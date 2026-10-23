/** Offline healing contracts. All artifacts and status/log writes stay in private scratch. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failClass, failureNote, httpStatusOf, isRefusalText } from "../src/domain/failure.js";
import * as tel from "../src/telemetry/telemetry.js";
import * as render from "../src/workers/renderlane.js";
import * as run from "../src/cli/run.js";
import * as audio from "../src/stages/audio.js";
import * as vertex from "../src/llm/vertexTts.js";
import * as grok from "../src/llm/grokTts.js";
import * as llm from "../src/llm/client.js";

let root: string;
const originalWriter = [...llm.WRITER_LANES];
beforeEach(() => {
  root = fs.mkdtempSync("/tmp/opencode/self-heal-");
  vi.stubEnv("PIPELINE_STATUS_DIR", path.join(root, "status"));
  vi.stubEnv("PIPELINE_LOG", path.join(root, "pipeline.log"));
  vi.stubEnv("MANHWA_LANE_CONFIG_DIR", path.join(root, "config"));
  vi.stubEnv("MANHWA_LANE_CONFIG", "");
  vi.stubEnv("MANHWA_LANE_CONFIG_SNAPSHOT", "");
  vi.stubEnv("PIPELINE_ENV", path.join(root, "no.env"));
  tel._reset();
  run._resetHooksForTests();
  render._resetHooksForTests();
  llm._resetSnapshotForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  tel._reset();
  run._resetHooksForTests();
  render._resetHooksForTests();
  llm.WRITER_LANES.splice(0, llm.WRITER_LANES.length, ...originalWriter);
  llm._setFetchForTests(null);
  llm._setSleepForTests(null);
  llm._resetSnapshotForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const text77 = 'vertex tts line 11 failed: Vertex Gemini 3.8 Flash TTS failed (HTTP 429): {"error":{"code":429,"message":"Resource exhausted..."}}';
describe("shared failure classification", () => {
  it.each([
    [new Error(text77), "transient", "HTTP 429 · rate limited"],
    [new llm.AllLanesFailed("all lanes failed: a: HTTP 403 | b: HTTP 429"), "transient", "All models busy"],
    [new llm.AllLanesFailed("all lanes failed: a: HTTP 401 | b: HTTP 422"), "permanent", "All models failed"],
    [new llm.AllLanesFailed("all lanes failed: a: HTTP 403 | b: strange reply"), "unknown", "All models failed"],
    [new llm.AllLanesFailed("all lanes failed: a: policy refusal | b: lane cooling"), "transient", "All models busy"],
    [new Error("14033 tokens"), "unknown", "Error"],
    [new Error("HTTP 503"), "transient", "HTTP 503 · provider overloaded"],
    [new Error("HTTP 401"), "permanent", "HTTP 401 · key rejected"],
    [new Error("request timed out"), "transient", "Timed out"],
    [new Error("fetch failed"), "transient", "Connection failed"],
    [Object.assign(new Error("request failed"), { name: "NetworkError" }), "transient", "Connection failed"],
    [new Error("returned empty audio"), "unknown", "Invalid audio"],
    [new TypeError("unexpected shape"), "unknown", "TypeError"],
    [new RangeError("unexpected value"), "unknown", "RangeError"],
    [new Error("policy refusal: sensitive words"), "permanent", "Policy refusal · safety filter"],
  ])("classifies %s without leaking payload", (error, cls, note) => {
    expect(failClass(error)).toBe(cls);
    expect(failureNote(error)).toBe(note);
    expect(run.failClass(error)).toBe(cls);
    expect(run.fail_class(error)).toBe(cls);
  });
  it("recognizes the incident status, not token counts", () => {
    expect(httpStatusOf(text77)).toBe(429);
    expect(httpStatusOf("14033 tokens")).toBeNull();
    expect(isRefusalText("The prompt could not be submitted. Prohibited Use policy")).toBe(true);
    expect(run.PERMANENT.test("14033 tokens")).toBe(false);
  });
});

describe("telemetry failure notes", () => {
  it("retries the in-flight stage, emits no failed event, and falls back to error names", () => {
    tel.start("fixture", ["ch1"], true);
    tel.stage("ch1", "audio", "done");
    tel.stage("ch1", "render", "running");
    tel.retrying("ch1", new Error(text77), { retryAt: 123, attempt: 1, maxAttempts: 3 });
    expect(tel._data()!.chapters.ch1!.stages.render).toMatchObject({
      state: "retrying", note: "HTTP 429 · rate limited", retryAt: 123, attempt: 1, maxAttempts: 3,
    });
    expect(tel._data()!.chapters.ch1!.stages.audio!.state).toBe("done");
    expect(tel._data()!.events.some((e) => e.message.includes("failed"))).toBe(false);
    tel.failed("ch1", new TypeError("bad shape"));
    expect(tel._data()!.chapters.ch1!.stages.render).toMatchObject({ state: "failed", note: "TypeError" });
    tel.failed("ch1", new RangeError("bad range"));
    expect(tel._data()!.chapters.ch1!.stages.render!.note).toBe("RangeError");
  });
  it("is fail-open without a snapshot or when the status path disappears", () => {
    expect(() => tel.retrying("ch1", new Error(text77), { retryAt: 0, attempt: 1, maxAttempts: 3 })).not.toThrow();
    tel.start("fixture", ["ch1"]);
    fs.rmSync(path.join(root, "status"), { recursive: true });
    expect(() => tel.retrying("ch1", new Error(text77), { retryAt: 0, attempt: 1, maxAttempts: 3 })).not.toThrow();
  });
});

function mp3Fixture(): string {
  const dest = path.join(root, "tone.mp3");
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", dest]);
  expect(result.status).toBe(0);
  return dest;
}

describe.each(["vertex", "grok"] as const)("%s TTS line healing", (engine) => {
  function setup() {
    const fixture = mp3Fixture();
    const lines = [["First line.", []], ["Second line.", []]] as const;
    const synth = engine === "vertex"
      ? vi.spyOn(vertex, "synthesizeVertexTtsToFile") : vi.spyOn(grok, "synthesizeGrokTtsToFile");
    if (engine === "vertex") vi.spyOn(vertex, "findVertexTtsVoice").mockReturnValue({ modelId: "test" } as never);
    else vi.spyOn(grok, "findGrokTtsVoice").mockReturnValue({ id: "test" } as never);
    const invoke = () => (engine === "vertex" ? audio.ttsLinesVertex : audio.ttsLinesGrok)(
      lines, path.join(root, "lines"), { voice_id: "test" }, { ...process.env, MANHWA_TTS_RETRY_DELAYS_S: "0,0,0,0,0" },
    );
    tel.start("fixture", ["ch1"], true);
    tel.bind({ chapter: "ch1" });
    return { fixture, synth, invoke };
  }
  it("retries 429 then succeeds; cached lines are never billed again", async () => {
    const { fixture, synth, invoke } = setup();
    let second = 0;
    synth.mockImplementation(async (opts) => {
      if (opts.text === "Second line." && second++ === 0) throw new Error("HTTP 429: Resource exhausted");
      fs.copyFileSync(fixture, opts.destPath);
    });
    const first = await invoke();
    expect(first).toHaveLength(2);
    expect(synth).toHaveBeenCalledTimes(3);
    expect(tel._data()!.events.some((e) => e.message === "ch1 · audio · retrying")).toBe(true);
    expect(await invoke()).toEqual(first);
    expect(synth).toHaveBeenCalledTimes(3);
  });
  it("never retries HTTP 401 and preserves the final error format", async () => {
    const { synth, invoke } = setup();
    synth.mockRejectedValue(new Error("HTTP 401: rejected"));
    await expect(invoke()).rejects.toThrow(`${engine} tts line 0 failed: HTTP 401: rejected`);
    expect(synth).toHaveBeenCalledTimes(1);
  });
  it.each(["TimeoutError", "NetworkError"])("retries a named %s without losing its type in the wrapper", async (name) => {
    const { fixture, synth, invoke } = setup();
    synth.mockRejectedValueOnce(Object.assign(new Error("request failed"), { name }));
    synth.mockImplementation(async (opts) => { fs.copyFileSync(fixture, opts.destPath); });
    await invoke();
    expect(synth).toHaveBeenCalledTimes(3);
    expect(tel._data()!.events.some((e) => e.message === "ch1 · audio · retrying")).toBe(true);
  });
  it.each(["missing inline audio data", "returned empty audio"])("caps %s at two retries", async (message) => {
    const { synth, invoke } = setup();
    synth.mockRejectedValue(new Error(message));
    await expect(invoke()).rejects.toThrow(`${engine} tts line 0 failed: ${message}`);
    expect(synth).toHaveBeenCalledTimes(3);
  });
  it("caps empty/invalid audio at two retries and leaves no cache proof", async () => {
    const { synth, invoke } = setup();
    synth.mockImplementation(async (opts) => { fs.writeFileSync(opts.destPath, "not audio"); });
    await expect(invoke()).rejects.toThrow("produced invalid audio");
    expect(synth).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(path.join(root, "lines"))).toEqual([]);
  });
});

function localPlan(legacy = false): render.RenderPlan {
  return { source: "persisted", legacy, revision: 1, configError: null, override: null, unavailableGraceS: 5,
    lanes: [{ id: "local", order: 0, enabled: true, configured: true, slots: 1, effectiveSlots: 1,
      minSlots: 1, maxSlots: 1, costTier: "free" }] };
}
describe.each([false, true])("video retries (legacy=%s)", (legacy) => {
  function setup(produce: typeof render.produce) {
    const plan = localPlan(legacy);
    render._hooks.produce = produce;
    render._hooks.renderPolicy = { ...render.renderPolicy,
      resolveRenderPlan: () => plan, resolve_render_plan: () => plan,
      laneAvailability: () => ({ local: [true, "ok"] }),
      lane_availability: () => ({ local: [true, "ok"] }),
    };
    render._hooks.lappy = { ...render.lappy, HOST: "", healthy: () => [false, "off"] };
    render._hooks.cloudlane = { ...render.cloudlane, NAME: "" };
    const q = new render.RenderQueue<string | null>();
    q.put("ch1");
    q.put(null);
    const done = vi.spyOn(q, "taskDone");
    const results: Record<string, render.VideoResult> = {};
    tel.start("fixture", ["ch1"], true);
    return { q, done, results, start: () => render.worker(root, path.join(root, "out"), q, results) };
  }
  it("requeues off-slot, joins only after the retry succeeds, and counts attempts", async () => {
    let release!: () => void;
    let waiting!: () => void;
    const reachedWait = new Promise<void>((resolve) => { waiting = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const produce = vi.fn(async () => {
      tel.stage("ch1", "audio", "running");
      if (produce.mock.calls.length === 1) throw new Error(text77);
      return ["video.mp4", 5] as [string, number];
    });
    const { q, done, results, start } = setup(produce);
    render._hooks.time = { ...render.time, sleep: async (seconds) => {
      if (seconds === 120) { waiting(); await wait; }
      else await new Promise((resolve) => setTimeout(resolve, 1));
    } };
    const worker = start();
    await reachedWait;
    let joined = false;
    const joining = q.join().then(() => { joined = true; });
    await Promise.resolve();
    expect(q.unfinished_tasks).toBe(1);
    expect(joined).toBe(false);
    expect(results.ch1).toBeUndefined();
    expect(tel._data()!.chapters.ch1!.stages.audio).toMatchObject({ state: "retrying", attempt: 1, maxAttempts: 3 });
    release();
    await worker;
    await joining;
    expect(results.ch1).toMatchObject({ status: "video-ok", video_attempts: 2 });
    expect(q.unfinished_tasks).toBe(0);
    expect(done).toHaveBeenCalledTimes(2); // chapter plus sentinel, never the requeued attempt
    expect(tel._data()!.events.some((e) => e.message.includes("failed"))).toBe(false);
  });
  it("exhausts transient retries and finalizes once with class and total attempts", async () => {
    const produce = vi.fn(async () => { throw new Error("HTTP 503"); });
    const { q, done, results, start } = setup(produce);
    const waits: number[] = [];
    render._hooks.time = { ...render.time, sleep: async (n) => { waits.push(n); } };
    await start();
    await q.join();
    expect(waits.filter((n) => n >= 120)).toEqual([120, 600]);
    expect(produce).toHaveBeenCalledTimes(3);
    expect(results.ch1).toMatchObject({ status: "video-failed", class: "transient", video_attempts: 3 });
    expect(q.unfinished_tasks).toBe(0);
    expect(done).toHaveBeenCalledTimes(2);
  });
  it("renders another chapter while a failed chapter waits off-slot", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let otherDone!: () => void;
    const other = new Promise<void>((resolve) => { otherDone = resolve; });
    const order: string[] = [];
    const produce = vi.fn(async (_s: string, ch: string) => {
      order.push(ch);
      if (ch === "ch1" && order.filter((c) => c === ch).length === 1) throw new Error("HTTP 429");
      if (ch === "ch2") otherDone();
      return ["video.mp4", 5] as [string, number];
    });
    const { q, results, start } = setup(produce);
    // Replace the initial sentinel with another chapter, then close the input.
    expect(q.getNowait()).toBe("ch1");
    q.taskDone();
    expect(q.getNowait()).toBeNull();
    q.taskDone();
    q.put("ch1"); q.put("ch2"); q.put(null);
    render._hooks.time = { ...render.time, sleep: async (seconds) => {
      if (seconds === 120) await wait;
      else await new Promise((resolve) => setTimeout(resolve, 1));
    } };
    const worker = start();
    await other;
    expect(order).toEqual(["ch1", "ch2"]);
    expect(results.ch1).toBeUndefined();
    release();
    await worker;
    await q.join();
    expect(order).toEqual(["ch1", "ch2", "ch1"]);
    expect(results.ch1!.video_attempts).toBe(2);
    expect(results.ch2!.video_attempts).toBe(1);
  });
  it.each(["cleaner exploded", "HTTP 401"])("finalizes %s immediately", async (message) => {
    const produce = vi.fn(async () => { throw new Error(message); });
    const { q, results, start } = setup(produce);
    await start();
    expect(produce).toHaveBeenCalledTimes(1);
    expect(results.ch1).toMatchObject({ status: "video-failed", class: failClass(new Error(message)), video_attempts: 1 });
    expect(q.unfinished_tasks).toBe(0);
  });
});

function scriptFixture(issues: string[]) {
  const sdir = path.join(root, "demo");
  fs.mkdirSync(path.join(sdir, "ch1"), { recursive: true });
  fs.writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ title: "fixture", tts: { engine: "edge" } }));
  run._setSeriesRootForTests(root);
  run._hooks.readChapter = (async () => ({ panels: [{ id: "p0001_1" }], characters: [], events: [], gags: [] })) as never;
  run._hooks.mergeBible = (async () => ({ characters: {} })) as never;
  run._hooks.panelTranscript = (() => "p0001_1 | transcript") as never;
  run._hooks.writeScript = (async (_a: unknown, _b: unknown, _c: unknown, dest: string) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const script = "## BEAT b01\nHe runs. @p0001_1\n";
    fs.writeFileSync(dest, script);
    return script;
  }) as never;
  run._hooks.factCheck = { check: () => issues } as never;
  run._hooks.promoBlock = { ensure: () => null } as never;
  return sdir;
}
describe("script telemetry and durable video reports", () => {
  it.each([
    [[], "done", 0], [["UNGROUNDED line 1"], "done", 0],
    [["UNGROUNDED line 1", "NUMBER line 2"], "warning", 1],
  ] as const)("check distinguishes findings %s from flagged issues", async (issues, state, flagged) => {
    scriptFixture([...issues]);
    expect(await run._runLocked("demo", ["ch1"])).toBe(0);
    expect(tel._data()!.chapters.ch1!.stages.check).toMatchObject({ state, findings: issues.length, flagged, lines: 1, words: 2 });
    expect(console.log).toHaveBeenCalledWith(`   script: 1 lines | fact_check: ${issues.length ? `FAIL (${issues.length})` : "PASS"}`);
  });
  it("writer retry never emits failed and resumes the actual failed stage as queued", async () => {
    scriptFixture([]);
    const write = run._hooks.writeScript;
    let calls = 0;
    run._hooks.writeScript = (async (...args: Parameters<typeof write>) => {
      if (++calls === 1) throw new Error(text77);
      return write(...args);
    }) as typeof write;
    run._hooks.time = { ...run.time, sleep: async () => {
      expect(tel._data()!.chapters.ch1!.stages.writer).toMatchObject({ state: "retrying", attempt: 1, maxAttempts: 3 });
    } };
    expect(await run._runLocked("demo", ["ch1"])).toBe(0);
    const events = tel._data()!.events.map((e) => e.message);
    expect(events).toContain("ch1 · writer · queued");
    expect(events.some((e) => e.includes("failed"))).toBe(false);
  });
  it.each(["video-ok", "video-failed"] as const)("writes %s before the worker finishes", async (status) => {
    const sdir = scriptFixture([]);
    run._hooks.renderlane = { worker: async (_s: string, _o: string, q: render.RenderQueue<string | null>, results: Record<string, render.VideoResult>) => {
      for (;;) {
        const ch = await q.get();
        if (ch === null) { q.taskDone(); return; }
        results[ch] = { status, video: "fixture.mp4", video_attempts: 2,
          ...(status === "video-failed" ? { class: "transient" as const, error: "HTTP 429" } : {}) };
        const report = JSON.parse(fs.readFileSync(path.join(sdir, "out", ch, "report.json"), "utf8"));
        expect(report).toMatchObject({ status, video_attempts: 2, lines: 1 });
        if (status === "video-failed") expect(report.class).toBe("transient");
        q.taskDone();
      }
    } } as never;
    expect(await run._runLocked("demo", ["ch1"], { video: true })).toBe(status === "video-ok" ? 0 : 1);
  });
});

it("HTTP 200 policy refusal moves to the next lane without parking the first lane", async () => {
  const lanes = ["refusal-fixture", "answer-fixture"].map((name) => llm._lane("openai", name, "test", {
    base: `http://lane.test/${name}`, key_env: null, stream: false,
  }));
  llm.WRITER_LANES.splice(0, llm.WRITER_LANES.length, ...lanes);
  llm._resetSnapshotForTests();
  const seen: string[] = [];
  const refusal = "The prompt could not be submitted. The prompt contains sensitive words that violate Google's Prohibited Use policy.";
  llm._setFetchForTests(async (input) => {
    const url = String(input);
    seen.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: url.includes("refusal-fixture") ? refusal : "answer" } }] }), { status: 200 });
  });
  llm._setSleepForTests(async () => {});
  tel.start("fixture", ["ch1"]);
  for (let i = 0; i < 2; i++) {
    expect((await llm.call([{ role: "user", content: "fixture" }], { retries: 1 })).choices[0]!.message.content).toBe("answer");
  }
  expect(seen.filter((s) => s.includes("refusal-fixture"))).toHaveLength(2);
  expect(seen.filter((s) => s.includes("answer-fixture"))).toHaveLength(2);
  expect(tel._data()!.recentCalls.filter((c) => c.note === "Refused · safety policy · next lane")).toHaveLength(2);
  expect(fs.readFileSync(path.join(root, "pipeline.log"), "utf8")).toContain("ERR");
});
