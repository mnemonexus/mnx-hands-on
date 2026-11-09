/** The list: opened by the learner from the Experiences page. When the host chooses an activity it goes straight to it. */
import { empty, h } from './dom';
import { RUNGS, RUNG_NAMES } from './engine';
import { engines } from './engines/registry';
import { FILTER_KEY, doneKey, parseDone, parseRung, rungKey, type Store } from './store';
import type { CatalogueEntry, DoneRecord } from './types';

export interface HomeDeps { store: Store; entries: CatalogueEntry[]; onOpen: (entry: CatalogueEntry) => void }
interface Filters { engine: string; undone: boolean; search: string }

const LEVEL = { 1: 'Introductory', 2: 'Intermediate', 3: 'Advanced' } as const;

export async function openHome(root: HTMLElement, deps: HomeDeps): Promise<void> {
  const { store, entries } = deps;
  empty(root);
  const keys = new Set(await store.keys());
  const done = new Map<string, DoneRecord>();
  const rungs = new Map<string, number>();
  await Promise.all(entries.map(async (e) => {
    if (keys.has(doneKey(e.id))) { const d = parseDone(await store.get(doneKey(e.id))); if (d) done.set(e.id, d); }
    const family = e.family ?? e.id;
    if (keys.has(rungKey(family))) rungs.set(e.id, parseRung(await store.get(rungKey(family)), RUNGS));
  }));
  let filters: Filters = { engine: 'all', undone: false, search: '' };
  try {
    const saved = JSON.parse((await store.get(FILTER_KEY)) ?? 'null') as Partial<Filters> | null;
    if (saved) filters = { ...filters, engine: typeof saved.engine === 'string' ? saved.engine : 'all', undone: saved.undone === true };
  } catch { /* a convenience only */ }

  const engineIds = [...new Set(entries.map((e) => e.launch.engine))];
  if (filters.engine !== 'all' && !engineIds.includes(filters.engine)) filters.engine = 'all';
  const labelOf = (id: string) => engines[id]?.label ?? id;

  const shell = h('div', { class: 'ho-root ho-home', 'data-view': 'home' });
  root.append(shell);
  const list = h('ul', { class: 'ho-cards', 'data-role': 'list' });
  const count = h('p', { class: 'ho-muted', role: 'status', 'data-role': 'count' });
  const controls = h('div', { class: 'ho-controls-row' });
  const persist = () => { void store.set(FILTER_KEY, JSON.stringify({ engine: filters.engine, undone: filters.undone })); };

  const render = (rebuildControls = false) => {
    if (rebuildControls) {
      empty(controls);
      const kind = h('div', { class: 'ho-chips', role: 'group', 'aria-label': 'Engine' });
      for (const [value, text] of [['all', 'All'], ...engineIds.map((id) => [id, labelOf(id)])] as Array<[string, string]>) {
        kind.append(h('button', { type: 'button', class: 'mnx-chip', 'aria-pressed': String(filters.engine === value), 'data-filter': `engine:${value}`, onclick: () => { filters.engine = value; persist(); render(true); } }, text));
      }
      const progress = h('div', { class: 'ho-chips', role: 'group', 'aria-label': 'Progress' },
        h('button', { type: 'button', class: 'mnx-chip', 'aria-pressed': String(filters.undone), 'data-filter': 'undone', onclick: () => { filters.undone = !filters.undone; persist(); render(true); } }, 'Not done yet'));
      controls.append(kind, progress);
    }
    const q = filters.search.trim().toLowerCase();
    const shown = entries.filter((e) => {
      if (filters.engine !== 'all' && e.launch.engine !== filters.engine) return false;
      if (filters.undone && done.has(e.id)) return false;
      if (q && !`${e.title} ${e.summary ?? ''} ${e.terms.join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
    empty(list);
    for (const e of shown) {
      const record = done.get(e.id);
      const rung = rungs.get(e.id);
      list.append(h('li', null, h('button', { type: 'button', class: 'ho-card', 'data-activity': e.id, 'data-engine': e.launch.engine, onclick: () => deps.onOpen(e) },
        h('span', { class: 'ho-card__top' },
          h('span', { class: 'ho-eyebrow' }, labelOf(e.launch.engine)),
          record ? h('span', { class: 'mnx-badge mnx-badge--success' }, `Done: ${record.met} of ${record.total}`) : null),
        h('span', { class: 'ho-card__title' }, e.title),
        e.summary ? h('span', { class: 'ho-card__summary' }, e.summary) : null,
        h('span', { class: 'ho-card__meta' }, `About ${e.minutes} min · ${LEVEL[e.level]}${rung !== undefined ? ` · next: ${(engines[e.launch.engine]?.rungNames ?? RUNG_NAMES)[rung].toLowerCase()}` : ''}`))));
    }
    count.textContent = shown.length === entries.length ? `${entries.length} activities.` : `${shown.length} of ${entries.length} activities.`;
    if (!shown.length) list.append(h('li', { class: 'mnx-empty' }, h('p', { class: 'mnx-empty__title' }, 'Nothing matches'), h('p', { class: 'mnx-empty__text' }, 'Clear a filter or the search to see more.')));
  };

  const search = h('input', { type: 'search', class: 'mnx-input', placeholder: 'Search titles and topics', 'aria-label': 'Search', 'data-role': 'search' }) as HTMLInputElement;
  search.addEventListener('input', () => { filters.search = search.value; render(); });

  shell.append(h('main', { class: 'ho-main' },
    h('header', { class: 'ho-homehead' },
      h('h1', { class: 'mnx-title' }, 'Hands On'),
      h('p', { class: 'mnx-text' }, 'Learn by touching the thing. Guess where it goes, then watch it move and turn the dials yourself.'),
      h('p', { class: 'ho-muted' }, 'Private study pack: it contains university course material and is not for sharing.')),
    search, controls, count, list));
  render(true);
}
