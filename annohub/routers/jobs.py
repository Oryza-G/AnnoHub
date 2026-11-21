"""任务查询与取消。裁切、预标注、导出共用。"""
from fastapi import APIRouter, Depends, HTTPException

from .. import auth, jobs

router = APIRouter(prefix="/api", tags=["jobs"])


@router.get("/jobs/{job_id}")
def get_job(job_id: str, user: dict = Depends(auth.current_user)):
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="任务不存在")
    return j


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, user: dict = Depends(auth.current_user)):
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="任务不存在")
    if j["status"] not in ("pending", "running"):
        return {"ok": False, "message": "任务已结束"}
    ok = jobs.cancel(job_id)
    return {"ok": ok}


@router.get("/projects/{pid}/jobs")
def project_jobs(pid: int, limit: int = 20, user: dict = Depends(auth.current_user)):
    return {"jobs": jobs.list_jobs(pid, limit)}
