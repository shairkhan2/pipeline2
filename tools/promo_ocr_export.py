#!/usr/bin/env python3
"""promo_ocr_export.py - OCR-export adapter over the installed manga-image-
translator Python API (no vendor edits).

Why this exists (B2a live finding, 2026-10-10): the installed MIT CLI's
``--save-text-file`` / ``--save-text`` flags do NOT produce a usable region
export for our config:

  * ``mode/local.py:286-293`` gates ``_save_text_to_file`` on ``self.text_regions``,
    a param the CLI never sets (no ``--text-regions`` arg) -> the batch export
    branch never fires.
  * ``manga_translator.py:1104-1110`` dumps only the *translated strings* (not
    the region polygons) to ``<stem>_translations.txt`` and then ``exit(-1)``
    (observed exit 255, "Don't continue if --save-text is used").

So instead of mutating the vendor or globbing its shared ``result/`` output, we
drive the same installed Python API directly with the SAME config
(ComicTextDetector + Model48pxOCR + translator=none) and serialize the returned
``ctx.text_regions`` to a controlled JSON. The tool's inpainted/rendered image
is discarded by the caller; only OCR polygons are used.

Output JSON (single object)::

    {"tool": "mit-api", "schema": "promo-ocr-1",
     "panels": {"<panel_id>": [ {"text": str, "lines": [[8 numbers], ...]} ]}}

Coordinates are in the INPUT image's pixel space; the caller handles any crop
offset / scale applied before handing images in.

Run with the MIT venv, cwd = MIT_DIR::

    /opt/mit-venv312/bin/python pipeline/tools/promo_ocr_export.py \
        --config <cfg.json> --output <out.json> <img1> [img2 ...]
"""
import argparse
import asyncio
import json
import os
import sys


def _load_mit():
    mit_dir = os.environ.get("MANHWA_MIT_DIR", "/opt/manga-image-translator")
    if mit_dir not in sys.path:
        sys.path.insert(0, mit_dir)
    from manga_translator import Config                      # noqa: E402
    from manga_translator.mode.local import MangaTranslatorLocal  # noqa: E402
    return Config, MangaTranslatorLocal


def _region_lines(region):
    """8-number polygons for a TextBlock's ``.lines`` (numpy or nested lists)."""
    out = []
    raw = getattr(region, "lines", None)
    if raw is None:
        return out
    try:
        import numpy as np
        arr = np.asarray(raw)
    except Exception:
        arr = raw
    try:
        for line in arr:
            flat = list(line.ravel()) if hasattr(line, "ravel") else list(line)
            flat = [float(v) for v in flat]
            if len(flat) == 8:
                out.append(flat)
    except Exception:
        pass
    return out


async def _export(cfg_path, images, out_path):
    from PIL import Image
    Config, MangaTranslatorLocal = _load_mit()
    with open(cfg_path, encoding="utf-8") as fh:
        cfg = Config(**json.load(fh))
    params = {
        "kernel_size": 3,
        "use_gpu": False,
        "input": list(images),
        "ignore_errors": True,
        "batch_size": 1,
    }
    tr = MangaTranslatorLocal(params)
    panels = {}
    for img_path in images:
        pid = os.path.splitext(os.path.basename(img_path))[0]
        try:
            img = Image.open(img_path).convert("RGB")
            ctx = await tr.translate(img, cfg)
        except Exception as e:
            print(f"[promo_ocr_export] {pid}: {type(e).__name__}: {e}",
                  file=sys.stderr)
            panels[pid] = []
            continue
        regs = []
        for region in (getattr(ctx, "text_regions", None) or []):
            text = getattr(region, "text", "") or ""
            lines = _region_lines(region)
            if text or lines:
                regs.append({"text": text, "lines": lines})
        panels[pid] = regs
    payload = {"tool": "mit-api", "schema": "promo-ocr-1", "panels": panels}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    return payload


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=True, help="MIT Config JSON")
    ap.add_argument("--output", required=True, help="destination JSON")
    ap.add_argument("images", nargs="+", help="input image(s)")
    args = ap.parse_args(argv)
    payload = asyncio.run(_export(args.config, args.images, args.output))
    n = sum(len(v) for v in payload["panels"].values())
    print(f"[promo_ocr_export] wrote {args.output}: {n} regions across "
          f"{len(payload['panels'])} panel(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
