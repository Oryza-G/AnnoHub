"""AnnoHub 启动器。

双击运行（或用 python run.py）后：
1. 若本机已有 AnnoHub 在跑，直接打开浏览器，不重复启动
2. 否则找可用端口启动服务，自动打开浏览器
3. 控制台打印局域网地址，方便发给同事

参数：
  --port 8765     指定端口
  --host 0.0.0.0  监听地址（0.0.0.0 允许局域网访问）
  --no-browser    不自动打开浏览器

账号维护（执行完即退出）：
  --reset-admin [密码]   重置 admin 密码，缺省为 admin123
  --promote 用户名       把已有账号提升为管理员
  --list-users           列出全部账号
"""
import argparse
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

from annohub import config, netinfo


def _setup_console() -> None:
    """Windows 控制台默认是 GBK，中文会乱码；切到 UTF-8 代码页再重定向 stdout。"""
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def is_annohub(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1.2) as r:
            return b"annohub" in r.read().lower() or b'"ok":true' in r.read().lower()
    except Exception:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1.2) as r:
                return r.status == 200
        except Exception:
            return False


def pick_port(start: int) -> int:
    for p in range(start, start + 30):
        if port_free(p):
            return p
    return start


def _is_admin() -> bool:
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def ensure_firewall(port: int) -> str:
    """返回状态：ok / added / need_admin / skipped"""
    try:
        st = netinfo.firewall_status(port)
    except Exception:
        return "skipped"
    if st.get("exists"):
        return "ok"
    if not _is_admin():
        return "need_admin"
    import subprocess

    try:
        subprocess.run(
            ["netsh", "advfirewall", "firewall", "add", "rule",
             f"name={netinfo.firewall_rule_name(port)}", "dir=in", "action=allow",
             "protocol=TCP", f"localport={port}", "profile=any"],
            capture_output=True, timeout=15,
        )
        return "added" if netinfo.firewall_status(port).get("exists") else "need_admin"
    except Exception:
        return "need_admin"


def maintenance(args) -> int | None:
    """账号维护类参数：做完即退出，不启动服务。"""
    want = (args.reset_admin is not None) or args.promote or args.list_users
    if not want:
        return None

    from annohub import auth, db

    db.init_db()
    conn = db.get_conn()

    if args.list_users:
        rows = conn.execute(
            "SELECT id, username, display_name, role, active FROM users ORDER BY id").fetchall()
        print("\n  账号列表")
        print("  " + "-" * 52)
        for r in rows:
            print(f"  #{r['id']:<3} {r['username']:<18} {r['display_name'] or '':<12}"
                  f" {r['role']:<9} {'启用' if r['active'] else '停用'}")
        print()

    if args.reset_admin is not None:
        pwd = args.reset_admin or "admin123"
        if len(pwd) < 6:
            print("  新密码至少 6 位。", flush=True)
            return 2
        row = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()
        with db.cursor(write=True) as c:
            if row:
                c.execute("UPDATE users SET pwd_hash=?, role='admin', active=1, must_change=0"
                          " WHERE id=?", (auth.hash_password(pwd), row["id"]))
            else:
                c.execute("INSERT INTO users (username, display_name, pwd_hash, role, active,"
                          " must_change, created_at, source) VALUES (?,?,?,?,?,?,?,'cli')",
                          ("admin", "管理员", auth.hash_password(pwd), "admin", 1, 0, db.now_iso()))
        print(f"  管理员账号已重置：admin / {pwd}（请登录后立即修改）", flush=True)

    if args.promote:
        row = conn.execute("SELECT id, role FROM users WHERE username=?",
                           (args.promote,)).fetchone()
        if not row:
            print(f"  没有找到账号 {args.promote}。可用 --list-users 查看现有账号。", flush=True)
            return 2
        with db.cursor(write=True) as c:
            c.execute("UPDATE users SET role='admin', active=1 WHERE id=?", (row["id"],))
        print(f"  {args.promote} 已提升为管理员。", flush=True)

    print(f"  数据目录：{config.data_dir()}", flush=True)
    return 0


def banner(port: int) -> str:
    info = netinfo.access_info(port)
    lines = [
        "",
        "  " + "=" * 58,
        f"  {config.APP_NAME}  v{config.VERSION}",
        "  " + "=" * 58,
        "",
        "  本机打开：",
        f"    http://127.0.0.1:{port}",
        "",
        "  同事访问（同一局域网）：",
        f"    {info['url_host']}      ← 推荐，IP 变了也能用",
    ]
    for a in info["addresses"]:
        if a["virtual"]:
            continue
        tag = " ← 主用" if a["main"] else ""
        lines.append(f"    http://{a['ip']}:{port}{tag}"
                     + (f"   ({a['name']})" if a.get("name") else ""))
    lines += [
        "",
        f"  数据目录：{config.data_dir()}",
        "  首次登录：admin / admin123（登录后请改密码）",
        "  忘记密码：在本目录执行 AnnoHub.exe --reset-admin",
        "",
        "  关闭本窗口即停止服务。程序运行期间请不要让电脑睡眠。",
        "  " + "=" * 58,
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    _setup_console()
    ap = argparse.ArgumentParser(description="AnnoHub 标注台")
    ap.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--reset-admin", nargs="?", const="", metavar="PASSWORD",
                    help="重置 admin 密码（默认 admin123）后退出")
    ap.add_argument("--promote", metavar="USERNAME", help="把某个账号提升为管理员后退出")
    ap.add_argument("--list-users", action="store_true", help="列出所有账号后退出")
    args = ap.parse_args()

    rc = maintenance(args)
    if rc is not None:
        return rc

    if is_annohub(args.port):
        print(f"检测到 AnnoHub 已在 {args.port} 端口运行，直接打开浏览器。", flush=True)
        if not args.no_browser:
            webbrowser.open(f"http://127.0.0.1:{args.port}")
        return 0

    port = args.port if port_free(args.port) else pick_port(args.port + 1)
    if port != args.port:
        print(f"端口 {args.port} 被占用，改用 {port}", flush=True)

    print(banner(port), flush=True)

    fw = ensure_firewall(port)
    if fw == "added":
        print(f"  已自动放行防火墙端口 {port}，同事现在可以访问。", flush=True)
    elif fw == "need_admin":
        print(f"  [注意] 防火墙还没有放行 {port} 端口，同事可能打不开。\n"
              f"  解决：以管理员身份重新运行一次本程序，或在「设置 → 局域网访问」点一键放行。",
              flush=True)

    if not args.no_browser:
        def open_later():
            time.sleep(1.6)
            try:
                webbrowser.open(f"http://127.0.0.1:{port}")
            except Exception:
                pass

        threading.Thread(target=open_later, daemon=True).start()

    import uvicorn

    # 直接传 app 对象而不是 "模块:属性" 字符串，PyInstaller 才能静态分析到入口
    from annohub.app import app as fastapi_app

    uvicorn.run(fastapi_app, host=args.host, port=port, log_level="warning",
                access_log=False, reload=False)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已停止。")
