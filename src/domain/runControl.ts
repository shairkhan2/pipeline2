/**
 * Cooperative run control: pause at safe points, and which script file a TTS
 * engine reads.
 *
 * A paused run finishes its current step, then exits with RUN_PAUSED_EXIT_CODE.
 * The intake worker records the job as "paused". Resume starts a new run that
 * reuses every cache, so it continues from where it stopped.
 */
import fs from "node:fs";
import path from "node:path";

/** Exit code a run uses after it stopped at a safe point because a pause was requested. */
export const RUN_PAUSED_EXIT_CODE = 75;

/** Env var naming the run's pause-request file. */
export const PAUSE_FILE_ENV = "MANHWA_PAUSE_FILE";

/** Env var carrying the intake job id into the run, for telemetry and pause control. */
export const JOB_ID_ENV = "MANHWA_JOB_ID";

/** Pause-request file for an intake job: `<jobsDir>/<jobId>.pause`. */
export function pauseFileFor(jobsDir: string, jobId: string): string {
  return path.join(jobsDir, `${jobId}.pause`);
}

/** True when the pause file named by MANHWA_PAUSE_FILE exists. */
export function pauseRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = String(env[PAUSE_FILE_ENV] ?? "").trim();
  return file.length > 0 && fs.existsSync(file);
}

/** Thrown at a safe point when a pause was requested. */
export class RunPausedError extends Error {
  readonly paused = true;
  /** Never a chapter failure: the chapter is retried on resume. */
  readonly permanent = false;
  readonly where: string;
  constructor(where: string) {
    super(`Run paused at a safe point (${where})`);
    this.name = "RunPausedError";
    this.where = where;
  }
}

export function isRunPausedError(e: unknown): e is RunPausedError {
  return e instanceof RunPausedError
    || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "RunPausedError");
}

/** Throw RunPausedError when a pause was requested. Call only at safe points. */
export function checkpoint(where: string, env: NodeJS.ProcessEnv = process.env): void {
  if (pauseRequested(env)) throw new RunPausedError(where);
}

/** Engine groups that share one script file. */
export function scriptFileForEngine(engine: string): "script_eleven.md" | "script_voice.md" | "script.md" {
  const e = String(engine ?? "").trim().toLowerCase();
  if (e === "eleven" || e === "elevenlabs") return "script_eleven.md";
  if (e === "external") return "script_voice.md";
  return "script.md";
}

export interface ScriptChoice {
  /** Path the engine should read. It may not exist. */
  path: string;
  /** Script file name the engine prefers. */
  preferred: string;
  /** True when another engine group's script was picked because the preferred one is missing. */
  fallback: boolean;
  /** True when inline [tag] delivery tags must be removed before synthesis. */
  stripTags: boolean;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The script a chapter should be voiced from with `engine`. The preferred file
 * wins. Otherwise another engine group's script is reused, so a provider
 * switch never reruns the writer. Tags are stripped when a tagged script feeds
 * an engine that would read them aloud.
 */
export function chooseChapterScript(
  chapterDir: string,
  engine: string,
  opts: { engineSupportsTags?: boolean } = {},
): ScriptChoice {
  const preferred = scriptFileForEngine(engine);
  const engineTags = opts.engineSupportsTags ?? preferred !== "script.md";
  const preferredPath = path.join(chapterDir, preferred);
  if (isFile(preferredPath)) {
    return { path: preferredPath, preferred, fallback: false, stripTags: preferred !== "script.md" && !engineTags };
  }
  for (const name of ["script_eleven.md", "script_voice.md", "script.md"]) {
    if (name === preferred) continue;
    const candidate = path.join(chapterDir, name);
    if (!isFile(candidate)) continue;
    return { path: candidate, preferred, fallback: true, stripTags: name !== "script.md" && !engineTags };
  }
  return { path: preferredPath, preferred, fallback: false, stripTags: false };
}
