/**
 * Break the Construct, the view: draws one round and hands the attempt back.
 *
 *   ask     the construct is drawn with its change. The student commits by choosing the readout in each condition (and, with
 *           two copies, whether the copies complement). Nothing arrives until they press Run.
 *   run     condition by condition the factors arrive, take hold of what is there or fail to, and the readout comes up.
 *   after   the guess stays beside the truth in every condition; the attempt is handed back once the last one has landed.
 */
import './construct.css';
import { reducedMotion, type Engine } from '../../engine';
import { button, h } from '../../dom';
import { tween } from '../../motion';
import { svgEl } from '../../plot';
import {
  the, agree, evalCell, issues, levelName, prepare, result, soft, startUpper, verbOf,
  type BCondition, type BRule, type BreakAttempt, type BreakSpec, type BreakTask, type CellEval, type FactorState, type PartState,
} from './logic';

const TRAVEL_MS = 750;
const HOLD_MS = 1100;
const upper = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const STATE_WORD: Record<PartState['kind'], string> = { ok: '', deleted: 'deleted', mutated: 'changed', flipped: 'flipped' };

interface Link {
  rule: number;
  copy: number;
  chip: HTMLElement;
  tile: HTMLElement;
  g: SVGGElement;
  path: SVGPathElement;
  arrow: SVGPolygonElement;
  bar: SVGPathElement;
  jitter: number;
}

function view(root: HTMLElement, task: BreakTask, done: (attempt: BreakAttempt) => void): () => void {
  const { spec, rung } = task;
  const copiesN = task.copies.length;
  const stops: Array<() => void> = [];
  const timers: number[] = [];
  let cancel: Array<() => void> = [];
  let phase: 'ask' | 'run' | 'after' = 'ask';
  let attempt: BreakAttempt | null = null;
  let shown = 0;
  const levels = spec.readout.levels;
  const lastLevel = levels.length - 1;

  const wrap = h('div', { class: 'ho-brk', 'data-engine': 'break', 'data-rung': String(rung), 'data-phase': 'ask', 'data-copies': String(copiesN) });
  root.append(wrap);
  wrap.append(
    h('p', { class: 'ho-brk__announce', 'data-role': 'announce' }, task.announce),
    h('p', { class: 'ho-brk__question', 'data-role': 'question' }, task.question),
  );

  // ── The picture: copies, and the factors between or above them ────────────────
  const card = h('div', { class: 'ho-brk__card' });
  const stage = h('div', { class: 'ho-brk__stage', 'data-role': 'stage' });
  const svg = svgEl('svg', { class: 'ho-brk__links', 'aria-hidden': 'true' });
  const tray = h('div', { class: 'ho-brk__tray', 'data-role': 'tray' });
  const chipEls = new Map<string, HTMLButtonElement>();
  for (const f of spec.factors) {
    const el = h('button', { type: 'button', class: 'ho-brk__chip', 'data-factor': f.id, 'data-state': 'idle' },
      h('span', { class: 'ho-brk__chipname' }, f.label), h('span', { class: 'ho-brk__chipstate' }));
    el.addEventListener('click', () => inspectFactor(f.id));
    chipEls.set(f.id, el);
    tray.append(el);
  }

  const tiles: HTMLElement[][] = [];
  const outs: Array<{ bars: HTMLElement[]; text: HTMLElement; box: HTMLElement }> = [];
  const copyEls = task.copies.map((copy, ci) => {
    const row = h('div', { class: 'ho-brk__row', 'data-copy': String(ci), role: 'group', 'aria-label': copiesN > 1 ? `Copy ${ci + 1}` : 'The construct' });
    const own: HTMLElement[] = [];
    for (const id of copy.order) {
      const p = spec.parts.find((x) => x.id === id) as BreakSpec['parts'][number];
      const st = copy.parts[id];
      const word = STATE_WORD[st.kind] || (st.moved ? 'moved' : '');
      const tile = h('button', {
        type: 'button', class: 'ho-brk__tile', 'data-part': id, 'data-state': st.kind, 'data-moved': String(!!st.moved),
        'aria-label': `${p.label}${word ? `, ${word}` : ''}`,
      }, h('span', { class: 'ho-brk__tilename' }, p.label), word ? h('span', { class: 'ho-brk__tileword' }, word) : null, h('span', { class: 'ho-brk__tags' }));
      tile.addEventListener('click', () => inspectPart(ci, id));
      own.push(tile);
      row.append(tile);
    }
    tiles.push(own);
    const bars = Array.from({ length: lastLevel }, () => h('i'));
    const text = h('span', { class: 'ho-brk__outtext' }, '');
    const box = h('span', { class: 'ho-brk__out', 'data-level': '-1', 'aria-live': 'polite' }, h('span', { class: 'ho-brk__outname' }, spec.readout.name), h('span', { class: 'ho-brk__meter', 'aria-hidden': 'true' }, ...bars), text);
    outs.push({ bars, text, box });
    // The readout sits on the outer side of each copy, away from the factors, so no arrow runs through it.
    const head = h('div', { class: 'ho-brk__copyhead' }, h('span', { class: 'ho-brk__copyname' }, copiesN > 1 ? `Copy ${ci + 1}` : 'The construct'), box);
    return h('div', { class: 'ho-brk__copy' }, ...(copiesN > 1 && ci === 0 ? [head, row] : [row, head]));
  });
  if (copiesN > 1) stage.append(copyEls[0], tray, copyEls[1]);
  else stage.append(tray, copyEls[0]);
  stage.append(svg as unknown as Node);
  card.append(stage);
  wrap.append(card);

  // ── Arrows from the factors to the parts they act on ─────────────────────────
  const links: Link[] = [];
  const perTile = new Map<string, string[]>();
  spec.rules.forEach((r, ri) => {
    if (!r.factor) return;
    task.copies.forEach((_, ci) => {
      const key = `${ci}:${r.part}`;
      const have = perTile.get(key) ?? [];
      if (!have.includes(r.factor as string)) have.push(r.factor as string);
      perTile.set(key, have);
    });
  });
  spec.rules.forEach((r, ri) => {
    if (!r.factor) return;
    task.copies.forEach((copy, ci) => {
      const tile = tiles[ci][copy.order.indexOf(r.part)];
      const g = svgEl('g', { class: 'ho-brk__link', 'data-state': 'hidden', 'data-model': r.notModelled ? 'no' : 'yes', 'data-effect': r.effect }, svg);
      const path = svgEl('path', { class: 'ho-brk__line' }, g);
      const arrow = svgEl('polygon', { class: 'ho-brk__head' }, g);
      const bar = svgEl('path', { class: 'ho-brk__head ho-brk__head--bar' }, g);
      const list = perTile.get(`${ci}:${r.part}`) as string[];
      links.push({ rule: ri, copy: ci, chip: chipEls.get(r.factor as string) as HTMLElement, tile, g, path, arrow, bar, jitter: (list.indexOf(r.factor as string) - (list.length - 1) / 2) * 12 });
      if (r.notModelled) { g.dataset.state = 'dotted'; }
    });
  });

  function drawLinks() {
    const box = stage.getBoundingClientRect();
    if (box.width < 40) return;
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    for (const l of links) {
      if (l.g.dataset.state === 'hidden') continue;
      const c = l.chip.getBoundingClientRect(); const t = l.tile.getBoundingClientRect();
      const above = t.top + t.height / 2 < c.top;
      const x1 = c.left + c.width / 2 - box.left; const y1 = (above ? c.top : c.bottom) - box.top;
      const x2 = t.left + t.width / 2 - box.left + l.jitter; const y2 = (above ? t.bottom : t.top) - box.top;
      const ym = (y1 + y2) / 2;
      l.path.setAttribute('d', `M${x1} ${y1} C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`);
      const rule = spec.rules[l.rule];
      const dir = above ? -1 : 1;
      const blocks = rule.effect === 'blocks' && !rule.notModelled;
      l.arrow.style.display = rule.notModelled || blocks ? 'none' : '';
      l.bar.style.display = blocks ? '' : 'none';
      if (blocks) l.bar.setAttribute('d', `M${x2 - 9} ${y2} L${x2 + 9} ${y2}`);
      else l.arrow.setAttribute('points', `${x2},${y2} ${x2 - 6.5},${y2 - 11 * dir} ${x2 + 6.5},${y2 - 11 * dir}`);
    }
  }
  const observer = new ResizeObserver(() => drawLinks());
  observer.observe(stage);
  stops.push(() => observer.disconnect());

  // ── Captions ─────────────────────────────────────────────────────────────────
  const caption = h('p', { class: 'ho-brk__caption', role: 'status', 'data-role': 'caption', 'data-kind': 'idle' });
  const setCaption = (kind: 'idle' | 'run', ...lines: Array<Node | string>) => {
    caption.dataset.kind = kind;
    caption.replaceChildren(...lines.map((l) => (typeof l === 'string' ? h('span', null, l) : l)));
  };
  const idleText = () => `${spec.story ? `${spec.story} ` : ''}Touch a part or a factor to read a note${asked.length > 1 ? ', or a condition to see what is in the cell' : ''}.`;
  const asked = task.asked;
  setCaption('idle', idleText());
  wrap.append(caption);
  if (spec.note) wrap.append(h('p', { class: 'ho-brk__story', 'data-role': 'assumption' }, spec.note));

  const gapRow = h('div', { class: 'ho-brk__gaps', 'data-role': 'gaps' });
  spec.rules.forEach((r, ri) => {
    if (!r.notModelled) return;
    gapRow.append(button(`Not modelled: ${spec.factors.find((f) => f.id === r.factor)?.label} and ${spec.parts.find((p) => p.id === r.part)?.label}`, 'ghost', () => inspectGap(ri), { small: true, 'data-gap': String(ri) }));
  });

  // ── The conditions, and the guesses ──────────────────────────────────────────
  const answers: Record<string, number> = {};
  let complement: boolean | null = null;
  const condRows: HTMLElement[] = [];
  const condSegs: HTMLButtonElement[][] = [];
  const results: HTMLElement[] = [];
  const controls = h('div', { class: 'ho-brk__ask', 'data-role': 'controls' });
  const run = button('Run', 'primary', () => commit(), { 'data-action': 'run', disabled: true });
  const ready = () => asked.every((c) => typeof answers[c.id] === 'number') && (copiesN === 1 || complement !== null);
  const refresh = () => { run.disabled = !ready(); };

  asked.forEach((c, k) => {
    const seg = h('div', { class: 'ho-brk__seg', role: 'group', 'aria-label': `${spec.readout.name} in ${c.label}`, 'data-count': String(levels.length) });
    const opts: HTMLButtonElement[] = [];
    levels.forEach((name, n) => {
      const o = h('button', {
        type: 'button', class: 'ho-brk__opt', 'data-cond': c.id, 'data-level': String(n), 'aria-pressed': 'false',
        onclick: () => {
          if (phase !== 'ask') return;
          answers[c.id] = n;
          opts.forEach((b) => b.setAttribute('aria-pressed', String(b === o)));
          showAsk(k);
          refresh();
        },
      }, name);
      opts.push(o); seg.append(o);
    });
    const res = h('div', { class: 'ho-brk__res', hidden: true });
    const name = h('button', { type: 'button', class: 'ho-brk__condname', 'data-cond-pick': c.id, onclick: () => { if (phase === 'ask') showAsk(k); else if (phase === 'after') showCond(k, false); } }, c.label);
    const row = h('div', { class: 'ho-brk__cond', 'data-cond-row': c.id, 'data-selected': String(k === 0) }, name, seg, res);
    condRows.push(row); condSegs.push(opts); results.push(res);
    controls.append(row);
  });
  const compSeg: HTMLButtonElement[] = [];
  let compRes: HTMLElement | null = null;
  if (copiesN > 1) {
    const seg = h('div', { class: 'ho-brk__seg ho-brk__seg--two', role: 'group', 'aria-label': 'Do the two copies complement each other', 'data-count': '2' });
    [[true, 'They complement'], [false, 'They do not complement']].forEach(([val, text]) => {
      const o = h('button', {
        type: 'button', class: 'ho-brk__opt', 'data-complement': String(val), 'aria-pressed': 'false',
        onclick: () => {
          if (phase !== 'ask') return;
          complement = val as boolean;
          compSeg.forEach((b) => b.setAttribute('aria-pressed', String(b === o)));
          refresh();
        },
      }, text as string);
      compSeg.push(o); seg.append(o);
    });
    compRes = h('div', { class: 'ho-brk__res', hidden: true });
    controls.append(h('div', { class: 'ho-brk__cond ho-brk__cond--complement', 'data-role': 'complement-row' },
      h('span', { class: 'ho-brk__condname ho-brk__condname--static' }, 'Does the cell read as normal in every condition?'), seg, compRes));
  }
  const goRow = h('div', { class: 'ho-brk__go' }, run, h('span', { class: 'ho-brk__story' }, 'Nothing arrives until you press Run.'));
  controls.append(goRow);
  wrap.append(controls);
  const skip = button('Skip to the end', 'ghost', () => skipRun?.(), { small: true, 'data-action': 'skip', hidden: true });
  const again = button('Watch it again', 'ghost', () => replay(), { small: true, 'data-action': 'replay', hidden: true });
  skip.classList.add('ho-brk__again'); again.classList.add('ho-brk__again');
  wrap.append(skip, again);
  if (gapRow.childElementCount) wrap.append(gapRow);

  // ── What the chips say ───────────────────────────────────────────────────────
  const factorName = (id: string) => spec.factors.find((f) => f.id === id)?.label ?? id;
  const shortOf = (id: string) => { const f = spec.factors.find((x) => x.id === id); return f?.short ?? f?.label ?? id; };
  /** Before the run only what is given is shown: what the condition adds, and what is always there. */
  function paintChipsAsk(k: number) {
    const c = asked[k];
    for (const f of spec.factors) {
      const el = chipEls.get(f.id) as HTMLElement;
      let word = ''; let state = 'idle';
      if (f.always) word = 'always there';
      else if (f.madeBy) word = `made from the ${soft(spec.parts.find((p) => p.id === f.madeBy)?.label ?? '')}`;
      else { const on = (c.has ?? []).includes(f.id); word = on ? 'present' : 'not present'; state = on ? 'given' : 'idle'; }
      el.dataset.state = state;
      (el.querySelector('.ho-brk__chipstate') as HTMLElement).textContent = word;
    }
  }
  function paintChips(ev: CellEval) {
    for (const f of spec.factors) {
      const st = ev.factors.get(f.id) as FactorState;
      const el = chipEls.get(f.id) as HTMLElement;
      el.dataset.state = st.state;
      (el.querySelector('.ho-brk__chipstate') as HTMLElement).textContent = st.state === 'active' ? 'active' : st.state === 'off' ? 'switched off' : 'absent';
      el.title = st.reason ? upper(st.reason) : '';
    }
  }
  function selectRow(k: number) {
    shown = k;
    condRows.forEach((r, i) => { r.dataset.selected = String(i === k); });
  }
  function showAsk(k: number) {
    selectRow(k);
    paintChipsAsk(k);
    for (const l of links) if (l.g.dataset.state !== 'dotted') l.g.dataset.state = rung === 0 ? 'idle' : 'hidden';
    outs.forEach((o) => setOut(o, -1));
    clearTags();
    drawLinks();
    if (phase === 'ask') setCaption('idle', idleText());
  }

  const clearTags = () => tiles.flat().forEach((t) => { (t.querySelector('.ho-brk__tags') as HTMLElement).replaceChildren(); t.dataset.bound = 'none'; });
  function setOut(o: (typeof outs)[number], level: number) {
    o.box.dataset.level = String(level);
    o.bars.forEach((b, i) => { b.dataset.on = String(level > i); });
    o.text.textContent = level < 0 ? '' : levelName(spec, level);
  }

  // ── Touching things ──────────────────────────────────────────────────────────
  function inspectFactor(id: string) {
    const f = spec.factors.find((x) => x.id === id) as BreakSpec['factors'][number];
    const bits: Array<Node | string> = [h('p', null, h('strong', null, f.label), f.madeBy ? ` is made from the ${soft(spec.parts.find((p) => p.id === f.madeBy)?.label ?? '')}.` : f.always ? ' is always there.' : ' is given in the condition.')];
    if (f.note) bits.push(h('p', { 'data-role': 'note' }, f.note));
    if (rung === 0 || phase !== 'ask') {
      for (const r of spec.rules) if (r.factor === id && !r.notModelled && r.say) bits.push(h('p', null, r.say));
    }
    setCaption('run', ...bits);
  }
  function inspectPart(ci: number, id: string) {
    const p = spec.parts.find((x) => x.id === id) as BreakSpec['parts'][number];
    const st = task.copies[ci].parts[id];
    const bits: Array<Node | string> = [h('p', null, h('strong', null, p.label), st.kind === 'ok' ? (st.moved ? ' has been moved.' : ' is as normal.') : ` is ${STATE_WORD[st.kind]}.`)];
    if (p.note) bits.push(h('p', { 'data-role': 'note' }, p.note));
    setCaption('run', ...bits);
  }
  function inspectGap(ri: number) {
    const r = spec.rules[ri];
    links.filter((l) => l.rule === ri).forEach((l) => { l.g.dataset.selected = 'true'; });
    setCaption('run', h('p', null, h('strong', null, 'Not modelled'), ` (${factorName(r.factor as string)} and ${spec.parts.find((p) => p.id === r.part)?.label}). ${r.notModelled}`));
    drawLinks();
  }

  // ── Showing one condition ────────────────────────────────────────────────────
  const stopRun = () => { cancel.forEach((c) => c()); cancel = []; timers.splice(0).forEach((t) => clearTimeout(t)); svg.querySelectorAll('.ho-brk__travel').forEach((n) => n.remove()); };
  stops.push(stopRun);
  let skipRun: (() => void) | null = null;

  const sentenceFor = (r: BRule, ok: boolean, ci: number): string => {
    const p = spec.parts.find((x) => x.id === r.part) as BreakSpec['parts'][number];
    const f = r.factor ? factorName(r.factor) : '';
    if (ok) return r.say ?? `${startUpper(soft(f))} ${agree(f, verbOf(r))} ${the(p.label)}.`;
    const st = task.copies[ci].parts[r.part];
    const lead = copiesN > 1 ? `On copy ${ci + 1}, ${the(p.label)}` : startUpper(the(p.label));
    return st.kind === 'ok' ? `${lead} is in the wrong place, so ${soft(f)} cannot ${verbOf(r)} it.` : `${lead} is ${STATE_WORD[st.kind]}, so ${soft(f)} cannot ${verbOf(r)} it.`;
  };

  /** Show condition k. When `play`, the factors travel and the readout comes up; otherwise the end state at once. */
  function showCond(k: number, play: boolean, onEnd?: () => void) {
    stopRun();
    selectRow(k);
    clearTags();
    const c = asked[k];
    const ev = evalCell(spec, c, task.copies, task.removed);
    paintChips(ev);
    outs.forEach((o) => setOut(o, -1));
    const live: Array<{ l: Link; ok: boolean }> = [];
    for (const l of links) {
      const r = spec.rules[l.rule];
      if (r.notModelled) { l.g.dataset.state = 'dotted'; continue; }
      const fs = ev.factors.get(r.factor as string) as FactorState;
      if (fs.state !== 'active') { l.g.dataset.state = 'hidden'; continue; }
      const st = ev.copies[l.copy].rules[l.rule];
      live.push({ l, ok: st.partWorks && st.orderKept });
      l.g.dataset.state = play ? 'lit' : (st.partWorks && st.orderKept ? 'done' : 'fail');
    }
    drawLinks();

    const lines: Array<Node | string> = [h('span', { class: 'ho-brk__count' }, c.label)];
    for (const f of spec.factors) {
      const st = ev.factors.get(f.id) as FactorState;
      if (st.state !== 'active' && spec.rules.some((r) => r.factor === f.id && !r.notModelled)) lines.push(h('p', null, h('strong', null, startUpper(f.label)), ` is ${st.state === 'absent' ? 'absent' : 'switched off'}: ${st.reason}.`));
    }
    const said = new Set<string>();
    for (const { l, ok } of live) {
      const r = spec.rules[l.rule];
      const text = sentenceFor(r, ok, l.copy);
      if (said.has(text)) continue;
      said.add(text);
      lines.push(h('p', null, text));
      if (ok && r.claim) lines.push(h('span', { class: 'ho-brk__claim' }, `From the lecture, point ${r.claim}.`));
    }

    const land = () => {
      svg.querySelectorAll('.ho-brk__travel').forEach((n) => n.remove());
      for (const { l, ok } of live) {
        l.g.dataset.state = ok ? 'done' : 'fail';
        const tags = l.tile.querySelector('.ho-brk__tags') as HTMLElement;
        const f = spec.rules[l.rule].factor as string;
        if (!tags.querySelector(`[data-tag="${f}"]`)) tags.append(h('span', { class: 'ho-brk__tag', 'data-tag': f, 'data-fit': ok ? 'yes' : 'no', 'aria-label': `${shortOf(f)} ${ok ? 'takes hold' : 'cannot take hold'}` }, `${shortOf(f)}${ok ? '' : ' ✕'}`));
        else if (!ok) (tags.querySelector(`[data-tag="${f}"]`) as HTMLElement).dataset.fit = 'no';
      }
      ev.copies.forEach((cp, ci) => setOut(outs[ci], cp.level));
      setCaption('run', ...lines);
      showResult(k);
      drawLinks();
      onEnd?.();
    };
    if (!play) { land(); return; }
    setCaption('run', h('span', { class: 'ho-brk__count' }, c.label), h('p', null, 'The factors arrive…'));
    live.forEach(({ l }) => {
      const dot = svgEl('circle', { class: 'ho-brk__travel', r: 5.5 }, svg);
      const len = l.path.getTotalLength();
      const at = (t: number) => { const p = l.path.getPointAtLength(len * t); dot.setAttribute('cx', String(p.x)); dot.setAttribute('cy', String(p.y)); };
      at(0);
      cancel.push(tween(TRAVEL_MS, at));
    });
    if (!live.length || reducedMotion()) land(); else timers.push(window.setTimeout(land, TRAVEL_MS + 30));
  }

  /** Beside each condition's guess, what the cell reads, and what it would read with nothing changed. */
  function showResult(k: number) {
    if (phase === 'ask' || !attempt) return;
    const c = asked[k];
    const truth = task.truth[k];
    const guess = attempt.levels[c.id];
    const right = guess === truth;
    condSegs[k].forEach((b, n) => {
      b.disabled = true;
      b.dataset.state = n === truth ? (right ? 'right' : 'truth') : n === guess ? 'wrong' : '';
    });
    const res = results[k];
    res.hidden = false;
    res.replaceChildren(
      h('span', { class: 'ho-brk__tagline', 'data-state': right ? 'met' : 'miss' }, `${right ? '✓' : '✗'} you: ${levelName(spec, guess)}`),
      h('span', null, right ? 'Right.' : `It reads ${levelName(spec, truth)}.`),
      h('span', { class: 'ho-brk__normal' }, `Normal: ${levelName(spec, task.normal[k])}`),
    );
  }
  function showComplement() {
    if (!compRes || attempt?.complement === undefined) return;
    const right = attempt.complement === task.complement;
    compSeg.forEach((b) => {
      b.disabled = true;
      const val = b.dataset.complement === 'true';
      b.dataset.state = val === task.complement ? (right ? 'right' : 'truth') : val === attempt?.complement ? 'wrong' : '';
    });
    compRes.hidden = false;
    compRes.replaceChildren(
      h('span', { class: 'ho-brk__tagline', 'data-state': right ? 'met' : 'miss' }, `${right ? '✓' : '✗'} you: ${attempt.complement ? 'complement' : 'do not complement'}`),
      h('span', null, right ? 'Right.' : `They ${task.complement ? 'do complement' : 'do not complement'}.`),
    );
  }

  function playAll(onEnd: () => void) {
    stopRun();
    let k = 0;
    const next = () => {
      if (k >= asked.length) { skipRun = null; skip.hidden = true; onEnd(); return; }
      const at = k++;
      showCond(at, true, () => timers.push(window.setTimeout(next, reducedMotion() ? 0 : HOLD_MS)));
    };
    skipRun = () => {
      stopRun();
      for (let i = 0; i < asked.length; i++) showCond(i, false);
      skipRun = null; skip.hidden = true;
      onEnd();
    };
    skip.hidden = reducedMotion() || asked.length < 2;
    next();
  }
  function replay() {
    if (phase === 'run') return;
    again.hidden = true;
    phase = 'run';
    playAll(() => { phase = 'after'; again.hidden = false; });
  }

  function commit() {
    if (phase !== 'ask' || !ready()) return;
    phase = 'run';
    attempt = copiesN > 1 ? { levels: { ...answers }, complement: complement as boolean } : { levels: { ...answers } };
    wrap.dataset.phase = 'run';
    controls.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { if (b.dataset.condPick === undefined) b.disabled = true; });
    goRow.hidden = true;
    for (const l of links) if (l.g.dataset.state === 'idle') l.g.dataset.state = 'hidden';
    playAll(() => {
      phase = 'after';
      wrap.dataset.phase = 'after';
      showComplement();
      again.hidden = false;
      timers.push(window.setTimeout(() => done(attempt as BreakAttempt), reducedMotion() ? 0 : 450));
    });
  }

  showAsk(0);
  requestAnimationFrame(() => drawLinks());

  return () => {
    stopRun();
    for (const t of timers) clearTimeout(t);
    for (const s of stops.reverse()) s();
    wrap.remove();
  };
}

export const construct: Engine<BreakSpec, BreakTask, BreakAttempt> = {
  id: 'construct',
  label: 'Break the Construct',
  rungNames: ['One change, one condition', 'Several conditions', 'Two copies: do they complement?'],
  issues,
  prepare,
  view,
  result,
};

export type { BCondition };
