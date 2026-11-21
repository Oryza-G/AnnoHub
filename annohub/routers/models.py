"""模型库：上传、切换、删除、测试。换更好的模型只需再传一个 onnx。"""
import json
import shutil
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile

from .. import auth, config, db, infer

router = APIRouter(prefix="/api", tags=["models"])


@router.get("/models")
def list_models(task: str = "", user: dict = Depends(auth.current_user)):
    infer.sync_models()
    models = infer.list_models()
    if task:
        models = [m for m in models if (m.get("task") or "detect") == task]
    for m in models:
        m["n_uses"] = db.get_conn().execute(
            "SELECT COUNT(*) c FROM projects WHERE model_id=?", (m["id"],)
        ).fetchone()["c"]
    return {"models": models, "active": next((m["id"] for m in models if m["is_default"]), None)}


@router.post("/models/sync")
def sync(user: dict = Depends(auth.current_user)):
    n = infer.sync_models()
    return {"added": n, "models": infer.list_models()}


@router.post("/models/upload")
async def upload_model(
    file: UploadFile = File(...),
    name: str = Form(""),
    classes: str = Form(""),
    imgsz: int = Form(640),
    task: str = Form("detect"),
    note: str = Form(""),
    user: dict = Depends(auth.require_admin),
):
    """上传 ONNX。classes 用逗号或换行分隔，例如 "rice" 或 "rice,weed"。"""
    fname = Path(file.filename or "model.onnx").name
    if not fname.lower().endswith(".onnx"):
        raise HTTPException(status_code=400, detail="只支持 .onnx 模型。pt 请先用 tools/export_onnx.py 转换")
    d = config.models_dir()
    target = d / fname
    if target.exists():
        stem, suffix = target.stem, target.suffix
        i = 2
        while (d / f"{stem}_{i}{suffix}").exists():
            i += 1
        target = d / f"{stem}_{i}{suffix}"
    size = 0
    tmp = target.with_suffix(".part")
    with tmp.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            size += len(chunk)
    tmp.rename(target)
    if size < 1024:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="文件为空或上传失败")

    cls_list = [c.strip() for c in str(classes).replace("\n", ",").split(",") if c.strip()]
    task = task if task in ("detect", "segment", "classify", "keypoint", "obb") else "detect"
    meta = {
        "display_name": name.strip() or target.stem,
        "file": target.name,
        "task": task,
        "imgsz": int(imgsz or 640),
        "classes": cls_list,
        "note": note,
        "source": "upload",
        "created_at": db.now_iso(),
    }
    target.with_suffix(".json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    infer.sync_models()
    row = db.get_conn().execute("SELECT id FROM models WHERE file_name=?", (target.name,)).fetchone()
    return {"ok": True, "id": row["id"] if row else None, "file": target.name,
            "warnings": [] if cls_list else ["未填写类别名，预标注产生的标签名会是 class_0，建议补填"]}


@router.post("/models/import-path")
def import_model_path(payload: dict = Body(...), user: dict = Depends(auth.require_admin)):
    """从本机路径直接导入模型文件，用于几十上百 MB、不想走浏览器上传的场景。"""
    import shutil

    src = Path(str(payload.get("path") or "")).expanduser()
    if not src.exists() or not src.is_file():
        raise HTTPException(status_code=400, detail=f"文件不存在：{src}")
    if src.suffix.lower() != ".onnx":
        raise HTTPException(status_code=400, detail="目前只支持 .onnx；.pt 请先用 tools/export_onnx.py 转换")
    d = config.models_dir()
    target = d / src.name
    i = 2
    while target.exists():
        target = d / f"{src.stem}_{i}{src.suffix}"
        i += 1
    shutil.copy2(src, target)
    cls_list = [str(c).strip() for c in (payload.get("classes") or []) if str(c).strip()]
    if isinstance(payload.get("classes"), str):
        cls_list = [c.strip() for c in str(payload["classes"]).replace("\n", ",").split(",") if c.strip()]
    task = payload.get("task") or "detect"
    meta = {
        "display_name": (payload.get("name") or src.stem).strip(),
        "file": target.name,
        "task": task,
        "imgsz": int(payload.get("imgsz") or 640),
        "classes": cls_list,
        "note": payload.get("note") or "",
        "source": str(src),
        "created_at": db.now_iso(),
    }
    target.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                           encoding="utf-8")
    infer.sync_models()
    row = db.get_conn().execute("SELECT id FROM models WHERE file_name=?", (target.name,)).fetchone()
    return {"ok": True, "id": row["id"] if row else None, "file": target.name}


@router.patch("/models/{mid}")
def patch_model(mid: int, payload: dict = Body(...), user: dict = Depends(auth.current_user)):
    m = infer.get_model(mid)
    if not m:
        raise HTTPException(status_code=404, detail="模型不存在")
    sets, args = [], []
    if "name" in payload:
        sets.append("name=?")
        args.append(str(payload["name"]).strip() or m["name"])
    if "note" in payload:
        sets.append("note=?")
        args.append(str(payload["note"]))
    if "imgsz" in payload:
        sets.append("imgsz=?")
        args.append(int(payload["imgsz"]))
    if payload.get("task"):
        t = str(payload["task"])
        if t not in ("detect", "segment", "classify", "keypoint", "obb"):
            raise HTTPException(status_code=400, detail="未知任务类型")
        sets.append("task=?")
        args.append(t)
    if "classes" in payload:
        cls = [str(x).strip() for x in payload["classes"] if str(x).strip()]
        sets.append("classes_json=?")
        args.append(json.dumps(cls, ensure_ascii=False))
    if payload.get("is_default"):
        with db.cursor(write=True) as c:
            c.execute("UPDATE models SET is_default=0")
        sets.append("is_default=1")
    if sets:
        args.append(mid)
        with db.cursor(write=True) as c:
            c.execute(f"UPDATE models SET {', '.join(sets)} WHERE id=?", args)
    # 同步回 json 元数据，保持目录与库一致
    fresh = infer.get_model(mid)
    meta_path = config.models_dir() / Path(fresh["file_name"]).with_suffix(".json").name
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        meta.update({"display_name": fresh["name"], "imgsz": fresh["imgsz"],
                     "task": fresh.get("task") or "detect",
                     "classes": fresh["classes"], "note": fresh["note"]})
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True, "model": infer.get_model(mid)}


@router.delete("/models/{mid}")
def delete_model(mid: int, user: dict = Depends(auth.require_admin)):
    if not infer.get_model(mid):
        raise HTTPException(status_code=404, detail="模型不存在")
    infer.delete_model(mid)
    infer.sync_models()
    return {"ok": True}


@router.post("/models/{mid}/test")
def test_model(mid: int, payload: dict = Body(default={}), user: dict = Depends(auth.current_user)):
    """用项目里的一张图试跑，返回框数量与前几个框，用于确认模型可用。"""
    m = infer.get_model(mid)
    if not m:
        raise HTTPException(status_code=404, detail="模型不存在")
    iid = payload.get("image_id")
    if not iid:
        row = db.get_conn().execute(
            "SELECT id FROM images WHERE is_empty=0 ORDER BY id LIMIT 1").fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="库里还没有图片，先裁一批再测")
        iid = row["id"]
    row = db.get_conn().execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="图片不存在")
    path = config.project_dir(row["project_id"]) / row["rel_path"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="图片文件缺失")
    import time

    t0 = time.time()
    try:
        preds = infer.predict(path, m, float(payload.get("conf", 0.25)), float(payload.get("iou", 0.45)))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"推理失败：{exc}")
    ms = (time.time() - t0) * 1000
    return {"n": len(preds), "ms": round(ms), "samples": preds[:8],
            "image_id": iid, "model": m["name"],
            "classes": m["classes"]}
