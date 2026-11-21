"""图像、标注、锁。所有写操作都过锁校验与 version 校验。"""
import json
import secrets
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import auth, config, db, geometry, infer, jobs

router = APIRouter(prefix="/api", tags=["images"])


# ------------------------------------------------------------------ 工具

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _expired(heartbeat_at: str) -> bool:
    try:
        hb = datetime.fromisoformat(heartbeat_at)
        if hb.tzinfo is None:
            hb = hb.replace(tzinfo=timezone.utc)
    except Exception:
        return True
    return (_now() - hb).total_seconds() > config.LOCK_TTL


def lock_state(image_id: int) -> dict | None:
    row = db.get_conn().execute(
        "SELECT l.*, u.display_name, u.username FROM locks l JOIN users u ON u.id=l.user_id"
        " WHERE l.image_id=?", (image_id,)
    ).fetchone()
    if not row:
        return None
    if _expired(row["heartbeat_at"]):
        return None
    try:
        hb = datetime.fromisoformat(row["heartbeat_at"])
        if hb.tzinfo is None:
            hb = hb.replace(tzinfo=timezone.utc)
        secs = int((_now() - hb).total_seconds())
    except Exception:
        secs = 0
    return {"user_id": row["user_id"], "name": row["display_name"],
            "username": row["username"], "seconds": secs}


def _require_lock(image_id: int, user: dict) -> None:
    st = lock_state(image_id)
    if st is None:
        raise HTTPException(status_code=423, detail="该图未加锁，请先申请锁再操作")
    if st["user_id"] != user["id"] and user["role"] != "admin":
        raise HTTPException(
            status_code=423,
            detail=f"该图正在被 {st['name']} 标注（{st['seconds']} 秒前有心跳），请稍后再试",
        )


def _image_row(image_id: int):
    row = db.get_conn().execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="图片不存在")
    return row


def _image_path(row) -> Path:
    return config.project_dir(row["project_id"]) / row["rel_path"]


def _thumb_path(row) -> Path:
    key = f"{row['sha256'][:20]}_{row['width']}x{row['height']}.jpg"
    return config.thumbs_dir() / key


# ------------------------------------------------------------------ 列表

@router.get("/projects/{pid}/images")
def list_images(
    pid: int,
    status: str = "",
    batch_id: int | None = None,
    assignee: int | None = None,
    q: str = "",
    only_empty: bool | None = None,
    has_model: bool | None = None,
    has_labels: bool | None = None,
    limit: int = 200,
    offset: int = 0,
    user: dict = Depends(auth.current_user),
):
    conn = db.get_conn()
    where = ["i.project_id=?"]
    args: list = [pid]
    if status:
        statuses = [s for s in status.split(",") if s]
        where.append("i.status IN (%s)" % ",".join("?" * len(statuses)))
        args += statuses
    if batch_id:
        where.append("i.batch_id=?")
        args.append(batch_id)
    if assignee:
        where.append("i.assignee_id=?")
        args.append(assignee)
    if q:
        where.append("(i.rel_path LIKE ? OR i.src_image LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    if only_empty is True:
        where.append("i.is_empty=1")
    elif only_empty is False:
        where.append("i.is_empty=0")
    if has_model is True:
        where.append("i.prelabeled=1")
    elif has_model is False:
        where.append("i.prelabeled=0")
    if has_labels is True:
        where.append("i.n_labels>0")
    elif has_labels is False:
        where.append("i.n_labels=0")

    wsql = " WHERE " + " AND ".join(where)
    total = conn.execute(f"SELECT COUNT(*) c FROM images i{wsql}", args).fetchone()["c"]
    rows = conn.execute(
        f"SELECT i.*, u.display_name AS assignee_name FROM images i"
        f" LEFT JOIN users u ON u.id=i.assignee_id{wsql}"
        f" ORDER BY i.id LIMIT ? OFFSET ?",
        args + [max(1, min(1000, limit)), max(0, offset)],
    ).fetchall()

    locks = {}
    for r in conn.execute(
        "SELECT l.image_id, l.heartbeat_at, u.display_name FROM locks l"
        " JOIN users u ON u.id=l.user_id"
    ).fetchall():
        if not _expired(r["heartbeat_at"]):
            locks[r["image_id"]] = r["display_name"]

    items = []
    for r in rows:
        d = dict(r)
        d["locked_by"] = locks.get(r["id"])
        d["mine"] = False
        items.append(d)
    counts = {x["status"]: x["c"] for x in conn.execute(
        "SELECT status, COUNT(*) c FROM images WHERE project_id=? GROUP BY status", (pid,)).fetchall()}
    return {"total": total, "items": items, "counts": counts, "lock_ttl": config.LOCK_TTL}


@router.get("/projects/{pid}/groups")
def list_groups(pid: int, user: dict = Depends(auth.current_user)):
    """来源分组：一次裁切或一次导入算一组，用于图片管理的左侧目录。"""
    rows = db.get_conn().execute(
        "SELECT b.*, (SELECT COUNT(*) FROM images i WHERE i.batch_id=b.id) AS n_now,"
        " (SELECT COUNT(*) FROM images i WHERE i.batch_id=b.id AND i.status IN ('done','reviewed'))"
        " AS n_done,"
        " (SELECT COUNT(*) FROM labels l JOIN images i ON i.id=l.image_id WHERE i.batch_id=b.id)"
        " AS n_labels"
        " FROM batches b WHERE b.project_id=? ORDER BY b.id DESC", (pid,)).fetchall()
    total = db.get_conn().execute(
        "SELECT COUNT(*) c FROM images WHERE project_id=?", (pid,)).fetchone()["c"]
    return {"groups": [dict(r) for r in rows], "total": total}


@router.get("/images/{iid}")
def get_image(iid: int, user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    labels = db.get_conn().execute(
        "SELECT * FROM labels WHERE image_id=? ORDER BY id", (iid,)
    ).fetchall()
    out = []
    for lb in labels:
        try:
            geom = json.loads(lb["geom_json"])
        except Exception:
            geom = []
        out.append({
            "id": lb["id"], "cls": lb["cls_name"], "geom_type": lb["geom_type"],
            "geom": geom, "x1": lb["x1"], "y1": lb["y1"], "x2": lb["x2"], "y2": lb["y2"],
            "conf": lb["conf"], "source": lb["source"],
        })
    st = lock_state(iid)
    prev = None
    nxt = None
    return {
        "image": dict(row),
        "labels": out,
        "lock": st,
        "mine": bool(st and st["user_id"] == user["id"]) or st is None,
    }


@router.get("/images/{iid}/file")
def image_file(iid: int, token: str = "", user: dict = Depends(auth.current_user)):
    import mimetypes

    row = _image_row(iid)
    st = lock_state(iid)
    if st is not None and st["user_id"] != user["id"] and user["role"] != "admin":
        raise HTTPException(
            status_code=423,
            detail=f"该图正在被 {st['name']} 标注，完成后才能查看",
        )
    p = _image_path(row)
    if not p.exists():
        raise HTTPException(status_code=404, detail="图片文件缺失")
    mt = mimetypes.guess_type(p.name)[0] or "image/jpeg"
    return FileResponse(p, media_type=mt,
                        headers={"Cache-Control": "private, max-age=300"})


@router.get("/images/{iid}/thumb")
def image_thumb(iid: int, size: int = 200, user: dict = Depends(auth.current_user)):
    from PIL import Image

    row = _image_row(iid)
    size = max(80, min(400, size))
    tp = _thumb_path(row).with_name(_thumb_path(row).stem + f"_{size}.jpg")
    if tp.exists():
        return FileResponse(tp, media_type="image/jpeg",
                            headers={"Cache-Control": "private, max-age=86400"})
    src = _image_path(row)
    if not src.exists():
        raise HTTPException(status_code=404, detail="图片文件缺失")
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(src) as im:
        im = im.convert("RGB")
        im.thumbnail((size, size), Image.BILINEAR)
        tp.parent.mkdir(parents=True, exist_ok=True)
        im.save(tp, format="JPEG", quality=82)
    return FileResponse(tp, media_type="image/jpeg",
                        headers={"Cache-Control": "private, max-age=86400"})


# ------------------------------------------------------------------ 锁

@router.post("/images/{iid}/lock")
def acquire_lock(iid: int, user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    conn = db.get_conn()
    now = db.now_iso()
    with db.cursor(write=True) as c:
        cur = c.execute("SELECT * FROM locks WHERE image_id=?", (iid,)).fetchone()
        if cur is None:
            c.execute(
                "INSERT INTO locks(image_id,user_id,acquired_at,heartbeat_at) VALUES(?,?,?,?)",
                (iid, user["id"], now, now),
            )
        elif cur["user_id"] == user["id"]:
            c.execute("UPDATE locks SET heartbeat_at=? WHERE image_id=?", (now, iid))
        elif _expired(cur["heartbeat_at"]):
            c.execute(
                "UPDATE locks SET user_id=?, acquired_at=?, heartbeat_at=? WHERE image_id=?",
                (user["id"], now, now, iid),
            )
        else:
            owner = c.execute("SELECT display_name FROM users WHERE id=?",
                              (cur["user_id"],)).fetchone()
            raise HTTPException(
                status_code=409,
                detail=f"{owner['display_name'] if owner else '他人'} 正在标注这张图，请稍后再试",
            )
        # 首次进入标注即记为处理中
        if row["status"] == "todo":
            c.execute("UPDATE images SET status='annotating', updated_at=? WHERE id=?", (now, iid))
    db.log_event("lock", user_id=user["id"], project_id=row["project_id"], image_id=iid)
    return {"ok": True, "image": dict(_image_row(iid)), "lock": lock_state(iid)}


@router.post("/images/{iid}/heartbeat")
def heartbeat(iid: int, user: dict = Depends(auth.current_user)):
    _image_row(iid)
    with db.cursor(write=True) as c:
        cur = c.execute("SELECT user_id FROM locks WHERE image_id=?", (iid,)).fetchone()
        if not cur:
            raise HTTPException(status_code=409, detail="锁已失效，请重新打开")
        if cur["user_id"] != user["id"]:
            raise HTTPException(status_code=409, detail="锁已被他人占用")
        c.execute("UPDATE locks SET heartbeat_at=? WHERE image_id=?", (db.now_iso(), iid))
    return {"ok": True}


@router.delete("/images/{iid}/lock")
def release_lock(iid: int, user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    with db.cursor(write=True) as c:
        cur = c.execute("SELECT user_id FROM locks WHERE image_id=?", (iid,)).fetchone()
        if cur and (cur["user_id"] == user["id"] or user["role"] == "admin"):
            c.execute("DELETE FROM locks WHERE image_id=?", (iid,))
            if row["status"] == "annotating":
                c.execute("UPDATE images SET status='todo', updated_at=? WHERE id=?",
                          (db.now_iso(), iid))
    db.log_event("unlock", user_id=user["id"], project_id=row["project_id"], image_id=iid)
    return {"ok": True}


# ------------------------------------------------------------------ 标注保存

class LabelIn(BaseModel):
    cls: str
    geom_type: str = "rect"
    geom: list | None = None
    x1: float | None = None
    y1: float | None = None
    x2: float | None = None
    y2: float | None = None
    conf: float | None = None
    source: str = "human"


class SaveIn(BaseModel):
    labels: list[LabelIn] = []
    version: int | None = None
    complete: bool = False


@router.put("/images/{iid}/labels")
def save_labels(iid: int, body: SaveIn, user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    _require_lock(iid, user)
    if body.version is not None and body.version != row["version"]:
        raise HTTPException(
            status_code=409,
            detail=f"数据已被更新（当前版本 {row['version']}，你提交的是 {body.version}），请重新打开这张图",
        )
    now = db.now_iso()
    w, h = float(row["width"]), float(row["height"])
    clean = []
    for lb in body.labels:
        bbox = None
        if lb.x1 is not None and lb.y1 is not None and lb.x2 is not None and lb.y2 is not None:
            bbox = [lb.x1, lb.y1, lb.x2, lb.y2]
        norm = geometry.normalize(lb.geom_type, lb.geom, w, h, bbox)
        if norm is None:
            continue
        gt, geom, bb = norm
        clean.append((lb, gt, geom, bb))

    with db.cursor(write=True) as c:
        c.execute("DELETE FROM labels WHERE image_id=?", (iid,))
        for lb, gt, geom, bb in clean:
            c.execute(
                "INSERT INTO labels(image_id,geom_type,geom_json,x1,y1,x2,y2,cls_name,conf,source,"
                "difficult,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?)",
                (iid, gt, json.dumps(geom, ensure_ascii=False), bb[0], bb[1], bb[2], bb[3],
                 lb.cls, lb.conf, lb.source, user["id"], now, now),
            )
        new_status = "done" if body.complete else "annotating"
        c.execute(
            "UPDATE images SET version=version+1, n_labels=?, status=?, updated_at=? WHERE id=?",
            (len(clean), new_status, now, iid),
        )
        if body.complete:
            c.execute("DELETE FROM locks WHERE image_id=?", (iid,))
    db.log_event("save", user_id=user["id"], project_id=row["project_id"], image_id=iid,
                 payload={"n": len(clean), "complete": body.complete})
    fresh = _image_row(iid)
    return {
        "ok": True,
        "version": fresh["version"],
        "n_labels": fresh["n_labels"],
        "status": fresh["status"],
        "lock": lock_state(iid),
    }


@router.post("/images/{iid}/complete")
def complete(iid: int, user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    _require_lock(iid, user)
    now = db.now_iso()
    with db.cursor(write=True) as c:
        c.execute("UPDATE images SET status='done', updated_at=? WHERE id=?", (now, iid))
        c.execute("DELETE FROM locks WHERE image_id=?", (iid,))
    db.log_event("complete", user_id=user["id"], project_id=row["project_id"], image_id=iid)
    return {"ok": True}


@router.post("/images/{iid}/skip")
def skip(iid: int, user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    _require_lock(iid, user)
    with db.cursor(write=True) as c:
        c.execute("UPDATE images SET status='skipped', updated_at=? WHERE id=?",
                  (db.now_iso(), iid))
        c.execute("DELETE FROM locks WHERE image_id=?", (iid,))
    return {"ok": True}


@router.post("/images/{iid}/reopen")
def reopen(iid: int, user: dict = Depends(auth.current_user)):
    _image_row(iid)
    with db.cursor(write=True) as c:
        c.execute("UPDATE images SET status='todo', updated_at=? WHERE id=?",
                  (db.now_iso(), iid))
    return {"ok": True}


# ------------------------------------------------------------------ 删除

def _can_manage(user: dict) -> bool:
    return user.get("role") in ("admin", "manager")


def _drop_files(rows: list) -> int:
    """删磁盘上的图片与缩略图，删不掉只记日志，不阻断数据库操作。"""
    n = 0
    for row in rows:
        try:
            p = _image_path(row)
            if p.exists():
                p.unlink()
                n += 1
        except Exception:
            pass
        try:
            sha = (row["sha256"] or "")[:20]
            if sha:
                for t in config.thumbs_dir().glob(f"{sha}_*"):
                    try:
                        t.unlink()
                    except Exception:
                        pass
        except Exception:
            pass
    return n


@router.delete("/images/{iid}")
def delete_image(iid: int, user: dict = Depends(auth.current_user)):
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="只有管理员可以删除图片")
    row = _image_row(iid)
    if lock_state(iid):
        raise HTTPException(status_code=423, detail="这张图正在被标注，先让对方完成或等锁过期")
    _drop_files([row])
    with db.cursor(write=True) as c:
        c.execute("DELETE FROM images WHERE id=?", (iid,))
    db.log_event("image_delete", user_id=user["id"], project_id=row["project_id"], image_id=iid)
    return {"ok": True}


@router.post("/projects/{pid}/images/delete")
def delete_images(pid: int, payload: dict = Body(...), user: dict = Depends(auth.current_user)):
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="只有管理员可以删除图片")
    conn = db.get_conn()
    ids = [int(x) for x in (payload.get("image_ids") or [])]
    if payload.get("batch_id"):
        rows = conn.execute(
            "SELECT * FROM images WHERE project_id=? AND batch_id=?",
            (pid, int(payload["batch_id"]))).fetchall()
    elif ids:
        rows = conn.execute(
            "SELECT * FROM images WHERE project_id=? AND id IN (%s)" % ",".join("?" * len(ids)),
            [pid] + ids).fetchall()
    else:
        raise HTTPException(status_code=400, detail="没有指定要删除的图片")

    locked = [r["id"] for r in rows if lock_state(r["id"])]
    rows = [r for r in rows if r["id"] not in locked]
    n_file = _drop_files(rows)
    if rows:
        with db.cursor(write=True) as c:
            c.execute("DELETE FROM images WHERE id IN (%s)" % ",".join("?" * len(rows)),
                      [r["id"] for r in rows])
    db.log_event("image_delete_bulk", user_id=user["id"], project_id=pid,
                 payload={"n": len(rows), "files": n_file})
    return {"ok": True, "deleted": len(rows), "files": n_file,
            "skipped_locked": len(locked)}


@router.post("/projects/{pid}/assign")
def assign(pid: int, payload: dict = Body(...), user: dict = Depends(auth.current_user)):
    ids = payload.get("image_ids") or []
    uid = payload.get("user_id")
    with db.cursor(write=True) as c:
        if ids:
            c.execute(
                "UPDATE images SET assignee_id=? WHERE id IN (%s)" % ",".join("?" * len(ids)),
                [uid] + [int(x) for x in ids],
            )
        else:
            c.execute("UPDATE images SET assignee_id=? WHERE project_id=? AND status IN ('todo','annotating')",
                      (uid, pid))
    return {"ok": True}


# ------------------------------------------------------------------ 下一张

@router.get("/projects/{pid}/next")
def next_image(pid: int, after: int = 0, mode: str = "todo", batch_id: int | None = None,
               user: dict = Depends(auth.current_user)):
    conn = db.get_conn()
    where = ["i.project_id=?"]
    args: list = [pid]
    if mode == "todo":
        where.append("i.status IN ('todo','annotating')")
    elif mode == "empty":
        where.append("i.status IN ('todo','annotating') AND i.is_empty=1")
    elif mode == "mine":
        where.append("i.assignee_id=? AND i.status IN ('todo','annotating')")
        args.append(user["id"])
    elif mode == "all":
        pass
    elif mode == "prelabel":
        where.append("i.n_labels=0")
    if batch_id:
        where.append("i.batch_id=?")
        args.append(batch_id)
    where.append("i.id > ?")
    args.append(after)
    row = conn.execute(
        f"SELECT i.id FROM images i WHERE {' AND '.join(where)} ORDER BY i.id LIMIT 1", args
    ).fetchone()
    if row is None:
        row = conn.execute(
            f"SELECT i.id FROM images i WHERE {' AND '.join(where[:-2] + ['1=1'])}"
            f" ORDER BY i.id LIMIT 1", args[:-1]
        ).fetchone()
    if row is None:
        return {"image_id": None}
    return {"image_id": row["id"]}


# ------------------------------------------------------------------ 预标注

@router.post("/images/{iid}/prelabel")
def prelabel_one(iid: int, payload: dict = Body(default={}), user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    _require_lock(iid, user)
    proj = db.get_conn().execute("SELECT * FROM projects WHERE id=?",
                                 (row["project_id"],)).fetchone()
    model = infer.resolve_model(proj["model_id"], payload.get("model_id"))
    if not model:
        raise HTTPException(status_code=400, detail="还没有可用模型，请先到「模型」页上传 ONNX")
    conf = float(payload.get("conf", 0.25))
    iou = float(payload.get("iou", 0.45))
    try:
        preds = infer.predict(_image_path(row), model, conf, iou)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"推理失败：{exc}")
    if payload.get("apply"):
        infer.apply_predictions(iid, row["project_id"], preds, model["id"], user["id"])
    return {"predictions": preds, "model": model["name"], "n": len(preds)}


@router.post("/projects/{pid}/prelabel")
def prelabel_batch(pid: int, payload: dict = Body(default={}), user: dict = Depends(auth.current_user)):
    row = db.get_conn().execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="项目不存在")
    model = infer.resolve_model(row["model_id"], payload.get("model_id"))
    if not model:
        raise HTTPException(status_code=400, detail="还没有可用模型，请先到「模型」页上传 ONNX")
    status_filter = payload.get("status_filter") or ["todo", "annotating", "done"]
    image_ids = payload.get("image_ids") or None
    job_id = jobs.submit(
        "prelabel",
        lambda j: infer.run_batch(
            j, pid, payload.get("model_id"),
            float(payload.get("conf", 0.25)), float(payload.get("iou", 0.45)),
            bool(payload.get("only_empty_labels", True)), status_filter,
            int(payload.get("limit", 0)), user["id"],
            [int(x) for x in image_ids] if image_ids else None,
        ),
        project_id=pid, user_id=user["id"], payload=payload,
    )
    return {"job_id": job_id, "task": model.get("task")}


# ------------------------------------------------------------------ 单张下载

@router.get("/images/{iid}/download")
def download_one(iid: int, fmt: str = "yolo", user: dict = Depends(auth.current_user)):
    row = _image_row(iid)
    proj = db.get_conn().execute("SELECT * FROM projects WHERE id=?",
                                 (row["project_id"],)).fetchone()
    try:
        classes = json.loads(proj["labels_json"] or "[]")
    except Exception:
        classes = []
    labels = db.get_conn().execute("SELECT * FROM labels WHERE image_id=?", (iid,)).fetchall()
    src = _image_path(row)
    name = f"{iid:06d}_{src.name}"
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        if src.exists():
            zf.writestr(name, src.read_bytes())
        if fmt == "yolo":
            lines = []
            for lb in labels:
                cx = (lb["x1"] + lb["x2"]) / 2 / row["width"]
                cy = (lb["y1"] + lb["y2"]) / 2 / row["height"]
                bw = (lb["x2"] - lb["x1"]) / row["width"]
                bh = (lb["y2"] - lb["y1"]) / row["height"]
                ci = classes.index(lb["cls_name"]) if lb["cls_name"] in classes else 0
                lines.append(f"{ci} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
            zf.writestr(f"{Path(name).stem}.txt", "\n".join(lines) + ("\n" if lines else ""))
        zf.writestr("classes.txt", "\n".join(classes) + "\n")
        zf.writestr("info.txt",
                    f"image_id: {iid}\nsize: {row['width']}x{row['height']}\n"
                    f"status: {row['status']}\nlabels: {len(labels)}\n")
    return Response(
        content=buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="image_{iid}.zip"'},
    )
