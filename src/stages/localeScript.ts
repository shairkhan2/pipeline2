/**
 * localeScript.ts - structure-preserving localization of a panel-tagged script.
 *
 * The reviewed English script is the ONLY source of truth for a language
 * version. It is parsed into narration units that carry their stable position
 * (line number), beat header, panel tags, @hold flag and emotion controls.
 * A translation must reproduce that skeleton exactly: same number of narration
 * lines, same beat headers in the same order, the same panel tags per line in
 * the same order, @hold where the source had it, and the same emotion controls.
 *
 * Everything here is pure and offline: no LLM, no filesystem, no TTS.
 */

export interface NarrationUnit {
  /** Stable id used in the translation JSON contract: u0001, u0002, ... */
  id: string;
  /** 1-based narration line number (headers/blank lines are not counted). */
  line: number;
  /** Beat header this unit belongs to, or null before the first header. */
  beat: string | null;
  /** Spoken text with @p/@hold/emotion controls replaced by placeholders. */
  template: string;
  /** Panel tags in source order, e.g. ["p0005_1", "p0007_1"]. */
  tags: string[];
  /** True when the source line carried @hold. */
  hold: boolean;
  /** Emotion controls in source order, e.g. ["[deadpan]"]. */
  emotions: string[];
  /** Spoken prose only (controls stripped). */
  spoken: string;
}

export interface ParsedLocaleScript {
  /** Every raw line, in order (trailing newline shape preserved separately). */
  lines: string[];
  units: NarrationUnit[];
  /** Beat header lines in order, e.g. "## BEAT b01_...". */
  beats: string[];
  /** The source ended with a newline. */
  trailingNewline: boolean;
}

export interface LocaleScriptIssue {
  code:
    | "unit_count"
    | "beat_sequence"
    | "tag_sequence"
    | "hold_mismatch"
    | "emotion_mismatch"
    | "placeholder"
    | "not_hindi"
    | "untranslated"
    | "number_lost"
    | "empty_line"
    | "length_warning";
  message: string;
  line?: number;
  severity: "error" | "warning";
}

const PANEL_TAG_RE = /@p\d{4}_\d+/g;
const HOLD_RE = /(?:^|\s)@hold(?:\s|$)/;
const EMOTION_RE = /\[[a-z][a-z ]{1,20}\]/g;
const DEVANAGARI_RE = /[\u0900-\u097F]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

export function isBeatHeader(line: string): boolean {
  return /^\s*##\s*BEAT\b/.test(line);
}

/** Split into universal newlines; mirrors Python splitlines for the shapes we get. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(/\r\n|\n|\r/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Placeholder for a control token: ⟦E1⟧ / ⟦T1⟧. */
export function emotionPlaceholder(index: number): string {
  return `⟦E${index + 1}⟧`;
}
export function tagPlaceholder(index: number): string {
  return `⟦T${index + 1}⟧`;
}

/** Panel tags in source order, de-duplicated only for comparison (order kept). */
export function panelTags(line: string): string[] {
  return [...line.matchAll(PANEL_TAG_RE)].map((m) => m[0]);
}

export function emotionControls(line: string): string[] {
  return [...line.matchAll(EMOTION_RE)].map((m) => m[0]);
}

export function hasHold(line: string): boolean {
  return HOLD_RE.test(` ${line} `);
}

/**
 * Parse a script into units. Controls are replaced by placeholders so the model
 * cannot silently drop or reorder them, and the validator can prove they came
 * back byte-identical.
 */
export function parseLocaleScript(script: string): ParsedLocaleScript {
  const trailingNewline = /\n$/.test(script);
  const lines = splitLines(script);
  const units: NarrationUnit[] = [];
  const beats: string[] = [];
  let beat: string | null = null;
  let lineNo = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      if (isBeatHeader(raw)) {
        beat = trimmed;
        beats.push(trimmed);
      }
      continue;
    }
    lineNo += 1;
    const tags = panelTags(raw);
    const emotions = emotionControls(raw);
    const hold = hasHold(raw);
    let body = raw;
    for (let i = 0; i < tags.length; i++) body = body.replace(tags[i]!, tagPlaceholder(i));
    for (let i = 0; i < emotions.length; i++) body = body.replace(emotions[i]!, emotionPlaceholder(i));
    body = body.replace(/(?:^|\s)@hold(?=\s|$)/, " ⟦H⟧");
    const spoken = body
      .replace(/⟦[ETH]\d*⟧/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    units.push({
      id: `u${String(units.length + 1).padStart(4, "0")}`,
      line: lineNo,
      beat,
      template: body.trim(),
      tags,
      hold,
      emotions,
      spoken,
    });
  }
  return { lines, units, beats, trailingNewline };
}

/** Replace ⟦Tn⟧/⟦En⟧/⟦H⟧ back with the source controls. */
export function restoreControls(template: string, unit: NarrationUnit): string {
  let out = template;
  for (let i = 0; i < unit.tags.length; i++) {
    out = out.split(tagPlaceholder(i)).join(unit.tags[i]!);
  }
  for (let i = 0; i < unit.emotions.length; i++) {
    out = out.split(emotionPlaceholder(i)).join(unit.emotions[i]!);
  }
  out = out.split("⟦H⟧").join("@hold");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Rebuild a full script from translated unit bodies. Headers, blank lines and
 * the source's blank-line rhythm are preserved; each narration line is replaced
 * in place. `translations` must be complete and in source order.
 */
export function rebuildScript(parsed: ParsedLocaleScript, translated: string[]): string {
  if (translated.length !== parsed.units.length) {
    throw new Error(`translation must have ${parsed.units.length} units, got ${translated.length}`);
  }
  const out: string[] = [];
  let u = 0;
  for (const raw of parsed.lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(raw);
      continue;
    }
    const unit = parsed.units[u];
    if (!unit) throw new Error(`script has more narration lines than parsed units at line ${u + 1}`);
    out.push(restoreControls(translated[u]!, unit));
    u += 1;
  }
  return out.join("\n") + (parsed.trailingNewline ? "\n" : "");
}

/* ------------------------------------------------------------------ *
 * Numbers: digit or word, English or Hindi, compared by VALUE.
 * ------------------------------------------------------------------ */

const EN_NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, lakh: 100000, crore: 10000000,
};

const HI_NUMBER_WORDS: Record<string, number> = {
  "शून्य": 0, "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5,
  "छह": 6, "छः": 6, "सात": 7, "आठ": 8, "नौ": 9, "दस": 10, "ग्यारह": 11,
  "बारह": 12, "तेरह": 13, "चौदह": 14, "पंद्रह": 15, "सोलह": 16,
  "सत्रह": 17, "अठारह": 18, "उन्नीस": 19, "बीस": 20, "तीस": 30,
  "चालीस": 40, "पचास": 50, "साठ": 60, "सत्तर": 70, "अस्सी": 80,
  "इक्कीस": 21, "बाईस": 22, "तेईस": 23, "चौबीस": 24, "पच्चीस": 25,
  "छब्बीस": 26, "सत्ताईस": 27, "अट्ठाईस": 28, "उनतीस": 29,
  "इकतीस": 31, "बत्तीस": 32, "तैंतीस": 33, "चौंतीस": 34, "पैंतीस": 35,
  "छत्तीस": 36, "सैंतीस": 37, "अड़तीस": 38, "उनतालीस": 39,
  "इकतालीस": 41, "बयालीस": 42, "तैंतालीस": 43, "चवालीस": 44,
  "पैंतालीस": 45, "छियालीस": 46, "सैंतालीस": 47, "अड़तालीस": 48,
  "उनचास": 49, "इक्यावन": 51, "बावन": 52, "तिरपन": 53, "चौवन": 54,
  "पचपन": 55, "छप्पन": 56, "सत्तावन": 57, "अट्ठावन": 58, "उनसठ": 59,
  "इकसठ": 61, "बासठ": 62, "तिरसठ": 63, "चौंसठ": 64, "पैंसठ": 65,
  "छियासठ": 66, "सड़सठ": 67, "अड़सठ": 68, "उनहत्तर": 69,
  "इकहत्तर": 71, "बहत्तर": 72, "तिहत्तर": 73, "चौहत्तर": 74,
  "पचहत्तर": 75, "छिहत्तर": 76, "सतहत्तर": 77, "अठहत्तर": 78,
  "उन्नासी": 79, "इक्यासी": 81, "बयासी": 82, "तिरासी": 83,
  "चौरासी": 84, "पचासी": 85, "छियासी": 86, "सत्तासी": 87,
  "अट्ठासी": 88, "नवासी": 89, "नब्बे": 90, "इक्यानवे": 91, "बानवे": 92,
  "तिरानवे": 93, "चौरानवे": 94, "पचानवे": 95, "छियानवे": 96,
  "सत्तानवे": 97, "अट्ठानवे": 98, "निन्यानवे": 99,
  "सौ": 100, "हज़ार": 1000, "हजार": 1000,
  "लाख": 100000, "करोड़": 10000000,
};

/** Devanagari digits -> ASCII, so १०,००० compares as 10000. */
export function normalizeDigits(text: string): string {
  return text.replace(/[\u0966-\u096F]/g, (d) => String(d.codePointAt(0)! - 0x0966));
}

const HI_WORDS_BY_LENGTH = Object.keys(HI_NUMBER_WORDS).sort((a, b) => b.length - a.length);

/**
 * Split a Devanagari run into number words, longest match first, so a joined
 * compound ("दसहज़ार") is still read as 10 x 1000. Returns null when the run
 * holds a non-number word (then the compound is not a number phrase).
 */
function splitHindiNumbers(run: string): number[] | null {
  const out: number[] = [];
  let rest = run;
  while (rest.length > 0) {
    const hit = HI_WORDS_BY_LENGTH.find((word) => rest.startsWith(word));
    if (!hit) return null;
    out.push(HI_NUMBER_WORDS[hit]!);
    rest = rest.slice(hit.length);
  }
  return out.length > 0 ? out : null;
}

/**
 * Numeric values expressed by a text, as digit runs or number-word phrases in
 * English or Hindi. Compounds are evaluated, not summed word by word:
 * "ten thousand" and "दस हज़ार" both yield 10000 (never {10, 1000}).
 */
export function numberValues(text: string): Set<number> {
  const values = new Set<number>();
  const normalized = normalizeDigits(text);
  // Tokens: Latin words, Devanagari letter runs (danda excluded), digit runs
  // (1,000 and Indian 1,00,000 grouping, optional decimal), and any other
  // single character as a separator. Separators always end a number phrase,
  // so "August 25, 2023" stays {25, 2023} and "3-5" stays {3, 5}.
  const tokens =
    normalized
      .toLowerCase()
      .match(
        /[a-z]+(?:-[a-z]+)*|[\u0900-\u0963\u0970-\u097F]+|\d{1,3}(?:(?:,\d{3})+|(?:,\d{2})+,\d{3})(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?|[^\sa-z\d\u0900-\u0963\u0970-\u097F]/g,
      ) ?? [];
  let total = 0;
  let current = 0;
  // A digit run is a complete value; only a following scale word ("5 thousand",
  // "2 लाख") may extend it.
  let afterDigits = false;
  const flush = (): void => {
    const value = total + current;
    if (value !== 0) values.add(value);
    total = 0;
    current = 0;
    afterDigits = false;
  };
  // Add one number word to the open phrase, or start a new phrase when it is
  // not a real compound continuation ("five six" is {5, 6}, not 11).
  const apply = (n: number): void => {
    if (afterDigits && n < 100) flush();
    afterDigits = false;
    if (n >= 1000) {
      total += (current || 1) * n;
      current = 0;
    } else if (n === 100) {
      if (current >= 100) flush();
      current = (current || 1) * 100;
    } else {
      const low = current % 100;
      if (!(low === 0 || (low >= 20 && low % 10 === 0 && n < 10))) flush();
      current += n;
    }
  };
  for (const raw of tokens) {
    if (/^\d/.test(raw)) {
      flush();
      const numeric = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(numeric)) continue;
      if (!Number.isInteger(numeric)) {
        // A decimal is its own value; it never compounds.
        values.add(numeric);
        continue;
      }
      current = numeric;
      afterDigits = true;
      continue;
    }
    if (/^[\u0900-\u097F]/.test(raw)) {
      const parts = splitHindiNumbers(raw);
      if (!parts) {
        flush();
        continue;
      }
      for (const n of parts) apply(n);
      continue;
    }
    if (!/^[a-z]/.test(raw)) {
      flush();
      continue;
    }
    // Latin words (hyphenated compounds split into parts). "and" is a
    // connector only after a scale word ("two hundred and five"); in a list
    // ("two and three") it ends the phrase.
    for (const part of raw.split("-")) {
      if (part === "and" && !afterDigits && (total > 0 || current > 0) && current % 100 === 0) {
        continue;
      }
      const n = EN_NUMBER_WORDS[part];
      if (n === undefined) {
        flush();
        break;
      }
      apply(n);
    }
  }
  flush();
  return values;
}

/**
 * Validate a translated unit list against the source skeleton.
 *
 * Errors block publication. Length is a WARNING only: a good Hindi line is not
 * required to keep an English word count.
 */
export function validateTranslation(
  parsed: ParsedLocaleScript,
  translated: string[],
  opts: { allowLatin?: readonly string[] } = {},
): LocaleScriptIssue[] {
  const issues: LocaleScriptIssue[] = [];
  const allowLatin = new Set((opts.allowLatin ?? []).map((w) => w.toLowerCase()));

  if (translated.length !== parsed.units.length) {
    issues.push({
      code: "unit_count",
      severity: "error",
      message: `translation must keep every narration unit (${parsed.units.length}), got ${translated.length}`,
    });
    return issues;
  }

  parsed.units.forEach((unit, i) => {
    const text = translated[i] ?? "";
    const trimmed = text.trim();
    if (!trimmed) {
      issues.push({ code: "empty_line", severity: "error", line: unit.line, message: "empty translated line" });
      return;
    }
    // Placeholder skeleton must survive exactly: same tags, same emotions, same hold.
    const gotTags = [...trimmed.matchAll(/⟦T(\d+)⟧/g)].map((m) => `T${m[1]}`);
    const wantTags = unit.tags.map((_, idx) => `T${idx + 1}`);
    if (gotTags.join(",") !== wantTags.join(",")) {
      issues.push({
        code: "tag_sequence",
        severity: "error",
        line: unit.line,
        message: `panel tags changed (expected ${wantTags.length}, kept ${gotTags.length})`,
      });
    }
    const gotEmotions = [...trimmed.matchAll(/⟦E(\d+)⟧/g)].map((m) => `E${m[1]}`);
    const wantEmotions = unit.emotions.map((_, idx) => `E${idx + 1}`);
    if (gotEmotions.join(",") !== wantEmotions.join(",")) {
      issues.push({
        code: "emotion_mismatch",
        severity: "error",
        line: unit.line,
        message: `emotion controls changed (expected ${wantEmotions.join("") || "none"}, kept ${gotEmotions.join("") || "none"})`,
      });
    }
    const gotHold = trimmed.includes("⟦H⟧");
    if (gotHold !== unit.hold) {
      issues.push({
        code: "hold_mismatch",
        severity: "error",
        line: unit.line,
        message: unit.hold ? "source @hold was dropped" : "translation invented @hold",
      });
    }
    const stray = trimmed.replace(/⟦[ETH]\d*⟧/g, "");
    if (/[⟦⟧]/.test(stray)) {
      issues.push({ code: "placeholder", severity: "error", line: unit.line, message: "malformed control placeholder" });
    }

    const prose = stray.replace(/\[[a-z][a-z ]{1,20}\]/g, " ").trim();
    const hasLetters = LATIN_LETTER_RE.test(prose) || /[\u0900-\u097F]/.test(prose);
    if (hasLetters && !DEVANAGARI_RE.test(prose)) {
      issues.push({
        code: "not_hindi",
        severity: "error",
        line: unit.line,
        message: "translated line has no Devanagari text",
      });
    }
    if (hasLetters && !DEVANAGARI_RE.test(prose) && unit.spoken.length > 0) {
      // already reported above; keep the untranslated signal distinct for the model retry
      issues.push({
        code: "untranslated",
        severity: "error",
        line: unit.line,
        message: "line appears untranslated",
      });
    }
    if (hasLetters && DEVANAGARI_RE.test(prose) && sameIgnoringCase(prose, unit.spoken)) {
      issues.push({ code: "untranslated", severity: "error", line: unit.line, message: "line is unchanged from English" });
    }
    if (hasLetters && !allowLatin.has(prose.toLowerCase()) && isOnlyAllowlistedLatin(prose, allowLatin)) {
      issues.push({ code: "not_hindi", severity: "error", line: unit.line, message: "line is only allowlisted Latin text" });
    }

    const srcNums = numberValues(unit.spoken);
    if (srcNums.size > 0) {
      const gotNums = numberValues(prose);
      const missing = [...srcNums].filter((n) => !gotNums.has(n));
      if (missing.length > 0) {
        issues.push({
          code: "number_lost",
          severity: "error",
          line: unit.line,
          message: `number value(s) missing: ${missing.join(", ")}`,
        });
      }
    }

    const srcLen = Array.from(unit.spoken).length;
    const outLen = Array.from(prose).length;
    if (srcLen >= 12 && (outLen < srcLen * 0.35 || outLen > srcLen * 2.6)) {
      issues.push({
        code: "length_warning",
        severity: "warning",
        line: unit.line,
        message: `translation length ${outLen} vs source ${srcLen} characters - review for truncation or padding`,
      });
    }
  });

  const gotBeats = [...translated.join("\n").matchAll(/^\s*##\s*BEAT\b.*$/gm)].map((m) => m[0].trim());
  if (gotBeats.length > 0 && gotBeats.join("\n") !== parsed.beats.join("\n")) {
    issues.push({ code: "beat_sequence", severity: "error", message: "beat headers changed" });
  }
  return issues;
}

function sameIgnoringCase(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

function isOnlyAllowlistedLatin(text: string, allow: Set<string>): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return false;
  return words.every((w) => allow.has(w));
}

export function errorsOf(issues: readonly LocaleScriptIssue[]): LocaleScriptIssue[] {
  return issues.filter((i) => i.severity === "error");
}

export function warningsOf(issues: readonly LocaleScriptIssue[]): LocaleScriptIssue[] {
  return issues.filter((i) => i.severity === "warning");
}
