/**
 * Predict the Result, the view: draws one round and hands the attempt back.
 *
 *   ask     the sample is set out. The student commits on an empty result: bands dragged into lanes and set to faint, medium
 *           or dark (bands), or rings dragged up to draw a trace (trace). Nothing is revealed first.
 *   reveal  Run: the true result develops over the guess, which stays as a ghost, and what was missed is marked.
 *   after   one sentence for each mismatch, tied to a rule, and the guess can be hidden to see the result alone.
 *
 * The result is idealised: clean bands, no noise.
 */
import { reducedMotion, type Engine } from '../../engine';
import { button, empty, h } from '../../dom';
import { tween } from '../../motion';
import { Curve, Marker, Plot } from '../../plot';
import { clamp, fmt } from '../../scale';
import './predict.css';
import {
  ANCHORS, LEVEL_FROM, LEVEL_NAMES, STEPS, issues, judge, prepare, result, smooth, truthLine,
  type Band, type Mismatch, type PlacedBand, type PredictAttempt, type PredictSpec, type PredictTask, type TaskLane,
} from './logic';

const LEVEL_ALPHA = ['0', '0.3', '0.62', '1'];
const snap = (y: number) => Math.round(clamp(y, 0, 1) * STEPS) / STEPS;

/** What a skin hands back to the shared frame. */
interface Skin {
  attempt(): PredictAttempt;
  anyThing(): boolean;
  freeze(): void;
  /** Play the true result over the guess and call `end` when it has landed. Returns what stops it early. */
  reveal(mismatches: Mismatch[], end: () => void): () => void;
  showGuess(on: boolean): void;
  destroy(): void;
}

const laneWord = (i: number) => String(i + 1);

const KIND_RANK: Record<string, number> = { sample: 0, missing: 1, 'peak-missing': 1, extra: 1, 'peak-extra': 1, order: 2, larger: 3, darker: 3 };
/** The mismatches worth saying first: the ones that matter most, at most two, in different lanes where it can be. */
function headline(mism: Mismatch[]): Mismatch[] {
  const ranked = mism.map((m, k) => ({ m, k })).sort((a, c) => (KIND_RANK[a.m.kind] ?? 4) - (KIND_RANK[c.m.kind] ?? 4) || a.k - c.k).map((x) => x.m);
  const out: Mismatch[] = [];
  for (const m of ranked) if (out.length < 2 && !out.some((o) => o.lane === m.lane)) out.push(m);
  for (const m of ranked) if (out.length < 2 && !out.includes(m)) out.push(m);
  return out;
}
const laneNumber = (i: number) => `lane ${laneWord(i)}`;

function view(root: HTMLElement, task: PredictTask, done: (attempt: PredictAttempt) => void): () => void {
  const spec = task.spec;
  const stops: Array<() => void> = [];
  const timers: number[] = [];
  let phase: 'ask' | 'reveal' | 'after' = 'ask';
  let pick: number | undefined;

  const wrap = h('div', { class: 'ho-predict', 'data-engine': 'predict', 'data-skin': task.skin, 'data-rung': String(task.rung), 'data-phase': 'ask' });
  root.append(wrap);

  // ── The setup ──────────────────────────────────────────────────────────────
  const samples = h('ol', { class: 'ho-samples', 'aria-label': 'What is in each lane', 'data-role': 'samples' });
  task.lanes.forEach((lane, i) => {
    samples.append(h('li', { class: 'ho-samples__item', 'data-lane': String(i), 'data-given': String(lane.given && !lane.hidden), 'data-hidden': String(lane.hidden) },
      h('span', { class: 'ho-samples__num' }, laneWord(i)),
      lane.hidden
        ? h('span', { class: 'ho-samples__text' }, h('strong', null, 'Not named'), ' · This sample is shown, but not told to you.')
        : h('span', { class: 'ho-samples__text' }, h('strong', null, lane.name), lane.detail ? ` · ${lane.detail}` : '')));
  });
  wrap.append(
    h('p', { class: 'ho-announce', 'data-role': 'announce' }, task.announce),
    samples,
    h('p', { class: 'ho-question', 'data-role': 'question' }, task.question),
  );

  // ── Run, made first because the skins report changes to it ────────────────
  const status = h('p', { class: 'mnx-feedback ho-gapnote', role: 'status', 'data-role': 'gap', hidden: true });
  const hint = h('p', { class: 'ho-hint', 'data-role': 'runhint' }, '');
  const run = button('Run', 'primary', () => start(), { 'data-action': 'run' });
  const toggle = button('Hide my guess', 'ghost', () => {
    const on = toggle.textContent === 'Show my guess';
    skin.showGuess(on);
    toggle.textContent = on ? 'Hide my guess' : 'Show my guess';
  }, { small: true, 'data-action': 'toggle-guess', hidden: true });
  const controls = h('div', { class: 'ho-controls', 'data-role': 'controls' }, hint, h('div', { class: 'ho-runrow' }, run, toggle));

  // ── The result itself ──────────────────────────────────────────────────────
  const stage = h('div', { class: 'ho-predict__stage' });
  wrap.append(stage);
  const skin: Skin = task.skin === 'trace' ? traceSkin(stage, task, stops) : bandsSkin(stage, task, stops, () => syncRun());

  const note = h('p', { class: 'ho-formula', 'data-role': 'idealised' }, `Idealised: clean ${task.skin === 'trace' ? 'peaks' : 'bands'}, no noise.${spec.note ? ` ${spec.note}` : ''}`);
  wrap.append(note);

  // ── Which sample made the unnamed lane (rung 2) ────────────────────────────
  let mysteryBox: HTMLElement | null = null;
  if (task.mystery) {
    const m = task.mystery;
    const group = h('div', { class: 'mnx-choices ho-choices ho-mystery__options', role: 'group', 'aria-label': 'Which sample' });
    m.options.forEach((o) => {
      group.append(h('button', {
        type: 'button', class: 'mnx-choice', 'data-sample': String(o.lane), 'aria-pressed': 'false',
        onclick: () => {
          if (phase !== 'ask') return;
          pick = o.lane;
          group.querySelectorAll('[data-sample]').forEach((el) => el.setAttribute('aria-pressed', String((el as HTMLElement).dataset.sample === String(o.lane))));
          syncRun();
        },
      }, h('span', { class: 'mnx-choice__key' }, laneWord(o.lane)), h('span', { class: 'mnx-choice__text' }, o.name)));
    });
    mysteryBox = h('section', { class: 'ho-mystery', 'data-role': 'mystery', 'aria-label': 'Which sample made the lane with no name' },
      h('p', { class: 'ho-mystery__q' }, `Lane ${laneWord(m.lane)} is shown, but its sample is not named. Which of these made it?`), group);
    wrap.append(mysteryBox);
  }

  wrap.append(controls, status);

  function syncRun() {
    if (phase !== 'ask') return;
    const needPick = task.mystery !== null && pick === undefined;
    run.disabled = needPick;
    hint.textContent = needPick ? 'Choose which sample made the lane with no name, then press Run.' : '';
  }
  syncRun();

  // ── Revealing ──────────────────────────────────────────────────────────────
  const listBox = h('div', { class: 'ho-mismatches', 'data-role': 'mismatches', hidden: true });
  const detail = h('div', { class: 'ho-mismatches ho-detail', 'data-role': 'lane-detail', hidden: true });
  wrap.append(listBox, detail);

  function start() {
    if (phase !== 'ask') return;
    if (task.mystery && pick === undefined) { syncRun(); return; }
    phase = 'reveal';
    wrap.dataset.phase = 'reveal';
    const a = skin.attempt();
    const attempt: PredictAttempt = { ...a, pick };
    skin.freeze();
    run.hidden = true; hint.hidden = true;
    for (const el of wrap.querySelectorAll<HTMLButtonElement>('.ho-mystery button')) el.disabled = true;
    const mism = judge(task, attempt);
    stops.push(skin.reveal(mism, () => landed(attempt, mism)));
  }

  function landed(attempt: PredictAttempt, mism: Mismatch[]) {
    phase = 'after';
    wrap.dataset.phase = 'after';
    if (task.mystery && mysteryBox) {
      const m = task.mystery;
      for (const el of mysteryBox.querySelectorAll<HTMLElement>('[data-sample]')) {
        const lane = Number(el.dataset.sample);
        const chosen = pick === lane;
        const right = m.correct.includes(lane);
        if (chosen) el.dataset.state = right ? 'correct' : 'incorrect';
        else if (right && !(pick !== undefined && m.correct.includes(pick))) el.dataset.state = 'correct';
      }
    }
    empty(listBox);
    const bad = new Set(mism.filter((m) => m.kind !== 'sample').flatMap((m) => m.lanes ?? [m.lane]));
    const right = task.fill.filter((i) => !bad.has(i)).length;
    const total = task.fill.length;
    const word = task.skin === 'trace' ? 'trace' : 'lane';
    // One quiet line: how many were right. The mismatches that matter most follow in a sentence or two; the rest wait for a tap.
    status.className = 'mnx-feedback ho-gapnote';
    if (!mism.length) {
      status.textContent = total === 1 ? `The ${word} is right.` : `All ${total} ${word}s are right.`;
      listBox.append(h('p', { class: 'ho-mismatches__item', 'data-kind': 'none' }, task.skin === 'trace' ? 'Every peak is where it should be.' : 'Every band is in its lane and in the right order, and the darkness follows the amounts.'));
    } else {
      status.textContent = total === 1 ? (right ? `The ${word} is right.` : `The ${word} is not right.`) : `${right} of ${total} ${word}s right.`;
      const told = headline(mism);
      for (const m of told) listBox.append(h('p', { class: 'ho-mismatches__item', 'data-kind': m.kind }, m.text));
      const rest = [...bad].some((i) => !told.some((m) => (m.lanes ?? [m.lane]).includes(i))) || mism.length > told.length;
      if (rest && total > 1) listBox.append(h('p', { class: 'ho-hint ho-mismatches__more' }, `Tap a ${word} number for what differs in it.`));
    }
    listBox.hidden = false;
    // Each lane header gets a small tick or cross, and opens that lane's details when tapped.
    for (const i of task.fill) {
      const good = !bad.has(i);
      const head = wrap.querySelector<HTMLElement>(`[data-lane-head="${i}"]`) ?? wrap.querySelector<HTMLElement>(`.ho-trace-card[data-lane="${i}"] .ho-trace__head`);
      if (!head) continue;
      head.dataset.mark = good ? 'right' : 'wrong';
      head.setAttribute('aria-label', `${cap(laneNumber(i))}: ${good ? 'right' : 'not right'}. Press for details.`);
      head.setAttribute('aria-pressed', 'false');
      head.dataset.detail = String(i);
      if (head.tagName !== 'BUTTON') { head.setAttribute('role', 'button'); head.tabIndex = 0; }
    }
    const openDetail = (i: number) => {
      const was = detail.dataset.lane === String(i) && !detail.hidden;
      for (const el of wrap.querySelectorAll<HTMLElement>('[data-detail]')) el.setAttribute('aria-pressed', String(!was && el.dataset.detail === String(i)));
      empty(detail);
      if (was) { detail.hidden = true; detail.dataset.lane = ''; return; }
      const mine = mism.filter((m) => (m.lanes ?? [m.lane]).includes(i) || m.lane2 === i);
      detail.append(h('p', { class: 'ho-detail__title' }, `${cap(laneNumber(i))}${task.lanes[i].hidden ? '' : ` · ${task.lanes[i].name}`}`));
      if (!mine.length) detail.append(h('p', { class: 'ho-mismatches__item' }, bad.has(i) ? 'Nothing more to say about this one.' : 'This one was right.'));
      for (const m of mine) detail.append(h('p', { class: 'ho-mismatches__item', 'data-kind': m.kind }, m.text));
      detail.dataset.lane = String(i);
      detail.hidden = false;
    };
    wrap.addEventListener('click', (ev) => {
      const el = (ev.target as Element).closest<HTMLElement>('[data-detail]');
      if (el && phase === 'after') openDetail(Number(el.dataset.detail));
    });
    wrap.addEventListener('keydown', (ev) => {
      const el = (ev.target as Element).closest<HTMLElement>('[data-detail]');
      if (el && el.tagName !== 'BUTTON' && phase === 'after' && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openDetail(Number(el.dataset.detail)); }
    });
    status.hidden = false;
    toggle.hidden = false;
    wrap.append(h('p', { class: 'ho-lesson', 'data-role': 'lesson' }, task.lesson));
    timers.push(window.setTimeout(() => {
      done(attempt);
      wrap.querySelector('[data-role=lesson]')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }, reducedMotion() ? 0 : 300));
  }

  return () => {
    for (const t of timers) clearTimeout(t);
    for (const stop of stops.reverse()) stop();
    skin.destroy();
    wrap.remove();
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Bands
// ═════════════════════════════════════════════════════════════════════════════

function bandTag(text: string) { return h('span', { class: 'ho-band__tag', 'aria-hidden': 'true' }, text); }

function bandsSkin(stage: HTMLElement, task: PredictTask, stops: Array<() => void>, changed: () => void): Skin {
  const spec = task.spec;
  const placed: PlacedBand[] = [];
  let selected: PlacedBand | null = null;
  let armed: string | null = null;
  let frozen = false;
  const n = task.lanes.length;
  const editable = new Set(task.fill);
  const shortOf = (id: string) => task.palette.find((p) => p.id === id)?.short ?? id;
  const nameOf = (id: string) => task.palette.find((p) => p.id === id)?.name ?? id;

  // The things that can be placed.
  const palette = h('div', { class: 'ho-palette', role: 'group', 'aria-label': 'Bands you can place', 'data-role': 'palette' });
  palette.append(h('span', { class: 'ho-palette__label' }, 'Bands to place'));
  for (const item of task.palette) {
    const label = item.size !== null && spec.axis.unit ? `${item.short} · ${fmt(item.size)} ${spec.axis.unit}` : item.short;
    palette.append(h('button', { type: 'button', class: 'ho-chipband', 'data-sp': item.id, 'aria-pressed': 'false', title: item.name, 'aria-label': `${item.name}${item.size !== null && spec.axis.unit ? `, ${fmt(item.size)} ${spec.axis.unit}` : ''}` }, label));
  }
  const legend = h('ul', { class: 'ho-legend', 'aria-label': 'Names of the bands' });
  for (const item of task.palette) legend.append(h('li', null, h('strong', null, item.short), ` ${item.name}${item.size !== null && spec.axis.unit ? `, ${fmt(item.size)} ${spec.axis.unit}` : ''}`));
  stage.append(palette);

  // The lanes.
  const card = h('div', { class: 'ho-card ho-bands-card' });
  const grid = h('div', { class: 'ho-bands', style: `--lanes: ${n}`, 'data-role': 'bands' });
  const hasLadder = task.ladder.length > 0;
  const runs: HTMLElement[] = [];
  const bodies: HTMLElement[] = [];
  if (hasLadder) {
    const run = h('div', { class: 'ho-lane__run' });
    for (const rung of task.ladder) {
      run.append(h('div', { class: 'ho-ladder__tick', style: `top: ${(rung.t * 100).toFixed(2)}%` }, h('span', { class: 'ho-ladder__mark' }), h('span', { class: 'ho-ladder__label' }, fmt(rung.size))));
    }
    grid.append(h('div', { class: 'ho-ladder' },
      h('div', { class: 'ho-lane__head ho-ladder__head', 'aria-hidden': 'true' }, spec.axis.unit || 'size'),
      h('div', { class: 'ho-lane__body ho-ladder__body' }, run)));
  }
  task.lanes.forEach((lane, i) => {
    const run = h('div', { class: 'ho-lane__run' });
    const body = h('div', { class: 'ho-lane__body', 'data-lane-body': String(i), 'data-editable': String(editable.has(i)), 'aria-hidden': 'true' }, run);
    const head = h('button', {
      type: 'button', class: 'ho-lane__head', 'data-lane-head': String(i), 'aria-label': `Lane ${laneWord(i)}${lane.hidden ? '' : `: ${lane.name}`}`,
      onclick: () => { if (armed && editable.has(i) && !frozen) put(armed, i, 0.5); },
    }, laneWord(i));
    runs.push(run); bodies.push(body);
    grid.append(h('div', { class: 'ho-lane', 'data-lane': String(i), 'data-editable': String(editable.has(i)) }, head, body));
  });
  card.append(grid);
  const pc = (v: number) => `${Math.round(v * 100)}%`;
  const key = h('p', { class: 'ho-formula', 'data-role': 'key' },
    `Darkness follows the amount, set against the strongest band on the whole result: ${pc(LEVEL_FROM[2])} or more is dark, ${pc(LEVEL_FROM[1])} or more is medium, ${pc(LEVEL_FROM[0])} or more is faint, and less than that does not show.`);
  stage.append(card, legend, key);

  // Shown lanes: the truth, already developed.
  const truthBand = (b: Band, i: number, missed = false) => {
    const el = h('div', { class: 'ho-band ho-band--truth', 'data-sp': b.sp, 'data-level': String(b.level), 'data-missed': String(missed), style: `top: ${(b.t * 100).toFixed(2)}%; --lv: ${LEVEL_ALPHA[b.level]}` },
      bandTag(b.short), h('span', { class: 'ho-band__bar' }));
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `Lane ${laneWord(i)}: ${b.name}, ${LEVEL_NAMES[b.level]}`);
    return el;
  };
  task.lanes.forEach((lane, i) => { if (lane.given) for (const b of lane.truth) runs[i].append(truthBand(b, i)); });

  // ── Placing ────────────────────────────────────────────────────────────────
  const levelRow = h('div', { class: 'ho-levelrow', 'data-role': 'levels' });
  const levelText = h('span', { class: 'ho-levelrow__text', 'aria-live': 'polite' }, 'Place a band, then choose how dark it is.');
  const levelBtns = [1, 2, 3].map((lv) => h('button', {
    type: 'button', class: 'mnx-chip', 'data-level': String(lv), 'aria-pressed': 'false', disabled: true,
    onclick: () => { if (selected && !frozen) { selected.level = lv; paint(); } },
  }, cap(LEVEL_NAMES[lv])));
  const removeBtn = button('Remove', 'ghost', () => { if (selected && !frozen) { remove(selected); } }, { small: true, 'data-action': 'remove-band', disabled: true });
  levelRow.append(levelText, h('div', { class: 'ho-chips' }, ...levelBtns, removeBtn));
  stage.append(levelRow);

  function guessEl(p: PlacedBand): HTMLElement {
    const sel = selected === p;
    const el = h('button', {
      type: 'button', class: 'ho-band ho-band--guess', 'data-sp': p.sp, 'data-level': String(p.level), 'data-selected': String(sel),
      style: `top: ${(p.y * 100).toFixed(2)}%; --lv: ${LEVEL_ALPHA[p.level]}`,
      'aria-label': `${nameOf(p.sp)} in lane ${laneWord(p.lane)}, ${LEVEL_NAMES[p.level]}. Arrow keys move it, 1 to 3 set the darkness, Delete removes it.`,
    }, bandTag(shortOf(p.sp)), h('span', { class: 'ho-band__bar' }));
    el.addEventListener('pointerdown', (ev) => grabBand(ev, p, el));
    el.addEventListener('focus', () => { if (selected !== p) { selected = p; sync(); } });
    el.addEventListener('keydown', (ev) => keyBand(ev, p));
    return el;
  }

  function paint(focus = false) {
    for (const i of editable) for (const el of runs[i].querySelectorAll('.ho-band--guess, .ho-band--preview')) el.remove();
    let focusEl: HTMLElement | null = null;
    for (const p of [...placed].sort((a, b) => a.y - b.y)) {
      const el = guessEl(p);
      runs[p.lane].append(el);
      if (focus && selected === p) focusEl = el;
    }
    sync();
    focusEl?.focus({ preventScroll: true });
    changed();
  }
  function sync() {
    levelBtns.forEach((b, k) => { b.disabled = !selected || frozen; b.setAttribute('aria-pressed', String(!!selected && selected.level === k + 1)); });
    (removeBtn as HTMLButtonElement).disabled = !selected || frozen;
    levelText.textContent = selected ? `${nameOf(selected.sp)} in lane ${laneWord(selected.lane)}. How dark is it?` : placed.length ? 'Press a band to change how dark it is.' : 'Place a band, then choose how dark it is.';
    for (const el of runs.flatMap((r) => [...r.querySelectorAll<HTMLElement>('.ho-band--guess')])) {
      el.dataset.selected = String(selected !== null && el.dataset.sp === selected.sp && Number((el.parentElement?.parentElement?.parentElement as HTMLElement)?.dataset.lane) === selected.lane);
    }
  }
  function put(sp: string, lane: number, y: number) {
    const was = placed.findIndex((p) => p.lane === lane && p.sp === sp);
    const level = was >= 0 ? placed[was].level : 2;
    if (was >= 0) placed.splice(was, 1);
    const p: PlacedBand = { lane, sp, y: snap(y), level };
    placed.push(p);
    selected = p;
    paint(true);
  }
  function remove(p: PlacedBand) {
    const k = placed.indexOf(p);
    if (k >= 0) placed.splice(k, 1);
    if (selected === p) selected = null;
    paint();
  }
  function setArmed(sp: string | null) {
    armed = sp;
    palette.querySelectorAll<HTMLElement>('.ho-chipband').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.sp === sp)));
    stage.dataset.armed = sp ? 'true' : 'false';
  }

  /** Which lane the pointer is nearest to, and how far down it is, or null when it is nowhere near the lanes. */
  function laneAt(x: number, y: number): { lane: number; y: number } | null {
    let best = -1; let dist = Infinity;
    for (const i of editable) {
      const r = bodies[i].getBoundingClientRect();
      if (y < r.top - 36 || y > r.bottom + 36) continue;
      const c = (r.left + r.right) / 2;
      const d = Math.abs(x - c);
      if (d < dist && d <= r.width * 0.9 + 12) { dist = d; best = i; }
    }
    if (best < 0) return null;
    const r = runs[best].getBoundingClientRect();
    return { lane: best, y: snap((y - r.top) / r.height) };
  }

  // A floating copy follows the pointer while something is carried.
  let floatEl: HTMLElement | null = null;
  let preview: HTMLElement | null = null;
  function carryStart(text: string) {
    floatEl = h('div', { class: 'ho-float', 'aria-hidden': 'true' }, text);
    stage.append(floatEl);
  }
  function carryMove(ev: PointerEvent) {
    if (!floatEl) return;
    const r = stage.getBoundingClientRect();
    floatEl.style.left = `${ev.clientX - r.left}px`;
    floatEl.style.top = `${ev.clientY - r.top}px`;
    const at = laneAt(ev.clientX, ev.clientY);
    for (const b of bodies) b.dataset.over = 'false';
    preview?.remove(); preview = null;
    if (at) {
      bodies[at.lane].dataset.over = 'true';
      preview = h('div', { class: 'ho-band ho-band--preview', style: `top: ${(at.y * 100).toFixed(2)}%; --lv: 0.5` }, h('span', { class: 'ho-band__bar' }));
      runs[at.lane].append(preview);
    }
  }
  function carryEnd() {
    floatEl?.remove(); floatEl = null;
    preview?.remove(); preview = null;
    for (const b of bodies) b.dataset.over = 'false';
  }

  function drag(ev: PointerEvent, el: HTMLElement, text: string, onClick: () => void, onDrop: (at: { lane: number; y: number } | null) => void, onStart?: () => void) {
    if (frozen || ev.button !== 0) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX; const y0 = ev.clientY;
    let moving = false;
    const move = (e: PointerEvent) => {
      if (!moving && Math.hypot(e.clientX - x0, e.clientY - y0) > 5) { moving = true; carryStart(text); onStart?.(); }
      if (moving) carryMove(e);
    };
    const up = (e: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (moving) { const at = laneAt(e.clientX, e.clientY); carryEnd(); onDrop(at); } else onClick();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  for (const chip of palette.querySelectorAll<HTMLElement>('.ho-chipband')) {
    const sp = chip.dataset.sp as string;
    chip.addEventListener('pointerdown', (ev) => drag(ev, chip, shortOf(sp), () => setArmed(armed === sp ? null : sp), (at) => { if (at) { setArmed(null); put(sp, at.lane, at.y); } }));
    chip.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setArmed(armed === sp ? null : sp); } });
  }
  // With a band picked up, pressing a lane puts it there.
  const lanePress = (ev: PointerEvent) => {
    if (!armed || frozen) return;
    const at = laneAt(ev.clientX, ev.clientY);
    if (!at) return;
    const sp = armed;
    setArmed(null);
    put(sp, at.lane, at.y);
  };
  grid.addEventListener('pointerdown', (ev) => { if (!(ev.target as Element).closest('.ho-band--guess, .ho-lane__head')) lanePress(ev); });

  function grabBand(ev: PointerEvent, p: PlacedBand, el: HTMLElement) {
    drag(ev, el, shortOf(p.sp),
      () => { selected = p; paint(true); },
      (at) => {
        if (!at) { remove(p); return; }
        const k = placed.indexOf(p);
        if (k >= 0) placed.splice(k, 1);
        const clash = placed.findIndex((q) => q.lane === at.lane && q.sp === p.sp);
        if (clash >= 0) placed.splice(clash, 1);
        const q: PlacedBand = { lane: at.lane, sp: p.sp, y: at.y, level: p.level };
        placed.push(q); selected = q; paint(true);
      },
      () => { el.dataset.moving = 'true'; });
  }
  function keyBand(ev: KeyboardEvent, p: PlacedBand) {
    if (frozen) return;
    const big = ev.shiftKey ? 4 : 1;
    let done = true;
    if (ev.key === 'ArrowUp') p.y = clamp(p.y - big / STEPS, 0, 1);
    else if (ev.key === 'ArrowDown') p.y = clamp(p.y + big / STEPS, 0, 1);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const lanes = [...editable].sort((a, b) => a - b);
      const k = lanes.indexOf(p.lane) + (ev.key === 'ArrowRight' ? 1 : -1);
      if (k >= 0 && k < lanes.length && !placed.some((q) => q.lane === lanes[k] && q.sp === p.sp)) p.lane = lanes[k];
    } else if (ev.key === '1' || ev.key === '2' || ev.key === '3') p.level = Number(ev.key);
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); remove(p); return; }
    else done = false;
    if (done) { ev.preventDefault(); selected = p; paint(true); }
  }

  paint();

  // ── Reveal ─────────────────────────────────────────────────────────────────
  return {
    attempt: () => ({ skin: 'bands', placed: placed.map((p) => ({ ...p })) }),
    anyThing: () => placed.length > 0,
    freeze() {
      frozen = true;
      setArmed(null);
      selected = null;
      sync();
      stage.dataset.frozen = 'true';
      for (const c of palette.querySelectorAll<HTMLButtonElement>('.ho-chipband')) c.disabled = true;
      for (const el of stage.querySelectorAll<HTMLElement>('.ho-band--guess')) { el.setAttribute('tabindex', '-1'); el.dataset.selected = 'false'; }
      levelRow.hidden = true;
    },
    reveal(mism, end) {
      const hit = new Set<string>();
      for (const i of task.fill) for (const b of task.lanes[i].truth) hit.add(`${i}|${b.sp}`);
      // The guess becomes a ghost, ringed by whether the thing really is in that lane.
      for (const p of placed) {
        const el = [...runs[p.lane].querySelectorAll<HTMLElement>('.ho-band--guess')].find((e) => e.dataset.sp === p.sp);
        if (el) { el.dataset.ghost = 'true'; el.dataset.state = hit.has(`${p.lane}|${p.sp}`) ? 'met' : 'miss'; }
      }
      // The truth is laid beneath, undeveloped.
      const made: HTMLElement[] = [];
      const guessed = new Set(placed.map((p) => `${p.lane}|${p.sp}`));
      for (const i of task.fill) {
        task.lanes[i].truth.forEach((b) => {
          const el = truthBand(b, i, !guessed.has(`${i}|${b.sp}`));
          el.dataset.developed = 'false';
          el.style.setProperty('--i', String(i));
          runs[i].prepend(el);
          made.push(el);
        });
      }
      wrapLanesStatus(task, bodies, mism);
      const fast = reducedMotion();
      if (fast) for (const el of made) el.dataset.developed = 'true';
      else requestAnimationFrame(() => requestAnimationFrame(() => { for (const el of made) el.dataset.developed = 'true'; }));
      const timer = window.setTimeout(end, fast ? 0 : 1100);
      return () => clearTimeout(timer);
    },
    showGuess(on) { stage.dataset.guess = on ? 'shown' : 'hidden'; },
    destroy() { carryEnd(); },
  };
}

/** Mark lanes that held a mismatch, so the eye goes to them. */
function wrapLanesStatus(task: PredictTask, bodies: HTMLElement[], mism: Mismatch[]) {
  const bad = new Set(mism.filter((m) => m.kind !== 'sample').flatMap((m) => m.lanes ?? [m.lane]));
  task.fill.forEach((i) => { (bodies[i].parentElement as HTMLElement).dataset.state = bad.has(i) ? 'miss' : 'met'; });
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ═════════════════════════════════════════════════════════════════════════════
// Trace
// ═════════════════════════════════════════════════════════════════════════════

function traceSkin(stage: HTMLElement, task: PredictTask, stops: Array<() => void>): Skin {
  const spec = task.spec;
  const run = spec.axis.run as NonNullable<PredictSpec['axis']['run']>;
  const xOf = (t: number) => run.min + t * (run.max - run.min);
  const editable = new Set(task.fill);
  const anchors: number[][] = task.lanes.map(() => new Array<number>(ANCHORS).fill(0));
  let frozen = false;

  interface Panel {
    lane: TaskLane; index: number; plot: Plot; guess: Curve; truth: Curve; rings: Marker[]; tips: Marker[];
  }
  const panels: Panel[] = [];
  const hint = h('p', { class: 'ho-hint' }, task.fill.length ? 'Drag a ring up to start a peak. The rings beside it make it wider or narrower.' : '');
  stage.append(hint);

  task.lanes.forEach((lane, index) => {
    const card = h('div', { class: 'ho-card ho-trace-card', 'data-lane': String(index), 'data-editable': String(editable.has(index)) });
    card.append(h('div', { class: 'ho-trace__head' },
      h('span', { class: 'ho-samples__num' }, laneWord(index)),
      h('span', { class: 'ho-trace__name' }, lane.hidden ? 'Not named' : lane.name)));
    stage.append(card);
    const plot = new Plot(card,
      { min: run.min, max: run.max, scale: 'linear', title: `${run.name}${run.unit ? ` (${run.unit})` : ''}` },
      { min: 0, max: 1, scale: 'linear', title: 'relative signal' },
      `Trace for lane ${laneWord(index)}`);
    stops.push(() => plot.destroy());
    const truth = new Curve(plot, 'ho-curve--truth');
    const guess = new Curve(plot, 'ho-curve--guess');
    const panel: Panel = { lane, index, plot, guess, truth, rings: [], tips: [] };
    const line = truthLine(lane.truth);
    const tips = lane.truth.map((b) => { const m = new Marker(plot, { kind: 'now', label: `${b.name} peak` }); m.show(false); return m; });
    panel.tips = tips;
    if (lane.given) {
      truth.set((x) => line((x - run.min) / (run.max - run.min)));
      lane.truth.forEach((b, k) => { tips[k].show(true); tips[k].set(xOf(b.t), b.height); tips[k].setTag(b.short); });
    } else {
      truth.set(null);
      const f0 = smooth(anchors[index]);
      guess.set((x) => f0((x - run.min) / (run.max - run.min)));
      for (let k = 0; k < ANCHORS; k++) {
        const ring = new Marker(plot, { kind: 'ring', label: `Anchor ${k + 1} of ${ANCHORS}, lane ${laneWord(index)}` });
        ring.set(xOf(k / (ANCHORS - 1)), 0);
        const stopDrag = ring.drag({
          axis: 'y',
          valueText: (_x, y) => `${Math.round(y * 100)}%`,
          onMove: (_x, y) => {
            if (frozen) return;
            anchors[index][k] = clamp(y, 0, 1);
            const f = smooth(anchors[index]);
            guess.set((x) => f((x - run.min) / (run.max - run.min)));
          },
        });
        stops.push(stopDrag);
        panel.rings.push(ring);
      }
    }
    panels.push(panel);
  });

  return {
    attempt: () => ({ skin: 'trace', anchors: anchors.map((a) => a.slice()) }),
    anyThing: () => anchors.some((a) => a.some((v) => v > 0.02)),
    freeze() { frozen = true; hint.hidden = true; },
    reveal(mism, end) {
      const bad = new Set(mism.filter((m) => m.kind !== 'sample').flatMap((m) => m.lanes ?? [m.lane]));
      const live = panels.filter((p) => editable.has(p.index));
      for (const p of live) {
        const line = truthLine(p.lane.truth);
        p.guess.path.dataset.ghost = 'true';
        p.guess.path.dataset.state = bad.has(p.index) ? 'miss' : 'met';
        for (const r of p.rings) r.show(false);
        p.plot.root.closest('.ho-card')?.setAttribute('data-state', bad.has(p.index) ? 'miss' : 'met');
        p.lane.truth.forEach((b, k) => { p.tips[k].show(true); p.tips[k].set(xOf(b.t), 0); p.tips[k].setTag(b.short); });
        p.truth.set(() => 0);
        void line;
      }
      const stop = tween(reducedMotion() ? 0 : 1000, (g) => {
        for (const p of live) {
          const line = truthLine(p.lane.truth);
          p.truth.set((x) => g * line((x - run.min) / (run.max - run.min)));
          p.lane.truth.forEach((b, k) => p.tips[k].set(xOf(b.t), g * b.height));
        }
      }, () => setTimeout(end, 0));
      return stop;
    },
    showGuess(on) { for (const p of panels) p.guess.show(on); },
    destroy() { /* plots are destroyed through stops */ },
  };
}

export const predict: Engine<PredictSpec, PredictTask, PredictAttempt> = {
  id: 'predict',
  label: 'Predict the Result',
  rungNames: ['One lane to fill', 'Every lane', 'Name the sample'],
  issues,
  prepare,
  view,
  result,
};
