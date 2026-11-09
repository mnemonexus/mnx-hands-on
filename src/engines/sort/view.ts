/**
 * Sort, the view: statements arrive one at a time and the student throws each into a bin, or into "both".
 *
 *   ask      one statement in the hand. Drag it onto a bin, or press the bin (keys 1, 2, 3 and B).
 *   settle   a right one flies in and sits in its bin; a wrong one is carried there, bounces back and says why. It must
 *            settle before the next arrives, but only the first try counts.
 *   end      the bins stay side by side, every statement in full, and a slip shows where it was first put.
 *
 * "This statement is unclear" retires it for good (kept in mnx.storage) and is reported in the run's note.
 */
import type { ExperienceHost } from '@mnemonexus/addon-sdk';
import { hashSeed, reducedMotion, type Engine } from '../../engine';
import { button, h } from '../../dom';
import './sort.css';
import {
  binName, cardId, deal, issues, prepare, replacement, result, shown,
  type Placed, type SortAttempt, type SortCard, type SortPlacement, type SortSpec, type SortTask,
} from './logic';

// ── What the student has marked unclear, kept for good ───────────────────────

const memory = new Map<string, string>();
const retiredKey = (spec: SortSpec) => `retired:sort:${hashSeed(spec.bins.map((b) => b.label).join('|')).toString(36)}`;

/** The host the page was opened by (the SDK reads the same global). Null where there is none, such as in a unit test. */
function host(): ExperienceHost | null {
  try { return ((globalThis as { mnx?: ExperienceHost }).mnx ?? null); } catch { return null; }
}
async function loadRetired(key: string): Promise<Set<string>> {
  let raw: string | null = memory.get(key) ?? null;
  const mnx = host();
  if (mnx?.props.permissions.includes('storage:local')) {
    try { raw = (await mnx.storage.get(key)) ?? raw; } catch { /* the memory copy stands */ }
  }
  try {
    const list = JSON.parse(raw ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
async function saveRetired(key: string, set: Set<string>): Promise<void> {
  const raw = JSON.stringify([...set].slice(-200));
  memory.set(key, raw);
  const mnx = host();
  if (mnx?.props.permissions.includes('storage:local')) {
    try { await mnx.storage.set(key, raw); } catch { /* a refusal never interrupts a round */ }
  }
}

// ── The round ────────────────────────────────────────────────────────────────

function view(root: HTMLElement, task: SortTask, done: (attempt: SortAttempt) => void): () => void {
  const spec = task.spec;
  const key = retiredKey(spec);
  let stopped = false;
  const stops: Array<() => void> = [];
  const timers: number[] = [];
  const later = (fn: () => void, ms: number) => { const id = window.setTimeout(() => { if (!stopped) fn(); }, reducedMotion() ? 0 : ms); timers.push(id); };

  const places: Placed[] = [...task.bins, 'both'];
  const wrap = h('div', { class: 'ho-sort', 'data-engine': 'sort', 'data-rung': String(task.rung), 'data-phase': 'ask' });
  root.append(wrap);

  const intro = h('p', { class: 'ho-announce', 'data-role': 'announce' }, spec.intro ?? 'Throw each statement into the bin it belongs to. If it is true of all of them, it goes in "Both".');
  const count = h('p', { class: 'ho-sort-count', 'data-role': 'count' });
  const cardBox = h('div', { class: 'ho-sort-hand', 'data-role': 'hand' });
  const unclear = button('This statement is unclear', 'ghost', () => retire(), { small: true, 'data-action': 'unclear' });
  const status = h('p', { class: 'ho-sort-reason', role: 'status', 'data-role': 'reason' });
  const bins = h('div', { class: 'ho-sort-bins', 'data-role': 'bins', 'data-count': String(places.length) });
  wrap.append(intro, h('div', { class: 'ho-sort-tools' }, count, unclear), cardBox, status, bins);

  const lists = new Map<string, HTMLElement>();
  const heads = new Map<string, HTMLButtonElement>();
  places.forEach((p, i) => {
    const isBoth = p === 'both';
    const head = h('button', {
      type: 'button', class: 'ho-sort-bin__head', 'data-place': String(p), 'data-action': `bin-${p}`,
      onclick: () => place(p),
    }, h('span', { class: 'ho-sort-bin__name' }, isBoth ? 'Both' : binName(spec, p)),
      h('span', { class: 'ho-sort-bin__key', 'aria-hidden': 'true' }, isBoth ? 'B' : String(i + 1)));
    head.setAttribute('aria-label', isBoth ? 'Both (key B)' : `${binName(spec, p)} (key ${i + 1})`);
    const note = !isBoth && spec.bins[p as number].note ? h('p', { class: 'ho-sort-bin__note', hidden: true }, spec.bins[p as number].note) : null;
    const list = h('ul', { class: 'ho-sort-bin__list', 'aria-label': isBoth ? 'In both' : `In ${binName(spec, p)}` });
    const col = h('section', { class: 'ho-sort-bin', 'data-place': String(p), 'data-both': String(isBoth) }, head, note, list);
    bins.append(col);
    lists.set(String(p), list);
    heads.set(String(p), head);
  });

  // ── State ──────────────────────────────────────────────────────────────────
  let retired = new Set<string>();
  let queue: SortCard[] = [];
  let total = 0;
  let current: SortCard | null = null;
  let currentEl: HTMLElement | null = null;
  let tries = 0;
  let first: Placed | null = null;
  let busy = false;
  const placements: SortPlacement[] = [];
  const retiredNow: string[] = [];
  const tried = new Set<string>();

  const mark = () => {
    const at = Math.min(placements.length + 1, total);
    count.textContent = total ? `Statement ${at} of ${total}` : '';
  };

  function finish() {
    wrap.dataset.phase = 'end';
    unclear.hidden = true;
    cardBox.hidden = true;
    for (const note of bins.querySelectorAll<HTMLElement>('.ho-sort-bin__note')) note.hidden = false;
    count.textContent = 'Side by side';
    intro.textContent = 'Here they are together. Where you first put a statement and slipped, it says so.';
    later(() => done({ placements: placements.slice(), retired: retiredNow.slice() }), 350);
  }

  function next() {
    busy = false;
    for (const hd of heads.values()) hd.removeAttribute('data-tried');
    tried.clear();
    tries = 0; first = null;
    current = queue.shift() ?? null;
    currentEl = null;
    cardBox.replaceChildren();
    if (!current) { finish(); return; }
    mark();
    const el = h('div', { class: 'ho-sort-card', 'data-role': 'card', 'data-state': 'ready', tabindex: '0', 'aria-label': current.t }, current.t);
    cardBox.append(el);
    currentEl = el;
    wireDrag(el);
    el.focus({ preventScroll: true });
  }

  // ── Placing ────────────────────────────────────────────────────────────────
  function flyTo(el: HTMLElement, target: Element, then: () => void) {
    if (reducedMotion() || typeof el.animate !== 'function') { then(); return; }
    const a = el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const own = (el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/) ?? []).slice(1).map(Number);
    const from = `translate(${own[0] ?? 0}px, ${own[1] ?? 0}px)`;
    const move = el.animate([{ transform: from, opacity: 1 }, { transform: `translate(${(own[0] ?? 0) + dx}px, ${(own[1] ?? 0) + dy}px) scale(0.45)`, opacity: 0.35 }], { duration: 230, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' });
    move.onfinish = then;
    move.oncancel = then;
  }

  function place(where: Placed) {
    if (busy || !current || !currentEl || stopped || tried.has(String(where))) return;
    const card = current;
    const el = currentEl;
    busy = true;
    tries++;
    if (first === null) first = where;
    const col = bins.querySelector(`[data-place="${String(where)}"].ho-sort-bin`) ?? bins;
    const right = where === card.bin;
    flyTo(el, heads.get(String(where)) ?? col, () => {
      if (stopped) return;
      if (right) {
        placements.push({ id: cardId(card), first: first as Placed, tries });
        const slip = first !== card.bin;
        const li = h('li', { class: 'ho-sort-mini', 'data-slip': String(slip), title: shown(card) },
          h('span', { class: 'ho-sort-mini__text' }, shown(card)),
          slip ? h('span', { class: 'ho-sort-mini__slip' }, `You first put this in ${first === 'both' ? 'both' : binName(spec, first as Placed)}.`) : null);
        lists.get(String(where))?.append(li);
        status.textContent = slip ? `Yes. ${card.why}` : '';
        status.dataset.kind = slip ? 'hint' : '';
        currentEl?.remove();
        later(next, slip ? 1600 : 120);
      } else {
        tried.add(String(where));
        heads.get(String(where))?.setAttribute('data-tried', 'true');
        status.textContent = `Not ${where === 'both' ? 'in both' : `with ${binName(spec, where)}`}. Try another.`;
        status.dataset.kind = 'wrong';
        el.getAnimations?.().forEach((a) => a.cancel());
        el.style.transform = '';
        el.dataset.state = 'wrong';
        busy = false;
        later(() => { if (el.isConnected) el.dataset.state = 'ready'; }, 900);
      }
    });
  }

  function retire() {
    if (busy || !current || stopped) return;
    const card = current;
    const id = cardId(card);
    retired.add(id);
    retiredNow.push(id);
    void saveRetired(key, retired);
    // Another of the same bin takes its place, so the round keeps its balance.
    const inPlay = [...queue, card, ...placements.map((p) => spec.cards.find((c) => cardId(c) === p.id)).filter((c): c is SortCard => !!c)];
    const spare = replacement(task, retired, inPlay, card.bin);
    if (spare) queue.push(spare);
    else total = Math.max(0, total - 1);
    status.textContent = 'Thank you. That statement is retired and will not come up again.';
    status.dataset.kind = 'hint';
    next();
    mark();
  }

  // ── Dragging ───────────────────────────────────────────────────────────────
  function wireDrag(el: HTMLElement) {
    let sx = 0, sy = 0, moved = false, id = -1;
    const targetAt = (x: number, y: number) => {
      const under = document.elementFromPoint(x, y);
      const t = under?.closest<HTMLElement>('[data-place]');
      if (!t) return null;
      const v = t.dataset.place as string;
      return v === 'both' ? 'both' as const : Number(v);
    };
    const hover = (x: number, y: number) => {
      const t = targetAt(x, y);
      for (const [k, hd] of heads) hd.toggleAttribute('data-over', t !== null && String(t) === k);
    };
    el.addEventListener('pointerdown', (ev) => {
      if (busy || ev.button > 0) return;
      id = ev.pointerId; sx = ev.clientX; sy = ev.clientY; moved = false;
      try { el.setPointerCapture(id); } catch { /* not every host allows it */ }
      el.dataset.state = 'held';
    });
    el.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      hover(ev.clientX, ev.clientY);
    });
    const release = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      id = -1;
      for (const hd of heads.values()) hd.removeAttribute('data-over');
      if (el.dataset.state === 'held') el.dataset.state = 'ready';
      if (!moved) return;
      const t = targetAt(ev.clientX, ev.clientY);
      if (t === null) { el.style.transform = ''; return; }
      place(t);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', (ev) => { if (ev.pointerId === id) { id = -1; el.style.transform = ''; el.dataset.state = 'ready'; } });
  }

  const keys = (ev: KeyboardEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || wrap.dataset.phase !== 'ask') return;
    const k = ev.key.toLowerCase();
    if (k === 'b') place('both');
    else { const i = Number(k) - 1; if (Number.isInteger(i) && i >= 0 && i < task.bins.length) place(task.bins[i]); }
  };
  document.addEventListener('keydown', keys);
  stops.push(() => document.removeEventListener('keydown', keys));

  void loadRetired(key).then((set) => {
    if (stopped) return;
    retired = set;
    queue = deal(task, retired);
    total = queue.length;
    if (!total) { done({ placements: [], retired: [] }); return; }
    next();
  });

  return () => { stopped = true; for (const s of stops) s(); for (const t of timers) clearTimeout(t); };
}

export const sort: Engine<SortSpec, SortTask, SortAttempt> = {
  id: 'sort',
  label: 'Sort',
  rungNames: ['Two bins', 'More statements', 'Three bins'],
  issues,
  prepare,
  view,
  result,
};
