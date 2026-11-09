import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport } from '../src/report';
import {
  cardId, chooseBins, deal, issues, prepare, replacement, result, shown, slack, standaloneProblem,
  type SortAttempt, type SortSpec, type SortTask,
} from '../src/engines/sort/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const history: SortSpec = readJson('test', 'fixtures', 'sort', 'roman-republic-empire.json');

const generated: Array<{ id: string; spec: SortSpec }> = readdirSync(join(ROOT, 'content', 'generated'))
  .filter((f) => f.endsWith('.json')).map((f) => readJson('content', 'generated', f)).filter((a) => a.engine === 'sort');

/** A run's rounds with one seed, as run.ts makes them. */
const run = (spec: SortSpec, rung: number, seed = 'run1') => [0, 1, 2].map((r) => prepare(spec, `${seed}:${r}`, rung));
const binOf = (spec: SortSpec, text: string) => spec.cards.find((c) => c.t === text)!.bin;
const perfect = (task: SortTask, retired: string[] = []): SortAttempt => ({
  placements: deal(task, new Set(retired)).map((c) => ({ id: cardId(c), first: c.bin, tries: 1 })), retired,
});

describe('the shipped activities are fit to use', () => {
  test('the Roman fixture has no issues', () => expect(issues(history)).toEqual([]));
  test('every generated Sort activity has no issues', () => {
    expect(generated.length).toBeGreaterThan(0);
    for (const a of generated) expect(`${a.id}: ${issues(a.spec).join(' | ')}`).toBe(`${a.id}: `);
  });
  test('no generated card names a bin, and a masked card keeps its original for the reveal', () => {
    for (const a of generated) {
      for (const c of a.spec.cards) {
        for (const b of a.spec.bins) expect(c.t).not.toMatch(new RegExp(`(^|[^A-Za-z0-9])${b.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i'));
        expect(shown(c)).toBe(c.full ?? c.t);
      }
    }
  });
  test('a masked card is checked on its original, and the original must stand alone', () => {
    const spec: SortSpec = { bins: [{ label: 'Alpha' }, { label: 'Beta' }], cards: [] };
    const card = (t: string, full: string | undefined, bin: number) => ({ t, ...(full ? { full } : {}), bin, why: 'Because.' });
    spec.cards = [
      card('This starts at the promoter and ends at the terminator.', 'An alpha starts at the promoter and ends at the terminator.', 0),
      card('This is the basic assembly of subunits that bind DNA.', 'The alpha is the basic assembly of subunits that bind DNA.', 0),
      card('This is a sequence that is read into a single copy.', 'An alpha is a sequence that is read into a single copy.', 0),
      card('Bravo helps the cell to pick out the right messenger.', undefined, 1),
      card('Bravo makes the proteins in the cell at a slow pace.', undefined, 1),
      card('Bravo adds a long tail to the finished messenger.', undefined, 1),
    ];
    expect(issues(spec)).toEqual([]);
    spec.cards[0] = card('This starts at the promoter and ends at the terminator.', 'It starts at the promoter and ends at the terminator.', 0);
    expect(issues(spec).join(' ')).toContain('starts with "it"');
  });
  test('the engine is registered by its one line', () => {
    expect(engines.sort?.label).toBe('Sort');
    expect(engines.sort?.id).toBe('sort');
  });
});

describe('what a writer is told', () => {
  const ok = (): SortSpec => JSON.parse(JSON.stringify(history));
  test('a statement that leans on the one before it is refused', () => {
    const s = ok(); s.cards[0].t = 'It was the main check on the power of the other consul.';
    expect(issues(s).join(' ')).toContain('needs the sentence before it');
  });
  test('a statement pointing at a slide is refused', () => {
    const s = ok(); s.cards[1].t = 'The magistrates in the table above held office for one year only.';
    expect(issues(s).join(' ')).toContain('outside itself');
  });
  test('a bin that does not exist, a missing reason and too few statements are refused', () => {
    const a = ok(); a.cards[0].bin = 5;
    expect(issues(a).join(' ')).toContain('does not exist');
    const b = ok(); b.cards[2].why = '';
    expect(issues(b).join(' ')).toContain('no "why"');
    const c = ok(); c.cards = c.cards.filter((x) => x.bin !== 1 || x.t.startsWith('Augustus'));
    expect(issues(c).join(' ')).toContain('needs at least 3');
  });
  test('one bin, four bins and a repeated label are refused', () => {
    const one = ok(); one.bins = [one.bins[0]];
    expect(issues(one).join(' ')).toContain('two or three');
    const dup = ok(); dup.bins[1].label = dup.bins[0].label;
    expect(issues(dup).join(' ')).toContain('both called');
  });
  test('a spec too long for the catalogue is refused', () => {
    const s = ok();
    for (let i = 0; i < 40; i++) s.cards.push({ t: `Statement number ${i} that carries on for a good while so the spec grows.`, bin: i % 2, why: 'Because it does.' });
    expect(issues(s).join(' ')).toContain('characters');
  });
  test('standaloneProblem passes whole sentences and stops dangling ones', () => {
    expect(standaloneProblem('Two consuls were chosen each year, and each could veto the other.')).toBeNull();
    expect(standaloneProblem('This is why the Republic fell.')).not.toBeNull();
    expect(standaloneProblem('Also, the Senate met in Rome every month.')).not.toBeNull();
    expect(standaloneProblem('Short.')).not.toBeNull();
  });
});

describe('a spec from another subject runs with no code change', () => {
  test('history: the same seed gives the same round, and different seeds differ', () => {
    const a = prepare(history, 'h:0', 1), b = prepare(history, 'h:0', 1);
    expect(deal(a).map(cardId)).toEqual(deal(b).map(cardId));
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(deal(prepare(history, `seed${i}:0`, 1)).map(cardId).join(','));
    expect(seen.size).toBeGreaterThan(5);
  });
  test('rung 0 is two bins and a few statements, rung 1 more', () => {
    const r0 = prepare(history, 'x:0', 0), r1 = prepare(history, 'x:0', 1);
    expect(r0.bins.length).toBe(2);
    expect(deal(r0).length).toBe(4);
    expect(deal(r0).some((c) => c.bin === 'both')).toBe(false);
    expect(deal(r1).length).toBeGreaterThan(deal(r0).length);
  });
  test('a round has the same number from each bin', () => {
    for (let i = 0; i < 30; i++) {
      const cards = deal(prepare(history, `bal${i}:0`, 0));
      expect(cards.filter((c) => c.bin === 0).length).toBe(2);
      expect(cards.filter((c) => c.bin === 1).length).toBe(2);
    }
  });
  test('the engine, not the spec, says where a statement goes: a right run meets every statement', () => {
    for (const task of run(history, 1)) {
      const r = result(task, perfect(task));
      expect(r.met).toBe(true);
      expect(r.label).toContain('in the right place first time');
    }
  });
  test('the end of a round names the two things and says why a miss went where it did', () => {
    const task = prepare(history, 'miss:0', 0);
    const cards = deal(task);
    const placements = cards.map((c, i) => ({ id: cardId(c), first: i < 2 ? (c.bin === 0 ? 1 : 0) : c.bin, tries: i < 2 ? 2 : 1 }));
    const r = result(task, { placements, retired: [] });
    expect(r.met).toBe(false);
    expect(r.why).toContain(history.cards.find((c) => c.t === cards[0].t)!.why);
    expect(r.label).toContain('The Roman Republic');
    expect(r.label).toContain('The Roman Empire');
  });
  test('swapping two things more than once is named as a wrong idea', () => {
    const task = prepare(history, 'mix:0', 0);
    const placements = deal(task).map((c) => ({ id: cardId(c), first: c.bin === 0 ? 1 : 0, tries: 2 }) as { id: string; first: 0 | 1; tries: number });
    const r = result(task, { placements, retired: [] });
    expect(r.misconception).toMatch(/Mixes up/);
  });
  test('using "both" for something that is not shared is a slip, and so is missing a shared one', () => {
    const task = prepare(history, 'both:0', 1);
    const cards = deal(task);
    const wrongBoth = cards.map((c) => ({ id: cardId(c), first: (c.bin === 'both' ? 0 : 'both') as 0 | 'both', tries: 2 }));
    const r = result(task, { placements: wrongBoth, retired: [] });
    expect(r.met).toBe(false);
    expect(r.misconception).toBeTruthy();
  });
  test('slack allows one slip in four to eight', () => {
    expect([slack(4), slack(6), slack(8), slack(9)]).toEqual([1, 1, 2, 2]);
  });
});

describe('three bins, near-identical statements', () => {
  const three: SortSpec = {
    bins: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
    cards: [0, 1, 2].flatMap((b) => [0, 1, 2, 3, 4].map((i) => ({ t: `Item ${'ABCDE'[i]} of the ${['first', 'second', 'third'][b]} group holds the ${['red', 'blue', 'green'][b]} lamp in the shared hall.`, bin: b, why: `It belongs to group ${b + 1}.` }))),
  };
  test('the synthetic spec is fit to use', () => expect(issues(three)).toEqual([]));
  test('rung 2 shows all three bins and nine statements; rungs 0 and 1 show two bins', () => {
    expect(prepare(three, 't:0', 2).bins).toEqual([0, 1, 2]);
    expect(deal(prepare(three, 't:0', 2)).length).toBe(9);
    expect(prepare(three, 't:0', 0).bins.length).toBe(2);
    expect(chooseBins(three, 1).length).toBe(2);
  });
  test('generated three-bin specs show all three at rung 2', () => {
    const triples = generated.filter((a) => a.spec.bins.length === 3);
    for (const a of triples) expect(prepare(a.spec, 'g:0', 2).bins).toEqual([0, 1, 2]);
  });
  test('rung 2 picks the statements that read most like another bin', () => {
    const spec: SortSpec = {
      bins: [{ label: 'Left' }, { label: 'Right' }],
      cards: [
        { t: 'The harbour wall protects the northern shipping lanes from the winter swell.', bin: 0, why: 'Harbour wall.' },
        { t: 'The harbour wall protects the northern fishing boats from the winter swell.', bin: 1, why: 'Harbour wall too.' },
        { t: 'Oranges ripen in the orchards above the town during the spring.', bin: 0, why: 'Oranges.' },
        { t: 'Granite was quarried on the upper slope and carried down by cart.', bin: 0, why: 'Granite.' },
        { t: 'Lanterns hung along the quay are lit by the keeper at dusk.', bin: 1, why: 'Lanterns.' },
        { t: 'Salt pans on the eastern shore are raked twice a week in summer.', bin: 1, why: 'Salt pans.' },
        { t: 'A ferry crosses the estuary every hour from early morning until nightfall.', bin: 0, why: 'Ferry.' },
        { t: 'The bell tower was rebuilt after the great fire in the sixteenth century.', bin: 1, why: 'Bell tower.' },
      ],
    };
    expect(issues(spec)).toEqual([]);
    let first = 0;
    for (let i = 0; i < 20; i++) {
      const cards = deal(prepare(spec, `near${i}:0`, 2));
      if (cards.some((c) => c.t.includes('shipping lanes')) && cards.some((c) => c.t.includes('fishing boats'))) first++;
    }
    expect(first).toBe(20);
  });
});

describe('a run does not repeat a statement when the pool allows it', () => {
  test('three rounds of rung 0 on the history pool meet all eight bin statements before any repeats', () => {
    const all = new Set<string>();
    for (const task of run(history, 0)) for (const c of deal(task)) all.add(c.t);
    expect(all.size).toBe(8);
  });
});

describe('"this statement is unclear"', () => {
  test('a retired statement is never dealt again, and the bin keeps its balance', () => {
    const task = prepare(history, 'ret:0', 0);
    const first = deal(task);
    const gone = new Set([cardId(first[0])]);
    const again = deal(task, gone);
    expect(again.map(cardId)).not.toContain(cardId(first[0]));
    expect(again.filter((c) => c.bin === first[0].bin).length).toBe(first.filter((c) => c.bin === first[0].bin).length);
  });
  test('a replacement comes from the same bin and is not already in play', () => {
    const task = prepare(history, 'rep:0', 1);
    const cards = deal(task);
    const victim = cards.find((c) => c.bin === 0)!;
    const retired = new Set([cardId(victim)]);
    const spare = replacement(task, retired, cards, 0);
    expect(spare).not.toBeNull();
    expect(spare!.bin).toBe(0);
    expect(cards.map(cardId)).not.toContain(cardId(spare!));
    expect(cardId(spare!)).not.toBe(cardId(victim));
  });
  test('when the pool is gone there is no replacement, and the round is just shorter', () => {
    const task = prepare(history, 'none:0', 0);
    const everything = new Set(history.cards.filter((c) => c.bin === 0).map(cardId));
    expect(replacement(task, everything, [], 0)).toBeNull();
    expect(deal(task, everything).filter((c) => c.bin === 0).length).toBe(0);
  });
  test('the run report says how many were marked unclear', () => {
    const task = prepare(history, 'note:0', 0);
    const retired = [cardId(deal(task)[0])];
    const r = result(task, perfect(task, retired));
    expect(r.note).toBe('1 statement marked as unclear and left out for good.');
    const report = buildReport({ activityId: 'ho-sort-x', skill: 'telling-apart', rung: 0, rounds: [r, r, r], finished: true });
    expect(report.note).toContain('marked as unclear');
    expect(report.valid).toBe(true);
    expect(report.criteria.length).toBe(3);
  });
  test('a run ended early reports valid false and no criteria', () => {
    const report = buildReport({ activityId: 'ho-sort-x', skill: 'telling-apart', rung: 0, rounds: [], finished: false });
    expect(report.valid).toBe(false);
    expect(report.criteria).toEqual([]);
  });
});

describe('the engine code mentions no subject', () => {
  test('sort/logic.ts and sort/view.ts', () => {
    const words = ['consul', 'roman', 'senate', 'protein', 'enzyme', 'kinetic', 'ligand', 'transcription', 'ribosome', 'spectrum', 'history', 'biology'];
    for (const file of ['logic.ts', 'view.ts', 'sort.css']) {
      const text = readFileSync(join(ROOT, 'src', 'engines', 'sort', file), 'utf8').toLowerCase();
      for (const word of words) expect(`${file}: ${text.includes(word) ? word : ''}`).toBe(`${file}: `);
    }
  });
  test('binOf is a plain lookup on the spec', () => {
    expect(binOf(history, 'The Senate continued to meet in the city of Rome.')).toBe('both');
  });
});
