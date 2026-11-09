/**
 * Grow, Arrest, Count, the view. One round:
 *
 *   ask   the student commits before anything is revealed: they pick a stage (rung 0), draw the histogram by dragging across
 *         an empty chart (rung 1), or type a number (rung 2). The "before" outline and a sample of the population are shown.
 *   run   the time-lapse plays: the sample moves between stages, and the true histogram builds up, stacked by stage, over the
 *         ghost of the sketch (scaled to the same total, which is said).
 *   done  the clock can be dragged back and forth. The round is handed back once the time-lapse has finished.
 *
 * Colour means something: each stage has its own data colour, the quiet text colour is the guess, success and danger mark
 * whether it was right.
 */
import { reducedMotion, type Engine } from '../../engine';
import { button, h } from '../../dom';
import { tween } from '../../motion';
import { svgEl } from '../../plot';
import { clamp, ticks } from '../../scale';
import './grow.css';
import {
  committed, fmt, histOf, individualsOf, issues, overlap, pct, prepare, q, quota, readNumber, result, sum, valueRange, valueText, withUnit,
  centreOf, type GrowAttempt, type GrowSpec, type GrowTask,
} from './logic';

const NICE = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
const niceMax = (v: number) => NICE.find((n) => n >= v) ?? 1;
const colourOf = (i: number) => `var(--mnx-data-${(i % 10) + 1})`;
const DOTS = 96;
const PLAY_MS = 5200;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function view(root: HTMLElement, task: GrowTask, done: (attempt: GrowAttempt) => void): () => void {
  const { spec, sim, rung } = task;
  const S = spec.stages.length;
  const nb = spec.measure.bins;
  const steps = sim.frames.length - 1;
  const noun = individualsOf(spec);
  const totals = sim.frames.map(histOf);
  let peak = 0;
  for (const t of totals) for (const v of t) peak = Math.max(peak, v);
  const yMax = niceMax(peak * 1.12);

  let phase: 'ask' | 'run' | 'done' = 'ask';
  let stopped = false;
  let handed = false;
  let frameAt = 0;
  let ghostScale = 0;
  let guessStage: string | undefined;
  let guessValue: number | undefined;
  const sketch = new Array<number>(nb).fill(0);
  const stops: Array<() => void> = [];
  const timers: number[] = [];
  let playing: (() => void) | null = null;

  const wrap = h('div', { class: 'ho-gac', 'data-engine': 'grow', 'data-rung': String(rung), 'data-phase': 'ask' });
  root.append(wrap);

  // ── The question ───────────────────────────────────────────────────────────
  const head = h('div', { class: 'ho-gac__head' },
    spec.story ? h('p', { class: 'ho-muted', 'data-role': 'story' }, spec.story) : null,
    h('span', { class: 'ho-eyebrow' }, 'The treatment'),
    h('p', { class: 'ho-question', 'data-role': 'treatment' }, task.treatment.label),
    h('p', { class: 'ho-announce', 'data-role': 'announce' }, task.question),
  );

  // ── The chart ──────────────────────────────────────────────────────────────
  const card = h('div', { class: 'ho-card ho-gac__card' });
  const svg = svgEl('svg', { class: 'ho-svg ho-gac__svg', role: 'img', 'data-role': 'hist', 'aria-label': `Histogram of ${spec.measure.name}` });
  const plotBox = h('div', { class: 'ho-gac__plot' }, svg);
  card.append(plotBox);
  const gGrid = svgEl('g', {}, svg);
  const gTruth = svgEl('g', { class: 'ho-gac__truth' }, svg);
  const gGhost = svgEl('g', { class: 'ho-gac__ghost' }, svg);
  const before = svgEl('path', { class: 'ho-gac__before', fill: 'none' }, svg);
  const gAxis = svgEl('g', {}, svg);
  const gBins = svgEl('g', {}, svg);
  const hint = svgEl('text', { class: 'ho-gac__drawhint', 'text-anchor': 'middle' }, svg);
  const hit = svgEl('rect', { class: 'ho-gac__hit', fill: 'transparent' }, svg);
  const truthRects: SVGRectElement[][] = Array.from({ length: S }, (_, s) => Array.from({ length: nb }, () => svgEl('rect', { class: 'ho-gac__bar', fill: colourOf(s) }, gTruth)));
  const ghostRects: SVGRectElement[] = Array.from({ length: nb }, () => svgEl('rect', { class: 'ho-gac__gbar' }, gGhost));
  const binRects: SVGRectElement[] = [];

  const beforeKey = h('li', { 'data-role': 'before-key' }, h('i', { class: 'ho-gac__key ho-gac__key--before' }), 'Before the treatment');
  const legend = h('ul', { class: 'ho-gac__legend', 'aria-label': 'Key to the chart' },
    beforeKey,
    rung === 1 ? h('li', null, h('i', { class: 'ho-gac__key ho-gac__key--ghost' }), 'Your sketch (scaled to the same total once it runs)') : null,
    h('li', null, h('i', { class: 'ho-gac__key ho-gac__key--now' }), `The ${noun} now, coloured by stage`),
  );

  // Where each stage's value sits along the axis. Stages whose ranges overlap go on separate rows.
  const rowsOf: number[] = [];
  {
    const placed: Array<{ lo: number; hi: number; row: number }> = [];
    spec.stages.forEach((st) => {
      const [lo, hi] = valueRange(st);
      let row = 0;
      const w = (spec.measure.max - spec.measure.min) * 0.02;
      while (placed.some((p) => p.row === row && p.lo - w < hi && lo - w < p.hi)) row++;
      placed.push({ lo, hi, row });
      rowsOf.push(row);
    });
  }
  const bandRows = Math.max(...rowsOf) + 1;

  const geom = { W: 600, H: 240, left: 40, top: 10, pw: 550, ph: 160, bottom: 70 };
  const xOf = (v: number) => geom.left + ((v - spec.measure.min) / (spec.measure.max - spec.measure.min)) * geom.pw;
  const cw = () => geom.pw / nb;

  function layout() {
    const W = Math.max(280, Math.floor(plotBox.clientWidth || 600));
    geom.W = W;
    geom.H = clamp(Math.round(W * 0.42), 210, 280);
    geom.left = W < 420 ? 36 : 44;
    geom.pw = W - geom.left - 10;
    geom.bottom = 40 + bandRows * 7;
    geom.ph = geom.H - geom.top - geom.bottom;
    svg.setAttribute('viewBox', `0 0 ${W} ${geom.H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(geom.H));
    hit.setAttribute('x', String(geom.left));
    hit.setAttribute('y', String(geom.top));
    hit.setAttribute('width', String(geom.pw));
    hit.setAttribute('height', String(geom.ph));
    gGrid.replaceChildren();
    gAxis.replaceChildren();
    const base = geom.top + geom.ph;
    for (const t of ticks({ min: 0, max: yMax, scale: 'linear' }, 4)) {
      const y = base - (t.value / yMax) * geom.ph;
      svgEl('line', { class: 'ho-grid', x1: geom.left, x2: geom.left + geom.pw, y1: y, y2: y }, gGrid);
      if (phase !== 'ask' || rung !== 1) svgEl('text', { class: 'ho-ticklabel', x: geom.left - 6, y: y + 4, 'text-anchor': 'end' }, gAxis).textContent = `${Math.round(t.value * 100)}%`;
    }
    svgEl('line', { class: 'ho-axis', x1: geom.left, x2: geom.left + geom.pw, y1: base, y2: base }, gAxis);
    for (const t of ticks({ min: spec.measure.min, max: spec.measure.max, scale: 'linear' }, W < 420 ? 4 : 7)) {
      const x = xOf(t.value);
      svgEl('line', { class: 'ho-tickmark', x1: x, x2: x, y1: base, y2: base + 4 }, gAxis);
      svgEl('text', { class: 'ho-ticklabel', x, y: base + 17, 'text-anchor': 'middle' }, gAxis).textContent = withUnit(t.value, spec.measure.unit);
    }
    spec.stages.forEach((st, s) => {
      const [lo, hi] = valueRange(st);
      const x0 = xOf(lo), x1 = Math.max(xOf(hi), x0 + 6);
      svgEl('rect', { class: 'ho-gac__band', x: x0 - 3, y: base + 24 + rowsOf[s] * 7, width: x1 - x0 + 0, height: 5, rx: 2.5, fill: colourOf(s) }, gAxis);
    });
    svgEl('text', { class: 'ho-axistitle', x: geom.left + geom.pw / 2, y: geom.H - 6, 'text-anchor': 'middle' }, gAxis).textContent =
      spec.measure.unit && spec.measure.unit.length > 1 ? `${spec.measure.name} (${spec.measure.unit})` : spec.measure.name;
    hint.setAttribute('x', String(geom.left + geom.pw / 2));
    hint.setAttribute('y', String(geom.top + geom.ph / 2));
    const w = cw();
    for (let b = 0; b < nb; b++) {
      for (let s = 0; s < S; s++) { truthRects[s][b].setAttribute('x', String(geom.left + b * w + 0.5)); truthRects[s][b].setAttribute('width', String(Math.max(1, w - 1))); }
      ghostRects[b].setAttribute('x', String(geom.left + b * w + 0.5));
      ghostRects[b].setAttribute('width', String(Math.max(1, w - 1)));
      const r = binRects[b];
      if (r) { r.setAttribute('x', String(geom.left + b * w)); r.setAttribute('y', String(geom.top)); r.setAttribute('width', String(w)); r.setAttribute('height', String(geom.ph)); }
    }
    paintBars();
  }

  // The state of the population at a fractional frame.
  function mixAt(fi: number) {
    const a = clamp(Math.floor(fi), 0, steps), b = Math.min(steps, a + 1), t = clamp(fi - a, 0, 1);
    const fa = sim.frames[a], fb = sim.frames[b];
    return {
      t: lerp(fa.t, fb.t, t),
      total: lerp(fa.total, fb.total, t),
      shares: fa.shares.map((x, i) => lerp(x, fb.shares[i], t)),
      hist: fa.hist.map((row, s) => row.map((x, k) => lerp(x, fb.hist[s][k], t))),
    };
  }

  const startHist = totals[0];
  function paintBars() {
    const base = geom.top + geom.ph;
    const mix = mixAt(frameAt);
    const showNow = rung !== 1 || phase !== 'ask';
    for (let b = 0; b < nb; b++) {
      let acc = 0;
      for (let s = 0; s < S; s++) {
        const hgt = showNow ? (mix.hist[s][b] / yMax) * geom.ph : 0;
        const r = truthRects[s][b];
        r.setAttribute('y', String(base - acc - hgt));
        r.setAttribute('height', String(Math.max(0, hgt)));
        acc += hgt;
      }
    }
    // The outline of how it was before.
    const c = cw();
    let d = '';
    for (let b = 0; b < nb; b++) {
      const y = base - (startHist[b] / yMax) * geom.ph;
      d += `${b === 0 ? 'M' : 'L'}${geom.left + b * c},${y}L${geom.left + (b + 1) * c},${y}`;
    }
    before.setAttribute('d', d);
    // Before the run the outline is the starting shape. For a treatment that changes nothing it would be the answer, so it waits.
    const outline = phase !== 'ask' || (rung === 1 && !task.treatment.control);
    before.style.display = outline ? '' : 'none';
    beforeKey.hidden = !outline;
    // The sketch, raw while drawing, then scaled to the same total as the real thing.
    const total = sum(sketch);
    for (let b = 0; b < nb; b++) {
      const raw = sketch[b] * yMax;
      const scaled = total > 0 ? sketch[b] / total : 0;
      const share = lerp(raw, scaled, ghostScale);
      const hgt = (share / yMax) * geom.ph;
      const r = ghostRects[b];
      r.setAttribute('y', String(base - hgt));
      r.setAttribute('height', String(Math.max(0, hgt)));
      r.style.display = rung === 1 && total > 0 ? '' : 'none';
      const bin = binRects[b];
      if (bin) bin.setAttribute('aria-valuenow', String(Math.round(sketch[b] * 100)));
    }
    hint.textContent = rung === 1 && phase === 'ask' && total === 0 ? 'Drag across here to draw your bars' : '';
  }

  // ── The sample of the population ───────────────────────────────────────────
  const field = h('div', { class: 'ho-card ho-gac__field' });
  const clock = h('p', { class: 'ho-gac__clock', 'data-role': 'clock' });
  const zones = h('div', { class: 'ho-gac__zones', role: 'list', 'aria-label': `A sample of ${DOTS} ${noun}, by stage` });
  field.append(clock, zones);
  const zoneEls: Array<{ el: HTMLElement; pct: HTMLElement; dots: SVGCircleElement[]; shown: number }> = [];
  spec.stages.forEach((st, s) => {
    const dots: SVGCircleElement[] = [];
    const dotSvg = svgEl('svg', { class: 'ho-gac__dots', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    const golden = Math.PI * (3 - Math.sqrt(5));
    const rad = 44 * Math.sqrt(1 / DOTS) * 0.74;
    for (let k = 0; k < DOTS; k++) {
      const r = 45 * Math.sqrt((k + 0.5) / DOTS);
      const a = k * golden + s * 1.3;
      const c = svgEl('circle', { class: 'ho-gac__dot', cx: (50 + r * Math.cos(a)).toFixed(2), cy: (50 + r * Math.sin(a)).toFixed(2), r: rad.toFixed(2), fill: colourOf(s), 'data-on': '0' }, dotSvg);
      dots.push(c);
    }
    const pctEl = h('span', { class: 'ho-gac__zonepct' }, '');
    const el = h('div', { class: 'ho-gac__zone', role: 'listitem', 'data-stage': st.id, tabindex: '0' },
      h('div', { class: 'ho-gac__zonehead' }, h('i', { class: 'ho-gac__swatch', style: `background:${colourOf(s)}` }), h('strong', null, st.label), pctEl),
      h('p', { class: 'ho-gac__zonesub' }, `${fmt(st.duration)} ${spec.unit} · ${valueText(spec, st)}`),
      dotSvg,
      st.note ? h('p', { class: 'ho-gac__zonenote' }, st.note) : null,
    );
    el.addEventListener('click', () => { el.dataset.open = el.dataset.open === 'true' ? 'false' : 'true'; });
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); (ev.target as HTMLElement).click(); } });
    zones.append(el);
    zoneEls.push({ el, pct: pctEl, dots, shown: -1 });
  });

  function paintField() {
    const mix = mixAt(frameAt);
    const q = quota(mix.shares, DOTS);
    zoneEls.forEach((z, s) => {
      // A number to be worked out is not read off the labels before the run.
      z.pct.textContent = rung >= 2 && phase === 'ask' ? '' : pct(mix.shares[s]);
      if (q[s] !== z.shown) {
        z.dots.forEach((c, k) => c.setAttribute('data-on', k < q[s] ? '1' : '0'));
        z.shown = q[s];
      }
    });
    const growth = mix.total;
    clock.textContent = `Time ${fmt(mix.t)} ${spec.unit} · ${noun} present ${growth >= 10 ? Math.round(growth) : growth.toFixed(2)} times the start`;
  }

  // ── Rung 2: the share over time ────────────────────────────────────────────
  let lineSvg: SVGSVGElement | null = null;
  let lineBox: HTMLElement | null = null;
  let lineLayout: (() => void) | null = null;
  let linePaint: (() => void) | null = null;
  const lineCard = rung >= 2 ? h('div', { class: 'ho-card ho-gac__card ho-gac__linecard' }) : null;
  if (lineCard && (task.ask.kind === 'fraction' || task.ask.kind === 'time')) {
    const stage = task.ask.stage;
    lineSvg = svgEl('svg', { class: 'ho-svg ho-gac__svg', role: 'img', 'data-role': 'line', 'aria-label': `Share of ${noun} in ${spec.stages[stage].label} over time` });
    lineBox = h('div', { class: 'ho-gac__plot' }, lineSvg);
    lineCard.append(lineBox);
    const lGrid = svgEl('g', {}, lineSvg);
    const path = svgEl('path', { class: 'ho-gac__trace', fill: 'none', stroke: colourOf(stage) }, lineSvg);
    const lMarks = svgEl('g', {}, lineSvg);
    const L = { left: 44, top: 12, pw: 500, ph: 120, H: 180 };
    const lx = (t: number) => L.left + (t / task.length) * L.pw;
    const ly = (s: number) => L.top + L.ph - clamp(s, 0, 1) * L.ph;
    lineLayout = () => {
      const W = Math.max(280, Math.floor(lineBox!.clientWidth || 600));
      L.left = W < 420 ? 38 : 44; L.pw = W - L.left - 12; L.H = 180;
      lineSvg!.setAttribute('viewBox', `0 0 ${W} ${L.H}`); lineSvg!.setAttribute('width', String(W)); lineSvg!.setAttribute('height', String(L.H));
      lGrid.replaceChildren();
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        svgEl('line', { class: 'ho-grid', x1: L.left, x2: L.left + L.pw, y1: ly(v), y2: ly(v) }, lGrid);
        svgEl('text', { class: 'ho-ticklabel', x: L.left - 6, y: ly(v) + 4, 'text-anchor': 'end' }, lGrid).textContent = `${Math.round(v * 100)}%`;
      }
      svgEl('line', { class: 'ho-axis', x1: L.left, x2: L.left + L.pw, y1: ly(0), y2: ly(0) }, lGrid);
      for (const t of ticks({ min: 0, max: task.length, scale: 'linear' }, W < 420 ? 4 : 6)) {
        svgEl('text', { class: 'ho-ticklabel', x: lx(t.value), y: ly(0) + 17, 'text-anchor': 'middle' }, lGrid).textContent = fmt(t.value);
      }
      svgEl('text', { class: 'ho-axistitle', x: L.left + L.pw / 2, y: L.H - 6, 'text-anchor': 'middle' }, lGrid).textContent = `time (${spec.unit})`;
      linePaint!();
    };
    linePaint = () => {
      const upto = Math.floor(frameAt);
      let d = '';
      for (let k = 0; k <= upto; k++) d += `${k === 0 ? 'M' : 'L'}${lx(sim.frames[k].t)},${ly(sim.frames[k].shares[stage])}`;
      if (frameAt > upto && upto < steps) {
        const m = mixAt(frameAt);
        d += `L${lx(m.t)},${ly(m.shares[stage])}`;
      }
      path.setAttribute('d', d);
      lMarks.replaceChildren();
      if (task.ask.kind === 'time') {
        svgEl('line', { class: 'ho-atline', x1: L.left, x2: L.left + L.pw, y1: ly(task.ask.share), y2: ly(task.ask.share) }, lMarks);
        svgEl('text', { class: 'ho-gac__marktext', x: L.left + L.pw - 2, y: ly(task.ask.share) - 5, 'text-anchor': 'end' }, lMarks).textContent = pct(task.ask.share);
      }
      if (guessValue !== undefined) {
        if (task.ask.kind === 'time') {
          const x = lx(clamp(guessValue, 0, task.length));
          svgEl('line', { class: 'ho-gac__guessline', x1: x, x2: x, y1: L.top, y2: ly(0) }, lMarks);
          svgEl('text', { class: 'ho-gac__marktext ho-gac__marktext--guess', x, y: L.top + 10, 'text-anchor': x > L.left + L.pw - 70 ? 'end' : 'start', dx: x > L.left + L.pw - 70 ? -5 : 5 }, lMarks).textContent = `you: ${fmt(guessValue)} ${spec.unit}`;
        } else {
          const y = ly(guessValue / 100);
          svgEl('line', { class: 'ho-gac__guessline', x1: L.left, x2: L.left + L.pw, y1: y, y2: y }, lMarks);
          svgEl('circle', { class: 'ho-gac__guessdot', cx: lx(task.length), cy: y, r: 6 }, lMarks);
          svgEl('text', { class: 'ho-gac__marktext ho-gac__marktext--guess', x: L.left + 4, y: y - 5 }, lMarks).textContent = `you: ${Math.round(guessValue)}%`;
        }
      }
      if (phase === 'done' && task.answer !== null) {
        const met = result(task, attempt()).met;
        const cls = met ? 'ho-gac__truedot ho-gac__truedot--met' : 'ho-gac__truedot ho-gac__truedot--miss';
        if (task.ask.kind === 'time') svgEl('circle', { class: cls, cx: lx(task.answer), cy: ly(task.ask.share), r: 6 }, lMarks);
        else svgEl('circle', { class: cls, cx: lx(task.length), cy: ly(task.answer / 100), r: 6 }, lMarks);
      }
    };
  }

  // ── What the student does ──────────────────────────────────────────────────
  const picks: HTMLButtonElement[] = [];
  const controls = h('div', { class: 'ho-gac__controls' });
  const status = h('p', { class: 'ho-gac__note', role: 'status', 'data-role': 'note' });
  const runButton = button('Run it', 'primary', () => run(), { 'data-action': 'run', disabled: true });
  const hintLine = h('p', { class: 'ho-hint', 'data-role': 'hint' });
  const runRow = h('div', { class: 'ho-gac__runrow' }, runButton, hintLine);
  let input: HTMLInputElement | null = null;
  let preview: HTMLElement | null = null;

  const attempt = (): GrowAttempt => (rung === 0 ? { stage: guessStage } : rung === 1 ? { sketch: [...sketch] } : { value: guessValue });

  function refreshRun() {
    const ok = phase === 'ask' && committed(task, attempt());
    runButton.disabled = !ok;
    hintLine.textContent = phase !== 'ask' ? '' : ok
      ? 'Press Run when you are sure. You cannot change it afterwards.'
      : rung === 0 ? 'Pick a stage to commit.' : rung === 1 ? 'Draw some bars to commit.' : 'Type a number to commit.';
  }

  if (rung === 0) {
    const group = h('div', { class: 'mnx-choices ho-choices ho-gac__picks', role: 'group', 'aria-label': 'Where the most end up' });
    spec.stages.forEach((st, i) => {
      const b = h('button', {
        type: 'button', class: 'mnx-choice ho-gac__pick', 'data-stage-pick': st.id, 'aria-pressed': 'false',
        onclick: () => pickStage(st.id),
      }, h('span', { class: 'mnx-choice__key' }, String(i + 1)), h('i', { class: 'ho-gac__swatch', style: `background:${colourOf(i)}` }), h('span', { class: 'mnx-choice__text' }, st.label));
      picks.push(b);
      group.append(b);
    });
    controls.append(group);
    const keys = (ev: KeyboardEvent) => {
      if (phase !== 'ask' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const i = Number(ev.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < S) pickStage(spec.stages[i].id);
    };
    document.addEventListener('keydown', keys);
    stops.push(() => document.removeEventListener('keydown', keys));
  } else if (rung === 1) {
    controls.append(h('div', { class: 'ho-gac__sketchrow' },
      h('p', { class: 'ho-hint' }, 'Drag across the chart to set the height of each bar. Taller means more of the population. The arrow keys move a bar once you tab to the chart.'),
      button('Clear', 'ghost', () => { sketch.fill(0); paintBars(); refreshRun(); }, { small: true, 'data-action': 'clear' })));
  } else {
    input = h('input', {
      type: 'text', class: 'mnx-input ho-answer', id: 'ho-gac-answer', 'data-role': 'answer', autocomplete: 'off', spellcheck: 'false',
      placeholder: task.ask.kind === 'time' ? `for example 8 ${spec.unit}` : 'for example 40%', 'aria-label': 'Your answer',
    }) as HTMLInputElement;
    preview = h('p', { class: 'ho-preview', 'data-role': 'preview' });
    const problem = h('p', { class: 'mnx-help mnx-help--error', role: 'alert', hidden: true });
    input.addEventListener('input', () => {
      problem.hidden = true;
      const v = readNumber(input!.value, task.ask.kind === 'time' ? spec.unit : '%');
      if (input!.value.trim() && v === null) { preview!.textContent = ''; guessValue = undefined; }
      else if (v === null) { guessValue = undefined; preview!.textContent = ''; }
      else {
        guessValue = v;
        preview!.textContent = `Read as ${task.ask.kind === 'time' ? `${fmt(v)} ${spec.unit}` : `${fmt(v)}%`}`;
      }
      if (lineLayout) linePaint?.();
      refreshRun();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (phase === 'ask' && committed(task, attempt())) run();
      else { problem.textContent = 'Type a number first, such as 40 or 40%.'; problem.hidden = false; }
    });
    controls.append(h('div', { class: 'mnx-field ho-answerrow' },
      h('label', { class: 'mnx-label', for: 'ho-gac-answer' }, task.ask.kind === 'time' ? `Your answer, in ${spec.unit}` : 'Your answer, as a percentage'),
      input, preview, problem));
  }

  function pickStage(id: string) {
    if (phase !== 'ask') return;
    guessStage = id;
    picks.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stagePick === id)));
    refreshRun();
  }

  // Sketching: press and drag across the chart.
  if (rung === 1) {
    for (let b = 0; b < nb; b++) {
      const r = svgEl('rect', {
        class: 'ho-gac__bin', tabindex: b === 0 ? '0' : '-1', role: 'slider', 'aria-orientation': 'vertical', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
        'aria-label': `Bar at ${withUnit(centreOf(spec.measure, b), spec.measure.unit)}`, fill: 'none', 'data-bin': String(b),
      }, gBins);
      r.addEventListener('keydown', (ev) => {
        if (phase !== 'ask') return;
        const k = (ev as KeyboardEvent).key;
        const big = (ev as KeyboardEvent).shiftKey ? 0.25 : 0.05;
        let handled = true;
        if (k === 'ArrowUp') sketch[b] = clamp(Math.round((sketch[b] + big) * 100) / 100, 0, 1);
        else if (k === 'ArrowDown') sketch[b] = clamp(Math.round((sketch[b] - big) * 100) / 100, 0, 1);
        else if (k === 'ArrowRight' && b < nb - 1) focusBin(b + 1);
        else if (k === 'ArrowLeft' && b > 0) focusBin(b - 1);
        else if (k === 'Home') focusBin(0);
        else if (k === 'End') focusBin(nb - 1);
        else handled = false;
        if (handled) { ev.preventDefault(); paintBars(); refreshRun(); }
      });
      binRects.push(r);
    }
    const focusBin = (b: number) => { binRects.forEach((r, i) => r.setAttribute('tabindex', i === b ? '0' : '-1')); binRects[b].focus(); };
    let last: { b: number; v: number } | null = null;
    let dragging = false;
    const at = (ev: PointerEvent) => {
      const box = svg.getBoundingClientRect();
      const x = ((ev.clientX - box.left) / box.width) * geom.W;
      const y = ((ev.clientY - box.top) / box.height) * geom.H;
      const b = clamp(Math.floor((x - geom.left) / cw()), 0, nb - 1);
      const v = clamp(Math.round(((geom.top + geom.ph - y) / geom.ph) * 100) / 100, 0, 1);
      return { b, v };
    };
    const set = (ev: PointerEvent) => {
      const p = at(ev);
      if (last && Math.abs(p.b - last.b) > 1) {
        const dir = p.b > last.b ? 1 : -1;
        for (let b = last.b; b !== p.b + dir; b += dir) sketch[b] = lerp(last.v, p.v, (b - last.b) / (p.b - last.b));
      }
      sketch[p.b] = p.v;
      last = p;
      paintBars();
      refreshRun();
    };
    hit.addEventListener('pointerdown', (ev) => {
      if (phase !== 'ask') return;
      dragging = true; last = null;
      hit.setPointerCapture(ev.pointerId);
      set(ev);
      ev.preventDefault();
    });
    hit.addEventListener('pointermove', (ev) => { if (dragging && phase === 'ask') set(ev); });
    const end = () => { dragging = false; last = null; };
    hit.addEventListener('pointerup', end);
    hit.addEventListener('pointercancel', end);
    hit.classList.add('ho-gac__hit--draw');
  }

  // ── Running ────────────────────────────────────────────────────────────────
  const scrub = h('input', { type: 'range', class: 'ho-range', min: 0, max: steps, step: 'any', value: 0, 'aria-label': 'Time', 'data-role': 'scrub' }) as HTMLInputElement;
  const again = button('Play again', 'ghost', () => play(), { small: true, 'data-action': 'again' });
  const skip = button('Skip to the end', 'ghost', () => skipToEnd(), { small: true, 'data-action': 'skip' });
  const scrubRow = h('div', { class: 'ho-gac__scrub', hidden: true }, h('label', { class: 'mnx-label' }, 'Time'), scrub, again, skip);
  scrub.addEventListener('input', () => {
    if (phase !== 'done') return;
    playing?.(); playing = null;
    seek(Number(scrub.value));
  });

  function seek(fi: number) {
    frameAt = clamp(fi, 0, steps);
    scrub.value = String(frameAt);
    scrub.style.setProperty('--fill', `${(frameAt / steps) * 100}%`);
    paintBars(); paintField(); linePaint?.();
  }

  function play() {
    playing?.();
    const after = phase === 'done';
    scrub.disabled = true;
    again.disabled = true;
    skip.hidden = after;
    let over = false;
    const stop = tween(PLAY_MS, (p) => seek(p * steps), () => { over = true; playing = null; skip.hidden = true; scrub.disabled = false; again.disabled = false; if (!after) finish(); else seek(steps); }, (t) => t);
    if (!over) playing = stop;
  }

  function skipToEnd() {
    if (phase === 'ask' || !playing) return;
    const after = phase === 'done';
    playing(); playing = null;
    skip.hidden = true;
    seek(steps);
    scrub.disabled = false; again.disabled = false;
    if (!after) finish();
  }

  function run() {
    if (phase !== 'ask' || !committed(task, attempt())) return;
    phase = 'run';
    wrap.dataset.phase = 'run';
    picks.forEach((b) => { b.disabled = true; });
    if (input) input.disabled = true;
    runButton.disabled = true;
    hintLine.textContent = '';
    controls.setAttribute('data-locked', 'true');
    if (rung === 1) controls.hidden = true;
    layout();
    paintField();
    if (rung === 1) tween(500, (p) => { ghostScale = p; paintBars(); }, undefined, (t) => 1 - Math.pow(1 - t, 3));
    scrubRow.hidden = false;
    play();
  }

  function finish() {
    phase = 'done';
    wrap.dataset.phase = 'done';
    scrub.disabled = false; again.disabled = false;
    const verdict = result(task, attempt());
    // Mark what was right and wrong.
    if (rung === 0) {
      picks.forEach((b) => { b.dataset.reveal = b.dataset.stagePick === spec.stages[task.top].id ? 'right' : (b.getAttribute('aria-pressed') === 'true' ? 'wrong' : 'none'); });
    }
    zoneEls[task.top].el.dataset.top = 'true';
    if (rung === 1) {
      const o = overlap(sketch, histOf(sim.frames[steps]));
      status.textContent = `Your bars and the real ones overlap by ${Math.round(o * 100)}%.`;
    } else if (rung >= 2 && task.answer !== null) {
      status.textContent = task.ask.kind === 'time'
        ? `You said ${fmt(guessValue ?? NaN)} ${spec.unit}; the model gives ${fmt(task.answer)} ${spec.unit}.`
        : `You said ${fmt(guessValue ?? NaN)}%; the model gives ${Math.round(task.answer)}%.`;
    } else status.textContent = verdict.met ? 'Yes.' : `Not quite: most are in ${q(spec.stages[task.top].label)}.`;
    status.dataset.kind = verdict.met ? 'hint' : 'wrong';
    layout();
    timers.push(window.setTimeout(() => { if (!stopped && !handed) { handed = true; done(attempt()); } }, reducedMotion() ? 0 : 500));
  }

  // ── Putting it together ────────────────────────────────────────────────────
  const noteBits: Array<HTMLElement | null> = [
    spec.illustrative ? h('p', { class: 'ho-gac__badge', 'data-role': 'illustrative' }, 'Illustrative numbers') : null,
    h('p', { class: 'ho-note', 'data-role': 'spec-note' }, spec.note),
  ];
  const info = h('div', { class: 'ho-gac__info' }, ...noteBits);
  wrap.append(head, card, legend, scrubRow, ...(lineCard ? [lineCard] : []), field, controls, runRow, status, info);

  const observers: ResizeObserver[] = [];
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { layout(); lineLayout?.(); });
    ro.observe(plotBox);
    if (lineBox) ro.observe(lineBox);
    observers.push(ro);
  }
  layout();
  lineLayout?.();
  paintField();
  refreshRun();
  if (rung === 2) timers.push(window.setTimeout(() => input?.focus({ preventScroll: true }), 50));

  return () => {
    stopped = true;
    playing?.();
    for (const s of stops) s();
    for (const t of timers) clearTimeout(t);
    for (const o of observers) o.disconnect();
  };
}

export const grow: Engine<GrowSpec, GrowTask, GrowAttempt> = {
  id: 'grow',
  label: 'Grow, Arrest, Count',
  rungNames: ['Which stage', 'The shape', 'The number'],
  issues,
  prepare,
  view,
  result,
};
