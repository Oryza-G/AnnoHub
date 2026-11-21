"""认证、自助注册与用户管理路由。"""
from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel

from .. import auth, config, db

router = APIRouter(prefix="/api", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


class RegisterIn(BaseModel):
    username: str
    password: str
    display_name: str = ""


class PwdIn(BaseModel):
    old: str
    new: str


class UserIn(BaseModel):
    username: str
    display_name: str
    password: str
    role: str = "annotator"


class UserPatch(BaseModel):
    display_name: str | None = None
    role: str | None = None
    active: bool | None = None
    password: str | None = None


@router.get("/auth/public")
def public_config():
    """登录页需要的信息，不需要登录。"""
    return {
        "app": config.APP_NAME,
        "version": config.VERSION,
        "allow_register": db.get_bool("allow_register", True),
        "need_approval": db.get_bool("register_need_approval", False),
        "note": db.get_setting("site_note", ""),
    }


@router.post("/auth/register")
def register(body: RegisterIn):
    if not db.get_bool("allow_register", True):
        raise HTTPException(status_code=403, detail="管理员已关闭自助注册，请向管理员要账号")
    username = body.username.strip()
    if len(username) < 3 or len(username) > 24:
        raise HTTPException(status_code=400, detail="账号长度需要在 3~24 个字符之间")
    if not username.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail="账号只能包含字母、数字、下划线和横线")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    exists = db.get_conn().execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if exists:
        raise HTTPException(status_code=400, detail="这个账号已经有人用了，换一个")
    need_approval = db.get_bool("register_need_approval", False)
    with db.cursor(write=True) as c:
        cur = c.execute(
            "INSERT INTO users(username,display_name,pwd_hash,role,active,must_change,created_at,source)"
            " VALUES(?,?,?,'annotator',?,0,?,'self')",
            (username, (body.display_name or username).strip(),
             auth.hash_password(body.password), 0 if need_approval else 1, db.now_iso()),
        )
        uid = cur.lastrowid
    db.log_event("register", user_id=uid, payload={"username": username,
                                                  "approval": need_approval})
    return {"ok": True, "id": uid, "need_approval": need_approval,
            "message": "注册成功，等管理员审批后即可登录" if need_approval else "注册成功，正在进入"}


@router.post("/auth/login")
def login(body: LoginIn, response: Response):
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM users WHERE username=?", (body.username.strip(),)).fetchone()
    if not row or not auth.verify_password(body.password, row["pwd_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    if not row["active"]:
        raise HTTPException(status_code=403, detail="账号还没启用，请联系管理员审批")
    token = auth.create_session(row["id"])
    response.set_cookie(
        auth.COOKIE_NAME, token, max_age=auth.SESSION_DAYS * 86400,
        httponly=True, samesite="lax", path="/",
    )
    db.log_event("login", user_id=row["id"])
    return {
        "user": {
            "id": row["id"], "username": row["username"],
            "display_name": row["display_name"], "role": row["role"],
            "must_change": bool(row["must_change"]),
        }
    }


@router.post("/auth/logout")
def logout(response: Response, user: dict = Depends(auth.current_user)):
    auth.drop_session(user["token"])
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(user: dict = Depends(auth.current_user)):
    return {"user": {k: v for k, v in user.items() if k != "token"}}


@router.post("/auth/password")
def change_password(body: PwdIn, user: dict = Depends(auth.current_user)):
    conn = db.get_conn()
    row = conn.execute("SELECT pwd_hash FROM users WHERE id=?", (user["id"],)).fetchone()
    if not auth.verify_password(body.old, row["pwd_hash"]):
        raise HTTPException(status_code=400, detail="原密码不正确")
    if len(body.new) < 6:
        raise HTTPException(status_code=400, detail="新密码至少 6 位")
    with db.cursor(write=True) as c:
        c.execute("UPDATE users SET pwd_hash=?, must_change=0 WHERE id=?",
                  (auth.hash_password(body.new), user["id"]))
    return {"ok": True}


@router.get("/users")
def list_users(user: dict = Depends(auth.current_user)):
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT u.id,u.username,u.display_name,u.role,u.active,u.created_at,u.source,"
        " (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id=u.id) AS last_seen,"
        " (SELECT COUNT(*) FROM images i WHERE i.assignee_id=u.id AND i.status IN ('done','reviewed'))"
        " AS n_done"
        " FROM users u ORDER BY u.id"
    ).fetchall()
    return {"users": [dict(r) for r in rows],
            "allow_register": db.get_bool("allow_register", True),
            "need_approval": db.get_bool("register_need_approval", False)}


@router.patch("/system/registration")
def set_registration(payload: dict = Body(...), user: dict = Depends(auth.require_admin)):
    if "allow_register" in payload:
        db.set_bool("allow_register", bool(payload["allow_register"]))
    if "need_approval" in payload:
        db.set_bool("register_need_approval", bool(payload["need_approval"]))
    return {"ok": True, "allow_register": db.get_bool("allow_register", True),
            "need_approval": db.get_bool("register_need_approval", False)}


@router.delete("/users/{uid}")
def delete_user(uid: int, user: dict = Depends(auth.require_admin)):
    if uid == user["id"]:
        raise HTTPException(status_code=400, detail="不能删除自己")
    row = db.get_conn().execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")
    with db.cursor(write=True) as c:
        c.execute("UPDATE images SET assignee_id=NULL WHERE assignee_id=?", (uid,))
        c.execute("DELETE FROM users WHERE id=?", (uid,))
    db.log_event("user_delete", user_id=user["id"], payload={"username": row["username"]})
    return {"ok": True}


@router.post("/users/{uid}/approve")
def approve_user(uid: int, user: dict = Depends(auth.require_admin)):
    with db.cursor(write=True) as c:
        c.execute("UPDATE users SET active=1 WHERE id=?", (uid,))
    return {"ok": True}


@router.post("/users")
def create_user(body: UserIn, user: dict = Depends(auth.require_admin)):
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    try:
        with db.cursor(write=True) as c:
            cur = c.execute(
                "INSERT INTO users(username,display_name,pwd_hash,role,active,must_change,created_at)"
                " VALUES(?,?,?,?,1,1,?)",
                (body.username.strip(), body.display_name.strip() or body.username,
                 auth.hash_password(body.password), body.role, db.now_iso()),
            )
            uid = cur.lastrowid
    except Exception:
        raise HTTPException(status_code=400, detail="用户名已存在")
    db.log_event("user_create", user_id=user["id"], payload={"target": uid})
    return {"id": uid}


@router.patch("/users/{uid}")
def patch_user(uid: int, body: UserPatch, user: dict = Depends(auth.require_admin)):
    sets, args = [], []
    if body.display_name is not None:
        sets.append("display_name=?")
        args.append(body.display_name)
    if body.role is not None:
        sets.append("role=?")
        args.append(body.role)
    if body.active is not None:
        sets.append("active=?")
        args.append(1 if body.active else 0)
    if body.password:
        if len(body.password) < 6:
            raise HTTPException(status_code=400, detail="密码至少 6 位")
        sets.append("pwd_hash=?")
        sets.append("must_change=1")
        args.append(auth.hash_password(body.password))
    if not sets:
        return {"ok": True}
    args.append(uid)
    with db.cursor(write=True) as c:
        c.execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", args)
    return {"ok": True}
