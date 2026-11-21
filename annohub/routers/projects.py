"""项目、分组、裁切、导入、统计、目录浏览、系统诊断。"""
import json
import string
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, config, crop, db, geometry, importer, jobs, native_dialog, netinfo

router = APIRouter(prefix="/api", tags=["projects"])

VALID_TASKS = set(geometry.TASK_LABEL.keys())


class ProjectIn(BaseModel):
    name: str
    task_type: str = "detect"
    desc: str = ""
    labels: list[str] = []


class ProjectPatch(BaseModel):
    name: str | None = None
    desc: str | None = None
    labels: list[str] | None = None
    status: str | None = None
    task_type: str | None = None
    model_id: int | None = None
    allow_export_all: bool | None = None


class CropIn(BaseModel):
    source_root: str = ""
    files: list[str] = []
    params: dict = {}
    batch_name: str | None = None


class ImportImagesIn(BaseModel):
    source_root: str = ""
    files: list[str] = []
    batch_name: str | None = None
    recursive: bool = True
    pattern: str = ""
    max_images: int = 0


class ImportLabelsIn(BaseModel):
    source_root: str
    format: str = "auto"
    classes: list[str] = []
    mode: str = "merge"


class AssignBatchIn(BaseModel):
    user_id: int | None = None
    batch_id: int | None = None
    n: int = 0
    only_unassigned: bool = True
    include_done: bool = False


def _proj_row(pid: int):
    row = db.get_conn().execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="项目不存在")
    return row


def _project_dict(row) -> dict:
    d = dict(row)
    try:
        d["labels"] = json.loads(d.pop("labels_json") or "[]")
    except Exception:
        d["labels"] = []
    d["task_label"] = geometry.TASK_LABEL.get(d.get("task_type") or "detect", d.get("task_type"))
    d["geom_types"] = geometry.TASK_GEOMS.get(d.get("task_type") or "detect",
                                              ["rect", "polygon", "line", "point"])
    if not d["labels"]:
        d["labels"] = []
    # 存储位置：图片、标注都在这两个目录下，界面上要能直接看到、直接打开
    pdir = config.project_dir(int(d["id"]))
    d["dir"] = str(pdir)
    d["images_dir"] = str(pdir / "images")
    return d


@router.get("/projects")
def list_projects(user: dict = Depends(auth.current_user)):
    conn = db.get_conn()
    rows = conn.execute("SELECT * FROM projects ORDER BY status='archived', id DESC").fetchall()
    out = []
    for r in rows:
        d = _project_dict(r)
        st = conn.execute(
            "SELECT status, COUNT(*) c FROM images WHERE project_id=? GROUP BY status", (r["id"],)
        ).fetchall()
        counts = {x["status"]: x["c"] for x in st}
        total = sum(counts.values())
        d["stats"] = {
            "total": total,
            "todo": counts.get("todo", 0) + counts.get("annotating", 0),
            "done": counts.get("done", 0),
            "reviewed": counts.get("reviewed", 0),
            "skipped": counts.get("skipped", 0),
            "n_labels": conn.execute(
                "SELECT COUNT(*) c FROM labels l JOIN images i ON i.id=l.image_id"
                " WHERE i.project_id=?", (r["id"],)).fetchone()["c"],
            "progress": round((counts.get("done", 0) + counts.get("reviewed", 0)) / total * 100, 1)
            if total else 0.0,
        }
        d["n_batches"] = conn.execute(
            "SELECT COUNT(*) c FROM batches WHERE project_id=?", (r["id"],)
        ).fetchone()["c"]
        out.append(d)
    return {"projects": out}


@router.post("/projects")
def create_project(body: ProjectIn, user: dict = Depends(auth.current_user)):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="项目名不能为空")
    task = body.task_type if body.task_type in VALID_TASKS else "detect"
    seen, labels = set(), []
    for x in body.labels:
        x = str(x).strip()
        if x and x not in seen:
            seen.add(x)
            labels.append(x)
    if task == "classify" and not labels:
        raise HTTPException(status_code=400, detail="分类项目至少要有一个类别")
    with db.cursor(write=True) as c:
        cur = c.execute(
            "INSERT INTO projects(name,task_type,desc,labels_json,status,created_by,created_at)"
            " VALUES(?,?,?,?,'active',?,?)",
            (body.name.strip(), task, body.desc,
             json.dumps(labels, ensure_ascii=False), user["id"], db.now_iso()),
        )
        pid = cur.lastrowid
    config.project_dir(pid)
    db.log_event("project_create", user_id=user["id"], project_id=pid)
    return {"id": pid}


@router.get("/projects/{pid}")
def get_project(pid: int, user: dict = Depends(auth.current_user)):
    row = _proj_row(pid)
    d = _project_dict(row)
    conn = db.get_conn()
    d["batches"] = [dict(x) for x in conn.execute(
        "SELECT b.*, (SELECT COUNT(*) FROM images i WHERE i.batch_id=b.id) AS n_now"
        " FROM batches b WHERE b.project_id=? ORDER BY b.id DESC", (pid,)).fetchall()]
    return d


@router.patch("/projects/{pid}")
def patch_project(pid: int, body: ProjectPatch, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    sets, args = [], []
    if body.name is not None:
        sets.append("name=?")
        args.append(body.name.strip())
    if body.desc is not None:
        sets.append("desc=?")
        args.append(body.desc)
    if body.labels is not None:
        seen, clean = set(), []
        for x in body.labels:
            x = str(x).strip()
            if x and x not in seen:
                seen.add(x)
                clean.append(x)
        if not clean:
            raise HTTPException(status_code=400, detail="标签集不能为空")
        sets.append("labels_json=?")
        args.append(json.dumps(clean, ensure_ascii=False))
    if body.status is not None:
        sets.append("status=?")
        args.append(body.status)
    if body.task_type is not None:
        if body.task_type not in VALID_TASKS:
            raise HTTPException(status_code=400, detail="未知任务类型")
        sets.append("task_type=?")
        args.append(body.task_type)
    if body.model_id is not None:
        sets.append("model_id=?")
        args.append(body.model_id or None)
    if body.allow_export_all is not None:
        sets.append("allow_export_all=?")
        args.append(1 if body.allow_export_all else 0)
    if not sets:
        return {"ok": True}
    args.append(pid)
    with db.cursor(write=True) as c:
        c.execute(f"UPDATE projects SET {', '.join(sets)} WHERE id=?", args)
    return {"ok": True}


@router.delete("/projects/{pid}")
def archive_project(pid: int, hard: bool = False, user: dict = Depends(auth.require_admin)):
    row = _proj_row(pid)
    if hard:
        import shutil

        conn = db.get_conn()
        # 先把附属产物记下来：删表之后就查不到了
        shas = [r["sha256"] for r in conn.execute(
            "SELECT sha256 FROM images WHERE project_id=? AND sha256 IS NOT NULL", (pid,))]
        zips = [r["file_path"] for r in conn.execute(
            "SELECT file_path FROM exports WHERE project_id=? AND file_path IS NOT NULL", (pid,))]

        with db.cursor(write=True) as c:
            c.execute("DELETE FROM projects WHERE id=?", (pid,))

        for sha in shas:
            for t in config.thumbs_dir().glob(f"{sha}_*"):
                try:
                    t.unlink()
                except Exception:
                    pass
        for zp in zips:
            try:
                Path(zp).unlink(missing_ok=True)
            except Exception:
                pass
        try:
            shutil.rmtree(config.project_dir(pid), ignore_errors=True)
        except Exception:
            pass
        db.log_event("project_delete", user["id"], pid, payload={"name": row["name"]})
        return {"ok": True, "deleted": True, "n_images": len(shas)}
    with db.cursor(write=True) as c:
        c.execute("UPDATE projects SET status='archived' WHERE id=?", (pid,))
    return {"ok": True}


@router.get("/projects/{pid}/stats")
def project_stats(pid: int, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    conn = db.get_conn()
    by_status = {r["status"]: r["c"] for r in conn.execute(
        "SELECT status, COUNT(*) c FROM images WHERE project_id=? GROUP BY status", (pid,)).fetchall()}
    by_user = [dict(r) for r in conn.execute(
        "SELECT u.id, u.display_name, u.username,"
        " COUNT(i.id) AS total,"
        " SUM(CASE WHEN i.status IN ('done','reviewed') THEN 1 ELSE 0 END) AS done"
        " FROM users u LEFT JOIN images i ON i.assignee_id=u.id AND i.project_id=?"
        " GROUP BY u.id HAVING total>0 ORDER BY done DESC", (pid,)).fetchall()]
    by_batch = [dict(r) for r in conn.execute(
        "SELECT b.id, b.name, b.kind, b.n_images,"
        " (SELECT COUNT(*) FROM images i WHERE i.batch_id=b.id) AS n_now,"
        " (SELECT COUNT(*) FROM images i WHERE i.batch_id=b.id AND i.status IN ('done','reviewed'))"
        " AS done"
        " FROM batches b WHERE b.project_id=? ORDER BY b.id DESC", (pid,)).fetchall()]
    cls = [dict(r) for r in conn.execute(
        "SELECT l.cls_name, COUNT(*) c,"
        " SUM(CASE WHEN l.source='model' THEN 1 ELSE 0 END) AS from_model"
        " FROM labels l JOIN images i ON i.id=l.image_id WHERE i.project_id=?"
        " GROUP BY l.cls_name ORDER BY c DESC", (pid,)).fetchall()]
    by_geom = {r["geom_type"]: r["c"] for r in conn.execute(
        "SELECT l.geom_type, COUNT(*) c FROM labels l JOIN images i ON i.id=l.image_id"
        " WHERE i.project_id=? GROUP BY l.geom_type", (pid,)).fetchall()}
    total = sum(by_status.values())
    recent = [dict(r) for r in conn.execute(
        "SELECT i.id, i.rel_path, i.status, i.updated_at, u.display_name"
        " FROM images i LEFT JOIN users u ON u.id=i.assignee_id"
        " WHERE i.project_id=? ORDER BY i.updated_at DESC LIMIT 12", (pid,)).fetchall()]
    return {
        "total": total,
        "by_status": by_status,
        "by_user": by_user,
        "by_batch": by_batch,
        "by_class": cls,
        "by_geom": by_geom,
        "recent": recent,
        "progress": round((by_status.get("done", 0) + by_status.get("reviewed", 0)) / total * 100, 1)
        if total else 0.0,
    }


# ------------------------------------------------------------------ 目录浏览

@router.get("/browse")
def browse(path: str = "", ext: str = "", user: dict = Depends(auth.current_user)):
    """网页内的目录浏览器。

    默认只列图片；ext 传 "onnx" 或 "txt,json" 之类时按该扩展名列文件，
    供模型导入、标注导入在网页里选单个文件用。
    """
    exts = {("." + e.strip().lower().lstrip(".")) for e in ext.split(",") if e.strip()} \
        or set(importer.IMAGE_EXTS)
    if not path:
        drives = []
        for letter in string.ascii_uppercase:
            p = Path(f"{letter}:/")
            try:
                if p.exists():
                    drives.append({"name": f"{letter}:", "path": f"{letter}:/"})
            except OSError:
                continue
        home = Path.home()
        quick = []
        for name, sub in (("桌面", "Desktop"), ("下载", "Downloads"),
                          ("文档", "Documents"), ("图片", "Pictures")):
            q = home / sub
            if q.exists():
                quick.append({"name": name, "path": str(q)})
        quick.append({"name": "用户目录", "path": str(home)})
        return {"path": "", "parent": None, "dirs": drives, "files": [],
                "quick": quick, "n_images": 0, "n_files": 0}
    root = Path(path).expanduser()
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=400, detail="目录不存在或不可访问")
    dirs, files, n_img = [], [], 0
    try:
        for entry in sorted(root.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            if entry.name.startswith(".") or entry.name.startswith("$"):
                continue
            try:
                if entry.is_dir():
                    dirs.append({"name": entry.name, "path": str(entry)})
                elif entry.suffix.lower() in exts:
                    n_img += 1
                    if len(files) < 400:
                        try:
                            size = entry.stat().st_size
                        except OSError:
                            size = 0
                        files.append({"name": entry.name, "path": str(entry),
                                      "size": size, "ext": entry.suffix.lower().lstrip(".")})
            except OSError:
                continue
    except PermissionError:
        raise HTTPException(status_code=403, detail="没有权限访问该目录")
    parent = str(root.parent) if root.parent != root else ""
    return {"path": str(root), "parent": parent, "dirs": dirs, "files": files,
            "n_images": n_img, "n_files": n_img}


@router.post("/system/pick-folder")
def pick_folder(payload: dict | None = None, user: dict = Depends(auth.current_user)):
    """弹出本机（服务端所在电脑）的目录选择框。"""
    initial = (payload or {}).get("initial") or ""
    try:
        p = native_dialog.pick_folder("选择图片所在文件夹", initial or None)
    except native_dialog.Busy as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法打开系统对话框：{exc}")
    return {"path": p or ""}


@router.post("/system/pick-files")
def pick_files(payload: dict | None = None, user: dict = Depends(auth.current_user)):
    """弹出本机文件选择框，可多选。返回文件路径列表。"""
    payload = payload or {}
    kind = payload.get("kind") or "image"
    patterns = {
        "image": "图片|*.jpg;*.jpeg;*.png;*.bmp;*.tif;*.tiff;*.webp|所有文件|*.*",
        "model": "ONNX 模型|*.onnx|所有文件|*.*",
        "label": "标注文件|*.txt;*.xml;*.json;*.csv|所有文件|*.*",
        "any": "所有文件|*.*",
    }.get(kind, "所有文件|*.*")
    try:
        out = native_dialog.pick_files("选择文件", payload.get("initial") or None,
                                       bool(payload.get("multi", True)), patterns)
    except native_dialog.Busy as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法打开系统对话框：{exc}")
    return {"files": out or []}


# ------------------------------------------------------------------ 裁切

@router.post("/projects/{pid}/crop/plan")
def crop_plan(pid: int, body: CropIn, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    try:
        return crop.plan(body.source_root, body.params, files=body.files or None)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"预演失败：{exc}")


@router.post("/projects/{pid}/crop/run")
def crop_run(pid: int, body: CropIn, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    if not body.source_root and not body.files:
        raise HTTPException(status_code=400, detail="请先选择源目录或文件")
    job_id = jobs.submit(
        "crop",
        lambda j: crop.run(j, pid, body.source_root, body.params, body.batch_name,
                           user["id"], body.files or None),
        project_id=pid, user_id=user["id"],
        payload={"source_root": body.source_root, "params": body.params,
                 "n_files": len(body.files or [])},
    )
    return {"job_id": job_id}


# ------------------------------------------------------------------ 导入

@router.post("/projects/{pid}/import/images")
def import_images(pid: int, body: ImportImagesIn, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    if not body.source_root and not body.files:
        raise HTTPException(status_code=400, detail="请先选择目录或文件")
    opts = {"batch_name": body.batch_name, "recursive": body.recursive,
            "pattern": body.pattern, "max_images": body.max_images,
            "files": body.files or []}
    job_id = jobs.submit(
        "import",
        lambda j: importer.import_images(j, pid, body.source_root, opts, user["id"]),
        project_id=pid, user_id=user["id"],
        payload={"source_root": body.source_root, "n_files": len(body.files or [])},
    )
    return {"job_id": job_id}


@router.post("/projects/{pid}/import/labels/preview")
def preview_labels(pid: int, body: ImportLabelsIn, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    root = Path(body.source_root).expanduser()
    if not root.exists():
        raise HTTPException(status_code=400, detail=f"路径不存在：{root}")
    fmt, n = importer.detect_format(root)
    n_imgs = db.get_conn().execute(
        "SELECT COUNT(*) c FROM images WHERE project_id=?", (pid,)).fetchone()["c"]
    return {"format": fmt, "n_files": n, "n_images_in_project": n_imgs}


@router.post("/projects/{pid}/import/labels")
def import_labels(pid: int, body: ImportLabelsIn, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    job_id = jobs.submit(
        "import_labels",
        lambda j: importer.import_labels(
            j, pid, body.source_root,
            {"format": body.format, "classes": body.classes, "mode": body.mode}, user["id"]),
        project_id=pid, user_id=user["id"], payload=body.model_dump(),
    )
    return {"job_id": job_id}


@router.post("/projects/{pid}/labels/rename")
def rename_class(pid: int, payload: dict, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    old = str(payload.get("from") or "").strip()
    new = str(payload.get("to") or "").strip()
    if not old or not new:
        raise HTTPException(status_code=400, detail="原类别和新类别都要填")
    with db.cursor(write=True) as c:
        n = c.execute(
            "UPDATE labels SET cls_name=? WHERE cls_name=? AND image_id IN"
            " (SELECT id FROM images WHERE project_id=?)", (new, old, pid)).rowcount
    return {"ok": True, "changed": n}


@router.get("/projects/{pid}/batches")
def list_batches(pid: int, user: dict = Depends(auth.current_user)):
    _proj_row(pid)
    rows = db.get_conn().execute(
        "SELECT b.*, (SELECT COUNT(*) FROM images i WHERE i.batch_id=b.id) AS n_now"
        " FROM batches b WHERE b.project_id=? ORDER BY b.id DESC", (pid,)).fetchall()
    return {"batches": [dict(r) for r in rows]}


@router.delete("/projects/{pid}/batch/{bid}")
def delete_batch(pid: int, bid: int, user: dict = Depends(auth.require_admin)):
    _proj_row(pid)
    conn = db.get_conn()
    rows = conn.execute("SELECT * FROM images WHERE project_id=? AND batch_id=?",
                        (pid, bid)).fetchall()
    from .images import _drop_files

    _drop_files(rows)
    with db.cursor(write=True) as c:
        c.execute("DELETE FROM images WHERE project_id=? AND batch_id=?", (pid, bid))
        c.execute("DELETE FROM batches WHERE id=? AND project_id=?", (bid, pid))
    return {"ok": True, "deleted": len(rows)}


@router.post("/projects/{pid}/assign/batch")
def assign_batch(pid: int, body: AssignBatchIn, user: dict = Depends(auth.current_user)):
    """按分组把 N 张图分配给某个成员，用于概览页的派活。user_id 为空即收回。"""
    _proj_row(pid)
    if body.user_id not in (None, user["id"]) and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="只有管理员才能把图片派给别人")
    conn = db.get_conn()
    where = ["project_id=?"]
    args: list = [pid]
    if body.batch_id:
        where.append("batch_id=?")
        args.append(body.batch_id)
    if body.only_unassigned:
        where.append("assignee_id IS NULL")
    if not body.include_done:
        where.append("status IN ('todo','annotating')")
    ids = [r["id"] for r in conn.execute(
        f"SELECT id FROM images WHERE {' AND '.join(where)} ORDER BY id"
        + (" LIMIT ?" if body.n and body.n > 0 else ""),
        args + ([int(body.n)] if body.n and body.n > 0 else []),
    ).fetchall()]
    if not ids:
        return {"ok": True, "n": 0}
    with db.cursor(write=True) as c:
        c.execute("UPDATE images SET assignee_id=? WHERE id IN (%s)" % ",".join("?" * len(ids)),
                  [body.user_id] + ids)
    db.log_event("assign", user_id=user["id"], project_id=pid,
                 payload={"n": len(ids), "to": body.user_id, "batch_id": body.batch_id})
    return {"ok": True, "n": len(ids)}


@router.get("/projects/{pid}/batch/{bid}/manifest")
def batch_manifest(pid: int, bid: int, user: dict = Depends(auth.current_user)):
    from fastapi.responses import FileResponse

    row = db.get_conn().execute(
        "SELECT * FROM batches WHERE id=? AND project_id=?", (bid, pid)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="分组不存在")
    p = config.project_dir(pid) / "images" / f"b{bid}_manifest.csv"
    if not p.exists():
        raise HTTPException(status_code=404, detail="该分组没有生成 manifest")
    return FileResponse(p, media_type="text/csv; charset=utf-8",
                        filename=f"batch{bid}_manifest.csv")


# ------------------------------------------------------------------ 系统

@router.get("/system/info")
def system_info(user: dict = Depends(auth.current_user)):
    conn = db.get_conn()
    from datetime import datetime, timedelta, timezone

    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat(timespec="seconds")
    online = conn.execute(
        "SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE last_seen > ?", (cutoff,)
    ).fetchone()["c"]
    try:
        import shutil

        usage = shutil.disk_usage(str(config.data_dir()))
        disk = {"total": usage.total, "free": usage.free, "used": usage.used}
    except Exception:
        disk = {}
    return {
        "version": config.VERSION,
        "app": config.APP_NAME,
        "data_dir": str(config.data_dir()),
        "models_dir": str(config.models_dir()),
        "app_dir": str(config.APP_DIR),
        "bundle_dir": str(config.BUNDLE_DIR),
        "projects_dir": str(config.projects_dir()),
        "exports_dir": str(config.exports_dir()),
        "thumbs_dir": str(config.thumbs_dir()),
        "frozen": config.FROZEN,
        "online": online,
        "disk": disk,
        "access": netinfo.access_info(config.DEFAULT_PORT),
        "lock_ttl": config.LOCK_TTL,
        "autosave": config.AUTOSAVE_SECONDS,
        "allow_register": db.get_bool("allow_register", True),
        "need_approval": db.get_bool("register_need_approval", False),
        "task_labels": geometry.TASK_LABEL,
        "project_types": geometry.PROJECT_TYPES,
    }


@router.get("/system/netcheck")
def netcheck(port: int = 0, user: dict = Depends(auth.current_user)):
    return netinfo.diagnostics(port or config.DEFAULT_PORT)


@router.post("/system/firewall/open")
def firewall_open(payload: dict | None = None, user: dict = Depends(auth.require_admin)):
    port = int((payload or {}).get("port") or config.DEFAULT_PORT)
    return netinfo.open_firewall(port)


@router.post("/system/reveal")
def reveal_path(payload: dict | None = None, user: dict = Depends(auth.require_admin)):
    """在本机资源管理器里打开一个目录。只允许打开本程序自己的目录。"""
    import os
    import subprocess

    raw = str((payload or {}).get("path") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="没有给出路径")
    target = Path(raw).expanduser()
    roots = [config.data_dir(), config.APP_DIR, config.models_dir()]
    try:
        target = target.resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="路径无效")
    if not any(str(target).lower().startswith(str(r.resolve()).lower()) for r in roots):
        raise HTTPException(status_code=403, detail="只允许打开本程序的数据目录")
    if not target.exists():
        raise HTTPException(status_code=404, detail="目录不存在")
    try:
        if os.name == "nt":
            os.startfile(str(target))  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"打开失败：{exc}")
    return {"ok": True, "path": str(target)}


@router.get("/system/events")
def system_events(limit: int = 50, user: dict = Depends(auth.current_user)):
    rows = db.get_conn().execute(
        "SELECT e.*, u.display_name FROM events e LEFT JOIN users u ON u.id=e.user_id"
        " ORDER BY e.id DESC LIMIT ?", (limit,)
    ).fetchall()
    return {"events": [dict(r) for r in rows]}
