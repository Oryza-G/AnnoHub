# Contributing to AnnoHub

Thanks for looking. This document covers how to report a problem, how to run the project locally, and what a useful pull request looks like.

## Reporting a problem

Open an issue with the **Bug report** template. The three things that make a report actionable:

1. The version string from the startup banner.
2. Your Windows version, and whether you run the packaged `.exe` or the source.
3. What you did, what happened, and what you expected. If the browser console or the server console shows an error, paste it.

A screenshot of the console window is often worth more than a paragraph of description.

## Asking for a format

If an import or export format you need is missing, open an issue with a **small sample** — a handful of files plus the directory layout you expect. Format work is usually a contained change and goes much faster with a real sample than with a specification.

## Running locally

```bash
git clone https://github.com/Oryza-G/AnnoHub.git
cd AnnoHub
pip install -r requirements.txt
python run.py
```

The server writes to `./data` by default. Point `ANNOTOHUB_DATA` at a scratch directory when testing, so you do not mix test rows into a real database:

```bash
ANNOTOHUB_DATA=/tmp/annohub-test python run.py --port 8899
```

Frontend files under `web/` are served directly. Reload the browser after editing; there is no build step and no bundler.

## Code layout

| Path | Contents |
|---|---|
| `annohub/routers/` | HTTP endpoints, one module per area |
| `annohub/db.py` | Schema and connection handling |
| `annohub/crop.py` | Tile cropping |
| `annohub/importer.py` | Image and annotation import |
| `annohub/exporters.py` | Dataset packaging |
| `annohub/infer.py` | ONNX inference |
| `annohub/geometry.py` | Geometry types and project types |
| `web/js/view_*.js` | One module per screen |

## Pull requests

- Target `main`.
- Keep the diff focused on one thing. A bug fix that also reformats three files is hard to review.
- Describe what you tested, including the OS and whether you ran from source or the packaged binary.
- If the change touches the database schema, mention how existing `data` directories migrate.

For larger changes — a different storage backend, a revised locking model, a frontend rewrite — open an issue first. It is cheaper to agree on the shape before the code exists.

There is no CLA and no fixed roadmap.

## What is most useful right now

- Testing on GPUs and onnxruntime builds other than the default CPU one.
- Label conventions from domains other than remote sensing: medical, industrial inspection, document layout.
- Corrections to [docs/manual.md](docs/manual.md) (currently Chinese only).
- Reports of what breaks past the stated limits — 20,000 images, 8 concurrent annotators.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
