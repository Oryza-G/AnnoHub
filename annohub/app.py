"""FastAPI 应用装配。"""
import json
import traceback
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, infer
from .routers import auth as r_auth
from .routers import exports as r_exports
from .routers import images as r_images
from .routers import jobs as r_jobs
from .routers import models as r_models
from .routers import projects as r_projects


def create_app() -> FastAPI:
    app = FastAPI(title=config.APP_NAME, version=config.VERSION, docs_url="/api/docs",
                  redoc_url=None)

    db.init_db()
    try:
        infer.sync_models()
    except Exception:
        pass

    for r in (r_auth, r_projects, r_images, r_jobs, r_exports, r_models):
        app.include_router(r.router)

    web_dir = config.WEB_DIR
    if (web_dir / "css").exists():
        app.mount("/css", StaticFiles(directory=str(web_dir / "css")), name="css")
    if (web_dir / "js").exists():
        app.mount("/js", StaticFiles(directory=str(web_dir / "js")), name="js")
    if (web_dir / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(web_dir / "assets")), name="assets")

    @app.get("/")
    def index():
        p = web_dir / "index.html"
        if not p.exists():
            return JSONResponse({"detail": "前端文件缺失，请检查 web/index.html"}, status_code=500)
        return FileResponse(p, headers={"Cache-Control": "no-cache"})

    @app.get("/favicon.ico")
    def favicon():
        p = web_dir / "assets" / "favicon.ico"
        if p.exists():
            return FileResponse(p)
        return JSONResponse({}, status_code=204)

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "version": config.VERSION}

    @app.exception_handler(Exception)
    async def on_error(request: Request, exc: Exception):
        try:
            (config.logs_dir() / "server.log").open("a", encoding="utf-8").write(
                f"\n[{db.now_iso()}] {request.method} {request.url.path}\n"
                f"{traceback.format_exc()[-2000:]}\n"
            )
        except Exception:
            pass
        return JSONResponse({"detail": f"服务器内部错误：{exc}"}, status_code=500)

    # 首次启动提示写入日志，便于排查
    try:
        (config.logs_dir() / "server.log").open("a", encoding="utf-8").write(
            f"\n[{db.now_iso()}] 启动 {config.APP_NAME} {config.VERSION}  data={config.data_dir()}\n"
        )
    except Exception:
        pass
    return app


app = create_app()
