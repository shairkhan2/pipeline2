/**
 * T3.4 Phase 3 reader / fact-check / lane-client tests.
 *
 * Ports the offline guarantees from pipeline/tests/test_model_lanes.py and
 * exercises the reader/scout/fact-check surface that tools/test_reader_batch.py
 * only smokes live (12-panel batch, max_tokens=8000). This file stays offline:
 * fetch and sleep are stubbed, and every write lands under /tmp/opencode.
 *
 * /home/shair/manhwa-pipeline is read-only. The 10-chapter fact-check parity
 * run compares this port to pipeline/fact_check.py on kill-the-hero ch1-ch10.
 * readChapter cache-hit and batch re-assembly run on a scratch copy of ch1.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  getDefaultConfig,
  LANE_CONFIG_FILENAME,
  putLanesState,
} from "../src/config/laneConfig.js";
import { briefHash, pyJsonDumps } from "../src/contracts/hashes.js";
import {
  AllLanesFailed,
  FilterBlocked,
  LANES,
  MODEL,
  VISION_LANES,
  WRITER_LANES,
  _activeCounts,
  _activeLanes,
  _lane,
  _laneSemaphore,
  _readSse,
  _resetSnapshotForTests,
  _setFetchForTests,
  _setSleepForTests,
  call,
  imgB64,
  laneSnapshotStatus,
  pageBlocks,
  parseJson,
  parse_json,
  type Lane,
} from "../src/llm/client.js";
import {
  attitudeTail,
  attitudeTails,
  check,
  cmpCodePoints,
  connectives,
  entrySignature,
  exitSignature,
  mindReadFrames,
  personaCheck,
  stripEmotion,
  structureSignature,
} from "../src/stages/factCheck.js";
import {
  CAPTION_VERSION,
  LEDGER_KEEP,
  _apiCallCount,
  _resetApiCalls,
  _save,
  _setCallForTests,
  applyPromoMeta,
  batchDir,
  castBlock,
  enforceAliasUniqueness,
  idAudit,
  mergeBible,
  normBox,
  normPromoBbox,
  readChapter,
  setReaderDeps,
  type ChapterObs,
} from "../src/stages/reader.js";
import {
  _chapterBlock,
  _obs,
  _panelCandidates,
  contextDigest,
  scout,
} from "../src/stages/scout.js";
import { _reset as resetTelemetry } from "../src/telemetry/telemetry.js";

const SERIES = "/home/shair/manhwa-pipeline/series/kill-the-hero";
const REAL_OUT = path.join(SERIES, "out");
const REAL_CH1 = path.join(SERIES, "ch1");

const tmpRoots: string[] = [];
const origVision = [...VISION_LANES];
const origWriter = [...WRITER_LANES];

let envRestore: () => void = () => {};
let logSpy: ReturnType<typeof vi.spyOn>;

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

function stubProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function restoreLanes(): void {
  VISION_LANES.splice(0, VISION_LANES.length, ...origVision);
  WRITER_LANES.splice(0, WRITER_LANES.length, ...origWriter);
}

function laneId(lane: Lane): string {
  return `${lane.name}:${lane.model}`;
}

function useVision(lanes: Lane[]): void {
  VISION_LANES.splice(0, VISION_LANES.length, ...lanes);
  _resetSnapshotForTests();
}

function testLane(name: string, extra: Partial<Lane> = {}): Lane {
  return _lane("openai", name, `${name}-model`, {
    base: `http://lane.test/${name}`,
    key_env: null,
    ...extra,
  });
}

function okBody(content = "ok"): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: 3 },
  });
}

function http(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

beforeEach(() => {
  const root = makeTemp("p3");
  envRestore = stubProcessEnv({
    MANHWA_LANE_CONFIG: undefined,
    MANHWA_LANE_CONFIG_DIR: path.join(root, "missing-config"),
    MANHWA_LANE_CONFIG_SNAPSHOT: undefined,
    PIPELINE_LOG: path.join(root, "pipeline.log"),
    PIPELINE_STATUS_DIR: path.join(root, "status"),
    PIPELINE_ENV: path.join(root, "no-such.env"),
  });
  restoreLanes();
  _resetSnapshotForTests();
  _resetApiCalls();
  _setCallForTests(null);
  setReaderDeps(null);
  resetTelemetry();
  _setSleepForTests(async () => {});
  _setFetchForTests(async () => {
    throw new Error("unexpected network");
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  envRestore();
  restoreLanes();
  _setFetchForTests(null);
  _setSleepForTests(null);
  _setCallForTests(null);
  setReaderDeps(null);
  _resetSnapshotForTests();
  vi.restoreAllMocks();
});

describe("llm/client parseJson", () => {
  it("parses fenced json, strips think blocks, and keeps nested objects and arrays", () => {
    expect(parseJson('  {"a":1}  ')).toEqual({ a: 1 });
    expect(parseJson("```json\n{\"keep\":[1,{\"a\":2}]}\n```")).toEqual({ keep: [1, { a: 2 }] });
    expect(parseJson("```\n[1,[2,3]]\n```")).toEqual([1, [2, 3]]);

    const thought = "<THINK>{\"ignore\":true,\"nest\":[1]}</think>\n```json\n{\"keep\":[1,{\"a\":2}]}\n```";
    expect(parseJson(thought)).toEqual({ keep: [1, { a: 2 }] });
    expect(parse_json).toBe(parseJson);

    expect(parseJson('sure {"a":{"b":[1,2,{"c":3}]}} thanks')).toEqual({
      a: { b: [1, 2, { c: 3 }] },
    });
    expect(parseJson('prefix [{"a":1,"b":[{"c":2}]}] suffix')).toEqual([
      { a: 1, b: [{ c: 2 }] },
    ]);
  });

  it("salvages multiple page objects and rejects text with no json", () => {
    expect(parseJson('noise {"id":"p1","n":1} {"id":"p2","nest":[1,{"a":2}]} tail')).toEqual({
      pages: [
        { id: "p1", n: 1 },
        { id: "p2", nest: [1, { a: 2 }] },
      ],
      characters: [],
      gags: [],
      events: [],
    });
    expect(() => parseJson("no braces here")).toThrow("unparseable JSON");
  });
});

describe("llm/client lanes", () => {
  it("uses the hardcoded chains when no persisted config exists", () => {
    const cfg = process.env.MANHWA_LANE_CONFIG_DIR!;
    expect(fs.existsSync(cfg)).toBe(false);
    expect(_activeLanes("vision")).toBe(VISION_LANES);
    expect(_activeLanes("writer")).toBe(WRITER_LANES);
    expect(fs.existsSync(cfg)).toBe(false);

    const snap = laneSnapshotStatus();
    expect(snap.source).toBe("defaults");
    expect(snap.revision).toBe(0);
    expect(snap.configError).toBeNull();
    expect(snap.roles.vision).toEqual(VISION_LANES.map(laneId));
    expect(snap.roles.writer).toEqual(WRITER_LANES.map(laneId));
    expect(MODEL).toBe(WRITER_LANES[0]!.model);
    expect(LANES.text).toBe(LANES.writer);
    expect(LANES.writer).toBe(_activeLanes("writer"));
  });

  it("drives order, enablement, and concurrency from a persisted snapshot", () => {
    const cfgDir = makeTemp("lanes-persist");
    process.env.MANHWA_LANE_CONFIG_DIR = cfgDir;
    const defaults = getDefaultConfig();
    putLanesState({
      revision: 0,
      render: defaults.render,
      models: {
        vision: [
          { id: "agy:gemini-3.8-flash-high", enabled: true, concurrency: 3 },
          { id: "workbuddy:deepseek-v4.1-flash", enabled: true, concurrency: 2 },
        ],
        writer: [
          { id: "agy:gemini-3.7-flash-medium", enabled: true, concurrency: 1 },
          { id: "workbuddy:deepseek-v4.1-flash", enabled: true, concurrency: 4 },
        ],
      },
    }, "test");
    _resetSnapshotForTests();

    const vision = _activeLanes("vision");
    const writer = _activeLanes("writer");
    expect(vision.map(laneId)).toEqual([
      "agy:gemini-3.8-flash-high",
      "workbuddy:deepseek-v4.1-flash",
    ]);
    expect(vision.map((lane) => lane.concurrency)).toEqual([3, 2]);
    expect(writer.map(laneId)).toEqual([
      "agy:gemini-3.7-flash-medium",
      "workbuddy:deepseek-v4.1-flash",
    ]);
    expect(writer.map((lane) => lane.concurrency)).toEqual([1, 4]);
    const high = vision[0]!;
    expect(high.thinking).toBeNull();
    expect(high.stream).toBe(false);
    const wb = writer.find((lane) => lane.name === "workbuddy")!;
    expect(wb.thinking).toBe(false);
    expect(wb.stream).toBe(true);
    expect(laneSnapshotStatus().source).toBe("persisted");
    expect(_laneSemaphore("vision", high).limit).toBe(3);
  });

  it("resolves the snapshot once and ignores a later config write", () => {
    const cfgDir = makeTemp("lanes-freeze");
    process.env.MANHWA_LANE_CONFIG_DIR = cfgDir;
    const defaults = getDefaultConfig();
    const first = putLanesState({
      revision: 0,
      render: defaults.render,
      models: {
        vision: [{ id: "agy:gemini-3.8-flash-low", enabled: true, concurrency: 1 }],
        writer: [{ id: "workbuddy:deepseek-v4.1-flash", enabled: true, concurrency: 1 }],
      },
    }, "test");
    _resetSnapshotForTests();
    expect(_activeLanes("vision").map(laneId)).toEqual(["agy:gemini-3.8-flash-low"]);

    putLanesState({
      revision: first.revision,
      render: defaults.render,
      models: {
        vision: [{ id: "opencode:mimo-v2.5-free", enabled: true, concurrency: 1 }],
        writer: [{ id: "workbuddy:deepseek-v4.1-flash", enabled: true, concurrency: 1 }],
      },
    }, "test");
    expect(_activeLanes("vision").map(laneId)).toEqual(["agy:gemini-3.8-flash-low"]);
    expect(laneSnapshotStatus().source).toBe("persisted");

    _resetSnapshotForTests();
    expect(_activeLanes("vision").map(laneId)).toEqual(["opencode:mimo-v2.5-free"]);
  });

  it("forces the legacy chains when the snapshot env switch is off", () => {
    const cfgDir = makeTemp("lanes-off");
    process.env.MANHWA_LANE_CONFIG_DIR = cfgDir;
    const defaults = getDefaultConfig();
    putLanesState({
      revision: 0,
      render: defaults.render,
      models: {
        vision: [{ id: "agy:gemini-3.8-flash-high", enabled: true, concurrency: 2 }],
        writer: [{ id: "workbuddy:deepseek-v4.1-flash", enabled: true, concurrency: 1 }],
      },
    }, "test");
    process.env.MANHWA_LANE_CONFIG_SNAPSHOT = "0";
    _resetSnapshotForTests();
    expect(_activeLanes("vision")).toBe(VISION_LANES);
    expect(_activeLanes("writer")).toBe(WRITER_LANES);
    expect(laneSnapshotStatus().source).toBe("defaults");
  });

  it("falls back to defaults when the persisted file is not json", () => {
    const cfgDir = makeTemp("lanes-bad");
    process.env.MANHWA_LANE_CONFIG_DIR = cfgDir;
    fs.writeFileSync(path.join(cfgDir, LANE_CONFIG_FILENAME), "{not json");
    _resetSnapshotForTests();
    expect(_activeLanes("writer").map(laneId)).toEqual(WRITER_LANES.map(laneId));
    const snap = laneSnapshotStatus();
    expect(snap.source).not.toBe("persisted");
    expect(snap.configError).toBeTruthy();
  });
});

describe("llm/client semaphore", () => {
  it("defaults a lane to one slot and rejects an extra release", () => {
    const lane = testLane("serial");
    const sem = _laneSemaphore("writer", lane);
    expect(sem.limit).toBe(1);
    expect(sem._value).toBe(1);
    expect(() => sem.release()).toThrow(/released too many times/);

    const zero = testLane("zero");
    zero.concurrency = 0;
    expect(_laneSemaphore("vision", zero).limit).toBe(1);
  });

  it("bounds concurrent calls to the lane concurrency", async () => {
    const lane = testLane("slow");
    lane.concurrency = 2;
    useVision([lane]);
    let active = 0;
    let peak = 0;
    _setFetchForTests(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return http(200, okBody());
    });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        call([{ role: "user", content: "x" }], { lane: "vision", retries: 1 })),
    );
    expect(peak).toBe(2);
    const key = `vision:${lane.name}:${lane.model}`;
    expect(_activeCounts.get(key)).toBe(0);
  });
});

describe("llm/client SSE and retry policy", () => {
  it("assembles SSE content, reasoning, and usage, and rejects a non-SSE 200", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo","reasoning_content":"think"}}],"usage":{"total_tokens":7}}',
      "data: [DONE]",
      'data: {"choices":[{"delta":{"content":"nope"}}]}',
    ].join("\n");
    const out = _readSse(raw);
    expect(out.choices[0]!.message.content).toBe("hello");
    expect(out.choices[0]!.message.reasoning_content).toBe("think");
    expect(out.usage?.total_tokens).toBe(7);

    const crlf = 'data: {"choices":[{"delta":{"content":"a"}}]}\r\ndata: [DONE]\r\n';
    expect(_readSse(crlf).choices[0]!.message.content).toBe("a");
    expect(() => _readSse('{"error":"nope"}')).toThrow(/non-SSE 200/);
    expect(() => _readSse("not json")).toThrow(/non-SSE 200/);
    expect(() => _readSse('data: {"error":{"msg":"bad"}}')).toThrow(/stream error/);
  });

  it("parses a streaming lane body through call()", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo","reasoning_content":"x"}}],"usage":{"total_tokens":4}}',
      "data: [DONE]",
    ].join("\n");
    const bodies: string[] = [];
    useVision([testLane("sse", { stream: true })]);
    _setFetchForTests(async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(sse, { status: 200 });
    });
    const out = await call([{ role: "user", content: "x" }], { lane: "vision", retries: 1 });
    expect(out.choices[0]!.message.content).toBe("hello");
    expect(out.choices[0]!.message.reasoning_content).toBe("x");
    const posted = JSON.parse(bodies[0]!) as { stream?: boolean; messages: Array<{ role: string }> };
    expect(posted.stream).toBe(true);
    expect(posted.messages[0]!.role).toBe("system");
  });

  it("retries 429 and 5xx on the same lane, then accepts a later 200", async () => {
    const sleeps: number[] = [];
    _setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    for (const status of [429, 503]) {
      sleeps.length = 0;
      let n = 0;
      const urls: string[] = [];
      useVision([testLane("retry"), testLane("next")]);
      _setFetchForTests(async (input) => {
        const url = String(input);
        urls.push(url);
        n += 1;
        if (url.includes("/retry/") && n < 3) return http(status, "busy");
        return http(200, okBody("later"));
      });
      const out = await call([{ role: "user", content: "x" }], { lane: "vision", retries: 4 });
      expect(out.choices[0]!.message.content).toBe("later");
      expect(urls.every((url) => url.includes("/retry/"))).toBe(true);
      expect(urls).toHaveLength(3);
      expect(sleeps.length).toBe(2);
    }
  });

  it("retries an empty 200 and skips 401 and 403 without sleeping", async () => {
    const sleeps: number[] = [];
    _setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    let n = 0;
    useVision([testLane("empty")]);
    _setFetchForTests(async () => {
      n += 1;
      if (n === 1) return http(200, okBody("   "));
      return http(200, okBody("filled"));
    });
    const filled = await call([{ role: "user", content: "x" }], { lane: "vision", retries: 3 });
    expect(filled.choices[0]!.message.content).toBe("filled");
    expect(n).toBe(2);
    expect(sleeps).toHaveLength(1);

    for (const status of [401, 403]) {
      sleeps.length = 0;
      const urls: string[] = [];
      useVision([testLane("denied"), testLane("ok")]);
      _setFetchForTests(async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/denied/")) return http(status, "no");
        return http(200, okBody("from-next"));
      });
      const out = await call([{ role: "user", content: "x" }], { lane: "vision", retries: 4 });
      expect(out.choices[0]!.message.content).toBe("from-next");
      expect(urls.filter((url) => url.includes("/denied/"))).toHaveLength(1);
      expect(sleeps).toHaveLength(0);
    }
  });

  it.each([
    [422, "nope"],
    [400, "data_inspection_failed"],
    [400, "Inappropriate content"],
    [403, "moderation blocked"],
    [500, "content_policy"],
  ])("fail-fast FilterBlocked on %s %s and does not try the next lane", async (status, body) => {
    const urls: string[] = [];
    const sleeps: number[] = [];
    _setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    useVision([testLane("blocked"), testLane("ok")]);
    _setFetchForTests(async (input) => {
      urls.push(String(input));
      return http(status, body);
    });
    await expect(call([{ role: "user", content: "x" }], { lane: "vision", retries: 4 }))
      .rejects.toBeInstanceOf(FilterBlocked);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/blocked/");
    expect(sleeps).toHaveLength(0);
  });

  it("raises AllLanesFailed when every lane skips", async () => {
    useVision([testLane("a"), testLane("b")]);
    _setFetchForTests(async () => http(401, "no"));
    await expect(call([{ role: "user", content: "x" }], { lane: "vision", retries: 2 }))
      .rejects.toBeInstanceOf(AllLanesFailed);
  });
});

describe("llm/client imgB64", () => {
  it("resizes only when height exceeds maxH and returns a jpeg", async () => {
    const dir = makeTemp("img");
    const tall = path.join(dir, "tall.png");
    const small = path.join(dir, "small.png");
    await sharp({
      create: { width: 100, height: 1001, channels: 3, background: { r: 180, g: 20, b: 20 } },
    }).png().toFile(tall);
    await sharp({
      create: { width: 80, height: 100, channels: 3, background: { r: 20, g: 80, b: 180 } },
    }).png().toFile(small);

    const tallB64 = await imgB64(tall, 500, 80);
    const tallMeta = await sharp(Buffer.from(tallB64, "base64")).metadata();
    expect(tallMeta.format).toBe("jpeg");
    expect(tallMeta.height).toBe(500);
    expect(tallMeta.width).toBe(Math.max(1, Math.trunc((100 * 500) / 1001)));

    const smallB64 = await imgB64(small);
    const smallMeta = await sharp(Buffer.from(smallB64, "base64")).metadata();
    expect(smallMeta.format).toBe("jpeg");
    expect(smallMeta.width).toBe(80);
    expect(smallMeta.height).toBe(100);

    const blocks = await pageBlocks([small], 1400);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});

describe("factCheck", () => {
  it("strips known emotion tags and reports unknown ones", () => {
    const stripped = stripEmotion("He [sighs] left [whispers] and [deadpan] sat. [not a tag] [OK]");
    expect(stripped.bad).toEqual(["whispers", "not a tag"]);
    expect(stripped.text).not.toContain("[sighs]");
    expect(stripped.text).not.toContain("[deadpan]");
    expect(stripped.text).toContain("[whispers]");
    expect(stripped.text).toContain("[OK]");
  });

  it("counts connectives, including openers, and ignores headers", () => {
    const txt = [
      "# header",
      "",
      "So he ran because the door shut.",
      "He waited until dawn, which is why he lived.",
      "A plain line.",
      "@p0001_1 so what",
    ].join("\n");
    expect(connectives(txt)).toEqual({
      nLines: 4,
      counts: { because: 1, so: 1, but: 0, until: 1, "which is why": 0 },
      withAny: 3,
      openAny: 2,
    });
  });

  it("classifies attitude tails and mind-read frames, including exemptions", () => {
    expect(attitudeTail("He walks out, vowing he will never return.")?.[0]).toBe("rider");
    expect(attitudeTail("She is determined to keep the gate.")?.[0]).toBe("determined");
    expect(attitudeTail("He swears to protect the village.")?.[0]).toBe("vow");
    expect(attitudeTail("He decides that she will live.")?.[0]).toBe("decision");
    expect(attitudeTail("He decides that she was already gone.")).toBeNull();
    expect(attitudeTail("He keeps leaving her screaming in the hall.")?.[0]).toBe("state-rider");
    expect(attitudeTail("No more running from the debt.")?.[0]).toBe("nomore");
    expect(attitudeTail("He'll finish the job.")?.[0]).toBe("bare-vow");

    expect(mindReadFrames("It hits him that the door was locked.")).toBe("It hits him");
    expect(mindReadFrames("She said it hits him, but he ignored her.")).toBeNull();
    expect(mindReadFrames("He looks like he finally gets it.")).toBeNull();
    expect(mindReadFrames("He realizes that the sword is fake.")).toBe("realizes that ");

    const report = attitudeTails([
      "He walks out, vowing he will never return.",
      "It hits him that the door was locked.",
      "A plain step with no tail.",
    ].join("\n"));
    expect(report.nSteps).toBe(3);
    expect(report.tail).toBe(1);
    expect(report.rider).toBe(1);
    expect(report.mind).toHaveLength(1);
    expect(report.mind[0]![0]).toBe("It hits him");
  });

  it("flags persona P1 and exempts quoted media words and reported critic frames", () => {
    expect(personaCheck("She said the moral is clear.\nThe moral is clear.")).toEqual([
      "OUTSIDE (critic-frame): The moral is clear.",
    ]);
    expect(personaCheck('"This chapter" is what the poster said.\nThis chapter opens on a roof.')).toEqual([
      "OUTSIDE (media-word): This chapter opens on a roof.",
    ]);
    const hits = personaCheck("We see the hero fall.\nThe camera cuts to the alley.\nShe said we see the hero fall.");
    expect(hits).toEqual([
      "OUTSIDE (we-as-viewer): We see the hero fall.",
      "OUTSIDE (edit-word): The camera cuts to the alley.",
      "OUTSIDE (we-as-viewer): She said we see the hero fall.",
    ]);
  });

  it("reports entry and exit structure signatures", () => {
    expect(entrySignature("")).toEqual({ meta: "EMPTY", conn: "EMPTY", cold: "EMPTY", mid: "EMPTY" });
    expect(exitSignature("")).toEqual({ thread: "EMPTY", small: "EMPTY", reframe: "EMPTY", words: 0 });
    expect(structureSignature(
      "So the gate stands open when the bell rings.\nHe still waits.",
      "Last time the gate stands open.\nHe walks away.",
    )).toEqual({
      entry: { meta: "n", conn: "Y", cold: "Y", mid: "Y" },
      exit: { thread: "Y", small: "n", reframe: "n", words: 3 },
    });
  });

  it("checks numbers, panel tags, DUB length, quoted exemption, and promo lint", () => {
    const transcript = [
      'p0001_1 | art:1.0 | A man stands in a hall. | OVERLAY: "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG TODAY" | WORLD: -',
      "p0002_1 | art:0.9 | A woman holds a sword near the door. | OVERLAY: - | WORLD: -",
    ].join("\n");
    const script = [
      "The man is twelve years old today @p0001_1.",
      'He said "the quick brown fox jumps over the lazy dog today" and left @p0001_1.',
      "The quick brown fox jumps over the lazy dog today and nobody stopped him @p0001_1.",
      "Missing panel @p0099_1 and again @p0099_1 and page tag @p0001.",
      "Visit asura scans for more @p0002_1.",
    ].join("\n");
    const promo = { matches: (s: string) => /asura scans/i.test(s) };
    const issues = check(script, transcript, { promo, characterNames: ["Woojin"] });

    expect(issues.some((issue) => issue.startsWith("DUB (10w overlay): The quick brown fox"))).toBe(true);
    expect(issues.some((issue) => issue.includes("He said"))).toBe(false);
    expect(issues.filter((issue) => issue === "bad tag @p0099_1")).toHaveLength(1);
    expect(issues).toContain("page-level tag @p0001 (writer slip: use @pXXXX_N)");
    expect(issues.some((issue) => issue.startsWith("PROMO in narration:"))).toBe(true);
    expect(issues.some((issue) => issue.includes("word-number 'twelve'"))).toBe(true);
    expect(issues).toEqual([...issues].sort(cmpCodePoints));
    expect(new Set(issues).size).toBe(issues.length);

    const noPromo = check(script, transcript);
    expect(noPromo.some((issue) => issue.startsWith("PROMO"))).toBe(false);

    expect(check(
      "He is 12 years old @p0001_1.",
      "p0001_1 | art:1.0 | a boy stands. | OVERLAY: - | WORLD: -",
    ).some((issue) => issue.includes("number 12"))).toBe(true);
    expect(check(
      "He is 12 years old @p0001_1.",
      "p0001_1 | art:1.0 | a boy of 12 years | OVERLAY: - | WORLD: -",
    ).some((issue) => issue.includes("number 12") || issue.startsWith("bad tag"))).toBe(false);

    expect(check("He waited thirty-three days.", "a long day passed")
      .some((issue) => issue.includes("word-number 'thirty-three'"))).toBe(true);
    expect(check("He lost ten thousand years.", "a long year")
      .some((issue) => issue.includes("phrase 'ten thousand'"))).toBe(true);

    expect(check("[whispers] Go.", "p0001_1 | art:1 | x | OVERLAY: - | WORLD: -")
      .some((issue) => issue.includes("UNKNOWN emotion tag [whispers]"))).toBe(true);
    expect(check("[sighs] Go.", "p0001_1 | art:1 | x | OVERLAY: - | WORLD: -")
      .some((issue) => issue.includes("UNKNOWN"))).toBe(false);
    expect(check("안녕하세요 세계입니다", "p0001_1 | art:1 | x | OVERLAY: - | WORLD: -")[0]).toBe(
      "NON-ENGLISH NARRATION (1/1 lines = 100% foreign script, e.g. '안녕하세요 세계입니다')",
    );

    const lore = check(
      "Dragon Slayer appeared in the hall.",
      "p0001_1 | art:1 | a man | OVERLAY: - | WORLD: -",
      "The Dragon Slayer fell.",
      ["Woojin"],
    );
    expect(lore.some((issue) => issue.startsWith("LORE IMPORT 'Dragon Slayer'"))).toBe(true);
    const known = check(
      "Woojin Kim appeared.",
      "p0001_1 | art:1 | a man | OVERLAY: - | WORLD: -",
      "Woojin Kim was here.",
      ["Woojin"],
    );
    expect(known.some((issue) => issue.startsWith("LORE IMPORT"))).toBe(false);
  });

  it("matches Python fact_check on 10 real kill-the-hero chapters", () => {
    const py = spawnSync("python3", ["-c", `
import contextlib, io, json, sys
from pathlib import Path
sys.path.insert(0, "/home/shair/manhwa-pipeline/pipeline")
import fact_check
root = Path("/home/shair/manhwa-pipeline/series/kill-the-hero/out")
bible = json.loads((root / "bible.json").read_text())
names = []
for c in bible["characters"].values():
    if c.get("name"):
        names.append(c["name"])
    for a in c.get("aliases") or []:
        names.append(a)
out = {}
sink = io.StringIO()
for n in range(1, 11):
    ch = f"ch{n}"
    script = (root / ch / "script_eleven.md").read_text()
    transcript = (root / ch / "transcript.md").read_text()
    prev = (root / f"ch{n-1}" / "script_eleven.md").read_text() if n > 1 else ""
    with contextlib.redirect_stdout(sink):
        issues = fact_check.check(
            script, transcript, window_txt=prev, character_names=names,
            promo=None, prev_script=prev)
        n_lines, counts, with_any, open_any = fact_check.connectives(script)
        persona = fact_check.persona_issues(script)
        entry = fact_check.entry_signature(script)
        exit_sig = fact_check.exit_signature(script)
        n_steps, att, mind, surf = fact_check.tail_reports(script)
    out[ch] = {
        "issues": issues,
        "connectives": {"nLines": n_lines, "counts": counts, "withAny": with_any, "openAny": open_any},
        "persona": persona,
        "entry": list(entry),
        "exit": list(exit_sig),
        "tails": {"nSteps": n_steps, "att": att, "mind": mind, "dash": surf[0], "rider": surf[1], "tail": surf[2]},
    }
print(json.dumps(out))
`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 45_000 });
    expect(py.status, py.stderr).toBe(0);
    const expected = JSON.parse(py.stdout) as Record<string, {
      issues: string[];
      connectives: { nLines: number; counts: Record<string, number>; withAny: number; openAny: number };
      persona: string[];
      entry: string[];
      exit: Array<string | number>;
      tails: { nSteps: number; att: [string, string][]; mind: [string, string][]; dash: number; rider: number; tail: number };
    }>;

    const bible = JSON.parse(fs.readFileSync(path.join(REAL_OUT, "bible.json"), "utf8")) as {
      characters: Record<string, { name?: string; aliases?: string[] }>;
    };
    const names: string[] = [];
    for (const c of Object.values(bible.characters)) {
      if (c.name) names.push(c.name);
      for (const alias of c.aliases ?? []) names.push(alias);
    }

    const chapters = Object.keys(expected);
    expect(chapters).toHaveLength(10);
    for (const ch of chapters) {
      const n = Number(ch.slice(2));
      const script = fs.readFileSync(path.join(REAL_OUT, ch, "script_eleven.md"), "utf8");
      const transcript = fs.readFileSync(path.join(REAL_OUT, ch, "transcript.md"), "utf8");
      const prev = n > 1
        ? fs.readFileSync(path.join(REAL_OUT, `ch${n - 1}`, "script_eleven.md"), "utf8")
        : "";
      expect(script.length).toBeGreaterThan(0);
      expect(transcript.length).toBeGreaterThan(0);
      const want = expected[ch]!;
      expect(check(script, transcript, prev, names, null, prev), ch).toEqual(want.issues);
      expect(connectives(script), ch).toEqual(want.connectives);
      expect(personaCheck(script), ch).toEqual(want.persona);
      const entry = entrySignature(script);
      expect([entry.meta, entry.conn, entry.cold, entry.mid], ch).toEqual(want.entry);
      const exit = exitSignature(script);
      expect([exit.thread, exit.small, exit.reframe, exit.words], ch).toEqual(want.exit);
      const tails = attitudeTails(script);
      expect({
        nSteps: tails.nSteps,
        att: tails.att,
        mind: tails.mind,
        dash: tails.dash,
        rider: tails.rider,
        tail: tails.tail,
      }, ch).toEqual(want.tails);
    }
  }, 60_000);
});

describe("reader and scout", () => {
  let scratchCh = "";

  beforeAll(() => {
    scratchCh = path.join(makeTemp("real-ch1"), "ch1");
    fs.cpSync(REAL_CH1, scratchCh, { recursive: true });
  });

  function realPanels(n: number): Array<Record<string, unknown>> {
    const blob = JSON.parse(fs.readFileSync(path.join(REAL_OUT, "obs_ch1.json"), "utf8")) as {
      data: { panels: Array<Record<string, unknown>> };
    };
    return blob.data.panels.slice(0, n).map((panel) => structuredClone(panel));
  }

  function manifestFor(ids: string[]): Array<Record<string, unknown>> {
    return ids.map((id, i) => ({
      panel: `ch1/${id}.jpg`,
      page: 1,
      idx: i + 1,
      w: 100,
      h: 200,
    }));
  }

  it("audits panel ids exactly, including trim and sorted extras", () => {
    expect(idAudit({ panels: [{ id: " p1 " }, { id: "p2" }] }, ["p1", "p2"])).toEqual([true, [], []]);
    expect(idAudit({ panels: [{ id: "p2" }, { id: "p9" }] }, ["p1", "p2"])).toEqual([false, ["p1"], ["p9"]]);
    expect(idAudit({ panels: [] }, ["p1"])).toEqual([false, ["p1"], []]);
  });

  it("normalizes interest boxes, rejects bad promo boxes, and drops bad promo meta", () => {
    expect(normBox([1.2, -0.2, 0.1, 0.8])).toEqual({ x0: 0.1, y0: 0, x1: 1, y1: 0.8 });
    expect(normBox({ x0: 0.2, y0: 0.9, x1: 0.1, y1: 0.3 })).toEqual({ x0: 0.1, y0: 0.3, x1: 0.2, y1: 0.9 });
    expect(normBox(["0.1", "0.2", "0.4", "0.5"])).toEqual({ x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.5 });
    expect(normBox([0, 0, 0, 1])).toBeNull();
    expect(normBox("no")).toBeNull();

    expect(normPromoBbox([0, 0, 1000, 500])).toEqual({ x0: 0, y0: 0, x1: 1000, y1: 500 });
    expect(normPromoBbox([10, 10, 5, 40])).toBeNull();
    expect(normPromoBbox([-1, 0, 10, 10])).toBeNull();
    expect(normPromoBbox([0, 0, 1001, 10])).toBeNull();

    const panel: Record<string, unknown> = {
      promo_page: "full",
      promo_regions: [
        { text: "ok", bbox: [1, 2, 3, 4] },
        { text: 3, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
        { text: "bad", bbox: [0, 0, 0, 10] },
        "junk",
      ],
    };
    applyPromoMeta(panel);
    expect(panel.promo_page).toBeUndefined();
    expect(panel.promo_regions).toEqual([
      { text: "ok", bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
      { text: "", bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    ]);
    const kept = { promo_page: false, promo_regions: null as unknown };
    applyPromoMeta(kept);
    expect(kept.promo_page).toBe(false);
  });

  it("builds a named-only cast block with visual_now and as-of status", () => {
    const bible = {
      characters: {
        unknown_blonde: {
          name: "UNKNOWN-blonde",
          visual: "hair",
          visual_now: "hair2",
          status: "runs",
          last_seen: "ch9",
        },
        woojin: {
          name: "Woojin",
          visual: "old look",
          visual_now: "scarred",
          status: "alive",
          last_seen: "ch4",
        },
        sejoon: { name: "Sejoon", visual: "gold", status: "", last_seen: "ch8" },
        nameless: { name: "  ", visual: "x", last_seen: "ch99" },
      },
    };
    const block = castBlock(bible, 12);
    expect(block.startsWith("KNOWN CAST (characters already introduced")).toBe(true);
    expect(block).toContain("  Sejoon: gold");
    expect(block).toContain("  Woojin: scarred | as of ch4: alive");
    expect(block).not.toContain("old look");
    expect(block).toContain("inventing an UNKNOWN- tag");
    expect(block).not.toContain("UNKNOWN-blonde");
    expect(block.indexOf("Sejoon")).toBeLessThan(block.indexOf("Woojin"));
    expect(castBlock(bible, 1)).toContain("Sejoon");
    expect(castBlock(bible, 1)).not.toContain("Woojin");
    expect(castBlock({ characters: {} })).toBe("");
  });

  it("merges a contested real name by evidence quality, not alias count", () => {
    const bible: Record<string, unknown> = {
      characters: {
        egostic: {
          name: "Egostic",
          aliases: ["Dain", "extra", "more"],
          visual: "black",
          first_seen: "ch3",
          last_seen: "ch3",
        },
        kim_dain: {
          name: "Kim Dain",
          aliases: ["Dain"],
          visual: "",
          first_seen: "ch3",
          last_seen: "ch9",
        },
      },
      links: [],
    };
    expect(enforceAliasUniqueness(bible, false)).toEqual([
      "MERGED Egostic -> Kim Dain (both claimed 'dain')",
    ]);
    const chars = bible.characters as Record<string, Record<string, unknown>>;
    expect(Object.keys(chars)).toEqual(["kim_dain"]);
    expect(chars.kim_dain!.aliases).toEqual(["Dain", "Egostic", "extra", "more"]);
    expect(chars.kim_dain!.visual).toBe("black");
    expect(chars.kim_dain!.first_seen).toBe("ch3");
    const links = bible.links as Array<Record<string, unknown>>;
    expect(links.some((link) => link.alias === "Egostic" && String(link.evidence).includes("I-27"))).toBe(true);
  });

  it("drops a contested unknown-* guess from the weaker owner", () => {
    const byCount: Record<string, unknown> = {
      characters: {
        shin_haru: {
          name: "Shin Haru",
          aliases: ["unknown-blonde hero", "real alias"],
          first_seen: "ch1",
          last_seen: "ch4",
        },
        stardust: {
          name: "Stardust",
          aliases: ["unknown-blonde hero"],
          first_seen: "ch8",
          last_seen: "ch8",
        },
      },
      links: [],
    };
    expect(enforceAliasUniqueness(byCount, false)).toEqual([
      "DROPPED guess 'unknown-blonde hero' from Stardust (also claimed by shin_haru)",
    ]);
    const counted = byCount.characters as Record<string, { aliases: string[] }>;
    expect(counted.shin_haru!.aliases).toContain("unknown-blonde hero");
    expect(counted.stardust!.aliases).toEqual([]);

    const byRank: Record<string, unknown> = {
      characters: {
        shin: {
          name: "Shin",
          aliases: ["unknown-x"],
          first_seen: "ch1",
          last_seen: "ch2",
        },
        star: {
          name: "Star",
          aliases: ["unknown-x"],
          first_seen: "ch8",
          last_seen: "ch9",
        },
      },
      links: [],
    };
    const notes = enforceAliasUniqueness(byRank, false);
    expect(notes[0]).toContain("DROPPED guess 'unknown-x' from Star");
    const ranked = byRank.characters as Record<string, { aliases: string[] }>;
    expect(ranked.shin!.aliases).toEqual(["unknown-x"]);
    expect(ranked.star!.aliases).toEqual([]);
  });

  it("hits judge_cache.json and keeps only the last 3 ledger chapters", async () => {
    expect(LEDGER_KEEP).toBe(3);
    const dir = makeTemp("bible");
    const biblePath = path.join(dir, "bible.json");
    const prior = {
      characters: {
        woojin: {
          name: "Woojin",
          aliases: [],
          visual: "old",
          visual_now: "old",
          role: "fighter",
          status: "alive",
          first_seen: "ch1",
          last_seen: "ch1",
        },
      },
      plot_ledger: [
        { ch: "ch1", events: ["a"] },
        { ch: "ch2", events: ["b"] },
        { ch: "ch3", events: ["c"] },
        { ch: "ch4", events: ["d"] },
      ],
      gags: [
        { ch: "ch1", why: "old" },
        { ch: "ch2", why: "b" },
        { ch: "ch4", why: "d" },
      ],
      links: [],
      covered: ["ch1", "ch2", "ch3", "ch4"],
    };
    fs.writeFileSync(biblePath, JSON.stringify(prior));
    const named = { woojin: "old", sejoon: "gold" };
    const sig = createHash("sha256")
      .update(pyJsonDumps([named, {}], { sortKeys: true }), "utf8")
      .digest("hex")
      .slice(0, 24);
    fs.writeFileSync(
      path.join(dir, "judge_cache.json"),
      JSON.stringify({ [sig]: { alias_groups: [], resolve: {}, notes: "cached" } }),
    );
    _setCallForTests(async () => {
      throw new Error("judge should not call");
    });
    _resetApiCalls();

    const bible = await mergeBible(biblePath, "ch5", {
      characters: [
        { name: "Sejoon", visual: "gold", what_they_do: "rules" },
        { name: "UNKNOWN-boy", visual: "x", what_they_do: "guess" },
        { name: "Woojin", visual: "scarred now", what_they_do: "hunts" },
      ],
      events: ["the turn"],
      gags: [{ panel: "p1", why: "joke" }],
    });
    expect(_apiCallCount()).toBe(0);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("judge: cache hit"))).toBe(true);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("UNKNOWN-*"))).toBe(true);

    const chars = bible.characters as Record<string, Record<string, unknown>>;
    expect(chars.unknown_boy).toBeUndefined();
    expect(chars.sejoon!.visual).toBe("gold");
    expect(chars.woojin!.visual).toBe("old");
    expect(chars.woojin!.visual_now).toBe("scarred now");
    expect(chars.woojin!.status).toBe("hunts");
    expect(chars.woojin!.last_seen).toBe("ch5");

    const ledger = bible.plot_ledger as Array<{ ch: string; events: unknown }>;
    expect(ledger.map((row) => row.ch)).toEqual(["ch3", "ch4", "ch5"]);
    expect(ledger[2]!.events).toEqual(["the turn"]);
    const gags = bible.gags as Array<{ ch: string }>;
    expect(gags.map((gag) => gag.ch).sort()).toEqual(["ch4", "ch5"]);
    expect(bible.covered).toEqual(["ch1", "ch2", "ch3", "ch4", "ch5"]);
    expect(fs.existsSync(biblePath)).toBe(true);
  });

  it("returns a fresh obs with 0 API calls and does not re-read batches", async () => {
    expect(fs.readdirSync(scratchCh).some((name) => name.endsWith(".webp"))).toBe(true);
    const outDir = makeTemp("cache-hit");
    const panels = realPanels(2);
    const ids = panels.map((panel) => String(panel.id));
    const manifest = manifestFor(ids);
    for (const [i, panel] of panels.entries()) {
      panel.page = 1;
      panel.idx = i + 1;
      panel.visual = `cached-obs-${panel.id}`;
    }
    _save(path.join(outDir, "obs_ch1.json"), {
      panels,
      characters: [],
      gags: [],
      events: [],
    });
    _save(path.join(batchDir(outDir, "ch1", CAPTION_VERSION), "b00.json"), {
      panels: ids.map((id) => ({ id, visual: "from-batch" })),
      characters: [],
      gags: [],
      events: ["should-not-win"],
    });
    _setCallForTests(async () => {
      throw new Error("cache hit called the model");
    });
    _resetApiCalls();

    const obs = await readChapter(
      scratchCh,
      outDir,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    expect(_apiCallCount()).toBe(0);
    expect(obs.panels.map((panel) => panel.visual)).toEqual(ids.map((id) => `cached-obs-${id}`));
    expect(obs.events).toEqual([]);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("cache hit:"))).toBe(true);
    expect(briefHash(CAPTION_VERSION)).toHaveLength(8);
  });

  it("re-assembles page/idx from cached batches with 0 API calls", async () => {
    const outDir = makeTemp("reassemble");
    const panels = realPanels(2);
    const ids = panels.map((panel) => String(panel.id));
    const manifest = manifestFor(ids);
    const stale: ChapterObs = {
      panels: panels.map((panel) => {
        const copy: Record<string, unknown> = { ...panel, visual: "stale-obs" };
        delete copy.page;
        delete copy.idx;
        return copy;
      }),
      characters: [],
      gags: [],
      events: [],
    };
    _save(path.join(outDir, "obs_ch1.json"), stale);
    const batchPanels = panels.map((panel, i) => {
      const copy: Record<string, unknown> = { ...panel, visual: `from-batch-${panel.id}` };
      delete copy.page;
      delete copy.idx;
      if (i === 0) {
        copy.box = [0.1, 0.2, 0.5, 0.8];
        delete copy.focus_x;
        copy.promo_page = "nope";
        copy.promo_regions = [
          { text: "ad", bbox: [1, 2, 30, 40] },
          { text: "bad", bbox: [0, 0, 0, 1] },
        ];
      }
      return copy;
    });
    _save(path.join(batchDir(outDir, "ch1", CAPTION_VERSION), "b00.json"), {
      panels: batchPanels,
      characters: [{ name: "Woojin", visual: "scar" }],
      gags: [],
      events: ["door opens"],
    });
    _setCallForTests(async () => {
      throw new Error("reassembly called the model");
    });
    _resetApiCalls();

    const obs = await readChapter(
      scratchCh,
      outDir,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    expect(_apiCallCount()).toBe(0);
    expect(logSpy.mock.calls.some((args) => String(args[0]).includes("0 API calls"))).toBe(true);
    expect(obs.panels.map((panel) => panel.visual)).toEqual(ids.map((id) => `from-batch-${id}`));
    expect(obs.panels.map((panel) => [panel.page, panel.idx])).toEqual([[1, 1], [1, 2]]);
    expect(obs.panels[0]!.box).toEqual({ x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.8 });
    expect(obs.panels[0]!.focus_x).toBe(0.3);
    expect(obs.panels[0]!.promo_page).toBeUndefined();
    expect(obs.panels[0]!.promo_regions).toEqual([
      { text: "ad", bbox: { x0: 1, y0: 2, x1: 30, y1: 40 } },
    ]);
    expect(obs.events).toEqual(["door opens"]);
    expect(obs.characters[0]).toMatchObject({ name: "Woojin" });

    _resetApiCalls();
    const again = await readChapter(
      scratchCh,
      outDir,
      false,
      false,
      null,
      CAPTION_VERSION,
      async () => manifest,
    );
    expect(_apiCallCount()).toBe(0);
    expect(again.panels[0]!.page).toBe(1);
    expect(again.panels[0]!.visual).toBe(`from-batch-${ids[0]}`);
  });

  it("digests chapters before the opening and skips UNKNOWN names", () => {
    const outDir = makeTemp("digest");
    fs.writeFileSync(path.join(outDir, "obs_ch1.json"), JSON.stringify({
      data: {
        characters: [
          { name: "Woojin", visual: "scar", what_they_do: "fights" },
          { name: "UNKNOWN-boy", visual: "x", what_they_do: "y" },
        ],
        events: ["the betrayal"],
      },
    }));
    fs.writeFileSync(path.join(outDir, "obs_ch2.json"), JSON.stringify({
      characters: [{ name: "Sejoon", visual: "gold", what_they_do: "rules" }],
      events: ["the guild"],
    }));
    const digest = contextDigest(outDir, "ch3");
    expect(digest.startsWith("STORY SO FAR")).toBe(true);
    expect(digest).toContain("=== ch1 ===");
    expect(digest).toContain("=== ch2 ===");
    expect(digest).toContain("Woojin: scar | fights");
    expect(digest).toContain("Sejoon: gold | rules");
    expect(digest).toContain("the betrayal");
    expect(digest).not.toContain("UNKNOWN-boy");
    expect(contextDigest(outDir, "ch1")).toBe("");
    expect(_obs(outDir, "ch1")?.events).toEqual(["the betrayal"]);
    expect(_obs(outDir, "ch2")?.events).toEqual(["the guild"]);
    expect(_obs(outDir, "ch9")).toBeNull();

    const scratch = makeTemp("real-obs");
    fs.copyFileSync(path.join(REAL_OUT, "obs_ch1.json"), path.join(scratch, "obs_ch1.json"));
    fs.copyFileSync(path.join(REAL_OUT, "obs_ch2.json"), path.join(scratch, "obs_ch2.json"));
    const real = contextDigest(scratch, "ch3");
    expect(real).toContain("=== ch1 ===");
    expect(real).toContain("=== ch2 ===");
    expect(real.length).toBeGreaterThan(200);
    const block = _chapterBlock(scratch, "ch1", _obs(scratch, "ch1")!);
    expect(block.startsWith("=== ch1 ===")).toBe(true);
    expect(block).not.toContain("UNKNOWN");
  });

  it("returns a saved opening without a model call and filters unshowable panels", async () => {
    const outDir = makeTemp("scout");
    const opening = { start_ch: "ch2", panel: "p0001_1", hook: "already written" };
    fs.writeFileSync(path.join(outDir, "opening.json"), JSON.stringify(opening));
    _setFetchForTests(async () => {
      throw new Error("scout cache hit called the network");
    });
    const got = await scout("/no/such/series", outDir);
    expect(got.start_ch).toBe("ch2");
    expect(got.hook).toBe("already written");

    const rows = _panelCandidates({
      panels: [
        { id: "p1", art: 0.1, visual: "black card", overlay: [], bubble_at: "none" },
        { id: "p2", art: 0.9, visual: "fight", overlay: ["ASURA SCANS"], bubble_at: "corner" },
        { id: "p3", art: 0.4, visual: "caption wall", overlay: ["x".repeat(60)], bubble_at: "corner" },
        { id: "p4", art: 0.95, visual: "hero stands", overlay: ["ok"], bubble_at: "corner" },
      ],
    }, { matches: (s) => String(s).includes("ASURA") });
    expect(rows.map((row) => row.split(" | ")[0])).toEqual(["p4"]);
  });
});
