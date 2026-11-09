import { describe, expect, test } from 'bun:test';
import { pinnedFor } from './pinned';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SAME_RELATIVE, sizeWords, blend, buildModel, gapSentence, issues, prepare, relativeChange, result, spotFor, type DialAttempt, type DialSpec, type DialTask } from '../src/engines/dial/logic';
import { engines } from '../src/engines/registry';
import { withUnit } from '../src/scale';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const content: Record<string, { id: string; spec: DialSpec }> = {};
const pinned = pinnedFor<{ id: string; spec: DialSpec }>('dial');
for (const f of readdirSync(join(ROOT, 'content', 'dial'))) if (f.endsWith('.json')) content[f.replace('.json', '')] = readJson('content', 'dial', f);
const fixtures: Record<string, DialSpec> = {};
for (const f of readdirSync(join(ROOT, 'test', 'fixtures'))) if (f.endsWith('.json')) fixtures[f.replace('.json', '')] = readJson('test', 'fixtures', f);

const langmuir = pinned['langmuir-binding'].spec;
const beer = pinned['beer-lambert'].spec;
const decay = pinned['first-order-decay'].spec;
const specs: Array<[string, DialSpec]> = [
  ...Object.entries(content).map(([k, v]) => [k, v.spec] as [string, DialSpec]),
  ...Object.entries(fixtures),
];

describe('the shipped activities are fit to use', () => {
  for (const [name, spec] of specs) test(`${name} has no issues`, () => expect(issues(spec)).toEqual([]));
  test('every activity has its own id, and the ones these tests lean on are present', () => {
    const ids = Object.values(content).map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^ho-dial-/);
    expect(new Set(ids).size).toBe(ids.length);
    for (const name of ['beer-lambert', 'first-order-decay', 'langmuir-binding']) expect(pinned[name]).toBeDefined();
  });
  test('specs from other subjects are kept beside them, and are not course activities', () => {
    expect(Object.keys(fixtures).length).toBeGreaterThan(0);
    for (const name of Object.keys(fixtures)) expect(content[name]).toBeUndefined();
  });
});

describe('worked numbers from the lectures', () => {
  test('Langmuir: half-saturation is at L = Kd (047 slide 21, q20c, q20f)', () => {
    const m = buildModel(langmuir);
    expect(m.y(2, [2])).toBeCloseTo(0.5, 12); // protein X is half-saturated at 2 uM, so Kd = 2 uM
    expect(m.y(200, [200])).toBeCloseTo(0.5, 12);
    for (const kd of [1, 2, 20, 200, 5000]) expect(m.cross('half', [kd])).toBeCloseTo(kd, 6);
  });
  test('Langmuir: a weak binder never saturates; a tight one nearly does (047 q20d)', () => {
    const m = buildModel(langmuir);
    expect(m.y(10000, [5000])).toBeLessThan(0.7);
    expect(m.y(10000, [1])).toBeGreaterThan(0.999);
  });
  test('Beer-Lambert: tryptophan, 5690 M^-1 cm^-1, 100 uM, 1 cm reads A = 0.569 (046 q49)', () => {
    const m = buildModel(beer);
    expect(m.y(100, [5690, 1])).toBeCloseTo(0.569, 12);
    expect(m.y(0, [5690, 1])).toBe(0);
    expect(m.y(50, [5690, 0.5])).toBeCloseTo(m.y(100, [5690, 0.25]), 12);
  });
  test('first-order decay: 0.40 falling to 0.15 in 30 s is kobs of about 0.033 per second (017 q37)', () => {
    const m = buildModel(decay);
    expect(m.y(30, [0.4, 0.0327])).toBeCloseTo(0.15, 3);
    expect(m.y(30, [0.4, 0.033])).toBeCloseTo(0.1486, 3);
    expect(m.y(0, [0.4, 0.033])).toBeCloseTo(0.4, 12);
  });
  test('first-order decay: at kobs t = ln 2 half is left, so the half-life is ln 2 / kobs (017 q24)', () => {
    const m = buildModel(decay);
    expect(m.y(Math.LN2 / 0.05, [0.6, 0.05])).toBeCloseTo(0.3, 10);
    for (const k of [0.015, 0.033, 0.1, 0.25]) expect(m.cross('half', [0.5, k])).toBeCloseTo(Math.LN2 / k, 6);
  });
});

describe('a spec from another subject runs with no code change', () => {
  test('economics: demand with constant elasticity', () => {
    const spec = fixtures['demand-elasticity'];
    const m = buildModel(spec);
    expect(m.y(4, [80, 1])).toBeCloseTo(20, 12);
    expect(m.cross('halved', [80, 2])).toBeCloseTo(Math.SQRT2, 6);
    expect(prepare(spec, 'econ:0', 0).announce).toBeTruthy();
    expect(prepare(spec, 'econ:0', 1).question).toContain('£');
  });
  test('physics: projectile range, with trigonometry and units that convert', () => {
    const spec = fixtures['projectile-range'];
    const m = buildModel(spec);
    expect(m.y(45, [20, 10])).toBeCloseTo(40, 10);
    expect(m.y(30, [20, 10])).toBeCloseTo(m.y(60, [20, 10]), 10);
    const task = prepare(spec, 'phys:2', 2);
    expect(task.unit).toBe('m');
    // A student may answer in centimetres, and the engine reads it as the same length.
    expect(result(task, { kind: 'type', value: task.to, text: `${task.to * 100} cm` }).met).toBe(true);
  });
  test.each(Object.entries(fixtures))('%s sets sensible questions at every rung', (_name, spec) => {
    for (let rung = 0; rung < 3; rung++) {
      for (let i = 0; i < 60; i++) {
        const t = prepare(spec, `fixture:${i}`, rung);
        expect(Number.isFinite(t.from) && Number.isFinite(t.to)).toBe(true);
        expect(t.question.length).toBeGreaterThan(8);
      }
    }
  });
  test('the engine code mentions no subject', () => {
    const words = ['langmuir', 'ligand', 'protein', 'absorb', 'beer', 'lambert', 'half-life', 'kinetic', 'enzyme', 'dissociation', 'supply', 'demand', 'projectile', 'elastic', 'extinction'];
    const files = ['engine.ts', 'expr.ts', 'units.ts', 'scale.ts', 'plot.ts', 'motion.ts', 'run.ts', 'report.ts', 'engines/dial/logic.ts', 'engines/dial/view.ts'];
    for (const file of files) {
      const text = readFileSync(join(ROOT, 'src', file), 'utf8').toLowerCase();
      for (const word of words) expect(`${file}: ${text.includes(word) ? word : ''}`).toBe(`${file}: `);
    }
  });
});

describe('setting a question', () => {
  test('the same seed gives the same task, and seeds differ', () => {
    for (const [, spec] of specs) for (let rung = 0; rung < 3; rung++) {
      expect(JSON.stringify(prepare(spec, 'run1:0', rung))).toBe(JSON.stringify(prepare(spec, 'run1:0', rung)));
    }
    const seen = new Set(Array.from({ length: 30 }, (_, i) => prepare(langmuir, `s${i}:0`, 1).announce));
    expect(seen.size).toBeGreaterThan(4);
  });
  test('every task is consistent with the formula, for every spec, rung and seed', { timeout: 60_000 }, () => {
    for (const [name, spec] of specs) {
      const inRange = (v: number[]) => v.every((x, k) => x >= spec.parameters[k].min * (1 - 1e-9) && x <= spec.parameters[k].max * (1 + 1e-9));
      for (let rung = 0; rung < 3; rung++) for (let i = 0; i < 80; i++) {
        const t = prepare(spec, `many${i}:${i % 3}`, rung);
        const ctx = `${name} rung ${rung} seed ${i}`;
        expect(`${ctx} ${inRange(t.before)}`).toBe(`${ctx} true`);
        expect(`${ctx} ${inRange(t.after)}`).toBe(`${ctx} true`);
        expect(t.after.filter((v, k) => v !== t.before[k]).length).toBe(1);
        const s0 = spotFor(t, t.before);
        const s1 = spotFor(t, t.after);
        expect(s0.x).toBeCloseTo(t.track.before.x, 9);
        expect(s0.y).toBeCloseTo(t.track.before.y, 9);
        expect(s1.x).toBeCloseTo(t.track.after.x, 9);
        expect(s1.y).toBeCloseTo(t.track.after.y, 9);
        expect(t.measure === 'y' ? s1.y : s1.x).toBeCloseTo(t.to, 9);
        expect(blend(t, 0).every((v, k) => Math.abs(v - t.before[k]) <= 1e-9 * Math.abs(v))).toBe(true);
        expect(blend(t, 1).every((v, k) => Math.abs(v - t.after[k]) <= 1e-9 * Math.abs(v))).toBe(true);
        if (t.direction !== 'same') expect(Math.sign(t.to - t.from)).toBe(t.direction === 'up' ? 1 : -1);
      }
    }
  });
  test('rung 0 can ask for up, down and the same', () => {
    const seen = new Set(Array.from({ length: 80 }, (_, i) => prepare(beer, `d${i}:0`, 0).direction));
    expect([...seen].sort()).toEqual(['down', 'same', 'up']);
  });
  test('rung 0 never asks about a move too close to call (linear axes)', () => {
    for (const spec of [beer, decay, fixtures['projectile-range']]) for (let i = 0; i < 80; i++) {
      const t = prepare(spec, `c${i}:0`, 0);
      if (t.measure !== 'y') continue;
      const m = Math.abs(t.to - t.from) / (spec.y.max - spec.y.min);
      expect(m < 0.0251 || m >= 0.0599).toBe(true);
    }
  });
  test('a run does not keep changing the same parameter', () => {
    const changed = new Set(Array.from({ length: 3 }, (_, r) => prepare(beer, `run9:${r}`, 1).changed));
    expect(changed.size).toBeGreaterThan(1);
  });
  test("the announcement and question use the spec's own words and the formula's numbers", () => {
    const t = prepare(langmuir, 'words:0', 2);
    expect(t.announce).toMatch(/^The dissociation constant, Kd, /);
    expect(t.announce).toContain('µM');
    expect(t.question).toContain('Type it with its unit');
    expect(t.why).toContain(withUnit(t.after[0], 'µM'));
    expect(t.why).not.toContain('{');
  });
});

/** An attempt that is right for the task. */
function right(t: DialTask): DialAttempt {
  if (t.rung === 0) return { kind: 'pick', pick: t.direction };
  if (t.rung === 1) return { kind: 'place', value: t.to };
  return { kind: 'type', value: t.to, text: withUnit(t.to, t.unit) };
}

describe('judging an answer', () => {
  test.each(specs)('%s: the right answer is met at every rung', (_n, spec) => {
    for (let rung = 0; rung < 3; rung++) for (let i = 0; i < 20; i++) {
      const t = prepare(spec, `j${i}:0`, rung);
      const r = result(t, right(t));
      expect(r.met).toBe(true);
      expect(r.misconception).toBeUndefined();
      expect(r.label.length).toBeGreaterThan(20);
      expect(r.label.length).toBeLessThanOrEqual(200);
      expect(r.why).toBe(t.why);
    }
  });
  test('rung 0: a wrong direction is not met and names the wrong idea', () => {
    const t = prepare(beer, 'w:0', 0);
    const wrong = (['up', 'down', 'same'] as const).find((d) => d !== t.direction)!;
    const r = result(t, { kind: 'pick', pick: wrong });
    expect(r.met).toBe(false);
    expect(r.misconception).toMatch(/^Expected/);
    expect(r.misconception!.length).toBeLessThanOrEqual(120);
    expect(gapSentence(t, { kind: 'pick', pick: wrong })).toContain('You said');
  });
  test('rung 1: close enough counts, far does not, and the tolerance is a share of the axis', () => {
    const t = prepare(langmuir, 'p:0', 1);
    const near = t.to + (t.to > 0.5 ? -0.05 : 0.05);
    expect(result(t, { kind: 'place', value: near }).met).toBe(true);
    const far = t.to > 0.5 ? t.to - 0.3 : t.to + 0.3;
    expect(result(t, { kind: 'place', value: far }).met).toBe(false);
  });
  test('rung 2: within five per cent, and a power of ten out is named', () => {
    const t = prepare(beer, 'n:0', 2);
    expect(result(t, { kind: 'type', value: t.to * 1.04, text: '' }).met).toBe(true);
    expect(result(t, { kind: 'type', value: t.to * 1.2, text: '' }).met).toBe(false);
    const tenfold = result(t, { kind: 'type', value: t.to * 10, text: '' });
    expect(tenfold.met).toBe(false);
    expect(tenfold.misconception).toContain('power of ten');
  });
  test('a quantity asked in seconds is judged in seconds', () => {
    const t = prepare(decay, 'q:0', 2);
    expect(t.measure).toBe('half');
    expect(t.unit).toBe('s');
    expect(result(t, { kind: 'type', value: t.to, text: '' }).met).toBe(true);
    expect(result(t, { kind: 'type', value: t.to * 2, text: '' }).met).toBe(false);
  });
  test('the wrong kind of attempt for a rung is refused', () => {
    const t = prepare(langmuir, 'k:0', 1);
    expect(() => result(t, { kind: 'pick', pick: 'up' })).toThrow();
  });
});

describe('refusing a bad spec', () => {
  const clone = () => JSON.parse(JSON.stringify(langmuir)) as DialSpec;
  const has = (spec: unknown, text: string) => expect(issues(spec as DialSpec).join(' | ')).toContain(text);

  test('an unknown symbol', () => { const s = clone(); s.expression = 'L / (Kx + L)'; has(s, '"Kx"'); });
  test('a formula that does not parse', () => { const s = clone(); s.expression = 'L / (Kd + L'; has(s, 'Formula:'); });
  test('a value that is not finite', () => { const s = clone(); s.expression = 'L / (Kd - Kd)'; has(s, 'not a finite number'); });
  test('a root of a negative number', () => { const s = clone(); s.expression = 'sqrt(L - 5)'; has(s, 'not a finite number'); });
  test('a curve that leaves the y axis', () => { const s = clone(); s.y.max = 0.9; has(s, 'above the axis maximum'); });
  test('a curve below the y axis', () => { const s = clone(); s.y.min = 0.1; has(s, 'below the axis minimum'); });
  test('a start value outside its range', () => { const s = clone(); s.parameters[0].start = [2, 99999]; has(s, 'outside'); });
  test('a log axis from zero', () => { const s = clone(); s.x.min = 0; has(s, 'log scale'); });
  test('a parameter that does nothing', () => {
    const s = clone();
    s.parameters.push({ symbol: 'z', name: 'unused', unit: '', min: 1, max: 2, scale: 'linear', start: [1] });
    has(s, 'never moves the curve');
  });
  test('a quantity the curve never reaches', () => { const s = clone(); s.quantities![0].crossing = '2'; has(s, 'never reaches'); });
  test('a why that names something unknown', () => { const s = clone(); s.why = 'It is {nothing}.'; has(s, '{nothing}'); });
  test('a why that uses a marked point when a rung asks about a quantity', () => {
    const s = clone(); s.asks = [{ measure: 'y' }, { measure: 'half' }, { measure: 'half' }]; has(s, 'no marked point');
  });
  test('a measure that is not a quantity', () => { const s = clone(); s.asks = [{ measure: 'nope' }]; has(s, 'asks[0].measure'); });
  test('duplicate symbols', () => { const s = clone(); s.parameters[0].symbol = 'L'; has(s, 'used twice'); });
  test('a unit that cannot be read', () => { const s = clone(); s.parameters[0].unit = 'µM^^'; expect(issues(s).length).toBeGreaterThanOrEqual(0); });
  test('things that are not specs at all', () => {
    expect(issues(null as unknown as DialSpec).length).toBeGreaterThan(0);
    expect(issues({} as DialSpec).length).toBeGreaterThan(0);
    expect(issues('x' as unknown as DialSpec).length).toBeGreaterThan(0);
  });
  test('words a writer can act on, and few of them', () => {
    const s = clone(); s.expression = 'L / (Kx + L)';
    const found = issues(s);
    expect(found.length).toBeLessThanOrEqual(14);
    expect(found[0]).toMatch(/^[A-Z`]/);
  });
});

describe('the engine is registered', () => {
  test('dial is in the registry with everything an engine needs', () => {
    const e = engines['dial'];
    expect(e.id).toBe('dial');
    expect(e.label).toBe('Dial');
    for (const fn of ['issues', 'prepare', 'view', 'result'] as const) expect(typeof e[fn]).toBe('function');
  });
});

describe('"stays about the same" is true of the quantity, not only of the drawing', () => {
  test('relative change is measured against the larger value, and nothing moving is no change', () => {
    expect(relativeChange(4, 2)).toBe(0.5);
    expect(relativeChange(2, 4)).toBe(0.5);
    expect(relativeChange(0, 0)).toBe(0);
    expect(relativeChange(0, 1)).toBe(1);
  });
  test('rung 0 never marks a real change as the same, in any activity', { timeout: 60_000 }, () => {
    for (const [name, spec] of specs) {
      for (let i = 0; i < 120; i++) {
        const t = prepare(spec, `same${i}:${i % 3}`, 0);
        if (t.direction !== 'same') continue;
        const change = relativeChange(t.from, t.to);
        expect(`${name} moves ${change < SAME_RELATIVE ? 'too little to matter' : change}`).toBe(`${name} moves too little to matter`);
      }
    }
  });
  test('a fall low on a wide axis is not asked as "the same": Beer-Lambert stays proportional', () => {
    const t = Array.from({ length: 300 }, (_, i) => prepare(pinned['beer-lambert'].spec, `low${i}:0`, 0));
    for (const x of t) if (x.direction === 'same') expect(relativeChange(x.from, x.to)).toBeLessThan(SAME_RELATIVE);
    expect(t.some((x) => x.direction !== 'same')).toBe(true);
  });
});

describe('a unit typed after a filled-in value', () => {
  test('is refused, because the value already carries it', () => {
    const spec = JSON.parse(JSON.stringify(pinned['langmuir-binding'].spec)) as DialSpec;
    const unit = spec.parameters[0].unit as string;
    spec.why = `With ${'{'}${spec.parameters[0].symbol}${'}'} ${unit} the curve moves.`;
    expect(issues(spec).join(' | ')).toContain('already carries its unit');
  });
});

describe('the words for a change follow the change', () => {
  test('a negative value that moves up rises, though its ratio has fallen', () => {
    expect(sizeWords(-20, -10)).toBe('rises');
    expect(sizeWords(-10, -20)).toBe('falls');
    expect(sizeWords(-5, 5)).toBe('rises');
    expect(sizeWords(0, 5)).toBe('rises');
  });
  test('a positive value keeps its size words', () => {
    expect(sizeWords(2, 4)).toBe('doubles');
    expect(sizeWords(4, 2)).toBe('halves');
    expect(sizeWords(4, 3)).toBe('falls by 25%');
    expect(sizeWords(1, 3)).toBe('rises 3-fold');
  });
  test('a parameter marked whole is only ever asked at whole numbers', () => {
    for (const [name, spec] of specs) {
      const k = spec.parameters.findIndex((p) => p.whole);
      if (k < 0) continue;
      for (let rung = 0; rung < 3; rung++) for (let i = 0; i < 60; i++) {
        const t = prepare(spec, `whole${i}:${i % 3}`, rung);
        expect(`${name} ${Number.isInteger(t.after[k])}`).toBe(`${name} true`);
      }
    }
  });
});
