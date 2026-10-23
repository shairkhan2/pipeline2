/**
 * Recap style report for story-mode scripts (advisory, never blocks).
 *
 * Measures a script against the recap-channel target analysed from Manhwa Fresh
 * (first 6 min of "Arrogant Students Had No Idea the Academy Gardener..."):
 * ~214 wpm, ~10 spoken words per cut (~2.7 s shots), lines ~20-30 words,
 * causal glue between lines, no "then" chains, cold open, ending on the turn.
 * Replaces the legacy word-overlap fact check, which is not a grounding test.
 */

export interface StyleMetric {
  key: string;
  value: number | string;
  target: string;
  ok: boolean;
}

export interface StyleReport {
  lines: number;
  words: number;
  metrics: StyleMetric[];
  /** Lines worth a human look: then-chains, image description, repeated openers. */
  flags: string[];
}

// Calibrated on the reference transcript: 0.39 of its sentences open with one of these.
const GLUE = /^(but|so|and|because|now|still|except|yet|meanwhile|instead|only|until|later|after|once|when|while|even|which is why|that's why|by)\b/i;
const THEN_CHAIN = /(,\s*(and\s+)?then\b|\band then\b|\bthen\s+(he|she|they|it|sia|minjun)\b)/i;
const DESCRIBE = /\b(we see|is shown|can be seen|the (panel|image|picture|frame|page|scene) (shows|reveals)|close-up|in the background)\b/i;
const VIEWER_Q = /\?\s*$|\b(stay tuned|let me know|comment below|what do you think)\b/i;

function narrationLines(script: string): Array<{ text: string; panels: number; hold: boolean }> {
  const out: Array<{ text: string; panels: number; hold: boolean }> = [];
  for (const raw of script.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const panels = (l.match(/@p\d{4}_\d+/g) ?? []).length;
    const hold = /@hold\b/.test(l);
    const text = l
      .replace(/@p\d{4}_\d+/g, "")
      .replace(/@hold\b/g, "")
      .replace(/\[[a-z ]+\]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) out.push({ text, panels, hold });
  }
  return out;
}

const wc = (s: string): number => (s.match(/\S+/g) ?? []).length;

export function styleReport(script: string): StyleReport {
  const lines = narrationLines(script);
  const words = lines.reduce((n, l) => n + wc(l.text), 0);
  const spoken = lines.filter((l) => !l.hold);
  const cuts = Math.max(1, lines.reduce((n, l) => n + l.panels, 0));
  const lens = spoken.map((l) => wc(l.text));
  const median = lens.length ? [...lens].sort((a, b) => a - b)[Math.floor(lens.length / 2)]! : 0;
  const glued = spoken.slice(1).filter((l) => GLUE.test(l.text)).length;
  const glueShare = spoken.length > 1 ? glued / (spoken.length - 1) : 0;
  const flags: string[] = [];

  spoken.forEach((l, i) => {
    if (THEN_CHAIN.test(l.text)) flags.push(`line ${i + 1} then-chain: ${l.text.slice(0, 90)}`);
    if (DESCRIBE.test(l.text)) flags.push(`line ${i + 1} describes the image: ${l.text.slice(0, 90)}`);
  });
  const openers = new Map<string, number>();
  for (const l of spoken) {
    const k = l.text.split(/\s+/).slice(0, 2).join(" ").toLowerCase();
    openers.set(k, (openers.get(k) ?? 0) + 1);
  }
  for (const [k, n] of openers) if (n >= 3) flags.push(`opener "${k}" used ${n}x`);
  const last = spoken[spoken.length - 1]?.text ?? "";
  if (VIEWER_Q.test(last)) flags.push(`ending asks the viewer instead of landing the turn: ${last.slice(0, 90)}`);
  const first = spoken[0]?.text ?? "";
  const coldOpen = !/^(in this|today|this (chapter|episode)|welcome|last time)\b/i.test(first);

  const metrics: StyleMetric[] = [
    { key: "words per cut", value: +(words / cuts).toFixed(1), target: "8-14", ok: words / cuts >= 8 && words / cuts <= 14 },
    { key: "median line words", value: median, target: "18-30", ok: median >= 18 && median <= 30 },
    { key: "causal glue share", value: +glueShare.toFixed(2), target: "0.25-0.6 (ref 0.39)", ok: glueShare >= 0.25 && glueShare <= 0.6 },
    { key: "then-chains", value: flags.filter((f) => f.includes("then-chain")).length, target: "0", ok: !flags.some((f) => f.includes("then-chain")) },
    { key: "image description", value: flags.filter((f) => f.includes("describes the image")).length, target: "0", ok: !flags.some((f) => f.includes("describes the image")) },
    { key: "cold open", value: coldOpen ? "yes" : "no", target: "yes", ok: coldOpen },
    { key: "lands on the turn", value: VIEWER_Q.test(last) ? "no" : "yes", target: "yes", ok: !VIEWER_Q.test(last) },
  ];
  return { lines: lines.length, words, metrics, flags };
}

export function formatStyleReport(r: StyleReport): string[] {
  const out = [`   style (recap target): ${r.lines} lines, ${r.words} words`];
  for (const m of r.metrics) out.push(`     ${m.ok ? "ok  " : "MISS"} ${m.key}: ${m.value} (target ${m.target})`);
  for (const f of r.flags.slice(0, 8)) out.push(`     - ${f}`);
  return out;
}
