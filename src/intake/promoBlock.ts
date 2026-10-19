/**
 * promoBlock.ts - mechanical scanlator/promo/credit block list (I-19).
 *
 * TypeScript port of manhwa-pipeline/pipeline/promo_block.py. Zero LLM calls.
 * Built from the archive itself:
 *   seeds   : scanlator group name from cbz filenames inside the source zip
 *             ("Rage scans_Chapter 1_x.cbz" -> "rage scans") + ComicInfo
 *             <Translator> read from inside each nested cbz.
 *   rules   : shape gates applied to reader overlay strings, each corroborated
 *             across chapters (story text never repeats identically across
 *             chapters; banners always do):
 *     R1 URL      - http/www/domain shapes; a domain corroborated in >=3 chapters
 *                   blocks the whole domain family (invite-code variants included).
 *     R2 PROMO    - promo verbs ("read the new chapter", "join our discord",
 *                   "get early releases", ...) corroborated in >=2 chapters.
 *     R3 CREDIT   - "|"-separated production credits (Korean role labels,
 *                   STUDIO/publisher names) corroborated in >=2 chapters.
 *     R4 EDGE     - corroborated >=3 chapters, appears ONLY on edge pages
 *                   (first/last 2 pages of a chapter) and ONLY as OVERLAY text
 *                   (never WORLD). Catches team-name banners like "Rage Team".
 *
 *   False-positive guards (measured on villain-hero, the reason these exist):
 *     "STARDUST!" repeats 32x/5ch but appears in WORLD text (in-story comic
 *     title) -> never blocked by R4; not URL/promo/credit shaped -> survives.
 *     "Rage" as a bare token matched "raging over orange juice" in a past audit
 *     -> all matching is word-boundary or whole-string, never bare substrings of
 *     short tokens. Seeds/domains are the only substring rules and both are
 *     multi-char shapes ("rage scans", "ragescans.com").
 *
 * Consumers (all optional - absent file = no-op, old behavior):
 *   cleaner.should_clean(panel, block)  known-junk bypasses the 40-char floor
 *   timeline.pick_panels(..., block)    never swap TO a promo panel
 *   writer.panel_transcript(obs, block) promo strings stripped from OVERLAY view
 *   fact_check.check(..., promo=block)  PROMO lint: narration must not voice these
 *
 * SHARED SOURCES. One extra, conservative signature set is merged in:
 *   src/intake/promo_sources.json - a curated, schema-checked registry of prior
 *   scanlator NAMES / DOMAINS / provenance. These are research-discovered
 *   signatures valid for OLD archives; they do NOT assert any live/official
 *   current status. Names are FULL group labels only (never a bare 'Asura').
 *   The registry's content digest feeds the block hash, so a registry edit
 *   invalidates the cache even when no new chapter was read (ensure() rebuilds).
 *
 * panelPromo(panel)     = ANY matching text on the panel (unchanged).
 * panelFullPromo(panel) = conservative: true only when the panel is DEFINITELY
 *   a full/low-usefulness promo page worth dropping; a small corner/side promo
 *   over useful art returns false and the panel is kept (its promo text is
 *   still available for cleaning/transcript lint).
 *
 * Output: series/<name>/out/promo_block.json, content-hashed so consumers can
 * stamp caches against edits.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

export const BLOCK_FILE = "promo_block.json";
export const REGISTRY_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "promo_sources.json");
export const MIN_CH_URL = 3;    // domain corroborated in >=3 chapters
export const MIN_CH_PROMO = 2;  // promo phrase in >=2 chapters
export const MIN_CH_CREDIT = 2; // credit line in >=2 chapters
export const MIN_CH_EDGE = 3;   // edge-page banner in >=3 chapters
export const EDGE_PAGES = 2;    // first/last N pages of a chapter are "edge"

// Curated shared-source registry (src/intake/promo_sources.json). Only
// trustworthy FULL-label names / real domains cross series lines; prior
// `blocked` story phrases never do. Names must be full labels (>=2 tokens) so
// a bare ambiguous token ("Asura", "Reaper", "Flame") can never be imported.
export const REGISTRY_VERSION = 1;
export const MIN_REGISTRY_NAME_TOKENS = 2; // registry names are FULL labels (>=2 tokens)
// panelFullPromo(): explicit reader metadata wins. `promo_page is True` => FULL
// (even with no name hit: a high-art advert page). `promo_page is False` with
// usable art/bubble_at => MIXED (small/corner/side promo over story art; kept).
// Only when the explicit flag is absent/unknown do we fall back to this coarse
// art/bubble_at heuristic, and that fallback is candidate-selection ONLY -
// never an authorization to display. Missing/invalid metadata => full (fail
// safe). A panel that is already a detected promo is FULL when art <=
// FULL_PROMO_ART_LOW (too little artwork to show) OR bubble_at == 'full' with
// art < FULL_PROMO_ART_FULL (text covers the frame). A promo with useful art
// (>= FULL) and a small corner/edge/side bubble returns false so the panel is
// kept and its story dialogue retained.
export const FULL_PROMO_ART_LOW = 0.4;
export const FULL_PROMO_ART_FULL = 0.8;
// bubble_at enum from briefs.py; anything outside it (missing/garbage) is
// treated as "unknown" and the panel is classified conservatively as full.
export const BUBBLE_AT_VALUES: ReadonlySet<string> = new Set(
  ["none", "corner", "edge", "top", "bottom", "center", "full"]);

// Python re semantics notes for the ports below:
//  - Python \w / \b are unicode-aware (\w = letters + numbers + "_"); JS \b is
//    ASCII-only. Every Python \b becomes the UWB / UWBE lookarounds, with the
//    "u" flag enabling the \p classes.
//  - Python "\s" is str.isspace(): includes \x1c-\x1f and \x85, excludes BOM.
//    JS \s differs, so wkey/trim use the PY_WS class explicitly.
const UWB = "(?<![\\p{L}\\p{N}_])";
const UWBE = "(?![\\p{L}\\p{N}_])";
const HOST_SRC = "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}";
const HOST_RE = new RegExp(HOST_SRC, "gi");                    // finditer
const HOST_FULL_RE = new RegExp(`^(?:${HOST_SRC})$`, "i");     // fullmatch
const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;                 // unused in py; kept for parity

const PROMO_RE = new RegExp(
  `${UWB}(read|join|subscribe|support|watch|check out|get)${UWBE}[^|]{0,40}` +
  `${UWB}(chapter|discord|patreon|early|release|community|premium)${UWBE}`,
  "iu");
const CREDIT_ROLE = /각색|콘티|원작자|원작사|작화|번역|정리|정제|STUDIO|Studio/;
const URL_SRC = "((?:https?://|www\\.)?[a-z0-9][a-z0-9-]*" +
  "\\.(?:com|net|org|gg|xyz|io|me|to|top|club)(?:/[^\\s|]*)?)";
const URL_RE = new RegExp(UWB + URL_SRC, "iu");       // .search / .test
const URL_ALL_RE = new RegExp(UWB + URL_SRC, "giu");  // finditer

// Python's str-space set (str.isspace / re \s): 0x09-0x0d, 0x1c-0x1f, 0x20,
// 0x85, 0xa0, 0x1680, 0x2000-0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000.
// (JS \s additionally eats \ufeff and misses \x1c-\x1f / \x85.)
const PY_WS = "\t\n\x0b\x0c\r\x1c-\x1f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const PY_WS_RUN_RE = new RegExp(`[${PY_WS}]+`, "g");
const PY_WS_TRIM_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

export function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function wkey(s: unknown): string {
  return String(s ?? "").replace(PY_WS_TRIM_RE, "").toLowerCase()
    .replace(PY_WS_RUN_RE, " ");
}

function pyTrim(s: string): string {
  return s.replace(PY_WS_TRIM_RE, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical host/subdomain match: `dom` is a normalized domain signature
 * (dots stripped, e.g. 'asurascanscom'); it matches `s` only when `s` carries
 * a host whose label SUFFIX normalizes to `dom`. A host that merely CONTAINS
 * the text ('notasurascans.com') does not match. Old normalized payloads
 * (no dots) are supported because HOST_RE recovers the dotted host.
 */
export function domainMatches(s: unknown, dom: unknown): boolean {
  if (!dom) return false;
  const target = String(dom);
  for (const m of String(s).matchAll(HOST_RE)) {
    const labels = m[0].toLowerCase().split(".").filter((l) => l !== "");
    for (let i = 0; i < labels.length; i++) {
      if (norm(labels.slice(i).join("")) === target) return true;
    }
  }
  return false;
}

const phraseReCache = new Map<string, RegExp>();

function phraseRe(key: string): RegExp {
  let re = phraseReCache.get(key);
  if (re === undefined) {
    re = new RegExp(`${UWB}${escapeRegex(key)}${UWBE}`, "u");
    phraseReCache.set(key, re);
  }
  return re;
}

/**
 * Safe full-label name boundary match (word boundaries on the whitespace-
 * collapsed key), so a bare/substring token never fires ('rage' inside
 * 'raging over orange juice').
 */
export function nameMatches(s: unknown, nameKey: unknown): boolean {
  if (!nameKey) return false;
  return phraseRe(String(nameKey)).test(wkey(String(s)));
}

export interface BlockedEntry {
  string: string;
  rule: string;
  chapters: number;
  count: number;
}

export interface BlockData {
  seeds?: unknown[];
  domains?: unknown[];
  prior_names?: unknown[];
  prior_domains?: unknown[];
  blocked?: unknown[];
  hash?: string;
  registry_hash?: string;
  built_from_chapters?: string[];
  [key: string]: unknown;
}

export interface PanelObs {
  [key: string]: unknown;
}

/** Loaded block list with a matches() API for consumers. */
export class Block {
  data: BlockData;
  seeds: string[];
  domains: string[];
  priorNames: string[];
  priorDomains: string[];
  exact: Set<string>;
  phrases: string[];
  hash: string;

  constructor(data: BlockData | null | undefined) {
    this.data = data ?? {};
    const d = this.data;
    this.seeds = ((d.seeds as unknown[]) ?? []).map(norm).filter(Boolean);
    this.domains = ((d.domains as unknown[]) ?? []).map(norm).filter(Boolean);
    // Shared prior signatures (registry + sibling). Names are FULL labels
    // and matched on word boundaries; domains use canonical host matching.
    this.priorNames = ((d.prior_names as unknown[]) ?? []).map(wkey).filter(Boolean);
    this.priorDomains = ((d.prior_domains as unknown[]) ?? []).map(norm).filter(Boolean);
    this.exact = new Set(((d.blocked as unknown[]) ?? []).map(
      (b) => wkey((b as { string?: unknown })?.string)));
    this.phrases = ((d.blocked as unknown[]) ?? [])
      .map((b) => wkey((b as { string?: unknown })?.string))
      .filter((k) => k.split(" ").filter(Boolean).length >= 2);
    this.hash = (d.hash as string) ?? "";
  }

  /** True if string s is promo/credit junk per the built rules. */
  matches(s: unknown): boolean {
    if (!s) return false;
    const n = norm(s), k = wkey(s);
    if (this.exact.has(k)) return true;
    for (const sd of this.seeds) {        // seeds: normalized containment
      if (sd && n.includes(sd)) return true;
    }
    for (const d of this.domains) {       // learned domains: canonical host
      if (domainMatches(s, d)) return true;
    }
    for (const d of this.priorDomains) {  // shared registry/sibling domains
      if (domainMatches(s, d)) return true;
    }
    for (const nm of this.priorNames) {   // shared full-label names
      if (nameMatches(s, nm)) return true;
    }
    for (const ph of this.phrases) {      // multiword banners: word boundary
      if (phraseRe(ph).test(k)) return true;
    }
    return false;
  }

  /**
   * True if any text string on this observed panel is a blocked
   * promo/credit. World layer counts too: a scanlator URL inside a
   * 'system window' is a reader misclassification of a burned watermark,
   * and either way the pixels carry the ad.
   */
  panelPromo(panelObs?: PanelObs | null): boolean {
    const po = panelObs ?? {};
    const overlay = Array.isArray((po as PanelObs).overlay)
      ? ((po as PanelObs).overlay as unknown[]) : [];
    const world = Array.isArray((po as PanelObs).world)
      ? ((po as PanelObs).world as unknown[]) : [];
    return overlay.some((t) => this.matches(t)) ||
      world.some((t) => this.matches(t));
  }

  /**
   * True only when this panel is DEFINITELY a full/low-usefulness promo
   * page worth dropping (see module comment + FULL_PROMO_* comment).
   *
   * Priority order (I-xx, 2026-10-10 safe-display contract):
   *   1. Explicit reader metadata wins. ``promo_page is True`` => full,
   *      EVEN with no name hit (a high-art advert page whose text the
   *      registry does not know). ``promo_page is False`` WITH usable
   *      art/bubble_at metadata => mixed (small/corner promo, kept).
   *   2. Only when the explicit flag is absent/unknown do we fall back to
   *      the coarse art/bubble_at heuristic, and ONLY as candidate
   *      selection - it is NEVER an authorization to display a page the
   *      reader did not classify. Unknown + no usable metadata => true
   *      (fail safe: block render).
   *
   * A non-promo panel (no name hit, no explicit true) always returns
   * false; the art heuristic never fires without a detected promo.
   */
  panelFullPromo(panelObs?: PanelObs | null): boolean {
    const po = (panelObs ?? {}) as PanelObs & {
      promo_page?: unknown; art?: unknown; bubble_at?: unknown;
    };
    // 1. Explicit reader classification (full credit/advert page).
    const pp = po.promo_page;
    if (pp === true) return true;
    // 2. No detected promo and no explicit True => not a full promo page.
    if (!this.panelPromo(po)) return false;
    if (pp === false) {
      // Reader explicitly says the page is story art carrying only a
      // small/corner promo: keep it (mixed). This is usable metadata.
      return false;
    }
    // 3. Legacy/unknown explicit flag: coarse candidate-selection heuristic.
    const art = po.art;
    if (typeof art === "boolean" || typeof art !== "number") {
      return true;                        // missing/invalid art -> full
    }
    if (!Number.isFinite(art) || art < 0.0 || art > 1.0) {
      return true;                        // non-finite/out-of-range -> full
    }
    if (art <= FULL_PROMO_ART_LOW) {
      return true;
    }
    const ba = po.bubble_at ?? "";
    if (typeof ba !== "string") {
      return true;                        // non-string bubble_at -> full
    }
    const baNorm = pyTrim(ba).toLowerCase();
    if (!BUBBLE_AT_VALUES.has(baNorm)) {
      return true;                        // missing/invalid -> full
    }
    if (baNorm === "full" && art < FULL_PROMO_ART_FULL) return true;
    return false;
  }

  /**
   * The blocked strings actually present on this panel (I-23: the
   * cleaner's goal-gate needs WHICH strings to ask about, not just that
   * the panel is promo).
   */
  panelPromoStrings(panelObs?: PanelObs | null): string[] {
    const po = panelObs ?? {};
    const overlay = Array.isArray((po as PanelObs).overlay)
      ? ((po as PanelObs).overlay as unknown[]) : [];
    const world = Array.isArray((po as PanelObs).world)
      ? ((po as PanelObs).world as unknown[]) : [];
    return [...overlay, ...world].filter(
      (t) => t && this.matches(t)) as string[];
  }
}

export function pathFor(outDir: string): string {
  return path.join(outDir, BLOCK_FILE);
}

/** Return Block or null (absent file = feature off, never crash a run). */
export function load(outDir: string): Block | null {
  const p = pathFor(outDir);
  if (!existsSync(p)) return null;
  try {
    return new Block(JSON.parse(readFileSync(p, "utf-8")));
  } catch (e) {
    console.log(`promo_block: WARN unreadable ${p}: ${e} (continuing unblocked)`);
    return null;
  }
}

/** Source zip by title match under downloads (fallback: any zip). Absent zip
 * = seeds skipped, obs rules still run. */
function findZip(_seriesDir: string, title: unknown): string | null {
  const dl =
    process.env.MANHWA_DOWNLOADS ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "downloads");
  let cands: string[] = [];
  try {
    cands = readdirSync(dl)
      .filter((f) => f.endsWith(".zip"))
      .map((f) => path.join(dl, f));
  } catch {
    cands = [];
  }
  const tn = norm(title ?? "");
  if (tn) {
    for (const c of cands) {
      // python os.path.splitext: a leading-dot file has no extension
      const stem = path.posix.basename(c);
      const i = stem.lastIndexOf(".");
      const base = i > 0 ? stem.slice(0, i) : stem;
      if (norm(base) === tn) return c;
    }
  }
  return cands.length === 1 ? cands[0] : null;
}

/**
 * Group-name prefix from each cbz filename + ComicInfo <Translator> read
 * from inside the NESTED cbz (no extraction; central directory + one entry).
 */
export function extractZipSeeds(zipPath: string): Set<string> {
  const seeds = new Set<string>();
  let zf: AdmZip;
  try {
    zf = new AdmZip(zipPath);
  } catch (e) {
    console.log(`promo_block: WARN cannot open zip ${zipPath}: ${e}`);
    return seeds;
  }
  for (const entry of zf.getEntries()) {
    const n = entry.entryName;
    const base = n.split("/").pop() ?? "";
    const m = /^(.+?)[_ ]+[Cc]hapter/.exec(base);
    if (m && pyTrim(m[1]) !== "") seeds.add(pyTrim(m[1]));
    if (base.toLowerCase().endsWith(".cbz")) {
      try {
        const bytes = zf.readFile(n);
        if (bytes === null) continue;
        const inner = new AdmZip(bytes);
        for (const innerEntry of inner.getEntries()) {
          const iname = innerEntry.entryName;
          if (iname.toLowerCase().endsWith("comicinfo.xml")) {
            const data = inner.readFile(iname);
            if (data !== null) {
              // Buffer.toString() replaces invalid bytes, like errors="replace"
              const d = data.toString("utf-8");
              const t = /<Translator>([^\n]*?)<\/Translator>/.exec(d);
              if (t && pyTrim(t[1]) !== "") seeds.add(pyTrim(t[1]));
            }
            break;
          }
        }
      } catch {
        // nested read is best-effort
      }
    }
  }
  return seeds;
}

interface CollectedStrings {
  occ: Map<string, Set<string>>;   // wkey -> {ch}
  raw: Map<string, string>;        // wkey -> first-seen verbatim
  inWorld: Set<string>;            // wkeys seen as WORLD text
  edgeOnly: Map<string, boolean>;  // wkey -> bool (all hits on edge pages)
}

/** string -> {chapters}, plus world-presence and edge-page facts per string. */
function collectStrings(outDir: string, chapters: string[]): CollectedStrings {
  const occ = new Map<string, Set<string>>();
  const raw = new Map<string, string>();
  const inWorld = new Set<string>();
  const edgeOnly = new Map<string, boolean>();
  for (const ch of chapters) {
    const f = path.join(outDir, `obs_${ch}.json`);
    if (!existsSync(f)) continue;
    let d: unknown;
    try {
      d = JSON.parse(readFileSync(f, "utf-8"));
    } catch {
      continue;
    }
    d = (d as { data?: unknown }).data ?? d;
    const panels = ((d as { panels?: unknown }).panels ?? []) as PanelObs[];
    const ids = panels.map((p) => String((p as PanelObs).id ?? ""));
    const pageNums: number[] = [];
    for (const id of ids) {
      const m = /^p(\d+)/.exec(id);
      if (m) pageNums.push(parseInt(m[1], 10));
    }
    const pages = [...new Set(pageNums)].sort((a, b) => a - b);
    if (pages.length === 0) continue;
    let edgeIds: number[] = pages.slice(0, EDGE_PAGES);
    edgeIds = edgeIds.concat(pages.slice(-EDGE_PAGES));
    const edge = new Set(edgeIds);
    for (let pi = 0; pi < panels.length; pi++) {
      const mm = /^p(\d+)/.exec(ids[pi]);
      if (!mm) continue;
      const pg = parseInt(mm[1], 10);
      const p = panels[pi];
      const overlay = Array.isArray((p as PanelObs).overlay)
        ? ((p as PanelObs).overlay as unknown[]) : [];
      for (const s of overlay) {
        const k = wkey(s);
        if (k.length < 4) continue;
        let chs = occ.get(k);
        if (!chs) {
          chs = new Set();
          occ.set(k, chs);
        }
        chs.add(ch);
        if (!raw.has(k)) raw.set(k, pyTrim(String(s)));
        edgeOnly.set(k, (edgeOnly.get(k) ?? true) && edge.has(pg));
      }
      const world = Array.isArray((p as PanelObs).world)
        ? ((p as PanelObs).world as unknown[]) : [];
      for (const s of world) {
        inWorld.add(wkey(s));
      }
    }
  }
  return { occ, raw, inWorld, edgeOnly };
}

export interface Registry {
  names: string[];
  domains: string[];
  digest: string;
}

function pyRepr(v: unknown): string {
  if (v === undefined || v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/**
 * Load + validate the curated shared-source registry (promo_sources.json).
 *
 * Returns `names` as FULL group labels (>=2 whitespace tokens, so a bare
 * ambiguous token like 'Asura' is rejected), `domains` as canonical
 * normalized host signatures (real dotted hosts only), and `digest` as a
 * short sha256 of the raw registry bytes (so any registry edit changes the
 * block hash). A missing / unreadable / malformed / unsupported-version
 * registry returns empty names/domains and digest "" - it contributes
 * nothing and never crashes a run.
 */
export function loadRegistry(registryPath: string = REGISTRY_FILE): Registry {
  let raw: Buffer;
  try {
    raw = readFileSync(registryPath);
  } catch (e) {
    console.log(`promo_block: WARN registry unreadable ${registryPath}: ${e}`);
    return { names: [], domains: [], digest: "" };
  }
  let data: unknown;
  try {
    data = JSON.parse(utf8Strict.decode(raw));
  } catch (e) {
    console.log(`promo_block: WARN registry not JSON ${registryPath}: ${e}`);
    return { names: [], domains: [], digest: "" };
  }
  if (!isPlainObject(data) ||
    (data as { version?: unknown }).version !== REGISTRY_VERSION) {
    console.log(`promo_block: WARN registry version ` +
      `${pyRepr(isPlainObject(data)
        ? (data as { version?: unknown }).version
        : null)} != ${REGISTRY_VERSION}; ignored`);
    return { names: [], domains: [], digest: "" };
  }
  const sources = (data as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    console.log("promo_block: WARN registry 'sources' not a list; ignored");
    return { names: [], domains: [], digest: "" };
  }
  const names = new Set<string>();
  const domains = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!isPlainObject(src)) {
      console.log(`promo_block: WARN registry source[${i}] not an object; skipped`);
      continue;
    }
    const srcNames = ((src as { names?: unknown }).names ?? []) as unknown[];
    for (const nm of srcNames) {
      if (!(typeof nm === "string")) continue;
      const key = wkey(nm);
      if (key.split(" ").filter(Boolean).length < MIN_REGISTRY_NAME_TOKENS) {
        console.log(`promo_block: WARN registry name ${pyRepr(nm)} not a full ` +
          `label; skipped`);
        continue;
      }
      names.add(key);
    }
    const srcDomains = ((src as { domains?: unknown }).domains ?? []) as unknown[];
    for (const dm of srcDomains) {
      if (!(typeof dm === "string") || !HOST_FULL_RE.test(pyTrim(dm))) {
        console.log(`promo_block: WARN registry domain ${pyRepr(dm)} not a host; ` +
          `skipped`);
        continue;
      }
      domains.add(norm(dm));
    }
  }
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return {
    names: [...names].sort(cmpCodePoints),
    domains: [...domains].sort(cmpCodePoints),
    digest,
  };
}

/** Short sha256 of the raw registry bytes ("" when the registry is invalid). */
export function registryDigest(registryPath: string = REGISTRY_FILE): string {
  return loadRegistry(registryPath).digest;
}

/** Code-point lexicographic compare (python str ordering). */
export function cmpCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const as = Array.from(a);
  const bs = Array.from(b);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ca = as[i].codePointAt(0) as number;
    const cb = bs[i].codePointAt(0) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return as.length < bs.length ? -1 : as.length > bs.length ? 1 : 0;
}

/**
 * byte-exact json.dumps(sort_keys=True) for the hash payload: separators
 * (", ", ": "), key sorting at every level, and ensure_ascii escaping
 * (named \b\t\n\f\r escapes, \u00XX for other controls and >=0x7f, lowercase
 * hex; astral chars as lowercase surrogate pairs).
 */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string") return `"${pyEscapeString(v)}"`;
  if (Array.isArray(v)) {
    return v.length === 0 ? "[]" : `[${v.map(pyJson).join(", ")}]`;
  }
  if (isPlainObject(v)) {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(cmpCodePoints);
    if (keys.length === 0) return "{}";
    return `{${keys.map((k) =>
      `"${pyEscapeString(k)}": ${pyJson(obj[k])}`).join(", ")}}`;
  }
  return String(v);
}

function pyEscapeString(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x22) out += '\\"';
    else if (cp === 0x5c) out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0d) out += "\\r";
    else if (cp === 0x09) out += "\\t";
    else if (cp < 0x20 || cp > 0x7e) {
      if (cp < 0x10000) {
        out += "\\u" + cp.toString(16).padStart(4, "0");
      } else {
        const v = cp - 0x10000;
        out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
        out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
      }
    } else out += ch;
  }
  return out;
}

const HASH_KEYS = ["seeds", "domains", "prior_names", "prior_domains",
  "registry_hash", "blocked"] as const;

/** sha256 of json.dumps({six fields}, sort_keys=True), first 16 hex chars. */
function computeHash(payload: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const k of HASH_KEYS) subset[k] = payload[k];
  return createHash("sha256").update(pyJson(subset), "utf8")
    .digest("hex").slice(0, 16);
}

/**
 * Build + write promo_block.json. Mechanical only; returns Block.
 * (Python calls this build(); the v2 name is buildBlock.)
 */
export function buildBlock(
  seriesDir: string,
  outDir: string,
  zipPath?: string | null,
  verbose = true,
): Block {
  let meta: Record<string, unknown> = {};
  const mp = path.join(seriesDir, "meta.json");
  if (existsSync(mp)) {
    try {
      const rawMeta = JSON.parse(readFileSync(mp, "utf-8"));
      if (isPlainObject(rawMeta)) meta = rawMeta as Record<string, unknown>;
    } catch {
      // a corrupt meta.json only loses the title fallback for findZip
    }
  }

  const chapters = existsSync(outDir)
    ? readdirSync(outDir)
        .filter((d) => /^ch\d+$/.test(d))
        .sort((a, b) =>
          parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10))
    : [];

  const zip = zipPath || findZip(seriesDir, (meta as { title?: unknown }).title ?? "");
  const seeds = zip ? extractZipSeeds(zip) : new Set<string>();
  const registry = loadRegistry();

  const { occ, raw, inWorld, edgeOnly } = collectStrings(outDir, chapters);

  const blocked: BlockedEntry[] = [];
  const domainNames = new Set<string>();
  // R1 URL: domain corroborated across chapters -> block family
  const domCh = new Map<string, Set<string>>();
  for (const [k, chs] of occ) {
    const s = raw.get(k) ?? "";
    for (const m of s.matchAll(URL_ALL_RE)) {
      const host = m[1].replace(/^(?:https?):\/\/|^(?:www)\./gi, "");
      const dom = norm(host.split("/")[0] ?? "");
      if (dom) {
        let set = domCh.get(dom);
        if (!set) {
          set = new Set();
          domCh.set(dom, set);
        }
        for (const c of chs) set.add(c);
      }
    }
  }
  for (const [dom, chs] of domCh) {
    if (chs.size >= MIN_CH_URL) domainNames.add(dom);
  }
  // per-string rules
  for (const [k, chs] of occ) {
    const s = raw.get(k) ?? "";
    const n = norm(s);
    let rule: string | null = null;
    if (URL_RE.test(s) && [...domainNames].some((d) => domainMatches(s, d))) {
      rule = "R1-URL";
    } else if ([...seeds].some((sd) => n.includes(norm(sd)))) {
      rule = "SEED";                    // seed containment: no floor
    } else if (PROMO_RE.test(s) && chs.size >= MIN_CH_PROMO) {
      rule = "R2-PROMO";
    } else if (s.includes("|") && CREDIT_ROLE.test(s) &&
      chs.size >= MIN_CH_CREDIT) {
      rule = "R3-CREDIT";
    } else if (chs.size >= MIN_CH_EDGE && (edgeOnly.get(k) ?? false) &&
      !inWorld.has(k)) {
      rule = "R4-EDGE";
    }
    if (rule) {
      blocked.push({ string: s, rule: rule, chapters: chs.size, count: chs.size });
    }
  }
  blocked.sort((a, b) =>
    (b.chapters - a.chapters) || cmpCodePoints(a.string, b.string));

  const payload: Record<string, unknown> = {
    series: path.posix.basename(seriesDir.replace(/\/+$/, "")),
    title: (meta as { title?: unknown }).title ?? "",
    source_zip: zip || "",
    seeds: [...seeds].sort(cmpCodePoints),
    domains: [...domainNames].sort(cmpCodePoints),
    prior_names: registry.names,
    prior_domains: registry.domains,
    registry_hash: registry.digest,
    blocked: blocked,
    corroboration: {
      url: MIN_CH_URL, promo: MIN_CH_PROMO, credit: MIN_CH_CREDIT, edge: MIN_CH_EDGE,
    },
  };
  const h = computeHash(payload);
  payload.hash = h;
  payload.built_from_chapters = chapters;
  writeFileSync(pathFor(outDir), JSON.stringify(payload, null, 1));
  if (verbose) {
    console.log(`promo_block: ${blocked.length} strings, ${domainNames.size} domains, ` +
      `${seeds.size} seeds -> ${pathFor(outDir)} (hash ${h})`);
    for (const b of blocked.slice(0, 12)) {
      console.log(`   [${b.rule}] ${b.chapters}ch  ${pyRepr(b.string.slice(0, 70))}`);
    }
  }
  return new Block(payload as BlockData);
}

/**
 * Load if fresh; build if missing, new obs chapters appeared, or the
 * registry changed (mechanical rebuild, zero API cost - the point is the list
 * grows as the season reads in). Never raises for a run's sake.
 */
export function ensure(
  seriesDir: string,
  outDir: string,
  zipPath?: string | null,
): Block | null {
  try {
    const b = load(outDir);
    if (b === null) return buildBlock(seriesDir, outDir, zipPath);
    const have = new Set(b.data.built_from_chapters ?? []);
    const now = readdirSync(outDir)
      .filter((f) => f.startsWith("obs_ch") && f.endsWith(".json"))
      .map((f) => f.slice(4, -5));
    const missing = now.filter((c) => !have.has(c));
    if (missing.length > 0) {
      console.log(`promo_block: ${missing.length} new obs chapter(s) -> rebuilding`);
      return buildBlock(seriesDir, outDir, zipPath);
    }
    if (registryDigest() !== (b.data.registry_hash ?? "")) {
      console.log("promo_block: shared-source registry changed -> rebuilding");
      return buildBlock(seriesDir, outDir, zipPath);
    }
    return b;
  } catch (e) {
    console.log(`promo_block: WARN build failed (${e}); continuing unblocked`);
    return null;
  }
}
