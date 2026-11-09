/**
 * Dial, the logic: no DOM, no subject. A spec names a formula, two axes and some parameters; this file checks the spec,
 * sets a question from it and judges the answer. Every number a student is told comes from evaluating the formula, never
 * from the spec, so a slip in a spec makes a wrong setup (caught by `issues`) and not a wrong answer.
 *
 * Rungs: 0 says which way the marked point moves (up, down or the same), 1 drags a ghost point to where it will land, and
 * 2 types the value with its unit.
 */
import { clip } from '../../report';
import { RUNGS, hashSeed, rng, roundOf, type RoundResult } from '../../engine';
import { ExprError, RESERVED, compile, symbolsOf } from '../../expr';
import { cap, clamp, fmt, fromUnit, ticks, toUnit, withUnit, type ScaleKind } from '../../scale';
import { readAnswer, unitInfo } from '../../units';

// ── The spec ─────────────────────────────────────────────────────────────────

export interface DialAxisSpec { symbol: string; name: string; unit: string; min: number; max: number; scale: ScaleKind; marks?: number[] }
export interface DialYSpec { symbol?: string; name: string; unit: string; min: number; max: number; scale?: ScaleKind }
export interface DialParam {
  symbol: string; name: string; unit: string; min: number; max: number; scale: ScaleKind; start: number[];
  /** True for a count, such as electrons: only whole numbers are asked. */
  whole?: boolean;
}
/** A number worked out from the curve: the x at which y reaches a level that may depend on the parameters. */
export interface DialQuantity { id: string; name: string; crossing: string }
/** What is asked on one rung. `measure` is "y" (the value at a marked x) or a quantity's id. */
export interface DialAsk { measure?: string; question?: string; tolerance?: number }
export interface DialSpec {
  expression: string;
  x: DialAxisSpec;
  y: DialYSpec;
  parameters: DialParam[];
  quantities?: DialQuantity[];
  asks: DialAsk[];
  why: string;
  /** The formula as the course writes it, shown under the plot. Defaults to the expression. */
  formula?: string;
  note?: string;
}

export type Direction = 'up' | 'down' | 'same';
export type DialAttempt =
  | { kind: 'pick'; pick: Direction }
  | { kind: 'place'; value: number }
  | { kind: 'type'; value: number; text: string };

// ── Defaults ─────────────────────────────────────────────────────────────────

/** A move smaller than this much of the axis counts as "the same"... */
export const SAME_BELOW = 0.025;
/** ...and only if the quantity itself barely changes. A real change low on a wide axis is never called the same: it is not asked. */
export const SAME_RELATIVE = 0.05;
/** Rung 0 never asks about a move between SAME_BELOW and this: it is too close to call by eye. */
export const CLEAR_ABOVE = 0.06;
const MIN_MOVE = [CLEAR_ABOVE, 0.12, 0.08];
export const DEFAULT_PLACE_TOLERANCE = 0.08;
export const DEFAULT_VALUE_TOLERANCE = 0.05;
const BUILTIN_WORDS = ['at', 'y0', 'y1', 'from', 'to'];
const IDENT = /^[A-Za-z_Ͱ-Ͽἀ-῿][A-Za-z0-9_Ͱ-Ͽἀ-῿]*$/;

/** How far a value moved as a share of the larger of the two. */
export const relativeChange = (from: number, to: number) => {
  const biggest = Math.max(Math.abs(from), Math.abs(to));
  return biggest === 0 ? 0 : Math.abs(to - from) / biggest;
};

export const yAxis = (spec: DialSpec) => ({ min: spec.y.min, max: spec.y.max, scale: spec.y.scale ?? 'linear' as ScaleKind });

// ── The compiled model ───────────────────────────────────────────────────────

export interface Model {
  spec: DialSpec;
  /** The parameter symbols, in the order values are passed. */
  names: string[];
  y(x: number, p: readonly number[]): number;
  /** The level a quantity looks for, which may depend on the parameters. */
  level(id: string, p: readonly number[]): number;
  /** The x at which y first reaches the quantity's level, or NaN when it never does within the axis. */
  cross(id: string, p: readonly number[]): number;
}

export function buildModel(spec: DialSpec): Model {
  const names = spec.parameters.map((p) => p.symbol);
  const f = compile(spec.expression, [spec.x.symbol, ...names]);
  const scratch = new Array<number>(names.length + 1);
  const y = (x: number, p: readonly number[]) => {
    scratch[0] = x;
    for (let i = 0; i < names.length; i++) scratch[i + 1] = p[i];
    return f(scratch);
  };
  const levels = new Map<string, (v: readonly number[]) => number>();
  for (const q of spec.quantities ?? []) levels.set(q.id, compile(q.crossing, names));
  const level = (id: string, p: readonly number[]) => (levels.get(id) as (v: readonly number[]) => number)(p);
  const STEPS = 240;
  const cross = (id: string, p: readonly number[]) => {
    const target = level(id, p);
    const g = (u: number) => y(fromUnit(spec.x, u), p) - target;
    let prevU = 0; let prev = g(0);
    if (prev === 0) return spec.x.min;
    for (let i = 1; i <= STEPS; i++) {
      const u = i / STEPS; const cur = g(u);
      if (!Number.isFinite(cur)) return NaN;
      if (cur === 0) return fromUnit(spec.x, u);
      if ((prev < 0) !== (cur < 0)) {
        let lo = prevU; let hi = u; let gl = prev;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2; const gm = g(mid);
          if ((gm < 0) === (gl < 0)) { lo = mid; gl = gm; } else hi = mid;
        }
        return fromUnit(spec.x, (lo + hi) / 2);
      }
      prevU = u; prev = cur;
    }
    return NaN;
  };
  return { spec, names, y, level, cross };
}

// ── Checking a spec ──────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Names usable inside `{braces}` in the `why` line, for this spec. */
export function whyNames(spec: DialSpec): string[] {
  const names = [...BUILTIN_WORDS];
  for (const p of spec.parameters ?? []) names.push(p.symbol, `${p.symbol}0`);
  for (const q of spec.quantities ?? []) names.push(q.id, `${q.id}0`);
  return names;
}

/** Combinations of parameter values that cover the corners, the middle and every starting value. */
function paramGrid(spec: DialSpec, limit = 1200): number[][] {
  const options = spec.parameters.map((p) => {
    const mid = fromUnit(p, 0.5);
    return [...new Set([p.min, mid, p.max, ...p.start])];
  });
  let total = 1;
  for (const o of options) total *= o.length;
  if (total <= limit) {
    let rows: number[][] = [[]];
    for (const o of options) rows = rows.flatMap((r) => o.map((v) => [...r, v]));
    return rows;
  }
  const rand = rng('grid');
  const rows: number[][] = [spec.parameters.map((p) => p.min), spec.parameters.map((p) => p.max)];
  while (rows.length < limit) rows.push(options.map((o) => o[Math.floor(rand() * o.length)]));
  return rows;
}

export function issues(input: DialSpec): string[] {
  const out: string[] = [];
  const spec = input as unknown;
  if (!isObj(spec)) return ['The spec must be an object.'];
  const add = (msg: string) => { if (out.length < 14 && !out.includes(msg)) out.push(msg); };

  if (!isText(spec.expression, 400)) add('`expression` must be the formula as text, for example "L / (Kd + L)".');
  if (!isText(spec.why, 400)) add('`why` must be one sentence shown after the reveal.');
  if (spec.note !== undefined && !isText(spec.note, 240)) add('`note`, when given, must be a short line of text.');
  if (spec.formula !== undefined && !isText(spec.formula, 200)) add('`formula`, when given, must be a short line of text.');

  const axisIssues = (label: string, a: unknown, needSymbol: boolean) => {
    if (!isObj(a)) { add(`\`${label}\` must be an object.`); return; }
    if (needSymbol && (typeof a.symbol !== 'string' || !IDENT.test(a.symbol) || RESERVED.has(a.symbol))) add(`\`${label}.symbol\` must be a plain name such as "L" (letters, digits, underscores; not a function name).`);
    if (a.symbol !== undefined && !needSymbol && (typeof a.symbol !== 'string' || !a.symbol.trim())) add(`\`${label}.symbol\`, when given, must be text.`);
    if (!isText(a.name, 80)) add(`\`${label}.name\` must be a few plain words, for example "launch speed".`);
    if (typeof a.unit !== 'string' || a.unit.length > 40) add(`\`${label}.unit\` must be text (use "" for none).`);
    else if (!unitInfo(a.unit)) add(`\`${label}.unit\` "${a.unit}" cannot be read as a unit.`);
    if (!isNum(a.min) || !isNum(a.max) || !(a.min < a.max)) add(`\`${label}\` needs a \`min\` below its \`max\`.`);
    if (a.scale !== undefined && a.scale !== 'linear' && a.scale !== 'log') add(`\`${label}.scale\` must be "linear" or "log".`);
    if (a.scale === 'log' && isNum(a.min) && a.min <= 0) add(`\`${label}\` is on a log scale, so its \`min\` must be above 0.`);
  };
  axisIssues('x', spec.x, true);
  axisIssues('y', spec.y, false);
  if (isObj(spec.x) && spec.x.scale !== 'linear' && spec.x.scale !== 'log') add('`x.scale` must be "linear" or "log".');
  if (isObj(spec.x) && spec.x.marks !== undefined && (!Array.isArray(spec.x.marks) || spec.x.marks.some((m) => !isNum(m) || m < (spec.x as { min: number }).min || m > (spec.x as { max: number }).max))) add('`x.marks` must be numbers inside the x axis.');

  const symbols = new Set<string>();
  if (isObj(spec.x) && typeof spec.x.symbol === 'string') symbols.add(spec.x.symbol);
  if (!Array.isArray(spec.parameters) || spec.parameters.length < 1 || spec.parameters.length > 6) add('`parameters` must list one to six parameters.');
  else {
    for (const [i, p] of spec.parameters.entries()) {
      const at = `parameters[${i}]`;
      if (!isObj(p)) { add(`\`${at}\` must be an object.`); continue; }
      axisIssues(at, p, true);
      if (p.scale !== 'linear' && p.scale !== 'log') add(`\`${at}.scale\` must be "linear" or "log".`);
      if (typeof p.symbol === 'string') {
        if (symbols.has(p.symbol)) add(`The symbol "${p.symbol}" is used twice.`);
        symbols.add(p.symbol);
      }
      if (!Array.isArray(p.start) || p.start.length < 1 || p.start.length > 12) add(`\`${at}.start\` must list one to twelve starting values.`);
      else for (const s of p.start) {
        if (!isNum(s) || !isNum(p.min) || !isNum(p.max) || s < p.min || s > p.max) { add(`\`${at}.start\` has ${String(s)}, which is outside ${String(p.min)} to ${String(p.max)}.`); break; }
      }
    }
  }
  const quantities = Array.isArray(spec.quantities) ? spec.quantities : spec.quantities === undefined ? [] : null;
  if (quantities === null) add('`quantities`, when given, must be a list.');
  const qids = new Set<string>();
  for (const [i, q] of (quantities ?? []).entries()) {
    if (!isObj(q) || typeof q.id !== 'string' || !IDENT.test(q.id) || !isText(q.name, 80) || !isText(q.crossing, 400)) { add(`\`quantities[${i}]\` needs an \`id\`, a \`name\` and a \`crossing\` formula.`); continue; }
    if (symbols.has(q.id) || BUILTIN_WORDS.includes(q.id) || qids.has(q.id) || RESERVED.has(q.id)) add(`The quantity id "${q.id}" is already taken.`);
    qids.add(q.id);
  }
  if (!Array.isArray(spec.asks) || spec.asks.length < 1 || spec.asks.length > RUNGS) add(`\`asks\` must list what is asked at each rung: one to ${RUNGS} entries.`);
  else for (const [i, a] of spec.asks.entries()) {
    if (!isObj(a)) { add(`\`asks[${i}]\` must be an object.`); continue; }
    if (a.measure !== undefined && a.measure !== 'y' && !(typeof a.measure === 'string' && qids.has(a.measure))) add(`\`asks[${i}].measure\` must be "y" or the id of a quantity.`);
    if (a.question !== undefined && !isText(a.question, 240)) add(`\`asks[${i}].question\` must be a short question.`);
    if (a.tolerance !== undefined && (!isNum(a.tolerance) || a.tolerance <= 0 || a.tolerance > 0.5)) add(`\`asks[${i}].tolerance\` must be above 0 and at most 0.5.`);
  }
  if (out.length) return out;

  // The structure is sound; now the formula, which needs the names.
  const s = spec as unknown as DialSpec;
  let model: Model;
  try {
    for (const name of symbolsOf(s.expression)) {
      if (!symbols.has(name)) add(`The formula uses "${name}", which is neither the x symbol "${s.x.symbol}" nor a parameter symbol.`);
    }
    if (out.length) return out;
    model = buildModel(s);
  } catch (e) {
    return [e instanceof ExprError ? `Formula: ${e.message} (at character ${e.position + 1}).` : `Formula: ${String(e)}`];
  }
  for (const q of s.quantities ?? []) {
    try { compile(q.crossing, model.names); } catch (e) { add(`Quantity "${q.id}": ${e instanceof ExprError ? `${e.message} (at character ${e.position + 1})` : String(e)}.`); }
  }
  const shown = (p: readonly number[]) => s.parameters.map((q, i) => `${q.symbol} = ${withUnit(p[i], q.unit)}`).join(', ');
  for (const m of s.why.matchAll(/\{([^{}]*)\}/g)) {
    if (!whyNames(s).includes(m[1])) add(`\`why\` uses {${m[1]}}, which is not a parameter symbol, a quantity id or one of ${BUILTIN_WORDS.join(', ')}.`);
  }
  // Every filled-in value already carries its unit, so a unit typed after one is printed twice.
  const units = new Set([...s.parameters.map((p) => p.unit), s.x.unit, s.y.unit].filter((u): u is string => !!u));
  for (const m of s.why.matchAll(/\{([^{}]*)\}\s*([^\s.,;:)]+)/g)) {
    if (units.has(m[2])) add(`\`why\` has "{${m[1]}} ${m[2]}", but {${m[1]}} already carries its unit, so the student would read it twice. Remove "${m[2]}".`);
  }
  if (s.asks.some((a) => a.measure && a.measure !== 'y')) {
    for (const m of s.why.matchAll(/\{(at|y0|y1)\}/g)) add('`why` uses {' + m[1] + '}, but a rung asks about a quantity, which has no marked point. Leave it out of the sentence.');
  }
  for (const [i, a] of s.asks.entries()) {
    for (const m of (a.question ?? '').matchAll(/\{([^{}]*)\}/g)) if (!['at', 'x', 'y', 'measure'].includes(m[1])) add(`\`asks[${i}].question\` uses {${m[1]}}; only {at}, {x}, {y} and {measure} are filled.`);
  }
  if (out.length) return out;

  // The formula over the whole range.
  const grid = paramGrid(s);
  const xs: number[] = [];
  for (let i = 0; i <= 60; i++) xs.push(fromUnit(s.x, i / 60));
  xs.push(...(s.x.marks ?? []));
  const eps = (s.y.max - s.y.min) * 1e-9;
  const moved = new Array<boolean>(s.parameters.length).fill(false);
  let bad = 0;
  for (const p of grid) {
    for (const x of xs) {
      const v = model.y(x, p);
      const where = `at ${s.x.symbol} = ${withUnit(x, s.x.unit)} with ${shown(p)}`;
      if (!Number.isFinite(v)) { add(`The formula is not a finite number ${where}. Check for dividing by zero or the root of a negative.`); bad++; break; }
      if (v < s.y.min - eps) { add(`The curve leaves the y axis ${where}: it is ${fmt(v)}, below the axis minimum ${s.y.min}. Widen the axis or narrow the parameter ranges.`); bad++; break; }
      if (v > s.y.max + eps) { add(`The curve leaves the y axis ${where}: it is ${fmt(v)}, above the axis maximum ${s.y.max}. Widen the axis or narrow the parameter ranges.`); bad++; break; }
      if ((s.y.scale ?? 'linear') === 'log' && v <= 0) { add(`The y axis is logarithmic but the curve is ${fmt(v)} ${where}.`); bad++; break; }
    }
    if (bad > 3) break;
  }
  if (bad === 0) {
    // Every parameter must move the curve somewhere, or its slider does nothing.
    for (let k = 0; k < s.parameters.length; k++) {
      const base = s.parameters.map((q) => fromUnit(q, 0.5));
      const alt = base.slice(); alt[k] = fromUnit(s.parameters[k], 0.9);
      const alt2 = base.slice(); alt2[k] = fromUnit(s.parameters[k], 0.1);
      for (const x of xs) if (Math.abs(model.y(x, alt) - model.y(x, base)) > eps * 1e3 || Math.abs(model.y(x, alt2) - model.y(x, base)) > eps * 1e3) { moved[k] = true; break; }
      if (!moved[k]) add(`Changing "${s.parameters[k].symbol}" never moves the curve, so its slider would do nothing. Take it out, or use it in the formula.`);
    }
    for (const q of s.quantities ?? []) {
      for (const p of grid) {
        const x = model.cross(q.id, p);
        if (!Number.isFinite(x)) { add(`The curve never reaches ${q.name}'s level (${q.crossing}) within the x axis, with ${shown(p)}. Widen the x axis or narrow the parameter ranges.`); break; }
      }
    }
  }
  if (out.length) return out;

  // Every rung must be able to set a question.
  for (let rung = 0; rung < RUNGS; rung++) {
    for (const seed of ['check:0', 'check:1', 'check:2', 'a:0', 'b:1', 'c:2', 'd:0', 'e:1', 'f:2', 'g:0', 'h:1', 'i:2']) {
      try {
        const task = prepare(s, seed, rung);
        if (!Number.isFinite(task.from) || !Number.isFinite(task.to)) add(`Rung ${rung} set a question with no answer.`);
      } catch (e) {
        add(`Rung ${rung} cannot set a question from this spec: ${(e as Error).message}`);
        break;
      }
    }
  }
  return out;
}

// ── Setting a question ───────────────────────────────────────────────────────

export interface Spot { x: number; y: number }

export interface DialTask {
  spec: DialSpec;
  rung: number;
  seed: string;
  ask: DialAsk;
  /** "y" for the value at a marked x, or a quantity id for the x where a level is reached. */
  measure: string;
  /** Parameter values before and after the change, in the spec's order. */
  before: number[];
  after: number[];
  /** Index into `parameters` of the one that changes. */
  changed: number;
  /** The marked x, for the "y" measure; null for a quantity. */
  at: number | null;
  /** The measure before and after: the answer is `to`. */
  from: number;
  to: number;
  direction: Direction;
  /** Where the point sits on the plot before and after the change. */
  track: { before: Spot; after: Spot };
  /** What counts as close enough: a share of the axis (rung 1) or a share of the value (rung 2). */
  tolerance: number;
  /** The unit of the measure. */
  unit: string;
  announce: string;
  question: string;
  why: string;
  /** The compiled formula; not part of the task's data. */
  readonly model: Model;
}

const LOG_FACTORS = [0.1, 0.2, 0.25, 0.5, 2, 4, 5, 10];
const LIN_FACTORS = [0.5, 0.75, 1.5, 2];

/**
 * Values a parameter could change to: simple multiples of where it is, its own starting values and ends, and on a linear
 * range its quarter points. Never a change so big that it is a different thing, nor so small that it is not noticed.
 */
function newValues(p: DialParam, from: number): number[] {
  const found = new Set<number>();
  for (const f of p.scale === 'log' ? LOG_FACTORS : LIN_FACTORS) found.add(Number((from * f).toPrecision(6)));
  for (const v of [...p.start, p.min, p.max]) found.add(v);
  if (p.scale === 'linear') for (const q of [0.25, 0.5, 0.75]) found.add(Number(fromUnit(p, q).toPrecision(3)));
  const [lo, hi] = p.scale === 'log' ? [0.1, 10] : [0.4, 2.5];
  return [...found].filter((v) => (!p.whole || Number.isInteger(v)) && v >= p.min * (1 - 1e-9) && v <= p.max * (1 + 1e-9) && v !== from && v / from >= lo - 1e-9 && v / from <= hi + 1e-9).sort((a, b) => a - b);
}

const askFor = (spec: DialSpec, rung: number): DialAsk => spec.asks[Math.min(rung, spec.asks.length - 1)] ?? {};

/** x values that are good to point at: 1, 2 and 5 times a power of ten on a log axis, round steps on a linear one. */
export function markedXs(spec: DialSpec): number[] {
  if (spec.x.marks?.length) return [...spec.x.marks];
  const found: number[] = [];
  if (spec.x.scale === 'log') {
    for (const t of ticks(spec.x)) if ([1, 2, 5].includes(Math.round(t.value / Math.pow(10, Math.floor(Math.log10(t.value) + 1e-9))))) found.push(t.value);
  } else {
    for (const t of ticks(spec.x, 10)) found.push(t.value);
  }
  return found.length >= 3 ? found : Array.from({ length: 9 }, (_, i) => fromUnit(spec.x, (i + 1) / 10));
}

const verb = (up: boolean) => (up ? 'rises' : 'falls');

/** "doubles", "halves", "rises 10-fold", "falls 5-fold", "rises by 50%". */
export function sizeWords(from: number, to: number): string {
  // A ratio means nothing across zero or below it: -20 to -10 is a rise, though its ratio says it halved.
  if (from <= 0 || to <= 0) return to > from ? 'rises' : 'falls';
  const factor = to / from;
  if (Math.abs(factor - 2) < 1e-9) return 'doubles';
  if (Math.abs(factor - 0.5) < 1e-9) return 'halves';
  const big = (n: number) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : fmt(n, 2));
  if (factor > 1) return factor >= 2 ? `rises ${big(factor)}-fold` : `rises by ${Math.round((factor - 1) * 100)}%`;
  const inv = 1 / factor;
  return inv >= 2 ? `falls ${big(inv)}-fold` : `falls by ${Math.round((1 - factor) * 100)}%`;
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^{}]*)\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all));
}

export function prepare(spec: DialSpec, seed: string, rung: number): DialTask {
  const r = clamp(Math.round(rung), 0, RUNGS - 1);
  const rand = rng(seed);
  const model = buildModel(spec);
  const ask = askFor(spec, r);
  const measure = ask.measure && ask.measure !== 'y' ? ask.measure : 'y';
  const quantity = measure === 'y' ? null : (spec.quantities ?? []).find((q) => q.id === measure) ?? null;
  const axis = quantity ? spec.x : yAxis(spec);
  const norm = (v: number) => toUnit(axis, v);
  const before = spec.parameters.map((p) => p.start[Math.floor(rand() * p.start.length)]);

  // The parameter to change turns with the round, so a run does not keep asking about the same one.
  const n = spec.parameters.length;
  const lead = (hashSeed(seed.replace(/:\d+$/, '')) + roundOf(seed)) % n;
  const order = Array.from({ length: n }, (_, i) => (lead + i) % n);

  const xs = quantity ? [null] : markedXs(spec).filter((x) => r === 0 || (toUnit(spec.x, x) >= 0.04 && toUnit(spec.x, x) <= 0.96));
  interface Cand { param: number; value: number; at: number | null; from: number; to: number; delta: number; dir: Direction }
  const measureAt = (p: readonly number[], at: number | null) => (quantity ? model.cross(quantity.id, p) : model.y(at as number, p));

  const gather = (params: number[], relax = 1): Cand[] => {
    const cands: Cand[] = [];
    for (const k of params) {
      const p = spec.parameters[k];
      for (const value of newValues(p, before[k])) {
        const after = before.slice(); after[k] = value;
        for (const at of xs) {
          const from = measureAt(before, at); const to = measureAt(after, at);
          if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
          const delta = norm(to) - norm(from);
          const size = Math.abs(delta);
          if (r === 0) {
            if (size >= SAME_BELOW && size < CLEAR_ABOVE) continue;
            if (size < SAME_BELOW && relativeChange(from, to) >= SAME_RELATIVE) continue;
          }
          else if (size < MIN_MOVE[r] * relax) continue;
          if (r > 0) { const u = norm(to); if (u < 0.02 || u > 0.98) continue; }
          cands.push({ param: k, value, at, from, to, delta, dir: size < SAME_BELOW ? 'same' : delta > 0 ? 'up' : 'down' });
        }
      }
    }
    return cands;
  };

  let pool = gather([order[0]]);
  let wanted: Direction | null = null;
  if (r === 0) {
    if (!pool.length) pool = gather(order);
    const open = (['up', 'down', 'same'] as Direction[]).filter((d) => pool.some((c) => c.dir === d));
    const weight = (d: Direction) => (d === 'same' ? 0.6 : 1);
    let pick = rand() * open.reduce((t, d) => t + weight(d), 0);
    wanted = open[open.length - 1] ?? null;
    for (const d of open) { pick -= weight(d); if (pick <= 0) { wanted = d; break; } }
    if (wanted) pool = pool.filter((c) => c.dir === wanted);
  } else {
    if (!pool.length) pool = gather(order);
    if (!pool.length) pool = gather(order, 0.5);
  }
  if (!pool.length) throw new Error('no change of any parameter moves the answer enough to ask about it');
  const c = pool[Math.floor(rand() * pool.length)];

  const after = before.slice(); after[c.param] = c.value;
  const p = spec.parameters[c.param];
  const unit = quantity ? spec.x.unit : spec.y.unit;
  const tolerance = ask.tolerance ?? (r === 1 ? DEFAULT_PLACE_TOLERANCE : DEFAULT_VALUE_TOLERANCE);
  const track = quantity
    ? { before: { x: c.from, y: model.level(quantity.id, before) }, after: { x: c.to, y: model.level(quantity.id, after) } }
    : { before: { x: c.at as number, y: c.from }, after: { x: c.at as number, y: c.to } };

  const task: DialTask = {
    spec, rung: r, seed, ask, measure, before, after, changed: c.param, at: c.at, from: c.from, to: c.to, direction: c.dir,
    track, tolerance, unit, announce: '', question: '', why: '',
    model,
  } as DialTask;
  Object.defineProperty(task, 'model', { value: model, enumerable: false });
  task.announce = `The ${p.name.includes(',') ? p.name : `${p.name}, ${p.symbol}`}, ${sizeWords(before[c.param], c.value)}: from ${withUnit(before[c.param], p.unit)} to ${withUnit(c.value, p.unit)}.`;
  task.question = questionFor(task);
  task.why = fill(spec.why, whyVars(task));
  return task;
}

/** The marked point or the quantity, in words. */
function subject(task: DialTask, withAt = true): string {
  const s = task.spec;
  if (task.measure !== 'y') return `the ${(s.quantities ?? []).find((q) => q.id === task.measure)?.name ?? task.measure}`;
  return withAt ? `the ${s.y.name} at ${s.x.symbol} = ${withUnit(task.at as number, s.x.unit)}` : `the ${s.y.name}`;
}

function questionFor(task: DialTask): string {
  const s = task.spec;
  const custom = task.ask.question;
  if (custom) {
    return fill(custom, {
      at: task.at === null ? '' : withUnit(task.at, s.x.unit), x: s.x.symbol, y: s.y.name,
      measure: task.measure === 'y' ? s.y.name : (s.quantities ?? []).find((q) => q.id === task.measure)?.name ?? '',
    });
  }
  const what = subject(task);
  if (task.rung === 0) return `What happens to ${what}?`;
  if (task.rung === 1) return task.measure === 'y' ? `Drag the point to where ${what} will land.` : `Drag the point along the line to where ${what} will be.`;
  return `Work out ${what}. Type it with its unit.`;
}

export function whyVars(task: DialTask): Record<string, string> {
  const s = task.spec;
  const vars: Record<string, string> = {};
  s.parameters.forEach((p, i) => {
    vars[p.symbol] = withUnit(task.after[i], p.unit);
    vars[`${p.symbol}0`] = withUnit(task.before[i], p.unit);
  });
  const p = s.parameters[task.changed];
  vars.from = withUnit(task.before[task.changed], p.unit);
  vars.to = withUnit(task.after[task.changed], p.unit);
  if (task.at !== null) {
    vars.at = withUnit(task.at, s.x.unit);
    vars.y0 = withUnit(task.measure === 'y' ? task.from : task.model.y(task.at, task.before), s.y.unit);
    vars.y1 = withUnit(task.measure === 'y' ? task.to : task.model.y(task.at, task.after), s.y.unit);
  } else {
    vars.at = ''; vars.y0 = ''; vars.y1 = '';
  }
  for (const q of s.quantities ?? []) {
    vars[q.id] = withUnit(task.model.cross(q.id, task.after), s.x.unit);
    vars[`${q.id}0`] = withUnit(task.model.cross(q.id, task.before), s.x.unit);
  }
  return vars;
}

/** Parameter values part of the way through the change, for the reveal: moves in the parameter's own scale. */
export function blend(task: DialTask, t: number): number[] {
  const out = task.before.slice();
  const p = task.spec.parameters[task.changed];
  out[task.changed] = fromUnit(p, toUnit(p, task.before[task.changed]) + (toUnit(p, task.after[task.changed]) - toUnit(p, task.before[task.changed])) * t);
  return out;
}

/** Where the point sits for these parameters: at the marked x, or where the level is reached. */
export function spotFor(task: DialTask, p: readonly number[]): Spot {
  if (task.measure === 'y') return { x: task.at as number, y: task.model.y(task.at as number, p) };
  return { x: task.model.cross(task.measure, p), y: task.model.level(task.measure, p) };
}

// ── Judging an answer ────────────────────────────────────────────────────────

/** The measure's own axis: y for a value, x for a quantity. */
export function measureAxis(task: DialTask) {
  return task.measure === 'y' ? yAxis(task.spec) : { min: task.spec.x.min, max: task.spec.x.max, scale: task.spec.x.scale };
}

/** A typed answer as a number in the measure's unit, or what is wrong with it. */
export function readTyped(task: DialTask, text: string) {
  return readAnswer(text, task.unit);
}

/** Smallest slip that still counts, when the true value is near zero: half a percent of the axis. */
function floorFor(task: DialTask): number {
  const a = measureAxis(task);
  return a.scale === 'log' ? 0 : (a.max - a.min) * 0.005;
}

export function isClose(task: DialTask, value: number): boolean {
  if (task.rung === 1) return Math.abs(toUnit(measureAxis(task), value) - toUnit(measureAxis(task), task.to)) <= task.tolerance;
  return Math.abs(value - task.to) <= Math.max(task.tolerance * Math.abs(task.to), floorFor(task));
}

const DIRECTION_WORDS: Record<Direction, string> = { up: 'rises', down: 'falls', same: 'stays about the same' };
export const directionWord = (d: Direction) => DIRECTION_WORDS[d];

/** The direction a guessed value implies, relative to the starting value. */
function impliedDirection(task: DialTask, value: number): Direction {
  const a = measureAxis(task);
  const d = toUnit(a, value) - toUnit(a, task.from);
  return Math.abs(d) < SAME_BELOW ? 'same' : d > 0 ? 'up' : 'down';
}

export function changeWords(task: DialTask): string {
  const p = task.spec.parameters[task.changed];
  return `${p.symbol} ${task.after[task.changed] > task.before[task.changed] ? 'rises' : 'falls'} from ${withUnit(task.before[task.changed], p.unit)} to ${withUnit(task.after[task.changed], p.unit)}`;
}

export function result(task: DialTask, attempt: DialAttempt): RoundResult {
  const expectedKind = task.rung === 0 ? 'pick' : task.rung === 1 ? 'place' : 'type';
  if (attempt.kind !== expectedKind) throw new Error(`rung ${task.rung} expects a ${expectedKind} attempt`);
  const s = task.spec;
  const what = subject(task);
  const change = changeWords(task);
  let met: boolean;
  let label: string;
  let guessed: Direction;
  if (attempt.kind === 'pick') {
    met = attempt.pick === task.direction;
    guessed = attempt.pick;
    label = `Predicts that ${what} ${directionWord(task.direction)} when ${change}`;
  } else {
    met = isClose(task, attempt.value);
    guessed = impliedDirection(task, attempt.value);
    label = attempt.kind === 'place'
      ? `Places ${what} close to ${withUnit(task.to, task.unit)} (within ${Math.round(task.tolerance * 100)}% of the axis) when ${change}`
      : `Works out ${what} as ${withUnit(task.to, task.unit)}, within ${Math.round(task.tolerance * 100)}%, when ${change}`;
  }
  const out: RoundResult = { met, label: clip(label, 200), why: task.why };
  if (!met) {
    const subjectShort = task.measure === 'y' ? s.y.name : subject(task, false).replace(/^the /, '');
    const p = s.parameters[task.changed];
    const paramUp = task.after[task.changed] > task.before[task.changed];
    const ratio = attempt.kind === 'type' && task.to !== 0 ? Math.abs(attempt.value / task.to) : 0;
    const power = ratio > 0 ? Math.round(Math.log10(ratio)) : 0;
    if (power !== 0 && Math.abs(ratio / Math.pow(10, power) - 1) < 0.15) {
      // A clean factor of ten says more than a wrong direction: it is almost always a unit or a prefix.
      out.misconception = 'Out by a power of ten: check the unit and the prefix';
    } else if (guessed !== task.direction) {
      out.misconception = clip(
        guessed === 'same' ? `Expected the ${subjectShort} not to change when ${p.name} ${verb(paramUp)}`
          : task.direction === 'same' ? `Expected the ${subjectShort} to ${guessed === 'up' ? 'rise' : 'fall'} when ${p.name} ${verb(paramUp)}, though it barely moves there`
            : `Expected the ${subjectShort} to ${guessed === 'up' ? 'rise' : 'fall'} when ${p.name} ${verb(paramUp)}`, 120);
    }
  }
  return out;
}

/** The sentence under the plot once an answer is in: what was said and where it really is. */
export function gapSentence(task: DialTask, attempt: DialAttempt): string {
  const verdict = result(task, attempt);
  if (attempt.kind === 'pick') return verdict.met ? `Right: ${cap(subject(task))} ${directionWord(task.direction)}.` : `You said it ${directionWord(attempt.pick)}. It ${directionWord(task.direction)}.`;
  const guess = withUnit(attempt.value, task.unit);
  const truth = withUnit(task.to, task.unit);
  const off = Math.abs(attempt.value - task.to);
  if (verdict.met) return off === 0 || Math.abs(off) < Math.abs(task.to) * 1e-3 ? `Spot on: ${truth}.` : `You said ${guess}. It is ${truth}: close enough.`;
  return `You said ${guess}. It is ${truth}.`;
}

