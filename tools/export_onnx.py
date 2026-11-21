"""把 ultralytics .pt 权重导出为 ONNX，并生成 AnnoHub 模型元数据。

用法（在有 ultralytics 的环境里跑一次即可）：
    python export_onnx.py <best.pt> <输出目录> [模型显示名]

服务端只用 onnxruntime，不依赖 torch。换模型时重复本脚本即可。
"""
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    pt_path = Path(sys.argv[1]).resolve()
    out_dir = Path(sys.argv[2]).resolve()
    display = sys.argv[3] if len(sys.argv) > 3 else pt_path.parent.parent.parent.name
    out_dir.mkdir(parents=True, exist_ok=True)

    from ultralytics import YOLO

    model = YOLO(str(pt_path))
    names = model.names
    if isinstance(names, dict):
        classes = [names[k] for k in sorted(names)]
    else:
        classes = list(names)
    imgsz = 640
    try:
        imgsz = int(model.ckpt.get("train_args", {}).get("imgsz", 640) or 640)
    except Exception:
        pass

    print(f"[1/3] 载入 {pt_path.name}  类别={classes}  imgsz={imgsz}")
    exported = model.export(format="onnx", imgsz=imgsz, opset=12, simplify=True, dynamic=False)
    onnx_path = Path(exported)
    print(f"[2/3] 导出完成 {onnx_path}  {onnx_path.stat().st_size/1e6:.1f} MB")

    stem = pt_path.stem
    target = out_dir / f"{display.replace(' ', '_')}_{stem}.onnx"
    shutil.copy2(onnx_path, target)

    meta = {
        "display_name": display,
        "file": target.name,
        "task": "detect",
        "imgsz": imgsz,
        "classes": classes,
        "source": str(pt_path),
        "note": "由 ultralytics 导出的 YOLO 检测模型",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out_dir / f"{target.stem}.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[3/3] 已写入 {target.name} 与 {target.stem}.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
