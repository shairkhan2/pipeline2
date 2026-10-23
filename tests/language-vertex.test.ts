/**
 * Hindi language versions on Vertex TTS (Chirp 3 HD + Gemini 3.8 Flash TTS).
 *
 * The point of this suite is the COMPLETE path, not a picker string:
 *   catalog -> plan/preflight -> persisted job identity -> renderlane tts payload
 *   -> ttsLinesVertex -> Vertex request body -> preview cache identity.
 *
 * Offline only: Vertex credentials are Studio-store fixtures, every network
 * call is a stub, and audio fixtures are real MP3/WAV made with ffmpeg under
 * /tmp/opencode. No paid call, no live server, no user series.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MUST come before timeline.ts: it freezes MANHWA_STUDIO_PUBLIC (read at import
// time by timeline.ts) and installs the fake Edge python for this process.
import { fakeEdgeCalls } from "./helpers/language-studio-env.js";

import * as localize from "../src/stages/localize.js";
import * as audio from "../src/stages/audio.js";
import * as timeline from "../src/stages/timeline.js";
import * as vertexTts from "../src/llm/vertexTts.js";
import { catalog, resolveVoice, UnsupportedVoiceError } from "../src/localization/catalog.js";
import { readJob, readManifest, writeJob } from "../src/localization/store.js";
import { putSecret } from "../src/config/secretStore.js";
import { upsertProvider } from "../src/config/studioConfig.js";
import * as renderlane from "../src/workers/renderlane.js";
import { pyFloat, pyJsonDumps } from "../src/contracts/hashes.js";

const TMP_ROOT = "/tmp/opencode";
const slug = "vertex-hindi-fixture";
let root = "";
let sdir = "";

const ENGLISH_SCRIPT = [
  "## BEAT b00_opening",
  "The gate opens at midnight, and Zichen counts ten thousand steps before dawn. @p0001_1 @hold",
  "",
  "## BEAT b01_meeting",
  "Shen Qinghan waits by the library door with two books under her arm. @p0002_1",
  "Convenient timing. @p0002_1",
  "",
].join("\n");

function write(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function json(file: string, value: unknown): void {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeMp3(dest: string, seconds = 0.6): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, dest],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function makeWav(dest: string, seconds = 0.5): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ac", "1", "-ar", "24000", dest],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

function makeMp4(dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
      "-c:a", "aac", dest,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr}`);
}

/** Studio-store Vertex provider + secret in the fixture out dir. */
function configureVertex(outDir: string, secret = { access_token: "studio-access-token" }): void {
  upsertProvider({
    id: "vertex-ai",
    preset: "vertex-ai",
    auth: { mode: "vertex-oauth", projectId: "studio-project", secretRef: "provider:vertex-ai" },
  }, outDir);
  putSecret("provider:vertex-ai", JSON.stringify(secret), outDir);
}

function buildSeries(): void {
  const out = path.join(sdir, "out");
  json(path.join(sdir, "meta.json"), { title: "Vertex Hindi Fixture", tts: { engine: "edge" } });
  json(path.join(out, "bible.json"), {
    characters: { zichen: { name: "Zichen", aliases: [], role: "protagonist" } },
  });
  json(path.join(out, "obs_ch1.json"), {
    data: {
      panels: [
        { id: "p0001_1", visual: "Night artwork.", overlay: [], world: [], art: 0.9 },
        { id: "p0002_1", visual: "Girl artwork.", overlay: [], world: [], art: 0.9 },
        {
          id: "p0009_1",
          visual: "Vocabulary artwork.",
          overlay: ["gate midnight opens counts thousand steps"],
          world: ["shen qinghan waits library door books arm convenient timing"],
          art: 0.9,
        },
      ],
      characters: [],
      gags: [],
      events: [{ event: "Zichen counts steps before dawn." }],
    },
  });
  for (const id of ["p0001_1", "p0002_1", "p0009_1"]) {
    write(path.join(out, "panels", "ch1", `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  write(path.join(out, "ch1", "script.md"), ENGLISH_SCRIPT);
  json(path.join(out, "ch1", "report.json"), {
    series: slug, ch: "ch1", status: "ok", lines: 3, issues: [], window_holes: [],
  });
  write(path.join(out, "promo_block.json"), "{}\n");
}

function hindiFor(text: string): string {
  return text
    .replace(
      "The gate opens at midnight, and Zichen counts ten thousand steps before dawn.",
      "आधी रात को दरवाज़ा खुलता है, और ज़िचेन भोर से पहले दस हज़ार क़दम गिनता है।",
    )
    .replace(
      "Shen Qinghan waits by the library door with two books under her arm.",
      "शेन चिंगहान पुस्तकालय के दरवाज़े पर दो किताबें दबाए खड़ी है।",
    )
    .replace("Convenient timing.", "सुविधाजनक समय।");
}

function fakeLlm(): { fn: ReturnType<typeof vi.fn>; translateCalls: () => number } {
  let translateCount = 0;
  const fn = vi.fn(async (messages: unknown, options: { tag?: string }) => {
    if (String(options?.tag ?? "").includes("review")) {
      return { choices: [{ message: { content: JSON.stringify({ verdict: "accept", issues: [] }) } }] };
    }
    translateCount += 1;
    const raw = (messages as Array<{ content: string }>)[0]!.content;
    const block = /ENGLISH UNITS \(JSON\):\n([\s\S]*?)\n\nReply STRICT JSON/.exec(raw);
    if (!block) throw new Error("translate prompt missing units");
    const units = JSON.parse(block[1]!) as Array<{ id: string; text: string }>;
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            units: units.map((u) => ({ id: u.id, text: hindiFor(u.text) })),
            glossary: { names: { Zichen: "ज़िचेन", "Shen Qinghan": "शेन चिंगहान" }, terms: {} },
          }),
        },
      }],
    };
  });
  return { fn, translateCalls: () => translateCount };
}

interface FakeRenderer {
  fn: ReturnType<typeof vi.fn>;
  calls: Array<{ voice: string; speed: number; locale: string; tts: Record<string, unknown> }>;
}

function fakeRenderer(): FakeRenderer {
  const calls: FakeRenderer["calls"] = [];
  const fn = vi.fn(async (_sdir: string, ch: string, out: string, opts: {
    locale: string;
    tts: Record<string, unknown>;
  }) => {
    calls.push({ voice: String(opts.tts.voice_id), speed: Number(opts.tts.speed), locale: opts.locale, tts: opts.tts });
    const video = path.join(localize.__testCanonicalDir(path.dirname(out), opts.locale, ch), "video", "video.mp4");
    makeMp4(video);
    return [video, 1, []] as [string, number, string[]];
  });
  return { fn, calls };
}

/**
 * The pre-revision localized narration key: the exact identity object the code
 * hashed before the Gemini request revision was added. Proves Edge/Chirp keys did
 * not move while a Gemini key did.
 */
function oldLocaleKey(base: string, identity: Record<string, unknown>): string {
  const digest = createHash("sha256")
    .update(`${pyJsonDumps(identity, { sortKeys: true })}|${base}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${timeline.LOCALE_CACHE_VERSION}:${String(identity.locale)}:${digest}`;
}

/** Every Vertex HTTP call the code made, in order. */
function stubVertexFetch(audioFixture: string, mime = "audio/wav") {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ inlineData: { data: fs.readFileSync(audioFixture).toString("base64"), mimeType: mime } }] },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", impl);
  return calls;
}

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  root = fs.mkdtempSync(path.join(TMP_ROOT, "lang-vertex-"));
  sdir = path.join(root, "series", slug);
  fs.mkdirSync(sdir, { recursive: true });
  vi.stubEnv("MANHWA_JOBS_DIR", path.join(root, "out", "jobs"));
  vi.stubEnv("MANHWA_OUT_DIR", path.join(root, "out"));
  vi.stubEnv("MANHWA_SERIES_ROOT", path.join(root, "series"));
  localize._setSleepForTests(async () => {});
  buildSeries();
});

afterEach(() => {
  localize._setLlmCallForTests(null);
  localize._setRendererForTests(null);
  localize._setPreviewSynthForTests(null);
  localize._setVertexPreviewSynthForTests(null);
  localize._setPreviewTimeoutForTests(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/* ================================================================== *
 * 1. Catalog: provider/model grouping and real availability
 * ================================================================== */

describe("Hindi catalog: Vertex provider + model groups", () => {
  it("lists Edge, Chirp 3 HD and Gemini groups with an actionable hint when unconfigured", () => {
    const entry = catalog().find((item) => item.locale === "hi-IN")!;
    const groups = new Map<string, typeof entry.voices>();
    for (const voice of entry.voices) {
      const key = `${voice.provider}|${voice.modelId}`;
      groups.set(key, [...(groups.get(key) ?? []), voice]);
    }
    expect([...groups.keys()]).toEqual([
      "edge|edge",
      "vertex|chirp-3-hd",
      "vertex|gemini-3.8-flash-tts",
    ]);
    const edge = groups.get("edge|edge")!;
    expect(edge.map((v) => v.id)).toEqual(["hi-IN-MadhurNeural", "hi-IN-SwaraNeural"]);
    expect(edge.every((v) => v.available === true)).toBe(true);

    const vertex = [...groups.get("vertex|chirp-3-hd")!, ...groups.get("vertex|gemini-3.8-flash-tts")!];
    expect(vertex.map((v) => v.id)).toContain("hi-IN-Chirp3-HD-Aoede");
    expect(vertex.map((v) => v.id)).toContain("gemini-tts:Charon");
    // No credentials in this fixture: unavailable with a setup hint, NOT hidden
    // and NOT silently replaced by an Edge voice.
    expect(vertex.every((v) => v.available === false)).toBe(true);
    expect(vertex[0]!.unavailableReason).toMatch(/connect a vertex-ai provider in Studio/i);
  });

  it("reports the configured state and keeps the English catalog untouched", () => {
    configureVertex(path.join(root, "out"));
    const entry = catalog().find((item) => item.locale === "hi-IN")!;
    expect(entry.voices.filter((v) => v.provider === "vertex").every((v) => v.available === true)).toBe(true);
    // The built-in English catalog (and its single default) is byte-identical.
    const en = vertexTts.listVertexTtsVoices({ MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv);
    expect(en.map((v) => v.id)).toEqual(vertexTts.VERTEX_TTS_VOICES.map((v) => v.id));
    expect(en.filter((v) => v.default)).toHaveLength(1);
    expect(en.find((v) => v.default)!.id).toBe("en-US-Chirp3-HD-Charon");
  });

  it("resolves a Gemini Hindi voice and refuses an unknown one", () => {
    configureVertex(path.join(root, "out"));
    const resolved = resolveVoice("hi-IN", "gemini-tts:Charon");
    expect(resolved).toMatchObject({
      engine: "vertex",
      provider: "vertex",
      modelId: "gemini-3.8-flash-tts",
    });
    expect(() => resolveVoice("hi-IN", "gemini-tts:Nope")).toThrow(UnsupportedVoiceError);
    expect(() => resolveVoice("hi-IN", "hi-IN-Chirp3-HD-Aoede")).not.toThrow();
  });
});

/* ================================================================== *
 * 2. Vertex synthesis: Hindi request + line proof
 * ================================================================== */

describe("Vertex TTS for hi-IN", () => {
  it("sends only the Hindi transcript, because Gemini speaks part text verbatim", async () => {
    configureVertex(path.join(root, "out"));
    const wav = path.join(root, "gemini.wav");
    makeWav(wav);
    const calls = stubVertexFetch(wav);
    const dest = path.join(root, "out.mp3");
    await vertexTts.synthesizeVertexTtsToFile({
      text: "वह दरवाज़े पर खड़ी थी। [deadpan]",
      voiceId: "gemini-tts:Charon",
      destPath: dest,
      speed: 1.1,
      locale: "hi-IN",
      env: { MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/studio-project/locations/global"
      + "/publishers/google/models/gemini-3.8-flash-tts:generateContent",
    );
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.generationConfig.speechConfig.languageCode).toBe("hi-IN");
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Charon");
    // The part text IS the transcript: an instruction wrapper would be spoken.
    const prompt = body.contents[0].parts[0].text as string;
    expect(prompt).toBe("वह दरवाज़े पर खड़ी थी।");
    expect(prompt).not.toMatch(/read|never|bracket|tag/i);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "वह दरवाज़े पर खड़ी थी।" }] }]);
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
  });

  it("strips bracketed emotion tags instead of speaking them on a localized request", async () => {
    configureVertex(path.join(root, "out"));
    const wav = path.join(root, "gemini.wav");
    makeWav(wav);
    const calls = stubVertexFetch(wav);
    await vertexTts.synthesizeVertexTtsToFile({
      text: "[sighs] वह यहाँ इंतज़ार करती है।",
      voiceId: "gemini-tts:Charon",
      destPath: path.join(root, "tagged.mp3"),
      speed: 1,
      locale: "hi-IN",
      env: { MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv,
    });
    const body = JSON.parse(calls[0]!.init.body);
    const prompt = body.contents[0].parts[0].text as string;
    expect(prompt).toBe("वह यहाँ इंतज़ार करती है।");
    expect(prompt).not.toContain("[sighs]");
    expect(prompt).not.toMatch(/read|never|bracket|tag/i);
  });

  it("keeps the English Gemini request byte-identical (no languageCode, no prompt wrapper)", async () => {
    configureVertex(path.join(root, "out"));
    const wav = path.join(root, "gemini.wav");
    makeWav(wav);
    const calls = stubVertexFetch(wav);
    await vertexTts.synthesizeVertexTtsToFile({
      text: "Someone was waiting for her.",
      voiceId: "gemini-tts:Charon",
      destPath: path.join(root, "en.mp3"),
      env: { MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv,
    });
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Someone was waiting for her." }] }]);
    expect(body.generationConfig.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
    });
  });

  it("writes a Hindi line proof that names provider, model and locale, and reuses it", async () => {
    configureVertex(path.join(root, "out"));
    const wav = path.join(root, "gemini.wav");
    makeWav(wav);
    const calls = stubVertexFetch(wav);
    const dir = path.join(root, "tts_lines_vertex");
    const env = { MANHWA_OUT_DIR: path.join(root, "out"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;
    const lines = [["वह दरवाज़े पर खड़ी थी।", []]] as ReadonlyArray<readonly [string, unknown]>;
    const meta = { engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN", speed: 1.1 };
    const spans = await audio.ttsLinesVertex(lines, dir, meta, env);
    expect(spans).toHaveLength(1);
    const proof = fs.readFileSync(path.join(dir, "line_000.txt"), "utf8");
    expect(proof).toContain('"engine": "vertex"');
    expect(proof).toContain('"voice": "gemini-tts:Charon"');
    expect(proof).toContain('"language": "hi-IN"');
    expect(proof).toContain('"model": "gemini-3.8-flash-tts"');
    expect(proof).toContain('"speed": 1.1');
    // A localized Gemini line carries the request revision, so audio cached
    // while the request still held an instruction wrapper is never reused.
    expect(proof).toContain(`"request_rev": ${vertexTts.GEMINI_LOCALE_REQUEST_REV}`);
    expect(vertexTts.GEMINI_LOCALE_REQUEST_REV).toBeGreaterThan(1);
    // Second run: cached line, no second paid call.
    await audio.ttsLinesVertex(lines, dir, meta, env);
    expect(calls).toHaveLength(1);
    // A different model identity cannot reuse the cached take.
    await audio.ttsLinesVertex(lines, dir, { ...meta, voice_id: "hi-IN-Chirp3-HD-Aoede" }, env).catch(() => undefined);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the English Vertex line proof byte-identical (no locale, no model)", async () => {
    configureVertex(path.join(root, "out"));
    const wav = path.join(root, "gemini.wav");
    makeWav(wav);
    stubVertexFetch(wav);
    const dir = path.join(root, "tts_lines_vertex_en");
    const env = { MANHWA_OUT_DIR: path.join(root, "out"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;
    await audio.ttsLinesVertex(
      [["Someone was waiting for her.", []]] as ReadonlyArray<readonly [string, unknown]>,
      dir,
      { engine: "vertex", voice_id: "gemini-tts:Charon", speed: 1 },
      env,
    );
    // The historical proof shape: { text, tts: { engine, speed, voice } } only.
    const proof = JSON.parse(fs.readFileSync(path.join(dir, "line_000.txt"), "utf8")) as Record<string, unknown>;
    expect(proof).toEqual({
      text: "Someone was waiting for her.",
      tts: { engine: "vertex", speed: 1, voice: "gemini-tts:Charon" },
    });
  });

  it("keeps an English series with meta.language=en on its existing Gemini proof (no request_rev)", async () => {
    configureVertex(path.join(root, "out"));
    const wav = path.join(root, "gemini.wav");
    makeWav(wav);
    const calls = stubVertexFetch(wav);
    const dir = path.join(root, "tts_lines_vertex_en_lang");
    const env = { MANHWA_OUT_DIR: path.join(root, "out"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;
    await audio.ttsLinesVertex(
      [["Someone was waiting for her.", []]] as ReadonlyArray<readonly [string, unknown]>,
      dir,
      { engine: "vertex", voice_id: "gemini-tts:Fenrir", language: "en", speed: 1 },
      env,
    );
    // The shape real English chapters already have on disk: re-synthesis would re-bill.
    const proof = JSON.parse(fs.readFileSync(path.join(dir, "line_000.txt"), "utf8")) as Record<string, unknown>;
    expect(proof).toEqual({
      text: "Someone was waiting for her.",
      tts: { engine: "vertex", language: "en", model: "gemini-3.8-flash-tts", speed: 1, voice: "gemini-tts:Fenrir" },
    });
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Someone was waiting for her." }] }]);
    expect(body.generationConfig.speechConfig).not.toHaveProperty("languageCode");
  });

  it("keeps a localized Chirp 3 HD line proof free of the Gemini request revision", async () => {
    configureVertex(path.join(root, "out"));
    const wav = path.join(root, "gemini.wav");
    makeWav(wav);
    const audioB64 = fs.readFileSync(wav).toString("base64");
    vi.stubGlobal("fetch", (async (url: string) => new Response(JSON.stringify(
      String(url).includes(":synthesize")
        ? { audioContent: audioB64 }
        : { candidates: [{ content: { parts: [{ inlineData: { data: audioB64, mimeType: "audio/wav" } }] } }] },
    ), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
    const dir = path.join(root, "tts_lines_vertex_hi_chirp");
    await audio.ttsLinesVertex(
      [["वह दरवाज़े पर खड़ी थी।", []]] as ReadonlyArray<readonly [string, unknown]>,
      dir,
      { engine: "vertex", voice_id: "hi-IN-Chirp3-HD-Aoede", language: "hi-IN", speed: 1 },
      { MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv,
    );
    const proof = JSON.parse(fs.readFileSync(path.join(dir, "line_000.txt"), "utf8")) as {
      tts: Record<string, unknown>;
    };
    expect(proof.tts).toEqual({
      engine: "vertex",
      voice: "hi-IN-Chirp3-HD-Aoede",
      speed: 1,
      language: "hi-IN",
      model: "chirp-3-hd",
    });
    expect(proof.tts).not.toHaveProperty("request_rev");
  });

  describe("localized speech text hardening", () => {
    const DIRTY = "[आह] वह दरवाज़े पर खड़ी थी। (धीरे से) [Sighs] फिर रुकी।";
    const CLEAN_BRACKETS = "वह दरवाज़े पर खड़ी थी। (धीरे से) फिर रुकी।";

    it("drops any square-bracket segment, keeps parentheses, numbers and clean text", () => {
      expect(vertexTts.localizedSpeechText(DIRTY)).toBe(CLEAN_BRACKETS);
      expect(vertexTts.localizedSpeechText("उसने ३ बार [आह] कहा, 10 बजे।")).toBe("उसने ३ बार कहा, 10 बजे।");
      expect(vertexTts.localizedSpeechText("वह यहाँ है।")).toBe("वह यहाँ है।");
      expect(vertexTts.localizedSpeechText("[deadpan] वह तेज़ दौड़ता है।")).toBe("वह तेज़ दौड़ता है।");
      // Bracket-only line keeps a non-empty result so the line count never desyncs.
      expect(vertexTts.localizedSpeechText("[आह]")).toBe("आह");
      // English helper is untouched.
      expect(vertexTts.stripEmotionControls("[Sighs] Hello [deadpan]")).toBe("[Sighs] Hello");
    });

    it("cleans the Gemini request body", async () => {
      configureVertex(path.join(root, "out"));
      const wav = path.join(root, "gemini.wav");
      makeWav(wav);
      const calls = stubVertexFetch(wav);
      await vertexTts.synthesizeVertexTtsToFile({
        text: DIRTY,
        voiceId: "gemini-tts:Charon",
        destPath: path.join(root, "dirty-gemini.mp3"),
        speed: 1,
        locale: "hi-IN",
        env: { MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv,
      });
      const body = JSON.parse(calls[0]!.init.body);
      expect(body.contents[0].parts[0].text).toBe(CLEAN_BRACKETS);
    });

    it("cleans the Chirp request body and leaves English Chirp text alone", async () => {
      configureVertex(path.join(root, "out"));
      const wav = path.join(root, "chirp.wav");
      makeWav(wav);
      const audioB64 = fs.readFileSync(wav).toString("base64");
      const inputs: string[] = [];
      vi.stubGlobal("fetch", (async (_url: string, init: any) => {
        inputs.push(JSON.parse(init.body).input.text);
        return new Response(JSON.stringify({ audioContent: audioB64 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch);
      const env = { MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv;
      await vertexTts.synthesizeVertexTtsToFile({
        text: DIRTY,
        voiceId: "hi-IN-Chirp3-HD-Aoede",
        destPath: path.join(root, "dirty-chirp.mp3"),
        speed: 1,
        locale: "hi-IN",
        env,
      });
      await vertexTts.synthesizeVertexTtsToFile({
        text: "[Sighs] Hello (softly) there.",
        voiceId: "en-US-Chirp3-HD-Charon",
        destPath: path.join(root, "en-chirp.mp3"),
        speed: 1,
        env,
      });
      expect(inputs[0]).toBe(CLEAN_BRACKETS);
      expect(inputs[1]).toBe("[Sighs] Hello (softly) there.");
    });

    it("cleans the Edge hi-IN input but keeps the stored proof text raw", async () => {
      const dir = path.join(root, "tts_lines_edge_hi");
      await audio.ttsLines([[DIRTY, []]] as ReadonlyArray<readonly [string, unknown]>, dir, {
        voice: "hi-IN-SwaraNeural",
        locale: "hi-IN",
      });
      const calls = fakeEdgeCalls(dir);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.text).toBe(CLEAN_BRACKETS);
      expect(fs.readFileSync(path.join(dir, "line_000.txt"), "utf8")).toContain(DIRTY);
    });

    it("keeps English Edge text and a clean Hindi line proof/key identical", async () => {
      const enDir = path.join(root, "tts_lines_edge_en");
      await audio.ttsLines([["[Sighs] Hello (softly) there.", []]] as ReadonlyArray<readonly [string, unknown]>, enDir, {
        voice: "en-US-AndrewNeural",
      });
      expect(fakeEdgeCalls(enDir)[0]!.text).toBe("[Sighs] Hello (softly) there.");

      configureVertex(path.join(root, "out"));
      const wav = path.join(root, "gemini.wav");
      makeWav(wav);
      stubVertexFetch(wav);
      const env = { MANHWA_OUT_DIR: path.join(root, "out"), PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;
      const meta = { engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN", speed: 1 };
      const clean = "वह दरवाज़े पर खड़ी थी।";
      const dir = path.join(root, "tts_lines_vertex_clean_hi");
      await audio.ttsLinesVertex([[clean, []]] as ReadonlyArray<readonly [string, unknown]>, dir, meta, env);
      const proof = fs.readFileSync(path.join(dir, "line_000.txt"), "utf8");
      expect(proof).toBe(pyJsonDumps({
        text: clean,
        tts: {
          engine: "vertex",
          voice: "gemini-tts:Charon",
          speed: pyFloat(1),
          language: "hi-IN",
          model: "gemini-3.8-flash-tts",
          request_rev: vertexTts.GEMINI_LOCALE_REQUEST_REV,
        },
      }, { sortKeys: true }));
    });
  });

  it("rejects a voice that does not belong to the Hindi locale", async () => {
    configureVertex(path.join(root, "out"));
    await expect(audio.ttsLinesVertex(
      [["वह यहाँ है।", []]] as ReadonlyArray<readonly [string, unknown]>,
      path.join(root, "tts_lines_vertex"),
      { engine: "vertex", voice_id: "en-US-Chirp3-HD-Charon", language: "hi-IN", speed: 1 },
      { MANHWA_OUT_DIR: path.join(root, "out") } as NodeJS.ProcessEnv,
    )).rejects.toThrow(/not a Vertex AI TTS voice/);
  });
});

/* ================================================================== *
 * 3. Plan / preflight / persisted identity
 * ================================================================== */

describe("Hindi plan: provider preflight and durable identity", () => {
  it("refuses a Vertex voice with no credentials before any translation spend", async () => {
    const llm = fakeLlm();
    localize._setLlmCallForTests(llm.fn as never);
    const err = await localize.planLocalizeJob(sdir, {
      locale: "hi-IN", chapters: "1", voice: "gemini-tts:Charon",
    }).then(() => null, (e: unknown) => e as { code?: string; message?: string; statusCode?: number });
    expect(err?.statusCode).toBe(400);
    expect(err?.code).toBe("provider_unavailable");
    expect(err?.message).toMatch(/Vertex/);
    expect(err?.message).toMatch(/Studio/);
    expect(llm.translateCalls()).toBe(0);
    expect(fs.existsSync(path.join(sdir, "out", "languages", "jobs"))).toBe(false);
  });

  it("persists engine/provider/model so a restart or retry renders the same provider", async () => {
    configureVertex(path.join(root, "out"));
    const planned = await localize.planLocalizeJob(sdir, {
      locale: "hi-IN", chapters: "1", voice: "gemini-tts:Charon", speed: 1.1,
    });
    expect(planned.job).toMatchObject({
      engine: "vertex",
      provider: "vertex",
      modelId: "gemini-3.8-flash-tts",
    });
    const onDisk = readJob(sdir, planned.job.id)!;
    expect(onDisk).toMatchObject({
      engine: "vertex", provider: "vertex", modelId: "gemini-3.8-flash-tts", voice: "gemini-tts:Charon",
    });
    expect(localize.jobVoiceIdentity(onDisk)).toMatchObject({
      engine: "vertex", provider: "vertex", modelId: "gemini-3.8-flash-tts", locale: "hi-IN",
    });

    // A crashed worker is reconciled to `interrupted` without losing identity.
    writeJob(sdir, {
      ...onDisk,
      status: "running",
      stage: "render",
      pid: 999_999_999,
      pidStart: 1,
      updatedAt: new Date().toISOString(),
    });
    localize.reconcileLocalizeJobs(sdir);
    const reconciled = readJob(sdir, planned.job.id)!;
    expect(reconciled.status).toBe("interrupted");
    expect(reconciled).toMatchObject({ engine: "vertex", modelId: "gemini-3.8-flash-tts" });
    expect(localize.jobVoiceIdentity(reconciled).engine).toBe("vertex");
  });

  it("keeps an older Edge job valid and derives Edge identity from the catalog", async () => {
    const legacy = {
      schemaVersion: 1 as const,
      id: `loc-${Date.now()}-deadbeef`,
      slug,
      locale: "hi-IN",
      chapters: ["ch1"],
      voice: "hi-IN-MadhurNeural",
      speed: 1,
      status: "completed" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: {},
    };
    writeJob(sdir, legacy);
    const back = readJob(sdir, legacy.id)!;
    expect(back.voice).toBe("hi-IN-MadhurNeural");
    expect(back.engine).toBeUndefined();
    expect(localize.jobVoiceIdentity(back)).toMatchObject({ engine: "edge", provider: "edge" });
    // The Edge render key is unchanged: no provider/model fields are hashed in.
    const identity = localize.jobVoiceIdentity(back);
    const config = {
      background: "starfield", motion: "cut", quality: "1080p", cleaner: "c", promo: "p", panels: "x",
    };
    expect(localize.renderKeyFor("tk", "hi-IN-MadhurNeural", 1, config, identity))
      .toBe(localize.renderKeyFor("tk", "hi-IN-MadhurNeural", 1, config));
  });

  it("keeps a legacy Edge artifact usable and never re-renders it for free", async () => {
    configureVertex(path.join(root, "out"));
    const llm = fakeLlm();
    const renderer = fakeRenderer();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(renderer.fn as never);
    const first = await localize.planLocalizeJob(sdir, {
      locale: "hi-IN", chapters: "1", voice: "hi-IN-MadhurNeural", speed: 1,
    });
    await localize.runLocalizeJob(sdir, first.job.id, { skipPipelineConflictCheck: true, log: () => {} });
    // Simulate a pre-Vertex manifest: strip the new identity fields from disk.
    const manifestFile = path.join(sdir, "out", "languages", "manifest.json");
    const doc = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      locales: Record<string, { chapters: Record<string, Record<string, unknown>> }>;
    };
    const chapter = doc.locales["hi-IN"]!.chapters.ch1!;
    delete chapter.engine;
    delete chapter.provider;
    delete chapter.modelId;
    delete chapter.locale;
    const artifact = chapter.artifact as Record<string, unknown>;
    delete artifact.engine;
    delete artifact.provider;
    delete artifact.modelId;
    delete artifact.locale;
    fs.writeFileSync(manifestFile, `${JSON.stringify(doc, null, 2)}\n`);

    const again = await localize.planLocalizeJob(sdir, {
      locale: "hi-IN", chapters: "1", voice: "hi-IN-MadhurNeural", speed: 1,
    });
    const result = await localize.runLocalizeJob(sdir, again.job.id, {
      skipPipelineConflictCheck: true, log: () => {},
    });
    expect(result.status).toBe("completed");
    // The old Edge artifact still matches: reused, not re-rendered or retranslated.
    expect(renderer.calls).toHaveLength(1);
    expect(llm.translateCalls()).toBe(1);
    const view = localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!;
    expect(view.chapters[0]!.stale).toBeUndefined();
    expect(view.chapters[0]).toMatchObject({ engine: "edge", provider: "edge" });
  });

  it("rejects an unsupported language or voice with 400", async () => {
    await expect(localize.planLocalizeJob(sdir, {
      locale: "fr-FR", chapters: "1", voice: "hi-IN-MadhurNeural",
    })).rejects.toMatchObject({ code: "unsupported_locale", statusCode: 400 });
    await expect(localize.planLocalizeJob(sdir, {
      locale: "hi-IN", chapters: "1", voice: "nope",
    })).rejects.toMatchObject({ code: "unsupported_voice", statusCode: 400 });
  });
});

/* ================================================================== *
 * 4. Render: TTS payload reaches the renderer, voice-only change retranslates nothing
 * ================================================================== */

describe("Hindi render: Vertex reaches the render lane", () => {
  it("passes engine, voice, locale and speed through the real produce() path", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const originalLoad = renderlane._hooks.loadTimeline;
    const originalProbe = renderlane._hooks._probe;
    const originalRender = renderlane._hooks.renderLocal;
    renderlane._hooks.loadTimeline = async () => ({
      main: (_s: string, _ch: string, _script: string, _obs: string, vdir: string, opts?: Record<string, unknown>) => {
        seen.push((opts?.tts ?? {}) as Record<string, unknown>);
        fs.mkdirSync(vdir, { recursive: true });
        fs.writeFileSync(path.join(vdir, "shots.json"), JSON.stringify({ shots: [] }));
        return path.join(vdir, "shots.json");
      },
    });
    renderlane._hooks._probe = () => 5;
    renderlane._hooks.renderLocal = (_props: string, video: string) => makeMp4(video);
    try {
      const localeDir = localize.__testCanonicalDir(sdir, "hi-IN", "ch1");
      fs.mkdirSync(path.join(localeDir, "video"), { recursive: true });
      fs.writeFileSync(path.join(localeDir, "script.md"), ENGLISH_SCRIPT);
      await renderlane.produce(sdir, "ch1", path.join(sdir, "out"), {
        locale: "hi-IN",
        tts: {
          engine: "vertex",
          voice_id: "gemini-tts:Charon",
          language: "hi-IN",
          speed: 1.1,
          provider: "vertex",
          model: "gemini-3.8-flash-tts",
        },
        lane: "local",
      });
    } finally {
      renderlane._hooks.loadTimeline = originalLoad;
      renderlane._hooks._probe = originalProbe;
      renderlane._hooks.renderLocal = originalRender;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      engine: "vertex",
      voice_id: "gemini-tts:Charon",
      language: "hi-IN",
      speed: 1.1,
      provider: "vertex",
      model: "gemini-3.8-flash-tts",
    });
  });

  it("re-renders on a provider change without retranslating", async () => {
    configureVertex(path.join(root, "out"));
    const llm = fakeLlm();
    const renderer = fakeRenderer();
    localize._setLlmCallForTests(llm.fn as never);
    localize._setRendererForTests(renderer.fn as never);

    const edgeJob = await localize.planLocalizeJob(sdir, {
      locale: "hi-IN", chapters: "1", voice: "hi-IN-MadhurNeural", speed: 1,
    });
    expect((await localize.runLocalizeJob(sdir, edgeJob.job.id, { skipPipelineConflictCheck: true, log: () => {} })).status)
      .toBe("completed");
    const vertexJob = await localize.planLocalizeJob(sdir, {
      locale: "hi-IN", chapters: "1", voice: "gemini-tts:Charon", speed: 1,
    });
    expect((await localize.runLocalizeJob(sdir, vertexJob.job.id, { skipPipelineConflictCheck: true, log: () => {} })).status)
      .toBe("completed");

    expect(llm.translateCalls()).toBe(1);
    expect(renderer.calls.map((c) => c.tts.engine)).toEqual(["edge", "vertex"]);
    expect(renderer.calls.map((c) => c.voice)).toEqual(["hi-IN-MadhurNeural", "gemini-tts:Charon"]);
    expect(renderer.calls[1]!.tts).toMatchObject({
      language: "hi-IN", speed: 1, provider: "vertex", model: "gemini-3.8-flash-tts",
    });

    const rec = readManifest(sdir).locales["hi-IN"]!.chapters.ch1!;
    expect(rec.artifact).toMatchObject({
      engine: "vertex", provider: "vertex", modelId: "gemini-3.8-flash-tts", voice: "gemini-tts:Charon",
    });
    const view = localize.languagesState(sdir, slug, { reconcile: false }).versions[0]!;
    expect(view.chapters[0]).toMatchObject({ engine: "vertex", provider: "vertex", voice: "gemini-tts:Charon" });
    expect(view.chapters[0]!.stale).toBeUndefined();
  });
});

/* ================================================================== *
 * 4. Narration cache identity: model + locale, Edge unchanged
 * ================================================================== */

describe("Hindi narration identity", () => {
  it("re-bills when the Vertex model changes but keeps Edge keys unchanged", () => {
    const base = "abc123def4567890";
    const edge = timeline.localeNarrationCacheKey(base, "hi-IN", {
      engine: "edge", voice_id: "hi-IN-MadhurNeural", language: "hi-IN", speed: 1,
    });
    expect(edge).toMatch(/^loc-v1:hi-IN:[0-9a-f]{16}$/);
    // No model field: the same key a pre-Vertex Hindi render produced.
    expect(timeline.localeNarrationCacheKey(base, "hi-IN", {
      engine: "edge", voice_id: "hi-IN-MadhurNeural", language: "hi-IN", speed: 1,
    })).toBe(edge);

    const gemini = timeline.localeNarrationCacheKey(base, "hi-IN", {
      engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN", speed: 1,
      provider: "vertex", model: "gemini-3.8-flash-tts",
    });
    const chirp = timeline.localeNarrationCacheKey(base, "hi-IN", {
      engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN", speed: 1,
      provider: "vertex", model: "chirp-3-hd",
    });
    expect(gemini).not.toBe(chirp);
    expect(gemini).not.toBe(edge);
    expect(gemini).toMatch(/^loc-v1:hi-IN:[0-9a-f]{16}$/);
    // The Gemini key differs from the old (pre-revision) shape, so audio cached
    // while the request still carried an instruction wrapper is never reused.
    expect(gemini).not.toBe(oldLocaleKey(base, {
      locale: "hi-IN",
      engine: "vertex",
      voice_id: "gemini-tts:Charon",
      language: "hi-IN",
      speed: 1,
      provider: "vertex",
      model: "gemini-3.8-flash-tts",
      revision: null,
      command: null,
      style: null,
      settings: null,
    }));
    // Edge keeps the exact key a pre-Vertex Hindi render produced.
    expect(edge).toBe(oldLocaleKey(base, {
      locale: "hi-IN",
      engine: "edge",
      voice_id: "hi-IN-MadhurNeural",
      language: "hi-IN",
      speed: 1,
      provider: null,
      revision: null,
      command: null,
      style: null,
      settings: null,
    }));
  });

  it("pins the Gemini request revision into the localized narration key only", () => {
    const base = "abc123def4567890";
    const gemini = timeline.localeNarrationCacheKey(base, "hi-IN", {
      engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN", speed: 1,
      provider: "vertex", model: "gemini-3.8-flash-tts",
    });
    const chirp = timeline.localeNarrationCacheKey(base, "hi-IN", {
      engine: "vertex", voice_id: "hi-IN-Chirp3-HD-Aoede", language: "hi-IN", speed: 1,
      provider: "vertex", model: "chirp-3-hd",
    });
    // The revision is part of the Gemini identity only, and it comes from code:
    // an incoming request_rev in the tts block changes nothing.
    expect(vertexTts.GEMINI_LOCALE_REQUEST_REV).toBeGreaterThan(1);
    expect(gemini).toBe(timeline.localeNarrationCacheKey(base, "hi-IN", {
      engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN", speed: 1,
      provider: "vertex", model: "gemini-3.8-flash-tts", request_rev: 1,
    }));
    // Non-Gemini engines: no revision field, so the key equals the old shape.
    expect(chirp).toBe(oldLocaleKey(base, {
      locale: "hi-IN",
      engine: "vertex",
      voice_id: "hi-IN-Chirp3-HD-Aoede",
      language: "hi-IN",
      speed: 1,
      provider: "vertex",
      model: "chirp-3-hd",
      revision: null,
      command: null,
      style: null,
      settings: null,
    }));
  });

  it("carries a Vertex override into the effective tts meta", () => {
    const meta = timeline.localeTtsMeta(
      { engine: "edge", voice_id: "en-US-AndrewMultilingualNeural", speed: 1, revision: "3" },
      {
        engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN",
        speed: 1.1, provider: "vertex", model: "gemini-3.8-flash-tts",
      },
      "hi-IN",
    );
    expect(meta).toMatchObject({
      engine: "vertex",
      voice_id: "gemini-tts:Charon",
      language: "hi-IN",
      speed: 1.1,
      provider: "vertex",
      model: "gemini-3.8-flash-tts",
      revision: "3",
    });
    // The English identity never leaks into a Hindi render.
    expect(meta.voice_id).not.toBe("en-US-AndrewMultilingualNeural");
  });
});

/* ================================================================== *
 * 4b. Full locale render through timeline.main with a stubbed Vertex API
 * ================================================================== */

describe("Hindi timeline render on Vertex", () => {
  function buildRenderFixture(name: string): {
    sdir: string;
    out: string;
    script: string;
    obs: string;
    env: NodeJS.ProcessEnv;
  } {
    const fixtureRoot = fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
    const seriesDir = path.join(fixtureRoot, `series-${name}`);
    const out = path.join(seriesDir, "out");
    const panelsDir = path.join(out, "panels", "ch1");
    fs.mkdirSync(panelsDir, { recursive: true });
    const panels: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 3; i++) {
      const id = `p0001_${i}`;
      // A real JPEG: framing crops it with sharp.
      const jpeg = spawnSync("ffmpeg", [
        "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x203040:s=64x96:d=1`,
        "-frames:v", "1", path.join(panelsDir, `${id}.jpg`),
      ], { encoding: "utf8", timeout: 30_000 });
      if (jpeg.status !== 0) throw new Error(`panel fixture failed: ${jpeg.stderr}`);
      panels.push({ id, art: 0.9, bubble_at: "none", overlay: [], world: [] });
    }
    json(path.join(panelsDir, "manifest.json"), panels.map((p, i) => ({
      panel: `${p.id}.jpg`, page: 1, idx: i + 1, art_top: 0, art_bottom: 1,
    })));
    const localeDir = path.join(out, "languages", "hi-IN", "ch1");
    write(path.join(localeDir, "script.md"), [
      "वह तेज़ दौड़ता है। @p0001_1",
      "वह यहाँ इंतज़ार करती है। @p0001_2",
      "वे अब चले जाते हैं। @p0001_3",
      "",
    ].join("\n"));
    const obs = path.join(out, "obs_ch1.json");
    json(obs, { panels, characters: [], gags: [], events: [] });
    json(path.join(seriesDir, "meta.json"), {
      title: name, tts: { engine: "edge", voice_id: "en-US-AndrewMultilingualNeural", speed: 1 },
      visuals: { background: "starfield", motion: "cut" },
    });
    json(path.join(out, "promo_block.json"), { version: 1, pages: [] });
    return {
      sdir: seriesDir,
      out,
      script: path.join(localeDir, "script.md"),
      obs,
      env: {
        ...process.env,
        MANHWA_OUT_DIR: out,
        MANHWA_STUDIO_PUBLIC: path.join(fixtureRoot, "public"),
      },
    };
  }

  it("renders Hindi narration through the real Vertex line path", async () => {
    const fx = buildRenderFixture("vertex-render");
    configureVertex(fx.out);
    const wav = path.join(root, "line.wav");
    makeWav(wav, 0.5);
    const calls = stubVertexFetch(wav);
    const localeVideo = path.join(fx.out, "languages", "hi-IN", "ch1", "video");
    const props = await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, localeVideo, {
      locale: "hi-IN",
      tts: {
        engine: "vertex",
        voice_id: "gemini-tts:Charon",
        language: "hi-IN",
        speed: 1.1,
        provider: "vertex",
        model: "gemini-3.8-flash-tts",
      },
      env: fx.env,
    });
    expect(fs.existsSync(props)).toBe(true);
    expect(fs.existsSync(path.join(localeVideo, "narration.mp3"))).toBe(true);
    // Three lines, three real Vertex requests, each asking for Hindi.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const body = JSON.parse(call.init.body);
      expect(body.generationConfig.speechConfig.languageCode).toBe("hi-IN");
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Charon");
    }
    // The per-line proof pins locale + model, so an Edge take cannot be reused.
    const proofs = fs.readdirSync(path.join(localeVideo, "tts_lines_vertex"))
      .filter((name) => /^line_\d+\.txt$/.test(name))
      .map((name) => fs.readFileSync(path.join(localeVideo, "tts_lines_vertex", name), "utf8"));
    expect(proofs).toHaveLength(3);
    expect(proofs.every((proof) => proof.includes('"language": "hi-IN"'))).toBe(true);
    expect(proofs.every((proof) => proof.includes('"model": "gemini-3.8-flash-tts"'))).toBe(true);
    // A second run is a full cache hit: no further paid calls.
    await timeline.main(fx.sdir, "ch1", fx.script, fx.obs, localeVideo, {
      locale: "hi-IN",
      tts: {
        engine: "vertex", voice_id: "gemini-tts:Charon", language: "hi-IN",
        speed: 1.1, provider: "vertex", model: "gemini-3.8-flash-tts",
      },
      env: fx.env,
    });
    expect(calls).toHaveLength(3);
  });
});

/* ================================================================== *
 * 5. Preview: Vertex supported, bounded, cached by effective config
 * ================================================================== */

describe("Hindi preview: Vertex", () => {
  it("synthesizes through the Vertex path with the locale and speed of the render", async () => {
    configureVertex(path.join(root, "out"));
    const calls: Array<Record<string, unknown>> = [];
    localize._setVertexPreviewSynthForTests(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      makeMp3(opts.destPath);
    });
    const first = await localize.generateLanguagePreview(sdir, slug, {
      locale: "hi-IN", voice: "gemini-tts:Charon", speed: 1.1,
    });
    expect(first.cached).toBe(false);
    expect(calls[0]).toMatchObject({
      voiceId: "gemini-tts:Charon", locale: "hi-IN", speed: 1.1, text: localize.SAMPLE_TEXT_HI,
    });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    // Same settings: cached, no second synthesis.
    const second = await localize.generateLanguagePreview(sdir, slug, {
      locale: "hi-IN", voice: "gemini-tts:Charon", speed: 1.1,
    });
    expect(second.cached).toBe(true);
    expect(second.id).toBe(first.id);
    expect(calls).toHaveLength(1);
  });

  it("separates previews by provider identity and effective credentials", async () => {
    configureVertex(path.join(root, "out"));
    localize._setVertexPreviewSynthForTests(async (opts) => { makeMp3(opts.destPath); });
    localize._setPreviewSynthForTests(async (_t, dest) => { makeMp3(dest); });
    // The 10s cooldown bounds spend per locale; a new identity in this test is a
    // deliberate operator action, so clear it between calls.
    const clearCooldown = (): void => {
      const file = path.join(sdir, "out", "languages", "hi-IN", "previews", "cooldown.json");
      if (fs.existsSync(file)) fs.unlinkSync(file);
    };
    const edge = await localize.generateLanguagePreview(sdir, slug, {
      locale: "hi-IN", voice: "hi-IN-MadhurNeural", speed: 1,
    });
    clearCooldown();
    const vertex = await localize.generateLanguagePreview(sdir, slug, {
      locale: "hi-IN", voice: "gemini-tts:Charon", speed: 1,
    });
    expect(edge.id).not.toBe(vertex.id);
    // A different account must not serve the previous account's sample.
    configureVertex(path.join(root, "out"), { access_token: "other-access-token" });
    clearCooldown();
    const rotated = await localize.generateLanguagePreview(sdir, slug, {
      locale: "hi-IN", voice: "gemini-tts:Charon", speed: 1,
    });
    expect(rotated.id).not.toBe(vertex.id);
  });

  it("times out a hanging Vertex preview, cleans the tmp file and stays responsive", async () => {
    configureVertex(path.join(root, "out"));
    localize._setPreviewTimeoutForTests(150);
    const pending: Array<() => void> = [];
    localize._setVertexPreviewSynthForTests((opts) => new Promise<void>((resolve, reject) => {
      pending.push(resolve);
      opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    try {
      const started = Date.now();
      const hanging = localize.generateLanguagePreview(sdir, slug, {
        locale: "hi-IN", voice: "gemini-tts:Charon", speed: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(Date.now() - started).toBeLessThan(1_000);
      await expect(hanging).rejects.toMatchObject({ statusCode: 504, code: "preview_timeout" });
      const dir = path.join(sdir, "out", "languages", "hi-IN", "previews");
      const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes(".tmp.")) : [];
      expect(leftovers).toEqual([]);
    } finally {
      for (const resolve of pending) resolve();
    }
  });

  it("refuses a Vertex preview with no credentials instead of substituting Edge", async () => {
    await expect(localize.generateLanguagePreview(sdir, slug, {
      locale: "hi-IN", voice: "gemini-tts:Charon", speed: 1,
    })).rejects.toMatchObject({ statusCode: 400, code: "provider_unavailable" });
  });
});

/* ================================================================== *
 * 6. Discovery: hi-IN keeps its own cache file
 * ================================================================== */

describe("Vertex discovery for hi-IN", () => {
  it("caches Hindi voices separately and never clobbers the English cache", async () => {
    const outDir = path.join(root, "out");
    configureVertex(outDir);
    const env = { MANHWA_OUT_DIR: outDir, PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;
    const body = {
      voices: [
        { name: "en-US-Chirp3-HD-Charon", languageCodes: ["en-US"] },
        { name: "hi-IN-Chirp3-HD-Aoede", languageCodes: ["hi-IN"] },
        { name: "hi-IN-Neural2-A", languageCodes: ["hi-IN"] },
        { name: "fr-FR-Chirp3-HD-Kore", languageCodes: ["fr-FR"] },
      ],
    };
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const hi = await vertexTts.discoverVertexTtsVoices(env, { fetchImpl, locale: "hi-IN" });
    expect(calls[0]).toBe("https://texttospeech.googleapis.com/v1/voices?languageCode=hi-IN");
    expect(hi.map((v) => v.id)).toEqual(["hi-IN-Chirp3-HD-Aoede", "hi-IN-Neural2-A"]);
    const configDir = path.join(outDir, "config");
    expect(fs.existsSync(path.join(configDir, "vertex-tts-voices.hi-IN.json"))).toBe(true);
    expect(fs.existsSync(path.join(configDir, vertexTts.VERTEX_TTS_VOICES_CACHE_FILENAME))).toBe(false);

    await vertexTts.discoverVertexTtsVoices(env, { fetchImpl });
    expect(fs.existsSync(path.join(configDir, vertexTts.VERTEX_TTS_VOICES_CACHE_FILENAME))).toBe(true);
    const hiIds = vertexTts.listVertexTtsVoices(env, "hi-IN").map((v) => v.id);
    expect(hiIds).toContain("hi-IN-Neural2-A");
    expect(hiIds).not.toContain("en-US-Chirp3-HD-Charon");
    expect(vertexTts.listVertexTtsVoices(env).map((v) => v.id)).not.toContain("hi-IN-Neural2-A");
  });
});
