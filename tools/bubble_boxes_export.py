#!/usr/bin/env python3
"""bubble_boxes_export.py - text-block boxes over PanelCleaner's ComicTextDetector.

Runs ONLY the CTD block detector (no mask refinement, no OCR, no inpainting) so
framing can keep speech bubbles out of the shot window. Tall webtoon strips are
cut into overlapping tiles first: the detector letterboxes to a square, and a
900x3000 strip would otherwise shrink lettering below its receptive field.

Output JSON (single object)::

    {"tool": "pcleaner-ctd", "schema": "bubble-boxes-2",
     "images": {"<input path>": {"w": int, "h": int,
                                 "boxes": [[x0, y0, x1, y1, conf], ...]}}}

Coordinates are input-image pixels. An unreadable image maps to null.

Run with the PanelCleaner venv::

    /opt/panelcleaner/venv/bin/python tools/bubble_boxes_export.py \
        --model <comictextdetector.pt.onnx> --output <out.json> <img1> [img2 ...]
"""
import argparse
import json
import os
import sys

TILE_ASPECT = 1.6
TILE_OVERLAP = 0.15


def _tiles(h, w):
    """Vertical [y0, y1) tiles of at most TILE_ASPECT * w rows, overlapping."""
    th = int(w * TILE_ASPECT)
    if th <= 0 or h <= th * 1.35:
        return [(0, h)]
    step = max(1, int(th * (1 - TILE_OVERLAP)))
    out = []
    y = 0
    while True:
        y1 = min(h, y + th)
        out.append((y, y1))
        if y1 >= h:
            break
        y += step
    return out


def _merge(boxes):
    """Union boxes that overlap (tile seams split one bubble into two hits)."""
    boxes = sorted(boxes, key=lambda b: (b[1], b[0]))
    changed = True
    while changed:
        changed = False
        out = []
        for b in boxes:
            for i, o in enumerate(out):
                if b[0] < o[2] and o[0] < b[2] and b[1] < o[3] and o[1] < b[3]:
                    out[i] = [min(b[0], o[0]), min(b[1], o[1]), max(b[2], o[2]),
                              max(b[3], o[3]), max(b[4], o[4])]
                    changed = True
                    break
            else:
                out.append(list(b))
        boxes = out
    return boxes


def export(model_path, images, out_path):
    import cv2
    import numpy as np
    from pcleaner.comic_text_detector.inference import (
        TextDetector,
        postprocess_yolo,
        preprocess_img,
    )

    cv2.setNumThreads(int(os.environ.get("OMP_NUM_THREADS", str(os.cpu_count() or 4))))
    det = TextDetector(model_path=str(model_path), input_size=1024, device="cpu")
    size = det.input_size
    result = {}
    for img_path in images:
        try:
            arr = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
            if arr is None:
                raise ValueError("unreadable image")
            h, w = arr.shape[:2]
            found = []
            for y0, y1 in _tiles(h, w):
                tile = np.ascontiguousarray(arr[y0:y1])
                th, tw = tile.shape[:2]
                img_in, _ratio, dw, dh = preprocess_img(
                    tile, input_size=size, device="cpu", half=False, to_tensor=False
                )
                blks, _mask, _lines = det.net(img_in)
                aw, ah = size[0] - dw, size[1] - dh
                if aw <= 0 or ah <= 0:
                    continue
                rr = (tw / aw, th / ah)
                xyxy, _cls, conf = postprocess_yolo(blks, det.conf_thresh, det.nms_thresh, rr)
                for b, c in zip(xyxy, conf):
                    bx0, by0, bx1, by1 = (float(v) for v in b[:4])
                    found.append([
                        max(0.0, bx0), max(0.0, by0 + y0),
                        min(float(w), bx1), min(float(h), by1 + y0), float(c),
                    ])
            result[img_path] = {"w": w, "h": h, "boxes": _merge(found)}
        except Exception as e:
            print(f"[bubble_boxes_export] {img_path}: {type(e).__name__}: {e}", file=sys.stderr)
            result[img_path] = None
    payload = {"tool": "pcleaner-ctd", "schema": "bubble-boxes-2", "images": result}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return payload


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True, help="comictextdetector.pt.onnx path")
    ap.add_argument("--output", required=True, help="destination JSON")
    ap.add_argument("images", nargs="+", help="input image(s)")
    args = ap.parse_args(argv)
    payload = export(args.model, args.images, args.output)
    n = sum(len(v["boxes"]) for v in payload["images"].values() if v)
    print(f"[bubble_boxes_export] wrote {args.output}: {n} boxes across "
          f"{len(payload['images'])} image(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
