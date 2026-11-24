# AnnoHub

**English** | [简体中文](README.zh-CN.md)

Self-hosted image annotation server for Windows. One executable, one LAN address, no Docker, no cloud account.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Oryza-G/AnnoHub)](https://github.com/Oryza-G/AnnoHub/releases/latest)
![Platform](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4)
![Python](https://img.shields.io/badge/python-3.10%2B-3776AB)

![Rice seedling detection with model-predicted boxes](docs/screenshots/04-annotate.jpg)

*Pre-label output from the rice-seedling ONNX model on a 512×512 tile. The red boxes are model predictions; the number on each box is confidence.*

## Why this exists

A remote-sensing or plant-phenotyping group ends up with a few thousand drone images and a deadline. Four things have to happen: cut the images into tiles, hand the tiles to several people, stop two people from annotating the same tile, and export something Ultralytics can read.

Each step has a tool that does it well. Chaining them means copying folders by hand, fixing class-name mismatches, and reconciling three label formats before training. The projects that cover all four — CVAT, Label Studio — want Docker, someone to administer it, and usually a GPU machine.

AnnoHub targets the case in between: a group with one Windows workstation, a shared drive, and no infrastructure budget. The server and the web UI ship as a single 49 MB executable. Double-click it, hand the printed address to your colleagues, and they annotate in a browser with no client install and no accounts on anyone else's cloud.

Data never leaves the machine running the executable.

## What it handles

**Prepare images.** Cut a 12000×9000 mosaic into 640×640 tiles with configurable overlap and edge alignment, in JPG or PNG. Or import an existing folder of tiles and deduplicate by content hash.

**Annotate.** Rectangles, polygons, polylines, points, a freehand brush that closes into a polygon, and whole-image classification. All drawing tools stay available in every project type except classification — the type only decides which tool is preselected and which export format is the default.

**Share the work.** Self-service sign-up with admin approval, role assignment, and task allocation by member or by source group. Progress counts per member, per group, per project.

**Work at tile scale.** The annotation list fetches project metadata once and renders only the source groups you expand, so a 1,845-tile project opens fully listed instead of asking you to click “load more” twelve times. Collapsing a group is a CSS toggle, not a full list rebuild.

**Pre-label.** Load an ONNX model — detection, instance segmentation, or classification — and run it on one image, a selection, or a whole batch. Review and correct instead of drawing from zero. No PyTorch or CUDA required; onnxruntime on CPU is enough for tile-sized inference.

**Export.** 6 formats × 10 split ratios × 6 scopes, packaged as a zip with a manifest and a format note. Detection and segmentation labels go to separate directories so a combined export does not overwrite itself.

## Quick start

**Prebuilt binary.** Download `AnnoHub.exe` from [Releases](https://github.com/Oryza-G/AnnoHub/releases/latest), put it in an empty folder, double-click it. The first run creates a `data` folder beside the executable. The browser opens at `http://127.0.0.1:8765`; sign in with `admin / admin123` and change the password. Windows SmartScreen will warn about an unsigned binary — that is expected, there is no code-signing certificate.

**From source.** Python 3.10 or newer.

```bash
git clone https://github.com/Oryza-G/AnnoHub.git
cd AnnoHub
pip install -r requirements.txt
python run.py
```

Set `ANNOTOHUB_DATA` to move the data directory somewhere other than `./data`.

**Letting colleagues in.** The server listens on `0.0.0.0:8765`. If their browsers cannot reach it, the port is almost always blocked by Windows Firewall. Run the program once as administrator, or open Settings → LAN access → open port and confirm the system prompt. The same page shows every adapter address with a copy button, plus a short message you can paste into a group chat.

## Workflow

Create a project → pick a type and define classes → crop or import images → allocate tasks → annotate (optionally after a pre-label run) → export.

Four project types: object detection, instance segmentation, image classification, and other (keypoints, polylines, oriented boxes — everything enabled). The type describes the main output, not a restriction on tools.

![Project list](docs/screenshots/01-projects.jpg)

The full operating guide is in [docs/manual.md](docs/manual.md) (Chinese).

## Concurrent editing

Two people opening the same image is the failure mode that silently destroys work in a shared annotation folder. AnnoHub prevents it at the image level instead of the project level:

- Opening an image takes a lease. The client renews every 30 seconds; a lease that goes 90 seconds without renewal is released automatically, so a crashed browser does not lock an image forever.
- Saving carries the version the client started from. If someone else saved in between, the write is rejected with `409` and the client is told to reload, rather than overwriting their work.

Geometry is stored as `geom_type` plus `geom_json`, with rectangles also duplicated into `x1/y1/x2/y2` columns for fast filtering and statistics. Coordinates are original-image pixels; scaling happens only at render time, so exports are never rounded.

## Export formats

| Format | Structure |
|---|---|
| YOLO detection | `images/` `labels/` `data.yaml` |
| YOLO segmentation | `images/` `labels/` with polygon vertices |
| YOLO classification | `images/{train,val}/{class}/` |
| Pascal VOC | `JPEGImages/` `Annotations/` `ImageSets/` |
| COCO | `instances_{split}.json`, with `segmentation` and `keypoints` |
| CSV | One row per annotation, original coordinates |

A YOLO detection package contains:

```
images/train/  images/val/  images/test/
labels/train/  labels/val/  labels/test/
data.yaml
manifest.csv
README_yolo.txt
```

Splits are `none`, `9:1`, `8:2`, `7:3`, `3:1`, `1:1`, `8:1:1`, `7:2:1`, `6:2:2`, `7:1.5:1.5`. Scope can be limited to reviewed images, to your own images, to one source group, or widened to include unannotated images for a distribution check.

Existing annotations can be read back in: YOLO txt, Pascal VOC xml, COCO json, LabelMe json, and CSV. Useful for continuing a dataset that started elsewhere.

![Export page](docs/screenshots/07-export.jpg)

## Command line

| Flag | Effect |
|---|---|
| `--port N` | Port, default 8765 |
| `--host A` | Bind address, default 0.0.0.0 |
| `--no-browser` | Do not open a browser on start |
| `--reset-admin [password]` | Reset the admin password and exit |
| `--promote USER` | Grant admin to an existing account and exit |
| `--list-users` | Print all accounts and exit |

`AnnoHub.exe --reset-admin` is the recovery path when the only admin password is lost. The password returns to `admin123`.

## Stack

| Layer | Choice |
|---|---|
| Server | FastAPI + uvicorn, SQLite in WAL mode |
| Frontend | Plain JavaScript ES modules, no build step |
| Imaging | Pillow |
| Inference | onnxruntime, CPU by default, GPU build works |
| Packaging | PyInstaller, one file |

```
annohub/
├─ annohub/          server: routers, database, crop, import, export, inference
├─ web/              frontend: views, styles, assets
├─ tools/            helper scripts (ONNX export, smoke test, screenshots)
├─ docs/             manual and screenshots
├─ run.py            launcher
├─ build.spec        PyInstaller configuration
└─ requirements.txt
```

## Limits

These are real, and worth reading before you commit a dataset to it.

- Interface and manual are Chinese only. There is no i18n layer yet; the API and code comments are English, but labels and error messages are Chinese.
- ONNX only. A `.pt` file has to be exported first with `tools/export_onnx.py`.
- Images, not video. No frame extraction, no DICOM series.
- Built for a LAN. No TLS, no hardening against the public internet. Do not port-forward it.
- Comfortable up to roughly 20,000 images per project and 8 concurrent annotators. Beyond that SQLite and a single uvicorn process will start to show.
- Splits are random at image level, not stratified. With severe class imbalance, rebalance afterwards.
- Windows only for the packaged binary. The source runs on Linux and macOS but is untested there.

## Contributing

AnnoHub was written to solve one lab's problem, and released because the problem is common. It is a working tool rather than a finished product, and the areas that need help most are exactly the ones one person cannot test: other GPUs, other label conventions, other teams' habits.

Bug reports are as valuable as code. If something breaks, please include the version from the startup banner, your Windows version, and the steps that trigger it — a screenshot of the console window helps more than a description. If a format you need is missing, open an issue with a small sample file and the directory layout you expect; format support is usually a contained change.

Translations, corrections to the manual, and notes on how your group actually uses the tool are welcome too. For larger changes — a new storage backend, a different locking model, a rewritten frontend — open an issue first so we can agree on the shape before you spend a weekend on it.

There is no CLA and no fixed roadmap. Pull requests go to `main`; keep the diff focused, and describe what you tested.

## License

[MIT](LICENSE). Commercial use, modification, and redistribution are permitted.
