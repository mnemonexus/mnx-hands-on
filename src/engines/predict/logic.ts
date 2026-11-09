/**
 * Predict the Result, the logic: no DOM, no subject. A spec lists a sample for each lane, the things in it (each with a size,
 * an amount and the labels or probes it carries), how the instrument finds them (everything, what carries a named label, what
 * a named probe matches) and how position follows size. This file works out the bands from that, sets a round, and judges
 * what the student placed. Nothing a student is told about the result is written in a spec: a typo in a spec gives a
 * strange setup, which `issues` refuses, and never a result that contradicts the technique.
 *
 * Two skins share all of it: "bands" (lanes of bands, placed and set to faint, medium or dark) and "trace" (a line drawn
 * with a few anchor points, judged by its peaks).
 *
 * Rungs: 0 fills one lane while the others are shown; 1 fills the whole result; 2 also asks which sample made a lane whose
 * name is hidden. Round 0 is the sample as given; later rounds each change one thing in it.
 */
import { clip } from '../../report';
import { RUNGS, hashSeed, rng, roundOf, type RoundResult } from '../../engine';
import { clamp, fmt } from '../../scale';

// ── The spec ─────────────────────────────────────────────────────────────────

export type Skin = 'bands' | 'trace';
export type Rule = 'all' | 'label' | 'probe';
export interface Detect { rule: Rule; name?: string }
export interface RunAxis { name: string; unit: string; min: number; max: number }
export interface AxisSpec {
  /** What the position follows, for example "size". */
  name: string; unit: string; min: number; max: number;
  scale?: 'log' | 'linear';
  /** Which comes first (nearest the start): the bigger or the smaller. */
  bigger?: 'first' | 'last';
  /** Bands: the sizes of a ladder drawn beside the lanes; false for none. Default: round values on the axis. */
  ladder?: false | number[];
  /** Position measured for known sizes (in run units); position then follows these instead of the simple rule. */
  standards?: Array<{ size: number; at: number }>;
  /** Traces: what the horizontal axis reads. */
  run?: RunAxis;
}
export interface SpeciesSpec {
  name: string; short?: string;
  size?: number;
  /** Traces: the observed position, in run units, instead of a size. */
  at?: number;
  /** Relative width of a peak (traces). */
  width?: number;
  carries?: string[];
  matches?: string[];
  /** This thing carries the labels of the named reagent whenever the lane holds some of it. */
  labelledBy?: string;
  /** Present in the sample but never on the result. */
  reagent?: boolean;
}
export interface BindingSpec { binder: string; on: string[] }
export interface LaneSpec { id: string; name: string; detail?: string; mix: Record<string, number>; detect?: Detect }
export interface ChangeSpec {
  id: string; say: string; lesson?: string;
  detect?: Detect;
  /** lane id (or "*" for every lane) → amounts to set; 0 removes. */
  set?: Record<string, Record<string, number>>;
  /** Replace one species by another in every lane, keeping its amount. */
  swap?: Record<string, string>;
  /** Multiply amounts of a species in every lane. */
  scale?: Record<string, number>;
}
export interface WhySpec {
  kind: 'blank' | 'absent' | 'present' | 'order' | 'darker';
  lane?: string; species?: string | string[];
  /** darker: the lane (and/or species) it is darker than. */
  than?: { lane?: string; species?: string };
  /** Configurations it holds in: "base" and/or change ids. Default: ["base"]. */
  in?: string[];
  say: string; misconception?: string;
}
export interface PredictSpec {
  skin?: Skin;
  technique: string;
  intro: string;
  lesson: string;
  axis: AxisSpec;
  species: Record<string, SpeciesSpec>;
  bindings?: BindingSpec[];
  lanes: LaneSpec[];
  detect: Detect;
  changes: ChangeSpec[];
  why?: WhySpec[];
  note?: string;
}

// ── Numbers ──────────────────────────────────────────────────────────────────

export const EPS = 1e-9;
/** Share of the strongest band: from here up is faint, medium and dark. */
export const LEVEL_FROM = [0.04, 0.15, 0.5] as const;
export const LEVEL_NAMES = ['', 'faint', 'medium', 'dark'] as const;
/** A peak shows from this share of the tallest peak in its trace. */
export const PEAK_FROM = 0.1;
/** Amounts must sit clear of a threshold by this factor, so no band is a coin toss. */
export const MARGIN = 1.25;
/** Bands closer than this (as a share of the run) merge, so a spec may not have them. */
export const BAND_GAP = 0.09;
export const PEAK_GAP = 0.15;
/** Placed bands are held to this many steps down the lane. */
export const STEPS = 48;
/** A student's band counts as above another only when it is at least this far above it. */
export const ORDER_SLACK = 1.5 / STEPS;
export const PEAK_SIGMA = 0.03;
export const ANCHORS = 17;
/** How far a drawn peak may sit from the true one and still count (a share of the run). */
export const PEAK_TOL = 0.1;
export const PEAK_SHOWS = 0.12;
export const PEAK_PROMINENCE = 0.08;
/** The truth is "larger" only when it is this many times; the student must show at least this much. */
export const LARGER_TRUTH = 1.5;
export const LARGER_GUESS = 1.15;
export const DEFAULT_TRACE_TOP = 0.86;

const IDENT = /^[A-Za-z0-9_]+$/;
const SLUG = /^[A-Za-z0-9_-]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown, max = 300): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s && !/^[A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export const skinOf = (spec: PredictSpec): Skin => (spec.skin === 'trace' ? 'trace' : 'bands');

// ── Species, including what binds together ───────────────────────────────────

export const membersOf = (id: string) => id.split('+');
export const isProduct = (id: string) => id.includes('+');

export interface SpeciesInfo { id: string; name: string; short: string; size: number | null; at: number | null; width: number; reagent: boolean }

export function infoOf(spec: PredictSpec, id: string): SpeciesInfo | null {
  const parts = membersOf(id);
  const found = parts.map((p) => spec.species[p]);
  if (found.some((s) => !s)) return null;
  if (parts.length === 1) {
    const s = found[0];
    return { id, name: s.name, short: s.short ?? s.name, size: s.size ?? null, at: s.at ?? null, width: s.width ?? 1, reagent: s.reagent === true };
  }
  const sizes = found.map((s) => s.size);
  return {
    id, name: found.map((s) => s.short ?? s.name).join(' + '), short: found.map((s) => s.short ?? s.name).join('·'),
    size: sizes.every((z) => isNum(z)) ? (sizes as number[]).reduce((a, b) => a + b, 0) : null, at: null,
    width: Math.max(...found.map((s) => s.width ?? 1)), reagent: found.some((s) => s.reagent === true),
  };
}

/** Where along the run (0 at the start, 1 at the far end) a species sits. */
export function placeOf(spec: PredictSpec, info: SpeciesInfo): number {
  const a = spec.axis;
  if (info.at !== null && a.run) return (info.at - a.run.min) / (a.run.max - a.run.min);
  const size = info.size as number;
  const first = a.bigger !== 'last';
  if (a.standards?.length && a.run) {
    const pts = [...a.standards].sort((p, q) => p.size - q.size).map((p) => ({ u: Math.log(p.size), v: (p.at - a.run!.min) / (a.run!.max - a.run!.min) }));
    const u = Math.log(size);
    if (pts.length === 1) return pts[0].v;
    let i = 0;
    while (i < pts.length - 2 && u > pts[i + 1].u) i++;
    const p0 = pts[i]; const p1 = pts[i + 1];
    return p0.v + ((u - p0.u) / (p1.u - p0.u)) * (p1.v - p0.v);
  }
  const f = a.scale === 'linear' ? (size - a.min) / (a.max - a.min) : (Math.log(size) - Math.log(a.min)) / (Math.log(a.max) - Math.log(a.min));
  return first ? 1 - f : f;
}

// ── Working out a result ─────────────────────────────────────────────────────

export interface Band {
  sp: string; name: string; short: string;
  size: number | null; amount: number;
  /** Share of the strongest in its group (the whole result for bands, the lane for a trace). */
  rel: number;
  /** Where along the run, 0..1. */
  t: number;
  /** 1 faint, 2 medium, 3 dark (bands); 0 for a trace. */
  level: number;
  /** A trace: the peak height as a share of the axis. */
  height: number;
  width: number;
}
export interface ResolvedLane {
  id: string; name: string; detail: string; detect: Detect;
  /** Amounts after anything has bound. */
  amounts: Record<string, number>;
  /** What the lane was given before anything bound. */
  mix: Record<string, number>;
  bands: Band[];
}
export interface Config { id: string; say: string; lesson: string; detect: Detect; lanes: ResolvedLane[] }

function applyChange(spec: PredictSpec, change: ChangeSpec | null): { lanes: LaneSpec[]; detect: Detect } {
  let lanes: LaneSpec[] = spec.lanes.map((l) => ({ ...l, mix: { ...l.mix } }));
  let detect = spec.detect;
  if (change) {
    for (const [from, to] of Object.entries(change.swap ?? {})) {
      lanes = lanes.map((l) => {
        if (!(from in l.mix)) return l;
        const mix = { ...l.mix };
        mix[to] = (mix[to] ?? 0) + mix[from];
        delete mix[from];
        return { ...l, mix };
      });
    }
    for (const [sp, factor] of Object.entries(change.scale ?? {})) {
      lanes = lanes.map((l) => (sp in l.mix ? { ...l, mix: { ...l.mix, [sp]: l.mix[sp] * factor } } : l));
    }
    for (const [laneId, amounts] of Object.entries(change.set ?? {})) {
      lanes = lanes.map((l) => (laneId === '*' || laneId === l.id ? { ...l, mix: { ...l.mix, ...amounts } } : l));
    }
    if (change.detect) detect = change.detect;
  }
  return { lanes, detect };
}

/** Let each binder take hold of what it binds, in the order the spec lists them. */
export function bind(spec: PredictSpec, mix: Record<string, number>): Record<string, number> {
  const amounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(mix)) if (v > EPS) amounts[k] = v;
  for (const b of spec.bindings ?? []) {
    const have = amounts[b.binder] ?? 0;
    const total = b.on.reduce((n, id) => n + (amounts[id] ?? 0), 0);
    if (have <= EPS || total <= EPS) continue;
    const taken = Math.min(have, total);
    for (const id of b.on) {
      const a = amounts[id] ?? 0;
      if (a <= EPS) continue;
      const part = (taken * a) / total;
      amounts[id] = a - part;
      const product = `${id}+${b.binder}`;
      amounts[product] = (amounts[product] ?? 0) + part;
    }
    amounts[b.binder] = have - taken;
  }
  for (const k of Object.keys(amounts)) if (amounts[k] <= EPS) delete amounts[k];
  return amounts;
}

function labelsIn(spec: PredictSpec, id: string, mix: Record<string, number>): Set<string> {
  const out = new Set<string>();
  for (const m of membersOf(id)) {
    const s = spec.species[m];
    for (const l of s?.carries ?? []) out.add(l);
    if (s?.labelledBy && (mix[s.labelledBy] ?? 0) > EPS) for (const l of spec.species[s.labelledBy]?.carries ?? []) out.add(l);
  }
  return out;
}
function matchesOf(spec: PredictSpec, id: string): Set<string> {
  const out = new Set<string>();
  for (const m of membersOf(id)) for (const p of spec.species[m]?.matches ?? []) out.add(p);
  return out;
}

export function isSeen(spec: PredictSpec, id: string, mix: Record<string, number>, detect: Detect): boolean {
  if (detect.rule === 'all') return true;
  if (detect.rule === 'label') return labelsIn(spec, id, mix).has(detect.name ?? '');
  return matchesOf(spec, id).has(detect.name ?? '');
}

export const levelOf = (rel: number) => (rel >= LEVEL_FROM[2] ? 3 : rel >= LEVEL_FROM[1] ? 2 : rel >= LEVEL_FROM[0] ? 1 : 0);

/** Everything that is seen in one lane, before it is compared with the other lanes. */
function seenIn(spec: PredictSpec, lane: LaneSpec, laneDetect: Detect): { amounts: Record<string, number>; seen: Array<{ info: SpeciesInfo; amount: number }> } {
  const amounts = bind(spec, lane.mix);
  const seen: Array<{ info: SpeciesInfo; amount: number }> = [];
  for (const [id, amount] of Object.entries(amounts)) {
    const info = infoOf(spec, id);
    if (!info || info.reagent) continue;
    if (!isSeen(spec, id, lane.mix, laneDetect)) continue;
    seen.push({ info, amount });
  }
  return { amounts, seen };
}

export function resolveConfig(spec: PredictSpec, change: ChangeSpec | null): Config {
  const applied = applyChange(spec, change);
  const trace = skinOf(spec) === 'trace';
  const raw = applied.lanes.map((l) => {
    const detect = l.detect ?? applied.detect;
    return { l, detect, ...seenIn(spec, l, detect) };
  });
  const global = Math.max(0, ...raw.flatMap((r) => r.seen.map((s) => s.amount)));
  const lanes: ResolvedLane[] = raw.map((r) => {
    const top = trace ? Math.max(0, ...r.seen.map((s) => s.amount)) : global;
    const bands: Band[] = [];
    for (const { info, amount } of r.seen) {
      const rel = top > 0 ? amount / top : 0;
      const t = placeOf(spec, info);
      if (trace) {
        if (rel < PEAK_FROM) continue;
        bands.push({ sp: info.id, name: info.name, short: info.short, size: info.size, amount, rel, t, level: 0, height: rel * DEFAULT_TRACE_TOP, width: info.width });
      } else {
        const level = levelOf(rel);
        if (!level) continue;
        bands.push({ sp: info.id, name: info.name, short: info.short, size: info.size, amount, rel, t, level, height: 0, width: info.width });
      }
    }
    bands.sort((a, b) => a.t - b.t);
    return { id: r.l.id, name: r.l.name, detail: r.l.detail ?? '', detect: r.detect, amounts: r.amounts, mix: r.l.mix, bands };
  });
  return { id: change?.id ?? 'base', say: change?.say ?? '', lesson: change?.lesson ?? spec.lesson, detect: applied.detect, lanes };
}

export const configsOf = (spec: PredictSpec): Config[] => [resolveConfig(spec, null), ...spec.changes.map((c) => resolveConfig(spec, c))];

// ── Checking a spec ──────────────────────────────────────────────────────────

function detectIssues(spec: PredictSpec, d: unknown, where: string, add: (m: string) => void, mustMatch: boolean) {
  if (!isObj(d) || (d.rule !== 'all' && d.rule !== 'label' && d.rule !== 'probe')) { add(`${where} must be { "rule": "all" }, { "rule": "label", "name": ... } or { "rule": "probe", "name": ... }.`); return; }
  if (d.rule !== 'all' && !isText(d.name, 80)) add(`${where} needs a \`name\` for its ${d.rule}.`);
  if (mustMatch && d.rule !== 'all' && isText(d.name, 80)) {
    const ids = Object.keys(spec.species);
    const hit = ids.some((id) => (d.rule === 'label' ? labelsAnywhere(spec, id).has(d.name as string) : (spec.species[id].matches ?? []).includes(d.name as string)));
    if (!hit) add(`${where} names a ${d.rule} "${String(d.name)}" that no species carries, so nothing would ever show.`);
  }
}
function labelsAnywhere(spec: PredictSpec, id: string): Set<string> {
  const out = new Set<string>(spec.species[id]?.carries ?? []);
  const by = spec.species[id]?.labelledBy;
  if (by) for (const l of spec.species[by]?.carries ?? []) out.add(l);
  return out;
}

export function issues(input: PredictSpec): string[] {
  const out: string[] = [];
  const raw = input as unknown;
  if (!isObj(raw)) return ['The spec must be an object.'];
  const add = (msg: string) => { if (out.length < 14 && !out.includes(msg)) out.push(msg); };
  const s = raw as Record<string, unknown>;

  if (s.skin !== undefined && s.skin !== 'bands' && s.skin !== 'trace') add('`skin` must be "bands" or "trace".');
  const trace = s.skin === 'trace';
  if (!isText(s.technique, 60)) add('`technique` must name what is being run, in a few words.');
  if (!isText(s.intro, 400)) add('`intro` must set the experiment up in plain words (at most 400 characters).');
  if (!isText(s.lesson, 300)) add('`lesson` must be the one sentence shown when a round is right.');
  if (s.note !== undefined && !isText(s.note, 240)) add('`note`, when given, must be a short line of text.');

  // The axis.
  const a = s.axis;
  if (!isObj(a)) add('`axis` must say how position follows size.');
  else {
    if (!isText(a.name, 40)) add('`axis.name` must be a word or two, for example "size".');
    if (typeof a.unit !== 'string' || a.unit.length > 20) add('`axis.unit` must be text (use "" for none).');
    if (!isNum(a.min) || !isNum(a.max) || !(a.min < a.max)) add('`axis` needs a `min` below its `max`.');
    if (a.scale !== undefined && a.scale !== 'log' && a.scale !== 'linear') add('`axis.scale` must be "log" or "linear".');
    if ((a.scale ?? 'log') === 'log' && isNum(a.min) && a.min <= 0) add('`axis.min` must be above 0 on a log axis.');
    if (a.bigger !== undefined && a.bigger !== 'first' && a.bigger !== 'last') add('`axis.bigger` must be "first" or "last".');
    if (trace) {
      const r = a.run;
      if (!isObj(r) || !isText(r.name, 40) || typeof r.unit !== 'string' || !isNum(r.min) || !isNum(r.max) || !(r.min < r.max)) add('A trace needs `axis.run`: { name, unit, min, max } for its horizontal axis.');
    }
    if (a.standards !== undefined) {
      if (!Array.isArray(a.standards) || a.standards.length < 2 || a.standards.some((p) => !isObj(p) || !isNum(p.size) || p.size <= 0 || !isNum(p.at))) add('`axis.standards` must list at least two { size, at } pairs.');
      else if (!isObj(a.run)) add('`axis.standards` is read in run units, so `axis.run` is needed too.');
    }
    if (a.ladder !== undefined && a.ladder !== false && (!Array.isArray(a.ladder) || a.ladder.some((v) => !isNum(v) || v <= 0))) add('`axis.ladder` must be false or a list of sizes.');
  }

  // Species.
  const sp = s.species;
  if (!isObj(sp) || !Object.keys(sp).length) add('`species` must list the things that can be in a lane.');
  else for (const [id, v] of Object.entries(sp)) {
    if (!IDENT.test(id)) { add(`The species id "${id}" must be letters, digits and underscores only.`); continue; }
    if (!isObj(v) || !isText(v.name, 80)) { add(`Species "${id}" needs a \`name\`.`); continue; }
    if (v.short !== undefined && !isText(v.short, 12)) add(`Species "${id}": \`short\` must be at most 12 characters.`);
    if (v.size !== undefined && (!isNum(v.size) || v.size <= 0)) add(`Species "${id}": \`size\` must be above 0.`);
    if (v.at !== undefined && !(trace && isNum(v.at))) add(`Species "${id}": \`at\` is for traces only, and must be a number.`);
    if (v.reagent !== true && v.size === undefined && v.at === undefined) add(`Species "${id}" needs a \`size\` (or \`at\` in a trace), or must be a \`reagent\`.`);
    for (const k of ['carries', 'matches'] as const) if (v[k] !== undefined && (!Array.isArray(v[k]) || (v[k] as unknown[]).some((x) => !isText(x, 40)))) add(`Species "${id}": \`${k}\` must be a list of names.`);
    if (v.labelledBy !== undefined && (typeof v.labelledBy !== 'string' || !isObj(sp[v.labelledBy]))) add(`Species "${id}": \`labelledBy\` must name another species.`);
  }
  if (out.length) return out;
  const spec = input;
  const species = spec.species;

  // Bindings.
  const made = new Set<string>();
  if (spec.bindings !== undefined && !Array.isArray(spec.bindings)) add('`bindings`, when given, must be a list.');
  else for (const [i, b] of (spec.bindings ?? []).entries()) {
    if (!isObj(b) || typeof b.binder !== 'string' || !Array.isArray(b.on) || !b.on.length) { add(`\`bindings[${i}]\` needs a \`binder\` and a list \`on\`.`); continue; }
    const known = (id: string) => (id in species) || made.has(id);
    if (!(b.binder in species)) add(`\`bindings[${i}].binder\` "${b.binder}" is not a species.`);
    for (const id of b.on) {
      if (!known(id)) add(`\`bindings[${i}].on\` names "${id}", which is neither a species nor made by an earlier binding.`);
      else {
        const info = infoOf(spec, id);
        if (info && info.size === null && !trace) add(`"${id}" has no size, so what it binds to has no size either.`);
        made.add(`${id}+${b.binder}`);
      }
    }
  }

  // Lanes.
  const laneIds = new Set<string>();
  if (!Array.isArray(spec.lanes) || spec.lanes.length < 1 || spec.lanes.length > 8) add('`lanes` must list one to eight lanes.');
  else for (const [i, l] of spec.lanes.entries()) {
    if (!isObj(l) || typeof l.id !== 'string' || !SLUG.test(l.id) || !isText(l.name, 80)) { add(`\`lanes[${i}]\` needs an \`id\` (letters and digits) and a \`name\`.`); continue; }
    if (laneIds.has(l.id)) add(`The lane id "${l.id}" is used twice.`);
    laneIds.add(l.id);
    if (l.detail !== undefined && !isText(l.detail, 200)) add(`Lane "${l.id}": \`detail\` must be a short line of text.`);
    if (!isObj(l.mix) || !Object.keys(l.mix).length) add(`Lane "${l.id}" needs a \`mix\`: what it was given, with amounts.`);
    else for (const [k, v] of Object.entries(l.mix)) {
      if (!(k in species)) add(`Lane "${l.id}" holds "${k}", which is not a species.`);
      else if (!isNum(v) || v < 0) add(`Lane "${l.id}": the amount of "${k}" must be a number, 0 or more.`);
    }
    if (l.detect !== undefined) detectIssues(spec, l.detect, `Lane "${l.id}": \`detect\``, add, true);
  }
  detectIssues(spec, spec.detect, '`detect`', add, true);

  // Changes.
  if (!Array.isArray(spec.changes) || spec.changes.length < 2 || spec.changes.length > 6) add('`changes` must list two to six single changes, because a run has a changed sample in each of its later rounds.');
  const changeIds = new Set<string>(['base']);
  for (const [i, c] of (Array.isArray(spec.changes) ? spec.changes : []).entries()) {
    if (!isObj(c) || typeof c.id !== 'string' || !SLUG.test(c.id) || !isText(c.say, 200)) { add(`\`changes[${i}]\` needs an \`id\` and a \`say\` sentence.`); continue; }
    if (changeIds.has(c.id)) add(`The change id "${c.id}" is used twice (or is "base").`);
    changeIds.add(c.id);
    if (c.lesson !== undefined && !isText(c.lesson, 300)) add(`Change "${c.id}": \`lesson\` must be one sentence.`);
    if (c.detect !== undefined) detectIssues(spec, c.detect, `Change "${c.id}": \`detect\``, add, false);
    for (const [lane, amounts] of Object.entries(c.set ?? {})) {
      if (lane !== '*' && !laneIds.has(lane)) add(`Change "${c.id}" sets lane "${lane}", which does not exist.`);
      for (const [k, v] of Object.entries(amounts ?? {})) if (!(k in species) || !isNum(v) || v < 0) add(`Change "${c.id}" sets "${k}" to something that is not a species amount.`);
    }
    for (const [from, to] of Object.entries(c.swap ?? {})) if (!(from in species) || !(to in species)) add(`Change "${c.id}" swaps "${from}" for "${String(to)}", but both must be species.`);
    for (const [k, v] of Object.entries(c.scale ?? {})) if (!(k in species) || !isNum(v) || v < 0) add(`Change "${c.id}" scales "${k}" by something that is not a number.`);
    if (!c.detect && !c.set && !c.swap && !c.scale) add(`Change "${c.id}" changes nothing.`);
  }
  if (out.length) return out;

  // Every sample in every configuration, worked out.
  const configs = configsOf(spec);
  const runWord = trace ? 'peaks' : 'bands';
  for (const [ci, cfg] of configs.entries()) {
    const where = ci === 0 ? 'The sample as given' : `After "${cfg.id}"`;
    for (const lane of cfg.lanes) {
      for (const b of lane.bands) {
        if (!(b.t >= -EPS && b.t <= 1 + EPS)) add(`${where}: ${b.name} in lane "${lane.id}" would run off the ${trace ? 'trace' : 'result'} (position ${fmt(b.t)}). Widen the axis.`);
      }
      for (let i = 1; i < lane.bands.length; i++) {
        const gap = lane.bands[i].t - lane.bands[i - 1].t;
        if (gap < (trace ? PEAK_GAP : BAND_GAP)) add(`${where}: ${lane.bands[i - 1].name} and ${lane.bands[i].name} in lane "${lane.id}" run too close together to tell apart as ${runWord}.`);
      }
    }
    // Nothing may sit close to a threshold, or its darkness is a coin toss.
    const global = Math.max(0, ...cfg.lanes.flatMap((l) => Object.entries(l.amounts).filter(([id]) => { const inf = infoOf(spec, id); return inf && !inf.reagent && isSeen(spec, id, l.mix, l.detect); }).map(([, v]) => v)));
    for (const lane of cfg.lanes) {
      const top = trace ? Math.max(0, ...Object.entries(lane.amounts).filter(([id]) => { const inf = infoOf(spec, id); return inf && !inf.reagent && isSeen(spec, id, lane.mix, lane.detect); }).map(([, v]) => v)) : global;
      for (const [id, amount] of Object.entries(lane.amounts)) {
        const inf = infoOf(spec, id);
        if (!inf || inf.reagent || !isSeen(spec, id, lane.mix, lane.detect) || top <= 0) continue;
        const rel = amount / top;
        for (const thr of trace ? [PEAK_FROM] : LEVEL_FROM) {
          if (rel > thr / MARGIN && rel < thr * MARGIN) add(`${where}: the amount of ${inf.name} in lane "${lane.id}" is ${fmt(rel * 100, 2)}% of the strongest, too close to the ${fmt(thr * 100, 2)}% line between two darknesses to call. Change an amount.`);
        }
      }
    }
    if (!cfg.lanes.some((l) => l.bands.length)) add(`${where} shows nothing in any lane.`);
  }
  if (out.length) return out;

  // The reasons a spec offers must be true.
  const sizeOf = (id: string) => infoOf(spec, id)?.size ?? 0;
  const bandOf = (cfg: Config, laneId: string, id: string) => cfg.lanes.find((l) => l.id === laneId)?.bands.find((b) => b.sp === id);
  const covered = new Set<string>();
  for (const [i, w] of (spec.why ?? []).entries()) {
    const at = `why[${i}]`;
    if (!isObj(w) || !['blank', 'absent', 'present', 'order', 'darker'].includes(w.kind as string) || !isText(w.say, 220)) { add(`\`${at}\` needs a \`kind\` (blank, absent, present, order or darker) and a \`say\` sentence of at most 220 characters.`); continue; }
    if (w.misconception !== undefined && !isText(w.misconception, 120)) add(`\`${at}.misconception\` must be a short phrase.`);
    const inList = w.in ?? ['base'];
    if (!Array.isArray(inList) || inList.some((c) => !changeIds.has(c))) { add(`\`${at}.in\` must list "base" and/or change ids.`); continue; }
    if (w.lane !== undefined && !laneIds.has(w.lane)) { add(`\`${at}\` names lane "${w.lane}", which does not exist.`); continue; }
    for (const cid of inList) {
      const cfg = configs.find((c) => c.id === cid) as Config;
      if (w.kind === 'blank') {
        if (!w.lane) { add(`\`${at}\` (blank) needs a \`lane\`.`); break; }
        covered.add(`${cid}|${w.lane}`);
        if ((cfg.lanes.find((l) => l.id === w.lane) as ResolvedLane).bands.length) add(`\`${at}\` says lane "${w.lane}" is blank, but it shows bands in "${cid}".`);
      } else if (w.kind === 'absent' || w.kind === 'present') {
        const id = w.species as string;
        if (typeof id !== 'string' || !infoOf(spec, id)) { add(`\`${at}\` (${w.kind}) needs a \`species\`.`); break; }
        for (const lid of w.lane ? [w.lane] : [...laneIds]) {
          const seen = !!bandOf(cfg, lid, id);
          if (seen !== (w.kind === 'present')) add(`\`${at}\` says ${id} is ${w.kind} in lane "${lid}" in "${cid}", but the engine works out the opposite.`);
        }
      } else if (w.kind === 'order') {
        const pair = w.species;
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some((p) => !infoOf(spec, p))) { add(`\`${at}\` (order) needs \`species\`: [first, second], the one nearer the start first.`); break; }
        if (!(placeOf(spec, infoOf(spec, pair[0]) as SpeciesInfo) < placeOf(spec, infoOf(spec, pair[1]) as SpeciesInfo))) add(`\`${at}\` says ${pair[0]} runs before ${pair[1]}, but its position says otherwise (sizes ${fmt(sizeOf(pair[0]))} and ${fmt(sizeOf(pair[1]))}).`);
      } else if (w.kind === 'darker') {
        const id = w.species as string;
        const than = w.than;
        if (!w.lane || typeof id !== 'string' || !isObj(than) || (!than.lane && !than.species)) { add(`\`${at}\` (darker) needs a \`lane\`, a \`species\` and \`than\`: { lane } and/or { species }.`); break; }
        const val = (b: Band | undefined) => (b ? (trace ? b.height : b.level) : 0);
        const mine = val(bandOf(cfg, w.lane, id));
        const theirs = val(bandOf(cfg, than.lane ?? w.lane, than.species ?? id));
        if (!(mine > theirs)) add(`\`${at}\` says ${id} in lane "${w.lane}" is darker than the other, but in "${cid}" it is not.`);
      }
    }
  }
  for (const cfg of configs) for (const lane of cfg.lanes) {
    if (!lane.bands.length && !covered.has(`${cfg.id}|${lane.id}`)) add(`Lane "${lane.id}" shows nothing in "${cfg.id}", so a \`why\` of kind "blank" is needed for it (with "in": ["${cfg.id}"]), to say why.`);
  }
  if (out.length) return out;

  // A round must be able to be set at every rung.
  for (let rung = 0; rung < RUNGS; rung++) {
    for (const seed of ['check:0', 'check:1', 'check:2', 'a:0', 'b:1', 'c:2', 'd:1', 'e:2']) {
      try {
        const task = prepare(spec, seed, rung);
        if (!task.fill.length) add(`Rung ${rung} left nothing to fill in.`);
      } catch (e) {
        add(`Rung ${rung} cannot set a round from this spec: ${(e as Error).message}`);
        break;
      }
    }
  }
  return out;
}

// ── Setting a round ──────────────────────────────────────────────────────────

export interface TaskLane {
  id: string; name: string; detail: string;
  /** What the instrument shows for it. */
  truth: Band[];
  /** Shown to the student already (rung 0's other lanes, and rung 2's hidden lane). */
  given: boolean;
  /** Rung 2: the name is held back. */
  hidden: boolean;
  detect: Detect;
}
export interface PaletteItem { id: string; name: string; short: string; size: number | null }
export interface Mystery { lane: number; options: Array<{ lane: number; name: string }>; correct: number[] }

export interface PredictTask {
  spec: PredictSpec;
  rung: number;
  seed: string;
  round: number;
  skin: Skin;
  technique: string;
  change: { id: string; say: string } | null;
  announce: string;
  question: string;
  lesson: string;
  lanes: TaskLane[];
  /** Lanes the student fills in, by index. */
  fill: number[];
  palette: PaletteItem[];
  ladder: Array<{ size: number; t: number }>;
  mystery: Mystery | null;
}

const signature = (lane: { truth: Band[] }, trace: boolean) => JSON.stringify(lane.truth.map((b) => [b.sp, trace ? Math.round(b.height * 20) : b.level]));

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Round values on the axis, for a ladder beside the lanes. */
export function autoLadder(a: AxisSpec): number[] {
  if (a.ladder === false) return [];
  if (Array.isArray(a.ladder)) return a.ladder;
  const out: number[] = [];
  if ((a.scale ?? 'log') === 'log') {
    const multipliers = Math.log10(a.max / a.min) <= 1.3 ? [1, 2, 3, 4, 5, 6] : [1, 2, 5];
    for (let e = Math.floor(Math.log10(a.min)); e <= Math.ceil(Math.log10(a.max)); e++) for (const m of multipliers) {
      const v = m * Math.pow(10, e);
      if (v >= a.min * (1 - 1e-9) && v <= a.max * (1 + 1e-9)) out.push(v);
    }
  } else {
    const step = (a.max - a.min) / 6;
    for (let i = 0; i <= 6; i++) out.push(Number((a.min + step * i).toPrecision(3)));
  }
  return out.length > 7 ? out.filter((_, i) => i % 2 === 0) : out;
}

/** At rung 1 no more than this many lanes are shown. */
export const MAX_LANES_RUNG1 = 4;

/**
 * Which lanes rung 1 keeps when there are more than four, chosen by the seed. The key contrast always stays in: the lanes the
 * round's change altered together with one lane that did not change, or, in round 0, a lane and one that differs from it.
 * Returned in the order the spec lists them.
 */
function chooseLanes(spec: PredictSpec, change: ChangeSpec | null, cfg: Config, rand: () => number, trace: boolean): number[] {
  const all = cfg.lanes.map((_, i) => i);
  if (all.length <= MAX_LANES_RUNG1) return all;
  const sigOf = (l: ResolvedLane) => signature({ truth: l.bands }, trace);
  const sig = cfg.lanes.map(sigOf);
  const base = change ? resolveConfig(spec, null) : null;
  const changed = base ? all.filter((i) => sigOf(base.lanes[i]) !== sig[i]) : [];
  const pick: number[] = [];
  const take = (i: number | undefined) => { if (i !== undefined && !pick.includes(i) && pick.length < MAX_LANES_RUNG1) pick.push(i); };
  if (changed.length) {
    for (const i of shuffled(changed, rand).slice(0, MAX_LANES_RUNG1 - 1)) take(i);
    take(shuffled(all.filter((i) => !pick.includes(i) && !changed.includes(i) && sig[i] !== sig[pick[0]]), rand)[0]);
    take(shuffled(all.filter((i) => !pick.includes(i) && !changed.includes(i)), rand)[0]);
  } else {
    take(0);
    take(shuffled(all.filter((i) => sig[i] !== sig[0]), rand)[0]);
  }
  for (const i of shuffled(all, rand)) take(i);
  return pick.sort((a, c) => a - c);
}

export function prepare(spec: PredictSpec, seed: string, rung: number): PredictTask {
  const r = clamp(Math.round(rung), 0, RUNGS - 1);
  const rand = rng(seed);
  const trace = skinOf(spec) === 'trace';
  const round = roundOf(seed);
  const base = seed.replace(/:\d+$/, '');
  const change = round > 0 ? spec.changes[(hashSeed(base) + round - 1) % spec.changes.length] : null;
  const cfg = resolveConfig(spec, change);
  const kept = r === 1 ? chooseLanes(spec, change, cfg, rand, trace) : cfg.lanes.map((_, i) => i);
  const shown = kept.map((i) => cfg.lanes[i]);
  const n = shown.length;

  const lanes: TaskLane[] = shown.map((l) => ({ id: l.id, name: l.name, detail: l.detail, truth: l.bands, given: false, hidden: false, detect: l.detect }));
  let fill = lanes.map((_, i) => i);
  let mystery: Mystery | null = null;

  if (r === 2 && n >= 3) {
    const sig0 = signature(lanes[0], trace);
    const different = lanes.map((l, i) => i).filter((i) => i > 0 && signature(lanes[i], trace) !== sig0 && lanes[i].truth.length > 0);
    const pool = different.length ? different : lanes.map((_, i) => i).filter((i) => lanes[i].truth.length > 0);
    const pick = pool[Math.floor(rand() * pool.length)];
    const sig = signature(lanes[pick], trace);
    lanes[pick].given = true; lanes[pick].hidden = true;
    mystery = {
      lane: pick,
      options: lanes.map((l, i) => ({ lane: i, name: l.name })),
      correct: lanes.map((l, i) => i).filter((i) => signature(lanes[i], trace) === sig),
    };
    fill = fill.filter((i) => i !== pick);
  } else if (r === 0 && n > 1) {
    const target = Math.floor(rand() * n);
    lanes.forEach((l, i) => { l.given = i !== target; });
    fill = [target];
  }

  // What can be placed: whatever is in a lane, other than reagents. Products that show somewhere are included.
  const seen = new Set<string>();
  const shows = new Set<string>();
  for (const l of shown) {
    for (const id of Object.keys(l.amounts)) { const info = infoOf(spec, id); if (info && !info.reagent && !isProduct(id)) seen.add(id); }
    for (const b of l.bands) shows.add(b.sp);
  }
  const palette: PaletteItem[] = shuffled([...new Set([...seen, ...shows])], rand).map((id) => {
    const info = infoOf(spec, id) as SpeciesInfo;
    return { id, name: info.name, short: info.short, size: info.size };
  });

  const a = spec.axis;
  const ladder = trace ? [] : autoLadder(a).map((size) => ({ size, t: placeOf(spec, { id: '_', name: '', short: '', size, at: null, width: 1, reagent: false }) })).filter((p) => p.t >= -EPS && p.t <= 1 + EPS);

  const hiddenWord = r === 2 ? ' The sample in one lane is not named; you will be asked which one it is.' : '';
  const how = trace
    ? 'Drag the rings up to draw the trace you expect for each sample, then press Run.'
    : 'Drag each band into the lane where you expect it, set how dark it is, then press Run.';
  const only = r === 0 ? ` Lane ${fill[0] + 1} is yours to fill; the others are shown.` : '';
  return {
    spec, rung: r, seed, round, skin: trace ? 'trace' : 'bands', technique: spec.technique,
    change: change ? { id: change.id, say: change.say } : null,
    announce: change ? `The same experiment, with one thing changed: ${lowerFirst(change.say)}` : spec.intro,
    question: `${how}${only}${hiddenWord}`,
    lesson: cfg.lesson, lanes, fill, palette, ladder, mystery,
  };
}

// ── Judging a result ─────────────────────────────────────────────────────────

export interface PlacedBand { lane: number; sp: string; y: number; level: number }
export type PredictAttempt =
  | { skin: 'bands'; placed: PlacedBand[]; pick?: number }
  | { skin: 'trace'; anchors: number[][]; pick?: number };

export type MismatchKind = 'missing' | 'extra' | 'order' | 'darker' | 'peak-missing' | 'peak-extra' | 'larger' | 'sample';
export interface Mismatch { kind: MismatchKind; lane: number; /** Every lane it holds in, when the same slip is made in several. */ lanes?: number[]; sp?: string; sp2?: string; lane2?: number; text: string; misconception?: string }

/** The peaks of a drawn trace: local maxima of the anchors, with a plateau counted once. */
export interface DrawnPeak { t: number; height: number }
export function drawnPeaks(anchors: readonly number[]): DrawnPeak[] {
  const k = anchors.length;
  const out: DrawnPeak[] = [];
  let i = 0;
  while (i < k) {
    let j = i;
    while (j + 1 < k && Math.abs(anchors[j + 1] - anchors[i]) < 1e-9) j++;
    const left = i === 0 ? -Infinity : anchors[i - 1];
    const right = j === k - 1 ? -Infinity : anchors[j + 1];
    const h = anchors[i];
    if (h > left && h >= right && h >= PEAK_SHOWS) {
      // Prominence: how far it stands above the higher of the two valleys on either side before anything taller.
      let lo = h; for (let m = i - 1; m >= 0 && anchors[m] <= h; m--) lo = Math.min(lo, anchors[m]);
      let ro = h; for (let m = j + 1; m < k && anchors[m] <= h; m++) ro = Math.min(ro, anchors[m]);
      const leftWall = (() => { for (let m = i - 1; m >= 0; m--) if (anchors[m] > h) return true; return false; })();
      const rightWall = (() => { for (let m = j + 1; m < k; m++) if (anchors[m] > h) return true; return false; })();
      const base = leftWall && rightWall ? Math.max(lo, ro) : leftWall ? lo : rightWall ? ro : Math.min(lo, ro);
      if (h - base >= PEAK_PROMINENCE) out.push({ t: ((i + j) / 2) / (k - 1), height: h });
    }
    i = j + 1;
  }
  return out;
}

export const laneNumber = (i: number) => `lane ${i + 1}`;

function runPhrase(spec: PredictSpec, b: Band): string {
  const a = spec.axis;
  if (b.size !== null && a.unit) return `${fmt(b.size)} ${a.unit}`;
  return skinOf(spec) === 'trace' ? `${spec.axis.run?.name ?? 'position'} ${fmt(spec.axis.run ? spec.axis.run.min + b.t * (spec.axis.run.max - spec.axis.run.min) : b.t)}` : b.name;
}

/** What the engine can say about a cell on its own, when the spec has no sentence for it. */
function reasonFor(task: PredictTask, laneIdx: number, sp: string, shown: boolean): string {
  const spec = task.spec;
  const lane = task.lanes[laneIdx];
  const info = infoOf(spec, sp) as SpeciesInfo;
  const where = laneNumber(laneIdx);
  const detect = lane.detect;
  const resolved = resolveConfig(spec, task.change ? (spec.changes.find((c) => c.id === task.change?.id) ?? null) : null).lanes[laneIdx];
  const present = (resolved.amounts[sp] ?? 0) > EPS;
  const probe = detect.rule === 'probe' ? `the probe for ${detect.name}` : detect.rule === 'label' ? `the ${detect.name} label` : 'the detection';
  if (shown) {
    return detect.rule === 'all' ? `${cap(info.name)} is in ${where}, so it shows.` : `${cap(info.name)} is in ${where} and ${detect.rule === 'label' ? `carries ${probe}` : `is found by ${probe}`}, so it shows.`;
  }
  if (!present) return `There is no ${info.name} in ${where}, so there is nothing to show.`;
  if (detect.rule !== 'all' && !isSeen(spec, sp, resolved.mix, detect)) {
    return detect.rule === 'label' ? `${cap(info.name)} is in ${where} but does not carry ${probe}, so it cannot show.` : `${cap(info.name)} is in ${where} but ${probe} does not find it, so it cannot show.`;
  }
  return `There is too little ${info.name} in ${where} to show against the rest.`;
}

function whyFor(task: PredictTask, kind: WhySpec['kind'], laneIdx: number, sp?: string | string[], lane2?: number, sp2?: string): { say: string; misconception?: string } | null {
  const spec = task.spec;
  const cid = task.change?.id ?? 'base';
  const lid = task.lanes[laneIdx]?.id;
  for (const w of spec.why ?? []) {
    if (!(w.in ?? ['base']).includes(cid) || w.kind !== kind) continue;
    if (w.lane !== undefined && w.lane !== lid) continue;
    if (kind === 'order') { if (!Array.isArray(w.species) || !Array.isArray(sp) || w.species[0] !== sp[0] || w.species[1] !== sp[1]) continue; }
    else if (w.species !== undefined && w.species !== sp) continue;
    if (kind === 'darker') {
      const t = w.than ?? {};
      if (t.lane !== undefined && t.lane !== task.lanes[lane2 ?? laneIdx]?.id) continue;
      if (t.species !== undefined && t.species !== (sp2 ?? sp)) continue;
    }
    return { say: w.say, misconception: w.misconception };
  }
  return null;
}

/** Everything wrong with an attempt, in the order a student should hear it. Bands only count in lanes the student filled. */
export function judge(task: PredictTask, attempt: PredictAttempt): Mismatch[] {
  const out: Mismatch[] = [];
  const spec = task.spec;
  if (attempt.skin === 'bands' && task.skin === 'bands') {
    for (const li of task.fill) {
      const lane = task.lanes[li];
      const mine = attempt.placed.filter((p) => p.lane === li);
      const placed = new Map<string, PlacedBand>();
      for (const p of mine) if (!placed.has(p.sp)) placed.set(p.sp, p);
      const truth = new Map(lane.truth.map((b) => [b.sp, b]));
      if (!lane.truth.length) {
        const w = whyFor(task, 'blank', li);
        if (placed.size) out.push({ kind: 'extra', lane: li, sp: [...placed.keys()][0], text: `${cap(laneNumber(li))} is blank. ${w?.say ?? 'Nothing in it is picked up by the detection.'}`, misconception: w?.misconception ?? 'Expected bands where the detection picks nothing up' });
        continue;
      }
      for (const b of lane.truth) if (!placed.has(b.sp)) {
        const w = whyFor(task, 'present', li, b.sp);
        out.push({ kind: 'missing', lane: li, sp: b.sp, text: `${cap(laneNumber(li))} should show ${b.name}. ${w?.say ?? reasonFor(task, li, b.sp, true)}`, misconception: w?.misconception ?? 'Left out a band that the detection does pick up' });
      }
      for (const id of placed.keys()) if (!truth.has(id)) {
        const w = whyFor(task, 'absent', li, id);
        out.push({ kind: 'extra', lane: li, sp: id, text: `${cap(laneNumber(li))} does not show ${infoOf(spec, id)?.name ?? id}. ${w?.say ?? reasonFor(task, li, id, false)}`, misconception: w?.misconception ?? 'Placed a band that the detection does not pick up' });
      }
      // Order: the one that is bigger runs less far.
      const both = lane.truth.filter((b) => placed.has(b.sp));
      for (let i = 0; i < both.length; i++) for (let j = i + 1; j < both.length; j++) {
        const a = both[i]; const b = both[j];
        if (b.t - a.t < BAND_GAP) continue;
        if (!((placed.get(b.sp) as PlacedBand).y - (placed.get(a.sp) as PlacedBand).y >= ORDER_SLACK)) {
          const w = whyFor(task, 'order', li, [a.sp, b.sp]);
          out.push({ kind: 'order', lane: li, sp: a.sp, sp2: b.sp, text: `In ${laneNumber(li)}, ${a.name} runs ${spec.axis.bigger === 'last' ? 'less far than' : 'nearer the start than'} ${b.name}. ${w?.say ?? orderReason(spec, a, b)}`, misconception: w?.misconception ?? 'Mixed up which of two runs further' });
        }
      }
    }
    // Darkness: within a lane, and for one thing across lanes (the lanes shown count too).
    const levelAt = (li: number, sp: string): number | null => {
      const lane = task.lanes[li];
      if (task.fill.includes(li)) return attempt.placed.find((p) => p.lane === li && p.sp === sp)?.level ?? null;
      return lane.truth.find((b) => b.sp === sp)?.level ?? null;
    };
    const flagged = new Set<string>();
    const compare = (la: number, a: string, lb: number, b: string) => {
      const ta = task.lanes[la].truth.find((x) => x.sp === a)?.level ?? 0;
      const tb = task.lanes[lb].truth.find((x) => x.sp === b)?.level ?? 0;
      if (!ta || !tb || ta === tb) return;
      const [hiL, hiS, loL, loS] = ta > tb ? [la, a, lb, b] : [lb, b, la, a];
      const ha = levelAt(hiL, hiS); const lo = levelAt(loL, loS);
      if (ha === null || lo === null) return;
      if (ha > lo) return;
      const mine = task.fill.includes(hiL) ? hiL : loL;
      const key = `${mine}|${task.fill.includes(hiL) ? hiS : loS}`;
      if (flagged.has(key)) return;
      flagged.add(key);
      const sameLane = hiL === loL;
      const w = whyFor(task, 'darker', hiL, hiS, loL, loS);
      const hiName = infoOf(spec, hiS)?.name ?? hiS; const loName = infoOf(spec, loS)?.name ?? loS;
      const text = sameLane
        ? `In ${laneNumber(hiL)}, ${hiName} is darker than ${loName}.`
        : hiS === loS ? `${cap(hiName)} is darker in ${laneNumber(hiL)} than in ${laneNumber(loL)}.` : `${cap(hiName)} in ${laneNumber(hiL)} is darker than ${loName} in ${laneNumber(loL)}.`;
      out.push({ kind: 'darker', lane: mine, sp: hiS, sp2: loS, lane2: loL, text: `${text} ${w?.say ?? darkReason(task, hiL, hiS, loL, loS)}`, misconception: w?.misconception ?? 'Did not let the amount decide how dark a band is' });
    };
    for (let li = 0; li < task.lanes.length; li++) for (let lj = li; lj < task.lanes.length; lj++) {
      if (!task.fill.includes(li) && !task.fill.includes(lj)) continue;
      for (const a of task.lanes[li].truth) for (const b of task.lanes[lj].truth) {
        if (li === lj ? a.sp < b.sp : a.sp === b.sp) compare(li, a.sp, lj, b.sp);
      }
    }
  } else if (attempt.skin === 'trace' && task.skin === 'trace') {
    for (const li of task.fill) {
      const lane = task.lanes[li];
      const drawn = drawnPeaks(attempt.anchors[li] ?? []);
      const used = new Set<number>();
      const matched: Array<{ truth: Band; drawn: DrawnPeak | null }> = [];
      for (const b of lane.truth) {
        let best = -1; let dist = Infinity;
        drawn.forEach((d, i) => { const e = Math.abs(d.t - b.t); if (!used.has(i) && e < dist) { dist = e; best = i; } });
        if (best >= 0 && dist <= PEAK_TOL) { used.add(best); matched.push({ truth: b, drawn: drawn[best] }); } else matched.push({ truth: b, drawn: null });
      }
      if (!lane.truth.length) {
        const w = whyFor(task, 'blank', li);
        if (drawn.length) out.push({ kind: 'peak-extra', lane: li, text: `${cap(laneNumber(li))} stays flat. ${w?.say ?? 'Nothing in it is picked up by the detection.'}`, misconception: w?.misconception ?? 'Expected a peak where the detection picks nothing up' });
        continue;
      }
      for (const m of matched) if (!m.drawn) {
        const w = whyFor(task, 'present', li, m.truth.sp);
        out.push({ kind: 'peak-missing', lane: li, sp: m.truth.sp, text: `${cap(laneNumber(li))} has a peak for ${m.truth.name} at about ${runPhrase(spec, m.truth)}. ${w?.say ?? reasonFor(task, li, m.truth.sp, true)}`, misconception: w?.misconception ?? 'Left out a peak that the detection does pick up' });
      }
      drawn.forEach((d, i) => {
        if (used.has(i)) return;
        const near = lane.truth.reduce((p, b) => (Math.abs(b.t - d.t) < Math.abs(p.t - d.t) ? b : p), lane.truth[0]);
        const w = whyFor(task, 'absent', li, near.sp);
        out.push({ kind: 'peak-extra', lane: li, text: `${cap(laneNumber(li))} has no peak where you drew one${near ? ` (the nearest real one is ${near.name}, at about ${runPhrase(spec, near)})` : ''}. ${w?.say ?? 'Only what the detection picks up makes a peak.'}`, misconception: w?.misconception ?? 'Drew a peak the sample does not give' });
      });
      const both = matched.filter((m) => m.drawn);
      for (let i = 0; i < both.length; i++) for (let j = i + 1; j < both.length; j++) {
        const a = both[i]; const b = both[j];
        const ratio = a.truth.height / b.truth.height;
        if (ratio >= LARGER_TRUTH && !((a.drawn as DrawnPeak).height >= (b.drawn as DrawnPeak).height * LARGER_GUESS)) {
          const w = whyFor(task, 'darker', li, a.truth.sp, li, b.truth.sp);
          out.push({ kind: 'larger', lane: li, sp: a.truth.sp, sp2: b.truth.sp, text: `In ${laneNumber(li)}, the ${a.truth.name} peak is taller than the ${b.truth.name} peak. ${w?.say ?? 'There is more of it in the sample.'}`, misconception: w?.misconception ?? 'Did not let the amount decide how tall a peak is' });
        } else if (1 / ratio >= LARGER_TRUTH && !((b.drawn as DrawnPeak).height >= (a.drawn as DrawnPeak).height * LARGER_GUESS)) {
          const w = whyFor(task, 'darker', li, b.truth.sp, li, a.truth.sp);
          out.push({ kind: 'larger', lane: li, sp: b.truth.sp, sp2: a.truth.sp, text: `In ${laneNumber(li)}, the ${b.truth.name} peak is taller than the ${a.truth.name} peak. ${w?.say ?? 'There is more of it in the sample.'}`, misconception: w?.misconception ?? 'Did not let the amount decide how tall a peak is' });
        }
      }
    }
  }
  // The same slip about order in several lanes is told once.
  const merged: Mismatch[] = [];
  for (const m of out) {
    const twin = m.kind === 'order' ? merged.find((x) => x.kind === 'order' && x.sp === m.sp && x.sp2 === m.sp2) : undefined;
    if (twin) { twin.lanes = [...(twin.lanes ?? [twin.lane]), m.lane]; continue; }
    merged.push(m);
  }
  for (const m of merged) {
    if (m.kind === 'order' && m.lanes && m.lanes.length > 1) {
      const where = m.lanes.length === 2 ? `lanes ${m.lanes[0] + 1} and ${m.lanes[1] + 1}` : `lanes ${m.lanes.slice(0, -1).map((l) => l + 1).join(', ')} and ${m.lanes[m.lanes.length - 1] + 1}`;
      m.text = m.text.replace(/^In lane \d+/, `In ${where}`);
    }
  }
  out.length = 0;
  out.push(...merged);
  if (task.mystery) {
    const pick = attempt.pick;
    if (pick === undefined || !task.mystery.correct.includes(pick)) {
      const right = task.mystery.correct.map((i) => task.lanes[i].name);
      out.push({ kind: 'sample', lane: task.mystery.lane, text: `The lane with no name came from "${right[0]}"${right.length > 1 ? ` (or ${right.slice(1).map((n) => `"${n}"`).join(' or ')}, which give the same result)` : ''}.`, misconception: 'Could not tell which sample made a result' });
    }
  }
  return out;
}

function orderReason(spec: PredictSpec, a: Band, b: Band): string {
  // `a` is nearer the start than `b`.
  if (a.size === null || b.size === null) return `Position follows ${spec.axis.name}.`;
  return spec.axis.bigger === 'last'
    ? `${cap(a.name)} is smaller than ${b.name}, so it comes first.`
    : `${cap(a.name)} is bigger than ${b.name}, so it moves less far.`;
}
function darkReason(task: PredictTask, hiL: number, hiS: string, loL: number, loS: string): string {
  const spec = task.spec;
  const cfg = resolveConfig(spec, task.change ? (spec.changes.find((c) => c.id === task.change?.id) ?? null) : null);
  const a = cfg.lanes.find((l) => l.id === task.lanes[hiL].id)?.bands.find((x) => x.sp === hiS);
  const b = cfg.lanes.find((l) => l.id === task.lanes[loL].id)?.bands.find((x) => x.sp === loS);
  if (!a || !b) return '';
  return `There is more of it (about ${fmt(a.amount / b.amount, 2)} times as much), and the darkness follows the amount.`;
}

/** The faint, medium or dark band each truth band should be, written for a student. */
export function truthSummary(task: PredictTask, li: number): string {
  const lane = task.lanes[li];
  if (!lane.truth.length) return 'blank';
  return lane.truth.map((b) => (task.skin === 'trace' ? b.short : `${b.short} ${LEVEL_NAMES[b.level]}`)).join(', ');
}

export function result(task: PredictTask, attempt: PredictAttempt): RoundResult {
  const mism = judge(task, attempt);
  const darker = mism.filter((m) => m.kind === 'darker').length;
  const hard = mism.filter((m) => m.kind !== 'darker');
  const met = hard.length === 0 && darker <= 1;
  const lanes = task.fill.map((i) => i);
  const spec = task.spec;
  const what = task.skin === 'trace' ? 'peaks' : 'bands';
  const subject = lanes.length === 1
    ? `${laneNumber(lanes[0])} (${task.lanes[lanes[0]].name}): ${truthSummary(task, lanes[0])}`
    : `${lanes.length} lanes, for example ${laneNumber(lanes[0])}: ${truthSummary(task, lanes[0])}`;
  const change = task.change ? ` after ${lowerFirst(task.change.say.replace(/\.$/, ''))}` : '';
  const named = task.mystery ? ' and says which sample made the unnamed lane' : '';
  const label = clip(`Predicts the ${what} of the ${spec.technique}${change}, ${subject}${named}`, 200);
  const first = mism[0];
  const why = met ? task.lesson : clip([first?.text, mism[1]?.text].filter(Boolean).join(' ') || task.lesson, 420);
  const out: RoundResult = { met, label, why };
  if (!met && first?.misconception) out.misconception = clip(first.misconception, 120);
  return out;
}

// ── Drawing helpers shared by the view and the tests ─────────────────────────

/** A smooth line through anchor points that never overshoots them (monotone cubic), so a peak is only ever at an anchor. */
export function smooth(ys: readonly number[]): (t: number) => number {
  const n = ys.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0];
  const dx = 1 / (n - 1);
  const d = Array.from({ length: n - 1 }, (_, i) => (ys[i + 1] - ys[i]) / dx);
  const m = new Array<number>(n).fill(0);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  return (t) => {
    const u = clamp(t, 0, 1) / dx;
    const i = Math.min(n - 2, Math.floor(u));
    const s = u - i;
    const h00 = (1 + 2 * s) * (1 - s) * (1 - s); const h10 = s * (1 - s) * (1 - s); const h01 = s * s * (3 - 2 * s); const h11 = s * s * (s - 1);
    return h00 * ys[i] + h10 * dx * m[i] + h01 * ys[i + 1] + h11 * dx * m[i + 1];
  };
}

/** The true line for a trace: a clean peak for each band, no noise. */
export function truthLine(bands: readonly Band[]): (t: number) => number {
  return (t) => bands.reduce((sum, b) => sum + b.height * Math.exp(-0.5 * Math.pow((t - b.t) / (PEAK_SIGMA * b.width), 2)), 0);
}
