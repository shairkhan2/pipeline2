/**
 * Import FIRST by any test that renders through timeline.ts.
 *
 * Two import-time settings matter:
 *  - `MANHWA_STUDIO_PUBLIC` is frozen by timeline.ts at import time, and ESM
 *    evaluates every static import before the importing module body. Setting it
 *    here keeps these tests off the real remotion-studio/public tree.
 *  - `EDGE_TTS_PYTHON` is resolved once and cached inside audio.ts, and the Edge
 *    subprocess inherits `process.env`. One shared fake "python" here is
 *    therefore the only way every fixture can drive an offline Edge path.
 *
 * The fake answers the `import edge_tts` probe and synthesizes a real mp3 with
 * ffmpeg. It records each synthesis in a `<line>.edge.json` sidecar NEXT TO the
 * output file, so every fixture reads its own calls: no shared, truncatable log
 * and no cross-test race.
 *
 * No network, no real Edge install, no credentials.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LANGUAGE_TEST_ROOT = "/tmp/opencode/language-rendering-studio";

export function languageTestStudioPublic(): string {
  fs.mkdirSync(LANGUAGE_TEST_ROOT, { recursive: true });
  return path.join(LANGUAGE_TEST_ROOT, "public");
}

const FAKE_EDGE_BIN = path.join(LANGUAGE_TEST_ROOT, "fake_edge_python");

fs.mkdirSync(LANGUAGE_TEST_ROOT, { recursive: true });
fs.writeFileSync(
  FAKE_EDGE_BIN,
  [
    "#!/usr/bin/env python3",
    "import json, subprocess, sys",
    "# audio.ts probes with `python -c 'import edge_tts'` and synthesizes with",
    "# `python -c <EDGE_PY>` reading JSON on stdin. Distinguish on the source.",
    "if len(sys.argv) >= 3 and sys.argv[1] == '-c':",
    "    if sys.argv[2].strip() == 'import edge_tts':",
    "        sys.exit(0)",
    "    req = json.load(sys.stdin)",
    "with open(req['path'] + '.edge.json', 'w') as fh:",
    "    json.dump({'voice': req['voice'], 'rate': req['rate'], 'text': req['text']}, fh)",
    "seconds = 0.5 + 0.05 * len(req['text'])",
    "subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',",
    "                'sine=frequency=330:duration=%.3f' % seconds,",
    "                '-ac', '1', '-ar', '24000', '-b:a', '64k', req['path']], check=True)",
  ].join("\n"),
  { mode: 0o755 },
);
// Sanity: the fake must be a working executable, not a silently broken probe.
const probe = spawnSync(FAKE_EDGE_BIN, ["-c", "import edge_tts"], { timeout: 30_000 });
if (probe.status !== 0) {
  throw new Error(`fake edge python is not runnable: ${String(probe.stderr)}`);
}

process.env.MANHWA_STUDIO_PUBLIC = languageTestStudioPublic();
process.env.EDGE_TTS_PYTHON = FAKE_EDGE_BIN;

export interface FakeEdgeCall {
  voice: string;
  rate: string;
  text: string;
}

/**
 * Every fake-Edge synthesis recorded under `dir`, ordered by line index.
 * `dir` is the chapter's `tts_lines_edge` working dir (or a locale video dir).
 */
export function fakeEdgeCalls(dir: string): FakeEdgeCall[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".edge.json"))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as FakeEdgeCall);
}
