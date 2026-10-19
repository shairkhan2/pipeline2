// Byte-for-byte port of the v1 hash contracts:
//   reader.py   -> schemaHash, briefHash, batchDir, CAPTION_VERSION
//   slicer.py   -> pagesHash, SLICER_REV
//   cleaner.py  -> promoRulesHash, promoCacheHash, cfgHash, PROMO_ALGO_VERSION, PROMO_ROI_PAD_FRAC
//   timeline.py -> externalCachePayload, narrationCacheKey, lineProofToken
//
// SAFETY: these digests are cache keys for paid artifacts. A one-character drift marks
// every existing cache STALE and re-bills vision/TTS. Never "clean up" a formula here.
//
// Python compatibility: Python's json.dumps and repr() do not match JSON.stringify.
// Two differences matter for these keys and are reproduced below:
//   1. floats: Python prints 288.0 (not 288) and uses exponent form outside 1e-4..1e16.
//   2. repr(str): Python prefers single quotes and switches to double quotes only when
//      the string holds an apostrophe and no double quote.
// Numbers read back from JSON are indistinguishable int/float in JS, so callers that
// know a value is a Python float must wrap it with `pyFloat(...)`.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { READER_BATCH, READER_SCHEMA, readerBatch } from './briefs.js';

// ---------------------------------------------------------------------------
// Constants (verbatim from v1)
// ---------------------------------------------------------------------------

/** reader.py: the ACTIVE default caption version (v4). */
export const CAPTION_VERSION = 4;

/** slicer.py: bump only when the slice algorithm changes (invalidates the sidecar). */
export const SLICER_REV = 3;

/** cleaner.py: bump when the promo-mask algorithm/config changes. */
export const PROMO_ALGO_VERSION = 'pmask-v4';

/** cleaner.py: crop padding as a fraction of the ROI bbox. */
export const PROMO_ROI_PAD_FRAC = 0.5;

// ---------------------------------------------------------------------------
// Python-compatible number / string / JSON rendering
// ---------------------------------------------------------------------------

/** Marks a number that Python held as a `float` (so it renders as `288.0`, not `288`). */
export interface PyFloatMarker {
  readonly __pyFloat__: number;
}

/** Wrap a number so the serializer prints it the way Python prints a float. */
export function pyFloat(value: number): PyFloatMarker {
  return { __pyFloat__: value };
}

/**
 * Recursively wrap every number as a Python float. Use for structures that came from
 * `norm_box`/`norm_promo_bbox`/`normPromoBbox`, where Python guarantees floats and
 * `json.dumps` would therefore print `288.0`, not `288`.
 */
export function pyFloatDeep<T>(value: T): T {
  if (typeof value === 'number') return pyFloat(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => pyFloatDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object' && !isPyFloat(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = pyFloatDeep(v);
    return out as unknown as T;
  }
  return value;
}

function isPyFloat(value: unknown): value is PyFloatMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, '__pyFloat__')
  );
}

/**
 * Python's `repr(float)` / json float formatting: shortest round-trip digits, fixed
 * notation while `-4 <= decpt <= 16`, scientific otherwise, and always a `.0` for
 * whole fixed values (`repr(1.0) === "1.0"`).
 */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Number.POSITIVE_INFINITY) return 'Infinity';
  if (x === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';

  const neg = x < 0;
  const ax = Math.abs(x);
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(ax.toExponential());
  if (!m) return String(x); // unreachable for finite doubles
  const digits = m[1] + (m[2] ?? '');
  const decpt = Number.parseInt(m[3]!, 10) + 1; // digits before the point in fixed form

  let out: string;
  if (decpt <= -4 || decpt > 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0]!;
    const exp = decpt - 1;
    const sign = exp < 0 ? '-' : '+';
    out = `${mant}e${sign}${Math.abs(exp).toString().padStart(2, '0')}`;
  } else if (decpt <= 0) {
    out = `0.${'0'.repeat(-decpt)}${digits}`;
  } else if (decpt >= digits.length) {
    out = `${digits}${'0'.repeat(decpt - digits.length)}.0`;
  } else {
    out = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  return neg ? `-${out}` : out;
}

/**
 * Python's `repr(str)`: single quotes by default, double quotes when the string has an
 * apostrophe and no double quote, backslash escapes for the quote/backslash/controls,
 * and non-ASCII printable characters kept as-is.
 */
export function pyReprStr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return quote + out + quote;
}

/**
 * Python's `repr()` for the `lines` structure (`[[text, [tags...]], ...]`), which is
 * what `_narration_cache_key` hashes. Lists render with `[`, `]`, `, ` and strings via
 * pyReprStr; the shape must stay a list (a tuple would render `(...)`).
 */
export function pyReprLines(lines: ReadonlyArray<readonly [string, readonly string[]]>): string {
  return `[${lines
    .map((line) => `[${pyReprStr(line[0])}, [${line[1].map(pyReprStr).join(', ')}]]`)
    .join(', ')}]`;
}

/** Python's `str()` for the scalar types seen in these keys. */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  if (value === null || value === undefined) return 'None';
  return String(value);
}

export interface PyJsonOptions {
  sortKeys?: boolean;
  /** Python default separators are `(', ', ': ')`; `separators=(",", ":")` is compact. */
  separators?: readonly [string, string];
  /** Python's `json.dumps` defaults to `ensure_ascii=True`. */
  ensureAscii?: boolean;
}

function pyJsonQuote(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else if (ensureAscii && cp > 0x7f) {
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
      } else {
        out += `\\u${cp.toString(16).padStart(4, '0')}`;
      }
    } else out += ch;
  }
  return `${out}"`;
}

/** Compare by Unicode code point, matching Python's `sorted()` on `str`. */
function codePointCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0)!;
    const bc = bn.value.codePointAt(0)!;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
}

/** Sort strings by code point (Python `sorted`), not by JS UTF-16 code unit. */
export function pySorted(values: Iterable<string>): string[] {
  return [...values].sort(codePointCompare);
}

/** Python-compatible `json.dumps`. Exported because several cache keys hash its output. */
export function pyJsonDumps(value: unknown, opts: PyJsonOptions): string {
  const sep = opts.separators ?? [', ', ': '];
  const ensureAscii = opts.ensureAscii ?? true;
  const render = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (isPyFloat(v)) return pyFloatRepr(v.__pyFloat__);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
    if (typeof v === 'string') return pyJsonQuote(v, ensureAscii);
    if (Array.isArray(v)) return `[${v.map(render).join(sep[0])}]`;
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      let keys = Object.keys(obj);
      if (opts.sortKeys) keys = keys.sort(codePointCompare);
      return `{${keys.map((k) => `${pyJsonQuote(k, ensureAscii)}${sep[1]}${render(obj[k])}`).join(sep[0])}}`;
    }
    throw new TypeError(`cannot serialise ${typeof v}`);
  };
  return render(value);
}

// ---------------------------------------------------------------------------
// reader.py
// ---------------------------------------------------------------------------

/**
 * Fingerprint of the FROZEN reader schema (caption left as the `@@CAPTION@@` marker).
 * Must not move while any on-disk cache exists.
 */
export function schemaHash(): string {
  return createHash('sha256').update(READER_SCHEMA, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Cache key for the reader prompt actually in use.
 *
 * v1 keeps the HISTORICAL full-prompt sha256 (`9529b2f7`) so every existing batch/obs
 * stays fresh. A v>1 key is the sha of that version's composed prompt.
 */
export function briefHash(captionVersion: number = CAPTION_VERSION): string {
  const text = captionVersion === 1 ? READER_BATCH : readerBatch(captionVersion);
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Where a chapter's PAID batch caches live for a caption version. v1 keeps the exact
 * historical path (`<out>/batches/<ch>`); a v>1 read goes to a `v<cv>` subdirectory.
 */
export function batchDir(outDir: string, ch: string, cv: number = CAPTION_VERSION): string {
  const d = join(outDir, 'batches', ch);
  return cv === 1 ? d : join(d, `v${cv}`);
}

// ---------------------------------------------------------------------------
// slicer.py
// ---------------------------------------------------------------------------

/**
 * Deterministic fingerprint of the source pages: sorted `"<filename>:<size>\n"` of every
 * regular file in the chapter dir (symlinks followed, matching `os.path.isfile`).
 */
export function pagesHash(chdir: string): string {
  const h = createHash('sha256');
  for (const f of pySorted(readdirSync(chdir))) {
    const p = join(chdir, f);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p); // follows symlinks, like os.path.isfile
    } catch {
      continue;
    }
    if (st.isFile()) h.update(`${f}:${st.size}\n`, 'utf8');
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// cleaner.py
// ---------------------------------------------------------------------------

/** Default locations of the two files whose bytes feed `promoCacheHash`. */
export interface CleanerPaths {
  /** cleaner.py `CONFIG` (cleaner_config.json). */
  configPath: string;
  /** cleaner.py `PROMO_ADAPTER` (tools/promo_ocr_export.py). */
  adapterPath: string;
}

function readBytesOr(path: string, fallback: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.from(fallback, 'utf8');
  }
}

/** Content hash of the promo signature set (rules payload or promo list). */
export function promoRulesHash(it: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {
    promo: pySorted((it['promo'] as unknown[] | undefined ?? []).map((t) => String(t))),
  };
  const rules = it['promo_rules'];
  if (rules !== null && typeof rules === 'object' && !Array.isArray(rules)) {
    const r = rules as Record<string, unknown>;
    payload['rules_hash'] = String(r['hash'] ?? '');
    payload['registry'] = String(r['registry_hash'] ?? '');
    payload['blocked'] = pySorted(
      ((r['blocked'] as unknown[] | undefined) ?? [])
        .filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object' && !Array.isArray(b))
        .map((b) => String(b['string'] ?? '')),
    );
  }
  return createHash('sha1').update(pyJsonDumps(payload, { sortKeys: true }), 'utf8').digest('hex');
}

/**
 * Versioned mask-cache digest. Changes when the source bytes, the promo rules/registry,
 * the protected/observed texts, the reader promo_regions, the OCR adapter, or the crop
 * padding change. Distinct from `cfgHash`, so an old erase `.done`/`.rej` never satisfies
 * a mask-cache hit.
 *
 * `it.promo_regions` bboxes come from `normPromoBbox`, which always stores Python floats,
 * so the regions are rendered with every number as a float (`288.0`, never `288`).
 */
export function promoCacheHash(
  it: Record<string, unknown>,
  srcPath: string,
  paths: CleanerPaths,
): string {
  const h = createHash('sha1');
  h.update(PROMO_ALGO_VERSION, 'utf8');
  h.update(readBytesOr(paths.configPath, '<no-config>'));
  h.update(readBytesOr(srcPath, '<no-source>'));
  h.update(readBytesOr(paths.adapterPath, '<no-adapter>'));
  h.update(
    pyJsonDumps(
      {
        pad: pyFloat(PROMO_ROI_PAD_FRAC),
        regions: pyFloatDeep((it['promo_regions'] as unknown[] | undefined) ?? []),
      },
      { sortKeys: true },
    ),
    'utf8',
  );
  h.update(promoRulesHash(it), 'utf8');
  const texts = pySorted(
    new Set(
      [
        ...((it['overlay'] as unknown[] | undefined) ?? []),
        ...((it['world'] as unknown[] | undefined) ?? []),
      ].map((t) => String(t)),
    ),
  );
  h.update(pyJsonDumps(texts, {}), 'utf8');
  return h.digest('hex');
}

/**
 * Stable digest of (tool config + world strings). MUST stay a real digest, not JS
 * `hashCode()`: Python's `str.__hash__` is salted per process, which is exactly the bug
 * this replaced.
 */
export function cfgHash(worldTexts: readonly string[], configPath: string): string {
  const cfg = createHash('sha1').update(readBytesOr(configPath, '')).digest('hex');
  const worlds = createHash('sha1').update(pySorted(worldTexts).join('|'), 'utf8').digest('hex');
  return `${cfg}|${worlds}`;
}

// ---------------------------------------------------------------------------
// timeline.py
// ---------------------------------------------------------------------------

export interface ExternalTtsConfig {
  engine: string;
  provider: string;
  revision: string;
  command: string[];
  voice_id: string;
  language: string;
  speed: number;
  style: string;
  settings: Record<string, unknown>;
}

/** Canonical JSON string capturing every provider/voice/command/style setting. */
export function externalCachePayload(cfg: ExternalTtsConfig): string {
  return pyJsonDumps(
    {
      engine: 'external',
      provider: cfg.provider,
      revision: cfg.revision,
      command: cfg.command,
      voice_id: cfg.voice_id,
      language: cfg.language,
      speed: pyFloat(cfg.speed),
      style: cfg.style,
      settings: cfg.settings,
    },
    { sortKeys: true, separators: [',', ':'] },
  );
}

/**
 * TTS is deterministic per (script text, voice, rate/provider config), so it is cached.
 * `lines` must be the parsed script (`[[text, tags...], ...]`), rendered as Python `repr`.
 */
export function narrationCacheKey(
  lines: ReadonlyArray<readonly [string, readonly string[]]>,
  engine: string,
  voiceId: string | number,
  extCfg?: ExternalTtsConfig,
  speed?: number,
): string {
  if (engine === 'external') {
    if (extCfg === undefined) {
      throw new Error('external engine cache key requires ext_cfg');
    }
    const raw = `${pyReprLines(lines)}|${externalCachePayload(extCfg)}`;
    return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  }
  // Edge/Vertex/Grok accept a speaking rate: a different speed is different audio.
  const speedTag = typeof speed === 'number' && Number.isFinite(speed) && speed !== 1
    ? `|speed=${pyStr(speed)}`
    : '';
  return createHash('sha256')
    .update(`${pyReprLines(lines)}${engine}${pyStr(voiceId)}${speedTag}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Minimal JSON parser that preserves Python's int/float distinction: a number token
 * containing `.`, `e` or `E` becomes a `pyFloat` marker (Python `json.loads` yields a
 * float for those, an int otherwise). Needed because `JSON.parse` collapses both to JS
 * `number`, and re-serializing then prints `1` where Python prints `1.0`.
 */
export function parsePyJson(text: string): unknown {
  let i = 0;
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const fail = (): never => {
    throw new SyntaxError(`parsePyJson: unexpected token at ${i}`);
  };
  const parseString = (): string => {
    i++; // opening quote
    let out = '';
    for (;;) {
      const ch = text[i];
      if (ch === undefined) fail();
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch === '\\') {
        i++;
        const esc = text[i];
        if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16));
          i += 5;
        } else {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          out += map[esc!] ?? esc!;
          i++;
        }
      } else {
        out += ch;
        i++;
      }
    }
  };
  const parseNumber = (): number | PyFloatMarker => {
    const start = i;
    if (text[i] === '-' || text[i] === '+') i++;
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    let isFloat = false;
    if (text[i] === '.') {
      isFloat = true;
      i++;
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      isFloat = true;
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    }
    const n = Number(text.slice(start, i));
    return isFloat ? pyFloat(n) : n;
  };
  const parseValue = (): unknown => {
    ws();
    const ch = text[i];
    if (ch === '"') return parseString();
    if (ch === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const k = parseString();
        ws();
        if (text[i] !== ':') fail();
        i++;
        obj[k] = parseValue();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail();
      }
    }
    if (ch === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail();
      }
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return parseNumber();
  };
  const value = parseValue();
  ws();
  return value;
}

/**
 * I-24 content proof: a cached line mp3 is reusable ONLY if its `.txt` sidecar proves it
 * was synthesized from THIS exact text (and provider config for external TTS).
 */
export function lineProofToken(text: string, extCfg?: ExternalTtsConfig): string {
  if (extCfg === undefined) return text;
  return pyJsonDumps(
    { text, tts: parsePyJson(externalCachePayload(extCfg)) },
    { sortKeys: true, ensureAscii: false },
  );
}

/** Basename helper used when a caller only has a path (kept for parity with v1 call sites). */
export function panelBasenameNoExt(path: string): string {
  const b = basename(path);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}
