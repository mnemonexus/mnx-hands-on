/**
 * Find the Error, the view: a short passage, one sentence of which may be false.
 *
 *   ask     tap the sentence you think is wrong, or say that none is.
 *   repair  if you found it, pick what it should say from three.
 *   reveal  the false sentence is struck through and the true one written in beside it. A true sentence you tapped stays
 *           marked, so your guess sits next to the truth. The run always ends on the true version.
 */
import { reducedMotion, type Engine } from '../../engine';
import { button, h } from '../../dom';
import './spot.css';
import { foundIt, issues, needsRepair, prepare, result, type SpotAttempt, type SpotSpec, type SpotTask } from './logic';

function view(root: HTMLElement, task: SpotTask, done: (attempt: SpotAttempt) => void): () => void {
  let stopped = false;
  let phase: 'ask' | 'repair' | 'reveal' = 'ask';
  let pick: number | null = null;
  const timers: number[] = [];
  const stop: Array<() => void> = [];
  const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(() => { if (!stopped) fn(); }, reducedMotion() ? 0 : ms)); };

  const wrap = h('div', { class: 'ho-spot', 'data-engine': 'spot', 'data-rung': String(task.rung), 'data-phase': 'ask' });
  root.append(wrap);
  const intro = h('p', { class: 'ho-announce', 'data-role': 'announce' }, task.spec.intro ?? 'One sentence in this passage may be false. Tap it, or say that nothing is wrong.');
  const passage = h('p', { class: 'ho-spot-passage', 'data-role': 'passage' });
  const spans: HTMLElement[] = task.sentences.map((s, i) => {
    const el = h('span', {
      class: 'ho-spot-s', role: 'button', tabindex: '0', 'data-sentence': String(i),
      onclick: () => choose(i),
      onkeydown: (ev: Event) => { const k = (ev as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { ev.preventDefault(); choose(i); } },
    }, s.t);
    passage.append(el, ' ');
    return el;
  });
  const none = button('Nothing here is wrong', 'secondary', () => choose(null), { 'data-action': 'none' });
  const actions = h('div', { class: 'ho-spot-actions' }, none);
  const note = h('p', { class: 'ho-spot-note', role: 'status', 'data-role': 'note' });
  const repairBox = h('div', { class: 'ho-spot-repair', 'data-role': 'repair', hidden: true });
  wrap.append(intro, passage, actions, note, repairBox);

  function lock(el: HTMLElement | null) {
    for (const s of spans) { s.setAttribute('aria-disabled', 'true'); s.removeAttribute('tabindex'); }
    none.disabled = true;
    el?.classList.add('ho-spot-s--picked');
  }

  function choose(i: number | null) {
    if (phase !== 'ask' || stopped) return;
    pick = i;
    lock(i === null ? null : spans[i]);
    if (i === null) none.setAttribute('aria-pressed', 'true');
    if (needsRepair(task, { pick: i })) {
      phase = 'repair';
      wrap.dataset.phase = 'repair';
      note.textContent = 'Yes, that sentence is false.';
      note.dataset.kind = 'hint';
      askRepair();
    } else reveal({ pick: i });
  }

  function askRepair() {
    repairBox.hidden = false;
    repairBox.append(h('p', { class: 'ho-spot-ask' }, 'What should it say instead?'));
    const group = h('div', { class: 'mnx-choices ho-choices', role: 'group', 'aria-label': 'What it should say' });
    task.options.forEach((o, i) => {
      group.append(h('button', {
        type: 'button', class: 'mnx-choice', 'data-choice': String(i), 'data-right': String(o.right), 'aria-pressed': 'false',
        onclick: () => pickRepair(i),
      }, h('span', { class: 'mnx-choice__key' }, String(i + 1)), h('span', { class: 'mnx-choice__text' }, o.t)));
    });
    repairBox.append(group);
    const keys = (ev: KeyboardEvent) => {
      if (phase !== 'repair' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const i = Number(ev.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < task.options.length) pickRepair(i);
    };
    document.addEventListener('keydown', keys);
    stop.push(() => document.removeEventListener('keydown', keys));
    repairBox.scrollIntoView?.({ block: 'nearest' });
  }

  function pickRepair(i: number) {
    if (phase !== 'repair') return;
    for (const b of repairBox.querySelectorAll<HTMLButtonElement>('.mnx-choice')) b.disabled = true;
    const chosen = repairBox.querySelector(`[data-choice="${i}"]`);
    chosen?.setAttribute('aria-pressed', 'true');
    chosen?.classList.add('ho-spot-choice--yours');
    reveal({ pick: pick as number, repair: i });
  }

  function reveal(attempt: SpotAttempt) {
    phase = 'reveal';
    wrap.dataset.phase = 'reveal';
    for (const b of repairBox.querySelectorAll<HTMLElement>('.mnx-choice')) b.dataset.reveal = b.dataset.right === 'true' ? 'right' : 'wrong';
    if (task.falseAt >= 0) {
      const bad = spans[task.falseAt];
      bad.classList.add('ho-spot-s--false');
      bad.after(' ', h('ins', { class: 'ho-spot-fix', 'data-role': 'fix' }, task.correction));
    }
    if (typeof attempt.pick === 'number' && attempt.pick !== task.falseAt) {
      spans[attempt.pick].classList.add('ho-spot-s--yours');
      spans[attempt.pick].append(h('span', { class: 'ho-spot-tag' }, 'You tapped this one. It is true.'));
    }
    if (task.falseAt < 0) {
      const ok = foundIt(task, attempt);
      note.textContent = ok ? 'Right: every sentence is true.' : 'Every sentence here was true.';
      note.dataset.kind = ok ? 'hint' : 'wrong';
    } else if (attempt.pick === task.falseAt) {
      const ok = attempt.repair !== undefined && task.options[attempt.repair]?.right;
      note.textContent = ok ? 'Right: that is the true version.' : 'That was the false sentence, but not the true version.';
      note.dataset.kind = ok ? 'hint' : 'wrong';
    } else if (attempt.pick === null) {
      note.textContent = 'You said nothing was wrong, but one sentence was false.';
      note.dataset.kind = 'wrong';
    } else {
      note.textContent = 'That sentence is true. The false one is struck through.';
      note.dataset.kind = 'wrong';
    }
    later(() => done(attempt), 500);
  }

  const keys = (ev: KeyboardEvent) => {
    if (phase !== 'ask' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key.toLowerCase() === 'n') choose(null);
  };
  document.addEventListener('keydown', keys);
  stop.push(() => document.removeEventListener('keydown', keys));

  return () => { stopped = true; for (const s of stop) s(); for (const t of timers) clearTimeout(t); };
}

export const spot: Engine<SpotSpec, SpotTask, SpotAttempt> = {
  id: 'spot',
  label: 'Find the Error',
  rungNames: ['A short passage', 'A longer passage', 'Close sentences'],
  issues,
  prepare,
  view,
  result,
};
