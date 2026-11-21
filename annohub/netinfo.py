"""网卡选址与地址展示。

目的：让"把地址发给同事"这件事不依赖用户懂网络。
- 排除 Docker / VirtualBox / 无 DHCP 的虚拟网卡
- 有默认网关的私有地址作为主地址
- 同时给出计算机名访问方式（LLMNR / NetBIOS 解析，不受 DHCP 变化影响）
"""
import socket
import subprocess
import sys
import time

# 读网卡要起一次 PowerShell（1~2 秒），设置页每切一次标签都会问一次，
# 这里缓存 60 秒：开机后地址极少变化，没必要每次都重新扫。
_CACHE = {"t": 0.0, "data": None}
_CACHE_TTL = 60.0


def _is_windows() -> bool:
    return sys.platform == "win32"


_PRIVATE_PREFIXES = ("10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
                     "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
                     "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.")


def _is_virtual(name: str, ip: str) -> bool:
    low = name.lower()
    for kw in ("docker", "vmware", "virtualbox", "vbox", "hyper-v", "vethernet",
               "wsl", "tap", "tun", "loopback", "bluetooth", "loopback"):
        if kw in low:
            return True
    if ip.startswith("169.254."):
        return True
    if ip.startswith("172.17.") or ip.startswith("172.18."):
        return True
    return False


def _ps_ipconfig() -> list[dict]:
    """带缓存地读网卡地址；缓存期内直接返回上次结果。"""
    now = time.time()
    if _CACHE["data"] is not None and now - _CACHE["t"] < _CACHE_TTL:
        return _CACHE["data"]
    data = _ps_ipconfig_raw()
    if data:
        _CACHE["t"], _CACHE["data"] = now, data
    return data


def _ps_ipconfig_raw() -> list[dict]:
    """用 PowerShell 读取网卡地址；失败返回空列表。

    注意编码：Windows 中文系统上 PowerShell 输出可能是 GBK，直接 text=True
    会抛 UnicodeDecodeError，这里统一取字节再逐个编码尝试。
    """
    script = (
        "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
        "Get-NetIPAddress -AddressFamily IPv4 | "
        "Where-Object {$_.IPAddress -notlike '127.*'} | "
        "Select-Object IPAddress,InterfaceAlias,PrefixLength | ConvertTo-Json -Compress"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, timeout=10,
        )
        raw_bytes = proc.stdout or b""
        raw = ""
        for enc in ("utf-8", "gbk", "cp936", "latin-1"):
            try:
                raw = raw_bytes.decode(enc).strip()
                if raw:
                    break
            except UnicodeDecodeError:
                continue
        if not raw:
            return []
        import json

        data = json.loads(raw)
        if isinstance(data, dict):
            data = [data]
        return [
            {
                "ip": d.get("IPAddress"),
                "name": d.get("InterfaceAlias") or "",
                "prefix": d.get("PrefixLength"),
            }
            for d in data
            if d.get("IPAddress")
        ]
    except Exception:
        return []


def _socket_fallback() -> list[dict]:
    ips = []
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return [{"ip": ip, "name": "", "prefix": None} for ip in ips]


def list_addresses() -> list[dict]:
    raw = _ps_ipconfig() or _socket_fallback()
    seen, out = set(), []
    for item in raw:
        ip = item["ip"]
        if ip in seen:
            continue
        seen.add(ip)
        item["virtual"] = _is_virtual(item.get("name", ""), ip)
        item["private"] = ip.startswith(_PRIVATE_PREFIXES)
        out.append(item)
    # 主地址：非虚拟、私有网段、非 169.254
    main = next((x for x in out if not x["virtual"] and x["private"]), None)
    if main is None:
        main = next((x for x in out if not x["virtual"]), None)
    if main is None and out:
        main = out[0]
    for x in out:
        x["main"] = bool(main and x["ip"] == main["ip"])
    out.sort(key=lambda x: (not x["main"], x["virtual"], x["ip"]))
    return out


def hostname() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return "localhost"


def primary_ip() -> str:
    addrs = list_addresses()
    main = next((x for x in addrs if x["main"]), None)
    return main["ip"] if main else "127.0.0.1"


def access_info(port: int) -> dict:
    name = hostname()
    ip = primary_ip()
    return {
        "hostname": name,
        "ip": ip,
        "port": port,
        "url_ip": f"http://{ip}:{port}",
        "url_host": f"http://{name}:{port}",
        "addresses": list_addresses(),
        "hostname_note": "主机名地址在同一个局域网内通常可直接使用，IP 变化不影响它" if name else "",
    }


# ------------------------------------------------------------------ 局域网连通自检

def _run_netsh(args: list[str], timeout: int = 12) -> str:
    try:
        proc = subprocess.run(["netsh"] + args, capture_output=True, timeout=timeout)
        raw = proc.stdout or b""
        for enc in ("utf-8", "gbk", "cp936", "latin-1"):
            try:
                return raw.decode(enc, errors="ignore")
            except Exception:
                continue
        return ""
    except Exception:
        return ""


def firewall_rule_name(port: int) -> str:
    return f"AnnoHub {port}"


def firewall_status(port: int) -> dict:
    """检查是否已有放行规则。返回 {exists, enabled, detail}"""
    if not _is_windows():
        return {"exists": True, "enabled": True, "detail": "非 Windows，无需检查"}
    out = _run_netsh(["advfirewall", "firewall", "show", "rule",
                      f"name={firewall_rule_name(port)}"])
    exists = ("AnnoHub" in out and ("允许" in out or "Allow" in out)) or "AnnoHub" in out
    enabled = "否" not in out.split("启用")[-1][:8] if "启用" in out else True
    return {"exists": bool(exists), "enabled": bool(enabled),
            "detail": out.strip()[:600]}


def open_firewall(port: int) -> dict:
    """加一条入站放行规则。需要管理员权限，会弹一次 UAC。"""
    if not _is_windows():
        return {"ok": True, "detail": "非 Windows，跳过"}
    params = (f"advfirewall firewall add rule name=\"{firewall_rule_name(port)}\" "
              f"dir=in action=allow protocol=TCP localport={port} profile=any")
    try:
        import ctypes

        rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", "netsh", params, None, 0)
        if rc <= 32:
            return {"ok": False, "detail": "已被取消或没有管理员权限（UAC 未通过）"}
    except Exception as exc:
        return {"ok": False, "detail": f"调用失败：{exc}"}
    import time

    for _ in range(6):
        time.sleep(0.6)
        if firewall_status(port)["exists"]:
            return {"ok": True, "detail": "已放行"}
    return {"ok": False, "detail": "规则可能已添加，但读取状态超时；可以手动运行 netsh 检查"}


def port_listening(port: int) -> bool:
    import socket as _s

    for host in ("127.0.0.1",):
        try:
            with _s.create_connection((host, port), timeout=1.0):
                return True
        except Exception:
            continue
    return False


def network_profiles() -> list[dict]:
    if not _is_windows():
        return []
    script = (
        "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
        "Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory | "
        "ConvertTo-Json -Compress"
    )
    try:
        proc = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                              capture_output=True, timeout=10)
        raw = ""
        for enc in ("utf-8", "gbk", "cp936"):
            try:
                raw = (proc.stdout or b"").decode(enc).strip()
                if raw:
                    break
            except Exception:
                continue
        if not raw:
            return []
        import json

        data = json.loads(raw)
        if isinstance(data, dict):
            data = [data]
        out = []
        for d in data:
            cat = d.get("NetworkCategory")
            # PowerShell 枚举转 JSON 后是数字：0=公用 1=专用 2=域
            name_map = {0: "公用", 1: "专用", 2: "域", "0": "公用", "1": "专用", "2": "域"}
            cat_label = name_map.get(cat, str(cat or ""))
            out.append({"name": d.get("Name") or d.get("InterfaceAlias") or "",
                        "category": cat_label,
                        "private": cat_label in ("专用", "域")})
        return out
    except Exception:
        return []


def diagnostics(port: int) -> dict:
    fw = firewall_status(port)
    profs = network_profiles()
    public = [p for p in profs if not p["private"] and p["category"]]
    addrs = [a for a in list_addresses() if not a["virtual"]]
    hints = []
    if not fw["exists"]:
        hints.append("Windows 防火墙没有放行本程序的端口，这是同事打不开最常见的原因。"
                     "点下面的「放行端口」按钮，允许一次 UAC 弹窗即可。")
    elif not fw["enabled"]:
        hints.append("防火墙里已有规则但处于禁用状态，重新点「放行端口」会更新它。")
    if public:
        names = "、".join(p["name"] for p in public if p["name"])
        hints.append(f"当前网络（{names}）被 Windows 识别为「公用网络」，默认禁止别人访问本机。"
                     "加放行规则时已经按「所有配置文件」处理，所以放行后可用；"
                     "也可以在系统设置里把网络改成「专用网络」。")
    if len(addrs) > 1:
        ips = "、".join(a["ip"] for a in addrs)
        hints.append(f"这台电脑同时连着多个网络（{ips}），同事要用与自己同网段的那个地址，"
                     "两个都试试，哪个能开用哪个。")
    if not port_listening(port):
        hints.append("本机没有在监听该端口，服务可能已经停止。")
    if not hints:
        hints.append("本机侧检查正常。若同事仍打不开，请确认两台机器在同一网段，"
                     "且路由器没开「AP 隔离 / 访客网络」。")
    return {
        "port": port,
        "listening": port_listening(port),
        "firewall": fw,
        "profiles": profs,
        "addresses": addrs,
        "hints": hints,
    }
