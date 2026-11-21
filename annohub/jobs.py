"""后台任务框架：裁切、预标注、导出共用。

线程池 2 个 worker（裁切与推理都吃满 CPU 时不宜并行太多）。
进度写库，前端 1.5 秒轮询一次，简单可靠，不依赖 WebSocket。
"""
import json
import secrets
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

from . import db


class JobCancelled(Exception):
    pass


class Job:
    def __init__(self, job_id: str, payload: dict | None = None):
        self.id = job_id
        self.payload = payload or {}
        self._cancel = threading.Event()
        self._p = 0.0
        self._last_written = -1

    # -- 供任务函数调用
    def progress(self, pct: float, message: str | None = None) -> None:
        pct = max(0.0, min(100.0, float(pct)))
        self._p = pct
        if int(pct) == int(self._last_written) and message is None:
            return
        self._last_written = pct
        try:
            with db.cursor(write=True) as conn:
                if message is None:
                    conn.execute("UPDATE jobs SET progress=? WHERE id=?", (pct, self.id))
                else:
                    conn.execute(
                        "UPDATE jobs SET progress=?, message=? WHERE id=?", (pct, message, self.id)
                    )
        except Exception:
            pass

    def check_cancel(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()


_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="annohub-job")
_running: dict[str, Job] = {}
_running_lock = threading.Lock()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def submit(
    job_type: str,
    fn,
    *,
    project_id: int | None = None,
    user_id: int | None = None,
    payload: dict | None = None,
    prefix: str | None = None,
) -> str:
    job_id = _new_id(prefix or job_type)
    payload = payload or {}
    with db.cursor(write=True) as conn:
        conn.execute(
            "INSERT INTO jobs(id,type,project_id,status,progress,message,payload_json,created_by,created_at)"
            " VALUES(?,?,?,'pending',0,'排队中',?,?,?)",
            (
                job_id,
                job_type,
                project_id,
                json.dumps(payload, ensure_ascii=False),
                user_id,
                db.now_iso(),
            ),
        )
    job = Job(job_id, payload)
    with _running_lock:
        _running[job_id] = job

    def runner():
        with _running_lock:
            _running[job_id] = job
        try:
            with db.cursor(write=True) as conn:
                conn.execute(
                    "UPDATE jobs SET status='running', started_at=?, message='开始执行' WHERE id=?",
                    (db.now_iso(), job_id),
                )
            result = fn(job)
            with db.cursor(write=True) as conn:
                conn.execute(
                    "UPDATE jobs SET status='done', progress=100, message='已完成',"
                    " result_json=?, finished_at=? WHERE id=?",
                    (
                        json.dumps(result, ensure_ascii=False, default=str) if result else None,
                        db.now_iso(),
                        job_id,
                    ),
                )
        except JobCancelled:
            with db.cursor(write=True) as conn:
                conn.execute(
                    "UPDATE jobs SET status='cancelled', message='已取消', finished_at=? WHERE id=?",
                    (db.now_iso(), job_id),
                )
        except Exception as exc:
            tb = traceback.format_exc()[-1500:]
            with db.cursor(write=True) as conn:
                conn.execute(
                    "UPDATE jobs SET status='failed', message=?, finished_at=? WHERE id=?",
                    (f"{exc}"[:400], db.now_iso(), job_id),
                )
            try:
                from . import config

                (config.logs_dir() / "jobs.log").open("a", encoding="utf-8").write(
                    f"\n[{db.now_iso()}] {job_id}\n{tb}\n"
                )
            except Exception:
                pass
        finally:
            with _running_lock:
                _running.pop(job_id, None)

    _executor.submit(runner)
    return job_id


def cancel(job_id: str) -> bool:
    with _running_lock:
        job = _running.get(job_id)
    if job is None:
        return False
    job._cancel.set()
    return True


def get(job_id: str) -> dict | None:
    row = db.get_conn().execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        return None
    with _running_lock:
        alive = job_id in _running
    d = dict(row)
    d["alive"] = alive
    for k in ("payload_json", "result_json"):
        if d.get(k):
            try:
                d[k.replace("_json", "")] = json.loads(d[k])
            except Exception:
                d[k.replace("_json", "")] = None
    return d


def list_jobs(project_id: int | None = None, limit: int = 30) -> list[dict]:
    conn = db.get_conn()
    if project_id:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
            (project_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("result_json"):
            try:
                d["result"] = json.loads(d["result_json"])
            except Exception:
                d["result"] = None
        out.append(d)
    return out
