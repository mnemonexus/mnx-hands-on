/** Hands On: touch the thing, then see what it does (practice-v1). Engines live in src/engines; this file only opens an activity. */
import { getExperienceHost } from '@mnemonexus/addon-sdk';
import { installUi } from '@mnemonexus/addon-ui';
import './style.css';
import { loadCatalogue } from './data';
import { engines } from './engines/registry';
import { openHome } from './home';
import { runActivity, showProblem } from './run';
import { makeStore } from './store';
import type { CatalogueEntry } from './types';

const host = getExperienceHost();
installUi();
const store = makeStore(host);

/** The level fixed in settings, or null when it follows the learner. */
const fixedRung = (): number | null => {
  const level = ((host.props.settings ?? {}) as Record<string, unknown>).level;
  return level === '0' || level === '1' || level === '2' ? Number(level) : null;
};

async function run() {
  const entries = await loadCatalogue(host);
  const open = async (entry: CatalogueEntry, onBack?: () => void, reason?: string) => {
    const engine = engines[entry.launch.engine];
    if (!engine) { showProblem(host.root, host, `This activity needs the "${entry.launch.engine}" engine, which this version does not have.`); return; }
    await runActivity(host.root, entry, engine, { host, store, fixedRung, onBack, reason });
  };
  const practice = host.props.practice;
  if (practice) {
    const entry = entries.find((e) => e.id === practice.activityId);
    if (!entry) { showProblem(host.root, host, 'This activity is not in the pack. The pack may need reinstalling.'); return; }
    // The host already shows why this was offered, above the add-on, so the reason is not repeated here.
    await open(entry);
    return;
  }
  const home = (): Promise<void> => openHome(host.root, {
    store, entries,
    onOpen: (entry) => { open(entry, () => { void home(); }).catch((error) => showProblem(host.root, host, String((error as Error)?.message ?? error))); },
  });
  await home();
}

run().catch((error) => showProblem(host.root, host, String((error as Error)?.message ?? error)));
