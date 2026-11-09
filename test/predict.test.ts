import { describe, expect, test } from 'bun:test';
import { pinnedFor } from './pinned';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANCHORS, bind, configsOf, drawnPeaks, issues, judge, placeOf, prepare, resolveConfig, result, smooth, truthLine, infoOf,
  type PredictAttempt, type PredictSpec, type PredictTask,
} from '../src/engines/predict/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const content: Record<string, { id: string; spec: PredictSpec }> = {};
const pinned = pinnedFor<{ id: string; spec: PredictSpec }>('predict');
for (const f of readdirSync(join(ROOT, 'content', 'predict'))) if (f.endsWith('.json')) content[f.replace('.json', '')] = readJson('content', 'predict', f);
const fixtures: Record<string, PredictSpec> = {};
for (const f of readdirSync(join(ROOT, 'test', 'fixtures', 'predict'))) if (f.endsWith('.json')) fixtures[f.replace('.json', '')] = readJson('test', 'fixtures', 'predict', f);

const film = pinned['film-and-blots'].spec;
const emsa = pinned['emsa-competitor-supershift'].spec;
const sec = pinned['sec-two-detectors'].spec;
const specs: Array<[string, PredictSpec]> = [...Object.entries(content).map(([k, v]) => [k, v.spec] as [string, PredictSpec]), ...Object.entries(fixtures)];

/** The bands found in a lane of a configuration, as "short level" words. */
function seen(spec: PredictSpec, change: string | null, lane: string): string[] {
  const cfg = resolveConfig(spec, change ? (spec.changes.find((c) => c.id === change) ?? null) : null);
  return (cfg.lanes.find((l) => l.id === lane)?.bands ?? []).map((b) => `${b.short}:${spec.skin === 'trace' ? b.height.toFixed(2) : b.level}`);
}

/** An attempt that is right for the task. */
function right(t: PredictTask): PredictAttempt {
  const pick = t.mystery?.correct[0];
  if (t.skin === 'trace') {
    const anchors = t.lanes.map(() => new Array<number>(ANCHORS).fill(0));
    for (const i of t.fill) for (const b of t.lanes[i].truth) anchors[i][Math.round(b.t * (ANCHORS - 1))] = b.height;
    return { skin: 'trace', anchors, pick };
  }
  return { skin: 'bands', placed: t.fill.flatMap((i) => t.lanes[i].truth.map((b) => ({ lane: i, sp: b.sp, y: b.t, level: b.level }))), pick };
}

describe('the shipped activities are fit to use', () => {
  for (const [name, spec] of specs) test(`${name} has no issues`, () => expect(issues(spec)).toEqual([]));
  test('every activity has its own id, and the ones these tests lean on are present', () => {
    const ids = Object.values(content).map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^ho-predict-/);
    expect(new Set(ids).size).toBe(ids.length);
    for (const name of ['emsa-competitor-supershift', 'film-and-blots', 'sec-two-detectors']) expect(pinned[name]).toBeDefined();
  });
  test('specs from other subjects are kept beside them, and are not course activities', () => {
    expect(Object.keys(fixtures).length).toBeGreaterThan(0);
    for (const name of Object.keys(fixtures)) expect(content[name]).toBeUndefined();
  });
  test('each launch fits the catalogue limit of 4096 characters', () => {
    for (const [name, a] of Object.entries(content)) expect([name, JSON.stringify({ engine: 'predict', spec: a.spec }).length <= 4096]).toEqual([name, true]);
  });
  test('the engine is registered under its id', () => expect(engines.predict.label).toBe('Predict the Result'));
});

describe('bands are worked out from the sample, never listed', () => {
  test('autoradiography: every RNA that took up the radioactive uridine shows, and a lane without it is blank', () => {
    expect(seen(film, null, 'a')).toEqual(['X:1', 'H:2']);
    expect(seen(film, null, 'b')).toEqual([]);
    expect(seen(film, null, 'c')).toEqual(['X:3', 'H:2']);
  });
  test('a darker band means more RNA, and the longer RNA runs less far (000 B2.5, E.9)', () => {
    const cfg = resolveConfig(film, null);
    const x = (id: string) => cfg.lanes.find((l) => l.id === id)!.bands.find((b) => b.sp === 'X')!;
    expect(x('c').amount).toBeGreaterThan(x('a').amount);
    expect(x('c').level).toBeGreaterThan(x('a').level);
    expect(x('a').t).toBeLessThan(cfg.lanes[0].bands.find((b) => b.sp === 'H')!.t);
  });
  test('a northern blot shows only what the probe matches, whatever label the RNA has (000 B3.4, B3.5)', () => {
    expect(seen(film, 'northern', 'a')).toEqual(['X:1']);
    expect(seen(film, 'northern', 'b')).toEqual(['X:1']);
    expect(seen(film, 'probe-h', 'c')).toEqual(['H:3']);
  });
  test('an inducible vector without IPTG makes X at its usual level (000 H.26, H.38)', () => {
    expect(seen(film, null, 'd')).toEqual(seen(film, null, 'a'));
    expect(seen(film, null, 'e')).toEqual(seen(film, null, 'c'));
    expect(seen(film, 'no-iptg', 'e')).toEqual(seen(film, null, 'd'));
  });
  test('mobility shift: protein shifts the labelled DNA up, and the antibody shifts it further (084 A30.5, A40.n)', () => {
    expect(seen(emsa, null, 'a')).toEqual(['DNA:3']);
    expect(seen(emsa, null, 'b')).toEqual(['DNA·P:3', 'DNA:2']);
    expect(seen(emsa, null, 'e')).toEqual(['DNA·P·A:3', 'DNA:2'].map((s) => s.replace('·A', '·Ab')));
    const t = (id: string) => placeOf(emsa, infoOf(emsa, id)!);
    expect(t('D+P+A')).toBeLessThan(t('D+P'));
    expect(t('D+P')).toBeLessThan(t('D'));
  });
  test('mobility shift: a 50-fold excess of cold DNA with the site takes the protein, scrambled DNA does not (084 A45.n)', () => {
    expect(seen(emsa, null, 'c')).toEqual(['DNA:3']);
    expect(seen(emsa, null, 'd')).toEqual(seen(emsa, null, 'b'));
    expect(seen(emsa, 'swap-cold', 'c')).toEqual(seen(emsa, null, 'b'));
    expect(seen(emsa, 'swap-cold', 'd')).toEqual(['DNA:3']);
  });
  test('mobility shift: antibody alone shifts nothing, a scrambled probe shifts nothing, unfolded protein shifts nothing', () => {
    expect(seen(emsa, null, 'f')).toEqual(['DNA:3']);
    for (const lane of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(seen(emsa, 'scrambled-probe', lane)).toEqual(['DNA*:3']);
      expect(seen(emsa, 'unfolded', lane)).toEqual(['DNA:3']);
    }
  });
  test('binding splits what it binds in proportion, and cannot bind more than there is', () => {
    const a = bind(emsa, { D: 1, P: 0.5, C: 1 });
    expect(a['D+P']).toBeCloseTo(0.25, 12);
    expect(a['C+P']).toBeCloseTo(0.25, 12);
    expect(a.D).toBeCloseTo(0.75, 12);
    expect(a.P).toBeUndefined();
    const b = bind(emsa, { D: 1, P: 5 });
    expect(b['D+P']).toBeCloseTo(1, 12);
    expect(b.D).toBeUndefined();
    expect(b.P).toBeCloseTo(4, 12);
    // Antibody binds only the complex.
    const c = bind(emsa, { D: 1, P: 0.4, A: 1 });
    expect(c['D+P+A']).toBeCloseTo(0.4, 12);
    expect(c.A).toBeCloseTo(0.6, 12);
  });
  test('size exclusion: each detector sees what it reads, and the bigger complex comes off first (081 B.f8)', () => {
    expect(seen(sec, null, 'p')).toEqual(['complex:0.86']);
    expect(seen(sec, null, 'l')).toEqual(['complex:0.86', 'free DNA:0.43']);
    expect(seen(sec, 'dna-alone', 'p')).toEqual([]);
    expect(seen(sec, 'dna-alone', 'l')).toEqual(['free DNA:0.86']);
    expect(seen(sec, 'excess-protein', 'l')).toEqual(seen(sec, 'excess-protein', 'p'));
    const cfg = resolveConfig(sec, null);
    expect(cfg.lanes[1].bands[0].t).toBeLessThan(cfg.lanes[1].bands[1].t);
  });
  test('the idealised result has no noise: the same sample gives the same result every time', () => {
    for (const [, spec] of specs) expect(JSON.stringify(configsOf(spec))).toBe(JSON.stringify(configsOf(spec)));
  });
});

describe('position follows size', () => {
  test('log-linear: equal ratios are equal distances, and the bigger runs less far', () => {
    const at = (size: number) => placeOf(film, { id: '_', name: '', short: '', size, at: null, width: 1, reagent: false });
    expect(at(1.2) - at(0.6)).toBeCloseTo(at(2.4) - at(1.2), 12);
    expect(at(0.6)).toBeCloseTo(1, 12);
    expect(at(6)).toBeCloseTo(0, 12);
    expect(at(1.2)).toBeGreaterThan(at(2.4));
  });
  test('measured standards give a position between the two standards a size lies between', () => {
    const spec: PredictSpec = { ...sec, axis: { ...sec.axis, min: 1.4, max: 669, standards: [{ size: 669, at: 10 }, { size: 150, at: 13 }, { size: 81, at: 15 }, { size: 43, at: 17 }, { size: 17, at: 18.5 }, { size: 1.4, at: 21 }] } };
    const run = spec.axis.run!;
    const volume = (size: number) => run.min + placeOf(spec, { id: '_', name: '', short: '', size, at: null, width: 1, reagent: false }) * (run.max - run.min);
    expect(volume(150)).toBeCloseTo(13, 9);
    // 4 x 29 kDa: the course's model answer is a peak at about 13.8 mL, between the 150 and 81 kDa standards.
    expect(volume(116)).toBeGreaterThan(13);
    expect(volume(116)).toBeLessThan(15);
    expect(volume(116)).toBeCloseTo(13.8, 1);
  });
});

describe('a spec from another subject runs with no code change', () => {
  test('chemistry: a paper chromatogram uses the same lanes, bands and darkness', () => {
    const ink = fixtures['ink-chromatography'];
    expect(seen(ink, null, 'a')).toEqual(['red:3', 'blue:3']);
    expect(seen(ink, null, 'c')).toEqual(['red:3', 'blue:3', 'yellow:2']);
    expect(seen(ink, 'diluted', 'a')).toEqual(['red:2', 'blue:2']);
    expect(seen(ink, 'no-yellow', 'b')).toEqual(['blue:3']);
    expect(prepare(ink, 'ink:0', 1).announce).toContain('spot of each ink');
  });
  test('chemistry: a column run is a trace, with peaks placed by observed time and sized by amount', () => {
    const lc = fixtures['hplc-mixture'];
    expect(seen(lc, null, 's')).toEqual(['P:0.86', 'Q:0.86', 'R:0.86']);
    expect(seen(lc, null, 't')).toEqual(['P:0.43', 'R:0.86']);
    expect(seen(lc, 'more-q', 't').length).toBe(3);
  });
  test('every fixture sets a round at every rung and is met by the right attempt', () => {
    for (const [name, spec] of Object.entries(fixtures)) for (let rung = 0; rung < 3; rung++) for (let r = 0; r < 3; r++) {
      const t = prepare(spec, `fix:${r}`, rung);
      expect([name, rung, r, result(t, right(t)).met]).toEqual([name, rung, r, true]);
    }
  });
  test('the engine code mentions no subject', () => {
    const words = ['dna', 'rna', 'protein', 'antibod', 'uridine', 'northern', 'emsa', 'radio', 'enzyme', 'plasmid', 'expression', 'polymerase', 'chromatogra', 'electrophoresis', 'autoradio', 'gel', 'kinetic', 'ink', 'ligand'];
    for (const file of ['engines/predict/logic.ts', 'engines/predict/view.ts', 'engines/predict/predict.css']) {
      const text = readFileSync(join(ROOT, 'src', file), 'utf8').toLowerCase().replace(/[a-z]+\.[a-z]+/g, ' ');
      for (const word of words) {
        // Whole words only: "linking" and "think" are not "ink".
        const found = new RegExp(`\\b${word}`).test(text);
        expect(`${file}: ${found ? word : ''}`).toBe(`${file}: `);
      }
    }
  });
});

describe('setting a round', () => {
  test('the same seed gives the same task, and the first round is the sample as given', () => {
    for (const [, spec] of specs) for (let rung = 0; rung < 3; rung++) {
      expect(JSON.stringify(prepare(spec, 'run1:1', rung))).toBe(JSON.stringify(prepare(spec, 'run1:1', rung)));
      expect(prepare(spec, 'run1:0', rung).change).toBeNull();
      expect(prepare(spec, 'run1:0', rung).announce).toBe(spec.intro);
    }
  });
  test('each later round changes exactly one thing, and a run uses two different changes', () => {
    for (const [, spec] of specs) for (let i = 0; i < 12; i++) {
      const a = prepare(spec, `many${i}:1`, 1);
      const b = prepare(spec, `many${i}:2`, 1);
      expect(a.change).not.toBeNull();
      expect(b.change).not.toBeNull();
      expect(a.change!.id).not.toBe(b.change!.id);
    }
  });
  test('rung 0 fills one lane and shows the others; rung 1 fills all; rung 2 hides one lane and asks which sample made it', () => {
    const t0 = prepare(film, 'r:0', 0);
    expect(t0.fill.length).toBe(1);
    expect(t0.lanes.filter((l) => l.given).length).toBe(t0.lanes.length - 1);
    const t1 = prepare(film, 'r:0', 1);
    expect(t1.fill.length).toBe(t1.lanes.length);
    expect(t1.mystery).toBeNull();
    const t2 = prepare(film, 'r:0', 2);
    expect(t2.mystery).not.toBeNull();
    expect(t2.fill.length).toBe(t2.lanes.length - 1);
    expect(t2.lanes[t2.mystery!.lane].hidden).toBe(true);
    expect(t2.mystery!.correct).toContain(t2.mystery!.lane);
    // The lanes that make the same result are all accepted.
    const same = t2.mystery!.correct.map((i) => JSON.stringify(t2.lanes[i].truth.map((b) => [b.sp, b.level])));
    expect(new Set(same).size).toBe(1);
  });
  test('rung 1 shows at most four lanes, keeps the lanes the change altered, and rung 2 shows them all', () => {
    expect(emsa.lanes.length).toBeGreaterThan(4);
    for (let round = 0; round < 3; round++) for (const base of ['a', 'b', 'c', 'd', 'e']) {
      const seed = `${base}:${round}`;
      const t1 = prepare(emsa, seed, 1);
      expect(t1.lanes.length).toBeLessThanOrEqual(4);
      expect(t1.fill.length).toBe(t1.lanes.length);
      expect(prepare(emsa, seed, 1).lanes.map((l) => l.id)).toEqual(t1.lanes.map((l) => l.id));
      expect(prepare(emsa, seed, 2).lanes.length).toBe(emsa.lanes.length);
      if (round > 0) {
        const change = emsa.changes.find((c) => c.id === t1.change?.id) ?? null;
        const before = resolveConfig(emsa, null); const after = resolveConfig(emsa, change);
        const altered = after.lanes.filter((l, i) => JSON.stringify(l.bands.map((x) => [x.sp, x.level])) !== JSON.stringify(before.lanes[i].bands.map((x) => [x.sp, x.level]))).map((l) => l.id);
        expect(t1.lanes.filter((l) => altered.includes(l.id)).length).toBeGreaterThanOrEqual(Math.min(altered.length, 3));
      }
      // When the whole result has a contrast in it, the kept lanes still show one.
      const sigs = (ls: Array<{ truth: Array<{ sp: string; level: number }> }>) => new Set(ls.map((l) => JSON.stringify(l.truth.map((x) => [x.sp, x.level])))).size;
      const full = prepare(emsa, seed, 2).lanes;
      if (sigs(full) > 1) expect(sigs(t1.lanes)).toBeGreaterThan(1);
      expect(judge(t1, right(t1))).toEqual([]);
    }
  });
  test('the palette holds what is in the lanes, never a reagent, and lists a product that shows', () => {
    const ids = prepare(emsa, 'p:0', 2).palette.map((p) => p.id).sort();
    expect(ids).toEqual(['A', 'C', 'D', 'D+P', 'D+P+A', 'M']);
    expect(prepare(film, 'p:0', 1).palette.map((p) => p.id).sort()).toEqual(['H', 'X']);
  });
  test('the ladder marks round sizes, and a result with no ladder has none', () => {
    expect(prepare(film, 'l:0', 1).ladder.length).toBeGreaterThan(3);
    expect(prepare(emsa, 'l:0', 1).ladder).toEqual([]);
    expect(prepare(sec, 'l:0', 1).ladder).toEqual([]);
  });
});

describe('judging a result', () => {
  test.each(specs)('%s: the right attempt is met at every rung, in every round, with nothing to say', (_n, spec) => {
    for (let rung = 0; rung < 3; rung++) for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) {
      const t = prepare(spec, `j${i}:${r}`, rung);
      const v = result(t, right(t));
      expect(v.met).toBe(true);
      expect(v.misconception).toBeUndefined();
      expect(v.label.length).toBeGreaterThan(20);
      expect(v.label.length).toBeLessThanOrEqual(200);
      expect(v.why).toBe(t.lesson);
      expect(judge(t, right(t))).toEqual([]);
    }
  });
  test('an empty result is not met, and each blank lane that should be blank is accepted', () => {
    const t = prepare(film, 'e:0', 1);
    const v = result(t, { skin: 'bands', placed: [] });
    expect(v.met).toBe(false);
    expect(v.misconception).toBeTruthy();
    expect(judge(t, { skin: 'bands', placed: [] }).filter((m) => m.kind === 'missing').length).toBe(t.lanes.reduce((n, l) => n + l.truth.length, 0));
  });
  test('a band in a blank lane is named, with the spec\'s own reason for why the lane is blank', () => {
    const t = prepare(film, 'b:0', 1);
    const blank = t.lanes.findIndex((l) => !l.truth.length);
    const good = right(t) as Extract<PredictAttempt, { skin: 'bands' }>;
    const bad: PredictAttempt = { skin: 'bands', placed: [...good.placed, { lane: blank, sp: 'X', y: 0.4, level: 2 }] };
    const m = judge(t, bad);
    expect(m.length).toBe(1);
    expect(m[0].kind).toBe('extra');
    expect(m[0].text).toContain('ordinary uridine');
    const v = result(t, bad);
    expect(v.met).toBe(false);
    expect(v.why).toContain('ordinary uridine');
    expect(v.misconception).toBe('Expected RNA to show on film without a radioactive label');
  });
  test('a band the probe does not match is a mismatch with the spec\'s reason, and a missing one is too', () => {
    const t = prepare(film, 'n:1', 1);
    const mid = t.change!.id;
    const good = right(t) as Extract<PredictAttempt, { skin: 'bands' }>;
    const withH: PredictAttempt = { skin: 'bands', placed: [...good.placed, { lane: 0, sp: 'H', y: 0.7, level: 2 }, { lane: 0, sp: 'X', y: 0.45, level: 1 }].filter((p, i, a) => a.findIndex((q) => q.lane === p.lane && q.sp === p.sp) === i) };
    if (mid === 'northern') {
      const m = judge(t, withH);
      expect(m.some((x) => x.kind === 'extra' && x.text.includes('probe matches X only'))).toBe(true);
    }
    const without: PredictAttempt = { skin: 'bands', placed: good.placed.filter((p) => p.lane !== 0) };
    expect(judge(t, without).some((x) => x.kind === 'missing' && x.lane === 0)).toBe(true);
  });
  test('order: a heavier thing placed beyond a lighter one is named once, however many lanes it is wrong in', () => {
    const t = prepare(film, 'o:0', 1);
    const good = right(t) as Extract<PredictAttempt, { skin: 'bands' }>;
    const flipped: PredictAttempt = { skin: 'bands', placed: good.placed.map((p) => (p.sp === 'X' ? { ...p, y: 0.9 } : p)) };
    const m = judge(t, flipped).filter((x) => x.kind === 'order');
    expect(m.length).toBe(1);
    expect(m[0].text).toMatch(/^In lanes /);
    expect(m[0].text).toContain('moves less far');
    expect(result(t, flipped).met).toBe(false);
  });
  test('darker than: equal darkness where the truth differs is a slip, one slip is allowed, two are not', () => {
    const t = prepare(film, 'd:0', 1);
    const good = right(t) as Extract<PredictAttempt, { skin: 'bands' }>;
    const flat: PredictAttempt = { skin: 'bands', placed: good.placed.map((p) => ({ ...p, level: 2 })) };
    const m = judge(t, flat);
    expect(m.length).toBeGreaterThan(1);
    expect(m.every((x) => x.kind === 'darker')).toBe(true);
    expect(result(t, flat).met).toBe(false);
    // Fixing all but one leaves it met.
    const oneOff: PredictAttempt = { skin: 'bands', placed: good.placed.map((p) => (p.lane === 0 && p.sp === 'X' ? { ...p, level: 2 } : p)) };
    expect(judge(t, oneOff).filter((x) => x.kind === 'darker').length).toBeLessThanOrEqual(1);
  });
  test('snapping is generous: where a band is placed matters only as far as order, and a nearby spot is fine', () => {
    const t = prepare(film, 's:0', 1);
    const good = right(t) as Extract<PredictAttempt, { skin: 'bands' }>;
    const shifted: PredictAttempt = { skin: 'bands', placed: good.placed.map((p) => ({ ...p, y: Math.min(1, p.y + 0.08) })) };
    expect(result(t, shifted).met).toBe(true);
  });
  test('rung 0 judges only the lane filled in, and compares its darkness with the lanes shown', () => {
    for (let i = 0; i < 12; i++) {
      const t = prepare(film, `z${i}:0`, 0);
      expect(result(t, right(t)).met).toBe(true);
      const wrong = { skin: 'bands', placed: [] } as PredictAttempt;
      const lane = t.fill[0];
      expect(judge(t, wrong).every((m) => m.lane === lane)).toBe(true);
    }
  });
  test('rung 2: naming the wrong sample is not met and says which sample it was', () => {
    const t = prepare(film, 'm:0', 2);
    const good = right(t) as Extract<PredictAttempt, { skin: 'bands' }>;
    const wrongLane = t.mystery!.options.find((o) => !t.mystery!.correct.includes(o.lane));
    const bad: PredictAttempt = { ...good, pick: wrongLane!.lane };
    expect(result(t, bad).met).toBe(false);
    expect(judge(t, bad).some((m) => m.kind === 'sample' && m.text.includes(t.lanes[t.mystery!.correct[0]].name))).toBe(true);
    expect(result(t, { ...good, pick: undefined }).met).toBe(false);
  });
  test('the label is a sentence a student can read, naming the change after round 0', () => {
    const t = prepare(emsa, 'lab:1', 1);
    expect(result(t, right(t)).label).toMatch(/^Predicts the bands of the mobility shift assay after /);
    expect(result(prepare(emsa, 'lab:0', 0), right(prepare(emsa, 'lab:0', 0))).label).toMatch(/^Predicts the bands of the mobility shift assay, lane \d/);
  });
});

describe('the trace skin', () => {
  test('a smooth line through anchors never overshoots them, so a peak is only ever at an anchor', () => {
    const ys = [0, 0, 0.2, 0.9, 0.2, 0, 0, 0.5, 0.5, 0.1, 0, 0, 0, 0, 0, 0, 0];
    const f = smooth(ys);
    for (let i = 0; i <= 400; i++) { const v = f(i / 400); expect(v).toBeLessThanOrEqual(0.9 + 1e-9); expect(v).toBeGreaterThanOrEqual(-1e-9); }
    ys.forEach((y, i) => expect(f(i / (ys.length - 1))).toBeCloseTo(y, 9));
  });
  test('peaks are counted from the anchors: a plateau is one, a wobble is none', () => {
    const k = ANCHORS;
    const a = new Array<number>(k).fill(0);
    a[4] = 0.5;
    expect(drawnPeaks(a).length).toBe(1);
    a[5] = 0.5;
    expect(drawnPeaks(a).length).toBe(1);
    a[12] = 0.04;
    expect(drawnPeaks(a).length).toBe(1);
    a[12] = 0.4; a[11] = 0.38; a[13] = 0.39;
    expect(drawnPeaks(a).length).toBe(2);
    expect(drawnPeaks(new Array<number>(k).fill(0.5)).length).toBe(0);
  });
  test('the true line has a clean peak at each band and no noise', () => {
    const t = prepare(sec, 'tr:0', 1);
    const f = truthLine(t.lanes[1].truth);
    expect(f(t.lanes[1].truth[0].t)).toBeCloseTo(t.lanes[1].truth[0].height, 3);
    expect(f(0)).toBeLessThan(1e-6);
    expect(f(0.5)).toBe(f(0.5));
  });
  test('count, place and which is larger are judged, and a wrong count is named', () => {
    const t = prepare(sec, 'tc:0', 1);
    const good = right(t) as Extract<PredictAttempt, { skin: 'trace' }>;
    expect(result(t, good).met).toBe(true);
    // Leave out the second peak in the label trace.
    const noFree = { skin: 'trace', anchors: good.anchors.map((a, i) => (i === 1 ? a.map((v, k) => (k === Math.round(t.lanes[1].truth[1].t * (ANCHORS - 1)) ? 0 : v)) : a)) } as PredictAttempt;
    const m = judge(t, noFree);
    expect(m.some((x) => x.kind === 'peak-missing' && x.text.includes('free labelled DNA'))).toBe(true);
    // A peak where nothing comes off.
    const extra = { skin: 'trace', anchors: good.anchors.map((a, i) => (i === 0 ? a.map((v, k) => (k === 14 ? 0.5 : v)) : a)) } as PredictAttempt;
    expect(judge(t, extra).some((x) => x.kind === 'peak-extra')).toBe(true);
    // The smaller peak drawn taller than the big one.
    const swapped = { skin: 'trace', anchors: good.anchors.map((a, i) => {
      if (i !== 1) return a;
      const c = Math.round(t.lanes[1].truth[0].t * (ANCHORS - 1)); const f = Math.round(t.lanes[1].truth[1].t * (ANCHORS - 1));
      const b = a.slice(); b[c] = 0.3; b[f] = 0.8; return b;
    }) } as PredictAttempt;
    expect(judge(t, swapped).some((x) => x.kind === 'larger')).toBe(true);
    expect(result(t, swapped).met).toBe(false);
  });
  test('a peak near the right place counts, and a peak far from it does not', () => {
    const t = prepare(sec, 'tn:0', 1);
    const good = right(t) as Extract<PredictAttempt, { skin: 'trace' }>;
    const c = Math.round(t.lanes[0].truth[0].t * (ANCHORS - 1));
    const near = { skin: 'trace', anchors: good.anchors.map((a, i) => (i === 0 ? a.map((v, k) => (k === c ? 0 : k === c + 1 ? t.lanes[0].truth[0].height : v)) : a)) } as PredictAttempt;
    expect(result(t, near).met).toBe(true);
    const far = { skin: 'trace', anchors: good.anchors.map((a, i) => (i === 0 ? a.map((v, k) => (k === c ? 0 : k === c + 5 ? t.lanes[0].truth[0].height : v)) : a)) } as PredictAttempt;
    expect(result(t, far).met).toBe(false);
  });
});

describe('a spec with a mistake is refused, in words a writer can act on', () => {
  const clone = (): PredictSpec => JSON.parse(JSON.stringify(emsa));
  test('an amount too close to a darkness line to call', () => {
    const s = clone(); s.lanes[1].mix.P = 0.5;
    expect(issues(s).join(' ')).toMatch(/too close to the 50% line/);
  });
  test('a blank lane with no reason given', () => {
    const s: PredictSpec = JSON.parse(JSON.stringify(film)); s.why = (s.why ?? []).filter((w) => w.kind !== 'blank');
    expect(issues(s).join(' ')).toMatch(/Lane "b" shows nothing in "base".*kind "blank"/);
  });
  test('a reason that is not true', () => {
    const s = clone(); s.why = [...(s.why ?? []), { kind: 'absent', species: 'D+P', lane: 'b', in: ['base'], say: 'It is not there.' }];
    expect(issues(s).join(' ')).toMatch(/but the engine works out the opposite/);
    const o = clone(); o.why = [{ kind: 'order', species: ['D', 'D+P'], say: 'wrong way round' }];
    expect(issues(o).join(' ')).toMatch(/runs before/);
  });
  test('a probe or label that nothing carries', () => {
    const s: PredictSpec = JSON.parse(JSON.stringify(film)); s.detect = { rule: 'probe', name: 'probe Q' };
    expect(issues(s).join(' ')).toMatch(/nothing would ever show/);
  });
  test('two bands that run too close together, and a band off the axis', () => {
    const s = clone(); s.species.P.size = 0.05;
    expect(issues(s).join(' ')).toMatch(/too close together/);
    const o = clone(); o.axis.max = 6;
    expect(issues(o).join(' ')).toMatch(/run off/);
  });
  test('a lane with something that is not a species, a change that changes nothing, and too few changes', () => {
    const s = clone(); s.lanes[0].mix.Z = 1;
    expect(issues(s).join(' ')).toMatch(/"Z", which is not a species/);
    const c = clone(); c.changes[0] = { id: 'nothing', say: 'Nothing happens.' };
    expect(issues(c).join(' ')).toMatch(/changes nothing/);
    const f = clone(); f.changes = f.changes.slice(0, 1);
    expect(issues(f).join(' ')).toMatch(/two to six single changes/);
  });
  test('a result that shows nothing anywhere', () => {
    const s = clone(); s.detect = { rule: 'label', name: '32P' }; s.species.D.carries = ['32P']; s.species.S.carries = ['32P'];
    s.changes[0] = { id: 'dark', say: 'Everything goes dark.', set: { '*': { D: 0 } } };
    expect(issues(s).join(' ')).toMatch(/shows nothing in any lane|Lane "a" shows nothing/);
  });
  test('not an object, and the wrong skin', () => {
    expect(issues(null as unknown as PredictSpec)).toEqual(['The spec must be an object.']);
    const s = clone() as unknown as { skin: string }; s.skin = 'spiral';
    expect(issues(s as unknown as PredictSpec).join(' ')).toMatch(/"bands" or "trace"/);
  });
});
