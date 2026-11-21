"""裁切引擎：把大图按固定尺寸切成训练用小图。

只负责裁切。空图判定、波段另存之类的判断全部拿掉，交给用户在图片管理里
自己看、自己删——裁切阶段做取舍，很容易把有用的图静默丢掉。

保留的两个关键点：
1. 边缘贴边对齐：最后一块回退到 total - tile，保证满尺寸且覆盖到边，
   不会像原脚本那样把右/下边缘的窄条直接丢掉。
2. 每次裁切写 manifest.csv，记录源图、偏移、参数指纹，可回溯、可复现。
"""
import csv
import hashlib
import io
import json
from pathlib import Path

import numpy as np

from . import config, db, importer, jobs

IMAGE_EXTS = importer.IMAGE_EXTS

DEFAULT_PARAMS = {
    "tile_w": 640,
    "tile_h": 640,
    "overlap_x": 128,
    "overlap_y": 128,
    "pattern": "",
    "recursive": True,
    "max_images": 0,
    "jpeg_quality": 95,
    "out_format": "jpg",     # jpg | png
}

# 统一命名：组号-源图名-r行c列.扩展名，例如 03-DJI_0021-r002c005.jpg
# 组号在前的目的：按文件名排序时同一组的图连在一起，和图片页左侧分组顺序一致。
NAME_TEMPLATE = "{batch:02d}-{stem}-r{row:03d}c{col:03d}{ext}"


def ext_of(fmt: str) -> str:
    return ".png" if (fmt or "").lower() == "png" else ".jpg"


def merge_params(raw: dict | None) -> dict:
    p = dict(DEFAULT_PARAMS)
    if raw:
        for k, v in raw.items():
            if k in p and v is not None:
                p[k] = v
    p["tile_w"] = max(32, min(8192, int(p["tile_w"])))
    p["tile_h"] = max(32, min(8192, int(p["tile_h"])))
    p["overlap_x"] = max(0, min(p["tile_w"] - 8, int(p["overlap_x"])))
    p["overlap_y"] = max(0, min(p["tile_h"] - 8, int(p["overlap_y"])))
    p["max_images"] = max(0, int(p["max_images"] or 0))
    p["jpeg_quality"] = max(50, min(100, int(p["jpeg_quality"])))
    p["recursive"] = bool(p["recursive"])
    p["out_format"] = "png" if str(p["out_format"]).lower() in ("png", "jpeg-png") else "jpg"
    return p


def fingerprint(p: dict) -> str:
    keys = ["tile_w", "tile_h", "overlap_x", "overlap_y", "pattern", "recursive", "out_format"]
    payload = json.dumps({k: p.get(k) for k in keys}, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()[:12]


def offsets(total: int, tile: int, overlap: int) -> list[int]:
    """贴边对齐的起始坐标序列。

    例：total=5400, tile=640, overlap=128 -> 0,512,...,4864 之后补 4760（=5400-640），
    最后一块与倒数第二块重叠更多，但一定贴边且满尺寸。
    """
    if total <= tile:
        return [0]
    step = max(1, tile - overlap)
    out = list(range(0, total - tile + 1, step))
    last = total - tile
    if out[-1] != last:
        out.append(last)
    return out


def collect_sources(source_root: str, p: dict, files: list[str] | None = None) -> tuple[list[Path], Path]:
    if files:
        fl = [Path(f) for f in files if Path(f).suffix.lower() in IMAGE_EXTS]
        root = Path(files[0]).parent if files else Path(".")
        return fl, root
    root = Path(source_root).expanduser()
    fl = importer.scan_images(root, p.get("recursive", True), p.get("pattern") or "")
    if p.get("max_images"):
        fl = fl[: p["max_images"]]
    return fl, root


# ------------------------------------------------------------------ 读图

def _to_rgb_array(im) -> np.ndarray:
    if im.mode == "RGB":
        return np.asarray(im)
    if im.mode in ("L", "I", "I;16", "F"):
        g = np.asarray(im.convert("F"), dtype=np.float32)
        mx = float(g.max()) if g.size else 0.0
        if mx > 255:
            g = g / mx * 255.0
        g8 = np.clip(g, 0, 255).astype(np.uint8)
        return np.stack([g8, g8, g8], axis=-1)
    return np.asarray(im.convert("RGB"))


def load_source(path: Path) -> np.ndarray:
    """读成 RGB uint8。多波段 tif 取前三个波段合成可视化（不做逐图归一化，
    统一用全局最大值，避免两张图亮度基准不一致）。"""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    with Image.open(path) as im:
        n_frames = getattr(im, "n_frames", 1)
        if n_frames > 1:
            bands = []
            for i in range(min(n_frames, 8)):
                im.seek(i)
                bands.append(np.asarray(im, dtype=np.float32))
            stack = np.stack(bands[:min(3, len(bands))], axis=-1)
            if stack.shape[2] == 1:
                g = stack[:, :, 0]
                g8 = np.clip(g / (float(g.max()) or 1.0) * 255.0, 0, 255).astype(np.uint8)
                return np.stack([g8, g8, g8], axis=-1)
            rgb = stack[:, :, [2, 1, 0]] if stack.shape[2] >= 3 else stack
            mx = float(rgb.max()) or 1.0
            return np.clip(rgb / mx * 255.0, 0, 255).astype(np.uint8)
        return _to_rgb_array(im)


def _thumb_data_url(tile: np.ndarray, size: int = 220) -> str:
    import base64

    from PIL import Image

    im = Image.fromarray(tile)
    im.thumbnail((size, size), Image.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=82)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


# ------------------------------------------------------------------ 预演

def plan(source_root: str, raw_params: dict, sample_n: int = 6,
         files: list[str] | None = None) -> dict:
    p = merge_params(raw_params)
    fl, root = collect_sources(source_root, p, files)
    if not fl:
        return {"n_sources": 0, "n_tiles": 0, "samples": [], "per_file": [],
                "params": p, "warnings": ["这个位置没有找到支持的图片文件"]}
    warnings: list[str] = []
    total_tiles = 0
    per_file = []
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    for f in fl:
        try:
            with Image.open(f) as im:
                w, h = im.size
        except Exception as exc:
            warnings.append(f"{f.name} 无法读取：{exc}")
            continue
        xs = len(offsets(w, p["tile_w"], p["overlap_x"]))
        ys = len(offsets(h, p["tile_h"], p["overlap_y"]))
        total_tiles += xs * ys
        per_file.append({"file": str(f), "name": f.name, "width": w,
                         "height": h, "nx": xs, "ny": ys})

    samples = []
    if per_file:
        step = max(1, len(per_file) // 3)
        picks = per_file[::step][:3]
        for pf in picks:
            try:
                rgb = load_source(Path(pf["file"]))
                h, w = rgb.shape[:2]
                xs = offsets(w, p["tile_w"], p["overlap_x"])
                ys = offsets(h, p["tile_h"], p["overlap_y"])
                picks_ij = [(0, 0), (len(xs) - 1, 0), (0, len(ys) - 1),
                            (len(xs) // 2, len(ys) // 2), (len(xs) - 1, len(ys) - 1)]
                for (i, j) in picks_ij:
                    if len(samples) >= sample_n:
                        break
                    x0, y0 = xs[i], ys[j]
                    tile = rgb[y0:y0 + p["tile_h"], x0:x0 + p["tile_w"]]
                    if not tile.size:
                        continue
                    samples.append({
                        "file": Path(pf["file"]).name,
                        "x": int(x0), "y": int(y0),
                        "w": int(tile.shape[1]), "h": int(tile.shape[0]),
                        "edge": (i == len(xs) - 1) or (j == len(ys) - 1),
                        "thumb": _thumb_data_url(tile),
                    })
            except Exception as exc:
                warnings.append(f"{Path(pf['file']).name} 抽样失败：{exc}")
            if len(samples) >= sample_n:
                break

    return {
        "n_sources": len(per_file),
        "n_tiles": total_tiles,
        "per_file": per_file[:50],
        "samples": samples,
        "params": p,
        "fingerprint": fingerprint(p),
        "warnings": warnings,
    }


# ------------------------------------------------------------------ 执行

def run(job: jobs.Job, project_id: int, source_root: str, raw_params: dict,
        batch_name: str | None = None, user_id: int | None = None,
        files: list[str] | None = None) -> dict:
    p = merge_params(raw_params)
    fp = fingerprint(p)
    fl, root = collect_sources(source_root, p, files)
    if not fl:
        raise ValueError("没有可裁切的图片")

    name = (batch_name or "").strip() or (root.name if root.name else "裁切")
    with db.cursor(write=True) as conn:
        cur = conn.execute(
            "INSERT INTO batches(project_id,name,source_root,crop_params_json,param_fingerprint,"
            "created_at,kind) VALUES(?,?,?,?,?,?,'crop')",
            (project_id, name, str(root.resolve()), json.dumps(p, ensure_ascii=False), fp,
             db.now_iso()),
        )
        batch_id = cur.lastrowid

    img_root = config.project_dir(project_id) / "images" / f"b{batch_id}"
    img_root.mkdir(parents=True, exist_ok=True)

    manifest_path = img_root.parent / f"b{batch_id}_manifest.csv"
    mf = manifest_path.open("w", newline="", encoding="utf-8-sig")
    writer = csv.writer(mf)
    writer.writerow(["file", "src_image", "src_x", "src_y", "width", "height", "sha256"])

    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    total_est = 0
    for f in fl:
        try:
            with Image.open(f) as im:
                w, h = im.size
            total_est += len(offsets(w, p["tile_w"], p["overlap_x"])) * len(
                offsets(h, p["tile_h"], p["overlap_y"]))
        except Exception:
            continue

    processed = 0
    n_done = n_dup = 0
    try:
        for fi, f in enumerate(fl):
            job.check_cancel()
            job.progress(processed / max(1, total_est) * 100,
                         f"裁切 {fi + 1}/{len(fl)}：{f.name}")
            try:
                rgb = load_source(f)
            except Exception:
                continue
            h, w = rgb.shape[:2]
            xs = offsets(w, p["tile_w"], p["overlap_x"])
            ys = offsets(h, p["tile_h"], p["overlap_y"])
            try:
                rel_src = str(f.relative_to(root.resolve()))
            except Exception:
                rel_src = f.name

            stem = f.stem[:40]
            for yi, y0 in enumerate(ys):
                for xi, x0 in enumerate(xs):
                    job.check_cancel()
                    processed += 1
                    tile = rgb[y0:y0 + p["tile_h"], x0:x0 + p["tile_w"]]
                    if tile.shape[0] != p["tile_h"] or tile.shape[1] != p["tile_w"]:
                        pad = np.zeros((p["tile_h"], p["tile_w"], 3), dtype=np.uint8)
                        pad[: tile.shape[0], : tile.shape[1]] = tile
                        tile = pad

                    buf = io.BytesIO()
                    if p["out_format"] == "png":
                        Image.fromarray(tile).save(buf, format="PNG", compress_level=3)
                    else:
                        Image.fromarray(tile).save(buf, format="JPEG",
                                                   quality=p["jpeg_quality"], subsampling=0)
                    data = buf.getvalue()
                    sha = hashlib.sha256(data).hexdigest()
                    exists = db.get_conn().execute(
                        "SELECT id FROM images WHERE project_id=? AND sha256=?",
                        (project_id, sha)).fetchone()
                    if exists:
                        n_dup += 1
                        continue

                    ext = ext_of(p["out_format"])
                    fname = NAME_TEMPLATE.format(batch=batch_id, stem=stem,
                                                 row=yi, col=xi, ext=ext)
                    out_path = img_root / fname
                    i = 2
                    while out_path.exists():
                        fname = NAME_TEMPLATE.format(
                            batch=batch_id, stem=f"{stem}-{i}", row=yi, col=xi, ext=ext)
                        out_path = img_root / fname
                        i += 1
                    out_path.write_bytes(data)
                    rel = out_path.relative_to(config.project_dir(project_id)).as_posix()
                    with db.cursor(write=True) as conn:
                        conn.execute(
                            "INSERT INTO images(project_id,batch_id,rel_path,sha256,width,height,"
                            "src_image,src_x,src_y,src_w,src_h,is_empty,green_ratio,status,"
                            "updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,0,'todo',?)",
                            (project_id, batch_id, rel, sha, p["tile_w"], p["tile_h"],
                             rel_src, int(x0), int(y0), p["tile_w"], p["tile_h"],
                             db.now_iso()),
                        )
                    writer.writerow([fname, rel_src, int(x0), int(y0),
                                     p["tile_w"], p["tile_h"], sha])
                    n_done += 1
                    if processed % 25 == 0:
                        job.progress(processed / max(1, total_est) * 100,
                                     f"已裁 {n_done} 张")
    finally:
        mf.close()

    with db.cursor(write=True) as conn:
        conn.execute("UPDATE batches SET n_images=?, n_skipped=? WHERE id=?",
                     (n_done, n_dup, batch_id))

    job.progress(100, f"完成：{n_done} 张")
    return {"batch_id": batch_id, "n_images": n_done, "n_dup": n_dup,
            "manifest": str(manifest_path), "dir": str(img_root)}
