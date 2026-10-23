import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  compressChapterNumbers,
  resolveLanguageChapters,
  defaultLanguageChapters,
  firstAvailableLanguageVoice,
  hasLanguageVideo,
  isLanguageVersionActive,
  LANGUAGE_SPEED_MAX,
  LANGUAGE_SPEED_MIN,
  languageChapterSpec,
  languageChapterWarnings,
  languageChapterNotes,
  languageChapterNotice,
  languageChapterStage,
  languageMediaUrl,
  languageProviderLabel,
  languageRetryGroups,
  languageVoiceGroups,
  languageVoiceUnavailableReason,
  mergeNewerSnapshot,
  languageExportControls,
  languageExportErrorLabel,
  isLanguageExportBusy,
  type LanguageExportState,
  type LanguageChapterVersion,
  type LanguageSourceChapter,
  type LanguageVersion,
  type LanguageVoice,
} from "../frontend/src/lib/languages.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PANEL = path.join(REPO_ROOT, "frontend/src/components/library/LanguageVersions.tsx");
const API = path.join(REPO_ROOT, "frontend/src/lib/api.ts");
const LANGUAGES = path.join(REPO_ROOT, "frontend/src/lib/languages.ts");
const LIBRARY = path.join(REPO_ROOT, "frontend/src/pages/LibraryPage.tsx");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Source with comments removed, so prose never satisfies or breaks a check. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

function version(partial: Partial<LanguageVersion> & { chapters?: LanguageChapterVersion[] }): LanguageVersion {
  return {
    locale: "hi-IN",
    label: "Hindi",
    status: "queued",
    chapters: [],
    ...partial,
  };
}

const VOICES = [
  { id: "hi-IN-MadhurNeural", label: "Madhur", engine: "edge" },
  { id: "hi-IN-SwaraNeural", label: "Swara", engine: "edge" },
];

describe("Hindi export controls", () => {
  const state = (patch: Partial<LanguageExportState> = {}): LanguageExportState => ({
    canMerge: true, canGenerateOutro: true,
    chapters: { finished: ["ch1", "ch2"], missing: [], stale: [] },
    busy: { merge: false, outro: false, job: false, jobId: null, message: null },
    merged: { stale: false }, ...patch,
  } as LanguageExportState);
  it("labels counts and re-merges without disabling gaps or older chapters", () => {
    expect(languageExportControls(state())).toMatchObject({ mergeLabel: "Merge 2", mergeDisabled: false, outroDisabled: false });
    expect(languageExportControls(state({ merged: { stale: true } as LanguageExportState["merged"] })).mergeLabel).toBe("Merge again");
    expect(languageExportControls(state({ chapters: { finished: [], missing: [], stale: [] } })).mergeDisabled).toBe(true);
    expect(languageExportControls(state({ chapters: { finished: ["ch1"], missing: [{ chapter: "ch2", reason: "Missing" }], stale: [{ chapter: "ch1", reason: "Older settings" }] } })).mergeDisabled).toBe(false);
  });
  it("locks both actions for chapter jobs, export jobs and pending requests", () => {
    for (const key of ["merge", "outro", "job"] as const) {
      const next = state(); next.busy[key] = true;
      expect(languageExportControls(next)).toMatchObject({ busy: true, mergeDisabled: true, outroDisabled: true });
      expect(isLanguageExportBusy(next)).toBe(key !== "job");
    }
    expect(languageExportControls(state(), true).mergeDisabled).toBe(true);
    const next = state(); next.busy.outro = true;
    expect(languageExportControls(next).status).toBe("Making Hindi outro…");
    expect(isLanguageExportBusy(null)).toBe(false);
  });
  it("honors capability flags even while idle", () => {
    expect(languageExportControls(state({ canMerge: false, canGenerateOutro: false }))).toMatchObject({ mergeDisabled: true, outroDisabled: true });
  });
  it("gives every conflict an actionable short label", () => {
    for (const code of ["job_active", "export_busy", "series_busy", "nothing_to_merge", "outro_missing", "source_missing"]) {
      expect(languageExportErrorLabel(code)).not.toBe("Export couldn’t start");
    }
    expect(languageExportErrorLabel("invalid_speed")).toBe("Check speed");
    expect(languageExportErrorLabel("unknown")).toBe("Export couldn’t start");
  });
});

/** Catalog as the server now returns it: Edge, Vertex Chirp and Vertex Gemini. */
const GROUPED_VOICES: LanguageVoice[] = [
  { id: "hi-IN-MadhurNeural", label: "Madhur", engine: "edge", provider: "edge", modelId: "edge", modelLabel: "Edge", available: true },
  { id: "hi-IN-SwaraNeural", label: "Swara", engine: "edge", provider: "edge", modelId: "edge", modelLabel: "Edge", available: true },
  {
    id: "hi-IN-Chirp3-HD-Aoede", label: "Aoede · Chirp 3 HD", engine: "vertex", provider: "vertex",
    modelId: "chirp-3-hd", modelLabel: "Chirp 3 HD", available: false,
    unavailableReason: "Connect a Vertex AI provider in Studio (Providers → Vertex AI) to use Vertex voices.",
  },
  {
    id: "gemini-tts:Charon", label: "Charon · Gemini 3.8 Flash TTS", engine: "vertex", provider: "vertex",
    modelId: "gemini-3.8-flash-tts", modelLabel: "Gemini 3.8 Flash TTS", available: false,
    unavailableReason: "Connect a Vertex AI provider in Studio (Providers → Vertex AI) to use Vertex voices.",
  },
];

describe("Hindi chapter batches", () => {
  const source = Array.from({ length: 27 }, (_, index) => ({
    chapter: `ch${index + 1}`, eligible: index !== 6 && index !== 25,
  }));

  it("compresses ranges without filling gaps", () => {
    expect(compressChapterNumbers(Array.from({ length: 25 }, (_, index) => index + 1).concat(27)))
      .toBe("1-25,27");
    expect(compressChapterNumbers([])).toBe("");
  });

  it("sorts, deduplicates and excludes invalid chapter numbers", () => {
    expect(compressChapterNumbers([3, 1, 2, 3, 7, 0, -1, 1.5, Infinity, NaN])).toBe("1-3,7");
    expect(resolveLanguageChapters("3,1-3,2", source)).toMatchObject({ numbers: [1, 2, 3], value: "1-3" });
  });

  it("skips missing and ineligible chapters while preserving ordered batches", () => {
    expect(resolveLanguageChapters("5-8,30", source)).toEqual({
      numbers: [5, 6, 8], skipped: [7, 30], value: "5-6,8",
    });
  });

  it("resolves all to eligible chapters only", () => {
    const result = resolveLanguageChapters(" ALL ", source);
    expect(result.numbers).toHaveLength(25);
    expect(result.value).toBe("1-6,8-25,27");
    expect(result.skipped).toEqual([]);
  });

  it("supports clearing and selections containing no eligible chapter", () => {
    expect(resolveLanguageChapters("", source)).toEqual({ numbers: [], skipped: [], value: "" });
    expect(resolveLanguageChapters("7,30", source)).toEqual({ numbers: [], skipped: [7, 30], value: "" });
    expect(resolveLanguageChapters("all", [])).toEqual({ numbers: [], skipped: [], value: "" });
  });

  it("caps explicit and all selections at 500 without silent truncation", () => {
    const many = Array.from({ length: 501 }, (_, index) => ({ chapter: `ch${index + 1}`, eligible: true }));
    expect(resolveLanguageChapters("1-500", many).numbers).toHaveLength(500);
    expect(resolveLanguageChapters("1-501", many).error).toBeTruthy();
    expect(resolveLanguageChapters("all", many).error).toBeTruthy();
    expect(resolveLanguageChapters("all", many.slice(0, 500)).numbers).toHaveLength(500);
    expect(resolveLanguageChapters("1-300,1-300", many).error).toBeTruthy();
  });

  it("rejects malformed and unsafe integer ranges before expansion", () => {
    for (const spec of ["3-1", "1,,3", "0", "banana", "9007199254740992-9007199254740994"]) {
      expect(resolveLanguageChapters(spec, source)).toMatchObject({ numbers: [], value: "", error: expect.any(String) });
    }
  });
});

describe("Hindi language versions — request contract", () => {
  it("uses the exact language endpoints and no invented routes", () => {
    const api = read(API);
    expect(api).toContain("`/api/series/${enc(slug)}/languages`");
    expect(api).toContain("`/api/series/${enc(slug)}/languages/preview`");
    const languageBlock = api.slice(api.indexOf("languages(slug: string"), api.indexOf("getOutro(slug: string)"));
    expect(languageBlock).not.toContain("/api/intake/preview");
    expect(code(LANGUAGES)).not.toContain("/api/");
  });

  it("uses the server's canonical videoUrl instead of rebuilding a cache bust", () => {
    const canonical = "/media/azure-chronicles/languages/hi-IN/ch1/video.mp4?rev=7";
    const fallback = { slug: "azure-chronicles", locale: "hi-IN", chapter: "ch1" };
    expect(languageMediaUrl(canonical, fallback)).toBe(canonical);
    expect(languageMediaUrl(canonical, fallback, true)).toBe(`${canonical}&download=1`);
    expect(languageMediaUrl(undefined, fallback)).toBe(
      "/media/azure-chronicles/languages/hi-IN/ch1/video.mp4",
    );
    expect(languageMediaUrl(undefined, fallback, true)).toBe(
      "/media/azure-chronicles/languages/hi-IN/ch1/video.mp4?download=1",
    );
    expect(hasLanguageVideo({ chapter: "ch1", status: "failed", videoUrl: canonical })).toBe(true);
    expect(hasLanguageVideo({ chapter: "ch1", status: "failed" })).toBe(false);
  });

  it("surfaces chapter warnings from the renderer", () => {
    expect(languageChapterWarnings({ chapter: "ch1", status: "completed", warnings: [" dropped panel p3 ", ""] }))
      .toEqual(["dropped panel p3"]);
    expect(languageChapterWarnings({ chapter: "ch1", status: "completed" })).toEqual([]);
  });

  it("keeps deterministic source advisories out of actionable video warnings", () => {
    const review = [
      "UNGROUNDED (4w): a script paraphrase [words]", "LORE IMPORT: world text",
      "DUB: dialogue", "SCREENREADER: narration", "CAPTION: observation", "MULTI: overlap",
      "report.json listed 2 issue(s), but the deterministic check on the current script passes.",
    ];
    const actionable = ["Missing audio segment", "Render fallback used", "dropped panel p3", "Unknown renderer warning"];
    expect(languageChapterNotes({ chapter: "ch1", status: "completed", warnings: [...review, ...actionable, review[0]!, " "] }))
      .toEqual({ review, actionable });
    expect(languageChapterNotes({ chapter: "ch1", status: "completed" })).toEqual({ review: [], actionable: [] });
  });

  it("shows one notice with failure, stale, then actionable warning priority", () => {
    const chapter: LanguageChapterVersion = {
      chapter: "ch1", status: "failed", stage: "translate", error: "RAW_VALIDATION_FAILURE", stale: true,
      warnings: ["Missing audio segment", "UNGROUNDED (4w): source advisory"],
    };
    expect(languageChapterNotice(chapter)).toEqual({ tone: "danger", text: "Failed at translate" });
    expect(languageChapterNotice({ ...chapter, status: "completed", error: undefined }))
      .toEqual({ tone: "warning", text: "Older version · Generate again to update" });
    expect(languageChapterNotice({ ...chapter, status: "completed", error: undefined, stale: false }))
      .toEqual({ tone: "warning", text: "Check generated video" });
    expect(languageChapterNotice({ chapter: "ch1", status: "completed", warnings: ["UNGROUNDED (4w): advisory"] })).toBeNull();
    expect(languageChapterNotice({ chapter: "ch3", status: "completed" })).toBeNull();
    expect(languageChapterNotice({ chapter: "ch1", status: "failed", stage: "RAW_STAGE_WITH_INTERNAL_ID" })?.text)
      .toBe("Generation failed");
    expect(languageChapterNotice({ chapter: "ch1", status: "interrupted", stale: true })?.text).toBe("Generation interrupted");
    expect(languageChapterStage("translate")).toBe("Translating");
    expect(languageChapterStage("RAW_STAGE_WITH_INTERNAL_ID")).toBe("");
  });

  it("keeps the pure helpers free of browser globals for backend typecheck", () => {
    const pure = code(LANGUAGES);
    expect(pure).not.toMatch(/\bwindow\b|\bdocument\b|\bfetch\(|XMLHttpRequest/);
    const api = read(API);
    expect(api).toContain('from "./languages"');
  });

  it("defaults to one eligible chapter, never all of them", () => {
    const source: LanguageSourceChapter[] = [
      { chapter: "ch1", eligible: false, reason: "English video missing" },
      { chapter: "ch2", eligible: true },
      { chapter: "ch3", eligible: true },
    ];
    expect(defaultLanguageChapters(source)).toBe("2");
    expect(defaultLanguageChapters([])).toBe("");
    expect(defaultLanguageChapters([{ chapter: "ch1", eligible: false, reason: "no render" }])).toBe("");
  });

  it("accepts comma lists and sends exact chapter numbers", () => {
    expect(languageChapterSpec("1")).toEqual({ ok: true, value: "1", numbers: [1] });
    expect(languageChapterSpec(" 1 - 3 ")).toEqual({ ok: true, value: "1-3", numbers: [1, 2, 3] });
    expect(languageChapterSpec("1,3")).toEqual({ ok: true, value: "1,3", numbers: [1, 3] });
    expect(languageChapterSpec("3, 1")).toEqual({ ok: true, value: "1,3", numbers: [1, 3] });
    expect(languageChapterSpec("1,3,3")).toEqual({ ok: true, value: "1,3", numbers: [1, 3] });
    expect(languageChapterSpec("all")).toEqual({ ok: true, value: "all", numbers: [] });
    // A non-contiguous retry never widens into a range.
    expect(languageChapterSpec("1,3").ok && languageChapterSpec("1,3")).not.toMatchObject({ value: "1-3" });
  });

  it("rejects malformed chapter specs before any request", () => {
    expect(languageChapterSpec("")).toMatchObject({ ok: false });
    expect(languageChapterSpec("0")).toMatchObject({ ok: false });
    expect(languageChapterSpec("3-1")).toMatchObject({ ok: false });
    expect(languageChapterSpec("1,,3")).toMatchObject({ ok: false });
    expect(languageChapterSpec("1,abc")).toMatchObject({ ok: false });
    expect(languageChapterSpec("abc")).toMatchObject({ ok: false });
  });

  it("caps the TOTAL chapter count, not each range token", () => {
    // 300 + 300 would exceed the server's 500 cap even though each range passes.
    expect(languageChapterSpec("1-300,1-300")).toMatchObject({ ok: false });
    expect(languageChapterSpec("1-500")).toMatchObject({ ok: true });
    expect(languageChapterSpec("1-250,251-500")).toMatchObject({ ok: true });
  });

  it("keeps the speed range aligned with the backend", () => {
    expect(LANGUAGE_SPEED_MIN).toBe(0.5);
    expect(LANGUAGE_SPEED_MAX).toBe(2);
  });

  it("treats only queued or running work as active", () => {
    expect(isLanguageVersionActive(version({ status: "queued" }))).toBe(true);
    expect(isLanguageVersionActive(version({ status: "running" }))).toBe(true);
    expect(
      isLanguageVersionActive(version({ status: "completed", chapters: [{ chapter: "ch1", status: "running" }] })),
    ).toBe(true);
    expect(isLanguageVersionActive(version({ status: "completed" }))).toBe(false);
    expect(isLanguageVersionActive(version({ status: "failed" }))).toBe(false);
    expect(isLanguageVersionActive(version({ status: "interrupted" }))).toBe(false);
  });
});

describe("Hindi language versions — retry settings", () => {
  it("retries only the failed chapters, keeping non-contiguous numbers exact", () => {
    const plan = languageRetryGroups(
      version({
        status: "failed",
        chapters: [
          { chapter: "ch1", status: "failed", voice: "hi-IN-MadhurNeural", speed: 1 },
          { chapter: "ch2", status: "completed", voice: "hi-IN-MadhurNeural", speed: 1 },
          { chapter: "ch3", status: "interrupted", voice: "hi-IN-MadhurNeural", speed: 1 },
        ],
      }),
      VOICES,
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      locale: "hi-IN",
      voice: "hi-IN-MadhurNeural",
      speed: 1,
      chapters: "1,3",
    });
    expect(plan.groups[0]!.chapterNames).toEqual(["ch1", "ch3"]);
  });

  it("reuses each chapter's saved voice and speed, never the modal default", () => {
    const plan = languageRetryGroups(
      version({
        status: "failed",
        chapters: [
          { chapter: "ch1", status: "failed", voice: "hi-IN-SwaraNeural", speed: 1.25 },
          { chapter: "ch2", status: "completed", voice: "hi-IN-MadhurNeural", speed: 1 },
        ],
      }),
      VOICES,
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ voice: "hi-IN-SwaraNeural", speed: 1.25, chapters: "1" });
  });

  it("splits chapters with different saved settings into separate requests", () => {
    const plan = languageRetryGroups(
      version({
        status: "failed",
        chapters: [
          { chapter: "ch1", status: "failed", voice: "hi-IN-SwaraNeural", speed: 1.25 },
          { chapter: "ch2", status: "failed", voice: "hi-IN-MadhurNeural", speed: 1 },
          { chapter: "ch3", status: "failed", voice: "hi-IN-SwaraNeural", speed: 1.25 },
        ],
      }),
      VOICES,
    );
    expect(plan.groups).toHaveLength(2);
    const swara = plan.groups.find((group) => group.voice === "hi-IN-SwaraNeural");
    const madhur = plan.groups.find((group) => group.voice === "hi-IN-MadhurNeural");
    expect(swara).toMatchObject({ speed: 1.25, chapters: "1,3" });
    expect(madhur).toMatchObject({ speed: 1, chapters: "2" });
  });

  it("falls back to the version-level settings and refuses to guess when they are missing", () => {
    const withFallback = languageRetryGroups(
      version({
        status: "failed",
        voice: "hi-IN-SwaraNeural",
        speed: 1.25,
        chapters: [{ chapter: "ch1", status: "failed" }],
      }),
      VOICES,
    );
    expect(withFallback.groups[0]).toMatchObject({ voice: "hi-IN-SwaraNeural", speed: 1.25 });

    const unknown = languageRetryGroups(
      version({ status: "failed", chapters: [{ chapter: "ch1", status: "failed" }] }),
      VOICES,
    );
    expect(unknown.groups).toHaveLength(0);
    expect(unknown.unknown.map((chapter) => chapter.chapter)).toEqual(["ch1"]);
  });

  it("does not retry completed or running chapters", () => {
    const plan = languageRetryGroups(
      version({
        status: "completed",
        chapters: [
          { chapter: "ch1", status: "completed", voice: "hi-IN-MadhurNeural", speed: 1 },
          { chapter: "ch2", status: "running", voice: "hi-IN-MadhurNeural", speed: 1 },
        ],
      }),
      VOICES,
    );
    expect(plan.groups).toHaveLength(0);
    expect(plan.unknown).toHaveLength(0);
  });
});

describe("Hindi language versions — provider/model picker", () => {
  it("groups voices by provider and model, keeping unavailable ones visible", () => {
    const groups = languageVoiceGroups(GROUPED_VOICES);
    expect(groups.map((group) => group.id)).toEqual(["edge", "chirp-3-hd", "gemini-3.8-flash-tts"]);
    expect(groups.map((group) => group.label)).toEqual(["Edge", "Vertex · Chirp 3 HD", "Vertex · Gemini 3.8 Flash TTS"]);
    expect(groups.map((group) => group.available)).toEqual([true, false, false]);
    expect(groups[1]!.unavailableReason).toMatch(/connect a Vertex AI provider in Studio/i);
    // Every voice stays selectable-by-list: nothing is dropped or replaced.
    expect(groups.flatMap((group) => group.voices).map((voice) => voice.id))
      .toEqual(GROUPED_VOICES.map((voice) => voice.id));
  });

  it("groups the multilingual Gemini voices under Vertex, not under a fake locale id", () => {
    const groups = languageVoiceGroups(GROUPED_VOICES);
    const gemini = groups.find((group) => group.id === "gemini-3.8-flash-tts")!;
    expect(gemini.provider).toBe("vertex");
    expect(gemini.providerLabel).toBe("Vertex");
    expect(gemini.voices.map((voice) => voice.id)).toEqual(["gemini-tts:Charon"]);
    expect(languageProviderLabel(undefined, "vertex")).toBe("Vertex");
    expect(languageProviderLabel("edge")).toBe("Edge");
  });

  it("marks a partially configured group unavailable, not configured", () => {
    const partial: LanguageVoice[] = [
      { ...GROUPED_VOICES[2]!, available: true, unavailableReason: undefined },
      { ...GROUPED_VOICES[2]!, id: "hi-IN-Chirp3-HD-Kore", available: false, unavailableReason: "no project id" },
    ];
    const [group] = languageVoiceGroups(partial);
    expect(group!.available).toBe(false);
    expect(group!.unavailableReason).toBe("no project id");
    expect(firstAvailableLanguageVoice(partial)).toBe("hi-IN-Chirp3-HD-Aoede");
  });

  it("never preselects an unavailable voice and explains why one is blocked", () => {
    expect(firstAvailableLanguageVoice(GROUPED_VOICES)).toBe("hi-IN-MadhurNeural");
    const onlyVertex: LanguageVoice[] = GROUPED_VOICES.filter((voice) => voice.provider === "vertex");
    expect(firstAvailableLanguageVoice(onlyVertex)).toBe("");
    expect(languageVoiceUnavailableReason(onlyVertex, "gemini-tts:Charon")).toMatch(/Vertex/);
    expect(languageVoiceUnavailableReason(GROUPED_VOICES, "hi-IN-MadhurNeural")).toBe("");
  });

  it("preselects a configured Vertex voice when no Edge voice exists", () => {
    const configured: LanguageVoice[] = [
      { ...GROUPED_VOICES[2]!, available: true, unavailableReason: undefined },
      { ...GROUPED_VOICES[3]!, available: true, unavailableReason: undefined },
    ];
    expect(firstAvailableLanguageVoice(configured)).toBe("hi-IN-Chirp3-HD-Aoede");
  });

  it("carries saved provider identity into a retry group", () => {
    const plan = languageRetryGroups(
      version({
        status: "failed",
        chapters: [{
          chapter: "ch1", status: "failed", voice: "gemini-tts:Charon", speed: 1.1,
          engine: "vertex", provider: "vertex", modelId: "gemini-3.8-flash-tts",
        }],
      }),
      GROUPED_VOICES,
    );
    expect(plan.groups[0]).toMatchObject({
      voice: "gemini-tts:Charon", speed: 1.1, chapters: "1",
      engine: "vertex", provider: "vertex", modelId: "gemini-3.8-flash-tts",
    });
  });
});

describe("Hindi language versions — panel wiring", () => {
  const panel = read(PANEL);

  it("offers Hindi only and filters the server catalog", () => {
    expect(panel).toContain('const SUPPORTED_LOCALES = ["hi-IN"] as const;');
    expect(panel).toContain("(SUPPORTED_LOCALES as readonly string[]).includes(entry.locale)");
  });

  it("states that original artwork text is unchanged", () => {
    expect(panel).toContain("Original artwork text stays unchanged.");
  });

  it("shows ineligible English chapters with their reason", () => {
    expect(panel).toContain("ineligibleChapters");
    expect(panel).toContain("chapter.reason || \"Not rendered in English yet.\"");
  });

  it("keeps stale renders playable and labels them stale", () => {
    expect(panel).toContain("chapter.stale");
    expect(panel).toContain("The old Hindi video is still playable");
    expect(panel).toContain("const playable = hasLanguageVideo(chapter);");
    expect(panel).not.toContain("English source changed after this render");
    expect(panel).not.toContain('title="Source changed"');
  });

  it("stacks chapter content instead of letting sr-row create parallel cards", () => {
    expect(panel).toContain('className="sr-row min-w-0 flex-col items-stretch');
    expect(panel).toContain("sm:flex-row sm:items-center sm:justify-between");
    expect(panel).toContain("languageChapterNotice(chapter)");
    expect(panel).toContain("Review notes ({notes.review.length})");
    expect(panel).not.toContain('title="Render warnings"');
    const chapterBlock = panel.slice(panel.indexOf("activeVersion.chapters.map"), panel.indexOf("{privileged && (retryPlan"));
    expect(chapterBlock.match(/<details\b/g)).toHaveLength(1);
    expect(chapterBlock).not.toMatch(/<details[^>]*\bopen\b/);
    expect(chapterBlock).not.toContain("<Notice");
  });

  it("retries with saved settings per group instead of modal state", () => {
    expect(panel).toContain("languageRetryGroups(activeVersion, voices)");
    expect(panel).toContain("voice: group.voice");
    expect(panel).toContain("speed: group.speed");
    expect(panel).toContain("chapters: group.chapters");
    expect(panel).not.toMatch(/retrySpec/);
  });

  it("invalidates previews on voice, speed, locale and close", () => {
    expect(panel).toContain("previewKey.current");
    expect(panel).toContain("}, [locale, voice, speed]);");
    expect(panel).toContain("previewKey.current !== requestKey");
  });

  it("cancels reads on unmount, slug change and around a POST", () => {
    expect(panel).toContain("invalidateReads()");
    expect(panel).toContain("api.series.languages(requested, controller.signal)");
    expect(panel).toContain("mergeNewerSnapshot(current, next)");
  });

  it("has honest speed and cost copy", () => {
    expect(panel).toContain("1 is this Hindi voice’s normal speed.");
    expect(panel).not.toContain("English narration pace");
    expect(panel).not.toContain("reused for free");
    expect(panel).toContain("reused from cache only when its English source");
    // A provider change is a re-render, not a re-translation: say so.
    expect(panel).toContain("voice/provider/speed settings");
  });

  it("renders the grouped provider/model picker instead of a flat voice list", () => {
    expect(panel).toContain("languageVoiceGroups(voiceOptions)");
    expect(panel).toContain("<optgroup");
    expect(panel).toContain("group.label");
    expect(panel).toContain("not configured");
    expect(panel).toContain("firstAvailableLanguageVoice");
    expect(panel).toContain("languageVoiceUnavailableReason(voiceOptions, voice)");
    // An unconfigured provider disables generation and preview with the reason.
    expect(panel).toContain("Boolean(voiceBlockedReason)");
  });

  it("refuses a retry whose saved provider no longer serves that voice", () => {
    // A retry must not silently render on a different engine than the one the
    // user is retrying: the drift is surfaced instead.
    expect(panel).toContain("group.provider !== current.provider");
    expect(panel).toContain("Generate the chapter again to choose settings.");
  });

  it("ignores a stale submit response from an older request", () => {
    expect(panel).toContain("submitSeq.current");
    expect(panel).toContain("seq !== submitSeq.current");
  });

  it("does not let a snapshot without a timestamp replace a dated one", () => {
    const dated = { ...version({ status: "running" }), updatedAt: "2026-10-20T12:00:00.000Z" };
    const incoming = {
      ok: true,
      slug: "s",
      catalog: [],
      sourceChapters: [],
      versions: [{ ...version({ status: "completed" }), updatedAt: "" }],
    };
    expect(mergeNewerSnapshot({ ...incoming, versions: [dated] }, incoming).versions[0]!.status).toBe("running");
  });

  it("is wired into the series page without replacing the English chapter list", () => {
    const library = read(LIBRARY);
    expect(library).toContain("import { LanguageVersions }");
    const panelIndex = library.indexOf("<LanguageVersions");
    const chaptersIndex = library.indexOf('<section aria-label="Chapters">');
    expect(panelIndex).toBeGreaterThan(-1);
    expect(chaptersIndex).toBeGreaterThan(panelIndex);
  });
});
