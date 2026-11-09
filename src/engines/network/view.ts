/**
 * Knock It Out, the view: draws one round and hands the attempt back.
 *
 *   ask     the picture is shown as it is. The student commits by choosing what happens to each marked part (or which
 *           change gives the result seen), then presses Run. Nothing travels until they do.
 *   run     the change travels along the arrows one hop at a time, each node changing, each hop with its reason.
 *   after   the guess stays beside the truth. The attempt is handed back as the last hop lands.
 */
import './network.css';
import { reducedMotion, type Engine } from '../../engine';
import { button, h } from '../../dom';
import { tween } from '../../motion';
import { svgEl } from '../../plot';
import {
  answerWords, becauseOf, dirWord, issues, levelName, lowerFirst, prepare, result, upperFirst,
  type Dir, type Hop, type Level, type NetAttempt, type NetEdge, type NetSpec, type NetTask,
} from './logic';

const DIRS: Array<[Dir, string, string]> = [['down', '▼', 'Falls'], ['same', '=', 'Stays about the same'], ['up', '▲', 'Rises']];
const GLYPH: Record<Dir, string> = { down: '▼', same: '=', up: '▲' };
const KIND_WORD = { remove: 'removed', block: 'blocked', more: 'added to' } as const;
const HOP_MS = 1150;
const TRAVEL_MS = 650;

interface Geo { w: number; h: number; sx: number; sy: number; ex: number; ey: number; cx: number | null; cy: number | null; hx: number; hy: number }

function view(root: HTMLElement, task: NetTask, done: (attempt: NetAttempt) => void): () => void {
  const { spec, net, rung } = task;
  const stops: Array<() => void> = [];
  const timers: number[] = [];
  let phase: 'ask' | 'run' | 'after' = 'ask';
  let attempt: NetAttempt | null = null;
  let revealed = false;
  let live = task.before.slice() as Level[];
  const N = spec.nodes.length;

  const wrap = h('div', { class: 'ho-net', 'data-engine': 'network', 'data-rung': String(rung), 'data-mode': task.mode, 'data-phase': 'ask' });
  root.append(wrap);
  wrap.append(
    h('p', { class: 'ho-net__announce', 'data-role': 'announce' }, task.announce),
    h('p', { class: 'ho-net__question', 'data-role': 'question' }, task.question),
  );

  // ── The picture ────────────────────────────────────────────────────────────
  const card = h('div', { class: 'ho-net__card' });
  const stage = h('div', { class: 'ho-net__stage', 'data-role': 'stage' });
  const svg = svgEl('svg', { class: 'ho-net__edges', 'aria-hidden': 'true' });
  stage.append(svg as unknown as Node);
  card.append(stage);
  wrap.append(card);

  const changedNodes = new Set(task.changes.map((c) => net.index.get(c.node) as number));
  const outputIdx = task.outputs.map((o) => net.index.get(o) as number);
  const nodeEls: HTMLButtonElement[] = [];
  const levelEls: HTMLElement[] = [];
  const chipEls: HTMLElement[] = [];
  spec.nodes.forEach((n, i) => {
    const level = h('span', { class: 'ho-net__level' }, levelName(live[i]));
    const chips = h('span', { class: 'ho-net__chips' });
    const el = h('button', {
      type: 'button', class: 'ho-net__node', 'data-node': n.id, 'data-level': String(live[i]), 'data-changed': 'false',
      'data-output': String(outputIdx.includes(i) && task.mode === 'predict'),
      style: `left:${n.x}%;top:${n.y}%`,
      'aria-label': `${n.label}, ${levelName(live[i])}${outputIdx.includes(i) ? ', marked' : ''}${n.note ? ', has a note' : ''}`,
    }, h('span', { class: 'ho-net__name' }, n.label), h('span', { class: 'ho-net__meter', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), level, chips, n.note ? h('span', { class: 'ho-net__note', 'aria-hidden': 'true' }, 'i') : null);
    el.addEventListener('click', () => inspectNode(i));
    nodeEls.push(el); levelEls.push(level); chipEls.push(chips);
    stage.append(el);
  });
  // The marked parts carry a question mark until they are answered by the run.
  const paintAsking = () => {
    chipEls.forEach((c) => c.replaceChildren());
    if (task.mode === 'predict') outputIdx.forEach((i) => chipEls[i].append(h('span', { class: 'ho-net__badge ho-net__badge--ask' }, '?')));
  };
  paintAsking();

  const caption = h('p', { class: 'ho-net__caption', role: 'status', 'data-role': 'caption', 'data-kind': 'idle' });
  const setCaption = (kind: 'idle' | 'hop', ...lines: Array<Node | string>) => {
    caption.dataset.kind = kind;
    caption.replaceChildren(...lines.map((l) => (typeof l === 'string' ? h('span', null, l) : l)));
  };
  const idleText = () => spec.story ? `${spec.story} Touch a node or a dotted arrow to read a note.` : 'Touch a node or a dotted arrow to read a note.';
  setCaption('idle', idleText());
  wrap.append(caption);
  if (spec.note) wrap.append(h('p', { class: 'ho-net__story', 'data-role': 'assumption' }, spec.note));
  // The dotted arrows can be read from the keyboard too.
  const gapRow = h('div', { class: 'ho-net__gaps', 'data-role': 'gaps' });
  spec.edges.forEach((e, i) => {
    if (e.notModelled) gapRow.append(button(`Not modelled: ${spec.nodes[net.index.get(e.from) as number].label} to ${spec.nodes[net.index.get(e.to) as number].label}`, 'ghost', () => inspectEdge(i), { small: true, 'data-gap': String(i) }));
  });
  if (gapRow.childElementCount) wrap.append(gapRow);

  // ── Arrows ─────────────────────────────────────────────────────────────────
  const paths: SVGPathElement[] = [];
  const edgeEls: SVGGElement[] = [];
  const chipsAt: SVGGElement[] = [];
  const headEls: Array<{ arrow: SVGPolygonElement; bar: SVGPathElement }> = [];
  const reciprocal = (e: NetEdge) => spec.edges.some((o) => o !== e && o.from === e.to && o.to === e.from);
  spec.edges.forEach((e, i) => {
    const g = svgEl('g', { class: 'ho-net__edge', 'data-edge': String(i), 'data-state': 'idle', 'data-model': e.notModelled ? 'no' : 'yes', 'data-selected': 'false' }, svg);
    const path = svgEl('path', { class: 'ho-net__line' }, g);
    const hit = svgEl('path', { class: 'ho-net__hit', fill: 'none', stroke: 'transparent', 'stroke-width': 18 }, g);
    const arrow = svgEl('polygon', { class: 'ho-net__head ho-net__head--arrow' }, g);
    const bar = svgEl('path', { class: 'ho-net__head ho-net__head--bar' }, g);
    const chip = svgEl('g', { class: e.notModelled ? 'ho-net__chip ho-net__chip--no' : 'ho-net__chip' }, g);
    svgEl('circle', { r: 10 }, chip);
    svgEl('text', {}, chip).textContent = e.notModelled ? '?' : '';
    if (e.notModelled) chip.setAttribute('role', 'button');
    hit.addEventListener('click', () => inspectEdge(i));
    chip.addEventListener('click', () => inspectEdge(i));
    paths.push(path); edgeEls.push(g); chipsAt.push(chip); headEls.push({ arrow, bar });
  });

  /** Where an arrow runs, in pixels, trimmed so it begins and ends at the edge of the nodes. */
  function geometry(e: NetEdge, W: number, H: number): Geo {
    const a = spec.nodes[net.index.get(e.from) as number]; const b = spec.nodes[net.index.get(e.to) as number];
    const ai = net.index.get(e.from) as number; const bi = net.index.get(e.to) as number;
    const ax = (a.x / 100) * W; const ay = (a.y / 100) * H; const bx = (b.x / 100) * W; const by = (b.y / 100) * H;
    let cx: number | null = null; let cy: number | null = null;
    if (reciprocal(e)) {
      const mx = (ax + bx) / 2; const my = (ay + by) / 2; const dx = bx - ax; const dy = by - ay; const len = Math.hypot(dx, dy) || 1;
      cx = mx + (-dy / len) * 26; cy = my + (dx / len) * 26;
    }
    const trim = (px: number, py: number, qx: number, qy: number, el: HTMLElement) => {
      const dx = qx - px; const dy = qy - py;
      const hw = el.offsetWidth / 2 + 5; const hh = el.offsetHeight / 2 + 5;
      const t = Math.min(hw / (Math.abs(dx) || 1e-6), hh / (Math.abs(dy) || 1e-6), 0.45);
      return [px + dx * t, py + dy * t] as const;
    };
    const t1 = trim(ax, ay, cx ?? bx, cy ?? by, nodeEls[ai]);
    const t2 = trim(bx, by, cx ?? ax, cy ?? ay, nodeEls[bi]);
    // The head sits at the end; its direction is from the control point (or the start) to the end.
    return { w: W, h: H, sx: t1[0], sy: t1[1], ex: t2[0], ey: t2[1], cx, cy, hx: (cx ?? t1[0]), hy: (cy ?? t1[1]) };
  }

  const showsKind = (i: number) => task.showSigns || revealed || edgeEls[i].dataset.state !== 'idle';
  function drawEdges() {
    const W = stage.clientWidth; const H = stage.clientHeight;
    if (W < 40) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    spec.edges.forEach((e, i) => {
      const g = geometry(e, W, H);
      paths[i].setAttribute('d', g.cx === null ? `M${g.sx} ${g.sy} L${g.ex} ${g.ey}` : `M${g.sx} ${g.sy} Q${g.cx} ${g.cy} ${g.ex} ${g.ey}`);
      edgeEls[i].querySelector('.ho-net__hit')?.setAttribute('d', paths[i].getAttribute('d') as string);
      // The head: a triangle for an arrow that activates, a bar for one that blocks, a plain triangle while signs are hidden.
      const dx = g.ex - g.hx; const dy = g.ey - g.hy; const len = Math.hypot(dx, dy) || 1; const ux = dx / len; const uy = dy / len;
      const nx = -uy; const ny = ux;
      const blocks = e.sign === '-' && !e.notModelled && showsKind(i);
      const arrow = headEls[i].arrow; const bar = headEls[i].bar;
      arrow.style.display = e.notModelled || blocks ? 'none' : '';
      bar.style.display = blocks ? '' : 'none';
      if (blocks) bar.setAttribute('d', `M${g.ex + nx * 8} ${g.ey + ny * 8} L${g.ex - nx * 8} ${g.ey - ny * 8}`);
      else arrow.setAttribute('points', `${g.ex},${g.ey} ${g.ex - ux * 11 + nx * 6.5},${g.ey - uy * 11 + ny * 6.5} ${g.ex - ux * 11 - nx * 6.5},${g.ey - uy * 11 - ny * 6.5}`);
      // The sign chip sits half way along.
      const total = paths[i].getTotalLength();
      const mid = paths[i].getPointAtLength(total / 2);
      chipsAt[i].setAttribute('transform', `translate(${mid.x} ${mid.y})`);
      const text = chipsAt[i].querySelector('text') as SVGTextElement;
      if (total < 40 && !e.notModelled) chipsAt[i].style.display = 'none';
      else if (e.notModelled) { chipsAt[i].style.display = ''; text.textContent = '?'; }
      else if (showsKind(i)) { chipsAt[i].style.display = ''; text.textContent = e.sign === '-' ? '−' : '+'; }
      else chipsAt[i].style.display = 'none';
    });
  }

  function layout() {
    const w = stage.clientWidth;
    if (w < 40) return;
    stage.style.height = `${Math.round(Math.max(330, Math.min(470, w * 0.58)))}px`;
    drawEdges();
  }
  const observer = new ResizeObserver(() => layout());
  observer.observe(stage);
  stops.push(() => observer.disconnect());
  layout();

  // ── Touching a node or an arrow ────────────────────────────────────────────
  function inspectNode(i: number) {
    const n = spec.nodes[i];
    const bits: Array<Node | string> = [h('p', null, h('strong', null, n.label), ` is ${levelName(live[i])}${live[i] !== task.before[i] ? ` (it was ${levelName(task.before[i])})` : ''}.`)];
    if (n.note) bits.push(h('p', { 'data-role': 'note' }, n.note));
    setCaption('hop', ...bits);
  }
  function inspectEdge(i: number) {
    const e = spec.edges[i];
    edgeEls.forEach((g, k) => { g.dataset.selected = String(k === i); });
    const from = spec.nodes[net.index.get(e.from) as number].label; const to = spec.nodes[net.index.get(e.to) as number].label;
    if (e.notModelled) {
      setCaption('hop', h('p', null, h('strong', null, 'Not modelled'), ` (${from} to ${to}). ${e.notModelled}`));
    } else if (revealed || phase !== 'ask') {
      setCaption('hop', h('p', null, h('strong', null, `${from} ${e.sign === '-' ? 'blocks' : 'activates'} ${to}.`), ` ${e.reason}`), e.claim ? h('p', { class: 'ho-net__claim' }, `From the lecture, point ${e.claim}.`) : '');
    } else {
      setCaption('idle', 'Run it, and each arrow will tell you why it carries the change.');
    }
  }

  // ── Asking ─────────────────────────────────────────────────────────────────
  const answers: Record<string, Dir> = {};
  let pick = '';
  const controls = h('div', { class: 'ho-net__ask', 'data-role': 'controls' });
  const run = button('Run', 'primary', () => commit(), { 'data-action': 'run', disabled: true });
  const ready = () => (task.mode === 'predict' ? task.outputs.every((o) => answers[o]) : !!pick);
  const refresh = () => { run.disabled = !ready(); };
  if (task.mode === 'predict') {
    task.outputs.forEach((o) => {
      const group = h('div', { class: 'ho-net__seg', role: 'group', 'aria-label': `What happens to ${spec.nodes[net.index.get(o) as number].label}` });
      DIRS.forEach(([d, glyph, word]) => {
        group.append(h('button', {
          type: 'button', class: 'ho-net__opt', 'data-output': o, 'data-dir': d, 'aria-pressed': 'false',
          onclick: () => {
            if (phase !== 'ask') return;
            answers[o] = d;
            group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-dir') === d)));
            refresh();
          },
        }, h('span', { 'aria-hidden': 'true' }, glyph), word));
      });
      controls.append(h('div', { class: 'ho-net__row', 'data-output-row': o }, h('span', { class: 'ho-net__rowlabel' }, spec.nodes[net.index.get(o) as number].label), group));
    });
  } else {
    const opts = h('div', { class: 'ho-net__opts', role: 'group', 'aria-label': 'Which change gives this' });
    for (const o of task.options) {
      opts.append(h('button', {
        type: 'button', class: 'ho-net__opt', 'data-option': o.id, 'aria-pressed': 'false',
        onclick: () => {
          if (phase !== 'ask') return;
          pick = o.id;
          opts.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-option') === o.id)));
          refresh();
        },
      }, o.label));
    }
    controls.append(opts);
  }
  controls.append(h('div', { class: 'ho-net__go' }, run, h('span', { class: 'ho-net__story' }, task.mode === 'predict' ? 'Nothing moves until you press Run.' : 'Nothing moves until you press Run.')));
  wrap.append(controls);

  const verdict = h('div', { class: 'ho-net__verdict', 'data-role': 'verdict', hidden: true });
  const log = h('ol', { class: 'ho-net__log', 'data-role': 'log', 'aria-label': 'What happened, hop by hop', hidden: true });
  const skip = button('Skip to the end', 'ghost', () => skipRun?.(), { small: true, 'data-action': 'skip', hidden: true });
  skip.classList.add('ho-net__again');
  const again = button('Watch it again', 'ghost', () => replay(), { small: true, 'data-action': 'replay', hidden: true });
  again.classList.add('ho-net__again');
  wrap.append(skip, verdict, log, again);

  // ── Running ────────────────────────────────────────────────────────────────
  function setLevel(i: number, v: Level, flash: boolean) {
    live[i] = v;
    nodeEls[i].dataset.level = String(v);
    levelEls[i].textContent = v === task.before[i] ? levelName(v) : `${levelName(task.before[i])} → ${levelName(v)}`;
    nodeEls[i].dataset.changed = String(v !== task.before[i]);
    nodeEls[i].setAttribute('aria-label', `${spec.nodes[i].label}, ${levelName(v)}${v !== task.before[i] ? ` (was ${levelName(task.before[i])})` : ''}`);
    if (flash) { nodeEls[i].dataset.flash = 'false'; void nodeEls[i].offsetWidth; nodeEls[i].dataset.flash = 'true'; }
  }

  /** What a hop says: the node, what fed it, and the arrow's own reason. */
  function hopText(step: number, hop: Hop) {
    const n = spec.nodes[hop.node];
    const dir: Dir = hop.to > hop.from ? 'up' : 'down';
    const head = `${n.label} ${dirWord(dir)}`;
    const detail = hop.via.length
      ? `Because ${becauseOf(task, step, hop)}. ${hop.via.map((e) => spec.edges[e].reason).join(' ')}`
      : `${upperFirst(task.changes.find((k) => net.index.get(k.node) === hop.node)?.label ?? 'The change')}: the change starts here.`;
    const claim = hop.via.map((e) => spec.edges[e].claim).find(Boolean);
    return { head, tail: ` (${levelName(hop.from)} to ${levelName(hop.to)}).`, detail, claim };
  }
  function hopLine(step: number, hop: Hop): HTMLElement {
    const t = hopText(step, hop);
    return h('li', { 'data-node': spec.nodes[hop.node].id }, h('b', null, t.head), t.tail, h('span', null, t.detail));
  }

  const clearRun = () => {
    live = task.before.slice() as Level[];
    task.before.forEach((v, i) => { setLevel(i, v as Level, false); });
    edgeEls.forEach((g) => { g.dataset.state = 'idle'; });
    svg.querySelectorAll('.ho-net__travel').forEach((n) => n.remove());
    log.replaceChildren();
    drawEdges();
  };

  let cancel: Array<() => void> = [];
  const stopRun = () => { cancel.forEach((c) => c()); cancel = []; timers.splice(0).forEach((t) => clearTimeout(t)); svg.querySelectorAll('.ho-net__travel').forEach((n) => n.remove()); };
  stops.push(stopRun);

  let skipRun: (() => void) | null = null;

  function playSteps(onEnd: () => void) {
    stopRun();
    clearRun();
    log.hidden = false;
    // The change itself is the first step; each later step is one hop along the arrows.
    const steps = task.steps;
    let k = 0;
    const total = steps.length;
    /** Show what a step did: the nodes, the arrows it came along, the line in the log and the caption. */
    const land = (step: (typeof steps)[number], index: number) => {
      for (const e of edgeEls) if (e.dataset.state === 'lit') e.dataset.state = 'done';
      for (const e of new Set(step.hops.flatMap((hp) => hp.via))) edgeEls[e].dataset.state = 'done';
      svg.querySelectorAll('.ho-net__travel').forEach((n) => n.remove());
      for (const hp of step.hops) setLevel(hp.node, hp.to, true);
      drawEdges();
      const items = step.hops.map((hp) => hopLine(index, hp));
      log.querySelectorAll('li[data-now]').forEach((li) => li.removeAttribute('data-now'));
      items.forEach((li) => { li.setAttribute('data-now', 'true'); log.append(li); });
      const lines: Array<Node | string> = [h('span', { class: 'ho-net__count' }, index === 0 ? 'The change' : `Hop ${index}`)];
      step.hops.forEach((hp) => {
        const t = hopText(index, hp);
        lines.push(h('p', null, h('strong', null, t.head), `. ${t.detail}`));
        if (t.claim) lines.push(h('span', { class: 'ho-net__claim' }, `From the lecture, point ${t.claim}.`));
      });
      setCaption('hop', ...lines);
    };
    const finish = () => { skipRun = null; skip.hidden = true; onEnd(); };
    const next = () => {
      if (k >= total) { finish(); return; }
      const index = k;
      const step = steps[k++];
      const lit = [...new Set(step.hops.flatMap((hp) => hp.via))];
      const arrive = () => { land(step, index); timers.push(window.setTimeout(next, reducedMotion() ? 0 : Math.max(250, HOP_MS - TRAVEL_MS))); };
      for (const e of lit) {
        edgeEls[e].dataset.state = 'lit';
        const path = paths[e];
        const dot = svgEl('circle', { class: 'ho-net__travel', r: 5.5 }, svg);
        const len = path.getTotalLength();
        const at = (t: number) => { const p = path.getPointAtLength(len * t); dot.setAttribute('cx', String(p.x)); dot.setAttribute('cy', String(p.y)); };
        at(0);
        cancel.push(tween(reducedMotion() ? 0 : TRAVEL_MS, at));
      }
      drawEdges();
      if (!lit.length || reducedMotion()) arrive(); else timers.push(window.setTimeout(arrive, TRAVEL_MS + 30));
    };
    // Skipping lands every remaining step at once.
    skipRun = () => {
      stopRun();
      while (k < total) { const index = k; land(steps[k++], index); }
      finish();
    };
    skip.hidden = reducedMotion();
    next();
  }

  function replay() {
    if (phase === 'run') return;
    again.hidden = true;
    playSteps(() => { again.hidden = false; showRevealMarks(); });
  }

  /** The guess and the truth side by side: on the nodes, and in words under the picture. */
  function showRevealMarks() {
    if (!attempt) return;
    paintAsking();
    if (task.mode === 'predict') {
      outputIdx.forEach((i, k) => {
        const o = task.outputs[k];
        const guess = (attempt as NetAttempt).answers?.[o] as Dir;
        const right = guess === task.truth[o];
        chipEls[i].replaceChildren(
          h('span', { class: 'ho-net__badge ho-net__badge--you', 'data-state': right ? 'met' : 'miss', title: 'Your answer' }, `you ${GLYPH[guess]} ${right ? '✓' : '✗'}`),
          h('span', { class: 'ho-net__badge', title: 'What happens' }, `${GLYPH[task.truth[o]]}`),
        );
      });
    }
    const changeIdx = task.changes.map((c) => net.index.get(c.node) as number);
    changeIdx.forEach((i, k) => {
      chipEls[i].append(h('span', { class: 'ho-net__badge ho-net__badge--do' }, KIND_WORD[task.changes[k].kind] ?? 'changed'));
    });
    if (task.mode === 'identify') {
      const chosen = task.spec.perturbations.find((p) => p.id === (attempt as NetAttempt).pick);
      if (chosen && chosen.id !== task.answer) {
        const i = net.index.get(chosen.node) as number;
        chipEls[i].append(h('span', { class: 'ho-net__badge ho-net__badge--you', 'data-state': 'miss', title: 'Your answer' }, 'you chose ✗'));
      }
    }
  }

  function buildVerdict(a: NetAttempt) {
    const verdictResult = result(task, a);
    verdict.replaceChildren();
    if (task.mode === 'predict') {
      task.outputs.forEach((o) => {
        const right = (a.answers as Record<string, Dir>)[o] === task.truth[o];
        verdict.append(h('div', { class: 'ho-net__verdict-row', 'data-state': right ? 'met' : 'miss', 'data-output-row': o },
          h('b', null, spec.nodes[net.index.get(o) as number].label),
          h('span', { class: 'ho-net__tag', 'data-state': right ? 'met' : 'miss' }, `${right ? '✓' : '✗'} you: ${answerWords(task, o, a)}`),
          h('span', null, right ? 'Right.' : `It ${dirWord(task.truth[o])}.`)));
      });
    } else {
      const right = verdictResult.met;
      const correct = task.options.find((o) => o.id === task.answer);
      verdict.append(h('div', { class: 'ho-net__verdict-row', 'data-state': right ? 'met' : 'miss' },
        h('span', { class: 'ho-net__tag', 'data-state': right ? 'met' : 'miss' }, `${right ? '✓' : '✗'} you chose: ${answerWords(task, '', a)}`),
        h('span', null, right ? 'Right.' : `It was: ${lowerFirst(correct?.label ?? '')}.`)));
    }
    verdict.hidden = false;
  }

  function commit() {
    if (phase !== 'ask' || !ready()) return;
    phase = 'run';
    attempt = task.mode === 'predict' ? { kind: 'predict', answers: { ...answers } } : { kind: 'identify', pick };
    wrap.dataset.phase = 'run';
    controls.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = true; });
    revealed = true;
    drawEdges();
    playSteps(() => {
      phase = 'after';
      wrap.dataset.phase = 'after';
      const a = attempt as NetAttempt;
      controls.hidden = true;
      showRevealMarks();
      buildVerdict(a);
      again.hidden = false;
      timers.push(window.setTimeout(() => done(a), reducedMotion() ? 0 : 450));
    });
  }

  return () => {
    stopRun();
    for (const t of timers) clearTimeout(t);
    for (const s of stops.reverse()) s();
    wrap.remove();
  };
}

export const network: Engine<NetSpec, NetTask, NetAttempt> = {
  id: 'network',
  label: 'Knock It Out',
  rungNames: ['Arrows shown', 'Arrows hidden', 'Two changes, or a cause'],
  issues,
  prepare,
  view,
  result,
};
