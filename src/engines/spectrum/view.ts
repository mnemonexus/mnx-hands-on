/**
 * Read the Spectrum, the view: draws one simulated spectrum and hands the attempt back.
 *
 *   ask     the peaks are bare. The student taps them to read their m/z, works things out, and commits by pressing Check
 *           (or, on a ladder, by choosing a residue for each gap in turn).
 *   reveal  the truth is drawn over the spectrum: the charges, the gaps, the residue. The student's own answer stays beside
 *           it, and a wrong assignment shows itself as a mass that does not agree or a charge that is not a whole number.
 */
import './spectrum.css';
import { type Engine } from '../../engine';
import { button, h } from '../../dom';
import { svgEl } from '../../plot';
import { ticks } from '../../scale';
import { C13_SPACING, PROTON, RESIDUES, RESIDUE_CHOICES, WATER } from './masses';
import {
  chargeText, fixed, issues, prepare, readMass, result, workingFor,
  type Peak, type SpectrumAttempt, type SpectrumSpec, type SpectrumTask,
} from './logic';

// ── The drawing frame ────────────────────────────────────────────────────────

const Y_TOP = 1.5;

class Frame {
  readonly root = h('div', { class: 'ho-sp__frame' });
  readonly svg = svgEl('svg', { class: 'ho-sp__svg', role: 'img' });
  readonly back = svgEl('g', {}, this.svg);
  readonly under = svgEl('g', {}, this.svg);
  readonly peaks = svgEl('g', {}, this.svg);
  readonly over = svgEl('g', {}, this.svg);
  w = 0;
  h = 0;
  readonly m = { l: 16, r: 16, t: 14, b: 44 };
  private readonly listeners: Array<() => void> = [];
  private readonly observer: ResizeObserver;

  constructor(parent: HTMLElement, readonly xmin: number, readonly xmax: number, label: string) {
    this.svg.setAttribute('aria-label', label);
    this.root.append(this.svg as unknown as Node);
    parent.append(this.root);
    this.observer = new ResizeObserver(() => { if (this.root.clientWidth !== this.w) this.layout(); });
    this.observer.observe(this.root);
    this.layout();
  }

  get left() { return this.m.l; }
  get right() { return this.w - this.m.r; }
  get top() { return this.m.t; }
  get bottom() { return this.h - this.m.b; }
  px(x: number) { return this.left + ((x - this.xmin) / (this.xmax - this.xmin)) * (this.right - this.left); }
  py(v: number) { return this.bottom - (v / Y_TOP) * (this.bottom - this.top); }
  onLayout(fn: () => void) { this.listeners.push(fn); }

  layout() {
    const width = Math.round(this.root.clientWidth);
    if (width < 40) return;
    this.w = width;
    this.h = Math.round(Math.max(235, Math.min(340, width * 0.42)));
    this.svg.setAttribute('viewBox', `0 0 ${this.w} ${this.h}`);
    this.svg.setAttribute('width', String(this.w));
    this.svg.setAttribute('height', String(this.h));
    this.drawAxes();
    for (const fn of this.listeners) fn();
  }

  private drawAxes() {
    const g = this.back;
    g.replaceChildren();
    const { left, right, top, bottom } = this;
    svgEl('rect', { class: 'ho-sp__area', x: left, y: top, width: right - left, height: bottom - top }, g);
    const tk = ticks({ min: this.xmin, max: this.xmax, scale: 'linear' }, Math.max(3, Math.round((right - left) / 95)));
    const step = tk.length > 1 ? tk[1].value - tk[0].value : 1;
    const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
    for (const t of tk) {
      const x = this.px(t.value);
      svgEl('line', { class: 'ho-sp__grid', x1: x, x2: x, y1: top, y2: bottom }, g);
      svgEl('line', { class: 'ho-sp__tick', x1: x, x2: x, y1: bottom, y2: bottom + 4 }, g);
      svgEl('text', { class: 'ho-sp__ticklabel', x, y: bottom + 18, 'text-anchor': 'middle' }, g).textContent = fixed(t.value, decimals);
    }
    svgEl('line', { class: 'ho-sp__axis', x1: left, x2: right, y1: bottom, y2: bottom }, g);
    svgEl('text', { class: 'ho-sp__axistitle', x: (left + right) / 2, y: this.h - 8, 'text-anchor': 'middle' }, g).textContent = 'm/z';
  }

  destroy() { this.observer.disconnect(); this.root.remove(); }
}

const el = {
  text: (parent: Element, cls: string, content: string, x: number, y: number) => { const t = svgEl('text', { class: cls, x, y }, parent); t.textContent = content; return t; },
};

// ── The view ─────────────────────────────────────────────────────────────────

function view(root: HTMLElement, task: SpectrumTask, done: (attempt: SpectrumAttempt) => void): () => void {
  const { spec, rung, kind } = task;
  const d = task.decimals;
  const stops: Array<() => void> = [];
  const timers: number[] = [];
  let phase: 'ask' | 'after' = 'ask';
  const sel: number[] = [];

  const wrap = h('div', { class: 'ho-sp', 'data-engine': 'spectrum', 'data-kind': kind, 'data-rung': String(rung), 'data-phase': 'ask' });
  root.append(wrap);
  wrap.append(
    h('p', { class: 'ho-sp__announce', 'data-role': 'announce' }, task.announce),
    h('p', { class: 'ho-sp__question', 'data-role': 'question' }, task.question),
  );

  // ── The spectrum ───────────────────────────────────────────────────────────
  const card = h('div', { class: 'ho-sp__card' });
  wrap.append(card);
  const frame = new Frame(card, task.xmin, task.xmax, `A simulated mass spectrum with ${task.peaks.length} peaks`);
  stops.push(() => frame.destroy());
  const legend = h('div', { class: 'ho-sp__sim' }, h('span', null, h('b', null, 'Simulated spectrum.'), ' Peak heights are only illustrative.'));
  if (kind === 'ladder') {
    legend.append(h('span', { class: 'ho-sp__key' }, h('i', { 'data-role': 'y' }), 'y ions'), h('span', { class: 'ho-sp__key' }, h('i', { 'data-role': 'b' }), 'b ions'));
  } else if (task.peaks.some((p) => p.role === 'adduct')) {
    legend.append(h('span', null, 'The smaller peaks beside a main peak carry an adduct.'));
  }
  card.append(legend);

  const els = new Map<number, { g: SVGGElement; stem: SVGLineElement; apex: SVGCircleElement; tag: SVGTextElement; ring: SVGCircleElement; focus: SVGCircleElement; hit: SVGRectElement }>();
  for (const p of task.peaks) {
    const g = svgEl('g', { class: 'ho-sp__peak', 'data-id': String(p.id), 'data-role': p.role, 'data-selected': 'false', 'data-lit': 'false', tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': `Peak at m/z ${fixed(p.mz, d)}` }, frame.peaks);
    const hit = svgEl('rect', { class: 'ho-sp__hit' }, g);
    const stem = svgEl('line', { class: 'ho-sp__stem' }, g);
    const apex = svgEl('circle', { class: 'ho-sp__apex', r: 4.5 }, g);
    const ring = svgEl('circle', { class: 'ho-sp__ring', r: 10 }, g);
    const focus = svgEl('circle', { class: 'ho-sp__focus', r: 14 }, g);
    const tag = svgEl('text', { class: 'ho-sp__tag' }, g);
    ring.style.display = 'none';
    els.set(p.id, { g, stem, apex, tag, ring, focus, hit });
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(p.id); }
      else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        const order = [...task.peaks].sort((a, b) => a.mz - b.mz);
        const i = order.findIndex((q) => q.id === p.id) + (ev.key === 'ArrowRight' ? 1 : -1);
        if (order[i]) { ev.preventDefault(); els.get(order[i].id)?.g.focus(); }
      }
    });
  }
  const tagText = new Map<number, string>();
  const permanentTag = (id: number, text: string | null) => { if (text === null) tagText.delete(id); else tagText.set(id, text); place(); };
  const tagFor = (p: Peak) => tagText.get(p.id) ?? (sel.includes(p.id) && phase === 'ask' ? fixed(p.mz, d) : '');
  function place() {
    if (!frame.w) return;
    for (const p of task.peaks) {
      const e = els.get(p.id) as NonNullable<ReturnType<typeof els.get>>;
      const x = frame.px(p.mz); const y = frame.py(p.h);
      e.hit.setAttribute('x', String(x - 13)); e.hit.setAttribute('y', String(frame.top)); e.hit.setAttribute('width', '26'); e.hit.setAttribute('height', String(frame.bottom - frame.top));
      e.stem.setAttribute('x1', String(x)); e.stem.setAttribute('x2', String(x)); e.stem.setAttribute('y1', String(frame.bottom)); e.stem.setAttribute('y2', String(y));
      e.apex.setAttribute('cx', String(x)); e.apex.setAttribute('cy', String(y));
      e.ring.setAttribute('cx', String(x)); e.ring.setAttribute('cy', String(y));
      e.focus.setAttribute('cx', String(x)); e.focus.setAttribute('cy', String(y));
      e.tag.setAttribute('x', String(x)); e.tag.setAttribute('y', String(y - 12));
      e.tag.textContent = tagFor(p);
    }
    drawMarks();
  }
  frame.onLayout(place);

  // ── Tapping ────────────────────────────────────────────────────────────────
  const readout = h('p', { class: 'ho-sp__readout', role: 'status', 'data-role': 'readout' });
  wrap.append(readout);
  const readoutIdle = () => {
    const hint = kind === 'ladder' ? 'Tap a peak to read its m/z. Each gap you are asked about is highlighted for you.'
      : kind === 'shift' ? 'Tap the new peak to read its m/z. The marked peak is the one before treatment.'
      : kind === 'isotope' ? 'Tap two neighbouring peaks to measure the gap between them.'
      : kind === 'pair' ? 'Tap the two marked peaks to read their m/z. Tap any others you want to read.'
      : 'Tap peaks to read their m/z.';
    readout.replaceChildren(hint);
  };
  function paintSel() {
    for (const p of task.peaks) {
      const e = els.get(p.id) as NonNullable<ReturnType<typeof els.get>>;
      const on = sel.includes(p.id);
      e.g.dataset.selected = String(on);
      e.g.setAttribute('aria-pressed', String(on));
    }
    const picked = sel.map((id) => task.peaks[id]).sort((a, b) => a.mz - b.mz);
    if (!picked.length) readoutIdle();
    else if (picked.length === 1) readout.replaceChildren('m/z ', h('b', null, fixed(picked[0].mz, d)));
    else {
      const gaps = picked.slice(1).map((p, i) => fixed(p.mz - picked[i].mz, d));
      readout.replaceChildren(`m/z ${picked.map((p) => fixed(p.mz, d)).join(', ')}. Gap${gaps.length > 1 ? 's' : ''} between neighbours: `, h('b', null, gaps.join(', ')));
    }
    place();
    refreshWork();
  }
  function toggle(id: number) {
    if (phase !== 'ask' && kind !== 'ladder') return;
    const at = sel.indexOf(id);
    if (at >= 0) sel.splice(at, 1);
    else { sel.push(id); if (sel.length > 4) sel.shift(); }
    paintSel();
  }
  frame.svg.addEventListener('click', (ev) => {
    const r = frame.svg.getBoundingClientRect();
    const x = ev.clientX - r.left;
    let best = -1; let bestD = 16;
    for (const p of task.peaks) { const dist = Math.abs(frame.px(p.mz) - x); if (dist < bestD) { bestD = dist; best = p.id; } }
    if (best >= 0) toggle(best);
  });

  // ── Marks drawn over the spectrum ─────────────────────────────────────────
  type Mark = { kind: 'bracket'; a: number; b: number; text: string; state?: 'met' | 'miss'; level: number }
    | { kind: 'label'; mz: number; h: number; text: string; cls?: string; dy?: number }
    | { kind: 'ghost'; mz: number; text: string };
  let marks: Mark[] = [];
  function drawMarks() {
    frame.over.replaceChildren();
    if (!frame.w) return;
    for (const m of marks) {
      if (m.kind === 'bracket') {
        const x1 = frame.px(m.a); const x2 = frame.px(m.b);
        const y = frame.top + 12 + m.level * 22;
        const g = svgEl('g', {}, frame.over);
        svgEl('path', { class: 'ho-sp__bracket', 'data-state': m.state, d: `M${x1} ${y + 6} L${x1} ${y} L${x2} ${y} L${x2} ${y + 6}` }, g);
        el.text(g, 'ho-sp__label', m.text, (x1 + x2) / 2, y - 5);
      } else if (m.kind === 'label') {
        el.text(frame.over, m.cls ?? 'ho-sp__label', m.text, frame.px(m.mz), frame.py(m.h) - (m.dy ?? 28));
      } else {
        const x = frame.px(m.mz);
        const g = svgEl('g', {}, frame.over);
        svgEl('path', { class: 'ho-sp__ghost', d: `M${x} ${frame.bottom} L${x} ${frame.bottom - 26}` }, g);
        svgEl('circle', { class: 'ho-sp__ghost', cx: x, cy: frame.bottom - 30, r: 4.5 }, g);
        if (m.text) el.text(g, 'ho-sp__tag ho-sp__tag--you', m.text, x, frame.bottom - 40);
      }
    }
  }
  const lit = (ids: number[]) => { for (const p of task.peaks) (els.get(p.id) as NonNullable<ReturnType<typeof els.get>>).g.dataset.lit = String(ids.includes(p.id)); };

  place();

  // ── The pair that is marked ────────────────────────────────────────────────
  if (kind === 'pair') for (const id of task.pair) (els.get(id) as NonNullable<ReturnType<typeof els.get>>).ring.style.display = '';
  if (kind === 'shift') {
    (els.get(0) as NonNullable<ReturnType<typeof els.get>>).ring.style.display = '';
    permanentTag(0, fixed(task.peaks[0].mz, d));
  }

  // ── Asking ─────────────────────────────────────────────────────────────────
  const controls = h('div', { class: 'ho-sp__controls', 'data-role': 'controls' });
  const status = h('p', { class: 'ho-sp__status', role: 'status', 'data-role': 'gap', hidden: true });
  const check = button('Check', 'primary', () => commit(), { 'data-action': 'check', disabled: true });
  const problem = h('p', { class: 'mnx-help mnx-help--error', role: 'alert', hidden: true, 'data-role': 'problem' });
  let collect: () => SpectrumAttempt | null = () => null;
  let filled: () => boolean = () => collect() !== null;
  let massInput: HTMLInputElement | null = null;
  const refresh = () => { check.disabled = !filled(); };
  const work = h('div', { class: 'ho-sp__work', 'data-role': 'working', hidden: true });
  let showWork = false;
  const workBtn = button('Show the working', 'ghost', () => { showWork = !showWork; refreshWork(); }, { small: true, 'data-action': 'working' });
  let chargeInput: HTMLInputElement | null = null;

  function refreshWork() {
    workBtn.textContent = showWork ? 'Hide the working' : 'Show the working';
    work.hidden = !showWork;
    if (!showWork) return;
    work.replaceChildren();
    if (kind === 'isotope') {
      const picked = sel.map((id) => task.peaks[id]).sort((a, b) => a.mz - b.mz);
      if (picked.length >= 2) {
        const gap = picked[1].mz - picked[0].mz;
        work.append(h('p', null, `Neighbouring isotope peaks are one 13C apart, 1.003 mass units, so their gap on the m/z scale is 1.003 ÷ z.`), h('p', null, `Your two peaks are ${fixed(gap, d)} apart, so z = 1.003 ÷ ${fixed(gap, d)} = ${fixed(C13_SPACING / gap, 2)}.`));
        if (picked.length > 2 || Math.abs(C13_SPACING / gap - Math.round(C13_SPACING / gap)) > 0.15) work.append(h('p', { 'data-kind': 'check' }, 'That is not close to a whole number: check that the two peaks are neighbours.'));
      } else work.append(h('p', null, 'Neighbouring isotope peaks are one 13C apart, 1.003 mass units, so their gap on the m/z scale is 1.003 ÷ z.'), h('p', null, 'Tap two neighbouring peaks and the working will use their gap.'));
    } else {
      const z = chargeInput && /^\d+$/.test(chargeInput.value.trim()) ? Number(chargeInput.value.trim()) : undefined;
      for (const line of workingFor(task, z)) work.append(h('p', { 'data-kind': line.startsWith('If n') ? 'check' : '' }, line));
    }
  }

  const reference = referencePanel(task);

  if (kind === 'isotope') {
    const zTop = Math.min(spec.charges[1], 12);
    let chosen = 0;
    const row = h('div', { class: 'ho-sp__zrow', role: 'group', 'aria-label': 'The charge' });
    for (let z = spec.charges[0]; z <= zTop; z++) {
      row.append(h('button', {
        type: 'button', class: 'ho-sp__btn', 'data-z': String(z), 'aria-pressed': 'false',
        onclick: () => { if (phase !== 'ask') return; chosen = z; row.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === String(z)))); refresh(); },
      }, chargeText(z, task.mode)));
    }
    collect = () => (chosen ? { kind: 'charge', z: chosen } : null);
    controls.append(row);
  } else if (kind === 'pair' || kind === 'deconvolute') {
    const fields = h('div', { class: 'ho-sp__fields', 'data-cols': kind === 'pair' ? '2' : '1' });
    const mass = h('input', { type: 'text', class: 'mnx-input', id: 'ho-sp-mass', autocomplete: 'off', spellcheck: 'false', inputmode: 'text', placeholder: 'a number, or a sum such as 15 × (824.85 − 1)', 'aria-label': 'The mass in Da', 'data-role': 'answer' }) as HTMLInputElement;
    const preview = h('p', { class: 'ho-sp__preview', 'data-role': 'preview' });
    if (kind === 'pair') {
      chargeInput = h('input', { type: 'text', class: 'mnx-input', id: 'ho-sp-charge', autocomplete: 'off', inputmode: 'numeric', placeholder: 'a whole number', 'aria-label': 'The charge on the right-hand marked peak', 'data-role': 'charge' }) as HTMLInputElement;
      fields.append(h('div', { class: 'ho-sp__field' }, h('label', { class: 'mnx-label', for: 'ho-sp-charge' }, 'Charge, right-hand marked peak'), chargeInput));
    }
    fields.append(h('div', { class: 'ho-sp__field' }, h('label', { class: 'mnx-label', for: 'ho-sp-mass' }, `Mass in Da (${task.massType})`), mass, preview));
    controls.append(fields);
    massInput = mass;
    filled = () => !!mass.value.trim() && (kind === 'deconvolute' || !!chargeInput?.value.trim());
    const onType = () => {
      problem.hidden = true;
      const r = mass.value.trim() ? readMass(mass.value) : null;
      preview.textContent = r && r.ok ? `Read as ${fixed(r.value, 2, true)} Da` : '';
      refresh();
      refreshWork();
    };
    mass.addEventListener('input', onType);
    chargeInput?.addEventListener('input', onType);
    const enter = (ev: KeyboardEvent) => { if (ev.key === 'Enter') { ev.preventDefault(); if (!check.disabled) commit(); } };
    mass.addEventListener('keydown', enter);
    chargeInput?.addEventListener('keydown', enter);
    collect = () => {
      const r = mass.value.trim() ? readMass(mass.value) : null;
      if (!r || !r.ok) return null;
      if (kind === 'deconvolute') return { kind: 'mass', mass: r.value, text: mass.value.trim() };
      const zt = chargeInput?.value.trim() ?? '';
      return /^\d+$/.test(zt) && Number(zt) >= 1 ? { kind: 'pair', z: Number(zt), mass: r.value, text: mass.value.trim() } : null;
    };
  } else if (kind === 'shift') {
    let mod = '';
    let count = 0;
    const mods = h('div', { class: 'ho-sp__zrow', role: 'group', 'aria-label': 'Which modification' });
    for (const o of task.options) mods.append(h('button', { type: 'button', class: 'ho-sp__btn', 'data-mod': o.id, 'aria-pressed': 'false', onclick: () => { if (phase !== 'ask') return; mod = o.id; mods.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mod === o.id))); refresh(); } }, o.name));
    const counts = h('div', { class: 'ho-sp__zrow', role: 'group', 'aria-label': 'How many' });
    for (const c of [1, 2, 3]) counts.append(h('button', { type: 'button', class: 'ho-sp__btn', 'data-count': String(c), 'aria-pressed': 'false', onclick: () => { if (phase !== 'ask') return; count = c; counts.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.count === String(c)))); refresh(); } }, `${c} ×`));
    collect = () => (mod && count ? { kind: 'shift', mod, count } : null);
    controls.append(h('p', { class: 'ho-sp__hint' }, 'Which modification?'), mods, h('p', { class: 'ho-sp__hint' }, 'How many were added?'), counts);
  } else {
    buildLadder();
  }

  if (kind !== 'ladder') {
    controls.append(problem, h('div', { class: 'ho-sp__line' }, check, rung <= 1 ? workBtn : null));
    wrap.append(controls, work);
  } else wrap.append(controls);
  wrap.append(status, reference);
  readoutIdle();

  // ── Ladder: one residue at a time ──────────────────────────────────────────
  function buildLadder() {
    const picks: string[] = [];
    const rows: HTMLElement[] = [];
    const box = h('div', { class: 'ho-sp__rows' });
    controls.append(box);
    const open = (i: number) => {
      rows.forEach((r, k) => { if (r.dataset.state === 'locked' || r.dataset.state === 'open') r.dataset.state = k === i ? 'open' : 'locked'; });
      const row = task.rows[i];
      lit([row.to, ...(row.from === null ? [] : [row.from])]);
      marks = [];
      for (let k = 0; k < i; k++) addRowMark(k);
      if (row.from !== null) marks.push({ kind: 'bracket', a: task.peaks[row.from].mz, b: task.peaks[row.to].mz, text: `${fixed(row.delta, 3)}`, level: 0 });
      place();
    };
    function addRowMark(k: number) {
      const row = task.rows[k];
      const ok = picks[k] === row.answer;
      if (row.from !== null) marks.push({ kind: 'bracket', a: task.peaks[row.from].mz, b: task.peaks[row.to].mz, text: ok ? row.answer : `${row.answer} (you: ${picks[k]})`, state: ok ? 'met' : 'miss', level: (k % 2) });
      else marks.push({ kind: 'label', mz: task.peaks[row.to].mz, h: task.peaks[row.to].h, text: ok ? row.answer : `${row.answer} (you: ${picks[k]})`, dy: 26 });
    }
    task.rows.forEach((row, i) => {
      const grid = h('div', { class: 'ho-sp__resgrid', role: 'group', 'aria-label': `Residue for ${row.ask}` });
      const head = h('div', { class: 'ho-sp__rowhead' }, h('span', { class: 'ho-sp__rowask' }, `${i + 1}. ${row.ask}`), h('span', { class: 'ho-sp__rowgap', 'data-role': 'gap' }, `${row.label}: ${fixed(row.delta, 3)}`));
      const result = h('p', { class: 'ho-sp__rowresult', hidden: true, 'data-role': 'rowresult' });
      for (const choice of RESIDUE_CHOICES) {
        grid.append(h('button', {
          type: 'button', class: 'ho-sp__btn ho-sp__res', 'data-res': choice.id, title: choice.name,
          onclick: () => answer(i, choice.id, grid, result),
        }, h('b', null, choice.id), h('span', null, choice.three)));
      }
      const r = h('div', { class: 'ho-sp__row', 'data-row': String(i), 'data-state': i === 0 ? 'open' : 'locked' }, head, grid, result);
      rows.push(r);
      box.append(r);
    });
    function answer(i: number, id: string, grid: HTMLElement, resultEl: HTMLElement) {
      if (phase !== 'ask' || picks[i] !== undefined || rows[i].dataset.state !== 'open') return;
      picks[i] = id;
      const row = task.rows[i];
      const ok = id === row.answer;
      grid.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.disabled = true;
        if (b.dataset.res === row.answer) b.dataset.state = 'correct';
        else if (b.dataset.res === id) b.dataset.state = 'incorrect';
      });
      const rm = (g: string) => RESIDUES[task.massType][g === 'L/I' ? 'L' : g];
      resultEl.hidden = false;
      resultEl.textContent = ok
        ? `✓ ${fixed(row.delta, 3)} is ${row.answer}.`
        : `✗ You chose ${id} (${fixed(rm(id), 3)}), but the gap is ${fixed(row.delta, 3)}, which is ${row.answer} (${fixed(rm(row.answer), 3)}).`;
      rows[i].dataset.state = ok ? 'met' : 'miss';
      marks = [];
      for (let k = 0; k <= i; k++) addRowMark(k);
      place();
      if (i + 1 < task.rows.length) { rows[i + 1].dataset.state = 'open'; open(i + 1); }
      else finish({ kind: 'ladder', picks: [...picks] });
    }
    // Names of the ions read, shown once the ladder is finished.
    stops.push(() => undefined);
    open(0);
  }

  // ── Committing and revealing ───────────────────────────────────────────────
  function commit() {
    if (phase !== 'ask') return;
    const a = collect();
    if (!a) {
      if (kind === 'pair' || kind === 'deconvolute') {
        const r = massInput && massInput.value.trim() ? readMass(massInput.value) : { ok: false as const, problem: 'Type the mass first.' };
        problem.textContent = r.ok ? 'Give the charge as a whole number, such as 12.' : r.problem;
        problem.hidden = false;
      }
      return;
    }
    finish(a);
  }

  function finish(a: SpectrumAttempt) {
    phase = 'after';
    wrap.dataset.phase = 'after';
    controls.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach((b) => { if (kind !== 'ladder') b.disabled = true; });
    const verdict = result(task, a);
    reveal(a, verdict.met);
    status.hidden = false;
    const own = a.kind === 'pair' && a.z !== task.n ? ` ${workingFor(task, a.z).filter((l) => l.startsWith('If n')).join(' ')}` : '';
    status.textContent = `${verdict.met ? '✓ Right. ' : '✗ '}${verdict.why}${own}`;
    status.dataset.state = verdict.met ? 'met' : 'miss';
    if (kind !== 'ladder') { if (showWork) refreshWork(); }
    place();
    timers.push(window.setTimeout(() => done(a), 420));
  }

  function reveal(a: SpectrumAttempt, met: boolean) {
    lit([]);
    if (kind === 'isotope') {
      const z = task.z;
      const first = task.peaks[0]; const second = task.peaks[1];
      marks = [
        { kind: 'bracket', a: first.mz, b: second.mz, text: `gap ${fixed(second.mz - first.mz, 3)}`, state: met ? 'met' : undefined, level: 0 },
        { kind: 'label', mz: (first.mz + second.mz) / 2, h: Math.max(first.h, second.h), text: `z = ${chargeText(z, task.mode)}`, dy: 40 },
      ];
      if (a.kind === 'charge' && a.z !== z) {
        const s = C13_SPACING / a.z;
        for (let i = 0; i < task.peaks.length; i++) {
          const mz = first.mz + i * s;
          if (mz <= task.xmax) marks.push({ kind: 'ghost', mz, text: i === 0 ? `you: ${chargeText(a.z, task.mode)}` : '' });
        }
      }
    } else if (kind === 'pair' || kind === 'deconvolute') {
      marks = [];
      for (const id of task.series) { const p = task.peaks[id]; permanentTag(id, null); marks.push({ kind: 'label', mz: p.mz, h: p.h, text: chargeText(p.z as number, task.mode), dy: 14 }); }
      for (const p of task.peaks) if (p.role === 'adduct') marks.push({ kind: 'label', mz: p.mz, h: p.h, text: p.tag ?? '', cls: 'ho-sp__tag', dy: 12 });
      if (kind === 'pair' && a.kind === 'pair' && a.z !== task.n) {
        const right = task.peaks[task.pair[1]];
        marks.push({ kind: 'ghost', mz: right.mz, text: `you: ${chargeText(a.z, task.mode)}` });
      }
    } else if (kind === 'shift') {
      const b = task.peaks[0]; const af = task.peaks[1];
      permanentTag(1, fixed(af.mz, d));
      const lo = Math.min(b.mz, af.mz); const hi = Math.max(b.mz, af.mz);
      marks = [{ kind: 'bracket', a: lo, b: hi, text: `${fixed(Math.abs(af.mz - b.mz), 3)} × ${task.z} = ${fixed(Math.abs(task.delta), 2)} Da`, state: met ? 'met' : undefined, level: 0 }];
    } else if (kind === 'ladder') {
      for (const p of task.peaks) if (p.role === task.ionKind) permanentTag(p.id, `${p.role}${p.ion}`);
    }
    drawMarks();
  }

  return () => {
    for (const t of timers) clearTimeout(t);
    for (const s of stops.reverse()) s();
    wrap.remove();
  };
}

/** The reference a student may open: constants, and the tables of residues or modifications the spec gives. */
function referencePanel(task: SpectrumTask): HTMLElement {
  const box = h('details', { class: 'ho-sp__ref', 'data-role': 'reference' }, h('summary', null, task.kind === 'ladder' ? 'Residue masses' : task.kind === 'shift' ? 'Modification masses' : 'Numbers you may need'));
  const type = task.massType;
  if (task.kind === 'ladder') {
    box.append(h('p', null, `Residue masses (${type}), in Da. A y ion is its residues plus a water (${fixed(WATER[type], 3)}) and a proton (${fixed(PROTON, 3)}); a b ion is its residues plus a proton.`));
    const body = h('tbody');
    for (const c of RESIDUE_CHOICES) body.append(h('tr', null, h('th', { scope: 'row' }, c.id), h('td', null, c.name), h('td', null, fixed(RESIDUES[type][c.letters[0]], 3))));
    box.append(h('table', { class: 'ho-sp__table ho-sp__table--cols' }, body));
  } else if (task.kind === 'shift') {
    box.append(h('p', null, 'Mass added by each modification, in Da (a negative number is a loss). The shift in m/z is the mass change divided by the charge.'));
    const body = h('tbody');
    for (const m of task.options) body.append(h('tr', null, h('th', { scope: 'row' }, m.name), h('td', null, `${m.delta > 0 ? '+' : '−'}${fixed(Math.abs(m.delta), 3)}`), h('td', null, m.residues ? m.residues.join(', ') : '')));
    box.append(h('table', { class: 'ho-sp__table' }, body));
  } else {
    box.append(h('p', null, `One proton is ${fixed(PROTON, 5)}. ${task.kind === 'isotope' ? `Carbon-13 is ${fixed(C13_SPACING, 3)} heavier than carbon-12.` : `Rounding the proton to 1 is close enough here. Masses are ${type}.`}`));
    if (task.kind !== 'isotope') box.append(h('p', null, task.mode === 'positive' ? 'In positive mode an ion gains protons: m/z = (M + n × proton) ÷ n.' : 'In negative mode an ion loses protons: m/z = (M − n × proton) ÷ n.'));
  }
  return box;
}

export const spectrum: Engine<SpectrumSpec, SpectrumTask, SpectrumAttempt> = {
  id: 'spectrum',
  label: 'Read the Spectrum',
  rungNames: ['Read the charge', 'Charge and mass', 'Work it out unaided'],
  issues,
  prepare,
  view,
  result,
};
