"""导出、下载（含 Range 断点续传）、分享链接。"""
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from .. import auth, config, db, exporters, jobs

router = APIRouter(prefix="/api", tags=["exports"])

CHUNK = 1024 * 512


def _ranged(path: Path, request: Request, filename: str) -> Response:
    from urllib.parse import quote

    size = path.stat().st_size
    ctype = "application/zip"
    range_header = request.headers.get("range") or request.headers.get("Range")
    # HTTP 头只能是 latin-1，中文名必须走 RFC 5987 的 filename*
    ascii_name = filename.encode("ascii", "ignore").decode().strip() or "export.zip"
    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": (
            f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}'
        ),
    }
    if not range_header or not range_header.startswith("bytes="):
        def full():
            with open(path, "rb") as f:
                while True:
                    b = f.read(CHUNK)
                    if not b:
                        break
                    yield b

        headers = dict(base_headers)
        headers["Content-Length"] = str(size)
        return StreamingResponse(full(), media_type=ctype, headers=headers)

    try:
        spec = range_header.split("=", 1)[1].split(",")[0].strip()
        start_s, _, end_s = spec.partition("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else size - 1
    except Exception:
        raise HTTPException(status_code=416, detail="Range 头格式不正确")
    if start >= size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    end = min(end, size - 1)
    length = end - start + 1

    def partial():
        remaining = length
        with open(path, "rb") as f:
            f.seek(start)
            while remaining > 0:
                b = f.read(min(CHUNK, remaining))
                if not b:
                    break
                remaining -= len(b)
                yield b

    headers = dict(base_headers)
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(length)
    return StreamingResponse(partial(), status_code=206, media_type=ctype, headers=headers)


@router.post("/projects/{pid}/exports")
def create_export(pid: int, payload: dict = Body(default={}),
                  user: dict = Depends(auth.current_user)):
    conn = db.get_conn()
    proj = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not proj:
        raise HTTPException(status_code=404, detail="项目不存在")
    scope = payload.get("scope") or "all"
    if scope in ("all", "all_with_todo") and not proj["allow_export_all"] and user["role"] != "admin":
        raise HTTPException(status_code=403, detail="管理员已关闭全量导出")
    opts = {
        "formats": payload.get("formats") or ["yolo"],
        "split": payload.get("split", "none"),
        "seed": payload.get("seed", 42),
        "batch_id": payload.get("batch_id"),
        "image_ids": payload.get("image_ids"),
        "skip_empty": payload.get("skip_empty", False),
    }
    job_id = jobs.submit(
        "export",
        lambda j: exporters.run(j, pid, scope, opts, user["id"]),
        project_id=pid, user_id=user["id"], payload={"scope": scope, **opts},
    )
    return {"job_id": job_id}


@router.get("/projects/{pid}/exports")
def list_exports(pid: int, user: dict = Depends(auth.current_user)):
    rows = db.get_conn().execute(
        "SELECT e.*, u.display_name FROM exports e LEFT JOIN users u ON u.id=e.created_by"
        " WHERE e.project_id=? ORDER BY e.created_at DESC LIMIT 50", (pid,)
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["exists"] = bool(d.get("file_path") and Path(d["file_path"]).exists())
        try:
            d["options"] = json.loads(d.pop("options_json") or "{}")
        except Exception:
            d["options"] = {}
        out.append(d)
    return {"exports": out}


@router.get("/exports/{eid}")
def export_detail(eid: str, user: dict = Depends(auth.current_user)):
    row = db.get_conn().execute("SELECT * FROM exports WHERE id=?", (eid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="导出记录不存在")
    d = dict(row)
    d["exists"] = bool(d.get("file_path") and Path(d["file_path"]).exists())
    return d


@router.get("/exports/{eid}/download")
def download_export(eid: str, request: Request, user: dict = Depends(auth.current_user)):
    row = db.get_conn().execute("SELECT * FROM exports WHERE id=?", (eid,)).fetchone()
    if not row or not row["file_path"]:
        raise HTTPException(status_code=404, detail="导出包不存在或尚未完成")
    p = Path(row["file_path"])
    if not p.exists():
        raise HTTPException(status_code=404, detail="导出包已被清理，请重新导出")
    proj = db.get_conn().execute("SELECT name FROM projects WHERE id=?",
                                 (row["project_id"],)).fetchone()
    safe = (proj["name"] if proj else "export").replace(" ", "_")
    db.log_event("export_download", user_id=user["id"], project_id=row["project_id"],
                 payload={"export_id": eid})
    return _ranged(p, request, f"{safe}_{eid}.zip")


@router.delete("/exports/{eid}")
def delete_export(eid: str, user: dict = Depends(auth.current_user)):
    row = db.get_conn().execute("SELECT * FROM exports WHERE id=?", (eid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="导出记录不存在")
    if row["file_path"]:
        p = Path(row["file_path"])
        if p.exists():
            p.unlink()
    with db.cursor(write=True) as c:
        c.execute("DELETE FROM exports WHERE id=?", (eid,))
    return {"ok": True}


@router.post("/exports/{eid}/share")
def share(eid: str, payload: dict = Body(default={}), user: dict = Depends(auth.require_admin)):
    row = db.get_conn().execute("SELECT * FROM exports WHERE id=?", (eid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="导出记录不存在")
    days = int(payload.get("days", 7))
    max_dl = int(payload.get("max_downloads", 0))
    token = secrets.token_urlsafe(12)
    with db.cursor(write=True) as c:
        c.execute(
            "INSERT INTO share_links(token,export_id,expires_at,max_downloads,downloads,created_by,created_at)"
            " VALUES(?,?,?,?,0,?,?)",
            (token, eid,
             (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(timespec="seconds"),
             max_dl, user["id"], db.now_iso()),
        )
    return {"token": token, "url": f"/api/download/{token}", "expires_in_days": days}


@router.get("/download/{token}")
def download_shared(token: str, request: Request):
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM share_links WHERE token=?", (token,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="链接无效")
    try:
        exp = datetime.fromisoformat(row["expires_at"])
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
    except Exception:
        exp = datetime.now(timezone.utc) - timedelta(seconds=1)
    if exp < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="链接已过期")
    if row["max_downloads"] and row["downloads"] >= row["max_downloads"]:
        raise HTTPException(status_code=410, detail="下载次数已用完")
    ex = conn.execute("SELECT * FROM exports WHERE id=?", (row["export_id"],)).fetchone()
    if not ex or not ex["file_path"] or not Path(ex["file_path"]).exists():
        raise HTTPException(status_code=404, detail="文件已不存在")
    with db.cursor(write=True) as c:
        c.execute("UPDATE share_links SET downloads=downloads+1 WHERE token=?", (token,))
    return _ranged(Path(ex["file_path"]), request, f"{ex['id']}.zip")


@router.get("/projects/{pid}/export/scopes")
def export_scopes(pid: int, user: dict = Depends(auth.current_user)):
    conn = db.get_conn()
    total = conn.execute(
        "SELECT COUNT(*) c FROM images WHERE project_id=? AND status IN ('done','reviewed')", (pid,)
    ).fetchone()["c"]
    mine = conn.execute(
        "SELECT COUNT(*) c FROM images WHERE project_id=? AND assignee_id=?", (pid, user["id"])
    ).fetchone()["c"]
    return {
        "scopes": exporters.SCOPES,
        "splits": exporters.SPLIT_PRESETS,
        "counts": {"all": total, "done": total, "mine": mine},
    }
