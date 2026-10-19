/**
 * T4.4 Phase 4 tests.
 *
 * Ports the offline regressions from:
 *   pipeline/tools/test_promo_mask.py
 *   pipeline/tools/test_promo_cleaner.py
 *   pipeline/tools/test_render_framing.py
 *   pipeline/tests/test_external_tts.py
 *
 * Golden buildShots parity calls the v1 Python oracle read-only
 * (promo_block.load + timeline.build_shots) on reality-quest ch1-ch20.
 * Every write stays under /tmp/opencode. Nothing under
 * /home/shair/manhwa-pipeline is created, edited, or deleted.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  PromoMaskError,
  blurPromoRegions,
  parseTextExport,
  type Box,
  type RgbImage,
} from "../src/stages/promoMask.js";
import {
  PROMO_ALGO_VERSION,
  PROMO_BOXES_SUFFIX,
  _hooks,
  cleanPromoMask,
  hasWorldText,
  promoPageBoundary,
  shouldClean,
  validatePromoSidecar,
  writePromoSidecar,
  type CleanItem,
} from "../src/stages/cleaner.js";
import {
  _continuation,
  _speechEdges,
  _trimBlankPadding,
  cropWindow,
  frameShots,
  type Rgb,
} from "../src/stages/framing.js";
import { Block } from "../src/intake/promoBlock.js";
import { load as loadPromoBlock } from "../src/intake/promoBlock.js";
import {
  RuntimeError,
  ValueError,
  _lineFile,
  _lineProofToken,
  _narrationCacheKey,
  _parseExternalCommand,
  _resolveExternalTtsConfig,
  shlexSplit,
  ttsLinesExternal,
} from "../src/stages/audio.js";
import {
  _borrowRun,
  buildShots,
  parseScript,
  pickPanels,
  type TimelineShot,
} from "../src/stages/timeline.js";

const V1_SERIES = "/home/shair/manhwa-pipeline/series";
const VENV_PY = "/home/shair/manhwa-pipeline/.venv/bin/python";
const PROMO_TEXT = "READ OUR NEW CHAPTER";
const PROT_TEXT = "CHAPTER 1";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  const dir = fs.mkdtempSync(path.join("/tmp/opencode", `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}

const realHooks = { ..._hooks };
afterEach(() => {
  Object.assign(_hooks, realHooks);
});

function rgb(w: number, h: number, fill = 30): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < data.length; i++) data[i] = (fill + (i * 17)) % 60;
  return { data, width: w, height: h };
}

function paint(
  im: RgbImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: [number, number, number],
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * im.width + x) * 3;
      im.data[i] = color[0];
      im.data[i + 1] = color[1];
      im.data[i + 2] = color[2];
    }
  }
}

function outsideIdentical(src: Uint8Array, dst: Uint8Array, w: number, h: number, boxes: Box[]): boolean {
  const covered = new Uint8Array(w * h);
  for (const [x1, y1, x2, y2] of boxes) {
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) covered[y * w + x] = 1;
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (covered[i]) continue;
    const o = i * 3;
    if (src[o] !== dst[o] || src[o + 1] !== dst[o + 1] || src[o + 2] !== dst[o + 2]) return false;
  }
  return true;
}

function regionChanged(src: Uint8Array, dst: Uint8Array, w: number, box: Box): boolean {
  const [x1, y1, x2, y2] = box;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const o = (y * w + x) * 3;
      if (src[o] !== dst[o] || src[o + 1] !== dst[o + 1] || src[o + 2] !== dst[o + 2]) return true;
    }
  }
  return false;
}

const matchesReadOur = (s: string) => s.toLowerCase().includes("read our");

function poly(x1: number, y1: number, x2: number, y2: number): number[] {
  return [x1, y1, x2, y1, x2, y2, x1, y2];
}

async function writeRawJpeg(file: string, w: number, h: number, data: Uint8Array, quality = 95): Promise<void> {
  await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality })
    .toFile(file);
}

function fillRgb(w: number, h: number, color: [number, number, number]): Rgb {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = color[0];
    data[i * 3 + 1] = color[1];
    data[i * 3 + 2] = color[2];
  }
  return { w, h, data };
}

function pasteRgb(img: Rgb, color: [number, number, number], x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 3;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
    }
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function obsPanel(page: number, idx: number, art: number, extra: Record<string, unknown> = {}) {
  const id = `p${String(page).padStart(4, "0")}_${idx}`;
  return {
    id,
    page,
    idx,
    art,
    overlay: [] as string[],
    world: [] as string[],
    bubble_at: "none",
    weight: 2,
    ...extra,
  };
}

function byId(list: ReturnType<typeof obsPanel>[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const p of list) out[p.id] = p;
  return out;
}

// ---------------------------------------------------------------------------
// promoMask.parseTextExport
// ---------------------------------------------------------------------------

describe("promoMask.parseTextExport", () => {
  it("parses bare coords, np.int32 wrappers, and multiline text", () => {
    const txt =
      "[/x/panel_0001.jpg]\n\n-- 1 --\n" +
      "color: #1: white (fg, bg: #ffffff #000000)\n" +
      "text:  READ OUR\nNEW CHAPTER\n" +
      "trans: LEER\n" +
      "coords: [10, 20, 90, 20, 90, 60, 10, 60]\n" +
      "coords: [np.int32(12), np.int32(70), np.int32(88), np.int32(70), " +
      "np.int32(88), np.int32(100), np.int32(12), np.int32(100)]\n" +
      "coords: [np.float32(12.5), np.float32(70.0), np.float32(88.0), " +
      "np.float32(70.0), np.float32(88.0), np.float32(110.0), " +
      "np.float32(12.5), np.float32(110.0)]\n";
    const out = parseTextExport(txt);
    expect(Object.keys(out)).toEqual(["panel_0001"]);
    const rec = out.panel_0001![0]!;
    expect(rec.text).toBe("READ OUR\nNEW CHAPTER");
    expect(rec.lines).toHaveLength(3);
    expect(rec.lines[0]).toEqual([10, 20, 90, 20, 90, 60, 10, 60]);
    expect(rec.lines[1]![0]).toBe(12);
    expect(rec.lines[2]![0]).toBe(12.5);
  });

  it("keeps the newest section when a panel id repeats", () => {
    const one = (text: string, coords: string) =>
      `[/a/p0001.jpg]\n\n-- 1 --\ncolor: #1: white\ntext:  ${text}\ntrans: TRANS\ncoords: ${coords}\n`;
    const txt = one("OLD TEXT", "[1,1,2,1,2,2,1,2]") + one("NEW TEXT", "[3,3,9,3,9,9,3,9]");
    const out = parseTextExport(txt);
    expect(out.p0001).toHaveLength(1);
    expect(out.p0001![0]!.text).toBe("NEW TEXT");
    expect(out.p0001![0]!.lines[0]![0]).toBe(3);
  });

  it("uses the basename stem and ignores unknown headers", () => {
    const txt =
      "[/deep/dir/Page_7.PNG]\n-- 1 --\ntext:  HELLO\n" +
      "coords: [0,0,10,0,10,10,0,10]\n" +
      "note: something\nrandom garbage\ntrans: IGNORED\n";
    const out = parseTextExport(txt);
    expect(Object.keys(out)).toEqual(["Page_7"]);
    expect(out.Page_7![0]!.text).toBe("HELLO");
  });

  it("skips malformed, short, and non-finite coord lines", () => {
    const txt =
      "[p.jpg]\n-- 1 --\ntext:  X\n" +
      "coords: [1,2,3,4,5,6]\n" +
      "coords: [a,b,c,d,e,f,g,h]\n" +
      "coords: [0,0,nan,0,10,10,0,10]\n" +
      "coords: [0,0,10,0,10,10,0,10]\n";
    const rec = parseTextExport(txt).p![0]!;
    expect(rec.lines).toHaveLength(1);
    expect(rec.lines[0]![0]).toBe(0);
  });

  it("drops a region that appears before any panel header", () => {
    const txt = "-- 1 --\ntext:  ORPHAN\ncoords: [0,0,1,0,1,1,0,1]\n";
    expect(parseTextExport(txt)).toEqual({});
    expect(parseTextExport("")).toEqual({});
  });

  it("rejects a non-string export", () => {
    expect(() => parseTextExport(null as unknown as string)).toThrow(PromoMaskError);
  });
});

// ---------------------------------------------------------------------------
// promoMask.blurPromoRegions
// ---------------------------------------------------------------------------

describe("promoMask.blurPromoRegions", () => {
  const W = 240;
  const H = 180;

  function glyphImage(): RgbImage {
    const im = rgb(W, H, 20);
    paint(im, 6, 6, 80, 56, [245, 20, 20]);
    paint(im, 190, 140, 230, 170, [200, 200, 200]);
    return im;
  }

  it("changes glyphs inside the returned boxes and leaves every other pixel identical", async () => {
    const im = glyphImage();
    const before = im.data.slice();
    const region = { text: "READ OUR NEW CHAPTER", lines: [poly(6, 6, 84, 56)] };
    const { image, boxes } = await blurPromoRegions(im, [region], matchesReadOur, []);
    expect(boxes.length).toBeGreaterThan(0);
    expect(regionChanged(before, image.data, W, boxes[0]!)).toBe(true);
    expect(outsideIdentical(before, image.data, W, H, boxes)).toBe(true);
    expect(Buffer.from(im.data)).toEqual(Buffer.from(before));
  });

  it("masks every corner and the center, and never a non-matching region", async () => {
    // Expansion is font-height scaled, so the canvas must stay well above the
    // 30% union ceiling once five boxes grow.
    const bigW = 800;
    const bigH = 600;
    const coords: Record<string, number[]> = {
      tl: poly(40, 40, 60, 56),
      tr: poly(740, 40, 760, 56),
      bl: poly(40, 540, 60, 556),
      br: poly(740, 540, 760, 556),
      ct: poly(390, 290, 410, 306),
    };
    const im = rgb(bigW, bigH, 30);
    for (const c of Object.values(coords)) paint(im, c[0]! + 2, c[1]! + 2, c[4]! - 2, c[5]! - 2, [250, 10, 10]);
    const regions = Object.entries(coords).map(([k, lines]) => ({
      text: `READ OUR ${k}`,
      lines: [lines],
    }));
    const safe = poly(200, 200, 280, 240);
    regions.push({ text: "I WILL PROTECT YOU", lines: [safe] });
    const before = im.data.slice();
    const { image, boxes } = await blurPromoRegions(im, regions, matchesReadOur, []);
    expect(boxes).toHaveLength(5);
    for (const box of boxes) expect(regionChanged(before, image.data, bigW, box)).toBe(true);
    expect(outsideIdentical(before, image.data, bigW, bigH, boxes)).toBe(true);
    expect(regionChanged(before, image.data, bigW, [200, 200, 280, 240])).toBe(false);
  });

  it("accepts a one-panel map and a parse-then-mask export", async () => {
    const im = glyphImage();
    const mapped = await blurPromoRegions(
      im,
      { panel_1: [{ text: "READ OUR", lines: [poly(6, 6, 84, 56)] }] },
      matchesReadOur,
      [],
    );
    expect(mapped.boxes).toHaveLength(1);
    const txt =
      "[/in/p0001.jpg]\n-- 1 --\ntext:  READ OUR DISCORD\n" +
      "coords: [np.int32(6), np.int32(6), np.int32(84), np.int32(6), " +
      "np.int32(84), np.int32(56), np.int32(6), np.int32(56)]\n";
    const panels = parseTextExport(txt);
    const e2e = await blurPromoRegions(im, panels.p0001, matchesReadOur, []);
    expect(e2e.boxes).toHaveLength(1);
  });

  it("fail-closes on no match, missing coords, zero-area, oob, malformed, and a bad caller", async () => {
    const im = glyphImage();
    await expect(
      blurPromoRegions(im, [{ text: "I WILL PROTECT YOU", lines: [poly(100, 100, 180, 140)] }], matchesReadOur, []),
    ).rejects.toThrow(/no matching promo region/);
    await expect(
      blurPromoRegions(im, [{ text: "READ OUR", lines: [] }], matchesReadOur, []),
    ).rejects.toThrow(/no localized coordinates/);
    for (const line of [[10, 10, 10, 10, 10, 10, 10, 10], [500, 500, 600, 500, 600, 600, 500, 600]]) {
      await expect(
        blurPromoRegions(im, [{ text: "READ OUR", lines: [line] }], matchesReadOur, []),
      ).rejects.toThrow(/zero-area/);
    }
    for (const line of [
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [1, 2, 3, 4, 5, 6, Number.NaN, 8],
      [1, 2, 3, 4, 5, 6, Number.POSITIVE_INFINITY, 8],
      [1, 2, 3, 4, 5, 6, "x", 8],
    ]) {
      await expect(
        blurPromoRegions(im, [{ text: "READ OUR", lines: [line] }], matchesReadOur, []),
      ).rejects.toThrow(/malformed coordinates/);
    }
    await expect(blurPromoRegions(im, [], null as unknown as (s: string) => boolean, [])).rejects.toThrow(
      /matches must be callable/,
    );
    await expect(
      blurPromoRegions({ data: new Uint8Array(0), width: 0, height: 10 }, [], matchesReadOur, []),
    ).rejects.toThrow(/zero area/);
    await expect(
      blurPromoRegions({ data: new Uint8Array(3), width: 2, height: 2 }, [], matchesReadOur, []),
    ).rejects.toThrow(/3 bytes per pixel/);
    await expect(blurPromoRegions({} as RgbImage, [], matchesReadOur, [])).rejects.toThrow(/RGB/);
    await expect(blurPromoRegions(im, { a: [], b: [] }, matchesReadOur, [])).rejects.toThrow(/exactly one panel/);
  });

  it("rejects a union above 30% of the image", async () => {
    const im = glyphImage();
    const lines = [poly(0, 0, W, 80), poly(0, 80, W, 160), poly(0, 40, W, 120)];
    const regions = lines.map((ln, i) => ({ text: `READ OUR ${i}`, lines: [ln] }));
    await expect(blurPromoRegions(im, regions, matchesReadOur, [])).rejects.toThrow(/30%/);
  });

  it("shrinks an expanded box back off a protected string, and rejects a padded overlap", async () => {
    const im = glyphImage();
    paint(im, 12, 12, 48, 28, [250, 10, 10]);
    const before = im.data.slice();
    const promo = { text: "READ OUR", lines: [poly(10, 10, 50, 30)] };
    const beside = { text: "Chapter 12", lines: [poly(60, 12, 78, 28)] };
    const shrunk = await blurPromoRegions(im, [promo, beside], matchesReadOur, ["Chapter 12"]);
    expect(shrunk.boxes).toEqual([[9, 9, 51, 31]]);
    expect(regionChanged(before, shrunk.image.data, W, shrunk.boxes[0]!)).toBe(true);
    expect(outsideIdentical(before, shrunk.image.data, W, H, shrunk.boxes)).toBe(true);
    // A pixel the expansion would have covered, and the shrink-back must not.
    expect(shrunk.image.data[(2 * W + 2) * 3]).toBe(before[(2 * W + 2) * 3]);

    const overlapping = { text: "Chapter 12", lines: [poly(40, 12, 70, 28)] };
    await expect(
      blurPromoRegions(glyphImage(), [promo, overlapping], matchesReadOur, ["Chapter 12"]),
    ).rejects.toThrow(/overlaps protected/);
  });

  it("rejects a mixed region whose own text contains a protected string", async () => {
    const im = glyphImage();
    const mixed = { text: "READ OUR Chapter 12 UPDATE", lines: [poly(6, 6, 84, 56)] };
    await expect(blurPromoRegions(im, [mixed], matchesReadOur, ["Chapter 12"])).rejects.toThrow(/mixed region/);
  });
});

// ---------------------------------------------------------------------------
// cleaner gates, sidecar, cleanPromoMask
// ---------------------------------------------------------------------------

describe("cleaner gates", () => {
  const block = new Block({ blocked: [{ string: PROMO_TEXT }] });

  it("hasWorldText ignores blanks, non-strings, and promo-blocked strings", () => {
    expect(hasWorldText(null)).toBe(false);
    expect(hasWorldText(["", "   ", 3 as unknown as string])).toBe(false);
    expect(hasWorldText([PROT_TEXT])).toBe(true);
    expect(hasWorldText([PROMO_TEXT], block)).toBe(false);
    expect(hasWorldText([PROMO_TEXT, PROT_TEXT], block)).toBe(true);
  });

  it("shouldClean lets a promo string bypass the I-55 world-text veto and both floors", () => {
    expect(shouldClean({ overlay: [PROMO_TEXT], world: [PROT_TEXT], art: 0.9 }, block)).toBe(true);
    expect(shouldClean({ overlay: [], world: [PROMO_TEXT], art: 0 }, block)).toBe(true);
    expect(shouldClean({ overlay: ["x".repeat(60)], world: [PROT_TEXT], art: 0.9 }, block)).toBe(false);
    expect(shouldClean({ overlay: ["x".repeat(60)], world: [PROT_TEXT], art: 0.9 }, null)).toBe(false);
    expect(shouldClean({ overlay: ["x".repeat(60)], world: [], art: 0.9 }, null)).toBe(true);
    expect(shouldClean({ overlay: ["x".repeat(39)], world: [], art: 1 }, null)).toBe(false);
    expect(shouldClean({ overlay: ["x".repeat(40)], world: [], art: 0.49 }, null)).toBe(false);
    expect(shouldClean({ overlay: ["x".repeat(40)], world: [] }, null)).toBe(true);
  });

  it("promoPageBoundary rejects true, allows false, and uses the vision gate when unknown", async () => {
    const src = path.join(makeTemp("gate"), "p.jpg");
    await writeRawJpeg(src, 8, 8, new Uint8Array(8 * 8 * 3).fill(40));

    const full = await promoPageBoundary({ promo_page: true }, "/no/such.jpg");
    expect(full[0]).toBe(false);
    expect(full[2]).toBe(false);
    expect(full[1]).toMatch(/FULL promo page/);

    const partial = await promoPageBoundary({ promo_page: false }, "/no/such.jpg");
    expect(partial).toEqual([true, "reader classified partial/corner promo", true]);

    const missing = await promoPageBoundary({}, "/no/such.jpg");
    expect(missing[0]).toBe(false);
    expect(missing[1]).toMatch(/no original/);

    _hooks._visionFullVsStory = async () => true;
    const visionFull = await promoPageBoundary({}, src);
    expect(visionFull[0]).toBe(false);
    expect(visionFull[1]).toMatch(/FULL advert/);

    _hooks._visionFullVsStory = async () => false;
    const visionStory = await promoPageBoundary({ promo_page: undefined }, src);
    expect(visionStory).toEqual([true, "vision gate classified story page w/ corner promo", true]);

    _hooks._visionFullVsStory = async () => null;
    const dead = await promoPageBoundary({}, src);
    expect(dead[0]).toBe(false);
    expect(dead[1]).toMatch(/unavailable/);
  });
});

describe("cleaner promo sidecar", () => {
  it("writePromoSidecar round-trips, and validatePromoSidecar fail-closes", async () => {
    const dir = makeTemp("side");
    const src = path.join(dir, "p0001_1.jpg");
    await writeRawJpeg(src, 40, 20, new Uint8Array(40 * 20 * 3).fill(80));
    const out = path.join(dir, "p0001_1.png");
    fs.writeFileSync(out, "png");
    const boxes: Box[] = [[2, 3, 10, 12]];
    const side = await writePromoSidecar(out, src, "p0001_1", boxes, true, "hash-1");
    expect(side).toBe(out + PROMO_BOXES_SUFFIX);
    expect(validatePromoSidecar(out, src, "hash-1")).toBe(true);
    const data = JSON.parse(fs.readFileSync(side, "utf8")) as {
      version: string;
      partial: boolean;
      boxes_px: number[][];
      width: number;
      height: number;
    };
    expect(data.version).toBe(PROMO_ALGO_VERSION);
    expect(data.partial).toBe(true);
    expect(data.boxes_px).toEqual([[2, 3, 10, 12]]);
    expect(data.width).toBe(40);
    expect(data.height).toBe(20);

    expect(validatePromoSidecar(out, src, "other")).toBe(false);
    data.version = "nope";
    fs.writeFileSync(side, JSON.stringify(data));
    expect(validatePromoSidecar(out, src, "hash-1")).toBe(false);

    await writePromoSidecar(out, src, "p0001_1", boxes, false, "hash-1");
    const flipped = new Uint8Array(40 * 20 * 3).fill(9);
    await writeRawJpeg(src, 40, 20, flipped);
    expect(validatePromoSidecar(out, src, "hash-1")).toBe(false);

    fs.writeFileSync(side, JSON.stringify({ ...data, version: PROMO_ALGO_VERSION, boxes_px: [] }));
    expect(validatePromoSidecar(out, src, "hash-1")).toBe(false);
    expect(validatePromoSidecar(path.join(dir, "missing.png"), src, "hash-1")).toBe(false);
    fs.writeFileSync(out + PROMO_BOXES_SUFFIX, "{");
    expect(validatePromoSidecar(out, src, "hash-1")).toBe(false);
  });
});

describe("cleaner.cleanPromoMask", () => {
  const W = 400;
  const H = 300;

  async function fixture(pid = "p0001_1"): Promise<{ dir: string; panels: string; cleaned: string; item: CleanItem; src: string }> {
    const dir = makeTemp("mask");
    const panels = path.join(dir, "panels");
    const cleaned = path.join(dir, "cleaned");
    fs.mkdirSync(panels);
    fs.mkdirSync(cleaned);
    const src = path.join(panels, `${pid}.jpg`);
    const raw = new Uint8Array(W * H * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 13) % 50;
    for (let y = 8; y < 28; y++) {
      for (let x = 8; x < 40; x++) {
        const o = (y * W + x) * 3;
        raw[o] = 230;
        raw[o + 1] = 20;
        raw[o + 2] = 20;
      }
    }
    await writeRawJpeg(src, W, H, raw);
    const item: CleanItem = {
      id: pid,
      overlay: [PROMO_TEXT],
      world: [PROT_TEXT],
      promo: [PROMO_TEXT],
      promo_page: false,
    };
    return { dir, panels, cleaned, item, src };
  }

  function promoRecs(text: string, box: number[]) {
    return [{ text, lines: [box] }];
  }

  it("cache-hits without calling OCR or the verifier", async () => {
    const { panels, cleaned, item } = await fixture();
    const ocr: number[] = [];
    const verified: number[] = [];
    _hooks._runOcrExport = async (_paths, _work, _it, scale = 1) => {
      ocr.push(scale);
      return { [item.id]: promoRecs(PROMO_TEXT, poly(8, 8, 36, 24)) };
    };
    _hooks._verifyPromoMask = async () => {
      verified.push(1);
      return true;
    };
    const first = await cleanPromoMask(item, panels, cleaned);
    expect(first).toBe(path.join(cleaned, `${item.id}.png`));
    expect(ocr).toEqual([1]);
    // Success path verifies once to decide on 2x, then once more before the stamp.
    expect(verified).toEqual([1, 1]);
    expect(fs.existsSync(`${first}.done`)).toBe(true);
    const stamp = fs.readFileSync(`${first}.done`, "utf8").trim();
    expect(validatePromoSidecar(first!, path.join(panels, `${item.id}.jpg`), stamp)).toBe(true);

    const second = await cleanPromoMask(item, panels, cleaned);
    expect(second).toBe(first);
    expect(ocr).toEqual([1]);
    expect(verified).toEqual([1, 1]);
  });

  it("rescues a missing 1x export with exactly one 2x pass", async () => {
    const { panels, cleaned, item } = await fixture("p0002_1");
    const scales: number[] = [];
    _hooks._runOcrExport = async (_paths, _work, _it, scale = 1) => {
      scales.push(scale);
      if (scale === 1) return null;
      return { [item.id]: promoRecs(PROMO_TEXT, poly(8, 8, 36, 24)) };
    };
    _hooks._verifyPromoMask = async () => true;
    const out = await cleanPromoMask(item, panels, cleaned);
    expect(out).toBe(path.join(cleaned, `${item.id}.png`));
    expect(scales).toEqual([1, 2]);
    expect(fs.existsSync(out + ".rej")).toBe(false);
    expect(fs.existsSync(out + ".done")).toBe(true);
  });

  it("retries at 2x when the 1x verifier rejects, and does not negative-cache a failure", async () => {
    const { panels, cleaned, item } = await fixture("p0003_1");
    const scales: number[] = [];
    let verifies = 0;
    _hooks._runOcrExport = async (_paths, _work, _it, scale = 1) => {
      scales.push(scale);
      return { [item.id]: promoRecs(PROMO_TEXT, poly(8, 8, 36, 24)) };
    };
    _hooks._verifyPromoMask = async () => {
      verifies += 1;
      return verifies >= 2;
    };
    const out = await cleanPromoMask(item, panels, cleaned);
    expect(out).not.toBeNull();
    expect(scales).toEqual([1, 2]);

    const fail = await fixture("p0004_1");
    _hooks._runOcrExport = async () => null;
    _hooks._verifyPromoMask = async () => false;
    expect(await cleanPromoMask(fail.item, fail.panels, fail.cleaned)).toBeNull();
    expect(fs.existsSync(path.join(fail.cleaned, "p0004_1.png.rej"))).toBe(false);
    expect(fs.existsSync(path.join(fail.cleaned, "p0004_1.png"))).toBe(false);
  });

  it("does not call 2x when 1x verifies, and rejects a full promo page before any OCR", async () => {
    const { panels, cleaned, item } = await fixture("p0005_1");
    const scales: number[] = [];
    _hooks._runOcrExport = async (_paths, _work, _it, scale = 1) => {
      scales.push(scale);
      return { [item.id]: promoRecs(PROMO_TEXT, poly(8, 8, 36, 24)) };
    };
    _hooks._verifyPromoMask = async () => true;
    expect(await cleanPromoMask(item, panels, cleaned)).not.toBeNull();
    expect(scales).toEqual([1]);

    const full = await fixture("p0006_1");
    full.item.promo_page = true;
    const stale = path.join(full.cleaned, "p0006_1.png");
    fs.writeFileSync(stale, "stale");
    let called = 0;
    _hooks._runOcrExport = async () => {
      called += 1;
      return null;
    };
    expect(await cleanPromoMask(full.item, full.panels, full.cleaned)).toBeNull();
    expect(called).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

describe("framing", () => {
  it("cropWindow never cuts the interest box, and does not borrow opposite-edge padding", () => {
    for (const box of [
      { x0: 0, y0: 0.7, x1: 1, y1: 1 },
      { x0: 0.8, y0: 0.1, x1: 1, y1: 0.3 },
    ]) {
      const [x0, y0, x1, y1] = cropWindow({ w: 400, h: 800 }, box);
      expect(x0).toBeLessThanOrEqual(box.x0 * 400);
      expect(y0).toBeLessThanOrEqual(box.y0 * 800);
      expect(x1).toBeGreaterThanOrEqual(box.x1 * 400);
      expect(y1).toBeGreaterThanOrEqual(box.y1 * 800);
    }
    const [, top, , bottom] = cropWindow({ w: 900, h: 4000 }, { x0: 0, y0: 0.6, x1: 1, y1: 1 });
    expect(top).toBeGreaterThanOrEqual(2400 - 54);
    expect(bottom).toBe(4000);
  });

  it("trims only blank padding outside the reader's main visual", () => {
    const img = fillRgb(20, 30, [40, 80, 120]);
    for (let y = 0; y < 5; y++) pasteRgb(img, [250, 250, 250], 0, y, 20, y + 1);
    for (let y = 25; y < 30; y++) pasteRgb(img, [0, 0, 0], 0, y, 20, y + 1);
    const box = { x0: 0, y0: 0.4, x1: 1, y1: 0.7 };
    expect(_trimBlankPadding(img, [0, 0, 20, 30], box)).toEqual([0, 5, 20, 25]);

    const white = fillRgb(10, 20, [255, 255, 255]);
    const kept = _trimBlankPadding(white, [0, 0, 10, 20], { x0: 0, y0: 0.25, x1: 1, y1: 0.75 });
    expect(kept[1]).toBe(Math.floor(0.25 * 20));
    expect(kept[3]).toBe(Math.ceil(0.75 * 20));
  });

  it("drops an edge speech bubble and refuses to treat a white field as one", () => {
    const img = fillRgb(400, 800, [50, 100, 170]);
    pasteRgb(img, [240, 240, 240], 25, 0, 300, 180);
    pasteRgb(img, [15, 15, 15], 55, 40, 270, 65);
    pasteRgb(img, [240, 210, 200], 100, 350, 300, 390);
    const [top, bot] = _speechEdges(img, "top");
    expect(top).toBeGreaterThanOrEqual(180);
    expect(top).toBeLessThan(350);
    expect(bot).toBe(800);
    expect(_speechEdges(fillRgb(400, 800, [255, 255, 255]), "top")).toEqual([0, 800]);
    expect(_speechEdges(img, "center")).toEqual([0, 800]);
    expect(_speechEdges(img, null)).toEqual([0, 800]);

    const bottom = fillRgb(400, 800, [50, 100, 170]);
    pasteRgb(bottom, [240, 240, 240], 25, 620, 300, 800);
    pasteRgb(bottom, [15, 15, 15], 55, 700, 270, 740);
    const [b0, b1] = _speechEdges(bottom, "bottom");
    expect(b0).toBe(0);
    expect(b1).toBeLessThan(800);
    expect(b1).toBeGreaterThan(400);
  });

  async function continuationFixture() {
    const dir = makeTemp("frame");
    const panels = path.join(dir, "panels");
    const crops = path.join(dir, "crops");
    fs.mkdirSync(panels);
    const W = 400;
    const H = 800;
    const data = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        data[i] = Math.floor(50 + (100 * x) / (W - 1));
        data[i + 1] = 45;
        data[i + 2] = 70;
      }
    }
    await writeRawJpeg(path.join(panels, "p0001_1.jpg"), W, H, data);
    await writeRawJpeg(path.join(panels, "p0003_1.jpg"), W, 200, data.subarray(0, 200 * W * 3));
    const manifest = [
      { panel: "ch1/p0001_1.jpg", page: 1, page_span: [1, 2], idx: 1 },
      { panel: "ch1/p0003_1.jpg", page: 3, idx: 1 },
    ];
    fs.writeFileSync(path.join(panels, "manifest.json"), JSON.stringify(manifest));
    const pg = {
      id: "p0001_1",
      art: 0.8,
      overlay: ["dialogue"],
      world: [],
      box: { x0: 0.1, y0: 0.7, x1: 0.9, y1: 1 },
    };
    const next = {
      id: "p0003_1",
      art: 1,
      overlay: [] as string[],
      world: [] as string[],
      promo_page: false as boolean | undefined,
      promo_regions: undefined as unknown,
      box: { x0: 0, y0: 0, x1: 1, y1: 1 },
    };
    const shot: Record<string, any> = {
      panel: "p0001_1.jpg",
      start_s: 1.2,
      end_s: 4.9,
      line_id: 7,
      weight: 2,
      focus_y: 0.85,
      focus_x: 0.5,
      pw: 400,
      ph: 800,
      box: { ...pg.box },
    };
    return { panels, crops, pg, next, shot, manifest };
  }

  it("refuses a promo, unknown, or region-bearing donor before borrowing", async () => {
    const fx = await continuationFixture();
    const records = new Map<string, [Record<string, unknown>, Record<string, unknown> | null]>([
      ["p0001_1", [{ panel: "ch1/p0001_1.jpg", page: 1, page_span: [1, 2], idx: 1 }, { panel: "ch1/p0003_1.jpg", page: 3, idx: 1 }]],
    ]);
    const img = fillRgb(8, 8, [80, 40, 40]);
    const box = { x0: 0.1, y0: 0.7, x1: 0.9, y1: 1 };
    const baseNext = { art: 1, overlay: [], world: [], box: { x0: 0, y0: 0, x1: 1, y1: 0.2 } };
    for (const donor of [
      { ...baseNext, promo_page: true },
      { ...baseNext },
      { ...baseNext, promo_page: false, promo_regions: [{ text: "AD" }] },
    ]) {
      const got = await _continuation(
        "p0001_1",
        box,
        img,
        records,
        new Map([["p0003_1", donor]]),
        fx.panels,
        new Set(),
      );
      expect(got).toBeNull();
    }
  });

  it("frameShots welds only a confirmed story donor and leaves timing, obs, and sources alone", async () => {
    const fx = await continuationFixture();
    const obs = { panels: [fx.pg, fx.next] };
    const obsCopy = structuredClone(obs);
    const hashes = Object.fromEntries(
      fs.readdirSync(fx.panels).map((name) => [name, sha256(path.join(fx.panels, name))]),
    );
    const shot = structuredClone(fx.shot);
    const stats = await frameShots([shot], obs, fx.panels, fx.crops);
    expect(stats.continued).toBe(1);
    expect(stats.cropped).toBe(1);
    expect(shot.render_sources).toEqual(["p0001_1", "p0003_1"]);
    expect(shot.source_panel).toBe("p0001_1.jpg");
    expect(shot.start_s).toBe(1.2);
    expect(shot.end_s).toBe(4.9);
    expect(shot.line_id).toBe(7);
    expect(shot.weight).toBe(2);
    expect(shot.ph).toBeLessThan(1000);
    expect(fs.existsSync(String(shot._src))).toBe(true);
    expect(String(shot._src).startsWith(fx.crops)).toBe(true);
    const box = shot.box as Record<string, number>;
    expect(Object.values(box).every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(obs).toEqual(obsCopy);
    for (const [name, digest] of Object.entries(hashes)) {
      expect(sha256(path.join(fx.panels, name))).toBe(digest);
    }

    const again = structuredClone(fx.shot);
    const second = await frameShots([again], obs, fx.panels, fx.crops);
    expect(second.continued).toBe(1);
    expect(again._src).toBe(shot._src);
    const frozen = structuredClone(shot);
    const third = await frameShots([shot], obs, fx.panels, fx.crops);
    expect(third.unchanged).toBe(1);
    expect(shot).toEqual(frozen);
  });

  it("does not borrow a dialogue, world-text, or already-selected neighbour", async () => {
    const talk = await continuationFixture();
    talk.next.overlay = ["new dialogue"];
    const talkShot = structuredClone(talk.shot);
    const talkStats = await frameShots([talkShot], { panels: [talk.pg, talk.next] }, talk.panels, talk.crops);
    expect(talkStats.continued).toBe(0);
    expect(talkShot.render_sources).toEqual(["p0001_1"]);

    const world = await continuationFixture();
    world.next.world = ["LEVEL 5"];
    const worldStats = await frameShots(
      [structuredClone(world.shot)],
      { panels: [world.pg, world.next] },
      world.panels,
      world.crops,
    );
    expect(worldStats.continued).toBe(0);

    const picked = await continuationFixture();
    const shots = [
      structuredClone(picked.shot),
      { ...structuredClone(picked.shot), panel: "p0003_1.jpg", box: picked.next.box },
    ];
    const pickedStats = await frameShots(shots, { panels: [picked.pg, picked.next] }, picked.panels, picked.crops);
    expect(pickedStats.continued).toBe(0);
  });

  it("keeps a missing or whole-panel box, and crops art rather than a top bubble", async () => {
    const fx = await continuationFixture();
    for (const box of [null, { x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: Number.NaN }]) {
      const shot = { ...structuredClone(fx.shot), box };
      const original = structuredClone(shot);
      const stats = await frameShots([shot], { panels: [fx.pg, fx.next] }, fx.panels, fx.crops);
      expect(stats.cropped).toBe(0);
      expect(shot).toEqual(original);
    }

    const dir = makeTemp("bubble");
    const panels = path.join(dir, "panels");
    fs.mkdirSync(panels);
    const img = fillRgb(400, 800, [255, 255, 255]);
    pasteRgb(img, [60, 90, 150], 0, 200, 400, 500);
    await writeRawJpeg(path.join(panels, "p0001_1.jpg"), 400, 800, img.data);
    fs.writeFileSync(path.join(panels, "manifest.json"), "[]");
    const pg = {
      id: "p0001_1",
      art: 0.8,
      overlay: ["dialogue"],
      world: [],
      box: { x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.6 },
    };
    const shot: Record<string, unknown> = {
      panel: "p0001_1.jpg",
      start_s: 1,
      end_s: 2,
      line_id: 0,
      weight: 2,
      box: { ...pg.box },
    };
    const stats = await frameShots([shot], { panels: [pg] }, panels, path.join(dir, "crops"));
    expect(stats.continued).toBe(0);
    const crop = shot.crop as number[];
    expect(crop[1]).toBeGreaterThanOrEqual(200);
    expect(crop[3]).toBeLessThanOrEqual(500);
    expect(shot.ph).toBeLessThan(400);

    const speech = fillRgb(400, 800, [50, 100, 170]);
    pasteRgb(speech, [240, 240, 240], 25, 0, 300, 180);
    pasteRgb(speech, [15, 15, 15], 55, 40, 270, 65);
    pasteRgb(speech, [240, 210, 200], 100, 350, 300, 390);
    await writeRawJpeg(path.join(panels, "p0002_1.jpg"), 400, 800, speech.data);
    const pg2 = {
      id: "p0002_1",
      art: 0.5,
      bubble_at: "top",
      world: ["SKILL: ???"],
      overlay: ["dialogue"],
      box: { x0: 0.05, y0: 0.1, x1: 0.95, y1: 0.9 },
    };
    const shot2: Record<string, unknown> = {
      panel: "p0002_1.jpg",
      start_s: 1,
      end_s: 2,
      line_id: 1,
      weight: 2,
      box: { ...pg2.box },
    };
    const stats2 = await frameShots([shot2], { panels: [pg2] }, panels, path.join(dir, "crops"));
    expect(stats2.cropped).toBe(1);
    const crop2 = shot2.crop as number[];
    expect(crop2[1]).toBeGreaterThanOrEqual(180);
    expect(crop2[1]).toBeLessThan(350);
    expect(crop2[3]).toBeGreaterThan(390);

    const white = fillRgb(400, 800, [255, 255, 255]);
    await writeRawJpeg(path.join(panels, "p0009_1.jpg"), 400, 800, white.data);
    const pg3 = { id: "p0009_1", art: 0.8, bubble_at: "top", box: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 } };
    const shot3: Record<string, unknown> = { panel: "p0009_1.jpg", box: { ...pg3.box } };
    const stats3 = await frameShots([shot3], { panels: [pg3] }, panels, path.join(dir, "crops"));
    expect(stats3.cropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// audio external TTS
// ---------------------------------------------------------------------------

describe("audio external TTS", () => {
  function baseMeta(overrides: Record<string, unknown> = {}) {
    return {
      engine: "external",
      provider: "grok-subscription-tts",
      revision: "1",
      command: ["/usr/bin/python3", "/home/shair/home/tts/grok_tts.py"],
      voice_id: "eve",
      language: "en",
      speed: 1.0,
      style: "",
      settings: { text_normalization: false },
      ...overrides,
    };
  }

  it("requires voice_id and command, and parses an env command without a shell", () => {
    expect(() => _resolveExternalTtsConfig(baseMeta({ voice_id: "" }), {})).toThrow(/voice_id is empty/);
    expect(() => _resolveExternalTtsConfig(baseMeta({ command: [] }), {})).toThrow(/command .* is empty/);
    expect(() => _parseExternalCommand("")).toThrow(ValueError);
    expect(() => _parseExternalCommand("[]")).toThrow(ValueError);
    expect(() => _parseExternalCommand("[")).toThrow(/invalid JSON command/);
    expect(_parseExternalCommand('["/usr/bin/python3", "/tmp/a.py"]')).toEqual([
      "/usr/bin/python3",
      "/tmp/a.py",
    ]);
    expect(shlexSplit('/usr/bin/python3 "/tmp/my adapter.py"')).toEqual([
      "/usr/bin/python3",
      "/tmp/my adapter.py",
    ]);
    const cfg = _resolveExternalTtsConfig(
      { engine: "external", voice_id: "eve" },
      { MANHWA_TTS_COMMAND: "/usr/bin/python3 /home/shair/home/tts/grok_tts.py" },
    );
    expect(cfg.command).toEqual(["/usr/bin/python3", "/home/shair/home/tts/grok_tts.py"]);
    expect(cfg.engine).toBe("external");
    expect(cfg.speed).toBe(1);
  });

  it("changes both cache keys when any provider field changes", () => {
    const lines: [string, string[]][] = [["[excited] First line.", ["p0001_1"]]];
    const base = _resolveExternalTtsConfig(baseMeta(), {});
    const baseConcat = _narrationCacheKey(lines, "external", "eve", base);
    const baseLine = _lineProofToken(lines[0]![0], base);
    const mutations = [
      { provider: "azure-tts" },
      { revision: "2" },
      { command: ["/usr/bin/python3", "/tmp/other_adapter.py"] },
      { voice_id: "rex" },
      { language: "pt-BR" },
      { speed: 1.2 },
      { style: "urgent" },
      { settings: { text_normalization: true } },
    ];
    for (const mod of mutations) {
      const cfg2 = _resolveExternalTtsConfig(baseMeta(mod), {});
      expect(_narrationCacheKey(lines, "external", cfg2.voice_id, cfg2)).not.toBe(baseConcat);
      expect(_lineProofToken(lines[0]![0], cfg2)).not.toBe(baseLine);
    }
  });

  it("invalidates a line mp3 whose .txt proof does not match", () => {
    const dir = makeTemp("proof");
    const mp3 = path.join(dir, "line_000.mp3");
    const side = path.join(dir, "line_000.txt");
    fs.writeFileSync(mp3, Buffer.alloc(800, 7));
    fs.writeFileSync(side, "old text");
    _lineFile(dir, 0, "new text");
    expect(fs.existsSync(mp3)).toBe(false);
    expect(fs.existsSync(side)).toBe(false);

    const cfg = _resolveExternalTtsConfig(baseMeta(), {});
    const proof = _lineProofToken("hello", cfg);
    fs.writeFileSync(mp3, Buffer.alloc(800, 7));
    fs.writeFileSync(side, proof);
    const [kept] = _lineFile(dir, 0, "hello", proof);
    expect(fs.existsSync(kept)).toBe(true);
    fs.writeFileSync(side, proof + " ");
    _lineFile(dir, 0, "hello", proof);
    expect(fs.existsSync(mp3)).toBe(false);

    fs.writeFileSync(side, "orphan");
    _lineFile(dir, 0, "hello", proof);
    expect(fs.existsSync(side)).toBe(false);
  });

  it("reuses a proved line and resynthesizes when speed changes", async () => {
    const dir = makeTemp("tts");
    const sample = path.join(dir, "sample.mp3");
    const made = spawnSync(
      "ffmpeg",
      ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.35", "-ac", "1", "-ar", "24000", "-b:a", "64k", sample],
      { encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    const log = path.join(dir, "calls.jsonl");
    const helper = path.join(dir, "fake_tts.py");
    fs.writeFileSync(
      helper,
      "#!/usr/bin/env python3\n" +
        "import json, sys, shutil\n" +
        "req = json.loads(sys.stdin.read())\n" +
        `open(${JSON.stringify(log)}, "a").write(json.dumps({"speed": req["speed"], "voice_id": req["voice_id"]}) + "\\n")\n` +
        `shutil.copyfile(${JSON.stringify(sample)}, req["output_path"])\n`,
    );
    fs.chmodSync(helper, 0o755);
    const lines: [string, string[]][] = [["[excited] He lifts the blade.", ["p0001_1"]]];
    const tmp = path.join(dir, "lines");
    const meta = baseMeta({ command: [helper], voice_id: "eve", speed: 1.0 });
    const spans1 = await ttsLinesExternal(lines, tmp, meta, {});
    expect(spans1).toHaveLength(1);
    expect(spans1[0]![0]).toBe(0);
    expect(spans1[0]![1]).toBeGreaterThan(0.2);
    const cached = await ttsLinesExternal(lines, tmp, meta, {});
    expect(cached[0]![1]).toBeCloseTo(spans1[0]![1], 5);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);

    await ttsLinesExternal(lines, tmp, baseMeta({ command: [helper], voice_id: "eve", speed: 1.25 }), {});
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { speed: number });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.speed).toBe(1.25);
    const side = fs.readFileSync(path.join(tmp, "line_000.txt"), "utf8");
    expect(side).toContain("1.25");
    expect(side).not.toBe(lines[0]![0]);
  });

  it("does not commit a zero-duration file, and hides command secrets on failure", async () => {
    const dir = makeTemp("tts-bad");
    const bad = path.join(dir, "bad.py");
    fs.writeFileSync(
      bad,
      "#!/usr/bin/env python3\nimport json,sys\nreq=json.loads(sys.stdin.read())\nopen(req['output_path'],'wb').write(b'not-an-mp3')\n",
    );
    fs.chmodSync(bad, 0o755);
    const lines: [string, string[]][] = [["Test line.", ["p0001_1"]]];
    const tmp = path.join(dir, "out");
    await expect(ttsLinesExternal(lines, tmp, baseMeta({ command: [bad] }), {})).rejects.toThrow(/invalid audio/);
    expect(fs.existsSync(path.join(tmp, "line_000.mp3"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "line_000.txt"))).toBe(false);

    const fail = path.join(dir, "fail.py");
    fs.writeFileSync(
      fail,
      "#!/usr/bin/env python3\nimport json,sys\nreq=json.loads(sys.stdin.read())\nopen(req['output_path'],'wb').write(b'partial')\nsys.exit(1)\n",
    );
    fs.chmodSync(fail, 0o755);
    const errDir = path.join(dir, "err");
    await expect(
      ttsLinesExternal(lines, errDir, baseMeta({ command: [fail, "--token=supersecret"] }), {}),
    ).rejects.toThrow(RuntimeError);
    try {
      await ttsLinesExternal(lines, errDir, baseMeta({ command: [fail, "--token=supersecret"] }), {});
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toBe("external tts line 0 failed: rc=1");
      expect(msg).not.toContain("supersecret");
      expect(msg).not.toContain("SECRET");
    }
    expect(fs.readdirSync(errDir)).toEqual([]);

    await expect(
      ttsLinesExternal(lines, path.join(dir, "miss"), baseMeta({ command: ["/missing/bin/tts", "--key=topsecret123"] }), {}),
    ).rejects.toThrow(/executable not found/);
    try {
      await ttsLinesExternal(lines, path.join(dir, "miss"), baseMeta({ command: ["/missing/bin/tts", "--key=topsecret123"] }), {});
    } catch (e) {
      expect((e as Error).message).not.toContain("topsecret123");
    }
  });
});

// ---------------------------------------------------------------------------
// timeline parse / pick / borrow
// ---------------------------------------------------------------------------

describe("timeline script, ladder, and borrow", () => {
  it("parseScript strips tags, attaches orphans, and keeps @hold", () => {
    const dir = makeTemp("script");
    const file = path.join(dir, "script.md");
    fs.writeFileSync(
      file,
      "# comment\n\n" +
        "@p0009_1\n" +
        "Hello world @p0001_1\n" +
        "\n" +
        "@p0002_1\n" +
        "Next line @p0003_2 @hold\n" +
        "@p0004\n",
    );
    expect(parseScript(file)).toEqual([
      ["Hello world", ["p0009_1", "p0001_1", "p0002_1"]],
      ["Next line", ["@hold", "p0003_2", "page:0004"]],
    ]);
  });

  it("pickPanels walks the adjacency-first ladder and will not drop a run middle", () => {
    const adj = byId([
      obsPanel(1, 1, 0.2, { promo_page: true }),
      obsPanel(1, 2, 0.7),
      obsPanel(1, 3, 0.95),
      obsPanel(2, 1, 0.9),
    ]);
    const [ids, swaps] = pickPanels(adj, ["p0001_1"], "He runs.", 0);
    expect(ids).toEqual(["p0001_2"]);
    expect(swaps[0]).toContain("in-run");

    const samePage = byId([
      obsPanel(1, 1, 0.2, { promo_page: true }),
      obsPanel(1, 2, 0.4),
      obsPanel(1, 3, 0.95),
    ]);
    const [sameIds, sameSwaps] = pickPanels(samePage, ["p0001_1"], "He runs.", 0);
    expect(sameIds).toEqual(["p0001_3"]);
    expect(sameSwaps[0]).toContain("same-page");

    const page = byId([
      obsPanel(1, 1, 0.2, { promo_page: true }),
      obsPanel(2, 1, 0.9),
    ]);
    expect(pickPanels(page, ["p0001_1"], "He runs.", 0)[0]).toEqual(["p0002_1"]);

    const seen = byId([
      obsPanel(1, 1, 0.2, { promo_page: true }),
      obsPanel(1, 2, 0.7),
      obsPanel(1, 3, 0.95),
    ]);
    expect(pickPanels(seen, ["p0001_1"], "He runs.", 0, null, new Set(["p0001_2"]))[0]).toEqual(["p0001_3"]);

    const run = byId([
      obsPanel(1, 1, 0.2, { promo_page: true }),
      obsPanel(1, 2, 0.2, { promo_page: true }),
      obsPanel(1, 3, 0.2, { promo_page: true }),
    ]);
    const [kept, notes] = pickPanels(run, ["p0001_1", "p0001_2", "p0001_3"], "He runs.", 0);
    expect(kept).toEqual(["p0001_2"]);
    expect(notes[0]).toContain("dropped");
    expect(notes[1]).toContain("last member");
    expect(notes[2]).toContain("dropped");

    const about = byId([
      obsPanel(1, 1, 0.2, { promo_page: true }),
      obsPanel(1, 2, 0.9),
    ]);
    const [aboutIds, aboutSwaps, consec] = pickPanels(about, ["p0001_1"], "the system window opens", 0);
    expect(aboutIds).toEqual(["p0001_1"]);
    expect(aboutSwaps).toEqual([]);
    expect(consec).toBe(1);
  });

  it("borrows a contiguous run, prefers the nearer page, and skips reserved anchors", () => {
    const chain = byId([
      obsPanel(1, 1, 0.9),
      obsPanel(1, 2, 0.9),
      obsPanel(1, 3, 0.9),
      obsPanel(2, 1, 0.9),
    ]);
    expect(_borrowRun(chain, ["p0001_1"], new Set(["p0001_1"]), null, null, 2, new Set(["p0001_2"]))).toEqual([
      "p0001_3",
      "p0002_1",
    ]);

    const gapped = byId([
      obsPanel(1, 1, 0.9),
      obsPanel(1, 2, 0.9),
      obsPanel(3, 1, 0.9),
      obsPanel(4, 1, 0.9),
      obsPanel(4, 2, 0.9),
      obsPanel(5, 1, 0.9),
    ]);
    expect(
      _borrowRun(gapped, ["p0005_1"], new Set(["p0005_1", "p0003_1"]), null, null, 2),
    ).toEqual(["p0004_1", "p0004_2"]);
  });

  it("buildShots will not spend a reserved future anchor, and an untagged line extends", async () => {
    const dir = makeTemp("shots");
    const panels = path.join(dir, "panels");
    fs.mkdirSync(panels);
    fs.writeFileSync(path.join(panels, "manifest.json"), "[]");
    const raw = new Uint8Array(8 * 8 * 3).fill(40);
    for (const id of ["p0001_1", "p0001_2", "p0001_3"]) {
      await writeRawJpeg(path.join(panels, `${id}.jpg`), 8, 8, raw);
    }
    const obs = { panels: [obsPanel(1, 1, 0.95), obsPanel(1, 2, 0.9), obsPanel(1, 3, 0.8)] };
    const shots = buildShots(
      [
        ["First.", ["p0001_1"]],
        ["Page again.", ["page:0001"]],
        ["Later.", ["p0001_2"]],
      ],
      [[0, 2], [2, 4], [4, 6]],
      obs,
      panels,
      null,
      false,
    );
    expect(shots.map((s) => s.panel)).toEqual(["p0001_1.jpg", "p0001_3.jpg", "p0001_2.jpg"]);
    expect(shots.map((s) => s.line_id)).toEqual([0, 1, 2]);
    expect(shots[0]!.start_s).toBe(0);
    expect(shots[2]!.end_s).toBe(6);

    const extended = buildShots(
      [
        ["A.", ["p0001_1"]],
        ["B.", []],
        ["C.", ["@hold"]],
      ],
      [[0, 1.5], [1.5, 3.2], [3.2, 4.1]],
      obs,
      panels,
      null,
      false,
    );
    expect(extended).toHaveLength(1);
    expect(extended[0]!.panel).toBe("p0001_1.jpg");
    expect(extended[0]!.end_s).toBe(4.1);
  });
});

// ---------------------------------------------------------------------------
// golden buildShots vs v1 Python, read-only
// ---------------------------------------------------------------------------

describe("golden buildShots", () => {
  it("matches timeline.build_shots on reality-quest ch1-ch20", async () => {
    const dir = makeTemp("golden");
    const outJson = path.join(dir, "py.json");
    const script = path.join(dir, "oracle.py");
    fs.writeFileSync(
      script,
      `
import json, os, sys
sys.path.insert(0, "/home/shair/manhwa-pipeline/pipeline")
import promo_block, timeline
sdir = ${JSON.stringify(path.join(V1_SERIES, "reality-quest"))}
out = os.path.join(sdir, "out")
meta = json.load(open(os.path.join(sdir, "meta.json")))
engine = meta.get("tts", {}).get("engine", "edge")
block = promo_block.load(out)
script_name = {"eleven": "script_eleven.md", "external": "script_voice.md"}.get(engine, "script.md")
rows = []
for i in range(1, 21):
    name = "ch%d" % i
    cdir = os.path.join(out, name)
    script = os.path.join(cdir, script_name)
    durs_p = os.path.join(cdir, "video", "tts_durs.json")
    panels = os.path.join(out, "panels", name)
    obs_p = os.path.join(out, "obs_%s.json" % name)
    for p in (script, durs_p, obs_p):
        if not os.path.isfile(p):
            sys.exit("missing %s" % p)
    if not os.path.isdir(panels):
        sys.exit("missing %s" % panels)
    lines = timeline.parse_script(script)
    durs = json.load(open(durs_p))
    spans, t = [], 0.0
    for du in durs:
        spans.append((t, t + float(du)))
        t += float(du)
    obs = json.load(open(obs_p))
    obs = obs.get("data", obs)
    hook = "## BEAT b00_opening" in open(script).read(400)
    shots = timeline.build_shots(lines, spans, obs, panels, block, hook_first=hook)
    rows.append({"ch": name, "hook": hook, "shots": shots})
json.dump(rows, open(${JSON.stringify(outJson)}, "w"))
print("ok", len(rows))
`,
    );
    const py = spawnSync(VENV_PY, [script], { encoding: "utf8", timeout: 150_000 });
    expect(py.status, (py.stderr || py.stdout || "").slice(-800)).toBe(0);
    const rows = JSON.parse(fs.readFileSync(outJson, "utf8")) as Array<{
      ch: string;
      hook: boolean;
      shots: Array<Record<string, unknown>>;
    }>;
    expect(rows).toHaveLength(20);
    const block = loadPromoBlock(path.join(V1_SERIES, "reality-quest", "out"));
    const mismatches: string[] = [];
    for (const row of rows) {
      const cdir = path.join(V1_SERIES, "reality-quest", "out", row.ch);
      const scriptPath = path.join(cdir, "script_eleven.md");
      const lines = parseScript(scriptPath);
      const durs = JSON.parse(fs.readFileSync(path.join(cdir, "video", "tts_durs.json"), "utf8")) as number[];
      const spans: [number, number][] = [];
      let t = 0;
      for (const du of durs) {
        spans.push([t, t + Number(du)]);
        t += Number(du);
      }
      let obs = JSON.parse(fs.readFileSync(path.join(V1_SERIES, "reality-quest", "out", `obs_${row.ch}.json`), "utf8"));
      if (obs && typeof obs === "object" && "data" in obs) obs = obs.data;
      const shots = buildShots(
        lines,
        spans,
        obs,
        path.join(V1_SERIES, "reality-quest", "out", "panels", row.ch),
        block,
        row.hook,
      );
      if (shots.length !== row.shots.length) {
        mismatches.push(`${row.ch} length ${shots.length} != ${row.shots.length}`);
        continue;
      }
      expect(shots.length).toBeGreaterThan(0);
      for (let i = 0; i < shots.length && mismatches.length < 8; i++) {
        const why = shotDiff(shots[i]!, row.shots[i]!);
        if (why) mismatches.push(`${row.ch}[${i}] ${why}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 180_000);
});

function shotDiff(ts: TimelineShot, py: Record<string, unknown>): string | null {
  const keys = ["panel", "start_s", "end_s", "line_id", "focus_y", "art_top", "art_bottom", "weight", "pw", "ph"] as const;
  for (const k of keys) {
    const av = ts[k];
    const bv = py[k];
    if (typeof av === "number" && typeof bv === "number") {
      if (Math.abs(av - bv) > 1e-6) return `${k} ${av} != ${bv}`;
    } else if (av !== bv) {
      return `${k} ${String(av)} != ${String(bv)}`;
    }
  }
  const afx = ts.focus_x;
  const bfx = py.focus_x;
  if (!(afx == null && (bfx == null))) {
    if (typeof afx !== "number" || typeof bfx !== "number" || Math.abs(afx - bfx) > 1e-6) {
      return `focus_x ${String(afx)} != ${String(bfx)}`;
    }
  }
  const ab = ts.box;
  const bb = py.box as { x0: number; y0: number; x1: number; y1: number } | undefined;
  if (!ab && !bb) return null;
  if (!ab || !bb) return `box ${JSON.stringify(ab)} != ${JSON.stringify(bb)}`;
  for (const k of ["x0", "y0", "x1", "y1"] as const) {
    if (Math.abs(ab[k] - bb[k]) > 1e-6) return `box.${k} ${ab[k]} != ${bb[k]}`;
  }
  return null;
}
