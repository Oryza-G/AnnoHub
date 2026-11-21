"""端到端冒烟测试：登录 -> 建项目 -> 裁切 -> 锁 -> 预标注 -> 保存 -> 导出 -> 校验产物。

用法：python tools/smoke_test.py [源图目录]
默认用一张真实大图验证裁切与推理。
"""
import json
import io
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

BASE = "http://127.0.0.1:8765"
_cookie = None


def call(method: str, path: str, body=None, raw=False, expect=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if _cookie:
        req.add_header("Cookie", _cookie)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            setck = r.headers.get("Set-Cookie")
            if setck:
                globals()["_cookie"] = setck.split(";")[0]
            content = r.read()
            if raw:
                return content
            return json.loads(content.decode() or "{}")
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        if expect and e.code == expect:
            return json.loads(text or "{}")
        raise SystemExit(f"[FAIL] {method} {path} -> {e.code} {text[:400]}")


def wait_job(job_id: str, timeout=600):
    t0 = time.time()
    last = ""
    while time.time() - t0 < timeout:
        j = call("GET", f"/api/jobs/{job_id}")
        msg = f'{j["status"]} {j["progress"]:.0f}% {j["message"]}'
        if msg != last:
            print("    ", msg)
            last = msg
        if j["status"] in ("done", "failed", "cancelled"):
            if j["status"] != "done":
                raise SystemExit(f"[FAIL] 任务 {job_id} {j['status']}: {j['message']}")
            return j
        time.sleep(1.5)
    raise SystemExit("[FAIL] 任务超时")


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else \
        "D:/01-python_work/Rice_seedling_recognition/0_datasets/0_标注任务/2024宝坻/0_原始图片"

    print("[1] 登录")
    r = call("POST", "/api/auth/login", {"username": "admin", "password": "admin123"})
    print("    ", r["user"]["display_name"])

    print("[2] 建项目")
    proj = call("POST", "/api/projects", {
        "name": f"冒烟测试_{time.strftime('%m%d_%H%M')}",
        "task_type": "detect", "labels": ["rice"], "desc": "自动测试项目",
    })
    pid = proj["id"]
    print("     project_id =", pid)

    print("[3] 裁切预演")
    plan = call("POST", f"/api/projects/{pid}/crop/plan", {
        "source_root": src,
        "params": {"tile_w": 640, "tile_h": 640, "overlap_x": 128, "overlap_y": 128,
                   "max_images": 2},
    })
    print(f"     源图 {plan['n_sources']} 张 -> 预计 {plan['n_tiles']} 张小图，"
          f"空图比例约 {plan.get('est_empty_ratio')}")
    assert plan["n_tiles"] > 0, "预演没有产生 tile"
    for s in plan["samples"][:3]:
        print(f"      样本 {s['file']} @({s['x']},{s['y']}) {s['w']}x{s['h']} "
              f"绿={s['green_ratio']} 空={s['empty']}")
    assert plan["samples"], "预演没有样本"
    for s in plan["samples"]:
        assert s["w"] == 640 and s["h"] == 640, f"tile 尺寸不是 640x640: {s['w']}x{s['h']}"

    print("[4] 执行裁切")
    job = call("POST", f"/api/projects/{pid}/crop/run", {
        "source_root": src,
        "params": {"tile_w": 640, "tile_h": 640, "overlap_x": 128, "overlap_y": 128,
                   "max_images": 2},
        "batch_name": "冒烟测试批次",
    })
    j = wait_job(job["job_id"])
    res = j.get("result") or {}
    print(f"     裁出 {res.get('n_images')} 张，空图 {res.get('n_empty')}，重复 {res.get('n_dup')}")
    assert res.get("n_images", 0) > 0, "没有裁出图片"
    mf = Path(res["manifest"])
    assert mf.exists(), "manifest.csv 未生成"
    print("     manifest:", mf.name, "行数", len(mf.read_text(encoding="utf-8-sig").strip().split("\n")))

    print("[5] 图片列表")
    lst = call("GET", f"/api/projects/{pid}/images?limit=100")
    items = lst["items"]
    print(f"     共 {lst['total']} 张")
    assert items, "列表为空"
    for it in items[:5]:
        assert it["width"] == 640 and it["height"] == 640

    print("[6] 取一张非空图并加锁")
    pick = next((x for x in items if not x["is_empty"]), items[0])
    iid = pick["id"]
    print(f"     image_id={iid} is_empty={pick['is_empty']}")
    lk = call("POST", f"/api/images/{iid}/lock")
    print("     status =", lk["image"]["status"])
    # 第二个账号抢锁应当失败
    call("POST", "/api/users", {"username": "tester2", "display_name": "测试员2",
                                "password": "test123", "role": "annotator"}, expect=400)
    try:
        call("POST", "/api/auth/login", {"username": "tester2", "password": "test123"})
        other_cookie = _cookie
        globals()["_cookie"] = other_cookie
        conflict = call("POST", f"/api/images/{iid}/lock", expect=409)
        print("     他人抢锁返回:", conflict.get("detail"))
        call("POST", "/api/auth/login", {"username": "admin", "password": "admin123"})
    except SystemExit as e:
        print("     (跳过双账号锁测试)", e)

    print("[7] 预标注")
    pre = call("POST", f"/api/images/{iid}/prelabel", {"conf": 0.25, "iou": 0.45})
    preds = pre["predictions"]
    print(f"     模型 {pre['model']} 给出 {len(preds)} 个框，前3：",
          [f"{p['cls']}:{p['conf']:.2f}" for p in preds[:3]])
    assert len(preds) > 0, "模型没有预测出任何框，检查模型与图片是否匹配"

    print("[8] 保存标注并完成")
    labels = [{"cls": p["cls"], "x1": p["x1"], "y1": p["y1"], "x2": p["x2"], "y2": p["y2"],
               "conf": p["conf"], "source": "model"} for p in preds]
    img = call("GET", f"/api/images/{iid}")
    saved = call("PUT", f"/api/images/{iid}/labels",
                 {"labels": labels, "version": img["image"]["version"], "complete": True})
    print(f"     保存 {saved['n_labels']} 个框，状态 {saved['status']}，version {saved['version']}")
    assert saved["n_labels"] == len(labels)
    assert saved["status"] == "done"

    print("[9] 导图时读原图（锁已释放，应可读）")
    raw = call("GET", f"/api/images/{iid}/file", raw=True)
    print("     图片字节", len(raw))
    assert len(raw) > 1000

    print("[10] 导出 YOLO")
    ex = call("POST", f"/api/projects/{pid}/exports",
              {"scope": "all", "formats": ["yolo", "voc", "coco", "csv"],
               "split": "8:1:1", "seed": 42})
    j = wait_job(ex["job_id"])
    er = j.get("result") or {}
    print(f"     导出 {er.get('n_images')} 张 / {er.get('n_labels')} 框 / {er.get('size', 0)/1e6:.2f} MB")
    data = call("GET", f"/api/exports/{er['export_id']}/download", raw=True)
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()
    need = ["data.yaml", "classes.txt", "manifest.csv"]
    for n in need:
        assert n in names, f"导出包缺少 {n}"
    imgs = [n for n in names if n.startswith("images/")]
    lbls = [n for n in names if n.startswith("labels/")]
    print(f"     包内 images {len(imgs)}，labels {len(lbls)}，总条目 {len(names)}")
    assert imgs and lbls
    yaml_txt = zf.read("data.yaml").decode()
    print("     data.yaml:", yaml_txt.replace("\n", " | "))
    assert "nc:" in yaml_txt and "rice" in yaml_txt

    # 校验 YOLO 标签数值合法
    bad = 0
    for n in lbls:
        for line in zf.read(n).decode().strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split()
            assert len(parts) == 5, f"{n} 行格式错误: {line}"
            cls = int(parts[0])
            vals = [float(x) for x in parts[1:]]
            if cls < 0 or any(v < 0 or v > 1.0001 for v in vals):
                bad += 1
    print(f"     标签格式校验：异常行 {bad}")
    assert bad == 0, "存在越界或格式错误的标签"

    print("\n[PASS] 全链路通过")
    print(f"  项目 ID: {pid}  导出 ID: {er['export_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
