/**
 * Choose Your Controls, the logic: no DOM, no subject. A result is shown with two to four rival explanations. A spec says
 * what each explanation would give under each extra condition, in a small vocabulary (signal, none, reduced, increased).
 * This file works out the rest: which pairs of explanations a chosen set of conditions tells apart, which condition is a
 * decoy that gives the same result whatever is true, and the smallest sets that separate everything.
 *
 * A spec is refused if some pair of explanations can never be told apart, or if no condition is a decoy.
 *
 * Rungs: 0 gives a strong set and asks what each condition is for; 1 chooses freely from generous slots; 2 has tight slots.
 */
import { clip } from '../../report';
import { RUNGS, rng, type RoundResult } from '../../engine';
import { clamp } from '../../scale';

// ── The spec ─────────────────────────────────────────────────────────────────

export const OUTCOMES = ['signal', 'none', 'reduced', 'increased'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const MAX_HYPOTHESES = 4;
export const MIN_CONDITIONS = 4;
export const MAX_CONDITIONS = 10;

export interface Hypothesis { id: string; name: string }
export interface Condition {
  id: string; name: string;
  /** What is looked at when it runs, in a few words. */
  reads?: string;
  detail?: string;
  /** What each outcome means for this condition, in its own words. */
  says?: Partial<Record<Outcome, string>>;
}
export interface ControlsSpec {
  /** What was seen, which the explanations are trying to account for. */
  result: { title: string; detail?: string };
  hypotheses: Hypothesis[];
  conditions: Condition[];
  /** condition id → hypothesis id → what would be seen if that explanation were true. */
  outcomes: Record<string, Record<string, Outcome>>;
  lesson: string;
  note?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const SLUG = /^[A-Za-z0-9_-]+$/;

// ── What a set of conditions tells apart ─────────────────────────────────────

export type Pair = [number, number];

/** Every pair of explanations, by index. */
export function pairsOf(n: number): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

export interface Grid { hyps: Hypothesis[]; conds: Condition[]; cell: Outcome[][] /* [cond][hyp] */ }

export function gridOf(spec: ControlsSpec, hypIds?: string[], condIds?: string[]): Grid {
  const hyps = hypIds ? hypIds.map((id) => spec.hypotheses.find((h) => h.id === id) as Hypothesis) : spec.hypotheses;
  const conds = condIds ? condIds.map((id) => spec.conditions.find((c) => c.id === id) as Condition) : spec.conditions;
  return { hyps, conds, cell: conds.map((c) => hyps.map((h) => spec.outcomes[c.id][h.id])) };
}

/** The conditions (by index) that give two explanations different results. */
export const separators = (g: Grid, pair: Pair): number[] => g.conds.map((_, c) => c).filter((c) => g.cell[c][pair[0]] !== g.cell[c][pair[1]]);

/** A condition that gives the same result whatever is true tells you nothing about which explanation is right. */
export const isDecoy = (g: Grid, c: number) => g.cell[c].every((o) => o === g.cell[c][0]);

export interface Verdict {
  /** For each pair: the chosen conditions that tell it apart (empty means they still look the same). */
  told: Array<{ pair: Pair; by: number[] }>;
  stuck: Pair[];
  wasted: number[];
  all: boolean;
}
export function verdictOf(g: Grid, chosen: readonly number[]): Verdict {
  const told = pairsOf(g.hyps.length).map((pair) => ({ pair, by: separators(g, pair).filter((c) => chosen.includes(c)) }));
  return {
    told, stuck: told.filter((t) => !t.by.length).map((t) => t.pair),
    wasted: chosen.filter((c) => isDecoy(g, c)),
    all: told.every((t) => t.by.length > 0),
  };
}

/** Every smallest set of conditions that tells all the pairs apart. */
export function smallestSets(g: Grid): number[][] {
  const n = g.conds.length;
  for (let size = 1; size <= n; size++) {
    const found: number[][] = [];
    const walk = (start: number, set: number[]) => {
      if (set.length === size) { if (verdictOf(g, set).all) found.push(set.slice()); return; }
      for (let c = start; c < n; c++) { set.push(c); walk(c + 1, set); set.pop(); }
    };
    walk(0, []);
    if (found.length) return found;
  }
  return [];
}

/** Whether a grid is a fit set-up: every pair separable, a decoy present, and room to choose. */
function fitness(g: Grid): string | null {
  if (g.hyps.length < 2) return 'fewer than two explanations';
  for (const pair of pairsOf(g.hyps.length)) if (!separators(g, pair).length) return `${g.hyps[pair[0]].name} and ${g.hyps[pair[1]].name} can never be told apart`;
  if (!g.conds.some((_, c) => isDecoy(g, c))) return 'no condition is a decoy';
  const min = smallestSets(g)[0]?.length ?? 99;
  if (g.conds.length < min + 2) return `only ${g.conds.length} conditions for a smallest set of ${min}`;
  return null;
}

// ── Checking a spec ──────────────────────────────────────────────────────────

export function issues(input: ControlsSpec): string[] {
  const out: string[] = [];
  const raw = input as unknown;
  if (!isObj(raw)) return ['The spec must be an object.'];
  const add = (msg: string) => { if (out.length < 14 && !out.includes(msg)) out.push(msg); };
  const s = raw as Record<string, unknown>;

  if (!isObj(s.result) || !isText(s.result.title, 160)) add('`result.title` must say what was seen, in one sentence (at most 160 characters).');
  else if (s.result.detail !== undefined && !isText(s.result.detail, 300)) add('`result.detail`, when given, must be a short line of text.');
  if (!isText(s.lesson, 300)) add('`lesson` must be the one sentence shown when a round is right.');
  if (s.note !== undefined && !isText(s.note, 240)) add('`note`, when given, must be a short line of text.');

  const hyps = Array.isArray(s.hypotheses) ? s.hypotheses : [];
  if (hyps.length < 2 || hyps.length > MAX_HYPOTHESES) add(`\`hypotheses\` must list two to ${MAX_HYPOTHESES} rival explanations.`);
  const hypIds = new Set<string>();
  for (const [i, h] of hyps.entries()) {
    if (!isObj(h) || typeof h.id !== 'string' || !SLUG.test(h.id) || !isText(h.name, 120)) { add(`\`hypotheses[${i}]\` needs an \`id\` and a \`name\`.`); continue; }
    if (hypIds.has(h.id)) add(`The explanation id "${h.id}" is used twice.`);
    hypIds.add(h.id);
  }
  const conds = Array.isArray(s.conditions) ? s.conditions : [];
  if (conds.length < MIN_CONDITIONS || conds.length > MAX_CONDITIONS) add(`\`conditions\` must list ${MIN_CONDITIONS} to ${MAX_CONDITIONS} extra conditions that could be run.`);
  const condIds = new Set<string>();
  for (const [i, c] of conds.entries()) {
    if (!isObj(c) || typeof c.id !== 'string' || !SLUG.test(c.id) || !isText(c.name, 120)) { add(`\`conditions[${i}]\` needs an \`id\` and a \`name\`.`); continue; }
    if (condIds.has(c.id)) add(`The condition id "${c.id}" is used twice.`);
    condIds.add(c.id);
    if (c.reads !== undefined && !isText(c.reads, 80)) add(`Condition "${c.id}": \`reads\` must be a few words.`);
    if (c.detail !== undefined && !isText(c.detail, 200)) add(`Condition "${c.id}": \`detail\` must be a short line of text.`);
    if (c.says !== undefined) {
      if (!isObj(c.says)) add(`Condition "${c.id}": \`says\` must map outcomes to sentences.`);
      else for (const [k, v] of Object.entries(c.says)) if (!(OUTCOMES as readonly string[]).includes(k) || !isText(v, 120)) add(`Condition "${c.id}": \`says\` may use ${OUTCOMES.join(', ')} with a short sentence each.`);
    }
  }
  const outcomes = s.outcomes;
  if (!isObj(outcomes)) add('`outcomes` must give, for each condition, what each explanation would show.');
  else for (const cid of condIds) {
    const row = outcomes[cid];
    if (!isObj(row)) { add(`\`outcomes\` has nothing for the condition "${cid}".`); continue; }
    for (const hid of hypIds) if (!(OUTCOMES as readonly string[]).includes(row[hid] as string)) add(`\`outcomes.${cid}.${hid}\` must be one of ${OUTCOMES.join(', ')}.`);
    for (const k of Object.keys(row)) if (!hypIds.has(k)) add(`\`outcomes.${cid}\` names "${k}", which is not an explanation.`);
  }
  if (isObj(outcomes)) for (const k of Object.keys(outcomes)) if (!condIds.has(k)) add(`\`outcomes\` names "${k}", which is not a condition.`);
  if (out.length) return out;

  const spec = input;
  const g = gridOf(spec);
  for (const pair of pairsOf(g.hyps.length)) {
    if (!separators(g, pair).length) add(`"${g.hyps[pair[0]].name}" and "${g.hyps[pair[1]].name}" give the same result under every condition, so no choice of controls could ever tell them apart. Add a condition that separates them, or merge them.`);
  }
  if (!g.conds.some((_, c) => isDecoy(g, c))) add('No condition is a decoy. Add one that gives the same result under every explanation, so a wasted control can be shown for what it is.');
  if (out.length) return out;
  const min = smallestSets(g)[0]?.length ?? 0;
  if (g.conds.length < min + 2) add(`The smallest set that tells everything apart has ${min} conditions, but there are only ${g.conds.length}. There must be at least ${min + 2}, so that slots can be tight at one rung and generous at another.`);
  if (out.length) return out;

  for (let rung = 0; rung < RUNGS; rung++) {
    for (const seed of ['check:0', 'check:1', 'check:2', 'a:0', 'b:1', 'c:2']) {
      try {
        const t = prepare(spec, seed, rung);
        if (rung === 0 && !t.questions.length) add('Rung 0 set no question about what a condition is for.');
        if (rung > 0 && t.slots >= t.grid.conds.length) add(`Rung ${rung} has as many slots as conditions, so there is nothing to choose.`);
      } catch (e) {
        add(`Rung ${rung} cannot set a round from this spec: ${(e as Error).message}`);
        break;
      }
    }
  }
  return out;
}

// ── Setting a round ──────────────────────────────────────────────────────────

export interface PurposeOption { label: string; pair: Pair | null; correct: boolean }
export interface PurposeQuestion { cond: number; prompt: string; options: PurposeOption[] }

export interface ControlsTask {
  spec: ControlsSpec;
  rung: number;
  seed: string;
  /** The explanations and conditions of this round: a subset of the spec's, in a shuffled order. */
  grid: Grid;
  /** How many conditions may be run (rungs 1 and 2). */
  slots: number;
  /** The size of the smallest set that tells everything apart. */
  smallest: number;
  /** Rung 0: the strong set that is run, by condition index. */
  strong: number[];
  questions: PurposeQuestion[];
  announce: string;
  question: string;
  lesson: string;
}

export type ControlsAttempt =
  | { kind: 'set'; chosen: number[] }
  | { kind: 'purposes'; answers: number[] };

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const pairName = (g: Grid, pair: Pair) => `${g.hyps[pair[0]].name} from ${g.hyps[pair[1]].name}`;
const letter = (i: number) => String.fromCharCode(65 + i);
export const hypLabel = (g: Grid, i: number) => `${letter(i)}. ${g.hyps[i].name}`;

/** Which explanations and conditions a round uses: a drawn subset where that stays fit, else all of them. */
function drawGrid(spec: ControlsSpec, rand: () => number): Grid {
  const allH = spec.hypotheses.map((h) => h.id);
  const allC = spec.conditions.map((c) => c.id);
  for (let attempt = 0; attempt < 24; attempt++) {
    let h = allH; let c = allC;
    if (allH.length > 3 && attempt % 2 === 0) h = shuffled(allH, rand).slice(0, 3);
    if (allC.length > 4) { const drop = Math.floor(rand() * Math.min(3, allC.length - 3)); c = shuffled(allC, rand).slice(0, allC.length - drop); }
    const g = gridOf(spec, shuffled(h, rand), shuffled(c, rand));
    if (!fitness(g)) return g;
  }
  return gridOf(spec, shuffled(allH, rand), shuffled(allC, rand));
}

export function prepare(spec: ControlsSpec, seed: string, rung: number): ControlsTask {
  const r = clamp(Math.round(rung), 0, RUNGS - 1);
  const rand = rng(seed);
  const g = drawGrid(spec, rand);
  const sets = smallestSets(g);
  const smallest = sets[0].length;
  const slots = r === 2 ? smallest : Math.min(g.conds.length - 1, smallest + (g.conds.length - smallest >= 4 ? 2 : 1));
  let strong: number[] = [];
  const questions: PurposeQuestion[] = [];
  if (r === 0) {
    strong = sets[Math.floor(rand() * sets.length)].slice().sort((a, b) => a - b);
    const all = pairsOf(g.hyps.length);
    for (const c of strong) {
      const yes = all.filter((p) => g.cell[c][p[0]] !== g.cell[c][p[1]]);
      const no = all.filter((p) => g.cell[c][p[0]] === g.cell[c][p[1]]);
      const right = yes[Math.floor(rand() * yes.length)];
      const options: PurposeOption[] = [{ label: `It tells ${letter(right[0])} from ${letter(right[1])}`, pair: right, correct: true }];
      for (const p of shuffled(no, rand).slice(0, 2)) options.push({ label: `It tells ${letter(p[0])} from ${letter(p[1])}`, pair: p, correct: false });
      options.push({ label: 'It tells none of the explanations apart', pair: null, correct: false });
      questions.push({ cond: c, prompt: `What is "${g.conds[c].name}" for?`, options: shuffled(options, rand) });
    }
  }
  const n = g.hyps.length;
  const announce = r === 0
    ? strong.length === 1
      ? `This one condition would tell the ${n} explanations apart. Say what it is for, then run it.`
      : `These ${strong.length} conditions would tell the ${n} explanations apart. Say what each one is for, then run them.`
    : `Choose which extra conditions to run, up to ${slots}. Then run them and see which explanations are still left looking the same.`;
  return {
    spec, rung: r, seed, grid: g, slots, smallest, strong, questions, announce,
    question: r === 0 ? 'For each condition, choose what it tells apart.' : r === 1 ? `You have ${slots} slots, more than the fewest that could do it.` : `You have only ${slots} slots: the fewest that could do it.`,
    lesson: spec.lesson,
  };
}

// ── Judging a choice ─────────────────────────────────────────────────────────

/** How an outcome reads for a condition, in the condition's own words when it has them. */
export function outcomeWords(cond: Condition, o: Outcome): string {
  if (cond.says?.[o]) return cond.says[o] as string;
  const what = cond.reads ?? 'the result';
  return o === 'signal' ? `${what}: seen` : o === 'none' ? `${what}: not seen` : o === 'reduced' ? `${what}: lower` : `${what}: higher`;
}

export function stuckSentence(g: Grid, stuck: Pair[]): string {
  if (!stuck.length) return '';
  const names = stuck.slice(0, 3).map((p) => `${letter(p[0])} and ${letter(p[1])}`);
  return `Still cannot be told apart: ${names.join(', ')}${stuck.length > 3 ? `, and ${stuck.length - 3} more` : ''}. No condition you chose gives them different results.`;
}

export function result(task: ControlsTask, attempt: ControlsAttempt): RoundResult {
  const g = task.grid;
  if (attempt.kind === 'purposes') {
    const right = task.questions.map((q, i) => q.options[attempt.answers[i]]?.correct === true);
    const met = right.every(Boolean);
    const first = task.questions.findIndex((_, i) => !right[i]);
    const label = clip(`Says what each of ${task.questions.map((q) => `"${g.conds[q.cond].name}"`).join(' and ')} is for, in telling ${g.hyps.length} explanations apart`, 200);
    if (met) return { met, label, why: task.lesson };
    const q = task.questions[first];
    const yes = pairsOf(g.hyps.length).filter((p) => g.cell[q.cond][p[0]] !== g.cell[q.cond][p[1]]);
    const picked = q.options[attempt.answers[first]];
    return {
      met, label,
      why: clip(`"${g.conds[q.cond].name}" tells ${yes.slice(0, 2).map((p) => `${letter(p[0])} from ${letter(p[1])}`).join(' and ')}${yes.length > 2 ? ' and more' : ''}, because those explanations would give different results under it.`, 300),
      misconception: picked && picked.pair === null ? 'Thought a condition that separates explanations tells none of them apart' : 'Took a condition to test a pair of explanations that it cannot separate',
    };
  }
  const v = verdictOf(g, attempt.chosen);
  const tooMany = attempt.chosen.length > task.slots;
  const met = v.all && !tooMany && attempt.chosen.length > 0;
  const names = attempt.chosen.map((c) => `"${g.conds[c].name}"`).join(' and ') || 'nothing';
  const label = clip(`Chooses ${names} so that ${g.hyps.length} explanations can be told apart, with ${task.slots} slots`, 200);
  if (met) return { met, label, why: task.lesson };
  const parts: string[] = [];
  if (tooMany) parts.push(`That is ${attempt.chosen.length} conditions and there are only ${task.slots} slots.`);
  if (!v.all) parts.push(stuckSentence(g, v.stuck));
  if (v.wasted.length) parts.push(`${cap(g.conds[v.wasted[0]].name)} gives the same result under every explanation, so running it tells you nothing.`);
  const out: RoundResult = { met, label, why: clip(parts.filter(Boolean).join(' '), 360) || task.lesson };
  if (v.wasted.length) out.misconception = 'Treated a condition that gives the same result under every explanation as useful';
  else if (!v.all) out.misconception = 'Chose conditions that leave two explanations looking the same';
  return out;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
