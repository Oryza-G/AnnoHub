"""全局路径与常量。

数据目录优先级：环境变量 ANNOTOHUB_DATA > 源码同级 data/ 。
这样开发时数据落在仓库里，打包后把 ANNOTOHUB_DATA 指到程序目录即可。
"""
import os
import sys
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent          # .../annohub/annohub
SRC_DIR = PKG_DIR.parent                           # .../annohub

FROZEN = bool(getattr(sys, "frozen", False))
# 打包后：静态资源在解压目录，数据与模型放在 exe 同级，重启不丢
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", SRC_DIR)) if FROZEN else SRC_DIR
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else SRC_DIR
WEB_DIR = BUNDLE_DIR / "web"

VERSION = "1.4.0"
APP_NAME = "AnnoHub 标注台"
DEFAULT_PORT = 8765

# 锁心跳超时（秒）：浏览器关闭后 90 秒自动释放
LOCK_TTL = 90
# 自动保存间隔建议值，前端读取
AUTOSAVE_SECONDS = 30


def data_dir() -> Path:
    env = os.environ.get("ANNOTOHUB_DATA")
    if env:
        d = Path(env).expanduser().resolve()
    else:
        d = APP_DIR / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def sub_dir(name: str) -> Path:
    d = data_dir() / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "annohub.db"


def projects_dir() -> Path:
    return sub_dir("projects")


def project_dir(project_id: int) -> Path:
    d = projects_dir() / str(project_id)
    (d / "images").mkdir(parents=True, exist_ok=True)
    return d


def thumbs_dir() -> Path:
    return sub_dir("thumbs")


def exports_dir() -> Path:
    return sub_dir("exports")


def models_dir() -> Path:
    # 模型跟着程序目录走，换模型直接替换文件即可
    env = os.environ.get("ANNOTOHUB_MODELS")
    d = Path(env).expanduser().resolve() if env else (APP_DIR / "models")
    d.mkdir(parents=True, exist_ok=True)
    return d


def logs_dir() -> Path:
    return sub_dir("logs")
