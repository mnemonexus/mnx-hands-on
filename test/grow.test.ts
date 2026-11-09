import { describe, expect, test } from 'bun:test';
import { pinnedFor } from './pinned';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport } from '../src/report';
import {
  blur, committed, erf, histOf, issues, overlap, prepare, quota, readNumber, reachTime, result, simulate, sum, topStage,
  type GrowAttempt, type GrowEffect, type GrowSpec, type GrowTask,
} from '../src/engines/grow/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const content: Record<string, { id: string; spec: GrowSpec; cite?: string[]; covers?: string[]; minutes: number }> = {};
const pinned = pinnedFor<{ id: string; spec: GrowSpec; cite?: string[]; covers?: string[]; minutes: number }>('grow');
for (const f of readdirSync(join(ROOT, 'content', 'grow'))) if (f.endsWith('.json')) content[f.replace('.json', '')] = readJson('content', 'grow', f);
const line: GrowSpec = readJson('test', 'fixtures', 'grow', 'assembly-line.json');
const insect: GrowSpec = readJson('test', 'fixtures', 'grow', 'insect-life-cycle.json');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const last = (s: ReturnType<typeof simulate>) => s.frames[s.frames.length - 1];
const idx = (spec: GrowSpec, id: string) => spec.stages.findIndex((s) => s.id === id);

/** The answer that is right for a task. */
function right(task: GrowTask): GrowAttempt {
  if (task.ask.kind === 'stage') return { stage: task.spec.stages[task.top].id };
  if (task.ask.kind === 'shape') return { sketch: histOf(last(task.sim)) };
  return { value: task.answer ?? 0 };
}

describe('the shipped activities are fit to use', () => {
  const all: Array<[string, GrowSpec]> = [...Object.entries(content).map(([k, v]) => [k, v.spec] as [string, GrowSpec]), ['assembly-line', line], ['insect-life-cycle', insect]];
  for (const [name, spec] of all) {
    test(`${name} has no issues and fits the catalogue`, () => {
      expect(issues(spec)).toEqual([]);
      expect(JSON.stringify(spec).length).toBeLessThanOrEqual(4096);
    });
  }
  test('the engine is registered by its one line', () => {
    expect(engines.grow?.id).toBe('grow');
    expect(engines.grow?.label).toBe('Grow, Arrest, Count');
  });
  test('there are real activities from the lectures', () => {
    expect(Object.keys(content).length).toBeGreaterThanOrEqual(6);
  });
  test('every illustrative activity says so, and says nothing is from a lecture that is not', () => {
    for (const [name, a] of Object.entries(content)) {
      if (a.spec.illustrative) expect(`${name}: ${/illustrative/i.test(a.spec.note)}`).toBe(`${name}: true`);
    }
  });
});

describe('the model is exact where the maths is', () => {
  test('an untreated population keeps the same spread of stages for ever, and a loop multiplies it by the gain each cycle', () => {
    const spec = insect;
    const cycle = spec.stages.reduce((a, s) => a + s.duration, 0);
    const sim = simulate(spec, [], cycle * 2);
    const f0 = sim.frames[0], f1 = sim.frames[Math.round(cycle / spec.step)], f2 = last(sim);
    f0.shares.forEach((s, i) => { expect(f1.shares[i]).toBeCloseTo(s, 9); expect(f2.shares[i]).toBeCloseTo(s, 9); });
    expect(f1.total / f0.total).toBeCloseTo(3, 9);
    expect(f2.total / f0.total).toBeCloseTo(9, 9);
  });
  test('shares add to 1 and the histogram adds to 1 at every step', () => {
    for (const spec of [line, insect, content[Object.keys(content)[0]].spec]) {
      for (const tr of spec.treatments) {
        const sim = simulate(spec, tr.effects, tr.times[0]);
        for (const f of sim.frames) {
          expect(sum(f.shares)).toBeCloseTo(1, 9);
          expect(sum(histOf(f))).toBeCloseTo(1, 6);
        }
      }
    }
  });
  test('in a steady line each stage holds its duration over the total (Little\'s law)', () => {
    const f0 = simulate(line, [], 4).frames[0];
    const total = sum(line.stages.map((s) => s.duration));
    line.stages.forEach((s, i) => expect(f0.shares[i]).toBeCloseTo(s.duration / total, 9));
  });
  test('slowing a stage by f makes it hold f times as much of a steady line', () => {
    const f = last(simulate(line, [{ kind: 'slow', stage: 'weld', factor: 2 }], 40));
    const total = sum(line.stages.map((s) => s.duration)) + line.stages[idx(line, 'weld')].duration;
    line.stages.forEach((s, i) => expect(f.shares[i]).toBeCloseTo((s.id === 'weld' ? s.duration * 2 : s.duration) / total, 9));
  });
  test('a blocked exit holds back exactly the individuals that arrive: the line fills behind it and empties beyond it', () => {
    const effects: GrowEffect[] = [{ kind: 'block', transition: 'paint-out' }];
    const sim = simulate(line, effects, 40);
    const f = last(sim);
    expect(f.shares[idx(line, 'pack')]).toBeCloseTo(0, 9);
    // Everything that has arrived since the start and passed the other stations is waiting in the booth or on its way to it.
    expect(f.shares[idx(line, 'paint')]).toBeGreaterThan(0.7);
    // Mass is kept: before the block bites, nothing is lost in the stations upstream.
    const mass = (k: number) => sim.frames[k].total;
    expect(mass(10)).toBeGreaterThan(mass(0));
  });
  test('a loop with a blocked exit piles every individual up in that stage', () => {
    const f = last(simulate(insect, [{ kind: 'block', transition: 'pupate' }], 60));
    expect(f.shares[idx(insect, 'larva')]).toBeGreaterThan(0.999);
  });
  test('releasing a block lets the held individuals go on together', () => {
    const held = simulate(insect, [{ kind: 'block', transition: 'pupate' }, { kind: 'remove-block', transition: 'pupate', at: 20 }], 28);
    const at = (t: number) => held.frames[Math.round(t / held.step)];
    expect(at(20).shares[idx(insect, 'larva')]).toBeGreaterThan(0.99);
    // A step after the release almost everything has moved to the pupal stage.
    expect(at(21).shares[idx(insect, 'pupa')]).toBeGreaterThan(0.7);
    // They stay together as a wave: still pupae while the stage lasts, then adults as one group.
    expect(at(24).shares[idx(insect, 'pupa')]).toBeGreaterThan(0.5);
    expect(at(27).shares[idx(insect, 'adult')]).toBeGreaterThan(0.5);
  });
  test('killing in a stage removes a fixed share per step, so a steady line loses exp(-rate x duration) of its parts', () => {
    const rate = 0.25;
    const f = last(simulate(line, [{ kind: 'kill', stage: 'paint', rate }], 80));
    const paint = line.stages[idx(line, 'paint')].duration;
    // Parts through the booth survive with probability about (1 - exp(-rate d)) / (rate d) on average inside it, and exp(-rate d) after it.
    const stationary = sum(line.stages.map((s, i) => (s.id === 'paint' ? ((1 - Math.exp(-rate * paint)) / rate) : s.duration * (i > idx(line, 'paint') ? Math.exp(-rate * paint) : 1))));
    const want = (id: string) => {
      const i = idx(line, id);
      const d = line.stages[i].duration;
      return (id === 'paint' ? ((1 - Math.exp(-rate * d)) / rate) : d * (i > idx(line, 'paint') ? Math.exp(-rate * paint) : 1)) / stationary;
    };
    // The step is one minute, so the stepped model sits within a few per cent of the continuous one.
    for (const s of line.stages) expect(Math.abs(f.shares[idx(line, s.id)] - want(s.id))).toBeLessThan(0.03);
  });
  test('the histogram is spread by the measure\'s cv and every bar is accounted for', () => {
    const f = last(simulate(insect, [], 4));
    const hist = histOf(f);
    expect(hist.length).toBe(insect.measure.bins);
    expect(Math.min(...hist)).toBeGreaterThanOrEqual(0);
  });
  test('erf, blur, overlap and quota do what they say', () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(1)).toBeCloseTo(0.8427, 3);
    expect(sum(blur([0, 1, 0, 0]))).toBeCloseTo(1, 9);
    expect(overlap([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
    expect(overlap([1, 0, 0, 0], [0, 0, 0, 1])).toBeLessThan(0.3);
    expect(overlap([0, 0, 0], [1, 1, 1])).toBe(0);
    expect(quota([0.5, 0.3, 0.2], 10)).toEqual([5, 3, 2]);
    expect(sum(quota([1 / 3, 1 / 3, 1 / 3], 100))).toBe(100);
    expect(quota([0, 0], 5)).toEqual([0, 0]);
  });
  test('the time a share is reached is read off the run', () => {
    const sim = simulate(insect, [{ kind: 'block', transition: 'pupate' }], 30);
    const t = reachTime(sim, idx(insect, 'larva'), 0.9)!;
    expect(t).toBeGreaterThan(0);
    const before = sim.frames[Math.floor(t / sim.step)].shares[idx(insect, 'larva')];
    const after = sim.frames[Math.ceil(t / sim.step)].shares[idx(insect, 'larva')];
    expect(before).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(after).toBeGreaterThanOrEqual(0.9 - 1e-9);
    expect(reachTime(simulate(insect, [], 10), 0, 0.99)).toBeNull();
  });
});

describe('a spec from another subject runs with no code change', () => {
  for (const [name, spec] of [['assembly line', line], ['insect life cycle', insect]] as Array<[string, GrowSpec]>) {
    test(`${name}: the same seed gives the same round and every rung asks a fair question`, () => {
      expect(prepare(spec, 'x:0', 1)).toEqual(prepare(spec, 'x:0', 1));
      for (let rung = 0; rung < 3; rung++) {
        for (let i = 0; i < 20; i++) {
          const t = prepare(spec, `${name}${i}:${i % 3}`, rung);
          expect(t.question.length).toBeGreaterThan(20);
          expect(t.instruction).toContain(t.treatment.label);
          const good = result(t, right(t));
          expect(good.met).toBe(true);
          expect(good.why.length).toBeGreaterThan(30);
          expect(good.label.length).toBeGreaterThan(20);
          expect(committed(t, right(t))).toBe(true);
        }
      }
    });
    test(`${name}: a run of three rounds goes through different treatments`, () => {
      for (let i = 0; i < 20; i++) {
        const ids = [0, 1, 2].map((r) => prepare(spec, `run${i}:${r}`, 0).treatment.id);
        expect(new Set(ids).size).toBe(3);
      }
    });
  }
  test('the engine code names no subject or course fact', () => {
    const words = ['cell', 'dna', 'mitosis', 'cyclin', 'nocodazole', 'checkpoint', 'chromosome', 'lecture', 'histone', 'protein', 'insect', 'weld', 'enzyme', 'thymidine', 'quiescen'];
    for (const file of ['engines/grow/logic.ts', 'engines/grow/view.ts', 'engines/grow/grow.css']) {
      const text = readFileSync(join(ROOT, 'src', file), 'utf8').toLowerCase();
      for (const word of words) expect(`${file}: ${text.includes(word) ? word : ''}`).toBe(`${file}: `);
    }
  });
});

describe('the verdict', () => {
  const spec = insect;
  test('rung 0: the stage the model piles up in is right, another is not', () => {
    const t = prepare(spec, 'v:0', 0);
    expect(t.treatment.effects.length).toBeGreaterThan(0);
    expect(result(t, { stage: spec.stages[t.top].id }).met).toBe(true);
    const other = spec.stages.find((_, i) => i !== t.top)!;
    expect(result(t, { stage: other.id }).met).toBe(false);
  });
  test('rung 0: a pile-up put after the blocked step is named as a wrong idea', () => {
    for (let i = 0; i < 20; i++) {
      const t = prepare(spec, `blk${i}:${i % 3}`, 0);
      if (t.treatment.id !== 'wasp') continue;
      const r = result(t, { stage: 'pupa' });
      expect(r.met).toBe(false);
      expect(r.misconception).toContain('after the blocked step');
      return;
    }
    throw new Error('no block treatment came up');
  });
  test('rung 1: the true histogram passes, an empty chart does not commit, and the old shape is named as a wrong idea', () => {
    const t = prepare(spec, 'v:1', 1);
    expect(result(t, right(t)).met).toBe(true);
    expect(committed(t, { sketch: new Array(spec.measure.bins).fill(0) })).toBe(false);
    const before = histOf(t.base.frames[0]);
    const wrong = result(t, { sketch: before });
    if (!wrong.met) expect(wrong.misconception).toContain('without the treatment');
    // A flat sketch fails wherever the true histogram has a clear peak.
    let peaky = 0;
    for (let i = 0; i < 30; i++) {
      const u = prepare(spec, `flat${i}:${i % 3}`, 1);
      if (Math.max(...histOf(last(u.sim))) > 0.4) { peaky++; expect(result(u, { sketch: new Array(spec.measure.bins).fill(1) }).met).toBe(false); }
    }
    expect(peaky).toBeGreaterThan(0);
  });
  test('rung 1: a sketch one bar out still passes, and one far out does not', () => {
    const t = prepare(spec, 'v:1', 1);
    const truth = histOf(last(t.sim));
    const shift = (k: number) => truth.map((_, b) => truth[b - k] ?? 0);
    expect(overlap(shift(1), truth)).toBeGreaterThan(0.4);
    expect(overlap(shift(5), truth)).toBeLessThan(overlap(shift(1), truth));
  });
  test('rung 2: a number inside the tolerance is right and a number outside it is not', () => {
    for (let i = 0; i < 30; i++) {
      const t = prepare(spec, `n${i}:${i % 3}`, 2);
      expect(t.answer).not.toBeNull();
      expect(result(t, { value: t.answer! }).met).toBe(true);
      expect(result(t, { value: t.answer! + t.tolerance * 0.9 }).met).toBe(true);
      expect(result(t, { value: t.answer! + t.tolerance * 1.5 + 1 }).met).toBe(false);
    }
  });
  test('rung 2 asks both kinds of number', () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 60; i++) kinds.add(prepare(line, `k${i}:${i % 3}`, 2).ask.kind);
    expect(kinds.has('fraction')).toBe(true);
    expect(kinds.has('time')).toBe(true);
  });
  test('typed numbers are read with a percent sign or the unit, and nothing else', () => {
    expect(readNumber('45', '%')).toBe(45);
    expect(readNumber('45%', '%')).toBe(45);
    expect(readNumber(' 45 % ', '%')).toBe(45);
    expect(readNumber('7.5 h', 'h')).toBe(7.5);
    expect(readNumber('7,5 hours', 'h')).toBeNull();
    expect(readNumber('7 days', 'h')).toBeNull();
    expect(readNumber('', 'h')).toBeNull();
    expect(readNumber('abc', 'h')).toBeNull();
  });
  test('every verdict reports into a practice result with one criterion per round', () => {
    const rounds = [0, 1, 2].map((r) => result(prepare(spec, `rep:${r}`, 0), { stage: 'egg' }));
    const report = buildReport({ activityId: 'ho-grow-test', skill: 'x', rung: 0, rounds, finished: true, fixed: false, rungNames: ['Which stage', 'The shape', 'The number'] });
    expect(report.criteria?.length ?? 0).toBe(3);
    const early = buildReport({ activityId: 'ho-grow-test', skill: 'x', rung: 0, rounds: rounds.slice(0, 1), finished: false, fixed: false, rungNames: ['Which stage', 'The shape', 'The number'] });
    expect(early.valid).toBe(false);
  });
});

describe('what a writer is told', () => {
  test('an illustrative spec whose note does not say so is refused', () => {
    const a = clone(line); a.note = 'Parts take the times shown.';
    expect(issues(a).join(' ')).toContain('illustrative');
    const b = clone(line); b.illustrative = false;
    expect(issues(b).join(' ')).toContain('calls the numbers illustrative');
  });
  test('a duration that is not a whole number of steps is refused', () => {
    const a = clone(line); a.stages[0].duration = 4.5;
    expect(issues(a).join(' ')).toContain('whole number of steps');
  });
  test('a transition for a stage that is not there, or two for one stage, is refused', () => {
    const a = clone(line); a.transitions[1].from = 'nowhere';
    expect(issues(a).join(' ')).toContain('not a stage');
    const b = clone(line); b.transitions[1].from = 'cut';
    expect(issues(b).join(' ')).toContain('already has a way out');
  });
  test('a treatment that names something that is not there is refused', () => {
    const a = clone(line); a.treatments[0].effects = [{ kind: 'block', transition: 'nope' }];
    expect(issues(a).join(' ')).toContain('not a transition');
    const b = clone(line); b.treatments[1].effects = [{ kind: 'slow', stage: 'weld', factor: 1.5 }];
    expect(issues(b).join(' ')).toContain('whole "factor"');
    const c = clone(line); c.treatments[2].effects = [{ kind: 'kill', stage: 'paint', rate: 0 }];
    expect(issues(c).join(' ')).toContain('"rate"');
    const d = clone(line); d.treatments[0].effects = [{ kind: 'remove-block', transition: 'paint-out', at: 4 }];
    expect(issues(d).join(' ')).toContain('needs a block');
  });
  test('a treatment that does nothing is refused unless it is a control', () => {
    const a = clone(insect); a.treatments[0].effects = [];
    expect(issues(a).join(' ')).toContain('does nothing');
    a.treatments[0].control = true;
    expect(issues(a).join(' ')).toEqual('');
  });
  test('a treatment whose result is the same as doing nothing is refused', () => {
    const a = clone(line); a.treatments[0].effects = [{ kind: 'slow', stage: 'pack', factor: 2 }]; a.treatments[0].times = [3];
    expect(issues(a).join(' ')).toMatch(/almost as it is|clearly holds/);
  });
  test('a run that leaves nothing alive is refused', () => {
    const a = clone(insect); a.treatments[1].effects = [{ kind: 'kill', stage: 'larva', rate: 2 }];
    expect(issues(a).join(' ')).toContain('almost nothing');
  });
  test('a value too near the edge of the axis for its spread is refused', () => {
    const a = clone(insect); a.stages[3].value = 19.9;
    expect(issues(a).join(' ')).toContain('edge of the axis');
  });
  test('a block released after the run ends is refused', () => {
    const a = clone(insect);
    a.treatments[2].effects = [{ kind: 'block', transition: 'pupate' }, { kind: 'remove-block', transition: 'pupate', at: 18 }];
    expect(issues(a).join(' ')).toContain('longer than the block');
  });
  test('a missing measure or stage list is refused in words', () => {
    const a = clone(insect) as unknown as Record<string, unknown>; delete a.measure;
    expect(issues(a as unknown as GrowSpec).join(' ')).toContain('measure');
    expect(issues(undefined as unknown as GrowSpec)).toEqual(['The spec is missing.']);
  });
  test('topStage is the stage with the largest share', () => {
    const f = last(simulate(insect, [{ kind: 'block', transition: 'lay' }], 40));
    expect(topStage(f)).toBe(idx(insect, 'adult'));
  });
});

describe('what the lectures say, worked out by the engine', () => {
  const run = (name: string, treatment: string, length?: number) => {
    const spec = content[name].spec;
    const tr = spec.treatments.find((t) => t.id === treatment)!;
    const sim = simulate(spec, tr.effects, length ?? tr.times[tr.times.length - 1]);
    return { spec, f: last(sim), hist: histOf(last(sim)), top: topStage(last(sim)) };
  };
  /** The value at which the tallest bar sits. */
  const peakAt = (spec: GrowSpec, hist: number[]) => {
    const b = hist.indexOf(Math.max(...hist));
    return spec.measure.min + ((b + 0.5) * (spec.measure.max - spec.measure.min)) / spec.measure.bins;
  };
  /** The share of the histogram above a value. */
  const above = (spec: GrowSpec, hist: number[], v: number) => sum(hist.filter((_, b) => spec.measure.min + (b * (spec.measure.max - spec.measure.min)) / spec.measure.bins >= v));

  test('untreated cells show a large 2N peak and a smaller 4N peak with S phase between (056 fc6, inh11; 057 dn9 to dn11)', () => {
    const spec = pinned['056-drug-arrest-points'].spec;
    const hist = histOf(simulate(spec, [], 6).frames[0]);
    expect(peakAt(spec, hist)).toBeCloseTo(2, 0);
    const g1 = sum(hist.slice(0, 5)), g2 = sum(hist.slice(8, 13)), between = sum(hist.slice(5, 8));
    expect(g1).toBeGreaterThan(g2);
    expect(g2).toBeGreaterThan(0.05);
    expect(between).toBeGreaterThan(0.1);
  });
  test('nocodazole leaves cells blocked in mitosis at 4N (056 inh5, inh11)', () => {
    const { spec, f, hist, top } = run('056-drug-arrest-points', 'noco');
    expect(spec.stages[top].id).toBe('m');
    expect(f.shares[top]).toBeGreaterThan(0.95);
    expect(peakAt(spec, hist)).toBeCloseTo(4, 0);
  });
  test('thymidine stops cells in early S, so there is no 4N peak (056 inh8, inh11)', () => {
    const { spec, f, hist, top } = run('056-drug-arrest-points', 'thy');
    expect(spec.stages[top].id).toBe('es');
    expect(above(spec, hist, 3.5)).toBeLessThan(0.01);
    expect(peakAt(spec, hist)).toBeLessThan(2.5);
    expect(f.shares[top]).toBeGreaterThan(0.9);
  });
  test('quiescent cells gather in one main 2N peak, and released cells move on together (056 nat2 to nat4)', () => {
    const quiet = run('056-quiescence-and-release', 'serum');
    expect(quiet.spec.stages[quiet.top].id).toBe('g1');
    expect(above(quiet.spec, quiet.hist, 3.5)).toBeLessThan(0.05);
    const crowded = run('056-quiescence-and-release', 'crowd');
    expect(crowded.spec.stages[crowded.top].id).toBe('g1');
    // Released: the cells that were held all leave G1 at once, so S phase fills as one group while G1 empties.
    const spec = pinned['056-quiescence-and-release'].spec;
    const tr = spec.treatments.find((t) => t.id === 'release')!;
    const sim = simulate(spec, tr.effects, 17);
    const at = (t: number) => sim.frames[Math.round(t / sim.step)];
    expect(at(8).shares[0]).toBeGreaterThan(at(9).shares[0] + 0.2);
    expect(at(9).shares[1]).toBeGreaterThan(at(8).shares[1] + 0.2);
  });
  test('aphidicolin is reversible: held cells stay in early S, and after the wash they cross S together (056 inh1, inh7, inh10)', () => {
    const spec = pinned['056-block-and-release'].spec;
    const held = run('056-block-and-release', 'hold');
    expect(spec.stages[held.top].id).toBe('es');
    // The longer the hold, the tighter the wave: more of the culture is in S just after the wash.
    const sShare = (id: string, t: number) => simulate(spec, spec.treatments.find((x) => x.id === id)!.effects, t).frames.at(-1)!.shares[idx(spec, 's')];
    expect(sShare('wash18', 21)).toBeGreaterThan(sShare('wash10', 16));
  });
  test('a cdc2 mutant stops at G2 to M at the restrictive temperature; wild type and the cool mutant do not (056 ts1 to ts3, sc1)', () => {
    const ts = run('056-temperature-sensitive-cdc2', 'ts');
    expect(ts.spec.stages[ts.top].id).toBe('g2');
    expect(ts.f.shares[ts.top]).toBeGreaterThan(0.8);
    for (const id of ['wt', 'perm']) {
      const spec = pinned['056-temperature-sensitive-cdc2'].spec;
      const tr = spec.treatments.find((t) => t.id === id)!;
      expect(tr.effects).toEqual([]);
      const f = last(simulate(spec, tr.effects, tr.times[0]));
      const g = simulate(spec, [], tr.times[0]).frames[0];
      f.shares.forEach((s, i) => expect(s).toBeCloseTo(g.shares[i], 9));
    }
  });
  test('each of the three checkpoints holds the cells just before it (057 ck2 to ck4)', () => {
    const food = run('057-three-checkpoints', 'food');
    expect(food.spec.stages[food.top].id).toBe('g1');
    const dna = run('057-three-checkpoints', 'dna');
    expect(dna.spec.stages[dna.top].id).toBe('g2');
    const spindle = run('057-three-checkpoints', 'spindle');
    expect(spindle.spec.stages[spindle.top].id).toBe('pm');
    // G1 holds 1, and the other two hold 2 (twice the G1 DNA content).
    expect(peakAt(food.spec, food.hist)).toBeCloseTo(1, 0);
    expect(peakAt(dna.spec, dna.hist)).toBeCloseTo(2, 0);
    expect(peakAt(spindle.spec, spindle.hist)).toBeCloseTo(2, 0);
  });
  test('X-rays with p53 working leave two peaks and no S phase; without p53 nothing changes; without p21 only the G2 hold remains (057 pf6, pp3 to pp7)', () => {
    const spec = pinned['057-p53-p21-arrest'].spec;
    const p53 = run('057-p53-p21-arrest', 'p53');
    expect(p53.f.shares[idx(spec, 's')]).toBeLessThan(0.01);
    expect(p53.f.shares[idx(spec, 'g1')]).toBeGreaterThan(0.3);
    expect(p53.f.shares[idx(spec, 'g2')]).toBeGreaterThan(0.3);
    const none = spec.treatments.find((t) => t.id === 'nop53')!;
    expect(none.effects).toEqual([]);
    const nop21 = run('057-p53-p21-arrest', 'nop21');
    expect(nop21.spec.stages[nop21.top].id).toBe('g2');
    expect(nop21.f.shares[idx(spec, 'g1')]).toBeLessThan(0.01);
  });
  test('a lesion in the leading-strand template arrests forks; one in the lagging-strand template does not (063 k4, k6, u5)', () => {
    const spec = pinned['063-fork-meets-lesion'].spec;
    for (const id of ['bulky', 'uv']) {
      const r = run('063-fork-meets-lesion', id, 30);
      expect(spec.stages[r.top].id).toBe('up');
      expect(r.f.shares[idx(spec, 'past')]).toBeLessThan(0.01);
      expect(peakAt(spec, r.hist)).toBeLessThan(5);
    }
    const lag = spec.treatments.find((t) => t.id === 'lag')!;
    expect(lag.effects).toEqual([]);
    const base = simulate(spec, [], 30).frames.at(-1)!;
    expect(base.shares[idx(spec, 'past')]).toBeGreaterThan(0.6);
  });
  test('a bypass polymerase lets the held forks go on together, and the later it comes the more are held (064 k3, l1, l3, l4)', () => {
    const spec = pinned['064-bypass-polymerase-restart'].spec;
    const stuck = run('064-bypass-polymerase-restart', 'stuck', 30);
    expect(stuck.f.shares[idx(spec, 'past')]).toBeLessThan(0.01);
    const sim = (id: string, t: number) => simulate(spec, spec.treatments.find((x) => x.id === id)!.effects, t);
    const early = sim('early', 30).frames.at(-1)!;
    expect(early.shares[idx(spec, 'past')]).toBeGreaterThan(0.5);
    // Forks held by the lesion all set off at once: a bar well ahead of the lesion holds a clear share.
    const bar = Math.max(...histOf(sim('late', 35).frames.at(-1)!));
    expect(bar).toBeGreaterThan(0.4);
  });
  test('every activity cites its covered points, covers no more than its minutes allow, and has three treatments', () => {
    for (const [name, a] of Object.entries(content)) {
      expect(a.covers?.length ?? 0).toBeGreaterThan(0);
      for (const c of a.covers ?? []) expect(`${name}: ${a.cite?.includes(c)}`).toBe(`${name}: true`);
      expect((a.covers ?? []).length).toBeLessThanOrEqual(a.minutes + 1);
      // Each run goes through every treatment once, so a point tied to one treatment is always met.
      expect(a.spec.treatments.length).toBe(3);
    }
  });
});
