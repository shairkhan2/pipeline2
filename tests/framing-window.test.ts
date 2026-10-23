/**
 * Recap-style window framing: full-width sliding window, bubble avoidance,
 * bubble detector fallback chain, and the 1.5 s per-panel pacing floor.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { _hooks, detectBubbleBoxes, type BubbleBox } from "../src/stages/cleaner.js";
import {
  _heuristicBubbles,
  _trimSubject,
  bubbleSet,
  frameShots,
  pickWindow,
  WINDOW_MAX_ASPECT,
  WINDOW_MIN_ASPECT,
  type BubbleRect,
  type Rect,
  type Rgb,
} from "../src/stages/framing.js";
import { buildShots, MIN_PANEL_S } from "../src/stages/timeline.js";

const tmpRoots: string[] = [];
function makeTemp(prefix: string): string {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  const dir = fs.mkdtempSync(path.join("/tmp/opencode", `${prefix}-`));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});
const realHooks = { ..._hooks };
afterEach(() => {
  Object.assign(_hooks, realHooks);
});

function fillRgb(w: number, h: number, color: [number, number, number]): Rgb {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(color, i * 3);
  return { w, h, data };
}

function paste(img: Rgb, color: [number, number, number], x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(color, (y * img.w + x) * 3);
}

/** A white balloon with three dark lettering bars. */
function balloon(img: Rgb, x0: number, y0: number, x1: number, y1: number): void {
  paste(img, [250, 250, 250], x0, y0, x1, y1);
  const lh = Math.max(4, Math.floor((y1 - y0) / 9));
  for (let k = 0; k < 3; k++) {
    const ly = y0 + Math.floor(((k + 1) * (y1 - y0)) / 4) - Math.floor(lh / 2);
    paste(img, [20, 20, 20], x0 + Math.floor((x1 - x0) * 0.2), ly, x1 - Math.floor((x1 - x0) * 0.2), ly + lh);
  }
}

async function writeJpeg(file: string, img: Rgb): Promise<void> {
  await sharp(Buffer.from(img.data), { raw: { width: img.w, height: img.h, channels: 3 } })
    .jpeg({ quality: 95 })
    .toFile(file);
}

function inside(win: Rect, subject: Rect): boolean {
  return win[1] <= subject[1] && win[3] >= subject[3];
}

function overlapRows(win: Rect, b: BubbleRect): number {
  return Math.max(0, Math.min(win[3], b[3]) - Math.max(win[1], b[1]));
}

describe("pickWindow", () => {
  it("is full width, keeps the subject inside and respects the aspect bounds", () => {
    const cases: Rect[] = [
      [100, 1200, 800, 1400], // short face close-up
      [50, 300, 850, 2600], // tall full body
      [0, 0, 900, 120], // tiny strip
    ];
    for (const subject of cases) {
      const win = pickWindow({ w: 900, h: 3000, subject, bubbles: [], weight: 2 });
      expect(win[0]).toBe(0);
      expect(win[2]).toBe(900);
      const ar = 900 / (win[3] - win[1]);
      expect(ar).toBeLessThanOrEqual(WINDOW_MAX_ASPECT + 0.01);
      expect(ar).toBeGreaterThanOrEqual(WINDOW_MIN_ASPECT - 0.01);
      if (subject[3] - subject[1] <= 900 / WINDOW_MIN_ASPECT) expect(inside(win, subject)).toBe(true);
    }
  });

  it("slides away from a bubble when the subject allows it", () => {
    const subject: Rect = [100, 1000, 800, 1400];
    const bubbleAbove: BubbleRect = [150, 600, 750, 950];
    const win = pickWindow({ w: 900, h: 3000, subject, bubbles: [bubbleAbove], weight: 2 });
    expect(inside(win, subject)).toBe(true);
    expect(overlapRows(win, bubbleAbove)).toBe(0);
    const bubbleBelow: BubbleRect = [150, 1420, 750, 1800];
    const win2 = pickWindow({ w: 900, h: 3000, subject, bubbles: [bubbleBelow], weight: 2 });
    expect(inside(win2, subject)).toBe(true);
    expect(overlapRows(win2, bubbleBelow)).toBe(0);
  });

  it("centres the subject when there is no bubble", () => {
    const subject: Rect = [100, 1000, 800, 1400];
    const win = pickWindow({ w: 900, h: 3000, subject, bubbles: [], weight: 2 });
    const mid = (win[1] + win[3]) / 2;
    expect(Math.abs(mid - 1200)).toBeLessThan(15);
  });

  it("gives a heavier panel more context", () => {
    const subject: Rect = [100, 1000, 800, 1800];
    const h = (weight: number) => {
      const r = pickWindow({ w: 900, h: 3000, subject, bubbles: [], weight });
      return r[3] - r[1];
    };
    expect(h(3)).toBeGreaterThan(h(2));
    expect(h(2)).toBeGreaterThan(h(1));
  });

  it("keeps the focus row inside a subject taller than the tallest window", () => {
    const subject: Rect = [0, 0, 900, 4000];
    const win = pickWindow({ w: 900, h: 4000, subject, bubbles: [], weight: 2, focusY: 3200 });
    expect(win[3] - win[1]).toBeLessThanOrEqual(Math.ceil(900 / WINDOW_MIN_ASPECT));
    expect(win[1]).toBeLessThan(3200);
    expect(win[3]).toBeGreaterThan(3200);
  });

  it("_trimSubject cuts a bubble out of the end of the reader box", () => {
    expect(_trimSubject([0, 100, 900, 1500], [[200, 80, 700, 400]])).toEqual([0, 400, 900, 1500]);
    expect(_trimSubject([0, 100, 900, 1500], [[200, 1300, 700, 1520]])).toEqual([0, 100, 900, 1300]);
    // A bubble in the middle of the subject is not a trim point.
    expect(_trimSubject([0, 100, 900, 1500], [[200, 700, 700, 900]])).toEqual([0, 100, 900, 1500]);
  });
});

describe("bubble detection fallback chain", () => {
  it("heuristic finds a lettered white balloon and ignores white gutters and blank fields", () => {
    const img = fillRgb(400, 1200, [60, 90, 150]);
    balloon(img, 80, 100, 320, 260);
    paste(img, [255, 255, 255], 0, 600, 400, 640); // full-width gutter
    paste(img, [250, 250, 250], 100, 800, 300, 950); // blank white field, no text
    const found = _heuristicBubbles(img);
    expect(found).toHaveLength(1);
    const [x0, y0, x1, y1] = found[0]!;
    expect(x0).toBeLessThanOrEqual(85);
    expect(y0).toBeLessThanOrEqual(105);
    expect(x1).toBeGreaterThanOrEqual(315);
    expect(y1).toBeGreaterThanOrEqual(255);
    expect(y1).toBeLessThan(600);
  });

  it("bubbleSet prefers CTD, then heuristic, then the reader's bubble_at", () => {
    const img = fillRgb(400, 800, [60, 90, 150]);
    balloon(img, 80, 400, 320, 520);
    const ctd: BubbleBox[] = [[100, 420, 300, 500, 0.9]];
    expect(bubbleSet(img, ctd, "none").source).toBe("ctd");
    const heur = bubbleSet(img, null, "none");
    expect(heur.source).toBe("heuristic");
    expect(heur.rects.length).toBe(1);

    const edge = fillRgb(400, 800, [50, 100, 170]);
    paste(edge, [240, 240, 240], 0, 0, 400, 180); // full-width top band: not a heuristic blob
    paste(edge, [15, 15, 15], 55, 40, 270, 65);
    const fallback = bubbleSet(edge, null, "top");
    expect(fallback.source).toBe("bubble_at");
    expect(fallback.rects[0]![3]).toBeGreaterThanOrEqual(180);
    expect(bubbleSet(fillRgb(50, 50, [60, 90, 150]), null, "none")).toEqual({ source: "none", rects: [] });
  });

  it("detectBubbleBoxes degrades to null when the detector is unavailable or throws, and caches hits", async () => {
    const dir = makeTemp("bubbles");
    const file = path.join(dir, "a.jpg");
    await writeJpeg(file, fillRgb(64, 64, [90, 90, 90]));
    const cache = path.join(dir, "cache");
    const prev = process.env.MANHWA_BUBBLE_DETECTOR;
    delete process.env.MANHWA_BUBBLE_DETECTOR;
    try {
      _hooks._runBubbleAdapter = async () => null;
      expect(await detectBubbleBoxes([file], cache)).toEqual({ [file]: null });
      _hooks._runBubbleAdapter = async () => {
        throw new Error("python missing");
      };
      expect(await detectBubbleBoxes([file], cache)).toEqual({ [file]: null });

      let calls = 0;
      _hooks._runBubbleAdapter = async (imgs) => {
        calls++;
        return Object.fromEntries(imgs.map((p) => [p, [[1, 2, 30, 40, 0.9]] as BubbleBox[]]));
      };
      expect(await detectBubbleBoxes([file], cache)).toEqual({ [file]: [[1, 2, 30, 40, 0.9]] });
      expect(await detectBubbleBoxes([file], cache)).toEqual({ [file]: [[1, 2, 30, 40, 0.9]] });
      expect(calls).toBe(1);

      process.env.MANHWA_BUBBLE_DETECTOR = "off";
      _hooks._runBubbleAdapter = async () => {
        throw new Error("must not run");
      };
      const other = path.join(dir, "b.jpg");
      await writeJpeg(other, fillRgb(64, 64, [10, 90, 10]));
      expect(await detectBubbleBoxes([other], cache)).toEqual({ [other]: null });
    } finally {
      if (prev === undefined) delete process.env.MANHWA_BUBBLE_DETECTOR;
      else process.env.MANHWA_BUBBLE_DETECTOR = prev;
    }
  });
});

describe("frameShots window mode", () => {
  async function fixture() {
    const dir = makeTemp("window");
    const panels = path.join(dir, "panels");
    fs.mkdirSync(panels);
    fs.writeFileSync(path.join(panels, "manifest.json"), "[]");
    // Tall 600x3000 strip: bubble at the top, subject in the middle.
    const img = fillRgb(600, 3000, [70, 60, 110]);
    balloon(img, 150, 150, 450, 450);
    paste(img, [180, 120, 90], 150, 900, 450, 1700);
    await writeJpeg(path.join(panels, "p0001_1.jpg"), img);
    const pg = {
      id: "p0001_1",
      art: 0.9,
      weight: 2,
      bubble_at: "top",
      box: { x0: 0, y0: 0.03, x1: 1, y1: 0.6 },
      focus_x: 0.5,
      focus_y: 0.4,
    };
    return { dir, panels, pg };
  }

  it("windows a tall panel, keeps the subject, drops the bubble, and stays backward compatible", async () => {
    const fx = await fixture();
    const shot: Record<string, unknown> = {
      panel: "p0001_1.jpg",
      start_s: 0,
      end_s: 2,
      line_id: 0,
      weight: 2,
      box: { ...fx.pg.box },
      focus_x: 0.5,
      focus_y: 0.4,
    };
    const ctd = async (imgs: readonly string[]) =>
      Object.fromEntries(imgs.map((p) => [p, [[180, 200, 420, 400, 0.95]] as BubbleBox[]]));
    const stats = await frameShots([shot], { panels: [fx.pg] }, fx.panels, path.join(fx.dir, "crops"), {
      mode: "window",
      detect: ctd,
    });
    expect(stats.cropped).toBe(1);
    expect(stats.bubbles).toEqual({ ctd: 1 });
    const crop = shot.crop as number[];
    expect(crop[0]).toBe(0);
    expect(crop[2]).toBe(600);
    expect(crop[1]).toBeGreaterThanOrEqual(450);
    expect(crop[1]).toBeLessThanOrEqual(900);
    expect(crop[3]).toBeGreaterThanOrEqual(1700);
    const ar = (shot.pw as number) / (shot.ph as number);
    expect(ar).toBeGreaterThanOrEqual(WINDOW_MIN_ASPECT - 0.01);
    expect(ar).toBeLessThanOrEqual(WINDOW_MAX_ASPECT + 0.01);
    expect(shot.framed).toBe(true);
    expect(shot.start_s).toBe(0);
    expect(shot.end_s).toBe(2);
    const meta = await sharp(String(shot._src)).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([shot.pw, shot.ph]);
    for (const v of Object.values(shot.box as Record<string, number>)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("windows a whole-panel box on a huge strip, but leaves a whole-panel box that already fits", async () => {
    const fx = await fixture();
    const full = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const shot: Record<string, unknown> = { panel: "p0001_1.jpg", box: full, weight: 2 };
    const none = async (imgs: readonly string[]) => Object.fromEntries(imgs.map((p) => [p, [] as BubbleBox[]]));
    const stats = await frameShots([shot], { panels: [{ ...fx.pg, box: full }] }, fx.panels, path.join(fx.dir, "c1"), {
      mode: "window",
      detect: none,
    });
    expect(stats.cropped).toBe(1);
    expect((shot.ph as number)).toBeLessThan(3000);

    const small = fillRgb(600, 800, [70, 60, 110]);
    await writeJpeg(path.join(fx.panels, "p0002_1.jpg"), small);
    const pg2 = { id: "p0002_1", art: 0.9, box: full };
    const shot2: Record<string, unknown> = { panel: "p0002_1.jpg", box: full };
    const before = structuredClone(shot2);
    const stats2 = await frameShots([shot2], { panels: [pg2] }, fx.panels, path.join(fx.dir, "c2"), {
      mode: "window",
      detect: none,
    });
    expect(stats2.unchanged).toBe(1);
    expect(shot2).toEqual(before);
  });

  it("still frames when the detector is unavailable (heuristic fallback)", async () => {
    const fx = await fixture();
    const shot: Record<string, unknown> = { panel: "p0001_1.jpg", box: { ...fx.pg.box }, weight: 2 };
    const stats = await frameShots([shot], { panels: [fx.pg] }, fx.panels, path.join(fx.dir, "c3"), {
      mode: "window",
      detect: async (imgs) => Object.fromEntries(imgs.map((p) => [p, null])),
    });
    expect(stats.cropped).toBe(1);
    expect(stats.bubbles).toEqual({ heuristic: 1 });
    expect((shot.crop as number[])[1]).toBeGreaterThanOrEqual(450);

    const shot2: Record<string, unknown> = { panel: "p0001_1.jpg", box: { ...fx.pg.box }, weight: 2 };
    const stats2 = await frameShots([shot2], { panels: [fx.pg] }, fx.panels, path.join(fx.dir, "c4"), {
      mode: "window",
      detect: async () => {
        throw new Error("boom");
      },
    });
    expect(stats2.cropped).toBe(1);
  });

  it("extends the window across a seam into a verified continuation panel", async () => {
    const dir = makeTemp("seam");
    const panels = path.join(dir, "panels");
    fs.mkdirSync(panels);
    const W = 400;
    const grad = (h: number) => {
      const img = fillRgb(W, h, [0, 0, 0]);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < W; x++) img.data.set([Math.floor(50 + (100 * x) / (W - 1)), 45, 70], (y * W + x) * 3);
      return img;
    };
    await writeJpeg(path.join(panels, "p0001_1.jpg"), grad(800));
    await writeJpeg(path.join(panels, "p0003_1.jpg"), grad(300));
    fs.writeFileSync(
      path.join(panels, "manifest.json"),
      JSON.stringify([
        { panel: "ch1/p0001_1.jpg", page: 1, page_span: [1, 2], idx: 1 },
        { panel: "ch1/p0003_1.jpg", page: 3, idx: 1 },
      ]),
    );
    const pg = { id: "p0001_1", art: 0.8, box: { x0: 0.1, y0: 0.75, x1: 0.9, y1: 1 } };
    const next = {
      id: "p0003_1",
      art: 1,
      overlay: [],
      world: [],
      promo_page: false,
      box: { x0: 0, y0: 0, x1: 1, y1: 0.5 },
    };
    const shot: Record<string, unknown> = { panel: "p0001_1.jpg", box: { ...pg.box }, weight: 2 };
    const stats = await frameShots([shot], { panels: [pg, next] }, panels, path.join(dir, "crops"), {
      mode: "window",
      detect: async (imgs) => Object.fromEntries(imgs.map((p) => [p, [] as BubbleBox[]])),
    });
    expect(stats.continued).toBe(1);
    expect(shot.render_sources).toEqual(["p0001_1", "p0003_1"]);
    const crop = shot.crop as number[];
    expect(crop[3]).toBeGreaterThan(800); // window crosses into the next panel
    expect(crop[1]).toBeLessThanOrEqual(600);
  });

  it("legacy fit mode is still selectable", async () => {
    const fx = await fixture();
    const shot: Record<string, unknown> = { panel: "p0001_1.jpg", box: { x0: 0.25, y0: 0.3, x1: 0.75, y1: 0.57 } };
    const stats = await frameShots([shot], { panels: [fx.pg] }, fx.panels, path.join(fx.dir, "fit"), { mode: "fit" });
    expect(stats.cropped).toBe(1);
    expect(stats.bubbles).toEqual({});
    // cropWindow: box padded by min(12% of its height, 6% of width) = 36 px.
    const crop = shot.crop as number[];
    expect(crop[1]).toBe(900 - 36);
    expect(crop[3]).toBe(1710 + 36);
  });
});

describe("pacing floor", () => {
  it("MIN_PANEL_S is 1.5 and a short multi-panel line keeps the heaviest panels", async () => {
    expect(MIN_PANEL_S).toBe(1.5);
    const dir = makeTemp("pace");
    const panels = path.join(dir, "panels");
    fs.mkdirSync(panels);
    fs.writeFileSync(path.join(panels, "manifest.json"), "[]");
    const ids = ["p0001_1", "p0001_2", "p0001_3", "p0001_4"];
    for (const id of ids) await writeJpeg(path.join(panels, `${id}.jpg`), fillRgb(8, 8, [40, 40, 40]));
    const weights = [1, 3, 1, 3];
    const obs = {
      panels: ids.map((id, i) => ({
        id,
        page: 1,
        idx: i + 1,
        art: 0.9,
        overlay: [],
        world: [],
        bubble_at: "none",
        weight: weights[i],
      })),
    };
    // 3.2 s for four panels: 0.8 s each is under the floor, so keep 2 (3.2 // 1.5).
    const shots = buildShots([["Line.", ids]], [[0, 3.2]], obs, panels, null, false);
    expect(shots.map((s) => s.panel)).toEqual(["p0001_2.jpg", "p0001_4.jpg"]);
    for (const s of shots) expect(s.end_s - s.start_s).toBeGreaterThanOrEqual(1.5);
    expect(shots[0]!.start_s).toBe(0);
    expect(shots[shots.length - 1]!.end_s).toBe(3.2);
    expect(shots[0]!.end_s).toBe(shots[1]!.start_s);

    // 4.5 s for three panels: 1.5 s each, all kept.
    const three = buildShots([["Line.", ids.slice(0, 3)]], [[0, 4.5]], obs, panels, null, false);
    expect(three).toHaveLength(3);
  });
});
