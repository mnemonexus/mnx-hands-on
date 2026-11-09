/**
 * Break the Construct, the logic: no DOM, no subject. A spec draws a construct as parts in a row, lists the factors that
 * act on it, and holds a small rule table saying what each factor needs in order to act (which part, in which order) and
 * what that does to a readout. The engine works out the readout in every condition, with one copy of the construct or two,
 * so a student's prediction can never be checked against a typed answer.
 *
 * The one physical idea, which is general and carries no subject: a PART works only on its own copy of the construct, and a
 * FACTOR is shared by the whole cell. So a factor made by a part on either copy reaches both copies (a "trans" effect),
 * while a part that is changed spoils only the copy it sits on (a "cis" effect). Nothing here says which is which.
 *
 * The rules, in plain words. A readout has levels (two to four, named by the spec) and a base level that a working copy
 * gives. For one copy in one condition:
 *   - a "needs" rule must hold or the readout is the lowest level. Rules that share a `group` are alternatives: any one will do.
 *   - an "adds" rule that holds raises the level (by 1 unless it says); a "blocks" rule that holds lowers it (to the lowest
 *     unless it says), the strongest blocker counting.
 *   - a rule "holds" when its part still works for its factor on THAT copy, the factor is active, and any order it asks for
 *     is kept. A rule with no factor holds when its part works.
 *   - a factor is present if it is always there, or the condition gives it, or some copy has the working part that makes it;
 *     it is active if present, every factor it needs is active and no factor that blocks it is.
 *   - the cell reads the highest level of its copies.
 * A rule marked `notModelled` is drawn but carries nothing: the honesty rule, as in Knock It Out.
 */
import { hashSeed, rng, roundOf, type RoundResult } from '../../engine';

// ── The spec ─────────────────────────────────────────────────────────────────

export interface BPart {
  id: string;
  label: string;
  /** Flipping the part ruins it only when it is oriented. */
  oriented?: boolean;
  note?: string;
}
export interface BFactor {
  id: string;
  label: string;
  /** Shorter name for the tag on a part (defaults to the label). */
  short?: string;
  /** The part that makes it: present if any copy has that part working. */
  madeBy?: string;
  /** Always there, in every condition (a supplied common factor). */
  always?: boolean;
  /** Factors that must be active for this one to be active, and factors that switch it off. */
  needs?: string[];
  blockedBy?: string[];
  note?: string;
}
export interface BCondition {
  id: string;
  label: string;
  /** The given factors (neither `always` nor `madeBy`) present in this condition. */
  has?: string[];
}
export interface BRule {
  effect: 'needs' | 'adds' | 'blocks';
  part: string;
  factor?: string;
  /** Rules of the same group are alternatives for `needs`: any one will do. */
  group?: string;
  by?: number;
  /** An order the rule asks for: this part must lie before / after the named one. */
  before?: string;
  after?: string;
  /** The base form of the verb for how the factor takes hold ("bind", "cut", "act on"). */
  verb?: string;
  /** What the rule does when it holds, in one plain sentence from the lecture. */
  say?: string;
  claim?: string;
  /** A line saying why this rule cannot be modelled. It is drawn dotted and carries nothing. */
  notModelled?: string;
}
export interface BEdit {
  kind: 'delete' | 'mutate' | 'move' | 'flip' | 'remove';
  part?: string;
  factor?: string;
  /** For `mutate`: only these factors fail to take hold. Otherwise nothing takes hold. */
  affects?: string[];
  /** For `move`: put the part straight after, or straight before, this one. */
  after?: string;
  before?: string;
}
export interface BChange extends Partial<BEdit> {
  id: string;
  /** An instruction: "Remove the switch". */
  label: string;
  /** Several edits at once, on one copy. */
  edits?: BEdit[];
}
export interface BreakSpec {
  story?: string;
  note?: string;
  parts: BPart[];
  factors: BFactor[];
  conditions: BCondition[];
  readout: { name: string; levels: string[]; base?: string };
  rules: BRule[];
  changes: BChange[];
}

export const editsOf = (c: BChange): BEdit[] => (c.edits?.length ? c.edits : [{ kind: c.kind as BEdit['kind'], part: c.part, factor: c.factor, affects: c.affects, after: c.after, before: c.before }]);

// ── One copy ─────────────────────────────────────────────────────────────────

export interface PartState { kind: 'ok' | 'deleted' | 'mutated' | 'flipped'; affects?: string[]; moved?: boolean }
export interface CopyState { order: string[]; parts: Record<string, PartState>; labels: string[] }

export function applyEdits(spec: BreakSpec, changes: readonly BChange[]): { copy: CopyState; removed: string[] } {
  const copy: CopyState = { order: spec.parts.map((p) => p.id), parts: Object.fromEntries(spec.parts.map((p) => [p.id, { kind: 'ok' } as PartState])), labels: changes.map((c) => c.label) };
  const removed: string[] = [];
  for (const c of changes) for (const e of editsOf(c)) {
    if (e.kind === 'remove') { if (e.factor) removed.push(e.factor); continue; }
    const id = e.part as string;
    const st = copy.parts[id];
    if (!st) continue;
    if (e.kind === 'delete') st.kind = 'deleted';
    else if (e.kind === 'mutate') { st.kind = 'mutated'; if (e.affects) st.affects = e.affects; }
    else if (e.kind === 'flip') { if (st.kind === 'ok') st.kind = 'flipped'; }
    else if (e.kind === 'move') {
      const rest = copy.order.filter((x) => x !== id);
      const anchor = e.after ?? e.before;
      const at = anchor ? rest.indexOf(anchor) : -1;
      if (at >= 0) rest.splice(e.after ? at + 1 : at, 0, id);
      else rest.push(id);
      copy.order = rest;
      st.moved = true;
    }
  }
  return { copy, removed };
}

const partOf = (spec: BreakSpec, id: string) => spec.parts.find((p) => p.id === id) as BPart;
const factorOf = (spec: BreakSpec, id: string) => spec.factors.find((f) => f.id === id) as BFactor;

/** Does the part still work for this factor on this copy? */
export function works(spec: BreakSpec, copy: CopyState, part: string, factor?: string): boolean {
  const st = copy.parts[part];
  if (!st) return false;
  if (st.kind === 'ok') return true;
  if (st.kind === 'deleted') return false;
  if (st.kind === 'flipped') return !partOf(spec, part).oriented;
  return st.affects ? !(factor && st.affects.includes(factor)) : false;
}

function orderKept(copy: CopyState, rule: BRule): boolean {
  const q = rule.before ?? rule.after;
  if (!q) return true;
  if (copy.parts[rule.part]?.kind === 'deleted' || copy.parts[q]?.kind === 'deleted') return false;
  const a = copy.order.indexOf(rule.part); const b = copy.order.indexOf(q);
  return rule.before ? a < b : a > b;
}

// ── One cell, one condition ──────────────────────────────────────────────────

export type FactorState = { state: 'absent' | 'off' | 'active'; reason: string };

export function factorStates(spec: BreakSpec, cond: BCondition, copies: readonly CopyState[], removed: readonly string[]): Map<string, FactorState> {
  const out = new Map<string, FactorState>();
  const compute = (id: string, depth: number): FactorState => {
    const have = out.get(id);
    if (have) return have;
    const f = factorOf(spec, id);
    let r: FactorState;
    if (depth > 12) r = { state: 'absent', reason: 'it depends on itself' };
    else if (removed.includes(id)) r = { state: 'absent', reason: 'it was taken away' };
    else if (f.always) r = { state: 'active', reason: '' };
    else if (f.madeBy) {
      const made = copies.some((c) => c.parts[f.madeBy as string]?.kind === 'ok');
      r = made ? { state: 'active', reason: '' } : { state: 'absent', reason: `no copy has a working ${soft(partOf(spec, f.madeBy).label)}` };
    } else r = (cond.has ?? []).includes(id) ? { state: 'active', reason: '' } : { state: 'absent', reason: 'not given in this condition' };
    if (r.state === 'active') {
      const lacking = (f.needs ?? []).find((n) => compute(n, depth + 1).state !== 'active');
      const blocker = (f.blockedBy ?? []).find((n) => compute(n, depth + 1).state === 'active');
      if (lacking) r = { state: 'off', reason: `it needs ${soft(factorOf(spec, lacking).label)}` };
      else if (blocker) r = { state: 'off', reason: `${soft(factorOf(spec, blocker).label)} switches it off` };
    }
    out.set(id, r);
    return r;
  };
  for (const f of spec.factors) compute(f.id, 0);
  return out;
}

export interface RuleStatus { holds: boolean; partWorks: boolean; orderKept: boolean; factor: FactorState | null }
export interface CopyEval { level: number; rules: RuleStatus[] }
export interface CellEval { factors: Map<string, FactorState>; copies: CopyEval[]; level: number }

export const topOf = (spec: BreakSpec) => spec.readout.levels.length - 1;
export const baseOf = (spec: BreakSpec) => (spec.readout.base === undefined ? topOf(spec) : Math.max(0, spec.readout.levels.indexOf(spec.readout.base)));

export function evalCell(spec: BreakSpec, cond: BCondition, copies: readonly CopyState[], removed: readonly string[]): CellEval {
  const factors = factorStates(spec, cond, copies, removed);
  const top = topOf(spec);
  const evals = copies.map((copy): CopyEval => {
    const rules = spec.rules.map((r): RuleStatus => {
      const fs = r.factor ? (factors.get(r.factor) as FactorState) : null;
      const pw = works(spec, copy, r.part, r.factor);
      const ok = orderKept(copy, r);
      return { holds: !r.notModelled && pw && ok && (!fs || fs.state === 'active'), partWorks: pw, orderKept: ok, factor: fs };
    });
    const groups = new Map<string, boolean>();
    spec.rules.forEach((r, i) => { if (r.effect === 'needs' && !r.notModelled) { const g = r.group ?? `#${i}`; groups.set(g, (groups.get(g) ?? false) || rules[i].holds); } });
    let level = [...groups.values()].every(Boolean) ? baseOf(spec) : 0;
    if (level > 0 || groups.size === 0) {
      spec.rules.forEach((r, i) => { if (r.effect === 'adds' && rules[i].holds) level += r.by ?? 1; });
      const cut = Math.max(0, ...spec.rules.map((r, i) => (r.effect === 'blocks' && rules[i].holds ? r.by ?? top : 0)));
      level = Math.max(0, Math.min(top, level - cut));
    }
    return { level, rules };
  });
  return { factors, copies: evals, level: Math.max(...evals.map((e) => e.level)) };
}

// ── Checking a spec ──────────────────────────────────────────────────────────

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const EFFECTS = ['needs', 'adds', 'blocks'];
const KINDS = ['delete', 'mutate', 'move', 'flip', 'remove'];
export const MAX_SPEC_CHARS = 4096;
const isStr = (x: unknown, max: number, min = 1): x is string => typeof x === 'string' && x.trim().length >= min && x.length <= max;

export function issues(input: BreakSpec): string[] {
  const out: string[] = [];
  const bad = (m: string) => { if (out.length < 14) out.push(m); };
  if (!input || typeof input !== 'object') return ['The spec is not an object.'];
  const spec = input;
  const parts = Array.isArray(spec.parts) ? spec.parts : [];
  const factors = Array.isArray(spec.factors) ? spec.factors : [];
  const conds = Array.isArray(spec.conditions) ? spec.conditions : [];
  const rules = Array.isArray(spec.rules) ? spec.rules : [];
  const changes = Array.isArray(spec.changes) ? spec.changes : [];
  if (parts.length < 2 || parts.length > 9) bad(`A construct has 2 to 9 parts; this one has ${parts.length}.`);
  const partIds = new Set<string>(); const factorIds = new Set<string>(); const condIds = new Set<string>();
  for (const [i, p] of parts.entries()) {
    if (!p || typeof p.id !== 'string' || !ID.test(p.id)) { bad(`Part ${i + 1}: \`id\` must be letters, digits, - or _, starting with a letter.`); continue; }
    if (partIds.has(p.id)) bad(`Part id "${p.id}" is used twice.`);
    partIds.add(p.id);
    if (!isStr(p.label, 24)) bad(`Part "${p.id}": \`label\` must be a short name, at most 24 characters.`);
    if (p.note !== undefined && !isStr(p.note, 200)) bad(`Part "${p.id}": \`note\` must be a sentence of at most 200 characters.`);
  }
  if (factors.length > 6) bad(`A construct has at most 6 factors; this one has ${factors.length}.`);
  for (const [i, f] of factors.entries()) {
    if (!f || typeof f.id !== 'string' || !ID.test(f.id)) { bad(`Factor ${i + 1}: \`id\` must be letters, digits, - or _, starting with a letter.`); continue; }
    if (factorIds.has(f.id)) bad(`Factor id "${f.id}" is used twice.`);
    factorIds.add(f.id);
    if (!isStr(f.label, 28)) bad(`Factor "${f.id}": \`label\` must be a short name, at most 28 characters.`);
    if (f.short !== undefined && !isStr(f.short, 12)) bad(`Factor "${f.id}": \`short\` must be at most 12 characters.`);
    if (f.madeBy !== undefined && !partIds.has(f.madeBy)) bad(`Factor "${f.id}": \`madeBy\` must be a part id.`);
    if (f.madeBy !== undefined && f.always) bad(`Factor "${f.id}" is both \`madeBy\` a part and \`always\` there: choose one.`);
    if (f.note !== undefined && !isStr(f.note, 200)) bad(`Factor "${f.id}": \`note\` must be a sentence of at most 200 characters.`);
  }
  for (const f of factors) for (const k of [...(f?.needs ?? []), ...(f?.blockedBy ?? [])]) if (!factorIds.has(k)) bad(`Factor "${f.id}" names "${k}" in \`needs\` or \`blockedBy\`, which is not a factor.`);
  if (conds.length < 1 || conds.length > 4) bad(`Give 1 to 4 conditions; this has ${conds.length}.`);
  for (const [i, c] of conds.entries()) {
    if (!c || typeof c.id !== 'string' || !ID.test(c.id)) { bad(`Condition ${i + 1}: \`id\` must be letters, digits, - or _.`); continue; }
    if (condIds.has(c.id)) bad(`Condition id "${c.id}" is used twice.`);
    condIds.add(c.id);
    if (!isStr(c.label, 40)) bad(`Condition "${c.id}": \`label\` must be a short phrase, at most 40 characters.`);
    for (const h of c.has ?? []) {
      const f = factors.find((x) => x?.id === h);
      if (!f) bad(`Condition "${c.id}" has "${h}", which is not a factor.`);
      else if (f.always || f.madeBy) bad(`Condition "${c.id}" has "${h}", which is always there or made by a part: only given factors are listed in \`has\`.`);
    }
  }
  const ro = spec.readout;
  if (!ro || !isStr(ro.name, 40) || !Array.isArray(ro.levels) || ro.levels.length < 2 || ro.levels.length > 4 || new Set(ro.levels).size !== ro.levels.length || ro.levels.some((l) => !isStr(l, 16))) bad('`readout` needs a `name` and 2 to 4 different `levels` (lowest first, at most 16 characters each).');
  else if (ro.base !== undefined && !ro.levels.includes(ro.base)) bad('`readout.base` must be one of the levels.');
  if (rules.length < 1 || rules.length > 8) bad(`Give 1 to 8 rules; this has ${rules.length}.`);
  for (const [i, r] of rules.entries()) {
    const where = `Rule ${i + 1}`;
    if (!r || !EFFECTS.includes(r.effect)) { bad(`${where}: \`effect\` must be needs, adds or blocks.`); continue; }
    if (!partIds.has(r.part)) bad(`${where}: \`part\` must be a part id.`);
    if (r.factor !== undefined && !factorIds.has(r.factor)) bad(`${where}: \`factor\` must be a factor id.`);
    if (r.effect !== 'needs' && r.factor === undefined) bad(`${where}: an "${r.effect}" rule needs a \`factor\`.`);
    for (const q of [r.before, r.after]) if (q !== undefined && (!partIds.has(q) || q === r.part)) bad(`${where}: \`before\` and \`after\` must name another part.`);
    if (r.before !== undefined && r.after !== undefined) bad(`${where}: give \`before\` or \`after\`, not both.`);
    if (r.by !== undefined && !(Number.isInteger(r.by) && r.by >= 1 && r.by <= 3)) bad(`${where}: \`by\` must be 1, 2 or 3.`);
    if (r.group !== undefined && r.effect !== 'needs') bad(`${where}: \`group\` is only for "needs" rules.`);
    if (r.say !== undefined && !isStr(r.say, 170)) bad(`${where}: \`say\` must be one plain sentence of at most 170 characters.`);
    if (r.claim !== undefined && !isStr(r.claim, 16)) bad(`${where}: \`claim\` must be a short point id such as "p61".`);
    if (r.verb !== undefined && !isStr(r.verb, 24)) bad(`${where}: \`verb\` must be the base form of a verb, such as "bind".`);
    if (r.notModelled !== undefined) {
      if (!isStr(r.notModelled, 220, 12)) bad(`${where}: \`notModelled\` must say in a sentence why this cannot be modelled (at most 220 characters).`);
      if (r.factor === undefined) bad(`${where}: a \`notModelled\` rule needs a \`factor\` to draw the dotted line from.`);
    }
  }
  if (changes.length < 2 || changes.length > 10) bad(`Offer 2 to 10 changes; this has ${changes.length}.`);
  const chIds = new Set<string>();
  for (const [i, c] of changes.entries()) {
    const where = `Change ${i + 1}`;
    if (!c || typeof c.id !== 'string' || !ID.test(c.id)) { bad(`${where}: \`id\` must be letters, digits, - or _.`); continue; }
    if (chIds.has(c.id)) bad(`Change id "${c.id}" is used twice.`);
    chIds.add(c.id);
    if (!isStr(c.label, 70, 6)) bad(`${where}: \`label\` must be an instruction such as "Remove the switch" (6 to 70 characters).`);
    const edits = c.edits?.length ? c.edits : [c as BEdit];
    if (edits.length > 3) bad(`${where}: at most 3 edits.`);
    for (const e of edits) {
      if (!e || !KINDS.includes(e.kind as string)) { bad(`${where}: \`kind\` must be delete, mutate, move, flip or remove.`); continue; }
      if (e.kind === 'remove') { if (!e.factor || !factorIds.has(e.factor)) bad(`${where}: "remove" needs a \`factor\` id.`); continue; }
      if (!e.part || !partIds.has(e.part)) { bad(`${where}: \`part\` must be a part id.`); continue; }
      if (e.kind === 'move' && (!(e.after ?? e.before) || !partIds.has((e.after ?? e.before) as string) || (e.after ?? e.before) === e.part)) bad(`${where}: "move" needs \`after\` or \`before\` naming another part.`);
      if (e.kind === 'mutate' && e.affects !== undefined && (!Array.isArray(e.affects) || !e.affects.length || e.affects.some((a) => !factorIds.has(a)))) bad(`${where}: \`affects\` must list factor ids.`);
    }
  }
  if (out.length) return out;

  const text = JSON.stringify(spec);
  if (text.length > MAX_SPEC_CHARS) { bad(`The spec is ${text.length} characters; the catalogue allows ${MAX_SPEC_CHARS}. Shorten sentences or notes.`); return out; }
  // Factors may not depend on themselves.
  for (const f of factors) {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (seen.has(id)) return id === f.id;
      seen.add(id);
      const g = factors.find((x) => x.id === id) as BFactor;
      return [...(g.needs ?? []), ...(g.blockedBy ?? [])].some(walk);
    };
    if ([...(f.needs ?? []), ...(f.blockedBy ?? [])].some(walk)) bad(`Factor "${f.id}" depends on itself through \`needs\` or \`blockedBy\`.`);
  }
  if (out.length) return out;
  const normal = spec.conditions.map((c) => evalCell(spec, c, [applyEdits(spec, []).copy], []).level);
  if (normal.every((l) => l === 0)) bad('The normal construct reads the lowest level in every condition, so there is nothing to break: check the rules.');
  if (!rules.some((r) => r.effect === 'needs')) bad('Give at least one "needs" rule (a part the readout cannot do without).');
  const moving = changes.filter((c) => spec.conditions.some((k, j) => evalCell(spec, k, [applyEdits(spec, [c]).copy], applyEdits(spec, [c]).removed).level !== normal[j]));
  if (moving.length < Math.ceil(changes.length / 2)) bad('At least half of the changes should alter the readout in some condition; most of these change nothing.');
  if (!out.length) {
    for (let rung = 0; rung < 3; rung++) for (let k = 0; k < 12; k++) {
      try { prepare(spec, `check${k}:${k % 3}`, rung); } catch (error) { bad(`Could not set a question at rung ${rung}: ${(error as Error).message}`); break; }
    }
  }
  return out;
}

// ── Setting a question ───────────────────────────────────────────────────────

export interface BreakAttempt { levels: Record<string, number>; complement?: boolean }

export interface BreakTask {
  spec: BreakSpec;
  rung: number;
  copies: CopyState[];
  removed: string[];
  /** The changes made, one per copy (a single change in one-copy rounds). */
  changes: BChange[];
  asked: BCondition[];
  /** The cell's level in each asked condition, and what it would be with nothing changed. */
  truth: number[];
  normal: number[];
  /** Rung 2 only: do the two copies together read as normal in every asked condition? */
  complement?: boolean;
  announce: string;
  question: string;
}

const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
/** A label for the middle of a sentence: lower-case the first letter unless the name is an acronym. */
export const soft = (s: string) => (/^\S*[A-Z]/.test(s.slice(1)) || /^\S*\d/.test(s) ? s : lowerFirst(s));
/** "the switch", but "step 2" and "AB-X" need no article when they are names. */
export const the = (label: string) => (/\d$/.test(label) || /^[A-Z]+-[A-Z0-9]+$/.test(label) ? soft(label) : `the ${soft(label)}`);
/** Capitalise the start of a sentence, unless the name begins in lower case on purpose (a name such as pH-7). */
export const startUpper = (s: string) => (/^[a-z]\S*[A-Z0-9]/.test(s) ? s : upperFirst(s));
const stripStop = (s: string) => s.replace(/[.\s]+$/, '');
export const levelName = (spec: BreakSpec, n: number) => spec.readout.levels[n];

const wholeNormal = (spec: BreakSpec, conds: readonly BCondition[], n: number) => conds.map((c) => evalCell(spec, c, Array.from({ length: n }, () => applyEdits(spec, []).copy), []).level);
/** The cell's levels when each copy has the change given for it (null for none). */
export function cellLevels(spec: BreakSpec, conds: readonly BCondition[], perCopy: ReadonlyArray<BChange | null>): number[] {
  const built = perCopy.map((c) => applyEdits(spec, c ? [c] : []));
  const removed = built.flatMap((b) => b.removed);
  return conds.map((c) => evalCell(spec, c, built.map((b) => b.copy), removed).level);
}
const differs = (a: readonly number[], b: readonly number[]) => a.some((v, i) => v !== b[i]);
const partChange = (c: BChange) => editsOf(c).every((e) => e.kind !== 'remove');

function shuffled<T>(list: readonly T[], rand: () => number): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function prepare(spec: BreakSpec, seed: string, rung: number): BreakTask {
  const round = roundOf(seed);
  const rand = rng(seed.replace(/:\d+$/, ''));
  const conds = spec.conditions;
  const normalFor = (n: number, cs: readonly BCondition[]) => wholeNormal(spec, cs, n);

  const make = (changes: BChange[], asked: BCondition[], copiesN: number, announce: string, question: string): BreakTask => {
    const perCopy: Array<BChange | null> = copiesN === 1 ? [changes[0]] : changes;
    const built = perCopy.map((c) => applyEdits(spec, c ? [c] : []));
    const removed = built.flatMap((b) => b.removed);
    const truth = cellLevels(spec, asked, perCopy);
    const normal = normalFor(copiesN, asked);
    const task: BreakTask = { spec, rung, copies: built.map((b) => b.copy), removed, changes, asked, truth, normal, announce, question };
    if (copiesN === 2) task.complement = !differs(truth, normal);
    return task;
  };

  // Pairs (rung 2): one change on each copy, preferring a mix of rescued and not rescued.
  if (rung >= 2) {
    const usable = spec.changes.filter(partChange);
    const found: Array<{ pair: [BChange, BChange]; comp: boolean; both: boolean; same: boolean }> = [];
    const alone = (c: BChange) => differs(cellLevels(spec, conds, [c]), normalFor(1, conds));
    for (let i = 0; i < usable.length; i++) for (let j = i; j < usable.length; j++) {
      const a = usable[i]; const b = usable[j];
      const same = i === j;
      if (!same && JSON.stringify(editsOf(a)) === JSON.stringify(editsOf(b))) continue;
      const both = alone(a) && alone(b);
      if (!both && !(alone(a) || alone(b))) continue;
      found.push({ pair: [a, b], comp: !differs(cellLevels(spec, conds, [a, b]), normalFor(2, conds)), both, same });
    }
    if (found.length) {
      const wantRescue = round % 2 === 1;
      const tiers = [
        found.filter((f) => f.both && f.comp === wantRescue && !f.same), found.filter((f) => f.comp === wantRescue && !f.same),
        found.filter((f) => f.both && f.comp === wantRescue), found.filter((f) => f.comp === wantRescue), found.filter((f) => f.both), found,
      ];
      const pool = shuffled(tiers.find((t) => t.length) as typeof found, rand);
      const pick = pool[round % pool.length];
      const pair = rand() < 0.5 ? pick.pair : ([pick.pair[1], pick.pair[0]] as [BChange, BChange]);
      return make(pair, conds, 2,
        `Two copies in one cell. Copy 1: ${lowerFirst(stripStop(pair[0].label))}. Copy 2: ${lowerFirst(stripStop(pair[1].label))}.`,
        'What does the cell read in each condition, and do the two copies complement each other (does the cell read as normal)? Choose, then press Run.');
    }
  }

  const moves = (c: BChange, cs: readonly BCondition[]) => differs(cellLevels(spec, cs, [c]), normalFor(1, cs));
  if (rung === 0) {
    const pairs = spec.changes.flatMap((c) => conds.map((k) => ({ c, k, m: moves(c, [k]) })));
    const loud = pairs.filter((p) => p.m); const quiet = pairs.filter((p) => !p.m);
    const list = round % 3 === 2 && quiet.length ? quiet : loud.length ? loud : quiet;
    const pick = shuffled(list, rand)[round % list.length];
    return make([pick.c], [pick.k], 1, `${upperFirst(stripStop(pick.c.label))}.`, `What is the ${spec.readout.name}${conds.length > 1 ? ` in the “${pick.k.label}” condition` : ''}? Choose, then press Run and watch the factors arrive.`);
  }
  const loud = spec.changes.filter((c) => moves(c, conds)); const quiet = spec.changes.filter((c) => !moves(c, conds));
  const list = round % 3 === 2 && quiet.length ? quiet : loud.length ? loud : quiet;
  const pick = shuffled(list, rand)[round % list.length];
  return make([pick], conds, 1, `${upperFirst(stripStop(pick.label))}.`, `What is the ${spec.readout.name}${conds.length > 1 ? ' in each condition' : ''}? Choose, then press Run and watch the factors arrive.`);
}

// ── Saying why ───────────────────────────────────────────────────────────────

const third = (verb: string) => verb.replace(/^(\S+)/, (w) => (/(s|sh|ch|x|z)$/.test(w) ? `${w}es` : `${w}s`));
/** The verb in the form a subject needs: plural when the name is a list or ends in s. */
export const agree = (label: string, verb: string) => (/and/i.test(label) || /[^s]s$/.test(label) ? verb : third(verb));
export const stateWord = (st: PartState) => (st.kind === 'deleted' ? 'deleted' : st.kind === 'mutated' ? 'changed' : st.kind === 'flipped' ? 'flipped' : 'moved');
export const verbOf = (r: BRule) => r.verb ?? 'act on';
export const normalCopy = (spec: BreakSpec) => applyEdits(spec, []).copy;
const plainState = (st: PartState) => st.kind !== 'ok' || !!st.moved;

/** What changed in the rules between the normal construct and this cell, in one condition: cell-wide clauses, then one list per copy. */
export function differences(task: BreakTask, k: number): { cell: string[]; copies: string[][] } {
  const { spec } = task;
  const cond = task.asked[k];
  const was = evalCell(spec, cond, task.copies.map(() => normalCopy(spec)), []);
  const now = evalCell(spec, cond, task.copies, task.removed);
  const cell: string[] = [];
  const copies: string[][] = task.copies.map(() => []);
  task.copies.forEach((copy, ci) => {
    spec.rules.forEach((r, i) => {
      if (r.notModelled) return;
      const a = was.copies[ci].rules[i]; const b = now.copies[ci].rules[i];
      if (a.holds === b.holds) return;
      const p = partOf(spec, r.part);
      const f = r.factor ? factorOf(spec, r.factor) : null;
      const st = copy.parts[r.part];
      const lead = `with ${the(p.label)} ${stateWord(st)}`;
      const put = (list: string[], text: string) => { if (!list.includes(text)) list.push(text); };
      if (!b.holds) {
        if (f && b.factor && b.factor.state !== 'active') put(cell, `${soft(f.label)} is ${b.factor.state === 'absent' ? 'absent' : 'switched off'} (${b.factor.reason})`);
        else if (!b.partWorks) put(copies[ci], f ? `${lead}, ${soft(f.label)} cannot ${verbOf(r)} it` : `${lead}, the readout loses something it needs`);
        else put(copies[ci], `${lead}, it no longer lies ${r.before ? 'before' : 'after'} ${the(partOf(spec, (r.before ?? r.after) as string).label)}`);
      } else put(copies[ci], `${soft(f?.label ?? p.label)} now ${f ? agree(f.label, verbOf(r)) : 'is needed on'} ${the(p.label)}`);
    });
  });
  return { cell, copies };
}

/** Factors that a changed part makes and that the cell still has, thanks to another copy. */
function rescued(task: BreakTask, k: number): string[][] {
  const { spec } = task;
  const now = evalCell(spec, task.asked[k], task.copies, task.removed);
  const out: string[][] = task.copies.map(() => []);
  task.copies.forEach((copy, ci) => {
    for (const f of spec.factors) {
      if (!f.madeBy || copy.parts[f.madeBy].kind === 'ok') continue;
      const j = task.copies.findIndex((c) => c.parts[f.madeBy as string].kind === 'ok');
      if (j >= 0 && now.factors.get(f.id)?.state !== 'absent') out[ci].push(`${soft(f.label)} still reaches it, made from ${the(partOf(spec, f.madeBy).label)} on copy ${j + 1}`);
    }
  });
  return out;
}

/** When nothing the readout depends on changed: say what kept the changed part from mattering. */
function whyInert(task: BreakTask, k: number): string {
  const { spec } = task;
  const many = task.copies.length > 1;
  const now = evalCell(spec, task.asked[k], task.copies, task.removed);
  const was = evalCell(spec, task.asked[k], task.copies.map(() => normalCopy(spec)), task.removed);
  const bits: string[] = [];
  const none = evalCell(spec, task.asked[k], task.copies.map(() => normalCopy(spec)), []);
  for (const fid of task.removed) {
    const fs = none.factors.get(fid);
    if (fs && fs.state !== 'active') bits.push(`${soft(factorOf(spec, fid).label)} is ${fs.state === 'absent' ? 'absent' : 'off'} here anyway (${fs.reason})`);
    else if (!spec.rules.some((r) => r.factor === fid)) bits.push(`the readout does not depend on ${soft(factorOf(spec, fid).label)}`);
  }
  const anyway = (fid: string): string | null => {
    const fs = was.factors.get(fid);
    return fs && fs.state !== 'active' ? `${soft(factorOf(spec, fid).label)} is ${fs.state === 'absent' ? 'absent' : 'off'} here anyway (${fs.reason})` : null;
  };
  task.copies.forEach((copy, ci) => {
    for (const [id, st] of Object.entries(copy.parts)) {
      if (!plainState(st)) continue;
      const p = partOf(spec, id);
      const name = `${many ? `on copy ${ci + 1}, ` : ''}${the(p.label)}`;
      const direct = spec.rules.filter((r) => r.part === id && !r.notModelled);
      const makes = spec.factors.filter((f) => f.madeBy === id);
      if (!direct.length && !makes.length) { bits.push(`${name} is not something the readout depends on`); continue; }
      for (const r of direct) {
        const idle = r.factor ? anyway(r.factor) : null;
        if (idle) bits.push(idle);
        else if (works(spec, copy, id, r.factor) && orderKept(copy, r)) bits.push(`${name} works just as well ${st.kind === 'flipped' ? 'flipped' : st.moved ? 'where it now is' : 'with this change'}`);
        else bits.push(`${name} is ${stateWord(st)}, but nothing that would act on it is active here`);
        break;
      }
      for (const f of makes) {
        const idle = anyway(f.id);
        if (idle) bits.push(idle);
        else if (now.factors.get(f.id)?.state === 'active') bits.push(`${soft(f.label)} is still made`);
      }
    }
  });
  return [...new Set(bits)].slice(0, 2).join('; ');
}

/** The condition worth explaining: where the cell departs from normal, else where one of the changes would have. */
function focusCond(task: BreakTask): number {
  const { spec, asked, truth, normal } = task;
  const first = truth.findIndex((t, i) => t !== normal[i]);
  if (first >= 0) return first;
  for (let i = 0; i < asked.length; i++) {
    if (task.changes.some((c) => cellLevels(spec, [asked[i]], [c])[0] !== normal[i])) return i;
  }
  return Math.max(0, normal.indexOf(Math.max(...normal)));
}

/** ", but X still Ys Z": the rules in the same group that keep the reading up when one route fails. */
function holdersFor(task: BreakTask, k: number): string {
  const { spec } = task;
  if (task.copies.length > 1 || task.truth[k] !== task.normal[k]) return '';
  const now = evalCell(spec, task.asked[k], task.copies, task.removed);
  const bits: string[] = [];
  spec.rules.forEach((r, i) => {
    if (r.effect !== 'needs' || !r.group || r.notModelled || !now.copies[0].rules[i].holds) return;
    const failing = spec.rules.some((q, j) => j !== i && q.group === r.group && !now.copies[0].rules[j].holds);
    if (failing) bits.push(r.factor ? `${soft(factorOf(spec, r.factor).label)} still ${agree(factorOf(spec, r.factor).label, verbOf(r))} ${the(partOf(spec, r.part).label)}` : `${the(partOf(spec, r.part).label)} still works`);
  });
  return bits.length ? `, but ${bits.slice(0, 2).join(' and ')}` : '';
}

export function whySentence(task: BreakTask): string {
  const { spec, asked, truth, normal } = task;
  const k = focusCond(task);
  const where = asked.length > 1 ? ` in the “${asked[k].label}” condition` : '';
  const diffs = differences(task, k);
  const parts: string[] = [];
  const reading = (verb: string) => `so the ${spec.readout.name} ${verb} ${levelName(spec, truth[k])}${where}`;
  if (task.copies.length === 1) {
    const clauses = [...diffs.cell, ...diffs.copies[0]].slice(0, 3);
    parts.push(clauses.length
      ? `${startUpper(clauses.map((c, i) => (i ? lowerFirst(c) : c)).join('; '))}${holdersFor(task, k)}, ${reading(holdersFor(task, k) ? 'stays' : 'is')}`
      : `${startUpper(whyInert(task, k) || 'Nothing the readout depends on is touched')}, ${reading('stays')}`);
  } else {
    const ev = evalCell(spec, asked[k], task.copies, task.removed);
    const saved = rescued(task, k);
    const each = task.copies.map((_, ci) => {
      const own = [...diffs.copies[ci], ...saved[ci]];
      const lvl = levelName(spec, ev.copies[ci].level);
      return own.length ? `copy ${ci + 1}: ${own.join('; ')}, so it reads ${lvl}` : `copy ${ci + 1} is unaffected, so it reads ${lvl}`;
    });
    const lead = diffs.cell.length ? `${startUpper(diffs.cell.join('; '))}. ` : '';
    parts.push(`${lead}${each.map(startUpper).join('. ')}. The cell reads the higher of its copies: ${levelName(spec, truth[k])}${where}`);
    const inert = task.changes.map((c) => !differs(cellLevels(spec, asked, [c]), normal));
    if (task.complement && inert.some(Boolean)) parts.push(`The two copies complement: the change on copy ${inert.indexOf(true) + 1} makes no difference, so that copy still reads as normal`);
    else if (task.complement && saved.some((l) => l.length)) parts.push('The two copies complement: a factor reaches both copies, so what one copy cannot make the other still supplies, while each part only works on its own copy');
    else if (task.complement) parts.push('The two copies complement: in each condition one of them is still complete, and each part works only on its own copy');
    else parts.push('The two copies do not complement: a part works only on its own copy, so a change in it is not rescued by the other copy, and the cell does not read as normal');
  }
  if (task.copies.length === 1 && asked.length > 1) {
    const same = asked.filter((_, i) => i !== k && truth[i] === normal[i]).map((c) => c.label);
    if (truth.some((t, i) => t !== normal[i]) && same.length && same.length === asked.length - 1) parts.push(`In the other condition${same.length > 1 ? 's' : ''} (${same.map((c) => `“${c}”`).join(', ')}) it reads as normal`);
  }
  return `${parts.join('. ')}.`.replace(/\.\./g, '.');
}

// ── Reading an attempt ───────────────────────────────────────────────────────

export const conditionWords = (task: BreakTask) => task.asked.map((c, i) => `${task.asked.length > 1 ? `${c.label}: ` : ''}${levelName(task.spec, task.truth[i])}`).join('; ');

export function result(task: BreakTask, attempt: BreakAttempt): RoundResult {
  const { spec, asked, truth, normal } = task;
  const given = asked.map((c) => attempt.levels[c.id]);
  if (given.some((g) => typeof g !== 'number')) throw new Error('A round needs a level for every condition.');
  if (task.copies.length > 1 && typeof attempt.complement !== 'boolean') throw new Error('A two-copy round needs a complement answer.');
  const wrong = asked.map((_, i) => i).filter((i) => given[i] !== truth[i]);
  const compWrong = task.copies.length > 1 && attempt.complement !== task.complement;
  const met = wrong.length === 0 && !compWrong;
  const cond = task.changes.map((c) => lowerFirst(stripStop(c.label))).join(' and ');
  const tail = task.copies.length > 1 ? `; the two copies ${task.complement ? 'complement' : 'do not complement'}` : '';
  let misconception: string | undefined;
  if (!met) {
    if (compWrong) misconception = task.complement ? 'Expects the copies to fail together where a factor reaches both copies' : 'Expects the other copy to rescue a change that works only on its own copy';
    else {
      const lostIt = wrong.filter((i) => given[i] === normal[i] && truth[i] !== normal[i]);
      const invented = wrong.filter((i) => given[i] !== normal[i] && truth[i] === normal[i]);
      const reversed = wrong.filter((i) => (given[i] - normal[i]) * (truth[i] - normal[i]) < 0);
      if (reversed.length) misconception = 'Reverses the effect: expects a loss where removing a block lets the readout rise, or the other way round';
      else if (lostIt.length) misconception = 'Expects no effect where the change does reach the readout';
      else if (invented.length) misconception = 'Expects an effect where nothing the readout depends on is touched';
    }
  }
  return { met, label: `Predicts the ${spec.readout.name} when ${cond}: ${conditionWords(task)}${tail}`, why: whySentence(task), misconception };
}

export const hashOf = hashSeed;
