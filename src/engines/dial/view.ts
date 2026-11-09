/**
 * Dial, the view: draws one round and hands the attempt back.
 *
 *   ask     the change is announced and the curve is shown as it is now. The student commits by touching something:
 *           picking a direction (rung 0), dragging the ghost point (rung 1) or typing a value (rung 2).
 *   reveal  the true curve slides into place over the guess, and the gap is shown.
 *   play    every parameter has a live slider, and the curve follows the hand. The attempt is handed back as the reveal ends,
 *           so the sentence on why arrives while the student is still playing.
 */
import { reducedMotion, type Engine } from '../../engine';
import { button, h } from '../../dom';
import { perFrame, tween } from '../../motion';
import { Curve, Marker, Plot, Segment } from '../../plot';
import { fmt, fromUnit, toUnit, withUnit } from '../../scale';
import {
  blend, gapSentence, issues, prepare, readTyped, result, spotFor, yAxis,
  type DialAttempt, type DialSpec, type DialTask, type Direction,
} from './logic';

const DIRECTIONS: Array<[Direction, string]> = [['up', 'Rises'], ['down', 'Falls'], ['same', 'Stays about the same']];
const SLIDER_STEPS = 1000;

const axisTitle = (name: string, symbol: string | undefined, unit: string) => {
  const head = symbol && symbol !== name ? `${name}, ${symbol}` : name;
  return unit ? `${head} (${unit.replace(/\^\(?(-?\d+)\)?/g, '^$1')})` : head;
};

function view(root: HTMLElement, task: DialTask, done: (attempt: DialAttempt) => void): () => void {
  const { spec, model, rung } = task;
  const xa = spec.x;
  const ya = yAxis(spec);
  const stops: Array<() => void> = [];
  const timers: number[] = [];
  let phase: 'ask' | 'reveal' | 'play' = 'ask';
  let attempt: DialAttempt | null = null;
  let current = task.before.slice();
  let freeze: () => void = () => undefined;

  const wrap = h('div', { class: 'ho-dial', 'data-engine': 'dial', 'data-rung': String(rung), 'data-phase': 'ask' });
  root.append(wrap);

  // ── What changed, and what is asked ────────────────────────────────────────
  const values = h('ul', { class: 'ho-values', 'aria-label': 'Values now' });
  spec.parameters.forEach((p, i) => {
    const changed = i === task.changed;
    values.append(h('li', { class: 'ho-values__item', 'data-changed': String(changed) },
      h('span', { class: 'ho-values__sym' }, p.symbol),
      h('span', { class: 'ho-values__val' }, changed ? `${withUnit(task.before[i], p.unit)} → ${withUnit(task.after[i], p.unit)}` : withUnit(task.before[i], p.unit))));
  });
  wrap.append(
    h('p', { class: 'ho-announce', 'data-role': 'announce' }, task.announce),
    values,
    h('p', { class: 'ho-question', 'data-role': 'question' }, task.question),
  );

  // ── The plot ───────────────────────────────────────────────────────────────
  const card = h('div', { class: 'ho-card' });
  wrap.append(card);
  const plot = new Plot(card, { ...xa, title: axisTitle(xa.name, xa.symbol, xa.unit) }, { ...ya, title: axisTitle(spec.y.name, spec.y.symbol, spec.y.unit) }, `${spec.y.name} against ${xa.name}`);
  stops.push(() => plot.destroy());

  const ghost = new Curve(plot, 'ho-curve--ghost');
  const live = new Curve(plot, 'ho-curve--live');
  live.set((x) => model.y(x, current));
  ghost.show(false);

  const quantity = task.measure !== 'y';
  const levelLine = new Segment(plot, 'ho-level');
  const atLine = new Segment(plot, 'ho-atline');
  const moveLine = new Segment(plot, 'ho-move');
  const gapLine = new Segment(plot, 'ho-gap');
  moveLine.show(false); gapLine.show(false);
  const placeLines = (p: readonly number[]) => {
    if (quantity) {
      const lvl = model.level(task.measure, p);
      levelLine.set(xa.min, lvl, xa.max, lvl);
      atLine.show(false);
    } else {
      levelLine.show(false);
      atLine.set(task.at as number, ya.min, task.at as number, ya.max);
    }
  };
  // Before the answer, a quantity's level line sits where the student's point will move along.
  placeLines(rung === 1 && quantity ? task.after : task.before);

  const now = new Marker(plot, { kind: 'now', tag: 'now', label: 'Where it is now' });
  now.set(task.track.before.x, task.track.before.y);
  const guess = new Marker(plot, { kind: 'ring', tag: 'you', label: 'Your answer' });
  guess.show(false);
  const truth = new Marker(plot, { kind: 'disc', label: 'Where it lands' });
  truth.show(false);
  const probe = new Marker(plot, { kind: 'now' });
  probe.show(false);
  probe.g.classList.add('ho-probe');
  probe.g.setAttribute('aria-hidden', 'true');

  const readout = h('p', { class: 'ho-readout', 'data-role': 'readout' }, '');
  const formula = h('p', { class: 'ho-formula', 'data-role': 'formula' }, spec.formula ?? `${spec.y.symbol ?? spec.y.name} = ${spec.expression}`);
  const note = spec.note ? h('p', { class: 'ho-note' }, spec.note) : null;
  wrap.append(h('div', { class: 'ho-under' }, formula, note, readout));

  // ── Asking ─────────────────────────────────────────────────────────────────
  const controls = h('div', { class: 'ho-controls', 'data-role': 'controls' });
  wrap.append(controls);
  const status = h('p', { class: 'mnx-feedback ho-gapnote', role: 'status', 'data-role': 'gap' });
  wrap.append(status);

  const spotText = (x: number, y: number) => (quantity ? withUnit(x, xa.unit) : withUnit(y, spec.y.unit));
  const lock = (a: DialAttempt) => {
    if (phase !== 'ask') return;
    phase = 'reveal';
    attempt = a;
    wrap.dataset.phase = 'reveal';
    for (const el of controls.querySelectorAll<HTMLElement>('button, input')) (el as HTMLButtonElement).disabled = true;
    if (rung > 0) controls.hidden = true;
    now.setTag(rung === 0 ? 'was' : '');
    startReveal(a);
  };

  if (rung === 0) {
    const box = h('div', { class: 'mnx-choices ho-choices', role: 'group', 'aria-label': 'Your prediction' });
    DIRECTIONS.forEach(([d, label], i) => {
      box.append(h('button', {
        type: 'button', class: 'mnx-choice', 'data-choice': d, 'aria-pressed': 'false',
        onclick: () => { box.querySelector(`[data-choice=${d}]`)?.setAttribute('aria-pressed', 'true'); lock({ kind: 'pick', pick: d }); },
      }, h('span', { class: 'mnx-choice__key' }, String(i + 1)), h('span', { class: 'mnx-choice__text' }, label)));
    });
    controls.append(box);
    const keys = (ev: KeyboardEvent) => {
      if (phase !== 'ask' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const i = ['1', '2', '3'].indexOf(ev.key);
      if (i >= 0 && !(ev.target instanceof HTMLInputElement)) (box.children[i] as HTMLButtonElement).click();
    };
    document.addEventListener('keydown', keys);
    stops.push(() => document.removeEventListener('keydown', keys));
  } else if (rung === 1) {
    // The ghost point starts where the thing is now and moves along the line it can land on.
    const axis = quantity ? 'x' : 'y';
    const start = task.track.before;
    guess.show(true);
    guess.set(start.x, quantity ? task.track.after.y : start.y);
    guess.g.classList.add('ho-pulse');
    const stopDrag = guess.drag({
      axis,
      guides: true,
      valueText: (x, y) => spotText(x, y),
      onMove: () => { guess.g.classList.remove('ho-pulse'); readout.textContent = ''; },
      onCommit: () => commitGuess(),
    });
    freeze = stopDrag;
    stops.push(stopDrag);
    const commitGuess = () => lock({ kind: 'place', value: quantity ? guess.x : guess.y });
    // Pressing anywhere on the plot picks the point up there, so it never has to be found first.
    const pick = (ev: PointerEvent) => {
      if (phase !== 'ask' || (ev.target as Element).closest('.ho-m')) return;
      const at = plot.pointer(ev);
      if (at.x < plot.left || at.x > plot.right || at.y < plot.top || at.y > plot.bottom) return;
      guess.g.classList.remove('ho-pulse');
      guess.grab(ev);
    };
    plot.svg.addEventListener('pointerdown', pick);
    stops.push(() => plot.svg.removeEventListener('pointerdown', pick));
    controls.append(
      h('p', { class: 'ho-hint' }, 'Drag the ring, or press on the plot. The arrow keys nudge it.'),
      button('Lock in', 'primary', commitGuess, { 'data-action': 'lock' }),
    );
  } else {
    const input = h('input', {
      type: 'text', class: 'mnx-input ho-answer', 'data-role': 'answer', autocomplete: 'off', spellcheck: 'false',
      placeholder: task.unit ? `for example 12 ${task.unit.replace(/\^\(?(-?\d+)\)?/g, '^$1')}` : 'for example 0.35', 'aria-label': 'Your answer with its unit',
    }) as HTMLInputElement;
    const problem = h('p', { class: 'mnx-help mnx-help--error', role: 'alert', hidden: true, 'data-role': 'problem' });
    const preview = h('p', { class: 'ho-preview', 'data-role': 'preview' }, '');
    const submit = () => {
      const r = readTyped(task, input.value);
      if (!r.ok) { problem.textContent = r.problem; problem.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      problem.hidden = true;
      lock({ kind: 'type', value: r.value, text: input.value.trim() });
    };
    input.addEventListener('input', () => {
      problem.hidden = true; input.removeAttribute('aria-invalid');
      const r = readTyped(task, input.value);
      preview.textContent = r.ok && input.value.trim() ? `Read as ${withUnit(r.value, task.unit)}` : '';
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    controls.append(
      h('div', { class: 'mnx-field ho-answerrow' },
        h('label', { class: 'mnx-label', for: 'ho-answer' }, 'Your answer'),
        h('div', { class: 'mnx-row ho-answerline' }, input, button('Check', 'primary', submit, { 'data-action': 'check' })),
        preview, problem),
    );
    input.id = 'ho-answer';
    timers.push(window.setTimeout(() => input.focus({ preventScroll: true }), 50));
  }

  // ── Revealing ──────────────────────────────────────────────────────────────
  function startReveal(a: DialAttempt) {
    freeze();
    const verdict = result(task, a);
    // Where the student's answer sits on the plot (rung 1 already has it there).
    if (a.kind === 'type') {
      guess.show(true);
      guess.set(quantity ? a.value : task.track.before.x, quantity ? task.track.after.y : a.value);
    } else if (a.kind === 'place') {
      guess.g.classList.remove('ho-pulse');
    }
    if (a.kind !== 'pick') {
      guess.setTag(`you: ${spotText(guess.x, guess.y)}${guess.g.dataset.clamped === 'true' ? ' (off the chart)' : ''}`);
      guess.g.dataset.state = verdict.met ? 'met' : 'miss';
    }
    ghost.set((x) => model.y(x, task.before));
    ghost.show(true);
    truth.show(true);
    truth.set(task.track.before.x, task.track.before.y);
    stops.push(tween(reducedMotion() ? 0 : 950, (t) => {
      current = blend(task, t);
      live.draw();
      const s = spotFor(task, current);
      truth.set(s.x, s.y);
      placeLines(current);
    }, () => finishReveal(a, verdict.met)));
  }

  function finishReveal(a: DialAttempt, met: boolean) {
    current = task.after.slice();
    live.draw();
    const s = spotFor(task, current);
    truth.set(s.x, s.y);
    truth.setTag(`true: ${spotText(s.x, s.y)}`);
    placeLines(current);
    if (a.kind === 'pick') {
      moveLine.set(task.track.before.x, task.track.before.y, s.x, s.y);
      moveLine.show(true);
      const chosen = wrap.querySelector<HTMLElement>(`[data-choice=${a.pick}]`);
      const right = wrap.querySelector<HTMLElement>(`[data-choice=${task.direction}]`);
      if (chosen) chosen.dataset.state = met ? 'correct' : 'incorrect';
      if (right && !met) right.dataset.state = 'correct';
    } else {
      gapLine.line.classList.toggle('ho-gap--met', met);
      gapLine.line.classList.toggle('ho-gap--miss', !met);
      gapLine.set(guess.x, guess.y, s.x, s.y);
      gapLine.show(true);
    }
    arrange();
    status.textContent = gapSentence(task, a);
    status.classList.add(met ? 'mnx-feedback--correct' : 'mnx-feedback--incorrect');
    buildSliders();
    phase = 'play';
    wrap.dataset.phase = 'play';
    stops.push(enableProbe());
    timers.push(window.setTimeout(() => {
      done(a);
      wrap.querySelector('[data-role=sliders]')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, reducedMotion() ? 0 : 420));
  }

  // ── Playing ────────────────────────────────────────────────────────────────
  /** Keep the tags of the points on the answer apart: the true point's tag goes on the side away from the other points. */
  function arrange() {
    const t = truth.pixel();
    const others = [guess, now].filter((m) => m.visible && m.g.getAttribute('transform')).map((m) => m.pixel());
    const above = others.length ? others.reduce((n, o) => n + (o.y <= t.y ? 1 : 0), 0) * 2 >= others.length : false;
    truth.tagSide = above ? 'below' : 'above';
    guess.tagSide = above ? 'above' : 'below';
    now.tagSide = guess.visible ? (above ? 'above' : 'below') : above ? 'above' : 'below';
    for (const m of [truth, guess, now]) m.place();
  }
  plot.onLayout(() => { if (phase !== 'ask') arrange(); });
  /** True while every dial is where the change put it, so the point is the true answer and not something being tried. */
  const atAnswer = () => current.every((v, i) => Math.abs(v - task.after[i]) <= 1e-9 * Math.abs(task.after[i]));
  const refresh = perFrame(() => {
    live.draw();
    const s = spotFor(task, current);
    truth.set(s.x, s.y);
    truth.setTag(`${atAnswer() ? 'true' : 'now'}: ${spotText(s.x, s.y)}`);
    placeLines(current);
    arrange();
    if (attempt && attempt.kind !== 'pick') gapLine.set(guess.x, guess.y, s.x, s.y);
    if (attempt && attempt.kind === 'pick') moveLine.set(task.track.before.x, task.track.before.y, s.x, s.y);
  });

  function buildSliders() {
    const panel = h('section', { class: 'ho-play', 'aria-label': 'Try it yourself', 'data-role': 'sliders' });
    const head = h('div', { class: 'ho-play__head' }, h('h2', { class: 'ho-play__title' }, 'Now turn the dials'));
    const rows = h('div', { class: 'ho-play__rows' });
    const bits: Array<{ input: HTMLInputElement; out: HTMLElement; was: HTMLElement; i: number }> = [];
    const paint = (b: { input: HTMLInputElement; out: HTMLElement; was: HTMLElement; i: number }) => {
      const p = spec.parameters[b.i];
      b.out.textContent = withUnit(current[b.i], p.unit);
      b.input.style.setProperty('--fill', `${(toUnit(p, current[b.i]) * 100).toFixed(1)}%`);
      b.input.setAttribute('aria-valuetext', `${p.name} ${withUnit(current[b.i], p.unit)}`);
      b.was.textContent = Math.abs(current[b.i] - task.before[b.i]) < 1e-12 * Math.abs(task.before[b.i]) ? '' : `was ${withUnit(task.before[b.i], p.unit)}`;
    };
    spec.parameters.forEach((p, i) => {
      const id = `ho-p-${i}`;
      const input = h('input', {
        type: 'range', class: 'ho-range', id, min: 0, max: SLIDER_STEPS, step: 1,
        value: Math.round(toUnit(p, current[i]) * SLIDER_STEPS), 'data-param': p.symbol, 'aria-label': `${p.name}, ${p.symbol}`,
      }) as HTMLInputElement;
      const out = h('output', { class: 'ho-play__out', for: id });
      const was = h('span', { class: 'ho-play__was' });
      const bit = { input, out, was, i };
      bits.push(bit);
      input.addEventListener('input', () => {
        current[i] = fromUnit(p, Number(input.value) / SLIDER_STEPS);
        paint(bit);
        refresh();
      });
      rows.append(h('div', { class: 'ho-play__row', 'data-changed': String(i === task.changed) },
        h('label', { class: 'ho-play__label', for: id }, h('span', { class: 'ho-play__sym' }, p.symbol), h('span', { class: 'ho-play__name' }, p.name)),
        input, h('span', { class: 'ho-play__value' }, out, was)));
      paint(bit);
    });
    head.append(button('Back to the answer', 'ghost', () => {
      const from = current.slice();
      stops.push(tween(reducedMotion() ? 0 : 320, (t) => {
        current = from.map((v, k) => v + (task.after[k] - v) * t);
        for (const b of bits) { b.input.value = String(Math.round(toUnit(spec.parameters[b.i], current[b.i]) * SLIDER_STEPS)); paint(b); }
        refresh();
      }));
    }, { small: true, 'data-action': 'reset' }));
    panel.append(head, rows);
    wrap.append(panel);
  }

  /** Hovering or pressing on the plot reads the curve at that x. */
  function enableProbe() {
    const at = (ev: PointerEvent) => {
      const p = plot.pointer(ev);
      if (p.x < plot.left || p.x > plot.right || p.y < plot.top - 6 || p.y > plot.bottom + 6) { leave(); return; }
      const x = plot.dataX(p.x);
      const y = model.y(x, current);
      probe.show(true);
      probe.set(x, y);
      readout.textContent = `${xa.symbol} = ${withUnit(x, xa.unit)}, ${spec.y.symbol ?? spec.y.name} = ${withUnit(y, spec.y.unit)}`;
    };
    const leave = () => { probe.show(false); readout.textContent = ''; };
    plot.svg.addEventListener('pointermove', at);
    plot.svg.addEventListener('pointerdown', at);
    plot.svg.addEventListener('pointerleave', leave);
    return () => {
      plot.svg.removeEventListener('pointermove', at);
      plot.svg.removeEventListener('pointerdown', at);
      plot.svg.removeEventListener('pointerleave', leave);
    };
  }

  return () => {
    for (const t of timers) clearTimeout(t);
    for (const stop of stops.reverse()) stop();
    wrap.remove();
  };
}

export const dial: Engine<DialSpec, DialTask, DialAttempt> = {
  id: 'dial',
  label: 'Dial',
  rungNames: ['Which way', 'How far', 'The number'],
  issues,
  prepare,
  view,
  result,
};

