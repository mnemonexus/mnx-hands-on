/**
 * Sort, the logic: no DOM, no subject. A spec names two or three things that are easy to confuse and a pool of statements,
 * each with the bin it belongs in and a short reason. A round deals a few of them one at a time; the engine works out whether
 * each went to the right place from the spec's own bin number, so the student never sees an answer a slip in the spec made up.
 *
 * Rungs: 0 is two clean bins and few statements, 1 is more statements, 2 is all three bins (when the spec has three) with
 * statements that read almost the same as ones in another bin.
 */
import { clip } from '../../report';
import { hashSeed, rng, roundOf, type RoundResult } from '../../engine';

// ── The spec ─────────────────────────────────────────────────────────────────

export interface SortBin { label: string; note?: string }
/** `bin` is the index of the bin it belongs in, or "both" when it is true of every bin shown. */
export interface SortCard {
  /** What the student reads while sorting. It must not name a bin, so the generator may put a stand-in ("this", "it") where the name was. */
  t: string;
  bin: number | 'both';
  why: string;
  /** The sentence as the lesson wrote it, shown once the card is placed. Only present when `t` has been masked. */
  full?: string;
}
/** The sentence to show once a card has been placed: the original when `t` was masked. */
export const shown = (card: Pick<SortCard, 't' | 'full'>) => card.full ?? card.t;
export interface SortSpec {
  bins: SortBin[];
  cards: SortCard[];
  /** One line above the first card, such as what the statements are about. */
  intro?: string;
}

export type Placed = number | 'both';
export interface SortPlacement { id: string; first: Placed; tries: number }
export interface SortAttempt {
  /** What was dealt, in order, each with where it went the first time. Cards marked unclear are not in this list. */
  placements: SortPlacement[];
  /** Ids of the cards the student marked unclear during this round. */
  retired: string[];
}

export const MIN_BIN_CARDS = 3;
export const MAX_SPEC_JSON = 6200;
const MAX_CARD = 240;
const MAX_WHY = 200;

/** Per rung: cards per bin in a round. */
const PER_BIN = [2, 3, 3];
/** Per rung: whether a "both" card may be dealt. */
const BOTH_MAX = [0, 1, 1];

/** A stable short name for a card, from its text. */
export const cardId = (card: Pick<SortCard, 't'>) => hashSeed(card.t.trim().toLowerCase()).toString(36);

// ── Plain checks on wording (English, no subject) ────────────────────────────

/** Words that, opening a sentence, point at something said before it. */
const LEADING = new Set([
  'it', 'its', "it's", 'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those', 'he', 'she', 'his', 'her', 'we', 'our', 'you', 'your',
  'such', 'both', 'also', 'however', 'therefore', 'thus', 'hence', 'then', 'so', 'but', 'and', 'or', 'yet', 'still', 'instead', 'otherwise', 'moreover',
  'furthermore', 'additionally', 'conversely', 'similarly', 'likewise', 'meanwhile', 'here', 'there', 'another', 'other', 'either', 'neither', 'each',
  'whereas', 'which', 'consequently', 'nevertheless',
  'first', 'second', 'third', 'finally', 'next', 'again', 'now', 'only', 'same', 'similar', 'unlike', 'despite',
]);
/** Phrases that need the page around them. */
const NEEDS_CONTEXT = /\b(?:(?:the|as|see|shown|described|given|listed|mentioned|stated|noted|seen|discussed|explained)\s+(?:above|below|earlier|previously)|(?:above|below|earlier)\s*[.;:)]?\s*$|previously (?:described|mentioned|shown|seen|discussed)|the former|the latter|see (?:slide|figure|fig|table|page)|slide \d|figure \d|fig\. ?\d|table \d|in this lecture|in the lecture|in the previous|last week|next week|the lecturer|the slide|the diagram|the graph|the figure|the table|the example|the question|we (?:will|shall|can|have)|let us|let's|you (?:will|should|can|need|must)|your )\b/i;

/** Why a statement could not stand alone, or null when it can. Used by the build, and by `issues` for every spec. */
export function standaloneProblem(text: string): string | null {
  const t = text.trim();
  if (t.length < 20) return 'is too short to mean anything on its own';
  if (t.length > MAX_CARD) return `is longer than ${MAX_CARD} characters`;
  const first = (t.match(/^[^a-zA-Z0-9]*([A-Za-z][A-Za-z'’-]*)/)?.[1] ?? '').toLowerCase().replace('’', "'");
  if (LEADING.has(first)) return `starts with "${first}", which needs the sentence before it`;
  if (/^(?:after|before|from|at|in|on|by|with|for|of|to|under|given|despite)\s+(?:this|that|these|those|it|them)\b/i.test(t)) return 'starts by pointing back at something said before it';
  if (/^[a-z]/.test(t)) return 'starts in lower case, so it is probably part of a longer sentence';
  if (/\?\s*$/.test(t)) return 'is a question, and a statement is needed';
  if (/^(?:\(|\[|[-•*]\s)/.test(t)) return 'starts like a list item or an aside';
  if (NEEDS_CONTEXT.test(t)) return 'points at something outside itself (a slide, a figure, "above", "we", "you")';
  if ((t.match(/\(/g) ?? []).length !== (t.match(/\)/g) ?? []).length) return 'has a bracket that is not closed';
  return null;
}

const STOP = new Set(('a an and are as at be been by can do does for from has have in into is it its of on or that the their there these this those to was were which with not no than then so such also may more most only other some when while who whom whose will would should could about within between both each either over under per via').split(' '));
/** The words of a text that carry meaning, lower case. */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9α-ω][a-z0-9α-ω'’-]*/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}
/** A light stem, so "bonds" and "bond", or "binding" and "binds", read as the same word. */
function stem(w: string): string {
  let x = w.replace(/['’]s$/, '');
  if (x.length > 4 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`;
  else if (x.length > 4 && x.endsWith('sses')) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s') && !/(ss|us|is)$/.test(x)) x = x.slice(0, -1);
  if (x.length > 6 && x.endsWith('ing')) x = x.slice(0, -3);
  else if (x.length > 5 && x.endsWith('ed')) x = x.slice(0, -2);
  return x;
}
/** How much two texts share (0 to 1). */
export function similarity(a: string, b: string): number {
  const x = new Set(contentWords(a));
  const y = new Set(contentWords(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// ── Checking a spec ──────────────────────────────────────────────────────────

export function issues(spec: SortSpec): string[] {
  const out: string[] = [];
  if (!spec || typeof spec !== 'object') return ['The spec is missing.'];
  const bins = Array.isArray(spec.bins) ? spec.bins : [];
  const cards = Array.isArray(spec.cards) ? spec.cards : [];
  if (bins.length < 2 || bins.length > 3) out.push(`"bins" must hold two or three things to tell apart, and it holds ${bins.length}.`);
  const labels = new Set<string>();
  bins.forEach((b, i) => {
    if (!b || typeof b.label !== 'string' || !b.label.trim()) out.push(`Bin ${i + 1} has no "label".`);
    else {
      if (b.label.length > 60) out.push(`Bin "${b.label}" has a label of more than 60 characters.`);
      if (labels.has(b.label.trim().toLowerCase())) out.push(`Two bins are both called "${b.label}".`);
      labels.add(b.label.trim().toLowerCase());
    }
    if (b?.note !== undefined && (typeof b.note !== 'string' || b.note.length > 200)) out.push(`Bin "${b?.label}" has a note that is not text of at most 200 characters.`);
  });
  const per = new Map<number, number>();
  const seen = new Set<string>();
  cards.forEach((c, i) => {
    const where = `Statement ${i + 1}`;
    if (!c || typeof c.t !== 'string') { out.push(`${where} has no "t" (its text).`); return; }
    if (c.full !== undefined) {
      // A masked card opens with a stand-in ("This ..."), so the original has to stand alone and the masked text only has to be a sentence.
      if (typeof c.full !== 'string') out.push(`${where} has a "full" that is not text.`);
      else {
        const f = standaloneProblem(c.full);
        if (f) out.push(`${where} ("${c.full.slice(0, 40)}…") ${f}.`);
        if (c.t.trim().length < 20 || c.t.length > MAX_CARD) out.push(`${where} has masked text of an unusable length.`);
      }
    } else {
      const p = standaloneProblem(c.t);
      if (p) out.push(`${where} ("${c.t.slice(0, 40)}…") ${p}.`);
    }
    const key = c.t.trim().toLowerCase();
    if (seen.has(key)) out.push(`${where} repeats an earlier statement.`);
    seen.add(key);
    if (c.bin !== 'both' && !(Number.isInteger(c.bin) && c.bin >= 0 && c.bin < bins.length)) out.push(`${where} names bin ${String(c.bin)}, which does not exist (use 0 to ${bins.length - 1}, or "both").`);
    else if (c.bin !== 'both') per.set(c.bin, (per.get(c.bin) ?? 0) + 1);
    if (typeof c.why !== 'string' || !c.why.trim()) out.push(`${where} has no "why", the reason it goes where it does.`);
    else if (c.why.length > MAX_WHY) out.push(`${where} has a "why" of more than ${MAX_WHY} characters.`);
  });
  bins.forEach((b, i) => { if ((per.get(i) ?? 0) < MIN_BIN_CARDS) out.push(`Bin "${b?.label}" has ${per.get(i) ?? 0} statements and needs at least ${MIN_BIN_CARDS}.`); });
  const size = JSON.stringify(spec).length;
  if (size > MAX_SPEC_JSON) out.push(`The spec is ${size} characters and the catalogue allows about ${MAX_SPEC_JSON} here: cut some statements.`);
  return out;
}

// ── Setting a round ──────────────────────────────────────────────────────────

export interface SortTask {
  spec: SortSpec;
  rung: number;
  round: number;
  /** The run's seed with the round taken off, so every round of a run draws from the same shuffle. */
  runSeed: string;
  /** The bins in play, as indices into spec.bins, in the order shown. */
  bins: number[];
  perBin: number;
  /** Each bin's cards in the order this run uses them, then the "both" cards. */
  order: Record<string, SortCard[]>;
  title: string;
}

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const r = rng(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Which bins to show: all of them at rung 2, otherwise the two that are least alike. */
export function chooseBins(spec: SortSpec, rung: number): number[] {
  const n = spec.bins.length;
  const all = spec.bins.map((_, i) => i);
  if (n <= 2 || rung >= 2) return all;
  let best = [0, 1];
  let bestScore = Infinity;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    let sum = 0, count = 0;
    for (const x of spec.cards) if (x.bin === a) for (const y of spec.cards) if (y.bin === b) { sum += similarity(x.t, y.t); count++; }
    const score = count ? sum / count : 0;
    if (score < bestScore - 1e-9) { bestScore = score; best = [a, b]; }
  }
  return best;
}

export function prepare(spec: SortSpec, seed: string, rung: number): SortTask {
  const r = Math.max(0, Math.min(2, Math.floor(rung)));
  const round = roundOf(seed);
  const runSeed = seed.replace(/:\d+$/, '');
  const bins = chooseBins(spec, r);
  const order: Record<string, SortCard[]> = {};
  for (const b of bins) {
    const mine = spec.cards.filter((c) => c.bin === b);
    const others = spec.cards.filter((c) => c.bin !== b && c.bin !== 'both' && bins.includes(c.bin as number));
    let list = shuffled(mine, `${runSeed}|bin${b}`);
    if (r === 2) {
      // Near-identical statements: the ones that read most like a statement in another bin come first.
      const near = new Map(mine.map((c) => [c, Math.max(0, ...others.map((o) => similarity(c.t, o.t)))]));
      const ranked = mine.slice().sort((x, y) => (near.get(y) ?? 0) - (near.get(x) ?? 0) || (x.t < y.t ? -1 : 1));
      const top = Math.max(PER_BIN[2], Math.ceil(ranked.length * 0.7));
      list = [...shuffled(ranked.slice(0, top), `${runSeed}|near${b}`), ...shuffled(ranked.slice(top), `${runSeed}|far${b}`)];
    }
    order[String(b)] = list;
  }
  order.both = shuffled(spec.cards.filter((c) => c.bin === 'both'), `${runSeed}|both`);
  const names = bins.map((b) => spec.bins[b].label);
  return { spec, rung: r, round, runSeed, bins, perBin: PER_BIN[r], order, title: names.join(' or ') };
}

/** The cards in a bin's order with the ones marked unclear taken out. */
const usable = (task: SortTask, key: string | number, retired: ReadonlySet<string>) => (task.order[String(key)] ?? []).filter((c) => !retired.has(cardId(c)));

/** This round's cards: a window of each bin's shuffled list that moves along with the round, so a run seldom repeats one. */
export function deal(task: SortTask, retired: ReadonlySet<string> = new Set()): SortCard[] {
  const cards: SortCard[] = [];
  for (const b of task.bins) {
    const list = usable(task, b, retired);
    const n = Math.min(task.perBin, list.length);
    for (let i = 0; i < n; i++) cards.push(list[(task.round * task.perBin + i) % list.length]);
  }
  const both = usable(task, 'both', retired);
  if (BOTH_MAX[task.rung] > 0 && both.length) cards.push(both[task.round % both.length]);
  return shuffled(cards, `${task.runSeed}|${task.round}|deal`);
}

/** A card to put in the place of one marked unclear: the next of the same bin that is not in play. Null when there is none. */
export function replacement(task: SortTask, retired: ReadonlySet<string>, inPlay: readonly SortCard[], bin: Placed): SortCard | null {
  const have = new Set(inPlay.map(cardId));
  const list = usable(task, bin, retired).filter((c) => !have.has(cardId(c)));
  if (!list.length) return null;
  const start = (task.round * task.perBin + task.perBin) % Math.max(1, usable(task, bin, retired).length);
  return list[start % list.length];
}

// ── Judging a round ──────────────────────────────────────────────────────────

const byId = (spec: SortSpec) => new Map(spec.cards.map((c) => [cardId(c), c]));
const nameOf = (spec: SortSpec, bin: Placed) => (bin === 'both' ? 'both' : spec.bins[bin]?.label ?? '?');

/** How many first placements may be wrong for the round to count as met. */
export const slack = (n: number) => Math.floor(n / 4);

export function result(task: SortTask, attempt: SortAttempt): RoundResult {
  const spec = task.spec;
  const cards = byId(spec);
  const rows = attempt.placements.map((p) => ({ p, card: cards.get(p.id) })).filter((r): r is { p: SortPlacement; card: SortCard } => !!r.card);
  const n = rows.length;
  const wrong = rows.filter((r) => r.p.first !== r.card.bin);
  const right = n - wrong.length;
  const names = task.bins.map((b) => spec.bins[b].label);
  const met = n > 0 && wrong.length <= slack(n);
  const label = `Sorts statements between ${names.join(', ')}: ${right} of ${n} in the right place first time`;
  let why: string;
  if (!wrong.length) {
    const notes = task.bins.map((b) => (spec.bins[b].note ? `${spec.bins[b].label}: ${spec.bins[b].note}` : '')).filter(Boolean);
    why = notes.length ? notes.join(' ') : `Each statement belongs with the one it describes: ${names.join(' and ')} are not interchangeable.`;
  } else {
    const first = wrong[0].card;
    why = `"${clip(shown(first), 80)}": ${first.why}`;
  }
  const out: RoundResult = { met, label: clip(label, 200), why: clip(why, 400) };
  // A wrong idea worth naming: the same two things swapped more than once, or "both" used wrongly.
  const pairs = new Map<string, number>();
  for (const { p, card } of wrong) {
    const from = card.bin === 'both' ? 'both' : spec.bins[card.bin].label;
    const to = p.first === 'both' ? 'both' : spec.bins[p.first]?.label ?? '?';
    const key = card.bin === 'both' ? `shared|${to}` : p.first === 'both' ? `split|${from}` : `swap|${[from, to].sort().join('|')}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) {
    const [kind, a, b] = top[0].split('|');
    out.misconception = clip(kind === 'swap' ? `Mixes up ${a} and ${b}` : kind === 'split' ? `Treats a feature of ${a} as shared with the others` : `Treats something the bins share as belonging only to ${a}`, 120);
  }
  if (attempt.retired.length) out.note = `${attempt.retired.length} statement${attempt.retired.length === 1 ? '' : 's'} marked as unclear and left out for good.`;
  return out;
}

/** The names of the bins' cards for the side-by-side summary at the end of a round. */
export function binName(spec: SortSpec, bin: Placed): string { return nameOf(spec, bin); }
