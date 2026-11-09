/**
 * Choose Your Controls, the view: a result is shown with rival explanations, and the student picks which extra conditions to
 * run, within a number of slots.
 *
 *   ask     the result, the explanations and the conditions. The student commits by choosing conditions (rungs 1 and 2) or by
 *           saying what each given condition is for (rung 0). Nothing is revealed first.
 *   reveal  the chosen conditions run one after another and a grid fills in, a column at a time. Each pair of explanations
 *           turns from undecided to told apart as a column that separates it lands, or stays stuck.
 *   after   a set that tells everything apart says so; one that leaves two rows identical says what still cannot be told.
 */
import { reducedMotion, type Engine } from '../../engine';
import { button, h } from '../../dom';
import './controls.css';
import {
  issues, outcomeWords, pairsOf, prepare, result, smallestSets, verdictOf,
  type ControlsAttempt, type ControlsSpec, type ControlsTask, type Outcome,
} from './logic';

const letter = (i: number) => String.fromCharCode(65 + i);
const MARK: Record<Outcome, string> = { signal: 'signal', none: 'none', reduced: '▼ reduced', increased: '▲ increased' };

function view(root: HTMLElement, task: ControlsTask, done: (attempt: ControlsAttempt) => void): () => void {
  const { spec, grid: g } = task;
  const timers: number[] = [];
  let phase: 'ask' | 'reveal' | 'after' = 'ask';
  const chosen: number[] = [];
  const answers: number[] = task.questions.map(() => -1);

  const wrap = h('div', { class: 'ho-ctl', 'data-engine': 'controls', 'data-rung': String(task.rung), 'data-phase': 'ask' });
  root.append(wrap);

  // ── What was seen, and the rival explanations ──────────────────────────────
  wrap.append(h('p', { class: 'ho-announce', 'data-role': 'announce' }, task.announce));
  wrap.append(h('section', { class: 'ho-ctl__seen', 'data-role': 'seen', 'aria-label': 'What was seen' },
    h('span', { class: 'ho-eyebrow' }, 'What was seen'),
    h('p', { class: 'ho-ctl__title' }, spec.result.title),
    spec.result.detail ? h('p', { class: 'ho-ctl__detail' }, spec.result.detail) : null));
  const hyps = h('ol', { class: 'ho-ctl__hyps', 'aria-label': 'Rival explanations', 'data-role': 'hypotheses' });
  g.hyps.forEach((hy, i) => hyps.append(h('li', { class: 'ho-ctl__hyp', 'data-hyp': String(i) }, h('span', { class: 'ho-ctl__letter' }, letter(i)), h('span', { class: 'ho-ctl__hypname' }, hy.name))));
  wrap.append(h('div', { class: 'ho-ctl__block' }, h('span', { class: 'ho-eyebrow' }, 'Possible explanations'), hyps));
  wrap.append(h('p', { class: 'ho-question', 'data-role': 'question' }, task.question));

  // ── The conditions ─────────────────────────────────────────────────────────
  const run = button('Run', 'primary', () => start(), { 'data-action': 'run', disabled: true });
  const counter = h('p', { class: 'ho-ctl__count', 'data-role': 'count', 'aria-live': 'polite' }, '');
  const hint = h('p', { class: 'ho-hint', 'data-role': 'runhint' }, '');
  const list = h('div', { class: 'ho-ctl__conds', 'data-role': 'conditions' });

  if (task.rung === 0) {
    task.questions.forEach((q, qi) => {
      const cond = g.conds[q.cond];
      const group = h('div', { class: 'mnx-choices ho-choices ho-ctl__purposes', role: 'group', 'aria-label': q.prompt });
      q.options.forEach((o, oi) => group.append(h('button', {
        type: 'button', class: 'mnx-choice', 'data-purpose': `${qi}:${oi}`, 'aria-pressed': 'false',
        onclick: () => {
          if (phase !== 'ask') return;
          answers[qi] = oi;
          group.querySelectorAll('button').forEach((b, k) => b.setAttribute('aria-pressed', String(k === oi)));
          sync();
        },
      }, h('span', { class: 'mnx-choice__text' }, o.label))));
      list.append(h('section', { class: 'ho-ctl__cond ho-ctl__cond--given', 'data-cond': String(q.cond) },
        h('p', { class: 'ho-ctl__condname' }, cond.name),
        cond.detail ? h('p', { class: 'ho-ctl__condetail' }, cond.detail) : null,
        h('p', { class: 'ho-ctl__prompt' }, q.prompt), group));
    });
  } else {
    g.conds.forEach((cond, ci) => {
      list.append(h('button', {
        type: 'button', class: 'ho-ctl__cond ho-ctl__cond--pick', 'data-cond': String(ci), 'aria-pressed': 'false',
        onclick: () => toggle(ci),
      }, h('span', { class: 'ho-ctl__tick', 'aria-hidden': 'true' }),
      h('span', { class: 'ho-ctl__condbody' }, h('span', { class: 'ho-ctl__condname' }, cond.name),
        cond.detail ? h('span', { class: 'ho-ctl__condetail' }, cond.detail) : null)));
    });
  }
  wrap.append(h('div', { class: 'ho-ctl__block' },
    h('div', { class: 'ho-ctl__head' }, h('span', { class: 'ho-eyebrow' }, task.rung === 0 ? 'Conditions to run' : 'Conditions you could run'), counter),
    list));

  function toggle(ci: number) {
    if (phase !== 'ask') return;
    const at = chosen.indexOf(ci);
    if (at >= 0) chosen.splice(at, 1);
    else if (chosen.length >= task.slots) { hint.textContent = `All ${task.slots} slots are used. Take one off first.`; return; }
    else chosen.push(ci);
    sync();
  }

  function sync() {
    if (phase !== 'ask') return;
    if (task.rung === 0) {
      const left = answers.filter((a) => a < 0).length;
      run.disabled = left > 0;
      counter.textContent = `${task.questions.length - left} of ${task.questions.length} answered`;
      hint.textContent = left ? 'Say what each one is for, then run them.' : '';
    } else {
      list.querySelectorAll<HTMLElement>('.ho-ctl__cond--pick').forEach((el) => {
        const on = chosen.includes(Number(el.dataset.cond));
        el.setAttribute('aria-pressed', String(on));
        el.dataset.full = String(!on && chosen.length >= task.slots);
      });
      run.disabled = chosen.length === 0;
      counter.textContent = `${chosen.length} of ${task.slots} slots used`;
      hint.textContent = chosen.length === 0 ? 'Choose the conditions you would run.' : '';
    }
  }

  wrap.append(h('div', { class: 'ho-controls', 'data-role': 'controls' }, hint, h('div', { class: 'ho-runrow' }, run)));

  // ── The grid that fills in ─────────────────────────────────────────────────
  const gridBox = h('section', { class: 'ho-ctl__resultbox', 'data-role': 'grid', hidden: true, 'aria-label': 'What each explanation would show' });
  const table = h('table', { class: 'ho-ctl__grid' });
  const pairList = h('ul', { class: 'ho-ctl__pairs', 'aria-label': 'Which explanations are told apart', 'data-role': 'pairs' });
  const status = h('p', { class: 'mnx-feedback ho-gapnote', role: 'status', 'data-role': 'gap', hidden: true });
  const fewest = h('p', { class: 'ho-ctl__fewest', 'data-role': 'fewest', hidden: true });
  gridBox.append(table, pairList);
  wrap.append(gridBox, status, fewest);

  function start() {
    if (phase !== 'ask') return;
    const order = task.rung === 0 ? task.strong.slice() : chosen.slice();
    if (!order.length) return;
    phase = 'reveal';
    wrap.dataset.phase = 'reveal';
    run.hidden = true; hint.hidden = true;
    for (const b of wrap.querySelectorAll<HTMLButtonElement>('.ho-ctl__cond button, button.ho-ctl__cond')) b.disabled = true;
    const attempt: ControlsAttempt = task.rung === 0 ? { kind: 'purposes', answers: answers.slice() } : { kind: 'set', chosen: order };
    const verdict = result(task, attempt);
    if (task.rung === 0) task.questions.forEach((q, qi) => {
      const group = list.querySelectorAll<HTMLElement>('.ho-ctl__purposes')[qi];
      group.querySelectorAll<HTMLElement>('button').forEach((b, oi) => {
        const o = q.options[oi];
        if (answers[qi] === oi) b.dataset.state = o.correct ? 'correct' : 'incorrect';
        else if (o.correct && !q.options[answers[qi]]?.correct) b.dataset.state = 'correct';
      });
    });
    play(order, attempt, verdict.met, verdict.why);
  }

  function play(order: number[], attempt: ControlsAttempt, met: boolean, why: string) {
    gridBox.hidden = false;
    const head = h('tr', null, h('th', { scope: 'col', class: 'ho-ctl__corner' }, 'If this is true'));
    for (const ci of order) head.append(h('th', { scope: 'col', class: 'ho-ctl__colhead', 'data-col': String(ci) }, h('span', { class: 'ho-ctl__colname' }, g.conds[ci].name), h('span', { class: 'ho-ctl__flag', hidden: true }, 'Same for every explanation')));
    table.append(h('thead', null, head));
    const body = h('tbody');
    g.hyps.forEach((hy, hi) => {
      const row = h('tr', { 'data-hyp': String(hi) }, h('th', { scope: 'row', class: 'ho-ctl__rowhead' }, h('span', { class: 'ho-ctl__letter' }, letter(hi)), h('span', null, hy.name)));
      for (const ci of order) row.append(h('td', { class: 'ho-ctl__cell', 'data-col': String(ci), 'data-filled': 'false' }, h('span', { class: 'ho-ctl__out' }, '·')));
      body.append(row);
    });
    table.append(body);
    const pairs = pairsOf(g.hyps.length);
    pairs.forEach((p, k) => pairList.append(h('li', { class: 'ho-ctl__pair', 'data-pair': String(k), 'data-state': 'open' },
      h('span', { class: 'ho-ctl__pairname' }, `${letter(p[0])} or ${letter(p[1])}`), h('span', { class: 'ho-ctl__pairstate' }, 'not yet told apart'))));

    const fillColumn = (ci: number, upTo: number[]) => {
      g.hyps.forEach((_, hi) => {
        const cell = table.querySelector<HTMLElement>(`tbody tr[data-hyp="${hi}"] td[data-col="${ci}"]`) as HTMLElement;
        const o = g.cell[ci][hi];
        cell.dataset.filled = 'true'; cell.dataset.outcome = o;
        const out = cell.firstElementChild as HTMLElement;
        out.textContent = MARK[o];
        cell.title = outcomeWords(g.conds[ci], o);
        cell.setAttribute('aria-label', `${g.hyps[hi].name}: ${outcomeWords(g.conds[ci], o)}`);
      });
      const headCell = table.querySelector<HTMLElement>(`thead th[data-col="${ci}"]`) as HTMLElement;
      if (g.cell[ci].every((o) => o === g.cell[ci][0])) { headCell.dataset.wasted = 'true'; (headCell.querySelector('.ho-ctl__flag') as HTMLElement).hidden = false; }
      const v = verdictOf(g, upTo);
      pairs.forEach((p, k) => {
        const item = pairList.children[k] as HTMLElement;
        const by = v.told[k].by;
        if (by.length) {
          item.dataset.state = 'told';
          (item.lastElementChild as HTMLElement).textContent = `told apart by ${g.conds[by[0]].name}`;
        }
      });
    };

    const finish = () => {
      const v = verdictOf(g, order);
      const pairsArr = pairsOf(g.hyps.length);
      v.stuck.forEach((p) => {
        const k = pairsArr.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
        const item = pairList.children[k] as HTMLElement;
        item.dataset.state = 'stuck';
        (item.lastElementChild as HTMLElement).textContent = 'looks the same';
        for (const hi of p) table.querySelector(`tbody tr[data-hyp="${hi}"]`)?.setAttribute('data-stuck', 'true');
      });
      phase = 'after';
      wrap.dataset.phase = 'after';
      status.hidden = false;
      if (met) {
        status.textContent = v.told.length === 1 ? 'That tells the two explanations apart.' : `That tells all ${g.hyps.length} explanations apart. Every pair of rows differs.`;
        status.className = 'mnx-feedback mnx-feedback--correct ho-gapnote';
      } else {
        status.textContent = why;
        status.className = 'mnx-feedback mnx-feedback--incorrect ho-gapnote';
      }
      if (task.rung !== 0 && !met) {
        const best = smallestSets(g)[0].map((c) => `"${g.conds[c].name}"`).join(' and ');
        fewest.textContent = `The fewest that would have done it: ${best}.`;
        fewest.hidden = false;
      }
      // The footer that follows gives the round's reason, so a lesson saying the same is not printed twice.
      if (result(task, attempt).why !== task.lesson) wrap.append(h('p', { class: 'ho-lesson', 'data-role': 'lesson' }, task.lesson));
      timers.push(window.setTimeout(() => {
        done(attempt);
        (wrap.querySelector('[data-role=lesson]') ?? status).scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }, reducedMotion() ? 0 : 250));
    };

    const so_far: number[] = [];
    if (reducedMotion()) {
      for (const ci of order) { so_far.push(ci); fillColumn(ci, so_far.slice()); }
      finish();
      return;
    }
    order.forEach((ci, k) => {
      timers.push(window.setTimeout(() => {
        table.querySelector(`thead th[data-col="${ci}"]`)?.setAttribute('data-running', 'true');
        timers.push(window.setTimeout(() => {
          so_far.push(ci);
          fillColumn(ci, so_far.slice());
          table.querySelector(`thead th[data-col="${ci}"]`)?.removeAttribute('data-running');
          if (k === order.length - 1) timers.push(window.setTimeout(finish, 350));
        }, 520));
      }, k * 700));
    });
  }

  sync();

  return () => {
    for (const t of timers) clearTimeout(t);
    wrap.remove();
  };
}

export const controls: Engine<ControlsSpec, ControlsTask, ControlsAttempt> = {
  id: 'controls',
  label: 'Choose Your Controls',
  rungNames: ['What a control is for', 'Choose with room', 'Choose with few slots'],
  issues,
  prepare,
  view,
  result,
};
