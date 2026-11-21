"""清空业务数据（项目、图片、标注、导出、任务），保留账号与模型库。

用法：python tools/reset_data.py --yes
交付前用它把测试数据清理干净。
"""
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from annohub import config, db  # noqa: E402

TABLES = ["labels", "locks", "images", "batches", "exports", "share_links",
          "jobs", "events", "projects"]


def main():
    if "--yes" not in sys.argv:
        print("这会删除所有项目、图片、标注与导出记录（账号和模型保留）。")
        print("确认请加参数：python tools/reset_data.py --yes")
        return 1
    db.init_db()
    with db.cursor(write=True) as conn:
        for t in TABLES:
            try:
                conn.execute(f"DELETE FROM {t}")
            except Exception as exc:
                print(f"  跳过 {t}: {exc}")
        conn.execute("DELETE FROM sessions")
        try:  # 表用了隐式 rowid，没有 AUTOINCREMENT 时这张表不存在
            conn.execute("DELETE FROM sqlite_sequence WHERE name IN "
                         "('images','labels','batches','projects','events')")
        except Exception:
            pass
    for d in (config.projects_dir(), config.exports_dir(), config.thumbs_dir()):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)
    print("已清空业务数据。账号与模型库保留。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
