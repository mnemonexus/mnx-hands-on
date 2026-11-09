/**
 * The shape every Hands On engine fills in. An engine is one piece of code that is filled with data: nothing about a
 * subject or a course lives in it. A spec holds the setup and the engine works out the answer, so a slip in a spec makes
 * a wrong setup (which `issues` refuses) and can never make a wrong answer told to a student.
 */

/** What one round comes to, in words a student can read. */
export interface RoundResult {
  /** True when the student got this round right. */
  met: boolean;
  /** One sentence naming what was asked and what is right. Reported to the host as the round's criterion. */
  label: string;
  /** The one plain sentence on why, shown after the reveal. */
  why: string;
  /** A short name for a wrong idea that this slip suggests, if it suggests one. */
  misconception?: string;
  /** Study items this round tested, when an activity says so per round. Present and empty means it tested none. */
  covers?: string[];
  /** Something about this round the host's note should carry, such as a card the student marked unclear. */
  note?: string;
}

export interface Engine<Spec, Task, Attempt> {
  id: string;
  label: string;
  /** What rungs 0, 1 and 2 are called for this engine, in a few plain words each. Defaults to Dial's: which way, how far, the number. */
  rungNames?: readonly [string, string, string];
  /** Words a writer can act on. Empty means the spec is fit to use. Must be pure: the build runs it without a DOM. */
  issues(spec: Spec): string[];
  /** Same seed, same task. The seed ends in ":<round>" so a run's rounds can differ. `rung` is 0, 1 or 2. */
  prepare(spec: Spec, seed: string, rung: number): Task;
  /**
   * Draw one round into `root`. The student commits by touching the thing; the engine plays the reveal and calls `done`
   * once it is finished, so the sentence on why arrives after it. May return a function that stops anything left running.
   */
  view(root: HTMLElement, task: Task, done: (attempt: Attempt) => void): void | (() => void);
  /** The verdict on an attempt. Pure. */
  result(task: Task, attempt: Attempt): RoundResult;
}

// biome-ignore lint: engines of every kind are held together in one list
export type AnyEngine = Engine<any, any, any>;

/** Rungs: 0 says which way it goes, 1 says how far, 2 gives the number with its unit. */
export const RUNGS = 3;
export const RUNG_NAMES = ['Which way', 'How far', 'The number'] as const;

// ── Seeds ────────────────────────────────────────────────────────────────────

/** A fixed number from a string (FNV-1a), so the same seed always gives the same task. */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A small seeded random source (mulberry32): returns numbers from 0 up to but not including 1. */
export function rng(seed: string): () => number {
  let a = hashSeed(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The round a seed belongs to ("run:2" is round 2), or 0 when it names none. */
export function roundOf(seed: string): number {
  const m = /:(\d+)$/.exec(seed);
  return m ? Number(m[1]) : 0;
}

/** True when the student has asked for less movement on screen. */
export function reducedMotion(): boolean {
  try {
    if (typeof document !== 'undefined' && document.documentElement.dataset.mnxMotion === 'reduced') return true;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}
