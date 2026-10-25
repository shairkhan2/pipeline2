/**
 * Script reuse on an engine switch, and pause checkpoints in the narration line loops.
 *
 * Offline: Vertex is a stubbed fetch with a Studio-store fixture credential,
 * ElevenLabs is a mocked client, Edge is the shared fake python. Audio is real
 * ffmpeg output. Everything lives under /tmp/opencode.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MUST come before timeline.ts: it freezes MANHWA_STUDIO_PUBLIC and installs the fake Edge python.
import { fakeEdgeCalls } from "./helpers/language-studio-env.js";

import * as audio from "../src/stages/audio.js";
import * as timeline from "../src/stages/timeline.js";
import * as eleven from "../src/llm/elevenlabsTts.js";
import { putSecret } from "../src/config/secretStore.js";
import { upsertProvider } from "../src/config/studioConfig.js";
import { narrationCacheKey } from "../src/contracts/hashes.js";
import { PAUSE_FILE_ENV, RunPausedError } from "../src/domain/runControl.js";
import * as tel from "../src/telemetry/telemetry.js";

const TMP_ROOT = "/tmp/opencode";
const EL_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const TAGGED = [
  "[deadpan] He runs fast. @p0001_1",
  "She waits here. @p0001_2",
  "[sighs] They leave now. @p0001_3",
  "",
].join("\n");
let root = "";

function makeAudio(dest: string, seconds = 0.5): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ac", "1", "-ar", "24000", dest,
  ], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr}`);
}

interface Fx {
  sdir: string;
  out: string;
  chDir: string;
  script: string;
  obs: string;
  vdir: string;
  env: NodeJS.ProcessEnv;
}

function fixture(name: string, tts: Record<string, unknown>, scripts: Record<string, string>): Fx {
  const sdir = path.join(root, `series-${name}`);
  const out = path.join(sdir, "out");
  const chDir = path.join(out, "ch1");
  const panelsDir = path.join(out, "panels", "ch1");
  fs.mkdirSync(panelsDir, { recursive: true });
  fs.mkdirSync(chDir, { recursive: true });
  const panels: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 3; i++) {
    const id = `p0001_${i}`;
    const r = spawnSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x203040:s=64x96:d=1",
      "-frames:v", "1", path.join(panelsDir, `${id}.jpg`),
    ], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) throw new Error(`panel fixture failed: ${r.stderr}`);
    panels.push({ id, art: 0.9, bubble_at: "none", overlay: [], world: [] });
  }
  fs.writeFileSync(path.join(panelsDir, "manifest.json"), JSON.stringify(panels.map((p, i) => ({
    panel: `${p.id}.jpg`, page: 1, idx: i + 1, art_top: 0, art_bottom: 1,
  }))));
  for (const [file, body] of Object.entries(scripts)) fs.writeFileSync(path.join(chDir, file), body);
  const obs = path.join(out, "obs_ch1.json");
  fs.writeFileSync(obs, JSON.stringify({ panels, characters: [], gags: [], events: [] }));
  fs.writeFileSync(path.join(out, "promo_block.json"), JSON.stringify({ version: 1, pages: [] }));
  fs.writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({
    title: name, tts, visuals: { background: "starfield", motion: "cut" },
  }));
  return {
    sdir, out, chDir,
    script: path.join(chDir, "script.md"),
    obs,
    vdir: path.join(chDir, "video"),
    env: {
      ...process.env,
      MANHWA_OUT_DIR: out,
      MANHWA_TTS_RETRY_DELAYS_S: "0,0,0,0,0",
      PIPELINE_STATUS_DIR: path.join(root, "status"),
      PIPELINE_LOG: path.join(root, "pipeline.log"),
    },
  };
}

function stubVertex(fx: Fx): string[] {
  upsertProvider({
    id: "vertex-ai",
    preset: "vertex-ai",
    auth: { mode: "vertex-oauth", projectId: "studio-project", secretRef: "provider:vertex-ai" },
  }, fx.out);
  putSecret("provider:vertex-ai", JSON.stringify({ access_token: "fixture-token" }), fx.out);
  const wav = path.join(root, "line.wav");
  makeAudio(wav);
  const texts: string[] = [];
  vi.stubGlobal("fetch", (async (_url: string, init: { body: string }) => {
    texts.push(JSON.parse(init.body).contents[0].parts[0].text as string);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { data: fs.readFileSync(wav).toString("base64"), mimeType: "audio/wav" } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch);
  return texts;
}

function mockEleven() {
  const mp3 = path.join(root, "tone.mp3");
  makeAudio(mp3, 0.6);
  const synth = vi.spyOn(eleven, "synthesizeElevenLabsToFile");
  synth.mockImplementation(async (opts) => {
    fs.copyFileSync(mp3, opts.destPath);
    return { keyId: "k" };
  });
  return synth;
}

function logged(): string[] {
  return (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  root = fs.mkdtempSync(path.join(TMP_ROOT, "script-reuse-"));
  vi.stubEnv("MANHWA_OUT_DIR", path.join(root, "out"));
  vi.stubEnv("MANHWA_SERIES_ROOT", path.join(root, "series"));
  vi.stubEnv("MANHWA_JOBS_DIR", path.join(root, "jobs"));
  vi.stubEnv("PIPELINE_STATUS_DIR", path.join(root, "status"));
  vi.stubEnv("PIPELINE_LOG", path.join(root, "pipeline.log"));
  vi.stubEnv(PAUSE_FILE_ENV, "");
  tel._reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  tel._reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("English script choice on an engine switch", () => {
  it("vertex with only script_eleven.md voices the stripped text", async () => {
    const fx = fixture("vx", { engine: "vertex", voice_id: "gemini-tts:Charon", speed: 1 }, { "script_eleven.md": TAGGED });
    const texts = stubVertex(fx);
    await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, fx.vdir, { env: fx.env });
    expect(texts).toEqual(["He runs fast.", "She waits here.", "They leave now."]);
    expect(logged().filter((l) => l.includes("reusing script_eleven.md"))).toHaveLength(1);
    // The per-line proof holds the spoken text, never the tagged one.
    const proof = fs.readFileSync(path.join(fx.vdir, "tts_lines_vertex", "line_000.txt"), "utf8");
    expect(proof).toContain('"text": "He runs fast."');
    expect(proof).not.toContain("[deadpan]");
    // Shot text is the script text; captions never carry tags because the parsed line is unchanged.
    expect(fs.existsSync(path.join(fx.vdir, "narration.mp3"))).toBe(true);
  });

  it("elevenlabs with only script.md voices it unchanged", async () => {
    const fx = fixture("el", { engine: "elevenlabs", voice_id: EL_VOICE }, {
      "script.md": "He runs fast. @p0001_1\nShe waits here. @p0001_2\n",
    });
    const synth = mockEleven();
    await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, fx.vdir, { env: fx.env });
    expect(synth.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual(["He runs fast.", "She waits here."]);
    expect(logged().some((l) => l.includes("reusing script.md"))).toBe(true);
    expect(logged().some((l) => l.includes("elevenlabs mode: voicing script.md - 0 emotion tags"))).toBe(true);
  });

  it("edge with only script_voice.md voices the stripped text", async () => {
    const fx = fixture("edge", { engine: "edge", voice_id: "en-US-AndrewMultilingualNeural", speed: 1 }, {
      "script_voice.md": TAGGED,
    });
    await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, fx.vdir, { env: fx.env });
    const calls = fakeEdgeCalls(path.join(fx.vdir, "tts_lines_edge"));
    expect(calls.map((c) => c.text)).toEqual(["He runs fast.", "She waits here.", "They leave now."]);
  });

  it("no script at all still raises the SystemExit", async () => {
    const fx = fixture("none", { engine: "vertex", voice_id: "gemini-tts:Charon" }, {});
    const err = await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, fx.vdir, { env: fx.env }).catch((e) => e);
    expect(err?.name).toBe("SystemExit");
    expect(String(err?.message)).toContain("missing - run the writer first");
  });

  it("keeps the narration key of a normal setup unchanged", async () => {
    const body = "He runs fast. @p0001_1\nShe waits here. @p0001_2\n";
    const fx = fixture("key", { engine: "vertex", voice_id: "gemini-tts:Charon", speed: 1 }, { "script.md": body });
    stubVertex(fx);
    await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, fx.vdir, { env: fx.env });
    const lines = timeline.parseScript(fx.script) as Array<[string, string[]]>;
    expect(fs.readFileSync(path.join(fx.vdir, "narration.key"), "utf8"))
      .toBe(narrationCacheKey(lines, "vertex", "gemini-tts:Charon", undefined, 1));
    expect(logged().some((l) => l.includes("reusing"))).toBe(false);
  });

  it("elevenlabs with its own tagged script keeps the model-based key and tags", async () => {
    const fx = fixture("elk", { engine: "elevenlabs", voice_id: EL_VOICE }, { "script_eleven.md": TAGGED });
    const synth = mockEleven();
    await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, fx.vdir, { env: fx.env });
    expect((synth.mock.calls[0]![0] as { text: string }).text).toBe("[deadpan] He runs fast.");
    const lines = timeline.parseScript(path.join(fx.chDir, "script_eleven.md")) as Array<[string, string[]]>;
    expect(fs.readFileSync(path.join(fx.vdir, "narration.key"), "utf8"))
      .toBe(narrationCacheKey(lines, "elevenlabs", `${EL_VOICE}|model=eleven_v4`, undefined, 1));
  });
});

describe("pause checkpoints in the line loops", () => {
  const LINES = [["One line.", []], ["Two line.", []], ["Three line.", []]] as const;

  it("pauses before line 2 after line 1 is cached, then resumes from line 2", async () => {
    const synth = mockEleven();
    const pauseFile = path.join(root, "job.pause");
    const dir = path.join(root, "lines");
    const env = { ...process.env, MANHWA_TTS_RETRY_DELAYS_S: "0,0,0,0,0", [PAUSE_FILE_ENV]: pauseFile };
    let first = true;
    synth.mockImplementation(async (opts) => {
      makeAudio(opts.destPath, 0.6);
      // Requested while line 1 synthesizes: the run stops at the next safe point.
      if (first) fs.writeFileSync(pauseFile, JSON.stringify({ at: Date.now(), by: "user" }));
      first = false;
      return { keyId: "k" };
    });
    const err = await audio.ttsLinesElevenlabs(LINES, dir, { voice_id: EL_VOICE }, env, { chapter: "ch1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RunPausedError);
    expect((err as RunPausedError).where).toBe("elevenlabs narration ch1 line 2");
    expect(synth).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir).sort()).toEqual(["line_000.mp3", "line_000.txt"]);

    fs.unlinkSync(pauseFile);
    synth.mockClear();
    const spans = await audio.ttsLinesElevenlabs(LINES, dir, { voice_id: EL_VOICE }, env, { chapter: "ch1" });
    expect(spans).toHaveLength(3);
    expect(synth.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual(["Two line.", "Three line."]);
  });

  it("cached lines never checkpoint", async () => {
    mockEleven();
    const dir = path.join(root, "lines");
    const pauseFile = path.join(root, "job.pause");
    const env = { ...process.env, MANHWA_TTS_RETRY_DELAYS_S: "0,0,0,0,0", [PAUSE_FILE_ENV]: pauseFile };
    await audio.ttsLinesElevenlabs(LINES, dir, { voice_id: EL_VOICE }, env);
    fs.writeFileSync(pauseFile, "{}");
    const spans = await audio.ttsLinesElevenlabs(LINES, dir, { voice_id: EL_VOICE }, env);
    expect(spans).toHaveLength(3);
  });

  it("vertex checkpoints before an uncached line through timeline.main", async () => {
    const fx = fixture("vxp", { engine: "vertex", voice_id: "gemini-tts:Charon" }, { "script.md": TAGGED });
    const texts = stubVertex(fx);
    const pauseFile = path.join(root, "vx.pause");
    fs.writeFileSync(pauseFile, "{}");
    const err = await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, fx.vdir, {
      env: { ...fx.env, [PAUSE_FILE_ENV]: pauseFile },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RunPausedError);
    expect((err as RunPausedError).where).toBe("vertex narration ch1 line 1");
    expect(texts).toEqual([]);
  });
});
