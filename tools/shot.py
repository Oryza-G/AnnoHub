"""界面截图与前端报错收集。用系统 Edge，不额外下载浏览器。

用法：python tools/shot.py [项目ID]
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
OUT = Path(__file__).resolve().parent.parent / "data" / "shots"
OUT.mkdir(parents=True, exist_ok=True)

errors = []


def main():
    pid = sys.argv[1] if len(sys.argv) > 1 else None
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True,
                                    args=["--disable-gpu", "--force-device-scale-factor=1"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text}")
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(600)
        shot(page, "01-登录")

        page.fill("#u", "admin")
        page.fill("#p", "admin123")
        page.click("button[type=submit]")
        page.wait_for_timeout(1600)
        shot(page, "02-项目列表")

        # 进入项目
        cards = page.query_selector_all("[data-pid]")
        target = None
        if pid:
            target = page.query_selector(f'[data-pid="{pid}"]')
        if not target and cards:
            target = cards[0]
        if target:
            target.click()
            page.wait_for_timeout(1400)
            shot(page, "03-项目概览")

            for tab, name in (("images", "04-图片"), ("crop", "05-裁切"),
                              ("export", "06-导出"), ("settings", "07-设置")):
                el = page.query_selector(f'[data-tab="{tab}"]')
                if el:
                    el.click()
                    page.wait_for_timeout(1100)
                    shot(page, name)

            # 标注页
            page.click("#btn-annotate")
            page.wait_for_timeout(2600)
            shot(page, "08-标注页")

            # 模型库
            page.goto(BASE + "/#/models", wait_until="networkidle")
            page.wait_for_timeout(1200)
            shot(page, "09-模型库")

            page.goto(BASE + "/#/settings", wait_until="networkidle")
            page.wait_for_timeout(1000)
            shot(page, "10-设置")

        browser.close()

    print("截图目录:", OUT)
    for f in sorted(OUT.glob("*.png")):
        print("  ", f.name)
    if errors:
        print("\n前端报错 / 警告：")
        for e in dict.fromkeys(errors):
            print("  ", e[:300])
    else:
        print("\n没有前端报错")


def shot(page, name):
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=False)


if __name__ == "__main__":
    main()
