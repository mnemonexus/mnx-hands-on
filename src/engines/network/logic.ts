/**
 * Knock It Out, the logic: no DOM, no subject. A spec is a small cause and effect network. The engine works out the
 * steady state before and after a change by passing the change along the arrows, one hop at a time, so an answer can
 * never be typed in wrongly. Every sentence a student reads comes from the spec's own reasons, and nothing about any
 * subject is written here.
 *
 * The rules, in plain words. A node has a level: off, low, normal or high (0 to 3).
 *   - A node with no "activates" arrows into it holds the level the spec gives it (normal if none): it is on until blocked.
 *   - Otherwise its drive is the lowest of its activators ("needs all") or the highest ("needs any").
 *   - Its blockers take away: the strongest blocker's level is subtracted from the drive, never below off.
 *   - A change clamps a node: removed or blocked means off, "add more" means high (or the level the spec gives).
 *   - An arrow marked notModelled is drawn but carries nothing. That is the honesty rule: the model flattens real
 *     systems, so it says where.
 *
 * Rungs: 0 is one change with the arrow signs shown, 1 hides the signs, 2 is a double change, or runs backwards (here is
 * the result, which change gives it).
 */
import { clip } from '../../report';
import { hashSeed, rng, roundOf, type RoundResult } from '../../engine';

// ── The spec ─────────────────────────────────────────────────────────────────

export const LEVEL_NAMES = ['off', 'low', 'normal', 'high'] as const;
export type Level = 0 | 1 | 2 | 3;
export type LevelName = (typeof LEVEL_NAMES)[number];
export type Dir = 'down' | 'same' | 'up';

export interface NetNode {
  id: string;
  label: string;
  /** Position on the picture, as a share of its width and height (4 to 96). */
  x: number;
  y: number;
  /** For two or more activators: all of them are needed, or any one will do. */
  needs?: 'all' | 'any';
  /** The level a node with no activators holds. Normal if not given. */
  level?: LevelName;
  /** An honest word about what this node leaves out. Shown when the node is touched. */
  note?: string;
}
export interface NetEdge {
  from: string;
  to: string;
  /** "+" the source activates the target, "-" it blocks it. May be left out only on a notModelled edge. */
  sign?: '+' | '-';
  /** One plain sentence, shown as the change crosses this arrow. */
  reason?: string;
  /** Where the lecture says it: a point id such as "p61". */
  claim?: string;
  /** A line saying why this arrow cannot be modelled. The arrow is drawn dotted and carries nothing. */
  notModelled?: string;
}
export interface NetPerturbation {
  id: string;
  node: string;
  kind: 'remove' | 'block' | 'more';
  /** What is done, as an instruction: "Remove the supply line". */
  label: string;
  /** Overrides the level the change sets (otherwise off for remove and block, high for more). */
  level?: LevelName;
  /** The outputs to mark for this change (otherwise the spec's). */
  outputs?: string[];
  /** The study items working out this change tests. A run meets only some changes, so this is kept per change. */
  covers?: string[];
}
export interface NetSpec {
  nodes: NetNode[];
  edges: NetEdge[];
  perturbations: NetPerturbation[];
  /** The nodes to mark: the student says what happens to each. */
  outputs: string[];
  /** One line saying what the picture is of. */
  story?: string;
  /** An assumption that matters, shown under the picture. */
  note?: string;
}

// ── The compiled network ─────────────────────────────────────────────────────

export interface Net {
  spec: NetSpec;
  index: Map<string, number>;
  /** For each node: the nodes that activate it and the nodes that block it (modelled arrows only), and the arrows. */
  acts: number[][];
  blocks: number[][];
  actEdges: number[][];
  blockEdges: number[][];
  needs: Array<'all' | 'any'>;
  base: Level[];
}

const lvl = (name: LevelName | undefined): Level => (name === undefined ? 2 : (Math.max(0, LEVEL_NAMES.indexOf(name)) as Level));

export function buildNet(spec: NetSpec): Net {
  const index = new Map(spec.nodes.map((n, i) => [n.id, i]));
  const n = spec.nodes.length;
  const acts: number[][] = Array.from({ length: n }, () => []);
  const blocks: number[][] = Array.from({ length: n }, () => []);
  const actEdges: number[][] = Array.from({ length: n }, () => []);
  const blockEdges: number[][] = Array.from({ length: n }, () => []);
  spec.edges.forEach((e, i) => {
    if (e.notModelled) return;
    const a = index.get(e.from) as number;
    const b = index.get(e.to) as number;
    if (e.sign === '-') { blocks[b].push(a); blockEdges[b].push(i); } else { acts[b].push(a); actEdges[b].push(i); }
  });
  return {
    spec, index, acts, blocks, actEdges, blockEdges,
    needs: spec.nodes.map((node) => node.needs ?? 'all'),
    base: spec.nodes.map((node) => lvl(node.level)),
  };
}

/** The level of one node given the levels of the others. */
function drive(net: Net, i: number, state: readonly Level[]): Level {
  let a: number;
  if (net.acts[i].length === 0) a = net.base[i];
  else if (net.needs[i] === 'any') a = Math.max(...net.acts[i].map((k) => state[k]));
  else a = Math.min(...net.acts[i].map((k) => state[k]));
  const b = net.blocks[i].length ? Math.max(...net.blocks[i].map((k) => state[k])) : 0;
  return Math.max(0, a - b) as Level;
}

/** One step of the whole network at once, with some nodes held where a change has put them. */
export function update(net: Net, state: readonly Level[], clamp: ReadonlyMap<number, Level>): Level[] {
  return state.map((_, i) => (clamp.has(i) ? (clamp.get(i) as Level) : drive(net, i, state)));
}

const MAX_STEPS = 40;

export interface Settled { ok: boolean; state: Level[]; why: string }

/**
 * The steady state under a change, found from several different starts. It settles when every start comes to rest in the
 * same place. A network that keeps changing, or that rests in different places from different starts, is refused.
 */
export function steady(net: Net, clamp: ReadonlyMap<number, Level> = new Map()): Settled {
  const n = net.spec.nodes.length;
  const starts: Level[][] = [0, 1, 2, 3].map((v) => Array<Level>(n).fill(v as Level)).concat([net.base.slice()]);
  let found: Level[] | null = null;
  for (const start of starts) {
    let state = update(net, start, clamp);
    const seen = new Set<string>();
    let rested = false;
    for (let k = 0; k < MAX_STEPS; k++) {
      const next = update(net, state, clamp);
      if (next.every((v, i) => v === state[i])) { rested = true; break; }
      const key = next.join('');
      if (seen.has(key)) break;
      seen.add(key);
      state = next;
    }
    if (!rested) return { ok: false, state, why: 'keeps changing' };
    if (found && found.some((v, i) => v !== state[i])) return { ok: false, state, why: 'rests in different places depending on where it starts' };
    found = state;
  }
  return { ok: true, state: found as Level[], why: '' };
}

export interface Hop { node: number; from: Level; to: Level; /** The arrows the change came along. */ via: number[] }
export interface Step { hops: Hop[] }

/** The change passed along, one hop at a time, from the steady state before. */
export function propagate(net: Net, before: readonly Level[], clamp: ReadonlyMap<number, Level>): { steps: Step[]; after: Level[]; settled: boolean } {
  const steps: Step[] = [];
  let state = before.slice() as Level[];
  let changed: Set<number> = new Set();
  // Step 1: the change itself.
  const first: Hop[] = [];
  for (const [node, to] of clamp) if (state[node] !== to) first.push({ node, from: state[node], to, via: [] });
  if (first.length) { steps.push({ hops: first }); first.forEach((h) => { state[h.node] = h.to; changed.add(h.node); }); }
  for (let k = 0; k < MAX_STEPS; k++) {
    const next = update(net, state, clamp);
    const hops: Hop[] = [];
    const now = new Set<number>();
    next.forEach((to, node) => {
      if (to === state[node]) return;
      const via = [...net.actEdges[node].filter((_, j) => changed.has(net.acts[node][j])), ...net.blockEdges[node].filter((_, j) => changed.has(net.blocks[node][j]))];
      hops.push({ node, from: state[node], to, via });
      now.add(node);
    });
    if (!hops.length) return { steps, after: state, settled: true };
    steps.push({ hops });
    state = next;
    changed = now;
  }
  return { steps, after: state, settled: false };
}

export const dirOf = (from: number, to: number): Dir => (to > from ? 'up' : to < from ? 'down' : 'same');
const DIR_WORDS: Record<Dir, string> = { down: 'falls', same: 'stays about the same', up: 'rises' };
export const dirWord = (d: Dir) => DIR_WORDS[d];
export const levelName = (v: number) => LEVEL_NAMES[v];
export const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
export const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The level a change sets. */
export function clampLevel(p: NetPerturbation): Level {
  if (p.level) return lvl(p.level);
  return p.kind === 'more' ? 3 : 0;
}

export function clampOf(net: Net, ps: readonly NetPerturbation[]): Map<number, Level> {
  return new Map(ps.map((p) => [net.index.get(p.node) as number, clampLevel(p)]));
}

// ── Checking a spec ──────────────────────────────────────────────────────────

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const KINDS = ['remove', 'block', 'more'];
export const MAX_SPEC_CHARS = 4096;
export const outputsOf = (spec: NetSpec, p: NetPerturbation) => p.outputs ?? spec.outputs;

/** Segment against a box, in percentage space, for the "arrow runs behind a node" check. */
function crosses(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, hw: number, hh: number): boolean {
  for (let t = 0.12; t <= 0.88; t += 0.04) {
    const x = ax + (bx - ax) * t; const y = ay + (by - ay) * t;
    if (Math.abs(x - cx) < hw && Math.abs(y - cy) < hh) return true;
  }
  return false;
}

export function issues(input: NetSpec): string[] {
  const out: string[] = [];
  const bad = (m: string) => { if (out.length < 14) out.push(m); };
  if (!input || typeof input !== 'object') return ['The spec is not an object.'];
  const spec = input;
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  const perts = Array.isArray(spec.perturbations) ? spec.perturbations : [];
  if (nodes.length < 4 || nodes.length > 9) bad(`A network has 4 to 9 nodes; this one has ${nodes.length}.`);
  const ids = new Set<string>();
  for (const [i, n] of nodes.entries()) {
    const where = `Node ${i + 1}`;
    if (!n || typeof n.id !== 'string' || !ID.test(n.id)) { bad(`${where}: \`id\` must be letters, digits, - or _, starting with a letter.`); continue; }
    if (ids.has(n.id)) bad(`${where}: id "${n.id}" is used twice.`);
    ids.add(n.id);
    if (typeof n.label !== 'string' || !n.label.trim() || n.label.length > 30) bad(`Node "${n.id}": \`label\` must be a short name, at most 30 characters.`);
    if (!(typeof n.x === 'number' && typeof n.y === 'number' && n.x >= 4 && n.x <= 96 && n.y >= 4 && n.y <= 96)) bad(`Node "${n.id}": \`x\` and \`y\` must be numbers from 4 to 96.`);
    if (n.needs !== undefined && n.needs !== 'all' && n.needs !== 'any') bad(`Node "${n.id}": \`needs\` must be "all" or "any".`);
    if (n.level !== undefined && !LEVEL_NAMES.includes(n.level)) bad(`Node "${n.id}": \`level\` must be off, low, normal or high.`);
    if (n.note !== undefined && (typeof n.note !== 'string' || n.note.length > 200)) bad(`Node "${n.id}": \`note\` must be a sentence of at most 200 characters.`);
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]; const b = nodes[j];
    if (a && b && Math.abs(a.x - b.x) < 22 && Math.abs(a.y - b.y) < 19) bad(`Nodes "${a.id}" and "${b.id}" sit on top of each other: keep them 22 apart across or 19 apart down.`);
  }
  const pairs = new Set<string>();
  for (const [i, e] of edges.entries()) {
    const where = `Arrow ${i + 1}`;
    if (!e || !ids.has(e.from) || !ids.has(e.to)) { bad(`${where}: \`from\` and \`to\` must be node ids.`); continue; }
    if (e.from === e.to) bad(`${where}: an arrow from a node to itself.`);
    const key = `${e.from}>${e.to}`;
    if (pairs.has(key)) bad(`${where}: two arrows from ${e.from} to ${e.to}.`);
    pairs.add(key);
    if (e.notModelled !== undefined) {
      if (typeof e.notModelled !== 'string' || e.notModelled.trim().length < 12 || e.notModelled.length > 220) bad(`${where}: \`notModelled\` must say in a sentence why this arrow cannot be modelled (at most 220 characters).`);
    } else {
      if (e.sign !== '+' && e.sign !== '-') bad(`${where}: \`sign\` must be "+" or "-" (only a notModelled arrow may leave it out).`);
      if (typeof e.reason !== 'string' || e.reason.trim().length < 8 || e.reason.length > 150) bad(`${where}: \`reason\` must be one plain sentence of at most 150 characters.`);
    }
    if (e.claim !== undefined && (typeof e.claim !== 'string' || e.claim.length > 16)) bad(`${where}: \`claim\` must be a short point id such as "p61".`);
  }
  if (!Array.isArray(spec.outputs) || spec.outputs.length < 1 || spec.outputs.length > 4 || spec.outputs.some((o) => !ids.has(o))) bad('`outputs` must name 1 to 4 nodes to mark.');
  if (perts.length < 2) bad('Offer at least two changes in `perturbations`.');
  const pids = new Set<string>();
  for (const [i, p] of perts.entries()) {
    const where = `Change ${i + 1}`;
    if (!p || typeof p.id !== 'string' || !ID.test(p.id)) { bad(`${where}: \`id\` must be letters, digits, - or _.`); continue; }
    if (pids.has(p.id)) bad(`${where}: id "${p.id}" is used twice.`);
    pids.add(p.id);
    if (!ids.has(p.node)) bad(`${where}: \`node\` must be a node id.`);
    if (!KINDS.includes(p.kind)) bad(`${where}: \`kind\` must be remove, block or more.`);
    if (typeof p.label !== 'string' || p.label.length < 6 || p.label.length > 70) bad(`${where}: \`label\` must be an instruction such as "Remove the supply line" (6 to 70 characters).`);
    if (p.level !== undefined && !LEVEL_NAMES.includes(p.level)) bad(`${where}: \`level\` must be off, low, normal or high.`);
    if (p.outputs !== undefined && (!Array.isArray(p.outputs) || !p.outputs.length || p.outputs.some((o) => !ids.has(o)))) bad(`${where}: \`outputs\` must name nodes.`);
  }
  if (out.length) return out;

  const text = JSON.stringify(spec);
  if (text.length > MAX_SPEC_CHARS) bad(`The spec is ${text.length} characters; the catalogue allows ${MAX_SPEC_CHARS}. Shorten reasons or notes.`);

  const net = buildNet(spec);
  for (const [i, n] of nodes.entries()) {
    if (net.acts[i].length >= 2 && n.needs === undefined) bad(`Node "${n.id}" has ${net.acts[i].length} activators: say whether it \`needs\` "all" or "any" of them.`);
    if (net.acts[i].length >= 1 && n.level !== undefined) bad(`Node "${n.id}" has activators, so its \`level\` would be ignored: remove it.`);
  }
  for (const [i, e] of edges.entries()) {
    if (e.notModelled) continue;
    const a = nodes[net.index.get(e.from) as number]; const b = nodes[net.index.get(e.to) as number];
    for (const [k, c] of nodes.entries()) {
      if (c === a || c === b) continue;
      if (crosses(a.x, a.y, b.x, b.y, c.x, c.y, 11, 9)) { bad(`Arrow ${i + 1} (${e.from} to ${e.to}) runs behind node "${nodes[k].id}": move a node.`); break; }
    }
  }
  const before = steady(net);
  if (!before.ok) { bad(`The network does not settle before anything is changed (it ${before.why}). Break the loop, or mark one arrow in it as notModelled.`); return out; }
  // Every change, and every pair of changes on different nodes, must settle.
  const idle: NetPerturbation[] = [];
  for (const p of perts) {
    const s = steady(net, clampOf(net, [p]));
    if (!s.ok) { bad(`The network does not settle when you "${p.label}" (it ${s.why}). Break the loop, or mark one arrow in it as notModelled.`); continue; }
    if (s.state[net.index.get(p.node) as number] === before.state[net.index.get(p.node) as number]) bad(`"${p.label}" changes nothing: ${nodes[net.index.get(p.node) as number].label} is already ${levelName(before.state[net.index.get(p.node) as number])}.`);
    const marks = outputsOf(spec, p);
    if (marks.includes(p.node)) bad(`"${p.label}" changes a node that is also marked as an output.`);
    if (!marks.some((o) => s.state[net.index.get(o) as number] !== before.state[net.index.get(o) as number])) idle.push(p);
    const trace = propagate(net, before.state, clampOf(net, [p]));
    if (!trace.settled) bad(`The change from "${p.label}" does not come to rest hop by hop.`);
  }
  if (!out.length) {
    for (let i = 0; i < perts.length; i++) for (let j = i + 1; j < perts.length; j++) {
      if (perts[i].node === perts[j].node) continue;
      const pair = [perts[i], perts[j]];
      if (!steady(net, clampOf(net, pair)).ok) bad(`Doing both "${perts[i].label}" and "${perts[j].label}" does not settle. Break the loop, or mark one arrow in it as notModelled.`);
      else if (!propagate(net, before.state, clampOf(net, pair)).settled) bad(`Doing both "${perts[i].label}" and "${perts[j].label}" does not come to rest hop by hop.`);
    }
  }
  // A change that alone moves nothing must matter in some pair, or it teaches nothing.
  if (!out.length) {
    for (const p of idle) {
      const matters = perts.some((q) => {
        if (q.node === p.node) return false;
        const pair = [p, q];
        const marks = [...new Set([...outputsOf(spec, p), ...outputsOf(spec, q)])].filter((o) => !pair.some((x) => x.node === o));
        const both = steady(net, clampOf(net, pair)).state;
        const alone = steady(net, clampOf(net, [q])).state;
        return marks.some((o) => both[net.index.get(o) as number] !== alone[net.index.get(o) as number]);
      });
      if (!matters) bad(`"${p.label}" changes none of its marked outputs, alone or with any other change, so there is nothing to predict.`);
    }
  }
  // Questions can be set at every rung from many seeds.
  if (!out.length) {
    for (let rung = 0; rung < 3; rung++) for (let k = 0; k < 12; k++) {
      try { prepare(spec, `check${k}:${k % 3}`, rung); } catch (error) { bad(`Could not set a question at rung ${rung}: ${(error as Error).message}`); break; }
    }
  }
  return out;
}

// ── Setting a question ───────────────────────────────────────────────────────

export interface NetAttempt { kind: 'predict' | 'identify'; answers?: Record<string, Dir>; pick?: string }

export interface NetTask {
  spec: NetSpec;
  net: Net;
  rung: number;
  mode: 'predict' | 'identify';
  /** The change(s) that are really made. */
  changes: NetPerturbation[];
  /** The nodes marked. */
  outputs: string[];
  before: Level[];
  after: Level[];
  steps: Step[];
  truth: Record<string, Dir>;
  /** For "identify": the changes to choose between, and the right one. */
  options: Array<{ id: string; label: string }>;
  answer: string;
  showSigns: boolean;
  announce: string;
  question: string;
}

const pattern = (net: Net, before: readonly Level[], after: readonly Level[], outs: readonly string[]): Record<string, Dir> =>
  Object.fromEntries(outs.map((o) => {
    const i = net.index.get(o) as number;
    return [o, dirOf(before[i], after[i])];
  }));
const patternKey = (p: Record<string, Dir>, outs: readonly string[]) => outs.map((o) => p[o]).join('|');

const joinWords = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
export const conditionOf = (changes: readonly NetPerturbation[]) => `you ${joinWords(changes.map((c) => lowerFirst(c.label)))}`;

export function prepare(spec: NetSpec, seed: string, rung: number): NetTask {
  const net = buildNet(spec);
  const before = steady(net).state;
  const perts = spec.perturbations;
  const round = roundOf(seed);
  const base = hashSeed(seed.replace(/:\d+$/, ''));
  const rand = rng(seed);
  const order = (offset: number) => (base + round + offset) % perts.length;

  const build = (changes: NetPerturbation[], mode: 'predict' | 'identify', showSigns: boolean, outs: string[]): NetTask => {
    const clamp = clampOf(net, changes);
    const trace = propagate(net, before, clamp);
    const truth = pattern(net, before, trace.after, outs);
    return {
      spec, net, rung, mode, changes, outputs: outs, before, after: trace.after, steps: trace.steps, truth, options: [], answer: '', showSigns,
      announce: '', question: '',
    };
  };

  // A double change: two different nodes, preferring a pair whose result is not just one of them on its own.
  const pairFor = (): NetPerturbation[] | null => {
    const found: Array<{ pair: NetPerturbation[]; score: number }> = [];
    for (let i = 0; i < perts.length; i++) for (let j = i + 1; j < perts.length; j++) {
      if (perts[i].node === perts[j].node) continue;
      const pair = [perts[i], perts[j]];
      const outs = [...new Set([...outputsOf(spec, perts[i]), ...outputsOf(spec, perts[j])])].filter((o) => !pair.some((p) => p.node === o)).slice(0, 4);
      if (!outs.length) continue;
      const both = pattern(net, before, propagate(net, before, clampOf(net, pair)).after, outs);
      const a = pattern(net, before, propagate(net, before, clampOf(net, [pair[0]])).after, outs);
      const b = pattern(net, before, propagate(net, before, clampOf(net, [pair[1]])).after, outs);
      const changed = outs.filter((o) => both[o] !== 'same').length;
      if (!changed) continue;
      const fresh = patternKey(both, outs) !== patternKey(a, outs) && patternKey(both, outs) !== patternKey(b, outs) ? 2 : 0;
      found.push({ pair, score: fresh + changed });
    }
    if (!found.length) return null;
    const best = Math.max(...found.map((f) => f.score));
    const top = found.filter((f) => f.score === best);
    return top[(base + round) % top.length].pair;
  };

  const moves = (p: NetPerturbation) => {
    const after = propagate(net, before, clampOf(net, [p])).after;
    return outputsOf(spec, p).some((o) => after[net.index.get(o) as number] !== before[net.index.get(o) as number]);
  };
  const single = (showSigns: boolean): NetTask => {
    const pool = showSigns ? perts.filter(moves) : perts;
    const p = (pool.length ? pool : perts)[(base + round) % (pool.length ? pool : perts).length];
    const t = build([p], 'predict', showSigns, outputsOf(spec, p));
    t.announce = `${upperFirst(p.label)}.`;
    t.question = 'What happens to each marked part? Choose, then press Run and watch the change travel.';
    return t;
  };

  if (rung === 0) return single(true);
  if (rung === 1) return single(false);

  // Rung 2: alternate between running backwards and a double change.
  const backwards = (base + round) % 2 === 0;
  if (backwards) {
    const p = perts[order(0)];
    const outs = outputsOf(spec, p);
    const t = build([p], 'identify', false, outs);
    const key = patternKey(t.truth, outs);
    const flat = outs.every((o) => t.truth[o] === 'same');
    // Other changes that give a different picture of the same outputs; never a second one that gives the same.
    const others = perts.filter((q) => q.id !== p.id && patternKey(pattern(net, before, propagate(net, before, clampOf(net, [q])).after, outs), outs) !== key && !outs.includes(q.node));
    const pickedOthers = others.map((q) => ({ q, r: rand() })).sort((a, b) => a.r - b.r).slice(0, 3).map((x) => x.q);
    if (!flat && pickedOthers.length >= 2) {
      const options = [p, ...pickedOthers].map((q) => ({ q, r: rand() })).sort((a, b) => a.r - b.r).map((x) => ({ id: x.q.id, label: x.q.label }));
      t.options = options;
      t.answer = p.id;
      t.announce = `Something was done to the network. Here is what was seen: ${joinWords(outs.map((o) => `${spec.nodes[net.index.get(o) as number].label} ${dirWord(t.truth[o])}`))}.`;
      t.question = 'Which change gives this? Choose one, then press Run.';
      return t;
    }
  }
  const pair = pairFor();
  if (pair) {
    const outs = [...new Set([...outputsOf(spec, pair[0]), ...outputsOf(spec, pair[1])])].filter((o) => !pair.some((p) => p.node === o)).slice(0, 4);
    const t = build(pair, 'predict', false, outs);
    t.announce = `Two changes at once. ${upperFirst(pair[0].label)}, and ${lowerFirst(pair[1].label)}.`;
    t.question = 'What happens to each marked part? Work out both changes, then press Run.';
    return t;
  }
  return single(false);
}

// ── Reading an attempt ───────────────────────────────────────────────────────

const labelOf = (task: NetTask, id: string) => task.spec.nodes[task.net.index.get(id) as number].label;

/** The reasons along the chain that made a node change, from the change itself to the node. */
export function chainTo(task: NetTask, node: number): Array<{ hop: Hop; edge: NetEdge | null }> {
  const chain: Array<{ hop: Hop; edge: NetEdge | null }> = [];
  let at = node;
  for (let s = task.steps.length - 1; s >= 0; s--) {
    const hop = task.steps[s].hops.find((h) => h.node === at);
    if (!hop) continue;
    const edge = hop.via.length ? task.spec.edges[hop.via[0]] : null;
    chain.unshift({ hop, edge });
    if (!edge) break;
    at = task.net.index.get(edge.from) as number;
  }
  return chain;
}

/** What fed a hop: "GADD34 phosphatase falls", from the step before. */
export function becauseOf(task: NetTask, step: number, hop: Hop): string {
  if (!hop.via.length || step < 1) return '';
  const prev = task.steps[step - 1].hops;
  const names: string[] = [];
  for (const e of hop.via) {
    const from = task.net.index.get(task.spec.edges[e].from) as number;
    const h = prev.find((x) => x.node === from);
    if (h) names.push(`${task.spec.nodes[from].label} ${dirWord(dirOf(h.from, h.to))}`);
  }
  return names.join(' and ');
}

/** Why a node did not move: what held it where it is. */
function whyHeld(task: NetTask, i: number): string {
  const net = task.net;
  const moved = (k: number) => task.after[k] !== task.before[k];
  const inputs = [...net.acts[i], ...net.blocks[i]];
  if (!inputs.some(moved)) return 'nothing that feeds it changes';
  const name = (k: number) => task.spec.nodes[k].label;
  const holders = net.blocks[i].filter((k) => !moved(k) && task.after[k] > 0).map((k) => `${name(k)} still blocks it`);
  if (holders.length) return holders.slice(0, 2).join(' and ');
  const limits = net.acts[i].filter((k) => !moved(k)).map((k) => `${name(k)} still limits it`);
  return limits.length ? limits.slice(0, 2).join(' and ') : 'its other inputs hold it where it is';
}

/** One plain passage on why: the chain from the change to the first output that moved, then what held the others. */
export function whySentence(task: NetTask): string {
  const lead = task.changes.map((c, i) => (i ? lowerFirst(c.label) : upperFirst(c.label))).join(' and ');
  const parts: string[] = [];
  let held = 0;
  const moved = task.outputs.filter((o) => task.truth[o] !== 'same').map((o) => ({ o, chain: chainTo(task, task.net.index.get(o) as number).filter((c) => c.edge) }));
  const longest = moved.sort((a, b) => b.chain.length - a.chain.length)[0];
  if (longest) {
    const words = longest.chain.map((c) => `${task.spec.nodes[c.hop.node].label} ${dirWord(dirOf(c.hop.from, c.hop.to))}`);
    parts.push(`${lead}, so ${words.length ? words.join(', so ') : `${labelOf(task, longest.o)} ${dirWord(task.truth[longest.o])}`}`);
  } else parts.push(lead);
  for (const o of task.outputs) {
    if (task.truth[o] !== 'same' || held++ > 0) continue;
    parts.push(`${labelOf(task, o)} stays about the same, because ${whyHeld(task, task.net.index.get(o) as number)}`);
  }
  return `${parts.join('. ')}.`.replace(/\.\./g, '.');
}

/** What this round tested, when the spec says so per change. */
function roundCovers(task: NetTask): Pick<RoundResult, 'covers'> {
  if (!task.spec.perturbations.some((p) => p.covers?.length)) return {};
  return { covers: [...new Set(task.changes.flatMap((p) => p.covers ?? []))] };
}

export function result(task: NetTask, attempt: NetAttempt): RoundResult {
  return { ...judged(task, attempt), ...roundCovers(task) };
}

function judged(task: NetTask, attempt: NetAttempt): RoundResult {
  const cond = conditionOf(task.changes);
  const truthWords = joinWords(task.outputs.map((o) => `${labelOf(task, o)} ${dirWord(task.truth[o])}`));
  const why = whySentence(task);
  if (task.mode === 'identify') {
    if (attempt.kind !== 'identify' || !attempt.pick) throw new Error('An "identify" round needs a pick.');
    const right = task.options.find((o) => o.id === task.answer);
    const met = attempt.pick === task.answer;
    return {
      met,
      label: clip(`Works out that ${truthWords} comes from: ${lowerFirst(right?.label ?? '')}`, 200),
      why,
      misconception: met ? undefined : 'Picks a change that would not give the effect seen',
    };
  }
  if (attempt.kind !== 'predict' || !attempt.answers) throw new Error('A "predict" round needs an answer for each marked part.');
  const wrong = task.outputs.filter((o) => attempt.answers![o] !== task.truth[o]);
  const met = wrong.length === 0;
  let misconception: string | undefined;
  if (!met) {
    const reversed = wrong.filter((o) => attempt.answers![o] !== 'same' && task.truth[o] !== 'same');
    const missed = wrong.filter((o) => attempt.answers![o] === 'same' && task.truth[o] !== 'same');
    const spread = wrong.filter((o) => attempt.answers![o] !== 'same' && task.truth[o] === 'same');
    if (reversed.length) misconception = 'Reverses the effect where an arrow blocks instead of activating';
    else if (missed.length) misconception = 'Expects no effect where the change does travel on';
    else if (spread.length) misconception = 'Expects a change to carry on past a node that holds steady';
  }
  return { met, label: clip(`Predicts that when ${cond}: ${truthWords}`, 200), why, misconception };
}

/** The wording of what the student chose, for the verdict line. */
export function answerWords(task: NetTask, id: string, attempt: NetAttempt): string {
  if (task.mode === 'identify') return lowerFirst(task.options.find((o) => o.id === attempt.pick)?.label ?? '');
  return dirWord((attempt.answers ?? {})[id] ?? 'same');
}
