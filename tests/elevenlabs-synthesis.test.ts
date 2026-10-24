/** ElevenLabs (direct API, key pool) narration wiring. The pool client is mocked; audio is real ffmpeg mp3. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failClass, failureNote } from "../src/domain/failure.js";
import * as tel from "../src/telemetry/telemetry.js";
import * as audio from "../src/stages/audio.js";
import * as timeline from "../src/stages/timeline.js";
import * as render from "../src/workers/renderlane.js";
import * as eleven from "../src/llm/elevenlabsTts.js";
import { engineScriptPath } from "../src/stages/localize.js";

const VOICE = "JBFqnCBsd6RMkjVDRZzb";
let root: string;

beforeEach(() => {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  root = fs.mkdtempSync("/tmp/opencode/elevenlabs-synth-");
  vi.stubEnv("PIPELINE_STATUS_DIR", path.join(root, "status"));
  vi.stubEnv("PIPELINE_LOG", path.join(root, "pipeline.log"));
  vi.stubEnv("MANHWA_LANE_CONFIG_DIR", path.join(root, "config"));
  vi.stubEnv("MANHWA_LANE_CONFIG", "");
  vi.stubEnv("MANHWA_LANE_CONFIG_SNAPSHOT", "");
  vi.stubEnv("MANHWA_OUT_DIR", path.join(root, "out"));
  tel._reset();
  render._resetHooksForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  tel._reset();
  render._resetHooksForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Tone with outer silence, so the trim step has something to remove. */
function paddedTone(): string {
  const dest = path.join(root, "tone.mp3");
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6",
    "-af", "adelay=500|500,apad=pad_dur=0.6", dest,
  ]);
  expect(r.status).toBe(0);
  return dest;
}

function probe(f: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" });
  return Number.parseFloat(r.stdout.trim());
}

const LINES = [["[whispers] First line.", []], ["Second line.", []]] as const;
const ENV = { ...process.env, MANHWA_TTS_RETRY_DELAYS_S: "0,0,0,0,0" };

function setup(meta: Record<string, unknown> = {}) {
  const fixture = paddedTone();
  const synth = vi.spyOn(eleven, "synthesizeElevenLabsToFile");
  let keyN = 0;
  synth.mockImplementation(async (opts) => {
    fs.copyFileSync(fixture, opts.destPath);
    return { keyId: `key-${keyN++}` };
  });
  tel.start("fixture", ["ch1"], true);
  tel.bind({ chapter: "ch1" });
  const dir = path.join(root, "lines");
  const invoke = (m: Record<string, unknown> = meta) =>
    audio.ttsLinesElevenlabs(LINES, dir, { voice_id: VOICE, ...m }, ENV);
  return { fixture, synth, invoke, dir };
}

describe("ttsLinesElevenlabs", () => {
  it("synthesizes, trims, and reuses the line cache with no new calls", async () => {
    const { fixture, synth, invoke, dir } = setup();
    const spans = await invoke();
    expect(spans).toHaveLength(2);
    expect(synth).toHaveBeenCalledTimes(2);
    const raw = probe(fixture);
    const trimmed = probe(path.join(dir, "line_000.mp3"));
    expect(trimmed).toBeLessThan(raw - 0.3);
    expect(spans[0]![1] - spans[0]![0]).toBeCloseTo(trimmed, 2);
    const proof = fs.readFileSync(path.join(dir, "line_000.txt"), "utf8");
    expect(proof).toContain('"model": "eleven_v4"');
    expect(proof).toContain('"engine": "elevenlabs"');
    expect(proof).not.toMatch(/key/i);
    expect(synth.mock.calls[0]![0]).toMatchObject({ voiceId: VOICE, modelId: "eleven_v4", speed: 1 });
    expect(await invoke()).toEqual(spans);
    expect(synth).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(dir).some((n) => n.includes(".tmp."))).toBe(false);
  });

  it("re-synthesizes on a model change; a new keyId does not re-bill", async () => {
    const { synth, invoke } = setup();
    await invoke();
    // setup's mock returns a different keyId every call; the cache ignores it.
    await invoke();
    expect(synth).toHaveBeenCalledTimes(2);
    await invoke({ model_id: "eleven_multilingual_v2" });
    expect(synth).toHaveBeenCalledTimes(4);
    expect(synth.mock.calls[3]![0].modelId).toBe("eleven_multilingual_v2");
  });

  it("keeps tags for eleven_v4 and strips them for eleven_multilingual_v2", async () => {
    const { synth, invoke } = setup();
    await invoke({ model_id: "eleven_v4" });
    expect(synth.mock.calls[0]![0].text).toBe("[whispers] First line.");
    await invoke({ model_id: "eleven_multilingual_v2" });
    expect(synth.mock.calls[2]![0].text).toBe("First line.");
  });

  it("passes meta.speed through to the client", async () => {
    const { synth, invoke } = setup();
    await invoke({ speed: 1.1 });
    expect(synth.mock.calls[0]![0].speed).toBe(1.1);
  });

  it("clamps speed to 0.7-1.2; speeds that clamp alike share one cache entry", async () => {
    const { synth, invoke, dir } = setup();
    await invoke({ speed: 1.5 });
    expect(synth).toHaveBeenCalledTimes(2);
    expect(synth.mock.calls[0]![0].speed).toBe(1.2);
    expect(fs.readFileSync(path.join(dir, "line_000.txt"), "utf8")).toContain('"speed": 1.2');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("speed 1.5 clamped to 1.2"));
    await invoke({ speed: 1.3 });
    expect(synth).toHaveBeenCalledTimes(2);
  });

  it("retries a retryable 429", async () => {
    const { fixture, synth, invoke } = setup();
    let n = 0;
    synth.mockImplementation(async (opts) => {
      if (n++ === 0) {
        throw new eleven.ElevenLabsRequestError(
          "ElevenLabs HTTP 429 concurrent_limit_exceeded: busy", 429, "concurrent_limit_exceeded", true,
        );
      }
      fs.copyFileSync(fixture, opts.destPath);
      return { keyId: "k" };
    });
    await invoke();
    expect(synth).toHaveBeenCalledTimes(3);
    expect(tel._data()!.events.some((e) => e.message === "ch1 · audio · retrying")).toBe(true);
  });

  it("never retries a non-retryable request error", async () => {
    const { synth, invoke } = setup();
    synth.mockRejectedValue(new eleven.ElevenLabsRequestError(
      "ElevenLabs HTTP 400 text_too_long: too long", 400, "text_too_long", false,
    ));
    await expect(invoke()).rejects.toThrow("elevenlabs tts line 0 failed: ElevenLabs HTTP 400");
    expect(synth).toHaveBeenCalledTimes(1);
  });

  it("does not retry pool exhaustion and keeps it permanent", async () => {
    const { synth, invoke, dir } = setup();
    const reasons = [{ keyId: "a", hint: "…ecb6", reason: "key …ecb6 (free): quota exhausted until 2026-11-23" }];
    synth.mockRejectedValue(new eleven.ElevenLabsPoolExhaustedError(
      "ElevenLabs key pool exhausted: key …ecb6 (free): quota exhausted until 2026-11-23", reasons,
    ));
    const err = await invoke().catch((e) => e);
    expect(err).toBeInstanceOf(eleven.ElevenLabsPoolExhaustedError);
    expect(err.reasons).toEqual(reasons);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(failClass(err)).toBe("permanent");
    expect(failureNote(err)).toBe("ElevenLabs keys exhausted");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("onPoolWait puts the waiting note on the audio stage", async () => {
    const { fixture, synth, invoke } = setup();
    const until = Date.now() + 60_000;
    synth.mockImplementation(async (opts) => {
      opts.onPoolWait?.({ untilMs: until, reasons: [{ keyId: "a", hint: "…a20d", reason: "quota" }] });
      expect(tel._data()!.chapters.ch1!.stages.audio).toMatchObject({
        state: "retrying",
        note: "ElevenLabs: every key is used up; waiting for a key",
        retryAt: until / 1000,
        attempt: 1,
        maxAttempts: 1,
      });
      fs.copyFileSync(fixture, opts.destPath);
      return { keyId: "k" };
    });
    await invoke();
    expect(synth).toHaveBeenCalled();
  });

  it("rejects a missing or malformed voice id", async () => {
    const { invoke } = setup();
    await expect(audio.ttsLinesElevenlabs(LINES, path.join(root, "x"), {}, ENV)).rejects.toThrow("voice_id is empty");
    await expect(invoke({ voice_id: "bad id!" })).rejects.toThrow("not an ElevenLabs voice id");
  });
});

describe("failure classification", () => {
  it.each([
    [new Error("elevenlabs tts line 3 failed: ElevenLabs key pool exhausted: key …ecb6: quota"), "permanent", "ElevenLabs keys exhausted"],
    [Object.assign(new Error("wrapped"), { name: "ElevenLabsPoolExhaustedError" }), "permanent", "ElevenLabs keys exhausted"],
    [new Error("elevenlabs tts line 0 failed: ElevenLabs HTTP 402 paid_plan_required: Free users"), "permanent", "HTTP 402 · payment required"],
    [new Error("elevenlabs tts line 0 failed: ElevenLabs HTTP 429 rate_limit_exceeded: slow"), "transient", "HTTP 429 · rate limited"],
  ])("%s", (e, cls, note) => {
    expect(failClass(e)).toBe(cls);
    expect(failureNote(e)).toBe(note);
  });
});

describe("engine allow-lists", () => {
  it("timeline accepts elevenlabs and requires script_eleven.md", async () => {
    const sdir = path.join(root, "series", "s1");
    const out = path.join(sdir, "out");
    fs.mkdirSync(path.join(out, "ch1"), { recursive: true });
    fs.writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ tts: { engine: "elevenlabs", voice_id: VOICE } }));
    fs.writeFileSync(path.join(out, "promo_block.json"), JSON.stringify({ version: 1, pages: [] }));
    fs.writeFileSync(path.join(out, "obs_ch1.json"), JSON.stringify({ panels: [] }));
    fs.writeFileSync(path.join(out, "ch1", "script.md"), "Line. @p0001_1\n");
    const err = await timeline.main(sdir, "ch1", path.join(out, "ch1", "script.md"), path.join(out, "obs_ch1.json"),
      path.join(out, "ch1", "video")).catch((e) => e);
    expect(String(err?.message ?? err)).toContain("engine=elevenlabs but");
    expect(String(err?.message ?? err)).toContain("script_eleven.md missing");
    fs.writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ tts: { engine: "nope", voice_id: VOICE } }));
    const bad = await timeline.main(sdir, "ch1", path.join(out, "ch1", "script.md"), path.join(out, "obs_ch1.json"),
      path.join(out, "ch1", "video")).catch((e) => e);
    expect(String(bad?.message ?? bad)).toContain("expected edge, eleven, elevenlabs");
  });

  it("localize reads script_eleven.md for an elevenlabs English series", () => {
    const out = path.join(root, "o");
    fs.mkdirSync(path.join(out, "ch1"), { recursive: true });
    fs.writeFileSync(path.join(out, "ch1", "script.md"), "x");
    fs.writeFileSync(path.join(out, "ch1", "script_eleven.md"), "y");
    expect(engineScriptPath(out, "ch1", "elevenlabs")).toBe(path.join(out, "ch1", "script_eleven.md"));
  });
});

describe("video lane", () => {
  it("a permanent pool failure fails only its chapter; the others render", async () => {
    const plan: render.RenderPlan = { source: "persisted", legacy: false, revision: 1, configError: null, override: null,
      unavailableGraceS: 5, lanes: [{ id: "local", order: 0, enabled: true, configured: true, slots: 1, effectiveSlots: 1,
        minSlots: 1, maxSlots: 1, costTier: "free" }] };
    render._hooks.renderPolicy = { ...render.renderPolicy,
      resolveRenderPlan: () => plan, resolve_render_plan: () => plan,
      laneAvailability: () => ({ local: [true, "ok"] }), lane_availability: () => ({ local: [true, "ok"] }) };
    render._hooks.lappy = { ...render.lappy, HOST: "", healthy: () => [false, "off"] };
    render._hooks.cloudlane = { ...render.cloudlane, NAME: "" };
    const sleeps: number[] = [];
    render._hooks.time = { ...render.time, sleep: async (n) => { sleeps.push(n); } };
    render._hooks.produce = vi.fn(async (_s: string, ch: string) => {
      if (ch === "ch1") {
        throw new eleven.ElevenLabsPoolExhaustedError("ElevenLabs key pool exhausted: key …ecb6 (free): quota", []);
      }
      return ["video.mp4", 5] as [string, number];
    });
    tel.start("fixture", ["ch1", "ch2", "ch3"], true);
    const q = new render.RenderQueue<string | null>();
    for (const ch of ["ch1", "ch2", "ch3", null]) q.put(ch);
    const results: Record<string, render.VideoResult> = {};
    await render.worker(root, path.join(root, "out"), q, results);
    await q.join();
    expect(results.ch1).toMatchObject({ status: "video-failed", class: "permanent", video_attempts: 1 });
    expect(results.ch1!.error).toContain("ElevenLabs key pool exhausted");
    expect(results.ch2).toMatchObject({ status: "video-ok" });
    expect(results.ch3).toMatchObject({ status: "video-ok" });
    expect(render._hooks.produce).toHaveBeenCalledTimes(3);
    expect(sleeps.filter((n) => n >= 120)).toEqual([]);
  });
});
