"""导出适配器：把项目标注转成训练框架能直接吃的格式。

检测 / 分割 / 分类三条线都覆盖：
  yolo      images/ labels/ data.yaml —— 矩形（其它几何取包围盒）
  yolo_seg  多边形标签，矩形自动展开成四点
  yolo_cls  按类别分目录的 ImageFolder，train/val 分开
  voc       Pascal VOC
  coco      COCO（bbox + segmentation）
  csv       一行一条，含 geom 原始坐标

打包一律 ZIP_STORED：JPEG 已压缩，再 deflate 几乎不减体积，纯耗 CPU。
"""
import csv
import io
import json
import random
import secrets
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from . import config, db, geometry

SCOPES = {
    "all": "全部已标注",
    "done": "已完成",
    "reviewed": "复核通过",
    "mine": "我标注的",
    "batch": "指定来源分组",
    "images": "指定图号",
    "selected": "当前选中的图",
    "images_only": "仅图片，不含标签",
    "all_with_todo": "全部图片（含未标注）",
}

SPLIT_PRESETS = [
    ("none", "不划分（全部放 train）"),
    ("9:1", "9 : 1（train / val）"),
    ("8:2", "8 : 2（train / val）"),
    ("7:3", "7 : 3（train / val）"),
    ("3:1", "3 : 1（train / val）"),
    ("1:1", "1 : 1（train / val）"),
    ("8:1:1", "8 : 1 : 1（train / val / test）"),
    ("7:2:1", "7 : 2 : 1（train / val / test）"),
    ("6:2:2", "6 : 2 : 2（train / val / test）"),
    ("7:1.5:1.5", "7 : 1.5 : 1.5（train / val / test）"),
]


def _split_ids(ids: list[int], ratio: str, seed: int) -> dict[str, list[int]]:
    """ratio 形如 8:1:1 / 9:1 / 7:1.5:1.5 / 1。"""
    parts = [float(x) for x in str(ratio).split(":") if str(x).strip() != ""]
    if not parts or sum(parts) <= 0 or len(parts) == 1:
        return {"train": ids}
    parts = parts[:3]
    total = sum(parts)
    rnd = random.Random(seed)
    shuffled = list(ids)
    rnd.shuffle(shuffled)
    names = ["train", "val", "test"][: len(parts)]
    out: dict[str, list[int]] = {}
    start = 0
    for i, (nm, w) in enumerate(zip(names, parts)):
        n = len(shuffled) if i == len(parts) - 1 else int(round(len(shuffled) * w / total))
        out[nm] = shuffled[start:start + n]
        start += n
    return out


def collect(project_id: int, scope: str, opts: dict, user_id: int) -> list[dict]:
    conn = db.get_conn()
    sql = "SELECT i.* FROM images i WHERE i.project_id=?"
    args: list = [project_id]
    if scope in ("all", "done", "images_only"):
        sql += " AND i.status IN ('done','reviewed')"
    elif scope == "reviewed":
        sql += " AND i.status='reviewed'"
    elif scope == "mine":
        sql += " AND i.assignee_id=?"
        args.append(user_id)
    elif scope == "batch":
        sql += " AND i.batch_id=?"
        args.append(int(opts.get("batch_id") or 0))
    elif scope in ("images", "selected"):
        ids = opts.get("image_ids") or []
        if not ids:
            return []
        sql += " AND i.id IN (%s)" % ",".join("?" * len(ids))
        args += [int(x) for x in ids]
    elif scope == "all_with_todo":
        pass
    else:
        sql += " AND i.status IN ('done','reviewed')"
    sql += " ORDER BY i.id"
    rows = conn.execute(sql, args).fetchall()
    out = []
    for r in rows:
        labels = conn.execute(
            "SELECT * FROM labels WHERE image_id=? ORDER BY id", (r["id"],)
        ).fetchall()
        item = dict(r)
        item["labels"] = [dict(x) for x in labels]
        out.append(item)
    return out


def _labels_of(item: dict) -> list[dict]:
    """解析 geom_json，产出统一结构：{cls, geom_type, geom, bbox, conf, source}"""
    res = []
    w, h = float(item.get("width") or 1), float(item.get("height") or 1)
    for lb in item["labels"]:
        try:
            geom = json.loads(lb["geom_json"])
        except Exception:
            continue
        gt = lb["geom_type"] or "rect"
        if gt == "rect" and len(geom) < 4:
            continue
        res.append({
            "cls": lb["cls_name"], "geom_type": gt, "geom": geom,
            "bbox": [lb["x1"] or 0, lb["y1"] or 0, lb["x2"] or 0, lb["y2"] or 0],
            "conf": lb.get("conf"), "source": lb.get("source"), "w": w, "h": h,
        })
    return res


def _rect_of(lb: dict) -> list[float]:
    gt, geom = lb["geom_type"], lb["geom"]
    if gt == "rect" and len(geom) >= 4:
        return [float(geom[0]), float(geom[1]), float(geom[2]), float(geom[3])]
    return lb["bbox"]


def _poly_of(lb: dict) -> list[list[float]]:
    gt, geom = lb["geom_type"], lb["geom"]
    if gt == "polygon" and geom:
        return [[float(p[0]), float(p[1])] for p in geom]
    x1, y1, x2, y2 = _rect_of(lb)
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def _nice_name(item: dict, used: set[str]) -> str:
    p = Path(item["rel_path"])
    name = f"{item['id']:06d}_{p.name}"
    if name in used:
        name = f"{item['id']:06d}_{secrets.token_hex(2)}{p.suffix}"
    used.add(name)
    return name


def run(job, project_id: int, scope: str, opts: dict, user_id: int) -> dict:
    conn = db.get_conn()
    proj = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not proj:
        raise ValueError("项目不存在")
    try:
        classes = json.loads(proj["labels_json"] or "[]")
    except Exception:
        classes = []
    formats = opts.get("formats") or ["yolo"]
    base_dir = config.project_dir(project_id)
    items = collect(project_id, scope, opts, user_id)
    if not items:
        raise ValueError("该范围下没有可导出的图片")

    # 类别索引：项目标签集优先，遇到集外标签追加到末尾
    class_index = {c: i for i, c in enumerate(classes)}
    extra: list[str] = []
    for it in items:
        for lb in _labels_of(it):
            if lb["cls"] not in class_index:
                class_index[lb["cls"]] = len(class_index)
                extra.append(lb["cls"])
    names = sorted(class_index.keys(), key=lambda c: class_index[c])

    split_ratio = opts.get("split") or "none"
    seed = int(opts.get("seed") or 42)
    ids = [it["id"] for it in items]
    if split_ratio in ("", "none", None, "1"):
        split_map = {"train": ids}
    else:
        split_map = _split_ids(ids, split_ratio, seed)
    id2split = {i: s for s, lst in split_map.items() for i in lst}

    export_id = f"exp_{secrets.token_hex(4)}"
    safe_name = "".join(ch for ch in proj["name"] if ch not in '\\/:*?"<>|').strip() or "project"
    out_zip = config.exports_dir() / f"{export_id}_{safe_name}.zip"
    now = db.now_iso()
    with db.cursor(write=True) as c:
        c.execute(
            "INSERT INTO exports(id,project_id,scope,options_json,status,created_by,created_at,expires_at)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (export_id, project_id, scope, json.dumps(opts, ensure_ascii=False), "running",
             user_id, now,
             (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(timespec="seconds")),
        )

    used: set[str] = set()
    n_labels = sum(len(_labels_of(it)) for it in items)
    total = len(items)
    job.progress(1, f"准备导出 {total} 张")

    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        name_map = {it["id"]: _nice_name(it, used) for it in items}

        zf.writestr("classes.txt", "\n".join(names) + "\n")
        zf.writestr("classes_detail.txt",
                    "\n".join(f"{i}: {c}" for i, c in enumerate(names)) + "\n")

        if "yolo" in formats or "yolo_seg" in formats:
            # 两个都要时分开写目录，否则会互相覆盖：labels/ 存检测框，labels_seg/ 存多边形
            both = ("yolo" in formats) and ("yolo_seg" in formats)
            seg_dir = "labels_seg" if both else "labels"
            for idx, it in enumerate(items):
                job.check_cancel()
                sp = id2split.get(it["id"], "train")
                fname = name_map[it["id"]]
                src = base_dir / it["rel_path"]
                if not src.exists():
                    continue
                zf.writestr(f"images/{sp}/{fname}", src.read_bytes())
                if scope == "images_only":
                    continue
                labs = _labels_of(it)
                stem = Path(fname).stem
                w, h = it["width"], it["height"]

                if "yolo" in formats:
                    lines = []
                    for lb in labs:
                        ci = class_index[lb["cls"]]
                        x1, y1, x2, y2 = _rect_of(lb)
                        cx, cy = (x1 + x2) / 2 / w, (y1 + y2) / 2 / h
                        bw, bh = (x2 - x1) / w, (y2 - y1) / h
                        lines.append(f"{ci} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
                    zf.writestr(f"labels/{sp}/{stem}.txt",
                                "\n".join(lines) + ("\n" if lines else ""))

                if "yolo_seg" in formats:
                    seg_lines = []
                    for lb in labs:
                        ci = class_index[lb["cls"]]
                        if lb["geom_type"] == "point":
                            # 点没有面积，扩成 4px 小方框，避免出现退化多边形
                            px, py = lb["bbox"][0], lb["bbox"][1]
                            pts = [[max(0, px - 4), max(0, py - 4)], [px + 4, max(0, py - 4)],
                                   [px + 4, py + 4], [max(0, px - 4), py + 4]]
                        else:
                            pts = _poly_of(lb)
                        flat = []
                        for p in pts:
                            flat.append(f"{p[0] / w:.6f}")
                            flat.append(f"{p[1] / h:.6f}")
                        if len(flat) >= 6:
                            seg_lines.append(f"{ci} " + " ".join(flat))
                    zf.writestr(f"{seg_dir}/{sp}/{stem}.txt",
                                "\n".join(seg_lines) + ("\n" if seg_lines else ""))

                if idx % 20 == 0:
                    job.progress(2 + idx / total * 55, f"YOLO 打包 {idx + 1}/{total}")

            seg_only = ("yolo_seg" in formats) and not ("yolo" in formats)
            task = "segment" if seg_only else "detect"
            head = ["# AnnoHub 导出", "path: .", "train: images/train"]
            if "val" in split_map:
                head.append("val: images/val")
            if "test" in split_map:
                head.append("test: images/test")
            head += ["", f"nc: {len(names)}", "names:"]
            head += [f"  {i}: {n}" for i, n in enumerate(names)]
            zf.writestr("data.yaml", "\n".join(head) + "\n")
            zf.writestr("task.txt", task + "\n")
            if both:
                zf.writestr(
                    "README_yolo.txt",
                    "labels/ 是检测框（cx cy w h），labels_seg/ 是分割多边形（顶点序列）。\n"
                    "做检测用 labels/，做分割把 labels_seg/ 改名成 labels/ 再训练。\n")

        if "yolo_cls" in formats:
            for idx, it in enumerate(items):
                job.check_cancel()
                sp = id2split.get(it["id"], "train")
                fname = name_map[it["id"]]
                src = base_dir / it["rel_path"]
                if not src.exists():
                    continue
                lbs = _labels_of(it)
                cls = lbs[0]["cls"] if lbs else "unlabeled"
                zf.writestr(f"images/{sp}/{cls}/{fname}", src.read_bytes())
                if idx % 20 == 0:
                    job.progress(58 + idx / total * 15, f"分类打包 {idx + 1}/{total}")
            zf.writestr("README_classify.txt",
                        "按类别分目录的 ImageFolder 结构。可直接用 torchvision.datasets.ImageFolder"
                        " 或 ultralytics 的 classify 数据集指到 images 目录。\n")

        if "voc" in formats:
            main_txt: dict[str, list[str]] = {}
            for idx, it in enumerate(items):
                job.check_cancel()
                fname = name_map[it["id"]]
                sp = id2split.get(it["id"], "train")
                src = base_dir / it["rel_path"]
                if not src.exists():
                    continue
                zf.writestr(f"VOCdevkit/VOC2007/JPEGImages/{fname}", src.read_bytes())
                xml = [
                    "<annotation>",
                    "  <folder>JPEGImages</folder>",
                    f"  <filename>{xml_escape(fname)}</filename>",
                    f"  <size><width>{it['width']}</width><height>{it['height']}</height>"
                    f"<depth>3</depth></size>",
                ]
                for lb in _labels_of(it):
                    if lb["geom_type"] == "polygon":
                        pts = "".join(
                            f"      <pt><x>{round(p[0])}</x><y>{round(p[1])}</y></pt>\n"
                            for p in _poly_of(lb))
                        xml += [
                            "  <object>",
                            f"    <name>{xml_escape(lb['cls'])}</name>",
                            "    <difficult>0</difficult>",
                            f"    <polygon>\n{pts}    </polygon>",
                            "  </object>",
                        ]
                        continue
                    x1, y1, x2, y2 = _rect_of(lb)
                    xml += [
                        "  <object>",
                        f"    <name>{xml_escape(lb['cls'])}</name>",
                        "    <difficult>0</difficult>",
                        f"    <bndbox><xmin>{round(x1)}</xmin><ymin>{round(y1)}</ymin>"
                        f"<xmax>{round(x2)}</xmax><ymax>{round(y2)}</ymax></bndbox>",
                        "  </object>",
                    ]
                xml.append("</annotation>")
                zf.writestr(f"VOCdevkit/VOC2007/Annotations/{Path(fname).stem}.xml",
                            "\n".join(xml))
                main_txt.setdefault(sp, []).append(Path(fname).stem)
                if idx % 20 == 0:
                    job.progress(74 + idx / total * 10, f"VOC 打包 {idx + 1}/{total}")
            for sp, lst in main_txt.items():
                zf.writestr(f"VOCdevkit/VOC2007/ImageSets/Main/{sp}.txt", "\n".join(lst) + "\n")

        if "coco" in formats:
            coco: dict = {
                "info": {"description": proj["name"], "version": "1.0", "year": 2026,
                         "contributor": "AnnoHub"},
                "licenses": [],
                "categories": [{"id": i + 1, "name": c, "supercategory": "object"}
                               for i, c in enumerate(names)],
                "images": [],
                "annotations": [],
            }
            ann_id = 1
            for idx, it in enumerate(items):
                job.check_cancel()
                fname = name_map[it["id"]]
                src = base_dir / it["rel_path"]
                if not src.exists():
                    continue
                zf.writestr(f"coco/images/{fname}", src.read_bytes())
                coco["images"].append({"id": it["id"], "file_name": fname,
                                       "width": it["width"], "height": it["height"],
                                       "split": id2split.get(it["id"], "train")})
                for lb in _labels_of(it):
                    x1, y1, x2, y2 = _rect_of(lb)
                    bw, bh = max(0.0, x2 - x1), max(0.0, y2 - y1)
                    if lb["geom_type"] == "point":
                        ann = {"id": ann_id, "image_id": it["id"],
                               "category_id": class_index[lb["cls"]] + 1,
                               "bbox": [round(x1, 2), round(y1, 2), 0, 0],
                               "area": 0, "iscrowd": 0,
                               "keypoints": [round(x1, 2), round(y1, 2), 2],
                               "num_keypoints": 1}
                    else:
                        seg = [[round(v, 2) for p in _poly_of(lb) for v in p]]
                        ann = {"id": ann_id, "image_id": it["id"],
                               "category_id": class_index[lb["cls"]] + 1,
                               "bbox": [round(x1, 2), round(y1, 2), round(bw, 2), round(bh, 2)],
                               "area": round(bw * bh, 2), "iscrowd": 0,
                               "segmentation": seg}
                    if lb.get("conf") is not None:
                        ann["score"] = lb["conf"]
                    coco["annotations"].append(ann)
                    ann_id += 1
            zf.writestr("coco/annotations/instances_all.json",
                        json.dumps(coco, ensure_ascii=False, indent=1))
            for sp in set(id2split.values()):
                sub = dict(coco)
                sub["images"] = [i for i in coco["images"] if i["split"] == sp]
                keep = {i["id"] for i in sub["images"]}
                sub["annotations"] = [a for a in coco["annotations"] if a["image_id"] in keep]
                zf.writestr(f"coco/annotations/instances_{sp}.json",
                            json.dumps(sub, ensure_ascii=False, indent=1))

        if "csv" in formats:
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["file", "width", "height", "class", "geom_type", "x1", "y1", "x2", "y2",
                        "geom", "source", "conf", "status"])
            for it in items:
                fname = name_map[it["id"]]
                lbs = _labels_of(it)
                if not lbs:
                    w.writerow([fname, it["width"], it["height"], "", "", "", "", "", "",
                                "", "", "", it["status"]])
                for lb in lbs:
                    x1, y1, x2, y2 = lb["bbox"]
                    w.writerow([fname, it["width"], it["height"], lb["cls"], lb["geom_type"],
                                round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2),
                                json.dumps(lb["geom"], ensure_ascii=False),
                                lb["source"] or "",
                                "" if lb["conf"] is None else round(lb["conf"], 4),
                                it["status"]])
            zf.writestr("annotations.csv", "\ufeff" + buf.getvalue())

        # manifest：图号 -> 文件 -> 来源，便于回溯
        mf = io.StringIO()
        mw = csv.writer(mf)
        mw.writerow(["image_id", "file", "split", "batch_id", "src_image", "src_x", "src_y",
                     "status", "n_labels"])
        for it in items:
            mw.writerow([it["id"], name_map[it["id"]], id2split.get(it["id"], "train"),
                         it["batch_id"], it.get("src_image"), it.get("src_x"), it.get("src_y"),
                         it["status"], len(it["labels"])])
        zf.writestr("manifest.csv", "\ufeff" + mf.getvalue())
        zf.writestr("README.txt",
                    f"AnnoHub 导出\n项目：{proj['name']}\n范围：{SCOPES.get(scope, scope)}\n"
                    f"格式：{', '.join(formats)}\n图片数：{total}\n标注条数：{n_labels}\n"
                    f"类别：{', '.join(names)}\n")

    size = out_zip.stat().st_size
    with db.cursor(write=True) as c:
        c.execute(
            "UPDATE exports SET file_path=?, size=?, n_images=?, n_labels=?, status='done' WHERE id=?",
            (str(out_zip), size, total, n_labels, export_id),
        )
    job.progress(100, f"完成：{total} 张 / {n_labels} 条 / {size / 1e6:.1f} MB")
    return {"export_id": export_id, "file_path": str(out_zip), "size": size,
            "n_images": total, "n_labels": n_labels, "n_extra_classes": len(extra)}
