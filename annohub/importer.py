"""数据导入：已有图片、已有标注。

两件事分开做，互不依赖：
1. import_images —— 把已经裁好（或已经是小图）的图片导入项目，按来源建一个分组
2. import_labels —— 把各种格式的标注文件挂到已有图片上

支持解析的标注格式：
  yolo      .txt（5 列矩形，或多于 5 列的归一化多边形）
  voc       Pascal VOC .xml（bndbox，可选 polygon）
  coco      COCO .json（bbox / segmentation / keypoints）
  labelme   LabelMe .json（rectangle / polygon / point / line / circle）
  csv       .csv（带表头，末列可以是 geom JSON）
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import shutil
from pathlib import Path
from xml.etree import ElementTree as ET

from . import config, db, geometry

IMAGE_EXTS = {".tif", ".tiff", ".jpg", ".jpeg", ".png", ".bmp", ".webp"}
RAW_EXTS = {".tif", ".tiff", ".bmp"}          # 浏览器不能直接显示，导入时转 JPEG


# ------------------------------------------------------------------ 扫描

def scan_images(root: str | Path, recursive: bool = True, pattern: str = "") -> list[Path]:
    root = Path(root).expanduser()
    if not root.exists():
        raise FileNotFoundError(f"路径不存在：{root}")
    if root.is_file():
        return [root] if root.suffix.lower() in IMAGE_EXTS else []
    it = root.rglob("*") if recursive else root.glob("*")
    import fnmatch

    out = []
    for p in it:
        try:
            if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
                continue
        except OSError:
            continue
        if pattern and not fnmatch.fnmatch(p.name, pattern):
            continue
        out.append(p)
    out.sort(key=lambda x: str(x).lower())
    return out


def _size(path: Path) -> tuple[int, int]:
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return 0, 0


def _needs_convert(path: Path) -> bool:
    from PIL import Image

    if path.suffix.lower() in RAW_EXTS:
        return True
    try:
        with Image.open(path) as im:
            return im.mode not in ("RGB", "L")
    except Exception:
        return False


# ------------------------------------------------------------------ 图片导入

def import_images(job, project_id: int, source: str, opts: dict | None = None,
                  user_id: int | None = None) -> dict:
    """source 可以是目录，也可以是具体文件列表（用 opts['files'] 传）。"""
    opts = opts or {}
    files_opt = opts.get("files") or []
    if files_opt:
        files = [Path(f) for f in files_opt if Path(f).suffix.lower() in IMAGE_EXTS]
        root = Path(files_opt[0]).parent if files_opt else Path("")
    else:
        root = Path(source).expanduser()
        files = scan_images(root, bool(opts.get("recursive", True)), opts.get("pattern") or "")
        if opts.get("max_images"):
            files = files[: int(opts["max_images"])]

    if not files:
        raise ValueError("没有找到可导入的图片")

    name = (opts.get("batch_name") or "").strip()
    if not name:
        name = root.name if root and root.name else "导入"
    now = db.now_iso()
    with db.cursor(write=True) as conn:
        cur = conn.execute(
            "INSERT INTO batches(project_id,name,source_root,crop_params_json,param_fingerprint,"
            "n_images,n_empty,n_skipped,created_at,kind) VALUES(?,?,?,'{}','import',0,0,0,?,'import')",
            (project_id, name, str(root), now),
        )
        batch_id = cur.lastrowid

    img_root = config.project_dir(project_id) / "images" / f"b{batch_id}"
    img_root.mkdir(parents=True, exist_ok=True)
    manifest = img_root.parent / f"b{batch_id}_manifest.csv"
    mf = manifest.open("w", newline="", encoding="utf-8-sig")
    writer = csv.writer(mf)
    writer.writerow(["file", "source_file", "width", "height", "sha256", "note"])

    total = len(files)
    n_done = n_dup = n_bad = 0
    used_names: set[str] = set()
    try:
        for idx, f in enumerate(files):
            job.check_cancel()
            job.progress(idx / max(1, total) * 100, f"导入 {idx + 1}/{total}：{f.name}")
            try:
                data = f.read_bytes()
            except Exception:
                n_bad += 1
                continue
            sha = hashlib.sha256(data).hexdigest()
            exists = db.get_conn().execute(
                "SELECT id FROM images WHERE project_id=? AND sha256=?", (project_id, sha)
            ).fetchone()
            if exists:
                n_dup += 1
                continue

            w, h = _size(f)
            if not w or not h:
                n_bad += 1
                continue

            stem = re.sub(r"[^\w\-\u4e00-\u9fa5]+", "_", f.stem)[:60] or "img"
            suffix = f.suffix.lower()
            note = ""
            if _needs_convert(f):
                from PIL import Image

                Image.MAX_IMAGE_PIXELS = None
                try:
                    with Image.open(f) as im:
                        im = im.convert("RGB")
                        data = _jpeg_bytes(im)
                    suffix = ".jpg"
                    note = "已转为 JPEG"
                    sha = hashlib.sha256(data).hexdigest()
                except Exception:
                    n_bad += 1
                    continue

            # 统一命名：组号-原文件名，例如 02-IMG_2041.jpg。
            # 组号在前的目的与裁切一致：按文件名排序时同组相连，且始终能追回原图。
            fname = f"{batch_id:02d}-{stem}{suffix}"
            i = 2
            while fname.lower() in used_names or (img_root / fname).exists():
                fname = f"{batch_id:02d}-{stem}_{i}{suffix}"
                i += 1
            used_names.add(fname.lower())
            out_path = img_root / fname
            out_path.write_bytes(data)

            try:
                rel_src = str(f.relative_to(root)) if root and f.is_relative_to(root) else f.name
            except Exception:
                rel_src = f.name

            rel = out_path.relative_to(config.project_dir(project_id)).as_posix()
            with db.cursor(write=True) as conn:
                conn.execute(
                    "INSERT INTO images(project_id,batch_id,rel_path,sha256,width,height,src_image,"
                    "is_empty,green_ratio,status,updated_at) VALUES(?,?,?,?,?,?,?,0,0,'todo',?)",
                    (project_id, batch_id, rel, sha, w, h, rel_src, db.now_iso()),
                )
            writer.writerow([fname, rel_src, w, h, sha, note])
            n_done += 1
    finally:
        mf.close()

    with db.cursor(write=True) as conn:
        conn.execute("UPDATE batches SET n_images=?, n_skipped=? WHERE id=?",
                     (n_done, n_dup + n_bad, batch_id))
    job.progress(100, f"完成：导入 {n_done} 张，重复跳过 {n_dup} 张")
    return {"batch_id": batch_id, "n_images": n_done, "n_dup": n_dup,
            "n_bad": n_bad, "dir": str(img_root), "manifest": str(manifest)}


def _jpeg_bytes(im, quality: int = 95) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, subsampling=0)
    return buf.getvalue()


# ------------------------------------------------------------------ 标注解析

def _num(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def parse_yolo(path: Path, width: int, height: int, classes: list[str]) -> list[dict]:
    out = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return out
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) < 5:
            continue
        try:
            ci = int(float(parts[0]))
        except ValueError:
            continue
        cls = classes[ci] if 0 <= ci < len(classes) else f"class_{ci}"
        vals = [_num(x) for x in parts[1:]]
        if len(vals) == 4:
            cx, cy, bw, bh = vals
            x1 = (cx - bw / 2) * width
            y1 = (cy - bh / 2) * height
            x2 = (cx + bw / 2) * width
            y2 = (cy + bh / 2) * height
            out.append({"cls": cls, "geom_type": "rect", "geom": [x1, y1, x2, y2]})
        elif len(vals) >= 6 and len(vals) % 2 == 0:
            pts = [[vals[i] * width, vals[i + 1] * height] for i in range(0, len(vals), 2)]
            out.append({"cls": cls, "geom_type": "polygon", "geom": pts})
    return out


def parse_voc(path: Path, width: int, height: int, classes: list[str]) -> list[dict]:
    out = []
    try:
        root = ET.parse(str(path)).getroot()
    except Exception:
        return out
    size = root.find("size")
    w = _num(size.findtext("width"), width) if size is not None else width
    h = _num(size.findtext("height"), height) if size is not None else height
    for obj in root.findall("object"):
        name = (obj.findtext("name") or "object").strip()
        poly = obj.find("polygon")
        if poly is not None:
            pts = [[_num(p.findtext("x")), _num(p.findtext("y"))] for p in poly.findall("pt")]
            if len(pts) >= 3:
                out.append({"cls": name, "geom_type": "polygon", "geom": pts})
                continue
        bb = obj.find("bndbox")
        if bb is None:
            continue
        x1 = _num(bb.findtext("xmin"))
        y1 = _num(bb.findtext("ymin"))
        x2 = _num(bb.findtext("xmax"))
        y2 = _num(bb.findtext("ymax"))
        out.append({"cls": name, "geom_type": "rect", "geom": [x1, y1, x2, y2]})
    return out


def parse_labelme(path: Path, width: int, height: int, classes: list[str]) -> list[dict]:
    out = []
    try:
        d = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return out
    for sh in d.get("shapes") or []:
        label = sh.get("label") or "object"
        pts = sh.get("points") or []
        st = (sh.get("shape_type") or "polygon").lower()
        if st == "rectangle" and len(pts) >= 2:
            (x1, y1), (x2, y2) = pts[0], pts[1]
            out.append({"cls": label, "geom_type": "rect",
                        "geom": [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]})
        elif st == "point" and len(pts) >= 1:
            out.append({"cls": label, "geom_type": "point", "geom": [pts[0][0], pts[0][1]]})
        elif st in ("line", "linestrip") and len(pts) >= 2:
            out.append({"cls": label, "geom_type": "line", "geom": [[p[0], p[1]] for p in pts]})
        elif st == "circle" and len(pts) >= 2:
            (cx, cy), (px, py) = pts[0], pts[1]
            r = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
            out.append({"cls": label, "geom_type": "polygon",
                        "geom": _circle(cx, cy, r)})
        elif len(pts) >= 3:
            out.append({"cls": label, "geom_type": "polygon",
                        "geom": [[p[0], p[1]] for p in pts]})
    return out


def _circle(cx: float, cy: float, r: float, n: int = 24) -> list[list[float]]:
    import math

    return [[round(cx + r * math.cos(2 * math.pi * i / n), 2),
             round(cy + r * math.sin(2 * math.pi * i / n), 2)] for i in range(n)]


def parse_coco(path: Path, index: dict) -> dict[int, list[dict]]:
    """COCO 一张 json 覆盖多张图，返回 {image_id: labels}，由调用方按文件名匹配。"""
    try:
        d = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    cats = {c["id"]: c.get("name", str(c["id"])) for c in d.get("categories") or []}
    id2file = {}
    for im in d.get("images") or []:
        key = _key_of(im.get("file_name") or "")
        if key:
            id2file[im["id"]] = key
    out: dict[int, list[dict]] = {}
    for a in d.get("annotations") or []:
        key = id2file.get(a.get("image_id"))
        if key is None:
            continue
        cls = cats.get(a.get("category_id"), "object")
        seg = a.get("segmentation")
        kps = a.get("keypoints")
        if kps:
            # COCO 关键点：x, y, v 三元组
            pts = []
            for i in range(0, len(kps) - 2, 3):
                if kps[i + 2] > 0:
                    pts.append({"cls": f"{cls}_{i // 3}", "geom_type": "point",
                                "geom": [kps[i], kps[i + 1]]})
            out.setdefault(key, []).extend(pts)
            continue
        if seg and isinstance(seg, list) and seg and isinstance(seg[0], list) and len(seg[0]) >= 6:
            pts = [[seg[0][i], seg[0][i + 1]] for i in range(0, len(seg[0]) - 1, 2)]
            out.setdefault(key, []).append({"cls": cls, "geom_type": "polygon", "geom": pts})
            continue
        bb = a.get("bbox")
        if bb and len(bb) >= 4:
            x, y, w, h = bb[0], bb[1], bb[2], bb[3]
            out.setdefault(key, []).append(
                {"cls": cls, "geom_type": "rect", "geom": [x, y, x + w, y + h]})
    return out


def parse_csv(path: Path, width: int, height: int, classes: list[str]) -> list[dict]:
    out = []
    try:
        text = path.read_text(encoding="utf-8-sig", errors="ignore")
    except Exception:
        return out
    try:
        rows = list(csv.DictReader(io.StringIO(text)))
    except Exception:
        return out
    for r in rows:
        low = {(k or "").strip().lower(): (v or "") for k, v in r.items()}
        cls = low.get("class") or low.get("label") or low.get("类别") or "object"
        if not cls.strip():
            continue
        if low.get("geom"):
            try:
                g = json.loads(low["geom"])
                out.append({"cls": cls, "geom_type": low.get("geom_type") or "rect", "geom": g})
                continue
            except Exception:
                pass
        if low.get("x1"):
            out.append({"cls": cls, "geom_type": "rect",
                        "geom": [_num(low.get("x1")), _num(low.get("y1")),
                                 _num(low.get("x2")), _num(low.get("y2"))]})
        elif low.get("cx"):
            out.append({"cls": cls, "geom_type": "point",
                        "geom": [_num(low.get("cx")), _num(low.get("cy"))]})
    return out


# ------------------------------------------------------------------ 文件名匹配

def _key_of(name: str) -> str:
    """把文件名或路径压成用于匹配的键：去掉目录、扩展名、前导编号。"""
    base = Path(str(name).replace("\\", "/")).name
    stem = Path(base).stem if base else str(name)
    stem = re.sub(r"^\d{4,8}[_\-]", "", stem)
    return stem.strip().lower()


def build_index(project_id: int) -> dict[str, int]:
    """建立多种键到 image_id 的映射，兼容导出时加的编号前缀、原始源图名。"""
    idx: dict[str, int] = {}
    rows = db.get_conn().execute(
        "SELECT id, rel_path, src_image FROM images WHERE project_id=?", (project_id,)
    ).fetchall()
    for r in rows:
        for cand in (r["rel_path"], r["src_image"]):
            if not cand:
                continue
            k = _key_of(cand)
            if k:
                idx.setdefault(k, r["id"])
        idx.setdefault(str(r["id"]), r["id"])
    return idx


def detect_format(root: Path) -> tuple[str, int]:
    """粗略判断一个目录里放的是哪种标注，返回 (格式, 文件数)。"""
    root = Path(root)
    files = list(root.rglob("*")) if root.is_dir() else [root]
    counts = {"coco": 0, "labelme": 0, "voc": 0, "yolo": 0, "csv": 0}
    for p in files:
        if not p.is_file():
            continue
        s = p.suffix.lower()
        if s == ".xml":
            counts["voc"] += 1
        elif s == ".csv":
            counts["csv"] += 1
        elif s == ".json":
            try:
                head = p.read_text(encoding="utf-8", errors="ignore")[:4000]
            except Exception:
                continue
            if '"annotations"' in head and '"images"' in head:
                counts["coco"] += 1
            elif '"shapes"' in head:
                counts["labelme"] += 1
        elif s == ".txt" and p.name.lower() not in ("classes.txt", "readme.txt"):
            try:
                first = p.read_text(encoding="utf-8", errors="ignore").strip().split("\n")[0]
                parts = first.split()
                if len(parts) >= 5 and all(re.match(r"^-?\d*\.?\d+$", x) for x in parts):
                    counts["yolo"] += 1
            except Exception:
                pass
    best, n = "yolo", 0
    for k, v in counts.items():
        if v > n:
            best, n = k, v
    return best, n


# ------------------------------------------------------------------ 标注导入

def import_labels(job, project_id: int, source: str, opts: dict | None = None,
                  user_id: int | None = None) -> dict:
    opts = opts or {}
    root = Path(source).expanduser()
    if not root.exists():
        raise FileNotFoundError(f"路径不存在：{root}")
    files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]

    fmt = (opts.get("format") or "auto").lower()
    detected, _ = detect_format(root) if fmt == "auto" else (fmt, 0)
    fmt = detected if fmt == "auto" else fmt

    try:
        proj = db.get_conn().execute("SELECT labels_json FROM projects WHERE id=?",
                                     (project_id,)).fetchone()
        project_classes = json.loads(proj["labels_json"] or "[]") if proj else []
    except Exception:
        project_classes = []
    classes = [str(c).strip() for c in (opts.get("classes") or []) if str(c).strip()]
    if not classes:
        classes = _read_classes(root, project_classes)
    if not classes:
        classes = project_classes or ["object"]

    index = build_index(project_id)
    sizes = {r["id"]: (r["width"], r["height"]) for r in db.get_conn().execute(
        "SELECT id,width,height FROM images WHERE project_id=?", (project_id,)).fetchall()}

    mode = (opts.get("mode") or "merge").lower()
    pending: dict[int, list[dict]] = {}
    n_files = n_hit = n_unmatched = 0
    matched_keys: set[str] = set()

    if fmt == "coco":
        for p in files:
            if p.suffix.lower() != ".json":
                continue
            job.check_cancel()
            n_files += 1
            per_file = parse_coco(p, index)
            for key, labels in per_file.items():
                iid = index.get(key)
                if not iid:
                    n_unmatched += 1
                    continue
                n_hit += 1
                matched_keys.add(key)
                pending.setdefault(iid, []).extend(labels)
            job.progress(min(90, n_files * 4), f"解析 COCO：{p.name}")
    else:
        for p in files:
            job.check_cancel()
            s = p.suffix.lower()
            labels: list[dict] = []
            key = _key_of(p.name)
            if fmt == "voc" and s == ".xml":
                n_files += 1
                labels = parse_voc(p, 0, 0, classes)
            elif fmt == "labelme" and s == ".json":
                n_files += 1
                labels = parse_labelme(p, 0, 0, classes)
            elif fmt == "yolo" and s == ".txt" and p.name.lower() not in ("classes.txt", "readme.txt"):
                n_files += 1
                iid = index.get(key)
                w, h = sizes.get(iid, (0, 0)) if iid else (0, 0)
                if not w:
                    continue
                labels = parse_yolo(p, w, h, classes)
            elif fmt == "csv" and s == ".csv":
                n_files += 1
                iid = index.get(key)
                w, h = sizes.get(iid, (0, 0)) if iid else (0, 0)
                labels = parse_csv(p, w, h, classes)
            else:
                continue

            iid = index.get(key)
            if iid is None:
                # 一张图可能对应多个标注文件（如 mask），尝试用父目录名匹配
                alt = _key_of(p.parent.name)
                iid = index.get(alt)
            if iid is None:
                if labels:
                    n_unmatched += 1
                continue
            n_hit += 1
            matched_keys.add(key)
            pending.setdefault(iid, []).extend(labels)
            if n_files % 20 == 0:
                job.progress(min(90, n_files / max(1, len(files)) * 90), f"解析 {p.name}")

    if not pending:
        raise ValueError(
            f"没有匹配到任何图片。识别为「{fmt}」格式，扫描 {n_files} 个标注文件。"
            "请确认标注文件名与图片名一致（不含扩展名）。")

    total_labels = 0
    skipped = 0
    now = db.now_iso()
    with db.cursor(write=True) as conn:
        for iid, labels in pending.items():
            w, h = sizes.get(iid, (0, 0))
            if not w:
                continue
            if mode == "replace":
                conn.execute("DELETE FROM labels WHERE image_id=?", (iid,))
            exist = set()
            for r in conn.execute(
                    "SELECT cls_name,x1,y1,x2,y2,geom_type FROM labels WHERE image_id=?", (iid,)
            ).fetchall():
                exist.add((r["cls_name"], round(r["x1"] or 0, 1), round(r["y1"] or 0, 1),
                           round(r["x2"] or 0, 1), round(r["y2"] or 0, 1), r["geom_type"]))
            for lb in labels:
                norm = geometry.normalize(lb.get("geom_type"), lb.get("geom"), w, h)
                if norm is None:
                    skipped += 1
                    continue
                gt, geom, bbox = norm
                sig = (lb["cls"], round(bbox[0], 1), round(bbox[1], 1),
                       round(bbox[2], 1), round(bbox[3], 1), gt)
                if mode != "replace" and sig in exist:
                    skipped += 1
                    continue
                exist.add(sig)
                conn.execute(
                    "INSERT INTO labels(image_id,geom_type,geom_json,x1,y1,x2,y2,cls_name,conf,"
                    "source,difficult,created_by,created_at,updated_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?, 'import',0,?,?,?)",
                    (iid, gt, json.dumps(geom, ensure_ascii=False), bbox[0], bbox[1],
                     bbox[2], bbox[3], lb["cls"], None, user_id, now, now),
                )
                total_labels += 1
            n = conn.execute("SELECT COUNT(*) c FROM labels WHERE image_id=?", (iid,)).fetchone()["c"]
            conn.execute("UPDATE images SET n_labels=?, updated_at=? WHERE id=?", (n, now, iid))

    job.progress(100, f"完成：{n_hit} 张图，{total_labels} 条标注")
    return {"format": fmt, "n_files": n_files, "n_matched": n_hit,
            "n_unmatched": n_unmatched, "n_labels": total_labels, "n_skipped": skipped,
            "classes": classes}


def _read_classes(root: Path, fallback: list[str]) -> list[str]:
    """从 classes.txt / data.yaml / 同名 json 里读类别名。"""
    names: list[str] = []
    for name in ("classes.txt", "obj.names", "labels.txt"):
        p = root / name if root.is_dir() else root.parent / name
        if p.exists():
            try:
                names = [x.strip() for x in p.read_text(encoding="utf-8", errors="ignore").splitlines()
                         if x.strip()]
                if names:
                    return names
            except Exception:
                pass
    for pat in ("*.yaml", "*.yml"):
        base = root if root.is_dir() else root.parent
        for p in base.glob(pat):
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            block = re.search(r"names\s*:\s*(?:\n((?:\s*[-]\s*.+\n?)+)|\[(.+?)\])", text)
            if not block:
                continue
            if block.group(1):
                return [re.sub(r"^\s*[-]\s*", "", ln).strip().strip("'\"")
                        for ln in block.group(1).splitlines() if ln.strip()]
            if block.group(2):
                return [x.strip().strip("'\"") for x in block.group(2).split(",") if x.strip()]
            m = re.findall(r"^\s*\d+\s*:\s*(.+)$", text, re.M)
            if m:
                return [x.strip().strip("'\"") for x in m]
    # labelme 的 labels.txt
    return names or []


def copy_local_file(src: str, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    p = Path(src)
    target = dest_dir / p.name
    shutil.copy2(p, target)
    return target
