import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_PAUSED_EXIT_CODE,
  RunPausedError,
  checkpoint,
  chooseChapterScript,
  isRunPausedError,
  pauseFileFor,
  pauseRequested,
  scriptFileForEngine,
} from "../src/domain/runControl.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "run-control-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("pause requests", () => {
  it("follows the pause file named by MANHWA_PAUSE_FILE", () => {
    const d = tmp();
    const file = pauseFileFor(d, "job-1-abc");
    expect(file).toBe(path.join(d, "job-1-abc.pause"));
    const env = { MANHWA_PAUSE_FILE: file } as NodeJS.ProcessEnv;
    expect(pauseRequested(env)).toBe(false);
    expect(() => checkpoint("chapter ch2", env)).not.toThrow();
    fs.writeFileSync(file, "{}");
    expect(pauseRequested(env)).toBe(true);
    let caught: unknown;
    try {
      checkpoint("chapter ch2", env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RunPausedError);
    expect(isRunPausedError(caught)).toBe(true);
    expect((caught as RunPausedError).where).toBe("chapter ch2");
    expect((caught as RunPausedError).permanent).toBe(false);
  });

  it("never pauses without the env var", () => {
    expect(pauseRequested({} as NodeJS.ProcessEnv)).toBe(false);
    expect(RUN_PAUSED_EXIT_CODE).toBe(75);
  });

  it("recognizes a pause error by name after it crosses a module copy", () => {
    expect(isRunPausedError(Object.assign(new Error("x"), { name: "RunPausedError" }))).toBe(true);
    expect(isRunPausedError(new Error("x"))).toBe(false);
  });
});

describe("script choice per engine", () => {
  it("maps engines to their script files", () => {
    expect(scriptFileForEngine("eleven")).toBe("script_eleven.md");
    expect(scriptFileForEngine("ElevenLabs")).toBe("script_eleven.md");
    expect(scriptFileForEngine("external")).toBe("script_voice.md");
    expect(scriptFileForEngine("vertex")).toBe("script.md");
    expect(scriptFileForEngine("edge")).toBe("script.md");
    expect(scriptFileForEngine("")).toBe("script.md");
  });

  it("prefers the engine's own script", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "script.md"), "plain");
    fs.writeFileSync(path.join(d, "script_eleven.md"), "[calm] tagged");
    const c = chooseChapterScript(d, "vertex");
    expect(c).toEqual({ path: path.join(d, "script.md"), preferred: "script.md", fallback: false, stripTags: false });
  });

  it("reuses a tagged script for vertex with tags stripped", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "script_eleven.md"), "[calm] tagged");
    const c = chooseChapterScript(d, "vertex");
    expect(c.path).toBe(path.join(d, "script_eleven.md"));
    expect(c.fallback).toBe(true);
    expect(c.stripTags).toBe(true);
  });

  it("reuses a plain script for elevenlabs without stripping", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "script.md"), "plain");
    const c = chooseChapterScript(d, "elevenlabs", { engineSupportsTags: true });
    expect(c.path).toBe(path.join(d, "script.md"));
    expect(c.fallback).toBe(true);
    expect(c.stripTags).toBe(false);
  });

  it("strips tags for an elevenlabs model without tag support", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "script_eleven.md"), "[calm] tagged");
    const c = chooseChapterScript(d, "elevenlabs", { engineSupportsTags: false });
    expect(c.fallback).toBe(false);
    expect(c.stripTags).toBe(true);
  });

  it("returns the preferred path when no script exists", () => {
    const d = tmp();
    const c = chooseChapterScript(d, "external");
    expect(c).toEqual({ path: path.join(d, "script_voice.md"), preferred: "script_voice.md", fallback: false, stripTags: false });
  });
});
