"""认证：PBKDF2 密码、会话 token、FastAPI 依赖。"""
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request

from . import db

COOKIE_NAME = "ah_token"
SESSION_DAYS = 30
_PBKDF2_ROUNDS = 120_000

_last_touch: dict[str, float] = {}


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, rounds, salt_hex, hash_hex = stored.split("$")
        if scheme != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with db.cursor(write=True) as conn:
        conn.execute(
            "INSERT INTO sessions(token,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)",
            (
                token,
                user_id,
                db.now_iso(),
                db.now_iso(),
                (now + timedelta(days=SESSION_DAYS)).isoformat(timespec="seconds"),
            ),
        )
    return token


def drop_session(token: str) -> None:
    with db.cursor(write=True) as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


def _token_of(request: Request) -> str | None:
    tok = request.cookies.get(COOKIE_NAME)
    if tok:
        return tok
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.query_params.get("token")


def current_user(request: Request) -> dict:
    token = _token_of(request)
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    conn = db.get_conn()
    row = conn.execute(
        "SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.role, u.active, u.must_change"
        " FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?",
        (token,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="会话已失效，请重新登录")
    if not row["active"]:
        raise HTTPException(status_code=403, detail="账号已停用")
    now = datetime.now(timezone.utc)
    try:
        exp = datetime.fromisoformat(row["expires_at"])
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
    except Exception:
        exp = now
    if exp <= now:
        drop_session(token)
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

    # 每 60 秒刷新一次 last_seen，避免每个请求都写库
    try:
        prev = _last_touch.get(token, 0)
        now_ts = now.timestamp()
        if now_ts - prev > 60:
            _last_touch[token] = now_ts
            touch_session(token)
    except Exception:
        pass

    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "must_change": bool(row["must_change"]),
        "token": token,
    }


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def touch_session(token: str) -> None:
    with db.cursor(write=True) as conn:
        conn.execute("UPDATE sessions SET last_seen=? WHERE token=?", (db.now_iso(), token))
