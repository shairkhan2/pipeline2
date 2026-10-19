/**
 * Stage 1.5: SCOUT. Port of pipeline/scout.py.
 *
 * Reads vision already cached for the first few chapters (0 reader calls),
 * picks the chapter+scene that hooks hardest as episode 1, writes the opening
 * line. Everything before the chosen chapter is context only.
 *
 * Output: out/opening.json
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SCOUT_CHAPTER, SCOUT_PANEL } from "../contracts/briefs.js";
import { pyFloatRepr, pyReprStr, type PyFloatMarker } from "../contracts/hashes.js";
import { ensure as ensurePromo } from "../intake/promoBlock.js";
import { call, log, pageBlocks, parseJson } from "../llm/client.js";

export const DEFAULT_RANGE = 5;

const PANEL_TAG = /@?(p\d{4}_\d+)/g;
const PANEL_TAG_STRIP = /@p\d+(?:_\d+)?/g;

interface PromoMatcher {
  matches(s: unknown): boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPyFloat(v: unknown): v is PyFloatMarker {
  return isRecord(v) && Object.prototype.hasOwnProperty.call(v, "__pyFloat__");
}

function pySlice(s: string, start: number, end?: number): string {
  return Array.from(s).slice(start, end).join("");
}

function jsonQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else if (cp > 0x7f) {
      if (cp > 0xffff) {
        const u = cp - 0x10000;
        const hi = 0xd800 + (u >> 10);
        const lo = 0xdc00 + (u & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      } else out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `${out}"`;
}

function pyJsonPretty(value: unknown, indent = 1): string {
  const render = (v: unknown, level: number): string => {
    const pad = " ".repeat(indent * level);
    const padIn = " ".repeat(indent * (level + 1));
    if (v === null || v === undefined) return "null";
    if (isPyFloat(v)) return pyFloatRepr(v.__pyFloat__);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
    if (typeof v === "string") return jsonQuote(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[\n${v.map((x) => padIn + render(x, level + 1)).join(",\n")}\n${pad}]`;
    }
    if (isRecord(v)) {
      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      return `{\n${keys.map((k) => `${padIn}${jsonQuote(k)}: ${render(v[k], level + 1)}`).join(",\n")}\n${pad}}`;
    }
    throw new TypeError(`cannot serialise ${typeof v}`);
  };
  return render(value, 0);
}

function pyRepr(v: unknown): string {
  if (typeof v === "string") return pyReprStr(v);
  if (v == null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

function pyList(xs: readonly string[]): string {
  return `[${xs.map((s) => pyReprStr(s)).join(", ")}]`;
}

/** Python str.format for `{name}` plus `{{` / `}}`. */
function pyFormat(template: string, fields: Record<string, string>): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    const next = template[i + 1];
    if (ch === "{" && next === "{") {
      out += "{";
      i++;
      continue;
    }
    if (ch === "}" && next === "}") {
      out += "}";
      i++;
      continue;
    }
    if (ch === "{") {
      const end = template.indexOf("}", i);
      if (end < 0) throw new Error("unmatched '{' in format string");
      const key = template.slice(i + 1, end);
      if (!(key in fields)) throw new Error(`format missing key ${key}`);
      out += fields[key]!;
      i = end;
      continue;
    }
    out += ch;
  }
  return out;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyRepr(x)).join(", ")}]`;
  if (isRecord(v)) {
    const parts = Object.keys(v).map((k) => `${pyReprStr(k)}: ${pyRepr(v[k])}`);
    return `{${parts.join(", ")}}`;
  }
  return String(v);
}

export function _obs(outDir: string, ch: string): Record<string, unknown> | null {
  const p = join(outDir, `obs_${ch}.json`);
  if (!existsSync(p)) return null;
  let d: unknown;
  try {
    d = JSON.parse(readFileSync(p, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(d)) return null;
  const data = d.data;
  return isRecord(data) ? data : d;
}

/** Events + the cast as first introduced. The scout judges openings from this. */
export function _chapterBlock(_outDir: string, ch: string, obs: Record<string, unknown>): string {
  const chars: string[] = [];
  const rawChars = Array.isArray(obs.characters) ? obs.characters.slice(0, 12) : [];
  for (const c of rawChars) {
    if (!isRecord(c)) continue;
    const n = typeof c.name === "string" ? c.name : "?";
    if (n.startsWith("UNKNOWN")) continue;
    const what = typeof c.what_they_do === "string" ? c.what_they_do : "";
    chars.push(`${n} (${what})`);
  }
  const events = (Array.isArray(obs.events) ? obs.events.slice(0, 40) : [])
    .map((e, i) => `  ${i + 1}. ${asText(e)}`)
    .join("\n");
  const cast = chars.join("; ") || "(none named)";
  return `=== ${ch} ===\ncharacters: ${cast}\nevents:\n${events}`;
}

/** Showable artwork panels only. The hook panel must be something to see. */
export function _panelCandidates(obs: Record<string, unknown>, block?: PromoMatcher | null): string[] {
  const rows: string[] = [];
  const panels = Array.isArray(obs.panels) ? obs.panels : [];
  for (const raw of panels) {
    if (!isRecord(raw)) continue;
    const art = typeof raw.art === "number" ? raw.art : 1;
    const overlay = Array.isArray(raw.overlay) ? raw.overlay : [];
    const ov = overlay.map((t) => String(t)).join(" ");
    const ba = String(raw.bubble_at ?? "").trim().toLowerCase();
    if (block && overlay.some((t) => block.matches(t))) continue;
    if (art <= 0.2 || (art < 0.5 && ov.length >= 60) || (ba === "full" && art < 0.8)) continue;
    const visual = pySlice(typeof raw.visual === "string" ? raw.visual : "", 0, 160);
    rows.push(`${String(raw.id)} | art:${art} | ${visual}`);
  }
  return rows;
}

function chapterNumber(ch: string): number {
  const m = /\d+/.exec(ch);
  if (!m) throw new Error(`scout: no chapter number in ${ch}`);
  return Number.parseInt(m[0], 10);
}

/**
 * Pick the opening chapter and write the hook. Returns the opening dict (also saved).
 * An existing opening.json is returned as-is unless force is set (0 API calls).
 */
export async function scout(
  seriesDir: string,
  outDir: string,
  chapters: string[] | null = null,
  hi: number = DEFAULT_RANGE,
  force = false,
): Promise<Record<string, unknown>> {
  const opPath = join(outDir, "opening.json");
  if (existsSync(opPath) && !force) {
    const op = JSON.parse(readFileSync(opPath, "utf8")) as Record<string, unknown>;
    console.log(
      `scout: opening.json exists - ${String(op.start_ch)} (${String(op.panel)}) [--force to re-scout]`,
    );
    return op;
  }

  const chs = chapters && chapters.length > 0
    ? chapters
    : Array.from({ length: hi }, (_, i) => `ch${i + 1}`);
  const obsByCh: Record<string, Record<string, unknown>> = {};
  const blocks: string[] = [];
  for (const ch of chs) {
    const o = _obs(outDir, ch);
    if (!o) continue;
    obsByCh[ch] = o;
    blocks.push(_chapterBlock(outDir, ch, o));
  }
  const haveCh = Object.keys(obsByCh);
  if (haveCh.length === 0) {
    throw new Error(
      "scout: no cached obs_chN.json in the search range - run the " +
        `reader first (looked for ${chs.join(", ")})`,
    );
  }
  console.log(
    `scout: judging openings across ${haveCh.join(", ")} ` +
      `(${blocks.length} chapter blocks, 0 API calls to gather)`,
  );

  const r = await call(
    [{ role: "user", content: [{ type: "text", text: pyFormat(SCOUT_CHAPTER, { chapters: blocks.join("\n\n") }) }] }],
    { max_tokens: 800, temperature: 0.3, tag: "scout chapter" },
  );
  const parsed = parseJson(String(r.choices[0]?.message?.content ?? ""));
  const pick = isRecord(parsed) ? parsed : {};
  let ch = String(pick.chapter ?? "").trim();
  if (!(ch in obsByCh)) {
    const raw = String(pick.chapter ?? "");
    ch = haveCh.find((c) => raw.includes(c)) ?? "";
  }
  if (!ch) {
    throw new Error(
      `scout: model returned unknown chapter ${pyRepr(pick.chapter)} (have ${pyList(haveCh)})`,
    );
  }
  const evs: unknown[] = Array.isArray(obsByCh[ch]!.events) ? (obsByCh[ch]!.events as unknown[]) : [];
  let ei = 0;
  try {
    const raw = pick.event;
    if (typeof raw === "boolean" || raw == null) throw new Error("bad event");
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) throw new Error("bad event");
      ei = Math.trunc(raw);
    } else if (typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())) {
      ei = Number.parseInt(raw.trim(), 10);
    } else throw new Error("bad event");
  } catch {
    ei = 0;
  }
  if (!(ei >= 1 && ei <= evs.length)) {
    throw new Error(`scout: event ${pyRepr(pick.event)} not in ${ch} (1..${evs.length})`);
  }
  const scene = asText(evs[ei - 1]);
  const why = typeof pick.why === "string" ? pick.why : "";
  console.log(
    `scout: opening = ${ch} event ${ei}\n       scene: ${pySlice(scene, 0, 120)}\n` +
      `       why: ${pySlice(why, 0, 140)}`,
  );

  let block: PromoMatcher | null = null;
  try {
    block = ensurePromo(seriesDir, outDir);
  } catch {
    block = null;
  }
  const rows = _panelCandidates(obsByCh[ch]!, block);
  if (rows.length === 0) throw new Error(`scout: ${ch} has no showable panels`);
  const ids = rows.map((row) => row.split(" | ")[0]!);
  const centre = Math.trunc(((ei - 0.5) / Math.max(1, evs.length)) * ids.length);
  const lo = Math.max(0, Math.min(centre - 8, ids.length - 16));
  const windowIds = ids.slice(lo, lo + 16);
  const panelDir = join(outDir, "panels", ch);
  const content: unknown[] = [
    { type: "text", text: pyFormat(SCOUT_PANEL, { ch, scene }) },
  ];
  for (const pid of windowIds) {
    const f = join(panelDir, `${pid}.jpg`);
    if (existsSync(f)) {
      content.push({ type: "text", text: `[${pid}]` });
      content.push(...(await pageBlocks([f], 700)));
    }
  }
  const r2 = await call([{ role: "user", content }], {
    max_tokens: 700,
    temperature: 0.4,
    tag: "scout hook",
    lane: "vision",
  });
  const hookParsed = parseJson(String(r2.choices[0]?.message?.content ?? ""));
  const hook = isRecord(hookParsed) ? hookParsed : {};
  const panelRecs: unknown[] = Array.isArray(obsByCh[ch]!.panels) ? (obsByCh[ch]!.panels as unknown[]) : [];
  const have = new Set(panelRecs.filter(isRecord).map((p) => String(p.id)));
  let line = String(hook.hook ?? "").trim();
  const tagged = [...line.matchAll(PANEL_TAG)].map((m) => m[1]!);
  const panels: string[] = tagged.filter((t) => have.has(t));
  let want: unknown[] = [];
  if (typeof hook.panels === "string") want = [hook.panels];
  else if (Array.isArray(hook.panels)) want = hook.panels;
  for (const w of want) {
    const id = String(w).replace(/^@/, "").trim();
    if (have.has(id) && !panels.includes(id)) panels.push(id);
  }
  if (panels.length === 0) panels.push(windowIds[0]!);
  const picked = panels.slice(0, 4);
  if (tagged.length > 0 && tagged.every((t) => have.has(t))) {
    line = line.trim();
  } else {
    line = line.replace(PANEL_TAG_STRIP, "").trim();
    line = `${line} ${picked.map((p) => `@${p}`).join(" ")}`.trim();
  }
  const panel = picked[0]!;
  const introduces = "introduces" in hook ? hook.introduces : [];
  const op: Record<string, unknown> = {
    start_ch: ch,
    start_at: chapterNumber(ch),
    scene,
    why,
    panel,
    hook: line,
    introduces: Array.isArray(introduces) ? introduces : [],
    search: haveCh,
  };
  const tmp = opPath + ".tmp";
  writeFileSync(tmp, pyJsonPretty(op, 1));
  renameSync(tmp, opPath);
  log(`SCOUT ${seriesDir} -> ${ch} panel=${panel}`);
  console.log(`scout: hook -> ${line}\n       saved: ${opPath}`);
  return op;
}

/**
 * Everything the ep1 writer needs about the chapters BEFORE startCh.
 * Those chapters are never scripted.
 */
export function contextDigest(outDir: string, startCh: string): string {
  const n = chapterNumber(startCh);
  const parts: string[] = [];
  for (let i = 1; i < n; i++) {
    const o = _obs(outDir, `ch${i}`);
    if (!o) continue;
    const chars: string[] = [];
    const rawChars = Array.isArray(o.characters) ? o.characters : [];
    for (const c of rawChars) {
      if (!isRecord(c)) continue;
      const nm = typeof c.name === "string" ? c.name : "?";
      if (nm.startsWith("UNKNOWN")) continue;
      const visual = typeof c.visual === "string" ? c.visual : "";
      const what = typeof c.what_they_do === "string" ? c.what_they_do : "";
      chars.push(`${nm}: ${visual} | ${what}`);
    }
    const ev = (Array.isArray(o.events) ? o.events : []).map((e) => `  - ${asText(e)}`).join("\n");
    const cast = chars.map((c) => `  ${c}`).join("\n");
    parts.push(`=== ch${i} ===\ncharacters:\n${cast}\nevents:\n${ev}`);
  }
  if (parts.length === 0) return "";
  return (
    "STORY SO FAR (chapters before your episode - the viewer has NOT seen these, " +
    "they are your context. Introduce the people and the situation they set up; " +
    "do NOT narrate these chapters as if the viewer watched them, and do NOT " +
    "import facts they do not contain):\n\n" +
    parts.join("\n\n") +
    "\n"
  );
}

export const context_digest = contextDigest;
export const _chapter_block = _chapterBlock;
export const _panel_candidates = _panelCandidates;
