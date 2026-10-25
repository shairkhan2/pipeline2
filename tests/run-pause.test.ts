/** Cooperative pause on the run side. Every artifact stays in a private temp dir. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as run from "../src/cli/run.js";
import * as render from "../src/workers/renderlane.js";
import * as tel from "../src/telemetry/telemetry.js";
import * as reader from "../src/stages/reader.js";
import * as llm from "../src/llm/client.js";
import { collectStatus } from "../src/telemetry/statusProbe.js";
import { failClass } from "../src/domain/failure.js";
import { CAPTION_VERSION, batchDir } from "../src/contracts/hashes.js";
import { RunPausedError, isRunPausedError } from "../src/domain/runControl.js";

let root: string;
let pauseFile: string;
let logs: string[];

beforeEach(() => {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  root = fs.mkdtempSync("/tmp/opencode/run-pause-");
  pauseFile = path.join(root, "jobs", "job-1.pause");
  vi.stubEnv("PIPELINE_STATUS_DIR", path.join(root, "status"));
  vi.stubEnv("PIPELINE_LOG", path.join(root, "pipeline.log"));
  vi.stubEnv("MANHWA_LANE_CONFIG_DIR", path.join(root, "config"));
  vi.stubEnv("MANHWA_LANE_CONFIG", "");
  vi.stubEnv("MANHWA_LANE_CONFIG_SNAPSHOT", "");
  vi.stubEnv("PIPELINE_ENV", path.join(root, "no.env"));
  vi.stubEnv("MANHWA_PAUSE_FILE", "");
  vi.stubEnv("MANHWA_JOB_ID", "");
  tel._reset();
  run._resetHooksForTests();
  render._resetHooksForTests();
  render.resetVideoPause();
  llm._resetSnapshotForTests();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  tel._reset();
  run._resetHooksForTests();
  run._setSeriesRootForTests(null);
  render._resetHooksForTests();
  render.resetVideoPause();
  reader._setCallForTests(null);
  llm._resetSnapshotForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function requestPause(): void {
  fs.mkdirSync(path.dirname(pauseFile), { recursive: true });
  fs.writeFileSync(pauseFile, JSON.stringify({ at: Date.now(), by: "user" }), { mode: 0o600 });
}

function series(chapters: string[], tts: Record<string, unknown> = { engine: "edge" }) {
  const sdir = path.join(root, "demo");
  for (const ch of chapters) fs.mkdirSync(path.join(sdir, ch), { recursive: true });
  fs.writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ title: "fixture", tts }));
  run._setSeriesRootForTests(root);
  run._hooks.readChapter = (async () => ({ panels: [{ id: "p0001_1" }], characters: [], events: [], gags: [] })) as never;
  run._hooks.mergeBible = (async (_p: string, ch: string) => ({ characters: {}, covered: [ch] })) as never;
  run._hooks.panelTranscript = (() => "p0001_1 | transcript") as never;
  const writer = vi.fn(async (_a: unknown, _b: unknown, _c: unknown, dest: string) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const script = "## BEAT b01\nHe runs. @p0001_1\n";
    fs.writeFileSync(dest, script);
    return script;
  });
  run._hooks.writeScript = writer as never;
  run._hooks.factCheck = { check: () => [] } as never;
  run._hooks.promoBlock = { ensure: () => null } as never;
  return { sdir, out: path.join(sdir, "out"), writer };
}

function localPlan(): render.RenderPlan {
  return { source: "persisted", legacy: false, revision: 1, configError: null, override: null, unavailableGraceS: 5,
    lanes: [{ id: "local", order: 0, enabled: true, configured: true, slots: 1, effectiveSlots: 1,
      minSlots: 1, maxSlots: 1, costTier: "free" }] };
}

/** Real worker + produce + prepare; only timeline.main and the render are mocked. */
function videoLane(main: (sdir: string, ch: string) => Promise<string>) {
  const plan = localPlan();
  render._hooks.renderPolicy = { ...render.renderPolicy,
    resolveRenderPlan: () => plan, resolve_render_plan: () => plan,
    laneAvailability: () => ({ local: [true, "ok"] }),
    lane_availability: () => ({ local: [true, "ok"] }),
  };
  render._hooks.lappy = { ...render.lappy, HOST: "", healthy: () => [false, "off"] };
  render._hooks.cloudlane = { ...render.cloudlane, NAME: "" };
  const timeline = vi.fn(main);
  render._hooks.loadTimeline = () => ({ main: timeline });
  const rendered = vi.fn(async (_ch: string, _props: string, video: string) => [video, 5] as [string, number]);
  render._hooks._render = rendered as never;
  return { timeline, rendered };
}

function pipelineLog(): string {
  try { return fs.readFileSync(path.join(root, "pipeline.log"), "utf8"); } catch { return ""; }
}

describe("run-side pause protocol", () => {
  it("a pause request in the main loop exits 75 with == PAUSED at", async () => {
    const { writer } = series(["ch1", "ch2"]);
    vi.stubEnv("MANHWA_PAUSE_FILE", pauseFile);
    requestPause();
    expect(await run._runLocked("demo", ["ch1", "ch2"])).toBe(75);
    expect(logs).toContain("== PAUSED at ch1 start");
    expect(writer).not.toHaveBeenCalled();
    expect(tel._data()).toMatchObject({ state: "paused", pausedWhere: "ch1 start" });
    expect(pipelineLog()).not.toContain("CHAPTERFAIL");
  });

  it("pauses between chapters and never fails the chapter in progress", async () => {
    const { out, writer } = series(["ch1", "ch2"]);
    vi.stubEnv("MANHWA_PAUSE_FILE", pauseFile);
    run._hooks.factCheck = { check: () => { requestPause(); return []; } } as never;
    expect(await run._runLocked("demo", ["ch1", "ch2"])).toBe(75);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(logs).toContain("== PAUSED at ch2 start");
    const report = JSON.parse(fs.readFileSync(path.join(out, "ch1", "report.json"), "utf8"));
    expect(report.status).toBe("ok");
    expect(fs.existsSync(path.join(out, "ch2", "report.json"))).toBe(false);
  });

  it("a finished run with a stale pause file still exits 0", async () => {
    series(["ch1"]);
    vi.stubEnv("MANHWA_PAUSE_FILE", pauseFile);
    // The request lands after the last safe point of the last chapter.
    run._hooks.factCheck = { check: () => { requestPause(); return []; } } as never;
    expect(await run._runLocked("demo", ["ch1"])).toBe(0);
    expect(logs.some((l) => l.startsWith("== PAUSED"))).toBe(false);
    expect(tel._data()!.state).toBe("completed");
  });

  it("without MANHWA_PAUSE_FILE the old behavior stays", async () => {
    const { writer } = series(["ch1", "ch2"]);
    requestPause(); // a file on disk means nothing without the env var
    expect(await run._runLocked("demo", ["ch1", "ch2"])).toBe(0);
    expect(writer).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.startsWith("== PAUSED"))).toBe(false);
  });

  it("failClass never calls a RunPausedError permanent", () => {
    const e = new RunPausedError("ch1 start");
    expect(isRunPausedError(e)).toBe(true);
    expect(failClass(e)).not.toBe("permanent");
  });
});

describe("reader batch checkpoint", () => {
  it("pauses before the first batch that is not cached, with no API call", async () => {
    vi.stubEnv("MANHWA_PAUSE_FILE", pauseFile);
    const chdir = path.join(root, "src", "ch1");
    fs.mkdirSync(chdir, { recursive: true });
    const out = path.join(root, "out");
    const ids = Array.from({ length: reader.BATCH + 1 }, (_, i) => `p0001_${i + 1}`);
    const manifest = ids.map((id, i) => ({ panel: `ch1/${id}.jpg`, page: 1, idx: i + 1, w: 100, h: 200 }));
    reader._save(path.join(batchDir(out, "ch1", CAPTION_VERSION), "b00.json"), {
      panels: ids.slice(0, reader.BATCH).map((id) => ({ id, visual: "cached" })),
      characters: [], gags: [], events: [],
    });
    const call = vi.fn(async () => { throw new Error("paused reader called the model"); });
    reader._setCallForTests(call as never);
    requestPause();
    const err = await reader.readChapter(chdir, out, false, false, null, CAPTION_VERSION, async () => manifest)
      .catch((e: unknown) => e);
    expect(isRunPausedError(err)).toBe(true);
    expect((err as RunPausedError).where).toBe("ch1 reader batch 2/2");
    expect(call).not.toHaveBeenCalled();
    expect(logs).toContain("  batch 1/2 cached");
  });
});

describe("video lane pause", () => {
  it("RunPausedError from prepare is no chapter failure, and later chapters are not processed", async () => {
    const { out, writer } = series(["ch1", "ch2", "ch3"]);
    vi.stubEnv("MANHWA_PAUSE_FILE", pauseFile);
    vi.stubEnv("READ_AHEAD", "0"); // the gate below would block ch1's read-ahead
    let reached!: () => void;
    const timelineCalled = new Promise<void>((resolve) => { reached = resolve; });
    const { timeline, rendered } = videoLane(async (_s, ch) => {
      // A2's narration checkpoint: the request exists, so the line loop throws.
      requestPause();
      reached();
      throw new RunPausedError(`${ch} narration line 1`);
    });
    const readChapter = run._hooks.readChapter;
    run._hooks.readChapter = (async (...args: Parameters<typeof readChapter>) => {
      if (path.basename(args[0]) !== "ch1") await timelineCalled;
      return readChapter(...args);
    }) as typeof readChapter;
    expect(await run._runLocked("demo", ["ch1", "ch2", "ch3"], { video: true })).toBe(75);
    expect(timeline).toHaveBeenCalledTimes(1);
    expect(rendered).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.startsWith("== PAUSED at "))).toBe(true);
    const report = JSON.parse(fs.readFileSync(path.join(out, "ch1", "report.json"), "utf8"));
    expect(report.status).toBe("ok");
    expect(fs.existsSync(path.join(out, "ch3", "report.json"))).toBe(false);
    expect(pipelineLog()).not.toContain("CHAPTERFAIL");
    expect(tel._data()!.state).toBe("paused");
  });

  it("auto-pauses on a vertex HTTP 403 narration failure, writing the reason, without failing the chapter", async () => {
    const { out } = series(["ch1"], { engine: "vertex", voice_id: "Kore" });
    vi.stubEnv("MANHWA_PAUSE_FILE", pauseFile);
    const { timeline } = videoLane(async () => {
      throw new Error(
        'vertex tts line 3 failed: Vertex Gemini 3.8 Flash TTS failed (HTTP 403): ' +
          '{"error":{"code":403,"message":"billing disabled"}}',
      );
    });
    expect(await run._runLocked("demo", ["ch1"], { video: true })).toBe(75);
    expect(timeline).toHaveBeenCalledTimes(1);
    const req = JSON.parse(fs.readFileSync(pauseFile, "utf8"));
    expect(req.by).toBe("auto");
    expect(req.reason).toContain("Vertex TTS rejected the account (HTTP 403: billing disabled)");
    expect(fs.statSync(pauseFile).mode & 0o777).toBe(0o600);
    const report = JSON.parse(fs.readFileSync(path.join(out, "ch1", "report.json"), "utf8"));
    expect(report.status).toBe("ok");
    expect(logs).toContain("== PAUSED at ch1 narration");
  });

  it("the same 403 without MANHWA_PAUSE_FILE fails the chapter as before", async () => {
    series(["ch1"], { engine: "vertex", voice_id: "Kore" });
    videoLane(async () => {
      throw new Error("vertex tts line 3 failed: Vertex Gemini 3.8 Flash TTS failed (HTTP 403): denied");
    });
    expect(await run._runLocked("demo", ["ch1"], { video: true })).toBe(1);
    expect(fs.existsSync(pauseFile)).toBe(false);
  });
});

describe("writer reuse on an engine switch", () => {
  it("reuses another engine's script with no writer call", async () => {
    const { out, writer } = series(["ch1"], { engine: "elevenlabs", voice_id: "abcdefghijklmnopqrst" });
    fs.mkdirSync(path.join(out, "ch1"), { recursive: true });
    fs.writeFileSync(path.join(out, "ch1", "script.md"), "## BEAT b01\nHe runs. @p0001_1\n");
    expect(await run._runLocked("demo", ["ch1"])).toBe(0);
    expect(writer).not.toHaveBeenCalled();
    expect(logs).toContain("   writer: reusing script.md for engine elevenlabs");
    expect(fs.existsSync(path.join(out, "ch1", "script_eleven.md"))).toBe(false);
  });

  it("--force still runs the writer", async () => {
    const { out, writer } = series(["ch1"], { engine: "elevenlabs", voice_id: "abcdefghijklmnopqrst" });
    fs.mkdirSync(path.join(out, "ch1"), { recursive: true });
    fs.writeFileSync(path.join(out, "ch1", "script.md"), "## BEAT b01\nHe runs. @p0001_1\n");
    expect(await run._runLocked("demo", ["ch1"], { force: true })).toBe(0);
    expect(writer).toHaveBeenCalledTimes(1);
  });
});

describe("telemetry", () => {
  it("status JSON carries jobId and state paused with pausedWhere", () => {
    vi.stubEnv("MANHWA_JOB_ID", "job-1");
    tel.start("demo", ["ch1"], true);
    tel.stage("ch1", "audio", "running");
    tel.paused("ch1 narration");
    const snap = JSON.parse(fs.readFileSync(tel._path()!, "utf8"));
    expect(snap).toMatchObject({ jobId: "job-1", state: "paused", pausedWhere: "ch1 narration" });
    const status = collectStatus({
      root, series: path.join(root, "series"), log: path.join(root, "pipeline.log"),
      status: path.join(root, "status"), procs: {}, now: Date.now() / 1000, models: {},
    });
    const row = status.runs.find((r: { id: string }) => r.id === snap.id);
    expect(row).toMatchObject({ jobId: "job-1", state: "paused", pausedWhere: "ch1 narration", alive: false });
    expect(status.running).toBe(false);
  });

  it("jobId is null without MANHWA_JOB_ID", () => {
    tel.start("demo", ["ch1"]);
    expect(tel._data()).toMatchObject({ jobId: null, pausedWhere: null });
  });
});
