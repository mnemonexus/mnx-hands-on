/**
 * Grow, Arrest, Count, the logic: no DOM, no subject. A spec names an ordered run of stages that a population moves through,
 * how long each lasts, and a measured value for each (what a histogram of the population would show). The engine steps the
 * population forward with a small age-structured model, so a treatment (block a transition, slow a stage, kill in a stage, lift
 * a block at a time) is worked out and never typed in. A slip in a spec gives a wrong setup, which `issues` can see, and never a
 * wrong answer told to a student.
 *
 * The model, exactly:
 *   - Time moves in steps. Every stage is cut into bins one step wide, so a stage that lasts 10 hours at a step of 0.5 has 20.
 *   - Each step, everything in a bin moves to the next bin. The last bin of a stage is where an individual waits for the
 *     transition out. A blocked transition leaves them there, and they pile up.
 *   - After the last stage the population either loops (each individual becomes `loop` individuals in the first stage) or,
 *     in a line, leaves, while new individuals join the first stage at a steady rate.
 *   - Before anything is done the population has been running for ever, so it holds the stable spread of ages (for a loop that
 *     is a geometric fall with age; for a line it is flat). That is worked out, not typed.
 *   - Slowing a stage by a whole number f makes it f times as long, keeping each individual's progress through it.
 *   - A killing treatment removes a fixed share of the individuals in a stage each step (a constant rate).
 *   - The measured value follows the stage's progress: a stage value is one number, or two (from, to) with a straight ramp.
 *     The histogram spreads each individual over a Gaussian whose width is `cv` times the value.
 *
 * Rungs (the task is chosen by seed):
 *   0  stage    which stage holds the most individuals once the treatment has run
 *   1  shape    sketch the histogram of the measured value at the end
 *   2  number   the share of the population in a stage (a percentage), or the time until that share is reached
 */
import { hashSeed, rng, roundOf, type RoundResult } from '../../engine';

// ── The spec ─────────────────────────────────────────────────────────────────

export interface GrowStage {
  id: string;
  label: string;
  /** How long the stage lasts, in the spec's time unit. A multiple of `step`. */
  duration: number;
  /** The measured value: one number, or [at the start of the stage, at the end]. */
  value: number | [number, number];
  /** An honest word about what the stage leaves out, at most 160 characters. */
  note?: string;
}
export interface GrowTransition {
  id: string;
  /** The stage this transition leaves. Each stage has exactly one. */
  from: string;
  label?: string;
}
export type GrowEffect =
  | { kind: 'block'; transition: string }
  | { kind: 'slow'; stage: string; factor: number }
  | { kind: 'kill'; stage: string; rate: number }
  | { kind: 'remove-block'; transition: string; at: number };
export interface GrowTreatment {
  id: string;
  /** An instruction in the imperative, such as "Add the drug". */
  label: string;
  /** One plain sentence on why the treatment does what it does: the course's reason. The engine adds the numbers. */
  because: string;
  /** What the treatment does. May be empty only when `control` is true. */
  effects: GrowEffect[];
  /** A treatment that leaves things as they are, to be told apart from one that does not. */
  control?: boolean;
  /** How long the run lasts, in the spec's time unit. One is chosen for each round. */
  times: number[];
}
export interface GrowMeasure {
  name: string;
  unit: string;
  min: number;
  max: number;
  /** The number of bars, 8 to 32. */
  bins: number;
  /** The width of each individual's spread, as a share of its value (0 to 0.2). */
  cv?: number;
}
export interface GrowSpec {
  story?: string;
  /** True when the durations, the loop gain and the rates are made up for the picture and not stated by the course. */
  illustrative: boolean;
  /** An honest word about what is assumed. When `illustrative` is true it must say so. */
  note: string;
  /** The time unit, such as "h". */
  unit: string;
  /** The width of a time step, in the time unit. */
  step: number;
  individual?: string;
  individuals?: string;
  /** Each individual becomes this many at the end of the last stage. Absent: a line, with individuals joining and leaving. */
  loop?: number;
  measure: GrowMeasure;
  stages: GrowStage[];
  transitions: GrowTransition[];
  treatments: GrowTreatment[];
}

export type GrowAttempt = { stage?: string; sketch?: number[]; value?: number };

export type GrowAsk =
  | { kind: 'stage' }
  | { kind: 'shape' }
  | { kind: 'fraction'; stage: number }
  | { kind: 'time'; stage: number; share: number };

/** One moment of the population. Shares are of the individuals present; `hist[stage][bar]` sums to 1 over the lot. */
export interface GrowFrame { t: number; total: number; shares: number[]; hist: number[][] }
export interface GrowSim { frames: GrowFrame[]; step: number }

export interface GrowTask {
  spec: GrowSpec;
  seed: string;
  rung: number;
  treatment: GrowTreatment;
  length: number;
  ask: GrowAsk;
  sim: GrowSim;
  /** The same run with nothing done, for the "before" outline and the misconception check. */
  base: GrowSim;
  /** The stage holding the most at the end. */
  top: number;
  /** The true number for a rung 2 question, in percent or in the time unit. */
  answer: number | null;
  /** Tolerance on that number, in the same unit. */
  tolerance: number;
  instruction: string;
  question: string;
}

// ── Limits ───────────────────────────────────────────────────────────────────

export const MAX_SPEC_JSON = 3900;
const MAX_STAGES = 8;
const MAX_BINS = 1500;
const MAX_FRAMES = 700;
/** How much a stage's share must lead the next one by for "which stage holds the most" to be a fair question. */
const LEAD = 1.15;
/** The share of the shapes' overlap above which a sketch counts as right. */
const SKETCH_PASS = 0.65;
/** A treatment that leaves the final histogram this close to the untreated one is not a treatment. */
const SAME = 0.9;

const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

// ── Small maths ──────────────────────────────────────────────────────────────

/** The error function (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const cdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

export const sum = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

/** Whole numbers show without a point; otherwise three significant figures. */
export function fmt(x: number): string {
  if (!Number.isFinite(x)) return '?';
  const r = Math.abs(x) >= 100 ? Math.round(x) : Number(x.toPrecision(3));
  return String(r);
}
export const pct = (share: number) => `${Math.round(share * 100)}%`;

/** A stage's label inside a sentence: set in quotes when it is more than one word, so "Before the lesion" does not read as a sentence start. */
export const q = (label: string) => (/\s/.test(label) ? `“${label}”` : label);

/** A value with its unit: a single letter or % sits against the number, anything longer after a space. */
export function withUnit(value: number, unit: string): string {
  const v = fmt(value);
  if (!unit) return v;
  return unit.length <= 1 ? `${v}${unit}` : `${v} ${unit}`;
}

const stageValue = (value: GrowStage['value'], progress: number) => (Array.isArray(value) ? value[0] + (value[1] - value[0]) * progress : value);

export function valueRange(stage: GrowStage): [number, number] {
  return Array.isArray(stage.value) ? [Math.min(...stage.value), Math.max(...stage.value)] : [stage.value, stage.value];
}

/** Where a stage's value sits, in words for a legend: "2 N" or "2 to 4 N". */
export function valueText(spec: GrowSpec, stage: GrowStage): string {
  const unit = spec.measure.unit;
  if (!Array.isArray(stage.value)) return withUnit(stage.value, unit);
  const [a, b] = stage.value;
  return a === b ? withUnit(a, unit) : `${fmt(a)} to ${withUnit(b, unit)}`;
}

export const edgesOf = (m: GrowMeasure) => Array.from({ length: m.bins + 1 }, (_, i) => m.min + ((m.max - m.min) * i) / m.bins);
export const centreOf = (m: GrowMeasure, b: number) => m.min + ((m.max - m.min) * (b + 0.5)) / m.bins;

/** The weights of one individual's spread over the bars, summing to 1. */
function barWeights(m: GrowMeasure, v: number): Float64Array {
  const row = new Float64Array(m.bins);
  const sd = (m.cv ?? 0) * Math.abs(v);
  const w = (m.max - m.min) / m.bins;
  if (sd < w * 0.02) {
    row[Math.max(0, Math.min(m.bins - 1, Math.floor((v - m.min) / w)))] = 1;
    return row;
  }
  let prev = cdf((m.min - v) / sd);
  let total = 0;
  for (let b = 0; b < m.bins; b++) {
    const next = cdf((m.min + w * (b + 1) - v) / sd);
    row[b] = Math.max(0, next - prev);
    total += row[b];
    prev = next;
  }
  if (total < 1e-9) { row[v < m.min ? 0 : m.bins - 1] = 1; return row; }
  for (let b = 0; b < m.bins; b++) row[b] /= total;
  return row;
}

// ── Reading the spec ─────────────────────────────────────────────────────────

const stageIndex = (spec: GrowSpec, id: string) => spec.stages.findIndex((s) => s.id === id);
const transitionOf = (spec: GrowSpec, id: string) => spec.transitions.find((t) => t.id === id);
export const individualsOf = (spec: GrowSpec) => spec.individuals ?? 'individuals';
export const individualOf = (spec: GrowSpec) => spec.individual ?? 'individual';

/** The name of a transition for a sentence: its label, or "leaving X". */
export function transitionName(spec: GrowSpec, t: GrowTransition): string {
  return t.label ?? `leaving ${spec.stages[stageIndex(spec, t.from)]?.label ?? t.from}`;
}

// ── The model ────────────────────────────────────────────────────────────────

/**
 * Runs the population for `length` time units from its stable state with the effects applied from time 0.
 * Frame k is the population at time k * step; frame 0 is the starting state, which the treatment has not yet touched.
 */
export function simulate(spec: GrowSpec, effects: GrowEffect[], length: number): GrowSim {
  const { step, stages, measure } = spec;
  const S = stages.length;
  const baseN = stages.map((s) => Math.max(1, Math.round(s.duration / step)));
  const N0 = sum(baseN);
  const slow = stages.map((s) => {
    const e = effects.find((x) => x.kind === 'slow' && x.stage === s.id);
    return e && e.kind === 'slow' ? Math.max(1, Math.round(e.factor)) : 1;
  });
  const len = baseN.map((n, i) => n * slow[i]);
  const start: number[] = [];
  const baseStart: number[] = [];
  let at = 0, bat = 0;
  for (let i = 0; i < S; i++) { start.push(at); baseStart.push(bat); at += len[i]; bat += baseN[i]; }
  const N = at;
  const keep = stages.map((s) => {
    const e = effects.find((x) => x.kind === 'kill' && x.stage === s.id);
    return e && e.kind === 'kill' ? Math.exp(-e.rate * step) : 1;
  });
  // When each stage's exit is held until: 0 = never held, Infinity = held for the whole run.
  const heldUntil = new Array<number>(S).fill(0);
  for (const e of effects) {
    if (e.kind !== 'block') continue;
    const t = transitionOf(spec, e.transition);
    const i = t ? stageIndex(spec, t.from) : -1;
    if (i >= 0) heldUntil[i] = Infinity;
  }
  for (const e of effects) {
    if (e.kind !== 'remove-block') continue;
    const t = transitionOf(spec, e.transition);
    const i = t ? stageIndex(spec, t.from) : -1;
    if (i >= 0) heldUntil[i] = e.at;
  }

  // The stable spread of the untreated population, then carried over to this layout with each individual's progress kept.
  const base = new Float64Array(N0);
  if (spec.loop) {
    const lambda = Math.pow(spec.loop, 1 / N0);
    for (let j = 0; j < N0; j++) base[j] = Math.pow(lambda, -j);
  } else base.fill(1);
  const baseTotal = sum(base);
  for (let j = 0; j < N0; j++) base[j] /= baseTotal;
  const inflow = spec.loop ? 0 : 1 / N0;
  let m = new Float64Array(N);
  for (let i = 0; i < S; i++) {
    for (let k = 0; k < baseN[i]; k++) {
      const mass = base[baseStart[i] + k] / slow[i];
      for (let r = 0; r < slow[i]; r++) m[start[i] + k * slow[i] + r] = mass;
    }
  }

  // What each bin shows on the histogram. A stage with one value has one row for every bin.
  const rows: Array<Float64Array | null> = new Array<Float64Array | null>(N).fill(null);
  const constRow: Array<Float64Array | null> = new Array<Float64Array | null>(S).fill(null);
  for (let i = 0; i < S; i++) {
    const [lo, hi] = valueRange(stages[i]);
    if (lo === hi) {
      constRow[i] = barWeights(measure, lo);
    } else {
      for (let k = 0; k < len[i]; k++) rows[start[i] + k] = barWeights(measure, stageValue(stages[i].value, (k + 0.5) / len[i]));
    }
  }

  const steps = Math.max(1, Math.round(length / step));
  const frames: GrowFrame[] = [];
  const snapshot = (t: number): GrowFrame => {
    const shares: number[] = [];
    const hist: number[][] = [];
    const total = sum(m);
    for (let i = 0; i < S; i++) {
      let mass = 0;
      const h = new Array<number>(measure.bins).fill(0);
      const c = constRow[i];
      for (let k = 0; k < len[i]; k++) {
        const w = m[start[i] + k];
        mass += w;
        if (c) continue;
        const row = rows[start[i] + k]!;
        for (let b = 0; b < measure.bins; b++) h[b] += w * row[b];
      }
      if (c) for (let b = 0; b < measure.bins; b++) h[b] = mass * c[b];
      shares.push(total > 1e-12 ? mass / total : 0);
      hist.push(total > 1e-12 ? h.map((x) => x / total) : h);
    }
    return { t, total, shares, hist };
  };
  frames.push(snapshot(0));
  for (let k = 0; k < steps; k++) {
    const t = k * step;
    const next = new Float64Array(N);
    for (let i = 0; i < S; i++) {
      const end = start[i] + len[i] - 1;
      const held = t < heldUntil[i];
      for (let j = start[i]; j <= end; j++) {
        const w = m[j];
        if (j < end) next[j + 1] += w;
        else if (held) next[j] += w;
        else if (i < S - 1) next[start[i + 1]] += w;
        else if (spec.loop) next[0] += w * spec.loop;
        // else: leaves the line
      }
    }
    if (inflow) next[0] += inflow;
    for (let i = 0; i < S; i++) if (keep[i] !== 1) for (let j = start[i]; j < start[i] + len[i]; j++) next[j] *= keep[i];
    m = next;
    frames.push(snapshot((k + 1) * step));
  }
  return { frames, step };
}

/** The histogram as one row of bars, summing to 1. */
export function histOf(frame: GrowFrame): number[] {
  const out = new Array<number>(frame.hist[0]?.length ?? 0).fill(0);
  for (const h of frame.hist) for (let b = 0; b < h.length; b++) out[b] += h[b];
  return out;
}

export function topStage(frame: GrowFrame): number {
  let best = 0;
  frame.shares.forEach((s, i) => { if (s > frame.shares[best]) best = i; });
  return best;
}

/** How far the second-largest share trails the largest, as largest / second (Infinity when there is no second). */
function lead(frame: GrowFrame): number {
  const s = [...frame.shares].sort((a, b) => b - a);
  return s[1] > 1e-9 ? s[0] / s[1] : Infinity;
}

/** Spreads each bar into its neighbours a little, so a sketch one bar out is not judged as a miss. */
export function blur(h: number[]): number[] {
  return h.map((_, i) => 0.25 * (h[i - 1] ?? h[i]) + 0.5 * h[i] + 0.25 * (h[i + 1] ?? h[i]));
}

/** How much two shapes share, from 0 to 1, with both scaled to the same total and blurred a little. */
export function overlap(a: number[], b: number[]): number {
  const sa = sum(a), sb = sum(b);
  if (sa <= 0 || sb <= 0) return 0;
  const x = blur(a.map((v) => v / sa)), y = blur(b.map((v) => v / sb));
  const nx = sum(x), ny = sum(y);
  let o = 0;
  for (let i = 0; i < x.length; i++) o += Math.min(x[i] / nx, y[i] / ny);
  return o;
}

/** The share of 100 individuals in each stage, as whole numbers adding to n (largest remainder), for a sampled view. */
export function quota(shares: number[], n: number): number[] {
  const t = sum(shares);
  if (t <= 0) return shares.map(() => 0);
  const exact = shares.map((s) => (s / t) * n);
  const out = exact.map(Math.floor);
  let left = n - sum(out);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i]++;
  return out;
}

/** The time at which a stage's share first reaches `share`, found by a straight line between steps; null if it never does. */
export function reachTime(sim: GrowSim, stage: number, share: number): number | null {
  const f = sim.frames;
  for (let k = 1; k < f.length; k++) {
    const a = f[k - 1].shares[stage], b = f[k].shares[stage];
    if (a < share && b >= share) return f[k - 1].t + ((share - a) / (b - a)) * sim.step;
    if (k === 1 && a >= share) return 0;
  }
  return null;
}

// ── Checking a spec ──────────────────────────────────────────────────────────

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const multiple = (x: number, step: number) => Math.abs(x / step - Math.round(x / step)) < 1e-6;

export function issues(spec: GrowSpec): string[] {
  const out: string[] = [];
  if (!spec || typeof spec !== 'object') return ['The spec is missing.'];
  if (typeof spec.illustrative !== 'boolean') out.push('"illustrative" must be true or false: say whether the durations and rates are made up for the picture or stated by the course.');
  if (typeof spec.note !== 'string' || !spec.note.trim()) out.push('"note" is missing: say what the picture assumes.');
  else if (spec.note.length > 300) out.push('"note" is longer than 300 characters.');
  else if (spec.illustrative === true && !/illustrative/i.test(spec.note)) out.push('"illustrative" is true, so the "note" must say the numbers are illustrative (use that word).');
  if (spec.illustrative === false && /illustrative/i.test(spec.note ?? '')) out.push('"illustrative" is false but the "note" calls the numbers illustrative.');
  if (typeof spec.unit !== 'string' || !spec.unit.trim()) out.push('"unit" is missing: the unit of time, such as "h".');
  if (!isNum(spec.step) || spec.step <= 0) { out.push('"step" must be a positive number: the width of a time step.'); return out; }
  if (spec.loop !== undefined && (!isNum(spec.loop) || spec.loop <= 1 || spec.loop > 20)) out.push('"loop" must be a number above 1 and up to 20, or absent for a line.');

  const m = spec.measure;
  if (!m || typeof m !== 'object') { out.push('"measure" is missing: the quantity the histogram shows.'); return out; }
  if (typeof m.name !== 'string' || !m.name.trim()) out.push('"measure.name" is missing.');
  if (typeof m.unit !== 'string') out.push('"measure.unit" must be a string (it may be empty).');
  if (!isNum(m.min) || !isNum(m.max) || m.min >= m.max) out.push('"measure" needs a "min" below its "max".');
  if (!Number.isInteger(m.bins) || m.bins < 8 || m.bins > 32) out.push('"measure.bins" must be a whole number from 8 to 32.');
  if (m.cv !== undefined && (!isNum(m.cv) || m.cv < 0 || m.cv > 0.2)) out.push('"measure.cv" must be from 0 to 0.2.');

  const stages = Array.isArray(spec.stages) ? spec.stages : [];
  if (stages.length < 2 || stages.length > MAX_STAGES) out.push(`"stages" needs 2 to ${MAX_STAGES} stages and has ${stages.length}.`);
  const ids = new Set<string>();
  let bins = 0;
  stages.forEach((s, i) => {
    const where = `Stage ${i + 1}`;
    if (typeof s?.id !== 'string' || !ID.test(s.id)) out.push(`${where} needs an "id" in lower case letters, digits and hyphens.`);
    else if (ids.has(s.id)) out.push(`${where}: the id "${s.id}" is used twice.`);
    else ids.add(s.id);
    if (typeof s?.label !== 'string' || !s.label.trim() || s.label.length > 28) out.push(`${where} needs a "label" of at most 28 characters.`);
    if (!isNum(s?.duration) || s.duration <= 0) out.push(`${where} needs a positive "duration".`);
    else if (!multiple(s.duration, spec.step)) out.push(`${where}'s duration ${s.duration} is not a whole number of steps of ${spec.step}.`);
    else bins += Math.round(s.duration / spec.step);
    const v = s?.value;
    const vs = Array.isArray(v) ? v : [v];
    if (!(vs.length === (Array.isArray(v) ? 2 : 1)) || vs.some((x) => !isNum(x))) out.push(`${where}'s "value" must be a number or [from, to].`);
    else if (isNum(m.min) && isNum(m.max)) {
      for (const x of vs as number[]) {
        const room = 3 * (m.cv ?? 0) * Math.abs(x);
        if (x - room < m.min || x + room > m.max) out.push(`${where}'s value ${x} is too near the edge of the axis (${m.min} to ${m.max}) for its spread: widen the axis.`);
      }
    }
    if (s?.note !== undefined && (typeof s.note !== 'string' || s.note.length > 160)) out.push(`${where}'s "note" must be at most 160 characters.`);
  });
  if (bins > MAX_BINS) out.push(`The stages come to ${bins} steps; use a wider "step" (at most ${MAX_BINS}).`);
  if (out.length) return out;

  const trans = Array.isArray(spec.transitions) ? spec.transitions : [];
  if (trans.length !== stages.length) out.push(`"transitions" needs one for each stage (the way out of it): ${stages.length}, and there are ${trans.length}.`);
  const tids = new Set<string>();
  const left = new Set<string>();
  trans.forEach((t, i) => {
    const where = `Transition ${i + 1}`;
    if (typeof t?.id !== 'string' || !ID.test(t.id)) out.push(`${where} needs an "id".`);
    else if (tids.has(t.id)) out.push(`${where}: the id "${t.id}" is used twice.`);
    else tids.add(t.id);
    if (!ids.has(t?.from)) out.push(`${where} leaves "${t?.from}", which is not a stage.`);
    else if (left.has(t.from)) out.push(`${where}: stage "${t.from}" already has a way out.`);
    else left.add(t.from);
    if (t?.label !== undefined && (typeof t.label !== 'string' || !t.label.trim() || t.label.length > 36)) out.push(`${where}'s "label" must be at most 36 characters.`);
  });

  const treatments = Array.isArray(spec.treatments) ? spec.treatments : [];
  if (treatments.length < 2 || treatments.length > 6) out.push(`"treatments" needs 2 to 6 and has ${treatments.length}.`);
  const trIds = new Set<string>();
  treatments.forEach((tr, i) => {
    const where = `Treatment ${i + 1}`;
    if (typeof tr?.id !== 'string' || !ID.test(tr.id)) out.push(`${where} needs an "id".`);
    else if (trIds.has(tr.id)) out.push(`${where}: the id "${tr.id}" is used twice.`);
    else trIds.add(tr.id);
    if (typeof tr?.label !== 'string' || !tr.label.trim() || tr.label.length > 72) out.push(`${where} needs a "label" of at most 72 characters.`);
    if (typeof tr?.because !== 'string' || tr.because.trim().length < 12 || tr.because.length > 230) out.push(`${where} needs a "because" of one plain sentence, at most 230 characters.`);
    const fx = Array.isArray(tr?.effects) ? tr.effects : [];
    if (fx.length > 3) out.push(`${where} has ${fx.length} effects; at most 3.`);
    if (fx.length === 0 && !tr?.control) out.push(`${where} does nothing: give it an effect, or mark it "control": true.`);
    const times = Array.isArray(tr?.times) ? tr.times : [];
    if (!times.length || times.length > 4) out.push(`${where} needs 1 to 4 "times".`);
    for (const t of times) {
      if (!isNum(t) || t <= 0 || !multiple(t, spec.step)) out.push(`${where}: the time ${t} must be a positive whole number of steps of ${spec.step}.`);
      else if (Math.round(t / spec.step) > MAX_FRAMES) out.push(`${where}: the time ${t} is more than ${MAX_FRAMES} steps.`);
    }
    const stagesHit = new Set<string>();
    for (const e of fx) {
      const kind = (e as { kind?: string })?.kind;
      if (kind === 'block' || kind === 'remove-block') {
        const t = (e as { transition: string }).transition;
        if (!transitionOf(spec, t)) out.push(`${where}: "${t}" is not a transition.`);
        if (kind === 'remove-block') {
          const at = (e as { at: number }).at;
          if (!isNum(at) || at <= 0 || !multiple(at, spec.step)) out.push(`${where}: a remove-block needs a positive "at", a whole number of steps.`);
          else if (times.some((x) => isNum(x) && x <= at)) out.push(`${where}: every run must last longer than the block does (${at} ${spec.unit}).`);
          if (!fx.some((x) => x.kind === 'block' && x.transition === t)) out.push(`${where}: a remove-block on "${t}" needs a block on it in the same treatment.`);
        }
      } else if (kind === 'slow') {
        const { stage, factor } = e as { stage: string; factor: number };
        if (!ids.has(stage)) out.push(`${where}: "${stage}" is not a stage.`);
        if (!Number.isInteger(factor) || factor < 2 || factor > 4) out.push(`${where}: "slow" needs a whole "factor" from 2 to 4.`);
        if (stagesHit.has(`s:${stage}`)) out.push(`${where}: stage "${stage}" is slowed twice.`);
        stagesHit.add(`s:${stage}`);
      } else if (kind === 'kill') {
        const { stage, rate } = e as { stage: string; rate: number };
        if (!ids.has(stage)) out.push(`${where}: "${stage}" is not a stage.`);
        if (!isNum(rate) || rate <= 0 || rate > 2) out.push(`${where}: "kill" needs a "rate" above 0 and up to 2 (per ${spec.unit}).`);
        if (stagesHit.has(`k:${stage}`)) out.push(`${where}: stage "${stage}" is killed twice.`);
        stagesHit.add(`k:${stage}`);
      } else out.push(`${where}: "${String(kind)}" is not an effect. Use block, slow, kill or remove-block.`);
    }
  });
  if (out.length) return out;
  if (JSON.stringify(spec).length > MAX_SPEC_JSON) out.push(`The spec is ${JSON.stringify(spec).length} characters; the catalogue allows ${MAX_SPEC_JSON}. Shorten the notes.`);
  if (bins * Math.max(...treatments.flatMap((t) => t.times)) / spec.step > 3e6) out.push('The run would be too large to work out: use a wider "step".');
  if (out.length) return out;

  // Fair to ask? Every run is worked out and judged.
  for (const tr of treatments) {
    for (const length of tr.times) {
      const label = `"${tr.label}" for ${length} ${spec.unit}`;
      const sim = simulate(spec, tr.effects, length);
      const base = simulate(spec, [], length);
      const last = sim.frames[sim.frames.length - 1];
      const baseLast = base.frames[base.frames.length - 1];
      if (last.total < 0.02) { out.push(`${label} leaves almost nothing alive: shorten it or lower the rate.`); continue; }
      const top = topStage(last);
      if (lead(last) < LEAD) out.push(`${label}: no stage clearly holds the most (${stages[top].label} ${pct(last.shares[top])}, and the next is too close). Pick another time or treatment.`);
      if (!tr.control && overlap(histOf(last), histOf(baseLast)) > SAME) out.push(`${label} leaves the histogram almost as it is without treatment: pick a longer time or a stronger effect, or mark it "control".`);
      if (!fractionAsk(spec, sim, base) && !timeAsk(spec, sim)) out.push(`${label}: every stage is either empty or full, or just as it was, and no share rises through a clear level, so there is no fair number to ask for. Pick another time.`);
    }
  }
  return out;
}

/** The stage to ask a share of: the one moved most from untreated, if its share is not near 0 or 1. */
function fractionAsk(spec: GrowSpec, sim: GrowSim, base: GrowSim): { stage: number } | null {
  const last = sim.frames[sim.frames.length - 1];
  const baseLast = base.frames[base.frames.length - 1];
  const order = spec.stages.map((_, i) => i).sort((a, b) => Math.abs(last.shares[b] - baseLast.shares[b]) - Math.abs(last.shares[a] - baseLast.shares[a]) || a - b);
  for (const i of order) {
    const s = last.shares[i];
    if (s >= 0.06 && s <= 0.94 && Math.abs(s - baseLast.shares[i]) >= 0.05) return { stage: i };
  }
  for (const i of order) if (last.shares[i] >= 0.06 && last.shares[i] <= 0.94) return { stage: i };
  return null;
}

/** A time ask: a stage whose share rises through a level that the run crosses cleanly. */
function timeAsk(spec: GrowSpec, sim: GrowSim): { stage: number; share: number; time: number } | null {
  const f = sim.frames;
  const n = f.length - 1;
  let best: { stage: number; share: number; time: number; gain: number } | null = null;
  spec.stages.forEach((_, i) => {
    const s0 = f[0].shares[i], s1 = f[n].shares[i];
    if (s1 - s0 < 0.2) return;
    const level = Math.round((s0 + (s1 - s0) * 0.55) / 0.05) * 0.05;
    if (level - s0 < 0.1 || s1 - level < 0.08) return;
    const time = reachTime(sim, i, level);
    if (time === null || time < 2 * sim.step || time > sim.step * (n - 2)) return;
    const kc = Math.ceil(time / sim.step);
    for (let k = kc; k <= n; k++) if (f[k].shares[i] < level - 0.02) return;
    if (!best || s1 - s0 > best.gain) best = { stage: i, share: level, time, gain: s1 - s0 };
  });
  return best;
}

// ── Preparing a round ────────────────────────────────────────────────────────

/** A seeded shuffle that is the same on every round of a run, so the rounds go through the treatments in turn. */
function order(seed: string, n: number): number[] {
  const run = seed.replace(/:\d+$/, '');
  const r = rng(`order:${run}`);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx;
}

export function prepare(spec: GrowSpec, seed: string, rung: number): GrowTask {
  const round = roundOf(seed);
  const r = rng(seed);
  const pickOrder = order(seed, spec.treatments.length);
  const treatment = spec.treatments[pickOrder[round % pickOrder.length]];
  const times = treatment.times;
  const length = times[(hashSeed(seed.replace(/:\d+$/, '')) + round) % times.length];
  const sim = simulate(spec, treatment.effects, length);
  const base = simulate(spec, [], length);
  const last = sim.frames[sim.frames.length - 1];
  const top = topStage(last);
  const noun = individualsOf(spec);
  let ask: GrowAsk = { kind: 'stage' };
  let answer: number | null = null;
  let tolerance = 0;
  let question = `Which stage holds the most ${noun} after ${length} ${spec.unit}?`;
  if (rung === 1) {
    ask = { kind: 'shape' };
    question = `Sketch how ${spec.measure.name} is spread across all the ${noun} after ${length} ${spec.unit}.`;
  } else if (rung >= 2) {
    const fa = fractionAsk(spec, sim, base);
    const ta = timeAsk(spec, sim);
    const t = ta && (!fa || r() < 0.5) ? ta : null;
    if (t) {
      ask = { kind: 'time', stage: t.stage, share: t.share };
      answer = t.time;
      tolerance = Math.max(2 * spec.step, 0.15 * t.time);
      question = `How long until ${pct(t.share)} of the ${noun} are in ${q(spec.stages[t.stage].label)}? Give the time in ${spec.unit}.`;
    } else {
      const f = fa ?? { stage: top };
      ask = { kind: 'fraction', stage: f.stage };
      answer = last.shares[f.stage] * 100;
      tolerance = Math.max(5, 0.1 * answer);
      question = `What share of the ${noun} are in ${q(spec.stages[f.stage].label)} after ${length} ${spec.unit}? Give a percentage.`;
    }
  }
  return {
    spec, seed, rung, treatment, length, ask, sim, base, top, answer, tolerance, question,
    instruction: `${treatment.label}, then run it for ${length} ${spec.unit}.`,
  };
}

// ── The verdict ──────────────────────────────────────────────────────────────

/** True when the attempt is complete enough to commit to. */
export function committed(task: GrowTask, attempt: GrowAttempt): boolean {
  if (task.ask.kind === 'stage') return typeof attempt.stage === 'string';
  if (task.ask.kind === 'shape') return Array.isArray(attempt.sketch) && sum(attempt.sketch) > 0.15;
  return typeof attempt.value === 'number' && Number.isFinite(attempt.value);
}

/** Reads a typed answer: "12", "12 h", "45%", "45 %" all work; anything else is null. */
export function readNumber(text: string, unit: string): number | null {
  const t = text.trim().replace(/,/g, '.').replace(/\s+/g, ' ');
  const m = /^(-?\d*\.?\d+(?:e-?\d+)?)\s*(%|[a-zµ]*)$/i.exec(t);
  if (!m) return null;
  const word = m[2].toLowerCase();
  if (word && word !== '%' && word !== unit.toLowerCase() && word !== `${unit.toLowerCase()}s` && word !== 'percent') return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

export function result(task: GrowTask, attempt: GrowAttempt): RoundResult {
  const { spec, treatment, length } = task;
  const noun = individualsOf(spec);
  const last = task.sim.frames[task.sim.frames.length - 1];
  const first = task.sim.frames[0];
  const baseLast = task.base.frames[task.base.frames.length - 1];
  const top = spec.stages[task.top];
  const because = treatment.because.trim();
  const end = /[.!?]$/.test(because) ? because : `${because}.`;

  if (task.ask.kind === 'stage') {
    const met = attempt.stage === top.id;
    const picked = spec.stages.find((s) => s.id === attempt.stage);
    let misconception: string | undefined;
    if (!met && picked) {
      const blocked = treatment.effects.filter((e) => e.kind === 'block').map((e) => transitionOf(spec, (e as { transition: string }).transition)).filter(Boolean) as GrowTransition[];
      const after = blocked.map((t) => spec.stages[(stageIndex(spec, t.from) + 1) % spec.stages.length].id);
      const killed = treatment.effects.some((e) => e.kind === 'kill' && e.stage === picked.id);
      if (after.includes(picked.id)) misconception = 'Puts the pile-up after the blocked step instead of before it';
      else if (killed) misconception = 'Expects a stage that is being killed to fill up';
      else if (picked.id === spec.stages[topStage(first)].id) misconception = 'Expects the treatment to leave the population as it was';
    }
    return {
      met,
      label: `Names the stage that holds the most ${noun} after ${length} ${spec.unit} (${q(top.label)}, ${pct(last.shares[task.top])})`,
      why: `${end} After ${length} ${spec.unit}, ${q(top.label)} holds ${pct(last.shares[task.top])} of the ${noun}, against ${pct(first.shares[task.top])} before.`,
      ...(misconception ? { misconception } : {}),
    };
  }

  if (task.ask.kind === 'shape') {
    const truth = histOf(last);
    const sketch = attempt.sketch ?? [];
    const o = overlap(sketch, truth);
    const met = o >= SKETCH_PASS;
    let tallest = 0;
    truth.forEach((v, b) => { if (v > truth[tallest]) tallest = b; });
    const centre = withUnit(centreOf(spec.measure, tallest), spec.measure.unit);
    let misconception: string | undefined;
    if (!met && sum(sketch) > 0) {
      const ob = overlap(sketch, histOf(baseLast));
      if (ob > o + 0.05 && ob >= SKETCH_PASS) misconception = 'Sketches the population as it would look without the treatment';
    }
    return {
      met,
      label: `Sketches how ${spec.measure.name} is spread across all the ${noun} after ${length} ${spec.unit} (tallest bars near ${centre})`,
      why: `${end} After ${length} ${spec.unit} the tallest bars sit near ${centre}, and ${q(top.label)} holds ${pct(last.shares[task.top])} of the ${noun}.`,
      ...(misconception ? { misconception } : {}),
    };
  }

  const value = attempt.value ?? NaN;
  const answer = task.answer ?? 0;
  const met = Number.isFinite(value) && Math.abs(value - answer) <= task.tolerance;
  if (task.ask.kind === 'fraction') {
    const stage = spec.stages[task.ask.stage];
    const was = first.shares[task.ask.stage] * 100;
    return {
      met,
      label: `Gives the share of ${noun} in ${q(stage.label)} after ${length} ${spec.unit} (${Math.round(answer)}%, within ${Math.round(task.tolerance)} points)`,
      why: `${end} After ${length} ${spec.unit}, ${q(stage.label)} holds ${Math.round(answer)}% of the ${noun}; it held ${Math.round(was)}% before.`,
      ...(!met && Number.isFinite(value) && Math.abs(value - was) <= task.tolerance ? { misconception: 'Expects the share to stay where it was before the treatment' } : {}),
    };
  }
  const stage = spec.stages[task.ask.stage];
  return {
    met,
    label: `Gives the time for ${pct(task.ask.share)} of the ${noun} to be in ${q(stage.label)} (${fmt(answer)} ${spec.unit}, within ${fmt(task.tolerance)})`,
    why: `${end} ${q(stage.label)} reaches ${pct(task.ask.share)} of the ${noun} after about ${fmt(answer)} ${spec.unit}.`,
  };
}
