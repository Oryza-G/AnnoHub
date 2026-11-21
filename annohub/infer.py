"""预标注推理：只依赖 onnxruntime，不 import torch。

模型库设计（支持随时换更好的模型）：
- models/ 目录下的 *.onnx + 同名 *.json（元数据：类别、imgsz）
- DB models 表镜像一份，供前端选择；目录是唯一事实来源，启动时同步
- 全局默认模型 + 项目级指定模型，批量预标注时也可临时指定
"""
import json
import threading
import time
from pathlib import Path

import numpy as np

from . import config, db

_sessions: dict[str, "object"] = {}
_session_lock = threading.Lock()
_MAX_CACHED = 3


# ------------------------------------------------------------------ 元数据同步

def sync_models() -> int:
    """把 models/ 目录里的 onnx 同步进库，返回新增数量。"""
    d = config.models_dir()
    added = 0
    for onnx in sorted(d.glob("*.onnx")):
        meta_path = onnx.with_suffix(".json")
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        classes = meta.get("classes") or []
        imgsz = int(meta.get("imgsz") or 640)
        size = onnx.stat().st_size
        conn = db.get_conn()
        row = conn.execute("SELECT id,size_bytes FROM models WHERE file_name=?", (onnx.name,)).fetchone()
        if row:
            if row["size_bytes"] != size:
                with db.cursor(write=True) as c:
                    c.execute(
                        "UPDATE models SET size_bytes=?, classes_json=?, imgsz=? WHERE id=?",
                        (size, json.dumps(classes, ensure_ascii=False), imgsz, row["id"]),
                    )
            continue
        name = meta.get("display_name") or onnx.stem
        with db.cursor(write=True) as c:
            c.execute(
                "INSERT INTO models(name,file_name,task,imgsz,classes_json,note,source,size_bytes,"
                "active,is_default,created_at) VALUES(?,?,?,?,?,?,?,?,1,0,?)",
                (
                    name, onnx.name, meta.get("task", "detect"), imgsz,
                    json.dumps(classes, ensure_ascii=False),
                    meta.get("note", ""), meta.get("source", ""), size, db.now_iso(),
                ),
            )
        added += 1

    # 若还没有默认模型，把第一个设为默认
    row = db.get_conn().execute("SELECT id FROM models WHERE is_default=1").fetchone()
    if row is None:
        first = db.get_conn().execute("SELECT id FROM models ORDER BY id LIMIT 1").fetchone()
        if first:
            with db.cursor(write=True) as c:
                c.execute("UPDATE models SET is_default=1 WHERE id=?", (first["id"],))
    return added


def list_models() -> list[dict]:
    rows = db.get_conn().execute("SELECT * FROM models ORDER BY is_default DESC, id DESC").fetchall()
    out = []
    d = config.models_dir()
    for r in rows:
        item = dict(r)
        try:
            item["classes"] = json.loads(item.pop("classes_json") or "[]")
        except Exception:
            item["classes"] = []
        item["exists"] = (d / item["file_name"]).exists()
        out.append(item)
    return out


def get_model(model_id: int | None) -> dict | None:
    conn = db.get_conn()
    if model_id:
        row = conn.execute("SELECT * FROM models WHERE id=?", (model_id,)).fetchone()
    else:
        row = conn.execute("SELECT * FROM models WHERE is_default=1 LIMIT 1").fetchone()
        if row is None:
            row = conn.execute("SELECT * FROM models ORDER BY id LIMIT 1").fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["classes"] = json.loads(d.get("classes_json") or "[]")
    except Exception:
        d["classes"] = []
    return d


def resolve_model(project_model_id: int | None, override_id: int | None = None) -> dict | None:
    """优先级：本次指定 > 项目指定 > 全局默认。"""
    if override_id:
        m = get_model(override_id)
        if m:
            return m
    if project_model_id:
        m = get_model(project_model_id)
        if m and (config.models_dir() / m["file_name"]).exists():
            return m
    return get_model(None)


def delete_model(model_id: int) -> None:
    m = get_model(model_id)
    if not m:
        return
    p = config.models_dir() / m["file_name"]
    if p.exists():
        p.unlink()
    j = p.with_suffix(".json")
    if j.exists():
        j.unlink()
    with _session_lock:
        _sessions.pop(str(p), None)
    with db.cursor(write=True) as c:
        c.execute("DELETE FROM models WHERE id=?", (model_id,))
        c.execute("UPDATE projects SET model_id=NULL WHERE model_id=?", (model_id,))


# ------------------------------------------------------------------ 会话

def _get_session(path: str):
    with _session_lock:
        sess = _sessions.get(path)
        if sess is not None:
            return sess
    import onnxruntime as ort

    providers = ["CPUExecutionProvider"]
    try:
        avail = ort.get_available_providers()
        if "CUDAExecutionProvider" in avail:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    except Exception:
        pass
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess = ort.InferenceSession(path, sess_options=so, providers=providers)
    with _session_lock:
        if len(_sessions) >= _MAX_CACHED:
            _sessions.pop(next(iter(_sessions)))
        _sessions[path] = sess
    return sess


def _letterbox(rgb: np.ndarray, size: int) -> tuple[np.ndarray, float, float, float]:
    from PIL import Image

    h, w = rgb.shape[:2]
    r = min(size / h, size / w)
    nh, nw = max(1, int(round(h * r))), max(1, int(round(w * r)))
    im = Image.fromarray(rgb).resize((nw, nh), Image.BILINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    dw, dh = (size - nw) / 2.0, (size - nh) / 2.0
    top, left = int(round(dh - 0.1)), int(round(dw - 0.1))
    canvas[top:top + nh, left:left + nw] = np.asarray(im)
    return canvas, r, left, top


def _center_crop_resize(rgb: np.ndarray, size: int) -> np.ndarray:
    """分类模型的标准预处理：短边缩放到 size，再中心裁 size×size。"""
    from PIL import Image

    h, w = rgb.shape[:2]
    r = size / min(h, w)
    im = Image.fromarray(rgb).resize((max(size, int(round(w * r))), max(size, int(round(h * r)))),
                                     Image.BILINEAR)
    nw, nh = im.size
    left, top = (nw - size) // 2, (nh - size) // 2
    im = im.crop((left, top, left + size, top + size))
    return np.asarray(im)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        union = areas[i] + areas[rest] - inter
        iou = np.where(union > 0, inter / union, 0)
        order = rest[iou <= iou_thr]
    return keep


def _softmax(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float64)
    x = x - x.max(axis=-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=-1, keepdims=True)


def _predict_classify(sess, rgb: np.ndarray, classes: list[str], size: int,
                      topk: int, conf_thr: float) -> list[dict]:
    h, w = rgb.shape[:2]
    crop = _center_crop_resize(rgb, size)
    inp = crop.astype(np.float32) / 255.0
    inp = np.transpose(inp, (2, 0, 1))[None, ...]
    inp = np.ascontiguousarray(inp)
    name = sess.get_inputs()[0].name
    out = sess.run(None, {name: inp})[0]
    vec = np.asarray(out).reshape(-1)
    if vec.size == 0:
        return []
    # 已经 softmax 过的输出(和为1)不再重复计算
    if vec.min() >= 0 and abs(float(vec.sum()) - 1.0) < 1e-3:
        probs = vec
    else:
        probs = _softmax(vec)
    order = probs.argsort()[::-1][:max(1, topk)]
    res = []
    for i in order:
        p = float(probs[i])
        if p < conf_thr:
            continue
        cls = classes[i] if i < len(classes) else f"class_{i}"
        res.append({
            "cls": cls, "conf": round(p, 4), "geom_type": "classify",
            "x1": 0.0, "y1": 0.0, "x2": float(w), "y2": float(h),
        })
    return res


def predict(image_path: Path, model: dict, conf_thr: float = 0.25,
            iou_thr: float = 0.45, max_det: int = 300,
            topk: int = 3) -> list[dict]:
    """按模型任务类型推理。

    detect / segment / obb / pose 返回矩形框（分割模型不还原掩膜，掩膜在
    标注端就是多边形的事，用模型掩膜直接生成多边形容易脏，交给人工修更稳）。
    classify 返回整图标签，bbox 铺满整幅图。
    """
    from PIL import Image

    path = config.models_dir() / model["file_name"]
    if not path.exists():
        raise FileNotFoundError(f"模型文件不存在：{path.name}")
    sess = _get_session(str(path))
    size = int(model.get("imgsz") or 640)
    classes = model.get("classes") or []
    task = (model.get("task") or "detect").lower()

    Image.MAX_IMAGE_PIXELS = None
    with Image.open(image_path) as im:
        rgb = np.asarray(im.convert("RGB"))
    h, w = rgb.shape[:2]

    if task == "classify":
        return _predict_classify(sess, rgb, classes, size, topk, conf_thr)

    canvas, r, padx, pady = _letterbox(rgb, size)
    inp = canvas[:, :, ::-1].astype(np.float32) / 255.0  # RGB->BGR, YOLO 默认
    inp = np.transpose(inp, (2, 0, 1))[None, ...]
    inp = np.ascontiguousarray(inp)

    name = sess.get_inputs()[0].name
    outputs = sess.run(None, {name: inp})
    out = outputs[0]
    if out.ndim == 3:
        out = out[0]
    # (4+nc, N) -> (N, 4+nc)
    if out.shape[0] < out.shape[1] and out.shape[0] <= 4 + max(1, len(classes)) + 64:
        out = out.T

    ncol = out.shape[1]
    if len(classes):
        nc = len(classes)
    else:
        nc = max(1, ncol - 4)
    has_obj = (ncol == 5 + nc)

    boxes_raw = out[:, :4]
    if has_obj:
        obj = out[:, 4]
        cls_scores = out[:, 5:5 + nc] * obj[:, None]
    else:
        cls_scores = out[:, 4:4 + nc]

    if cls_scores.size == 0:
        return []
    cls_idx = cls_scores.argmax(axis=1)
    confs = cls_scores.max(axis=1)
    mask = confs >= conf_thr
    if not mask.any():
        return []
    boxes_raw = boxes_raw[mask]
    confs = confs[mask]
    cls_idx = cls_idx[mask]

    # cx,cy,w,h -> x1,y1,x2,y2（letterbox 坐标）
    cx, cy, bw, bh = boxes_raw[:, 0], boxes_raw[:, 1], boxes_raw[:, 2], boxes_raw[:, 3]
    xyxy = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1)

    # 按类别分别做 NMS
    results: list[dict] = []
    for c in np.unique(cls_idx):
        sel = cls_idx == c
        b = xyxy[sel]
        s = confs[sel]
        for k in _nms(b, s, iou_thr):
            box = b[k]
            x1 = (box[0] - padx) / r
            y1 = (box[1] - pady) / r
            x2 = (box[2] - padx) / r
            y2 = (box[3] - pady) / r
            x1 = float(max(0.0, min(w, x1)))
            y1 = float(max(0.0, min(h, y1)))
            x2 = float(max(0.0, min(w, x2)))
            y2 = float(max(0.0, min(h, y2)))
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
            ci = int(c)
            cname = classes[ci] if ci < len(classes) else f"class_{ci}"
            results.append({
                "cls": cname,
                "conf": float(s[k]),
                "x1": round(x1, 2), "y1": round(y1, 2),
                "x2": round(x2, 2), "y2": round(y2, 2),
            })
    results.sort(key=lambda d: -d["conf"])
    return results[:max_det]


# ------------------------------------------------------------------ 写入标注

def apply_predictions(image_id: int, project_id: int, preds: list[dict],
                      model_id: int, user_id: int | None,
                      replace_model_only: bool = True) -> int:
    """把预测写成 labels，source='model'。默认只替换模型框，人工框保留。"""
    now = db.now_iso()
    row = db.get_conn().execute(
        "SELECT width,height FROM images WHERE id=?", (image_id,)).fetchone()
    iw = float(row["width"]) if row else 0.0
    ih = float(row["height"]) if row else 0.0
    with db.cursor(write=True) as conn:
        if replace_model_only:
            conn.execute(
                "DELETE FROM labels WHERE image_id=? AND source IN ('model','model_accepted')",
                (image_id,),
            )
        for p in preds:
            gt = p.get("geom_type") or "rect"
            if gt == "classify":
                geom = []
                x1, y1, x2, y2 = 0.0, 0.0, iw, ih
            else:
                geom = [p["x1"], p["y1"], p["x2"], p["y2"]]
                x1, y1, x2, y2 = p["x1"], p["y1"], p["x2"], p["y2"]
            conn.execute(
                "INSERT INTO labels(image_id,geom_type,geom_json,x1,y1,x2,y2,cls_name,conf,source,"
                "difficult,created_by,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,'model',0,?,?,?)",
                (image_id, gt, json.dumps(geom, ensure_ascii=False), x1, y1, x2, y2,
                 p["cls"], p["conf"], user_id, now, now),
            )
        n = conn.execute(
            "SELECT COUNT(*) c FROM labels WHERE image_id=?", (image_id,)
        ).fetchone()["c"]
        conn.execute(
            "UPDATE images SET n_labels=?, prelabeled=1, updated_at=? WHERE id=?",
            (n, now, image_id),
        )
    return len(preds)


def run_batch(job, project_id: int, model_id: int | None, conf_thr: float,
              iou_thr: float, only_empty_labels: bool, status_filter: list[str] | None,
              limit: int = 0, user_id: int | None = None,
              image_ids: list[int] | None = None) -> dict:
    proj = db.get_conn().execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not proj:
        raise ValueError("项目不存在")
    model = resolve_model(proj["model_id"], model_id)
    if not model:
        raise ValueError("没有可用模型，请先在模型页上传 ONNX")

    sql = "SELECT i.id, i.rel_path, i.n_labels FROM images i WHERE i.project_id=?"
    args: list = [project_id]
    if image_ids:
        sql += " AND i.id IN (%s)" % ",".join("?" * len(image_ids))
        args += [int(x) for x in image_ids]
    if status_filter:
        sql += " AND i.status IN (%s)" % ",".join("?" * len(status_filter))
        args += status_filter
    if only_empty_labels:
        sql += " AND i.n_labels=0"
    sql += " ORDER BY i.id"
    if limit:
        sql += " LIMIT ?"
        args.append(limit)
    rows = db.get_conn().execute(sql, args).fetchall()
    total = len(rows)
    done = 0
    n_boxes = 0
    failed = 0
    base = config.project_dir(project_id)
    is_cls = (model.get("task") or "detect").lower() == "classify"
    t0 = time.time()
    for idx, r in enumerate(rows):
        job.check_cancel()
        p = base / r["rel_path"]
        try:
            preds = predict(p, model, conf_thr, iou_thr)
            if is_cls:
                preds = preds[:1]
            apply_predictions(r["id"], project_id, preds, model["id"], user_id)
            n_boxes += len(preds)
            done += 1
        except Exception:
            failed += 1
        if idx % 5 == 0 or idx == total - 1:
            job.progress((idx + 1) / max(1, total) * 100,
                         f"预标注 {idx + 1}/{total}，累计 {n_boxes} 条")
    cost = time.time() - t0
    job.progress(100, f"完成：{done} 张，{n_boxes} 条，用时 {cost:.1f}s")
    return {
        "model": model["name"],
        "task": model.get("task"),
        "n_images": done,
        "n_boxes": n_boxes,
        "n_failed": failed,
        "seconds": round(cost, 1),
        "avg_ms": round(cost / max(1, done) * 1000),
    }
