/**
 * Runs one activity: rounds of its engine, the rung kept per family, and the report. This file knows nothing about any
 * engine's subject. It does not draw a results screen: the host draws the end of a run from the criteria reported.
 */
import type { ExperienceHost } from '@mnemonexus/addon-sdk';
import type { PracticeResult } from '@mnemonexus/addon-sdk/practice';
import { Clock } from './clock';
import { button, empty, h } from './dom';
import { creditFrom } from './credit';
import { RUNGS, RUNG_NAMES, type AnyEngine, type RoundResult } from './engine';
import { ROUNDS, buildReport, nextRung, passed } from './report';
import { doneKey, parseRung, rungKey, type Store } from './store';
import type { CatalogueEntry } from './types';

export interface RunDeps {
  host: ExperienceHost;
  store: Store;
  /** The level fixed in settings, or null to let the rung follow how the student is doing. */
  fixedRung: () => number | null;
  /** Present when the learner chose this from the list, so there is somewhere to go back to. */
  onBack?: () => void;
  /** Present when the host chose this activity (practice-v1): why it was offered. */
  reason?: string;
}

/** A fresh seed for each run, so the numbers are new every time. */
const newSeed = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function showProblem(root: HTMLElement, host: ExperienceHost, message: string) {
  empty(root);
  root.append(h('div', { class: 'ho-root' }, h('main', { class: 'ho-main' },
    h('div', { class: 'mnx-error', role: 'alert' }, h('p', { class: 'mnx-error__title' }, 'This could not be opened'), h('p', { class: 'mnx-error__text' }, message)),
    button('Close', 'secondary', () => host.exit(), { 'data-action': 'close' }))));
}

export async function runActivity(root: HTMLElement, entry: CatalogueEntry, engine: AnyEngine, deps: RunDeps): Promise<void> {
  const { host, store } = deps;
  const spec = entry.launch.spec;
  const problems = engine.issues(spec);
  if (problems.length) {
    console.warn(`Hands On: ${entry.id} was not opened: ${problems.join(' ')}`);
    showProblem(root, host, 'This activity has a fault, so it could not be opened. Nothing was recorded, and your other activities are not affected.');
    return;
  }

  const family = entry.family ?? entry.id;
  const fixed = deps.fixedRung();
  const stored = parseRung(await store.get(rungKey(family)), RUNGS);
  const rung = fixed ?? stored;
  const seed = newSeed();
  const skill = entry.skills[0];
  const names = engine.rungNames ?? RUNG_NAMES;
  const clock = new Clock();
  const results: RoundResult[] = [];
  let round = 0;
  let stopRound: void | (() => void);
  let ended = false;

  empty(root);
  const stage = h('div', { class: 'ho-stage', 'data-role': 'stage' });
  const progress = h('p', { class: 'ho-progress', 'data-role': 'progress' });
  const dots = h('ol', { class: 'ho-dots', 'aria-hidden': 'true' });
  for (let i = 0; i < ROUNDS; i++) dots.append(h('li', { class: 'ho-dot' }));
  const verdict = h('strong', { class: 'ho-after__verdict', 'data-role': 'verdict' });
  const why = h('span', { class: 'ho-after__why', 'data-role': 'why' });
  const next = button('Next round', 'primary', () => advance(), { 'data-action': 'next' });
  const after = h('div', { class: 'ho-after', 'data-role': 'after', role: 'status', hidden: true }, h('p', { class: 'ho-after__text' }, verdict, ' ', why), next);

  const ask = h('p', { class: 'mnx-feedback mnx-feedback--hint ho-confirm', role: 'status', hidden: true },
    'End this run now? It will not count, and your progress at this level stays as it was.');
  const yes = button('Yes, end it', 'danger', () => { void finish(false); }, { small: true, 'data-action': 'confirm-end', hidden: true });
  const no = button('Keep going', 'ghost', () => closeAsk(), { small: true, 'data-action': 'cancel-end', hidden: true });
  const open = button('End without finishing', 'ghost', () => {
    ask.hidden = false; yes.hidden = false; no.hidden = false; open.hidden = true; yes.focus();
  }, { small: true, 'data-action': 'end' });
  const closeAsk = () => { ask.hidden = true; yes.hidden = true; no.hidden = true; open.hidden = false; };

  const head = h('header', { class: 'ho-bar' });
  const row = h('div', { class: 'ho-bar__row' });
  if (deps.onBack) row.append(button('Back', 'ghost', () => { ended = true; stopRound?.(); clock.dispose(); deps.onBack?.(); }, { small: true, 'data-action': 'back', 'aria-label': 'Back to the list' }));
  row.append(
    h('div', { class: 'ho-bar__title' }, h('span', { class: 'ho-eyebrow' }, `Hands On · ${engine.label}`), h('h1', { class: 'ho-bar__name' }, entry.title)),
    h('div', { class: 'ho-bar__side' }, progress, dots));
  head.append(row);

  const main = h('main', { class: 'ho-main' });
  if (deps.reason) main.append(h('p', { class: 'ho-reason', 'data-role': 'reason' }, deps.reason));
  main.append(stage, h('div', { class: 'ho-end' }, open, ask, yes, no));
  root.append(h('div', { class: 'ho-root', 'data-view': 'activity', 'data-rung': String(rung) }, head, main, after));

  const mark = () => {
    progress.textContent = `${names[rung]} · round ${Math.min(round + 1, ROUNDS)} of ${ROUNDS}`;
    [...dots.children].forEach((dot, i) => {
      (dot as HTMLElement).dataset.state = i < results.length ? (results[i].met ? 'met' : 'miss') : i === round ? 'current' : 'todo';
    });
  };

  function begin() {
    if (ended) return;
    empty(stage);
    after.hidden = true;
    mark();
    const task = engine.prepare(spec, `${seed}:${round}`, rung);
    let handed = false;
    stopRound = engine.view(stage, task, (attempt) => {
      if (handed || ended) return;
      handed = true;
      const r = engine.result(task, attempt);
      results.push(r);
      verdict.textContent = r.met ? 'Right.' : 'Not this time.';
      why.textContent = r.why;
      next.textContent = round + 1 < ROUNDS ? 'Next round' : 'Finish';
      after.hidden = false;
      mark();
    });
  }

  function advance() {
    stopRound?.();
    stopRound = undefined;
    if (round + 1 < ROUNDS) { round++; begin(); stage.scrollIntoView({ block: 'start' }); } else { void finish(true); }
  }

  async function finish(completed: boolean) {
    if (ended) return;
    ended = true;
    stopRound?.();
    clock.stop();
    const report: PracticeResult = buildReport({ activityId: entry.id, skill, rung, rounds: results, finished: completed, fixed: fixed !== null, rungNames: names, creditFrom: creditFrom(engine.id) });
    if (completed) {
      const met = results.filter((r) => r.met).length;
      const writes: Array<Promise<unknown>> = [store.set(doneKey(entry.id), JSON.stringify({ met, total: results.length, at: Date.now(), valid: true }))];
      if (fixed === null) writes.push(store.set(rungKey(family), String(nextRung(rung, passed(results)))));
      await Promise.allSettled(writes);
    }
    clock.dispose();
    host.complete({ completed, elapsedSeconds: Math.max(0, Math.min(86400, Math.round(clock.seconds()))), practice: report });
  }

  clock.start();
  begin();
}
