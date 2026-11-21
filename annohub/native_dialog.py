"""本机原生文件/目录选择对话框。

浏览器出于安全限制无法弹出"服务端磁盘上的目录"，所以单机使用时由服务端
直接调用 Windows 原生对话框，选完把路径回传给网页。这样"点一下就能选目录"
和本地软件没有区别，也不用装 tkinter。

注意：对话框是阻塞的，一次只允许一个（并发请求会拿到 busy）。
"""
from __future__ import annotations

import sys
import threading

_busy = threading.Lock()

# comdlg32 / shell32 常量
OFN_READONLY = 0x00000001
OFN_OVERWRITEPROMPT = 0x00000002
OFN_HIDEREADONLY = 0x00000004
OFN_NOCHANGEDIR = 0x00000008
OFN_PATHMUSTEXIST = 0x00000800
OFN_FILEMUSTEXIST = 0x00001000
OFN_ALLOWMULTISELECT = 0x00000200
OFN_EXPLORER = 0x00080000
OFN_DONTADDTORECENT = 0x02000000

BIF_RETURNONLYFSDIRS = 0x0001
BIF_NEWDIALOGSTYLE = 0x0040
BIF_EDITBOX = 0x0010
BIF_USENEWUI = BIF_NEWDIALOGSTYLE | BIF_EDITBOX

BFFM_INITIALIZED = 1
BFFM_SETSELECTIONW = 0x0400 + 103
WM_USER = 0x0400


def available() -> bool:
    return sys.platform == "win32"


class Busy(Exception):
    pass


def _run_guarded(fn):
    if not available():
        raise RuntimeError("当前系统不支持原生文件对话框，请用界面里的浏览按钮")
    if not _busy.acquire(blocking=False):
        raise Busy("已经有一个文件选择窗口打开，请先处理它")
    try:
        return fn()
    finally:
        _busy.release()


def pick_folder(title: str = "选择文件夹", initial: str | None = None) -> str | None:
    return _run_guarded(lambda: _pick_folder(title, initial))


def pick_files(title: str = "选择图片", initial: str | None = None,
               multi: bool = True, patterns: str = "图片|*.jpg;*.jpeg;*.png;*.bmp;*.tif;*.tiff;*.webp|所有文件|*.*") -> list[str]:
    return _run_guarded(lambda: _pick_files(title, initial, multi, patterns))


def pick_file(title: str = "选择文件", initial: str | None = None,
              patterns: str = "所有文件|*.*") -> str | None:
    out = _run_guarded(lambda: _pick_files(title, initial, False, patterns))
    return out[0] if out else None


# ---------------------------------------------------------------- 实现

def _pick_folder(title: str, initial: str | None) -> str | None:
    import ctypes
    from ctypes import wintypes

    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    ole32 = ctypes.WinDLL("ole32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    class BROWSEINFOW(ctypes.Structure):
        _fields_ = [
            ("hwndOwner", wintypes.HWND),
            ("pidlRoot", ctypes.c_void_p),
            ("pszDisplayName", wintypes.LPWSTR),
            ("lpszTitle", wintypes.LPCWSTR),
            ("ulFlags", wintypes.UINT),
            ("lpfn", ctypes.c_void_p),
            ("lParam", wintypes.LPARAM),
            ("iImage", ctypes.c_int),
        ]

    BFFCALLBACK = ctypes.WINFUNCTYPE(ctypes.c_int, wintypes.HWND, wintypes.UINT,
                                     wintypes.LPARAM, wintypes.LPARAM)

    shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
    shell32.SHBrowseForFolderW.argtypes = [ctypes.POINTER(BROWSEINFOW)]
    shell32.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, wintypes.LPWSTR]
    shell32.SHGetPathFromIDListW.restype = wintypes.BOOL

    ole32.CoInitialize(None)
    try:
        # 把控制台窗口提到前台，对话框才有可见的属主
        try:
            hwnd = ctypes.windll.kernel32.GetConsoleWindow()
            if hwnd:
                user32.SetForegroundWindow(hwnd)
        except Exception:
            hwnd = 0

        def cb(h, msg, lp, data):
            if msg == BFFM_INITIALIZED:
                if initial:
                    user32.SendMessageW(h, BFFM_SETSELECTIONW, 1, ctypes.c_wchar_p(initial))
                user32.SetForegroundWindow(h)
            return 0

        callback = BFFCALLBACK(cb)
        buf = ctypes.create_unicode_buffer(1024)
        bi = BROWSEINFOW()
        bi.hwndOwner = hwnd or 0
        bi.pidlRoot = None
        bi.pszDisplayName = buf
        bi.lpszTitle = title
        bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_USENEWUI
        bi.lpfn = ctypes.cast(callback, ctypes.c_void_p)
        bi.lParam = 0
        bi.iImage = 0

        pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))
        if not pidl:
            return None
        path = ctypes.create_unicode_buffer(1024)
        if not shell32.SHGetPathFromIDListW(pidl, path):
            return None
        try:
            ctypes.windll.ole32.CoTaskMemFree(ctypes.c_void_p(pidl))
        except Exception:
            pass
        return path.value or None
    finally:
        ole32.CoUninitialize()


def _pick_files(title: str, initial: str | None, multi: bool, patterns: str) -> list[str]:
    import ctypes
    from ctypes import wintypes

    comdlg32 = ctypes.WinDLL("comdlg32", use_last_error=True)
    ole32 = ctypes.WinDLL("ole32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD),
            ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR),
            ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD),
            ("lpstrFile", wintypes.LPWSTR),
            ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD),
            ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR),
            ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR),
            ("lCustData", wintypes.LPARAM),
            ("lpfnHook", ctypes.c_void_p),
            ("lpTemplateName", wintypes.LPCWSTR),
            ("pvReserved", ctypes.c_void_p),
            ("dwReserved", wintypes.DWORD),
            ("FlagsEx", wintypes.DWORD),
        ]

    comdlg32.GetOpenFileNameW.argtypes = [ctypes.POINTER(OPENFILENAMEW)]
    comdlg32.GetOpenFileNameW.restype = wintypes.BOOL

    ole32.CoInitialize(None)
    try:
        try:
            hwnd = ctypes.windll.kernel32.GetConsoleWindow()
            if hwnd:
                user32.SetForegroundWindow(hwnd)
        except Exception:
            hwnd = 0

        size = 64 * 1024
        buf = ctypes.create_unicode_buffer(size)
        # 过滤器用 \0 分隔，结尾双 \0
        filt = "\0".join(patterns.split("|")) + "\0\0"

        flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_DONTADDTORECENT
        if multi:
            flags |= OFN_ALLOWMULTISELECT

        ofn = OPENFILENAMEW()
        ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
        ofn.hwndOwner = hwnd or 0
        ofn.lpstrFilter = filt
        ofn.nFilterIndex = 1
        ofn.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
        ofn.nMaxFile = size
        ofn.lpstrInitialDir = initial or None
        ofn.lpstrTitle = title
        ofn.Flags = flags

        if not comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):
            return []

        raw = buf[:]
        # 多选：目录 \0 文件1 \0 文件2 \0 ... \0
        parts = []
        cur = []
        for ch in raw:
            if ch == "\0":
                if not cur:
                    break
                parts.append("".join(cur))
                cur = []
            else:
                cur.append(ch)
        if not parts:
            return []
        if len(parts) == 1:
            return [parts[0]]
        import os

        base = parts[0]
        return [os.path.join(base, p) for p in parts[1:]]
    finally:
        ole32.CoUninitialize()
