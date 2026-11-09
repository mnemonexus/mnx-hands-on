import { describe, expect, test } from 'bun:test';
import { pinnedFor } from './pinned';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  gridOf, isDecoy, issues, pairsOf, prepare, result, separators, smallestSets, verdictOf,
  type ControlsAttempt, type ControlsSpec, type ControlsTask,
} from '../src/engines/controls/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const content: Record<string, { id: string; spec: ControlsSpec }> = {};
const pinned = pinnedFor<{ id: string; spec: ControlsSpec }>('controls');
for (const f of readdirSync(join(ROOT, 'content', 'controls'))) if (f.endsWith('.json')) content[f.replace('.json', '')] = readJson('content', 'controls', f);
const fixtures: Record<string, ControlsSpec> = {};
for (const f of readdirSync(join(ROOT, 'test', 'fixtures', 'controls'))) if (f.endsWith('.json')) fixtures[f.replace('.json', '')] = readJson('test', 'fixtures', 'controls', f);

const rtpcr = pinned['rt-pcr-band'].spec;
const mir = pinned['mir-214-atf4'].spec;
const village = fixtures['deserted-village'];
const specs: Array<[string, ControlsSpec]> = [...Object.entries(content).map(([k, v]) => [k, v.spec] as [string, ControlsSpec]), ...Object.entries(fixtures)];
const clone = (s: ControlsSpec): ControlsSpec => JSON.parse(JSON.stringify(s));
const ids = (t: ControlsTask, set: number[]) => set.map((c) => t.grid.conds[c].id).sort();

/** The smallest set that works, as an attempt. */
const best = (t: ControlsTask): ControlsAttempt => ({ kind: 'set', chosen: smallestSets(t.grid)[0] });
/** A set that does not work: every decoy, up to the slots. */
const worst = (t: ControlsTask): ControlsAttempt => ({ kind: 'set', chosen: t.grid.conds.map((_, c) => c).filter((c) => isDecoy(t.grid, c)).slice(0, t.slots) });

describe('the shipped activities are fit to use', () => {
  for (const [name, spec] of specs) test(`${name} has no issues`, () => expect(issues(spec)).toEqual([]));
  test('every activity has its own id, and the ones these tests lean on are present', () => {
    const ids = Object.values(content).map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^ho-controls-/);
    expect(new Set(ids).size).toBe(ids.length);
    for (const name of ['mir-214-atf4', 'rt-pcr-band']) expect(pinned[name]).toBeDefined();
  });
  test('a spec from another subject is kept beside them, and is not a course activity', () => {
    expect(fixtures['deserted-village']).toBeDefined();
    for (const name of Object.keys(fixtures)) expect(content[name]).toBeUndefined();
  });
  test('each launch fits the catalogue limit of 4096 characters', () => {
    for (const [name, a] of Object.entries(content)) expect([name, JSON.stringify({ engine: 'controls', spec: a.spec }).length <= 4096]).toEqual([name, true]);
  });
  test('the engine is registered under its id', () => expect(engines.controls.label).toBe('Choose Your Controls'));
});

describe('what a set of conditions tells apart is worked out from the outcomes', () => {
  test('RT-PCR: leaving out the reverse transcriptase and leaving out the cDNA tell all three apart (000 B4.n)', () => {
    const g = gridOf(rtpcr);
    const idx = (id: string) => g.conds.findIndex((c) => c.id === id);
    expect(verdictOf(g, [idx('no-rt'), idx('no-cdna')]).all).toBe(true);
    expect(verdictOf(g, [idx('no-rt')]).all).toBe(false);
    expect(verdictOf(g, [idx('no-cdna')]).stuck.length).toBe(1);
    // With no cDNA, "the cells really expressed it" and "DNA contamination" both give no band: they look the same.
    const stuck = verdictOf(g, [idx('no-cdna')]).stuck[0];
    expect(stuck.map((h) => g.hyps[h].id).sort()).toEqual(['dna', 'real']);
  });
  test('RT-PCR: a control for a known gene, or a repeat, gives the same result under every explanation', () => {
    const g = gridOf(rtpcr);
    expect(g.conds.filter((_, c) => isDecoy(g, c)).map((c) => c.id).sort()).toEqual(['again', 'known', 'long']);
    const v = verdictOf(g, [g.conds.findIndex((c) => c.id === 'known')]);
    expect(v.wasted.length).toBe(1);
    expect(v.stuck.length).toBe(3);
  });
  test('miR-214: the reporter with the wild-type 3\' UTR is the only thing that tells direct from indirect, so every smallest set holds it (026 A25.6)', () => {
    const g = gridOf(mir);
    const sets = smallestSets(g);
    expect(sets.every((s) => s.length === 2)).toBe(true);
    const wt = g.conds.findIndex((c) => c.id === 'luc-wt');
    expect(sets.every((s) => s.includes(wt))).toBe(true);
    const pair = pairsOf(g.hyps.length).find((p) => [g.hyps[p[0]].id, g.hyps[p[1]].id].sort().join() === 'direct,indirect')!;
    expect(separators(g, pair)).toEqual([wt]);
  });
  test('smallestSets finds every smallest set and no smaller one', () => {
    const g = gridOf(village);
    const sets = smallestSets(g).map((s) => g.conds.filter((_, c) => s.includes(c)).map((c) => c.id).sort().join('+')).sort();
    expect(sets).toEqual(['burials+rings', 'rings+wool']);
    for (let c = 0; c < g.conds.length; c++) expect(verdictOf(g, [c]).all).toBe(false);
  });
});

describe('a spec from another subject runs with no code change', () => {
  test('history: rival explanations of an abandoned village against sources that would separate them', () => {
    const g = gridOf(village);
    expect(g.hyps.length).toBe(3);
    for (let rung = 0; rung < 3; rung++) for (let i = 0; i < 20; i++) {
      const t = prepare(village, `h${i}:${rung}`, rung);
      expect(result(t, rung === 0 ? { kind: 'purposes', answers: t.questions.map((q) => q.options.findIndex((o) => o.correct)) } : best(t)).met).toBe(true);
    }
    const t = prepare(village, 'h:0', 2);
    expect(result(t, worst(t)).misconception).toContain('same result under every explanation');
  });
  test('the engine code mentions no subject', () => {
    const words = ['dna', 'rna', 'pcr', 'luciferase', 'agomir', 'protein', 'transcript', 'reporter', 'enzyme', 'plasmid', 'village', 'plague', 'sheep', 'harvest', 'burial', 'history', 'gel', 'band', 'lane', 'chemical'];
    for (const file of ['engines/controls/logic.ts', 'engines/controls/view.ts', 'engines/controls/controls.css']) {
      const text = readFileSync(join(ROOT, 'src', file), 'utf8').toLowerCase();
      for (const word of words) expect(`${file}: ${new RegExp(`\\b${word}`).test(text) ? word : ''}`).toBe(`${file}: `);
    }
  });
});

describe('a spec with a mistake is refused, in words a writer can act on', () => {
  test('a pair of explanations that can never be told apart', () => {
    const s = clone(village);
    for (const c of s.conditions) s.outcomes[c.id].sheep = s.outcomes[c.id].plague;
    const found = issues(s).join(' ');
    expect(found).toMatch(/give the same result under every condition, so no choice of controls could ever tell them apart/);
    expect(found).toContain('Plague killed');
  });
  test('no decoy', () => {
    const s = clone(village);
    s.conditions = s.conditions.filter((c) => c.id !== 'tax' && c.id !== 'church');
    delete s.outcomes.tax; delete s.outcomes.church;
    s.conditions.push({ id: 'extra1', name: 'A diary' }, { id: 'extra2', name: 'A map' });
    s.outcomes.extra1 = { plague: 'increased', sheep: 'none', weather: 'none' };
    s.outcomes.extra2 = { plague: 'none', sheep: 'increased', weather: 'reduced' };
    expect(issues(s).join(' ')).toMatch(/No condition is a decoy/);
  });
  test('too few conditions to leave a choice', () => {
    const s = clone(village);
    s.conditions = s.conditions.slice(0, 3);
    for (const k of ['tax', 'church']) delete s.outcomes[k];
    expect(issues(s).join(' ')).toMatch(/at least 4|4 to 10/);
  });
  test('an outcome outside the vocabulary, a missing outcome, one explanation, and too many', () => {
    const a = clone(village); (a.outcomes.wool as Record<string, string>).sheep = 'huge';
    expect(issues(a).join(' ')).toMatch(/must be one of signal, none, reduced, increased/);
    const b = clone(village); delete (b.outcomes.wool as Record<string, string>).sheep;
    expect(issues(b).join(' ')).toMatch(/outcomes\.wool\.sheep/);
    const c = clone(village); c.hypotheses = c.hypotheses.slice(0, 1);
    expect(issues(c).join(' ')).toMatch(/two to 4 rival explanations/);
    const d = clone(village);
    for (let i = 0; i < 2; i++) { d.hypotheses.push({ id: `h${i}`, name: `Another ${i}` }); for (const c2 of d.conditions) (d.outcomes[c2.id] as Record<string, string>)[`h${i}`] = 'none'; }
    expect(issues(d).join(' ')).toMatch(/two to 4 rival explanations/);
  });
  test('not an object', () => expect(issues(null as unknown as ControlsSpec)).toEqual(['The spec must be an object.']));
});

describe('setting a round', () => {
  test('the same seed gives the same task, and seeds differ', () => {
    for (const [, spec] of specs) for (let rung = 0; rung < 3; rung++) {
      expect(JSON.stringify(prepare(spec, 'run1:0', rung))).toBe(JSON.stringify(prepare(spec, 'run1:0', rung)));
    }
    const seen = new Set(Array.from({ length: 30 }, (_, i) => prepare(mir, `s${i}:0`, 1).grid.conds.map((c) => c.id).join()));
    expect(seen.size).toBeGreaterThan(4);
  });
  test('every round is fit: all pairs separable, a decoy present, room to choose', () => {
    for (const [name, spec] of specs) for (let rung = 0; rung < 3; rung++) for (let i = 0; i < 40; i++) {
      const t = prepare(spec, `fit${i}:${i % 3}`, rung);
      const g = t.grid;
      const ctx = `${name} rung ${rung} seed ${i}`;
      expect(`${ctx} ${pairsOf(g.hyps.length).every((p) => separators(g, p).length > 0)}`).toBe(`${ctx} true`);
      expect(`${ctx} ${g.conds.some((_, c) => isDecoy(g, c))}`).toBe(`${ctx} true`);
      expect(`${ctx} ${g.conds.length >= t.smallest + 2}`).toBe(`${ctx} true`);
      expect(t.smallest).toBe(smallestSets(g)[0].length);
    }
  });
  test('slots: tight at rung 2 (the fewest that could do it), generous at rung 1, never as many as there are conditions', () => {
    for (const [, spec] of specs) for (let i = 0; i < 20; i++) {
      const t1 = prepare(spec, `sl${i}:0`, 1);
      const t2 = prepare(spec, `sl${i}:0`, 2);
      expect(t2.slots).toBe(t2.smallest);
      expect(t1.slots).toBeGreaterThan(t1.smallest);
      expect(t1.slots).toBeLessThan(t1.grid.conds.length);
    }
  });
  test('a larger spec varies from round to round: it draws a subset that stays fit', () => {
    const sizes = new Set(Array.from({ length: 40 }, (_, i) => prepare(mir, `v${i}:0`, 1).grid.conds.length));
    expect([...sizes].sort()).toEqual([4, 5, 6].filter((n) => sizes.has(n)));
    expect(sizes.size).toBeGreaterThan(1);
    // The condition that alone separates direct from indirect is never dropped.
    for (let i = 0; i < 60; i++) expect(prepare(mir, `w${i}:0`, 1).grid.conds.some((c) => c.id === 'luc-wt')).toBe(true);
  });
  test('rung 0 gives a smallest strong set and asks what each is for, with exactly one right kind of answer', () => {
    for (const [, spec] of specs) for (let i = 0; i < 20; i++) {
      const t = prepare(spec, `q${i}:0`, 0);
      expect(t.strong.length).toBe(t.smallest);
      expect(verdictOf(t.grid, t.strong).all).toBe(true);
      expect(t.questions.length).toBe(t.strong.length);
      for (const q of t.questions) {
        expect(q.options.filter((o) => o.correct).length).toBe(1);
        const right = q.options.find((o) => o.correct)!;
        expect(t.grid.cell[q.cond][right.pair![0]]).not.toBe(t.grid.cell[q.cond][right.pair![1]]);
        for (const o of q.options.filter((x) => !x.correct && x.pair)) expect(t.grid.cell[q.cond][o.pair![0]]).toBe(t.grid.cell[q.cond][o.pair![1]]);
        expect(q.options.some((o) => o.pair === null)).toBe(true);
      }
    }
  });
});

describe('judging a choice', () => {
  test.each(specs)('%s: the smallest set is met at every rung with nothing to say', (_n, spec) => {
    for (const rung of [1, 2]) for (let i = 0; i < 12; i++) {
      const t = prepare(spec, `j${i}:0`, rung);
      const v = result(t, best(t));
      expect(v.met).toBe(true);
      expect(v.misconception).toBeUndefined();
      expect(v.why).toBe(t.lesson);
      expect(v.label.length).toBeGreaterThan(20);
      expect(v.label.length).toBeLessThanOrEqual(200);
    }
  });
  test('a set that leaves two explanations looking the same says which, in letters', () => {
    const t = prepare(rtpcr, 'x:0', 2);
    const one: ControlsAttempt = { kind: 'set', chosen: [t.grid.conds.findIndex((c) => c.id === 'no-rt')] };
    const v = result(t, one);
    expect(v.met).toBe(false);
    expect(v.why).toMatch(/^Still cannot be told apart: [A-C] and [A-C]/);
    expect(v.misconception).toBe('Chose conditions that leave two explanations looking the same');
  });
  test('a wasted control is named and shown to give the same result under every explanation', () => {
    const t = prepare(rtpcr, 'w:0', 1);
    const known = t.grid.conds.findIndex((c) => c.id === 'known' || c.id === 'again');
    const v = result(t, { kind: 'set', chosen: [known] });
    expect(v.met).toBe(false);
    expect(v.why).toContain('same result under every explanation');
    expect(v.misconception).toContain('same result under every explanation');
  });
  test('more conditions than slots is not met, even when they would work', () => {
    const t = prepare(rtpcr, 'o:0', 2);
    const all = { kind: 'set', chosen: t.grid.conds.map((_, c) => c) } as ControlsAttempt;
    const v = result(t, all);
    expect(v.met).toBe(false);
    expect(v.why).toContain('slots');
    expect(result(t, { kind: 'set', chosen: [] }).met).toBe(false);
  });
  test('rung 0: saying what each is for is judged against what it really separates', () => {
    const t = prepare(rtpcr, 'p:0', 0);
    const rightAnswers = t.questions.map((q) => q.options.findIndex((o) => o.correct));
    expect(result(t, { kind: 'purposes', answers: rightAnswers }).met).toBe(true);
    const wrong = t.questions.map((q) => q.options.findIndex((o) => !o.correct));
    const v = result(t, { kind: 'purposes', answers: wrong });
    expect(v.met).toBe(false);
    expect(v.why).toContain('tells ');
    expect(v.misconception).toBeTruthy();
    const none = t.questions.map((q) => q.options.findIndex((o) => o.pair === null));
    expect(result(t, { kind: 'purposes', answers: none }).misconception).toContain('none of them apart');
  });
  test('the order chosen does not matter, and the same condition twice counts once', () => {
    const t = prepare(rtpcr, 'dup:0', 1);
    const set = smallestSets(t.grid)[0];
    expect(result(t, { kind: 'set', chosen: [...set].reverse() }).met).toBe(true);
    expect(ids(t, set).length).toBe(set.length);
  });
});
