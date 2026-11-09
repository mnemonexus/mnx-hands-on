/**
 * Which engines name the lecture points they test (`covers`), and from which rung. The host counts a pass as one spaced review in
 * Recall of ideas the student has already answered: it moves those ideas a little later, never replaces a question, and only when
 * the student has turned "Count passes towards Recall" on for this add-on. So `covers` has to say what a run really tested.
 *
 * A rung below the one in EARNS_FROM gives the answer away in its setup, so a run there names nothing. Find the Error starts at
 * rung 1, because a passage at rung 0 is short. Sort has no per-round form yet, so it names nothing at any rung.
 */
import { RUNGS } from './engine';

/** The lowest rung that tests a point, per engine. Below it the setup gives the answer away. */
const EARNS_FROM: Record<string, number> = { construct: 1, controls: 1, dial: 1, grow: 0, network: 1, predict: 1, spectrum: 2, spot: 1 };

/** The engines that name `covers` in the catalogue. Sort is left out. */
export const NAMES_COVERS: ReadonlySet<string> = new Set(Object.keys(EARNS_FROM));

/** The rung a run needs to reach for its `covers` to count: RUNGS, one past the last, means never. */
export const creditFrom = (engine: string): number => (NAMES_COVERS.has(engine) ? EARNS_FROM[engine] ?? 0 : RUNGS);
