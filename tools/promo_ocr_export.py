#!/usr/bin/env python3
"""promo_ocr_export.py - promo OCR export over PanelCleaner's text detector.

Finds text regions with PanelCleaner's ComicTextDetector (CPU: OpenCV DNN +
ONNX) and reads each region with Tesseract. Only polygons and text are
exported; the caller blurs matched promo regions itself (promoMask.ts), so no
inpainting or image output happens here.

Output JSON (single object)::

    {"tool": "pcleaner-ctd", "schema": "promo-ocr-1",
     "panels": {"<panel_id>": [ {"text": str, "lines": [[8 numbers], ...]} ]}}

Coordinates are in the INPUT image's pixel space; the caller handles any crop
offset / scale applied before handing images in.

Run with the PanelCleaner venv::

    /opt/panelcleaner/venv/bin/python tools/promo_ocr_export.py \
        --model <comictextdetector.pt.onnx> --output <out.json> <img1> [img2 ...]
"""
import argparse
import json
import os
import sys


def _block_lines(blk):
    """8-number polygons for a TextBlock's ``.lines``."""
    out = []
    for line in getattr(blk, "lines", None) or []:
        try:
            flat = [float(v) for pt in line for v in pt]
        except TypeError:
            flat = [float(v) for v in line]
        if len(flat) == 8:
            out.append(flat)
    return out


def _ocr(img, xyxy, lang):
    import pytesseract

    w, h = img.size
    x0, y0, x1, y1 = (int(v) for v in xyxy)
    pad = 4
    box = (max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad))
    if box[2] <= box[0] or box[3] <= box[1]:
        return ""
    crop = img.crop(box)
    text = ""
    try:
        text = pytesseract.image_to_string(crop, lang=lang)
    except Exception:
        text = ""
    if not text.strip():
        try:
            d = pytesseract.image_to_data(
                crop, lang=lang, config="--psm 11", output_type=pytesseract.Output.DICT
            )
            text = " ".join(t for t in d.get("text", ()) if t)
        except Exception:
            text = ""
    return " ".join(text.split())


def export(model_path, images, out_path, lang="eng"):
    import cv2
    import numpy as np
    from PIL import Image
    from pcleaner.comic_text_detector.inference import TextDetector
    from pcleaner.comic_text_detector.utils.textmask import REFINEMASK_ANNOTATION

    cv2.setNumThreads(int(os.environ.get("OMP_NUM_THREADS", "4")))
    model = TextDetector(model_path=str(model_path), input_size=1024, device="cpu")
    panels = {}
    for img_path in images:
        pid = os.path.splitext(os.path.basename(img_path))[0]
        try:
            arr = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
            if arr is None:
                raise ValueError("unreadable image")
            _mask, _refined, blk_list = model(
                arr, refine_mode=REFINEMASK_ANNOTATION, keep_undetected_mask=False
            )
            pil = Image.open(img_path).convert("RGB")
            regs = []
            for blk in blk_list:
                lines = _block_lines(blk)
                text = _ocr(pil, blk.xyxy, lang)
                if text or lines:
                    regs.append({"text": text, "lines": lines})
            panels[pid] = regs
        except Exception as e:
            print(f"[promo_ocr_export] {pid}: {type(e).__name__}: {e}", file=sys.stderr)
            panels[pid] = []
    payload = {"tool": "pcleaner-ctd", "schema": "promo-ocr-1", "panels": panels}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    return payload


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True, help="comictextdetector.pt.onnx path")
    ap.add_argument("--output", required=True, help="destination JSON")
    ap.add_argument("--lang", default="eng", help="Tesseract language")
    ap.add_argument("images", nargs="+", help="input image(s)")
    args = ap.parse_args(argv)
    payload = export(args.model, args.images, args.output, args.lang)
    n = sum(len(v) for v in payload["panels"].values())
    print(f"[promo_ocr_export] wrote {args.output}: {n} regions across "
          f"{len(payload['panels'])} panel(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
