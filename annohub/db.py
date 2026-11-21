"""SQLite 访问层：连接、建表、种子数据。

约定：
- 时间统一 ISO 8601 UTC 字符串（带 +00:00）
- 每线程一个连接（FastAPI 同步端点跑在线程池里）
- 写操作串行化，避免 database is locked
"""
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

_local = threading.local()
_write_lock = threading.RLock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.db_path()), timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect()
        _local.conn = conn
    return conn


@contextmanager
def cursor(write: bool = False):
    """取一个游标。write=True 时加全局写锁并自动提交/回滚。"""
    conn = get_conn()
    if write:
        with _write_lock:
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    else:
        yield conn


# ---------------------------------------------------------------- schema

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  pwd_hash      TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'annotator',
  active        INTEGER NOT NULL DEFAULT 1,
  must_change   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  task_type     TEXT    NOT NULL DEFAULT 'detect',
  desc          TEXT    DEFAULT '',
  labels_json   TEXT    NOT NULL DEFAULT '[]',
  status        TEXT    NOT NULL DEFAULT 'active',
  model_id      INTEGER,
  allow_export_all INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  file_name     TEXT    NOT NULL UNIQUE,
  task          TEXT    NOT NULL DEFAULT 'detect',
  imgsz         INTEGER NOT NULL DEFAULT 640,
  classes_json  TEXT    NOT NULL DEFAULT '[]',
  note          TEXT    DEFAULT '',
  source        TEXT    DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT    NOT NULL,
  source_root       TEXT    NOT NULL,
  crop_params_json  TEXT    NOT NULL,
  param_fingerprint TEXT    NOT NULL,
  n_images          INTEGER NOT NULL DEFAULT 0,
  n_empty           INTEGER NOT NULL DEFAULT 0,
  n_skipped         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  kind              TEXT    NOT NULL DEFAULT 'crop',
  note              TEXT    DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(project_id);

CREATE TABLE IF NOT EXISTS images (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id    INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  rel_path    TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  src_image   TEXT,
  src_x       INTEGER, src_y INTEGER, src_w INTEGER, src_h INTEGER,
  is_empty    INTEGER NOT NULL DEFAULT 0,
  green_ratio REAL    DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'todo',
  assignee_id INTEGER REFERENCES users(id),
  version     INTEGER NOT NULL DEFAULT 0,
  n_labels    INTEGER NOT NULL DEFAULT 0,
  prelabeled  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_project_status ON images(project_id, status);
CREATE INDEX IF NOT EXISTS idx_images_assignee ON images(project_id, assignee_id);
CREATE INDEX IF NOT EXISTS idx_images_batch ON images(batch_id);

CREATE TABLE IF NOT EXISTS labels (
  id         INTEGER PRIMARY KEY,
  image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  geom_type  TEXT    NOT NULL DEFAULT 'rect',
  geom_json  TEXT    NOT NULL,
  x1 REAL, y1 REAL, x2 REAL, y2 REAL,
  cls_name   TEXT    NOT NULL,
  conf       REAL,
  source     TEXT    NOT NULL DEFAULT 'human',
  difficult  INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_image ON labels(image_id);
CREATE INDEX IF NOT EXISTS idx_labels_cls ON labels(cls_name);

CREATE TABLE IF NOT EXISTS locks (
  image_id     INTEGER PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  acquired_at  TEXT    NOT NULL,
  heartbeat_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT    PRIMARY KEY,
  type         TEXT    NOT NULL,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending',
  progress     REAL    NOT NULL DEFAULT 0,
  message      TEXT    DEFAULT '',
  payload_json TEXT,
  result_json  TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exports (
  id           TEXT    PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id       TEXT,
  scope        TEXT    NOT NULL,
  options_json TEXT    NOT NULL,
  file_path    TEXT,
  size         INTEGER DEFAULT 0,
  n_images     INTEGER DEFAULT 0,
  n_labels     INTEGER DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'pending',
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL,
  expires_at   TEXT
);

CREATE TABLE IF NOT EXISTS share_links (
  token         TEXT    PRIMARY KEY,
  export_id     TEXT    NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  expires_at    TEXT    NOT NULL,
  max_downloads INTEGER NOT NULL DEFAULT 0,
  downloads     INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  project_id INTEGER,
  image_id   INTEGER,
  action     TEXT NOT NULL,
  payload    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
"""

SCHEMA_VERSION = 2

# 旧库升级：缺列就补，不删数据
MIGRATIONS = [
    ("users", "source", "TEXT NOT NULL DEFAULT 'admin'"),
    ("batches", "kind", "TEXT NOT NULL DEFAULT 'crop'"),
    ("batches", "note", "TEXT DEFAULT ''"),
    ("images", "origin", "TEXT NOT NULL DEFAULT 'crop'"),
    ("projects", "geom_types", "TEXT DEFAULT ''"),
    ("models", "meta_json", "TEXT DEFAULT ''"),
]

DEFAULT_SETTINGS = {
    # 允许同事自助注册
    "allow_register": "1",
    # 注册后是否需要管理员审批（1 = 先停用，审批后可用）
    "register_need_approval": "0",
    "site_note": "",
}


def _ensure_columns(conn) -> None:
    for table, col, decl in MIGRATIONS:
        try:
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        except Exception:
            continue
        if col not in cols:
            try:
                with _write_lock:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
                    conn.commit()
            except Exception:
                pass


def init_db() -> None:
    conn = get_conn()
    with _write_lock:
        conn.executescript(SCHEMA)
        conn.commit()

    _ensure_columns(conn)

    cur = conn.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    row = cur.fetchone()
    if row is None:
        with _write_lock:
            conn.execute(
                "INSERT INTO schema_version(version, applied_at) VALUES(?,?)",
                (SCHEMA_VERSION, now_iso()),
            )
            conn.commit()
    elif row["version"] < SCHEMA_VERSION:
        with _write_lock:
            conn.execute(
                "INSERT INTO schema_version(version, applied_at) VALUES(?,?)",
                (SCHEMA_VERSION, now_iso()),
            )
            conn.commit()

    for k, v in DEFAULT_SETTINGS.items():
        with _write_lock:
            conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
            conn.commit()

    # 种子：默认管理员 admin / admin123（首次登录强制改密提示）
    cur = conn.execute("SELECT COUNT(*) AS n FROM users")
    if cur.fetchone()["n"] == 0:
        from .auth import hash_password

        with _write_lock:
            conn.execute(
                "INSERT INTO users(username, display_name, pwd_hash, role, active, must_change, created_at)"
                " VALUES(?,?,?,?,1,1,?)",
                ("admin", "管理员", hash_password("admin123"), "admin", now_iso()),
            )
            conn.commit()


def log_event(action: str, user_id=None, project_id=None, image_id=None, payload=None) -> None:
    import json

    try:
        with cursor(write=True) as conn:
            conn.execute(
                "INSERT INTO events(ts,user_id,project_id,image_id,action,payload) VALUES(?,?,?,?,?,?)",
                (
                    now_iso(),
                    user_id,
                    project_id,
                    image_id,
                    action,
                    json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                ),
            )
    except Exception:
        pass


def get_setting(key: str, default=None):
    try:
        row = get_conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default
    except Exception:
        return default


def set_setting(key: str, value: str) -> None:
    with cursor(write=True) as conn:
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def get_bool(key: str, default: bool = False) -> bool:
    v = get_setting(key)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def set_bool(key: str, value: bool) -> None:
    set_setting(key, "1" if value else "0")
