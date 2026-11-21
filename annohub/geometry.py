"""几何规约：存储、导入、导出三处共用同一套定义。

geom_type 与 geom 的结构：
  rect      矩形      geom = [x1, y1, x2, y2]        像素坐标，浮点，不取整
  polygon   多边形    geom = [[x, y], [x, y], ...]   至少 3 点
  line      折线      geom = [[x, y], [x, y], ...]   至少 2 点
  point     点        geom = [x, y]
  classify  整图分类  geom = []

所有坐标一律是原图像素坐标（左上角为原点，x 向右，y 向下）。
缩放在渲染层做，落库和导出都不缩放、不取整。
"""
from __future__ import annotations

GEOM_TYPES = ("rect", "polygon", "line", "point", "classify")

# 中文名，前端与导出说明共用
GEOM_LABEL = {
    "rect": "矩形框",
    "polygon": "多边形",
    "line": "折线",
    "point": "关键点",
    "classify": "整图标签",
}

# 项目类型 -> 允许的几何类型（导入的标注不受此限，一律接收）
#
# 项目类型只描述"这个项目主要产出什么"，不锁死标注工具：除了整图分类，
# 其余类型的画布都同时开放矩形、多边形、折线、点、画笔，标注时可随时切换。
TASK_GEOMS = {
    "detect": list(("rect", "polygon", "line", "point")),
    "segment": list(("rect", "polygon", "line", "point")),
    "keypoint": list(("rect", "polygon", "line", "point")),
    "obb": list(("rect", "polygon", "line", "point")),
    "mixed": list(("rect", "polygon", "line", "point")),
    "classify": ["classify"],
}

# 新建项目时可选的四类（顺序即界面顺序）
PROJECT_TYPES = [
    {"v": "detect", "t": "目标检测", "d": "以矩形框为主，数目标、找位置"},
    {"v": "segment", "t": "实例分割", "d": "以多边形为主，要贴合轮廓、算面积"},
    {"v": "classify", "t": "图像分类", "d": "一张图一个类别，不画形状"},
    {"v": "mixed", "t": "其他", "d": "关键点、折线、旋转框等，工具全开"},
]

TASK_LABEL = {
    "detect": "目标检测",
    "segment": "实例分割",
    "keypoint": "关键点",
    "classify": "图像分类",
    "obb": "旋转框",
    "mixed": "其他",
}


def _f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def bbox_of(geom_type: str, geom, width: float, height: float) -> list[float]:
    """由 geom 求轴对齐包围盒。"""
    if geom_type == "rect":
        x1, y1, x2, y2 = (_f(geom[0]), _f(geom[1]), _f(geom[2]), _f(geom[3])) if len(geom) >= 4 else (0, 0, 0, 0)
        return [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]
    if geom_type == "point":
        x, y = (_f(geom[0]), _f(geom[1])) if len(geom) >= 2 else (0, 0)
        return [x, y, x, y]
    if geom_type in ("polygon", "line"):
        pts = [(p[0], p[1]) for p in (geom or []) if len(p) >= 2] if geom else []
        if not pts:
            return [0, 0, 0, 0]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return [min(xs), min(ys), max(xs), max(ys)]
    return [0, 0, float(width), float(height)]


def normalize(geom_type: str, geom, width: float, height: float,
              bbox: list[float] | None = None) -> tuple[str, list, list[float]] | None:
    """把外部传进来的标注规整成可入库的形式。

    返回 (geom_type, geom, bbox)；无效标注返回 None。
    bbox 可以只给 x1..y2（矩形快速路径），也可以不给、由 geom 反算。
    """
    gt = (geom_type or "rect").lower()
    if gt not in GEOM_TYPES:
        gt = "rect"
    w, h = max(1.0, float(width)), max(1.0, float(height))

    if gt == "classify":
        return "classify", [], [0.0, 0.0, w, h]

    if gt == "rect":
        if geom and len(geom) >= 4:
            x1, y1, x2, y2 = _f(geom[0]), _f(geom[1]), _f(geom[2]), _f(geom[3])
        elif bbox and len(bbox) >= 4:
            x1, y1, x2, y2 = _f(bbox[0]), _f(bbox[1]), _f(bbox[2]), _f(bbox[3])
        else:
            return None
        x1, x2 = sorted((_clamp(x1, 0, w), _clamp(x2, 0, w)))
        y1, y2 = sorted((_clamp(y1, 0, h), _clamp(y2, 0, h)))
        if x2 - x1 < 0.5 or y2 - y1 < 0.5:
            return None
        return "rect", [x1, y1, x2, y2], [x1, y1, x2, y2]

    if gt == "point":
        if geom and len(geom) >= 2:
            x, y = _f(geom[0]), _f(geom[1])
        elif bbox and len(bbox) >= 2:
            x, y = _f(bbox[0]), _f(bbox[1])
        else:
            return None
        x, y = _clamp(x, 0, w), _clamp(y, 0, h)
        return "point", [x, y], [x, y, x, y]

    # polygon / line
    pts = []
    for p in (geom or []):
        if isinstance(p, dict):
            px, py = _f(p.get("x")), _f(p.get("y"))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            px, py = _f(p[0]), _f(p[1])
        elif isinstance(p, (int, float)):
            continue
        else:
            continue
        pts.append([round(_clamp(px, 0, w), 2), round(_clamp(py, 0, h), 2)])
    need = 3 if gt == "polygon" else 2
    if len(pts) < need:
        return None
    return gt, pts, bbox_of(gt, pts, w, h)


def to_bbox(geom_type: str, geom, width: float, height: float) -> list[float]:
    """导出到只吃矩形框的格式时用。"""
    return bbox_of(geom_type, geom, width, height)


def yolo_seg_line(geom_type: str, geom, width: float, height: float) -> list[float]:
    """转成 YOLO 分割格式的归一化坐标序列（x1 y1 x2 y2 ...）。"""
    w, h = max(1.0, float(width)), max(1.0, float(height))
    if geom_type == "polygon" and geom:
        out = []
        for p in geom:
            out += [round(p[0] / w, 6), round(p[1] / h, 6)]
        return out
    if geom_type == "rect":
        x1, y1, x2, y2 = to_bbox("rect", geom, width, height)
        return [round(x1 / w, 6), round(y1 / h, 6), round(x2 / w, 6), round(y1 / h, 6),
                round(x2 / w, 6), round(y2 / h, 6), round(x1 / w, 6), round(y2 / h, 6)]
    return []
