/**
 * Find the Error, the logic: no DOM, no subject. A spec holds a few short passages. In most, one sentence is false; in about
 * one in four, none is. The student taps the sentence they think is wrong (or says none is), and if they found the false one
 * they pick the right repair from three. The engine reads which sentence is false from the spec's own marks and never
 * writes a sentence of its own, so a slip in a spec cannot teach a falsehood the build did not see.
 *
 * Rungs: 0 shows four sentences, 1 shows up to six, and 2 puts the false sentence between two true ones that read much
 * like it.
 */
import { clip } from '../../report';
import { rng, roundOf, type RoundResult } from '../../engine';
import { similarity, standaloneProblem } from '../sort/logic';

// ── The spec ─────────────────────────────────────────────────────────────────

export interface SpotSentence { t: string; ok: boolean }
export interface SpotPassage {
  s: SpotSentence[];
  /** What the false sentence should say. Present when (and only when) a sentence is marked false. */
  correction?: string;
  /** Two plausible but wrong repairs. */
  repairs?: string[];
  /** The study items its false sentence tests. A run reaches only some passages, so this is kept per passage. */
  covers?: string[];
}
export interface SpotSpec { passages: SpotPassage[]; intro?: string }

export interface SpotAttempt {
  /** The sentence tapped, as an index into the task's sentences, or null for "nothing is wrong". */
  pick: number | null;
  /** The repair chosen, as an index into the task's options. Only asked when the false sentence was found. */
  repair?: number;
}

export const MIN_PASSAGES = 3;
export const MAX_SPEC_JSON = 3900;
const MIN_SENTENCES = 4;
const MAX_SENTENCES = 7;
const MAX_SENTENCE = 320;
/** Sentences shown per rung (an upper bound). */
const SHOWN = [4, 6, 5];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ── Checking a spec ──────────────────────────────────────────────────────────

export function issues(spec: SpotSpec): string[] {
  const out: string[] = [];
  if (!spec || typeof spec !== 'object') return ['The spec is missing.'];
  const passages = Array.isArray(spec.passages) ? spec.passages : [];
  if (passages.length < MIN_PASSAGES) out.push(`"passages" needs at least ${MIN_PASSAGES} passages so a run does not repeat one, and it has ${passages.length}.`);
  const falsehoods = new Set<string>();
  let withError = 0;
  passages.forEach((p, i) => {
    const where = `Passage ${i + 1}`;
    const s = Array.isArray(p?.s) ? p.s : [];
    if (s.length < MIN_SENTENCES || s.length > MAX_SENTENCES) out.push(`${where} has ${s.length} sentences and needs ${MIN_SENTENCES} to ${MAX_SENTENCES}.`);
    s.forEach((x, j) => {
      if (!x || typeof x.t !== 'string' || !x.t.trim()) out.push(`${where}, sentence ${j + 1} has no "t" (its text).`);
      else if (x.t.length > MAX_SENTENCE) out.push(`${where}, sentence ${j + 1} is longer than ${MAX_SENTENCE} characters.`);
      if (typeof x?.ok !== 'boolean') out.push(`${where}, sentence ${j + 1} must say whether it is true ("ok": true or false).`);
    });
    const texts = s.map((x) => norm(String(x?.t ?? '')));
    if (new Set(texts).size !== texts.length) out.push(`${where} repeats a sentence.`);
    const bad = s.filter((x) => x && x.ok === false);
    if (bad.length > 1) out.push(`${where} has ${bad.length} false sentences; at most one is allowed.`);
    if (bad.length === 1) {
      withError++;
      falsehoods.add(norm(bad[0].t));
      const fix = p.correction;
      if (typeof fix !== 'string' || !fix.trim()) out.push(`${where} has a false sentence but no "correction".`);
      else {
        const why = standaloneProblem(fix);
        if (why) out.push(`${where}'s correction ${why}.`);
        if (norm(fix) === norm(bad[0].t)) out.push(`${where}'s correction is the false sentence.`);
        if (texts.includes(norm(fix))) out.push(`${where}'s correction is already a sentence of the passage.`);
      }
      const rep = Array.isArray(p.repairs) ? p.repairs : [];
      if (rep.length !== 2 || rep.some((r) => typeof r !== 'string' || !r.trim())) out.push(`${where} needs exactly two wrong "repairs" to stand beside the correction.`);
      else {
        if (new Set([...rep, fix ?? ''].map(norm)).size !== 3) out.push(`${where}'s three repair choices are not all different.`);
        if (rep.some((r) => norm(r) === norm(bad[0].t))) out.push(`${where} offers the false sentence itself as a repair.`);
        if (rep.some((r) => texts.includes(norm(r)))) out.push(`${where} offers a sentence of the passage as a repair.`);
        if (rep.some((r) => r.length > MAX_SENTENCE)) out.push(`${where} has a repair longer than ${MAX_SENTENCE} characters.`);
      }
    } else if (p?.correction !== undefined || p?.repairs !== undefined) out.push(`${where} has no false sentence, so it needs no "correction" or "repairs".`);
  });
  if (passages.length && withError === 0) out.push('At least one passage needs a false sentence.');
  if (withError && passages.length - withError > passages.length / 2) out.push('More than half the passages have nothing wrong; about one in four is right.');
  // A falsehood planted in one passage must not turn up as a true sentence or a repair elsewhere in the spec.
  passages.forEach((p, i) => {
    for (const x of p?.s ?? []) if (x?.ok && falsehoods.has(norm(x.t))) out.push(`Passage ${i + 1} has, as a true sentence, a sentence that is planted as false in another passage.`);
    for (const r of p?.repairs ?? []) if (falsehoods.has(norm(r))) out.push(`Passage ${i + 1} offers, as a repair, a sentence that is planted as false in another passage.`);
  });
  const size = JSON.stringify(spec).length;
  if (size > MAX_SPEC_JSON) out.push(`The spec is ${size} characters and the catalogue allows about ${MAX_SPEC_JSON} here: cut a passage or shorten one.`);
  return out;
}

/**
 * Words that give a planted sentence away without any knowledge of the subject: an absolute the correction does not share.
 * A warning for writers rather than a refusal, because a true absolute can be what the lecture says.
 */
const TELLS = /\b(only|exactly|always|never|any|all|every|wherever|whatever|solely|entirely|completely)\b/gi;
export function tells(spec: SpotSpec): string[] {
  const out: string[] = [];
  (spec.passages ?? []).forEach((p, i) => {
    const planted = p.s.find((x) => !x.ok);
    if (!planted) return;
    const fix = norm(p.correction ?? '');
    const words = [...new Set((planted.t.match(TELLS) ?? []).map((w) => w.toLowerCase()))].filter((w) => !new RegExp(`\\b${w}\\b`).test(fix));
    if (words.length) out.push(`Passage ${i + 1}'s false sentence uses "${words.join('", "')}", which its correction does not: that gives it away.`);
  });
  return out;
}

// ── Setting a round ──────────────────────────────────────────────────────────

export interface SpotOption { t: string; right: boolean }
export interface SpotTask {
  spec: SpotSpec;
  rung: number;
  round: number;
  /** The sentences shown. */
  sentences: SpotSentence[];
  /** The index of the false one among them, or -1 when none is wrong. */
  falseAt: number;
  /** The three repairs in the order shown (empty when nothing is wrong). */
  options: SpotOption[];
  correction: string;
}

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const r = rng(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const falseIndex = (p: SpotPassage) => p.s.findIndex((x) => !x.ok);

/** How much the false sentence reads like the true ones either side of it (0 when it sits at an edge). */
function neighbourCloseness(p: SpotPassage): number {
  const f = falseIndex(p);
  if (f <= 0 || f >= p.s.length - 1) return 0;
  return Math.min(similarity(p.s[f].t, p.s[f - 1].t), similarity(p.s[f].t, p.s[f + 1].t));
}

/** Which passage a round uses. Rung 2 favours the ones whose false sentence is between two true sentences that read like it. */
export function choosePassage(spec: SpotSpec, runSeed: string, round: number, rung: number): number {
  const idx = spec.passages.map((_, i) => i);
  let order = shuffled(idx, `${runSeed}|passages`);
  if (rung >= 2) {
    const tier = (i: number) => {
      const p = spec.passages[i];
      return falseIndex(p) < 0 ? 0 : neighbourCloseness(p) > 0 ? 0 : 1;
    };
    order = order.sort((a, b) => tier(a) - tier(b));
    // Among the best tier, the closest-reading come first, but only on some seeds, so the same passage is not always first.
    const top = order.filter((i) => tier(i) === 0).sort((a, b) => neighbourCloseness(spec.passages[b]) - neighbourCloseness(spec.passages[a]));
    order = [...shuffled(top, `${runSeed}|close`), ...order.filter((i) => tier(i) !== 0)];
  }
  return order[round % order.length];
}

/** The start of the window of sentences shown. Never starts at a sentence that needs the one before it. */
export function windowStart(p: SpotPassage, size: number, rung: number, seed: string): number {
  const n = p.s.length;
  if (n <= size) return 0;
  const f = falseIndex(p);
  const lo = f >= 0 ? Math.max(0, f - size + 1) : 0;
  const hi = f >= 0 ? Math.min(f, n - size) : n - size;
  const starts: number[] = [];
  for (let s = lo; s <= hi; s++) {
    if (s > 0 && standaloneProblem(p.s[s].t)) continue;
    if (rung >= 2 && f >= 0 && (f === s || f === s + size - 1) && n > size) continue; // the false one stays between two true ones
    starts.push(s);
  }
  if (!starts.length) return Math.max(0, Math.min(lo, n - size));
  return starts[Math.floor(rng(`${seed}|start`)() * starts.length)];
}

export function prepare(spec: SpotSpec, seed: string, rung: number): SpotTask {
  const r = Math.max(0, Math.min(2, Math.floor(rung)));
  const round = roundOf(seed);
  const runSeed = seed.replace(/:\d+$/, '');
  const p = spec.passages[choosePassage(spec, runSeed, round, r)];
  const size = Math.min(SHOWN[r], p.s.length);
  const start = windowStart(p, size, r, seed);
  const sentences = p.s.slice(start, start + size);
  const f = sentences.findIndex((x) => !x.ok);
  const options: SpotOption[] = f < 0 ? [] : shuffled([
    { t: p.correction as string, right: true },
    ...(p.repairs ?? []).map((t) => ({ t, right: false })),
  ], `${seed}|options`);
  return { spec, rung: r, round, sentences, falseAt: f, options, correction: p.correction ?? '' };
}

// ── Judging a round ──────────────────────────────────────────────────────────

/** True when the student found the false sentence (or rightly said none is wrong). */
export const foundIt = (task: SpotTask, attempt: SpotAttempt) => (task.falseAt < 0 ? attempt.pick === null : attempt.pick === task.falseAt);

/** Whether the second question is asked: only when the false sentence was found. */
export const needsRepair = (task: SpotTask, attempt: Pick<SpotAttempt, 'pick'>) => task.falseAt >= 0 && attempt.pick === task.falseAt;

/** What this round tested, when the spec says so per passage: the passage it showed, and nothing for one with no error. */
function roundCovers(task: SpotTask): Pick<RoundResult, 'covers'> {
  if (!task.spec.passages.some((p) => p.covers?.length)) return {};
  const shown = task.falseAt >= 0 ? task.spec.passages.find((p) => p.correction === task.correction) : undefined;
  return { covers: shown?.covers ?? [] };
}

export function result(task: SpotTask, attempt: SpotAttempt): RoundResult {
  return { ...judged(task, attempt), ...roundCovers(task) };
}

function judged(task: SpotTask, attempt: SpotAttempt): RoundResult {
  const falseText = task.falseAt >= 0 ? task.sentences[task.falseAt].t : '';
  if (task.falseAt < 0) {
    const met = attempt.pick === null;
    const out: RoundResult = {
      met,
      label: 'Sees that nothing in a short passage is wrong, and leaves true sentences alone',
      why: met ? 'Every sentence in this passage is true, so there was nothing to change.' : `"${clip(task.sentences[attempt.pick as number].t, 100)}" is true. Nothing in this passage was wrong.`,
    };
    if (!met) out.misconception = clip(`Doubts a true statement: ${clip(task.sentences[attempt.pick as number].t, 90)}`, 120);
    return out;
  }
  const label = `Spots that "${clip(falseText, 90)}" is false and repairs it as "${clip(task.correction, 80)}"`;
  const found = attempt.pick === task.falseAt;
  const repaired = found && attempt.repair !== undefined && !!task.options[attempt.repair]?.right;
  const met = found && repaired;
  let why: string;
  let misconception: string | undefined;
  if (!found) {
    why = attempt.pick === null
      ? `One sentence was false: "${clip(falseText, 110)}" The true version: ${task.correction}`
      : `"${clip(task.sentences[attempt.pick].t, 90)}" is true. The false one was "${clip(falseText, 90)}" The true version: ${task.correction}`;
    misconception = clip(`Takes as true: ${clip(falseText, 100)}`, 120);
  } else if (!repaired) {
    const chosen = attempt.repair !== undefined ? task.options[attempt.repair]?.t : undefined;
    why = `You found the false sentence. What is true: ${task.correction}`;
    if (chosen) misconception = clip(`Believes: ${clip(chosen, 105)}`, 120);
  } else {
    why = `That sentence was false, and the true version is: ${task.correction}`;
  }
  return { met, label: clip(label, 200), why: clip(why, 420), ...(misconception ? { misconception } : {}) };
}
