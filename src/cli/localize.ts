#!/usr/bin/env node
/**
 * Localize CLI - serial, resumable Hindi (hi-IN) language version of a series.
 *
 *   npx tsx src/cli/localize.ts <series> --locale hi-IN --chapters 1-3 \
 *       --voice hi-IN-MadhurNeural [--speed 1] [--job <id>] [--json]
 *   npx tsx src/cli/localize.ts <series> --job <id> [--json]
 *   npx tsx src/cli/localize.ts <series> --status [--json]
 *
 * The server persists the job and spawns this CLI; the CLI executes a job that
 * is already on disk (or creates one when --chapters is given by hand).
 *
 * English artifacts are read-only here. All output goes to
 * <series>/out/languages/<locale>/<ch>/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJob, readManifest, sortChapters } from "../localization/store.js";
import {
  LocalizeError,
  availableChapters,
  languagesState,
  parseChapterSelection,
  planLocalizeJob,
  runLocalizeJob,
  seriesDir,
} from "../stages/localize.js";

const DOC = `Localize - Hindi (hi-IN) language versions of a reviewed English series.

  npx tsx src/cli/localize.ts <series> --locale hi-IN --chapters 1-3 \\
      --voice hi-IN-MadhurNeural [--speed 1] [--job <id>] [--json]
  npx tsx src/cli/localize.ts <series> --job <id> [--json]
  npx tsx src/cli/localize.ts <series> --status [--json]

Notes:
  - The English script must be generated, reviewed and checked first.
  - English files are never modified; output lives under out/languages/.
  - A chapter already published for the same source + voice is not re-rendered.`;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function seriesRoot(): string {
  return process.env.MANHWA_SERIES_ROOT || path.join(REPO_ROOT, "series");
}

interface Args {
  series: string;
  locale?: string;
  chapters?: string;
  voice?: string;
  speed?: number;
  job?: string;
  status: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const out: Args = { series: "", status: false, json: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      if (i + 1 >= argv.length) throw new LocalizeError(`${a} needs a value`, 400, "bad_args");
      i += 1;
      return argv[i]!;
    };
    switch (a) {
      case "--locale":
        out.locale = value();
        break;
      case "--chapters":
        out.chapters = value();
        break;
      case "--voice":
        out.voice = value();
        break;
      case "--speed": {
        const raw = value();
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new LocalizeError("--speed must be a number", 400, "bad_args");
        out.speed = n;
        break;
      }
      case "--job":
        out.job = value();
        break;
      case "--status":
        out.status = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        throw new LocalizeError(DOC, 0, "help");
      default:
        if (a.startsWith("--")) throw new LocalizeError(`unknown flag ${a}`, 400, "bad_args");
        positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    throw new LocalizeError(`expected exactly one series argument\n\n${DOC}`, 400, "bad_args");
  }
  out.series = positionals[0]!;
  return out;
}

function printStatus(sdir: string, slug: string): void {
  const state = languagesState(sdir, slug);
  console.log(`series: ${slug}`);
  for (const ch of availableChapters(sdir)) {
    const src = state.sourceChapters.find((s) => s.chapter === ch);
    console.log(
      `  ${ch}: source ${src?.eligible ? "eligible" : `NOT ELIGIBLE - ${src?.reason ?? "unknown"}`}`,
    );
  }
  const manifest = readManifest(sdir);
  for (const [locale, version] of Object.entries(manifest.locales)) {
    console.log(`\n${locale}:`);
    for (const ch of sortChapters(Object.keys(version.chapters))) {
      const rec = version.chapters[ch]!;
      const artifact = rec.artifact;
      console.log(
        `  ${ch}: ${rec.status}${rec.stage ? ` (${rec.stage})` : ""}` +
          (rec.error ? ` - ${rec.error.slice(0, 120)}` : "") +
          (artifact ? ` | video ${artifact.duration.toFixed(1)}s rev ${artifact.revision}` : " | no video"),
      );
    }
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof LocalizeError && err.code === "help") {
      console.log(DOC);
      return 0;
    }
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  let sdir: string;
  try {
    sdir = seriesDir(seriesRoot(), args.series);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (args.status) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(languagesState(sdir, args.series), null, 2)}\n`);
    } else {
      printStatus(sdir, args.series);
    }
    return 0;
  }

  try {
    let jobId = args.job ?? "";
    if (!jobId) {
      if (!args.locale || !args.voice) {
        throw new LocalizeError("--locale and --voice are required (or pass --job)", 400, "bad_args");
      }
      const chapters = parseChapterSelection(args.chapters ?? "all", availableChapters(sdir));
      const planned = await planLocalizeJob(sdir, {
        locale: args.locale,
        chapters: chapters.map((c) => c.slice(2)).join(",") || "all",
        voice: args.voice,
        speed: args.speed,
      });
      jobId = planned.job.id;
    } else if (!readJob(sdir, jobId)) {
      throw new LocalizeError(`job not found: ${jobId}`, 404, "job_not_found");
    }
    const result = await runLocalizeJob(sdir, jobId, {
      log: args.json ? () => undefined : (m) => console.log(m),
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ job: jobId, ...result }, null, 2)}\n`);
    } else {
      console.log(`job ${jobId}: ${result.status}`);
    }
    return result.status === "completed" ? 0 : 1;
  } catch (err) {
    const e = err as LocalizeError;
    process.stderr.write(`${e.message}\n`);
    return e.statusCode === 409 ? 3 : 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
