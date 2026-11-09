/**
 * What a run reports to the host (practice-v1, HOST_CONTRACT.md section 13), and how the rung moves. One criterion per
 * round, in words a student can read. The add-on never reports a grade: the host derives it. Pure, so it is tested without
 * a browser.
 */
import type { PracticeResult } from '@mnemonexus/addon-sdk/practice';
import { RUNGS, RUNG_NAMES, type RoundResult } from './engine';

const MAX_LABEL = 200;
const MAX_NOTE = 600;
const MAX_MISCONCEPTIONS = 32;

/** Shortens text to `max`, at a word where there is one reasonably near. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).trimEnd().replace(/[,;:]$/, '')}…`;
}

/** How many rounds a run has. */
export const ROUNDS = 3;

/** A run is passed when more than half its rounds were right. */
export function passed(rounds: readonly Pick<RoundResult, 'met'>[]): boolean {
  const met = rounds.filter((r) => r.met).length;
  return rounds.length > 0 && met * 2 > rounds.length;
}

/** Passing a run moves up one rung; missing one moves down one. */
export function nextRung(rung: number, pass: boolean): number {
  return Math.max(0, Math.min(RUNGS - 1, rung + (pass ? 1 : -1)));
}

export interface ReportInput {
  activityId: string;
  skill: string;
  rung: number;
  rounds: readonly RoundResult[];
  /** False when the student ended the run early. */
  finished: boolean;
  /** True when the rung was fixed in settings, so it does not move. */
  fixed?: boolean;
  /** What the engine calls its rungs, when not Dial's. */
  rungNames?: readonly string[];
  /** The lowest rung that can stand in for questions (`creditFrom` in credit.ts). */
  creditFrom?: number;
}

export function buildReport({ activityId, skill, rung, rounds, finished, fixed, rungNames, creditFrom = 0 }: ReportInput): PracticeResult {
  const names = rungNames ?? RUNG_NAMES;
  if (!finished || rounds.length === 0) {
    return {
      version: 1, activityId, valid: false, criteria: [], hintsUsed: 0, attempts: Math.max(0, rounds.length),
      note: 'This run was ended before it was finished, so it does not count.',
    };
  }
  const met = rounds.filter((r) => r.met).length;
  const misconceptions: string[] = [];
  for (const r of rounds) if (r.misconception && !misconceptions.includes(r.misconception)) misconceptions.push(clip(r.misconception, 120));
  const pass = passed(rounds);
  // An empty list says this round tested none of them, so the host credits nothing from the activity's own list either.
  const coversOf = (r: RoundResult) => (rung < creditFrom ? { covers: [] } : r.covers ? { covers: r.covers } : {});
  const note = [`Played at "${names[rung]}" (step ${rung + 1} of ${RUNGS}): ${met} of ${rounds.length} rounds right.`];
  for (const r of rounds) if (r.note && !note.includes(r.note)) note.push(r.note);
  if (!fixed) {
    const next = nextRung(rung, pass);
    note.push(next === rung ? `Next time stays at "${names[rung]}".` : `Next time moves ${next > rung ? 'up' : 'down'} to "${names[next]}".`);
  }
  return {
    version: 1, activityId, valid: true,
    criteria: rounds.map((r, i) => ({ id: `round-${i + 1}`, label: clip(r.label, MAX_LABEL), met: r.met, weight: 1, skill, ...coversOf(r) })),
    skills: [{ id: skill, evidence: Math.round((met / rounds.length) * 100) / 100 }],
    misconceptions: misconceptions.slice(0, MAX_MISCONCEPTIONS),
    hintsUsed: 0, attempts: rounds.length,
    note: clip(note.join(' '), MAX_NOTE),
  };
}
