# -*- mode: python ; coding: utf-8 -*-
"""AnnoHub 打包脚本：python -m PyInstaller build.spec --noconfirm

产物：04_发布/AnnoHub/AnnoHub.exe（单文件）
模型与数据不打进包里，放在 exe 同级目录，方便替换。
"""
import os
from pathlib import Path

ROOT = Path(os.getcwd())
WEB = ROOT / "web"
OUT = ROOT.parent.parent / "04_发布"

a = Analysis(
    ["run.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[(str(WEB), "web")],
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "anyio._backends._asyncio",
        "multipart",
        "python_multipart",
        "PIL._tkinter_finder",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["torch", "torchvision", "matplotlib", "scipy", "pandas",
              "tkinter", "PyQt5", "PySide6"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="AnnoHub",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "build" / "annohub.ico"),
)
