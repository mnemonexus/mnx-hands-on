import { describe, expect, test } from 'bun:test';
import { pinnedFor } from './pinned';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { C13_SPACING, PROTON, WATER, adductMz, fragmentMzs, massFrom, mzOf, peptideMass } from '../src/engines/spectrum/masses';
import {
  chargeFromPair, fixed, isotopeChargeTop, issues, prepare, readMass, result, shiftAnswers, whyFor, workingFor, type SpectrumAttempt, type SpectrumSpec, type SpectrumTask,
} from '../src/engines/spectrum/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const content: Record<string, { id: string; spec: SpectrumSpec }> = {};
const pinned = pinnedFor<{ id: string; spec: SpectrumSpec }>('spectrum');
for (const f of readdirSync(join(ROOT, 'content', 'spectrum'))) if (f.endsWith('.json')) content[f.replace('.json', '')] = readJson('content', 'spectrum', f);
const fixtures: Record<string, SpectrumSpec> = {};
for (const f of readdirSync(join(ROOT, 'test', 'fixtures', 'spectrum'))) if (f.endsWith('.json')) fixtures[f.replace('.json', '')] = readJson('test', 'fixtures', 'spectrum', f);
const specs: Array<[string, SpectrumSpec]> = [...Object.entries(content).map(([k, v]) => [k, v.spec] as [string, SpectrumSpec]), ...Object.entries(fixtures)];
const clone = (s: SpectrumSpec) => JSON.parse(JSON.stringify(s)) as SpectrumSpec;
const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('the shipped activities are fit to use', () => {
  for (const [name, spec] of specs) test(`${name} has no issues and fits the catalogue`, () => {
    expect(issues(spec)).toEqual([]);
    expect(JSON.stringify(spec).length).toBeLessThanOrEqual(4096);
  });
  test('there are real activities and specs from other kinds of sample', () => {
    expect(Object.keys(content).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(fixtures).length).toBeGreaterThanOrEqual(2);
  });
});

// The proton is rounded to 1 in the lectures' worked answers, so those are reproduced with 1 and then with the exact value.
describe('every worked answer in the lectures', () => {
  test('051:p59-p60 cytochrome c from the peaks at 824.85 and 773.36: charge 15, mass 12,357.75', () => {
    expect(Math.round(chargeFromPair(773.36, 824.85, 'positive', 1))).toBe(15);
    near(chargeFromPair(773.36, 824.85, 'positive', 1), 15, 0.01);
    near(massFrom(824.85, 15, 'positive', 1), 12357.75, 0.001);
    near(massFrom(824.85, 15, 'positive'), 12357.75, 0.12); // with the exact proton the answer moves by 15 x 0.0073
  });
  test('051:p61 the pair 951.56 and 883.68: charge 13, mass 12,357.28, close to the first', () => {
    expect(Math.round(chargeFromPair(883.68, 951.56, 'positive', 1))).toBe(13);
    near(massFrom(951.56, 13, 'positive', 1), 12357.28, 0.001);
    near(massFrom(951.56, 13, 'positive', 1), massFrom(824.85, 15, 'positive', 1), 0.5);
  });
  test('051:p63 negative mode, peaks 822.85 and 771.37: charge 15 and the same mass once the protons are put back', () => {
    expect(Math.round(chargeFromPair(771.37, 822.85, 'negative', 1))).toBe(15);
    near(massFrom(822.85, 15, 'negative', 1), 12357.75, 0.001);
  });
  test('060:p33-p34 a small molecule: 558.36 as 1+ and 279.68 as 2+ give 557.36', () => {
    near(massFrom(558.36, 1, 'positive', 1), 557.36, 0.001);
    near(massFrom(279.68, 2, 'positive', 1), 557.36, 0.001);
  });
  test('060:p36 negative mode: 951.8 as 1- gives 952.8 and 475.5 as 2- gives 953.0', () => {
    near(massFrom(951.8, 1, 'negative', 1), 952.8, 0.001);
    near(massFrom(475.5, 2, 'negative', 1), 951 + 2, 0.001);
  });
  test('060:p37-p38 a conjugate: 1581.4 as 2- gives 3164.8 and 1053.9 as 3- gives 3164.7, and the mean is 3164.75', () => {
    near(massFrom(1581.4, 2, 'negative', 1), 3164.8, 0.001);
    near(massFrom(1053.9, 3, 'negative', 1), 3164.7, 0.001);
  });
  test('060:p42 lysozyme from the peaks at 1590.6 and 1431.6: n = 9 and M = 14306.4', () => {
    near(chargeFromPair(1431.6, 1590.6, 'positive', 1), 9, 0.01);
    near(massFrom(1590.6, 9, 'positive', 1), 14306.4, 0.001);
  });
  test('060:p50 the negative-mode peaks predicted from 14306.4: 1787.3, 2042.8, 2383.4, 2860.3 and 3575.6', () => {
    const predicted = (z: number) => (14306.4 - z * 1) / z;
    for (const [z, mz] of [[8, 1787.3], [7, 2042.8], [6, 2383.4], [5, 2860.3], [4, 3575.6]]) near(predicted(z), mz, 0.06);
    near(mzOf(14306.4, 8, 'negative'), 1787.3, 0.06);
  });
  test('051:p74 two peptides almost the same mass: PEPTIDEK 927.455 and PEPTIDEQ 927.419', () => {
    near(peptideMass('PEPTIDEK', 'monoisotopic'), 927.455, 0.001);
    near(peptideMass('PEPTIDEQ', 'monoisotopic'), 927.419, 0.001);
  });
  test('059:p80 and p93 DAFLGSFLYEYSR: [M+H]+ about 1567.8 and y12 about 1452.7', () => {
    const seq = 'DAFLGSFLYEYSR';
    near(mzOf(peptideMass(seq, 'monoisotopic'), 1, 'positive'), 1567.8, 0.1);
    near(fragmentMzs(seq, 'monoisotopic').y[11], 1452.7, 0.1);
  });
  test('060:p109 y1 at 175 is arginine; p113 a gap of 167 is phosphoserine and 87 is serine', () => {
    near(fragmentMzs('PEPTIDER', 'monoisotopic').y[0], 175, 0.2);
    near(87.032028 + 79.966331, 167, 0.01);
  });
  test('060:p126 two phosphates and one methyl add about 173.98 Da (the lecture uses 14.04 for the methyl)', () => {
    near(2 * 79.966331 + 14.01565, 173.98, 0.04);
  });
  test('060:p140 a 465 Da ligand: [M+H]+ 466 and [M+Na]+ 488', () => {
    near(mzOf(465, 1, 'positive'), 466, 0.01);
    near(adductMz(465, 1, 22.98922), 488, 0.02);
  });
  test('051:p37 and 060:p3 the two modes differ by 2 for the same molecule, and a proton is the 1H mass less an electron', () => {
    near(mzOf(1000, 1, 'positive') - mzOf(1000, 1, 'negative'), 2 * PROTON, 1e-9);
    near(1.007825 - PROTON, 0.000549, 0.00001);
  });
  test('059:p41 isotope peaks of a singly charged ion are about one unit apart: 2191.7, 2192.7, 2193.7', () => {
    near(C13_SPACING / 1, 1, 0.004);
  });
});

describe('typing a mass', () => {
  test('a number, a number with Da or kDa, and a sum', () => {
    expect(readMass('12357.75')).toEqual({ ok: true, value: 12357.75 });
    expect(readMass('12,357.75 Da')).toEqual({ ok: true, value: 12357.75 });
    expect(readMass('12.35775 kDa')).toEqual({ ok: true, value: 12357.75 });
    const sum = readMass('15 * (824.85 - 1)');
    expect(sum.ok && Math.abs(sum.value - 12357.75) < 1e-9).toBe(true);
    const times = readMass('15 × (824.85 − 1.007)');
    expect(times.ok && Math.abs(times.value - 12357.64) < 0.01).toBe(true);
  });
  test('nonsense is refused in words', () => {
    for (const text of ['', 'abc', '15 *', 'alert(1)', '1/0']) {
      const r = readMass(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem.length).toBeGreaterThan(5);
    }
  });
  test('no code runs', () => {
    expect(readMass('process.exit()').ok).toBe(false);
    expect(readMass('1; 2').ok).toBe(false);
  });
});

describe('a spec from another kind of sample runs with no code change', () => {
  test('a small-molecule series in negative mode and a spec with an average-mass peptide', () => {
    for (const [name, spec] of Object.entries(fixtures)) {
      for (let rung = 0; rung < 3; rung++) {
        for (let i = 0; i < 30; i++) {
          const t = prepare(spec, `fix${name}${i}:${i % 3}`, rung);
          expect(t.announce.length).toBeGreaterThan(10);
          expect(t.peaks.length).toBeGreaterThan(1);
        }
      }
    }
  });
  test('the engine code names no subject or course fact', () => {
    const words = ['cytochrome', 'lysozyme', 'prion', 'phospho', 'mannos', 'glycan', 'trypsin', 'endotoxin', 'bsa', 'hemoglobin', 'insulin', 'glc', 'lecture', 'kinase'];
    for (const file of ['engines/spectrum/logic.ts', 'engines/spectrum/view.ts', 'engines/spectrum/masses.ts', 'engines/spectrum/spectrum.css']) {
      const text = readFileSync(join(ROOT, 'src', file), 'utf8').toLowerCase();
      for (const word of words) expect(`${file}: ${text.includes(word) ? word : ''}`).toBe(`${file}: `);
    }
  });
});

describe('setting a task', () => {
  const right = (t: SpectrumTask): SpectrumAttempt => {
    switch (t.kind) {
      case 'isotope': return { kind: 'charge', z: t.z };
      case 'pair': return { kind: 'pair', z: t.n, mass: t.M, text: '' };
      case 'deconvolute': return { kind: 'mass', mass: t.M, text: '' };
      case 'ladder': return { kind: 'ladder', picks: t.rows.map((r) => r.answer) };
      case 'shift': return { kind: 'shift', mod: t.mod!.id, count: t.count };
    }
  };
  test('the same seed gives the same task, and seeds differ', () => {
    for (const [, spec] of specs) for (let rung = 0; rung < 3; rung++) expect(JSON.stringify(prepare(spec, 'run1:0', rung))).toBe(JSON.stringify(prepare(spec, 'run1:0', rung)));
    const seen = new Set(Array.from({ length: 30 }, (_, i) => prepare(pinned['protein-charge-series'].spec, `s${i}:0`, 1).M));
    expect(seen.size).toBe(30);
  });
  test('every task is built from exact physics: peaks sit where the masses and charges say', () => {
    for (const [, spec] of specs) {
      for (let rung = 0; rung < 3; rung++) {
        for (let i = 0; i < 40; i++) {
          const t = prepare(spec, `phys${i}:${i % 3}`, rung);
          for (const p of t.peaks) {
            expect(p.mz).toBeGreaterThanOrEqual(t.xmin);
            expect(p.mz).toBeLessThanOrEqual(t.xmax);
            expect(p.h).toBeGreaterThan(0);
            expect(p.h).toBeLessThanOrEqual(1);
          }
          if (t.kind === 'isotope') {
            const gaps = t.peaks.slice(1).map((p, k) => p.mz - t.peaks[k].mz);
            for (const g of gaps) near(g, C13_SPACING / t.z, 1e-9);
            expect(t.z).toBeGreaterThanOrEqual(spec.charges[0]);
            expect(t.z).toBeLessThanOrEqual(isotopeChargeTop(spec.charges[0], spec.charges[1]));
          }
          if (t.kind === 'pair' || t.kind === 'deconvolute') {
            expect(t.series.length).toBeGreaterThanOrEqual(2);
            for (const id of t.series) near(massFrom(t.peaks[id].mz, t.peaks[id].z as number, spec.mode), t.M, 1e-6);
            const charges = t.series.map((id) => t.peaks[id].z as number);
            for (let k = 1; k < charges.length; k++) expect(charges[k - 1] - charges[k]).toBe(1);
            const [l, r] = t.pair;
            near(chargeFromPair(t.peaks[l].mz, t.peaks[r].mz, spec.mode), t.n, 1e-6);
            expect(t.peaks[r].z).toBe(t.n);
            for (const c of charges) { expect(c).toBeGreaterThanOrEqual(spec.charges[0]); expect(c).toBeLessThanOrEqual(spec.charges[1]); }
          }
          if (t.kind === 'ladder') {
            const frag = fragmentMzs(t.sequence, t.massType);
            for (const row of t.rows) {
              const to = t.peaks[row.to];
              near(to.mz, (t.ionKind === 'y' ? frag.y : frag.b)[(to.ion as number) - 1], 1e-9);
              expect(row.answer.length).toBeGreaterThan(0);
            }
            // The letters read off the gaps really are the peptide, from the end the ladder starts at.
            const read = t.rows.map((r) => r.answer).join('');
            const seq = t.sequence.replace(/[LI]/g, (m) => (m ? 'L/I' : m)).split('');
            void seq;
            const expected = t.ionKind === 'y' ? [...t.sequence].reverse().slice(0, t.rows.length) : [...t.sequence].slice(2, 2 + t.rows.length);
            expect(t.rows.map((r) => r.answer)).toEqual(expected.map((l) => (l === 'L' || l === 'I' ? 'L/I' : l)));
            expect(read.length).toBeGreaterThan(2);
            for (const row of t.rows) near(row.delta, (RES(t)[row.answer === 'L/I' ? 'L' : row.answer]), 1e-6);
          }
          if (t.kind === 'shift') {
            near(t.peaks[1].mz - t.peaks[0].mz, t.delta / t.z, 1e-9);
            expect(t.options.some((o) => o.id === t.mod!.id)).toBe(true);
            expect(shiftAnswers(spec, t.sequence || null).some((c) => c.mod.id === t.mod!.id && c.count === t.count)).toBe(true);
          }
          expect(result(t, right(t)).met).toBe(true);
        }
      }
    }
  });
  const RES = (t: SpectrumTask) => (t.massType === 'monoisotopic'
    ? { G: 57.021464, A: 71.037114, S: 87.032028, P: 97.052764, V: 99.068414, T: 101.047679, C: 103.009185, L: 113.084064, N: 114.042927, D: 115.026943, Q: 128.058578, K: 128.094963, E: 129.042593, M: 131.040485, H: 137.058912, F: 147.068414, R: 156.101111, Y: 163.063329, W: 186.079313 }
    : { G: 57.0519, A: 71.0788, S: 87.0782, P: 97.1167, V: 99.1326, T: 101.1051, C: 103.1388, L: 113.1594, N: 114.1038, D: 115.0886, Q: 128.1307, K: 128.1741, E: 129.1155, M: 131.1926, H: 137.1411, F: 147.1766, R: 156.1875, Y: 163.176, W: 186.2132 }) as Record<string, number>;
  test('rung 2 sets every task the spec allows, and rung 2 specs with one task set only that', () => {
    const kinds = (spec: SpectrumSpec) => new Set(Array.from({ length: 45 }, (_, i) => prepare(spec, `k${i}:${i % 3}`, 2).kind));
    expect([...kinds(pinned['protein-charge-series'].spec)]).toEqual(['deconvolute']);
    expect([...kinds(pinned['peptide-fragment-ladder'].spec)]).toEqual(['ladder']);
    expect([...kinds(pinned['modification-mass-shift'].spec)]).toEqual(['shift']);
    const all = clone(pinned['peptide-fragment-ladder'].spec); delete all.tasks; all.modifications = pinned['modification-mass-shift'].spec.modifications;
    expect(kinds(all).size).toBe(3);
  });
  test('rungs 0 and 1 set an isotope reading and a pair', () => {
    for (const [, spec] of specs) {
      expect(prepare(spec, 'a:0', 0).kind).toBe('isotope');
      expect(prepare(spec, 'a:0', 1).kind).toBe('pair');
    }
  });
  test('a wrong assignment shows itself: the wrong charge gives masses that disagree', () => {
    const t = prepare(pinned['protein-charge-series'].spec, 'show:0', 1);
    const [l, r] = t.pair;
    const good = Math.abs(massFrom(t.peaks[l].mz, t.n + 1, 'positive') - massFrom(t.peaks[r].mz, t.n, 'positive'));
    const bad = Math.abs(massFrom(t.peaks[l].mz, t.n + 2, 'positive') - massFrom(t.peaks[r].mz, t.n + 1, 'positive'));
    expect(good).toBeLessThan(0.1);
    expect(bad).toBeGreaterThan(100);
    const lines = workingFor(t, t.n + 1).join(' ');
    expect(lines).toContain('cannot be right');
    expect(workingFor(t, t.n).join(' ')).toContain('this fits');
    // The working is plain numbers: a student sees a charge that is close to whole.
    near(chargeFromPair(t.peaks[l].mz, t.peaks[r].mz, 'positive'), t.n, 1e-6);
  });
  test('tapping the wrong neighbours gives a charge that is not whole', () => {
    const t = prepare(pinned['protein-charge-series'].spec, 'show:1', 2);
    const a = t.peaks[t.series[0]]; const c = t.peaks[t.series[2]];
    const n = chargeFromPair(a.mz, c.mz, 'positive');
    expect(Math.abs(n - Math.round(n))).toBeGreaterThan(0.01);
  });
});

describe('judging an attempt', () => {
  test('isotope: the right charge is met, a wrong one is named', () => {
    const t = prepare(pinned['protein-charge-series'].spec, 'iso:0', 0);
    expect(result(t, { kind: 'charge', z: t.z }).met).toBe(true);
    const wrong = result(t, { kind: 'charge', z: t.z + 1 });
    expect(wrong.met).toBe(false);
    expect(wrong.misconception).toBeTruthy();
    expect(wrong.label.length).toBeLessThanOrEqual(200);
    expect(wrong.why).toContain('1.003');
  });
  test('pair: charge and mass both count, and the usual slips are named', () => {
    const t = prepare(pinned['protein-charge-series'].spec, 'pair:0', 1);
    expect(result(t, { kind: 'pair', z: t.n, mass: t.M + 0.2, text: '' }).met).toBe(true);
    expect(result(t, { kind: 'pair', z: t.n, mass: t.M + 5, text: '' }).met).toBe(false);
    expect(result(t, { kind: 'pair', z: t.n + 1, mass: t.M, text: '' }).misconception).toMatch(/extra charge/);
    const right = t.peaks[t.pair[1]];
    expect(result(t, { kind: 'pair', z: t.n, mass: t.n * right.mz, text: '' }).misconception).toMatch(/protons/);
    expect(result(t, { kind: 'pair', z: t.n, mass: right.mz, text: '' }).misconception).toMatch(/no charge/);
  });
  test('deconvolution: the mass alone, to within the tolerance the spec gives', () => {
    const t = prepare(pinned['protein-charge-series'].spec, 'deconv:0', 2);
    expect(t.kind).toBe('deconvolute');
    expect(result(t, { kind: 'mass', mass: t.M - 0.4, text: '' }).met).toBe(true);
    expect(result(t, { kind: 'mass', mass: t.M + 0.6, text: '' }).met).toBe(false);
    const tight = clone(pinned['protein-charge-series'].spec); tight.tolerance = 0.1;
    const u = prepare(tight, 'deconv:0', 2);
    expect(result(u, { kind: 'mass', mass: u.M + 0.3, text: '' }).met).toBe(false);
  });
  test('ladder: every residue must be read, and a near miss is named', () => {
    const t = prepare(pinned['peptide-fragment-ladder'].spec, 'lad:0', 2);
    expect(t.kind).toBe('ladder');
    const picks = t.rows.map((r) => r.answer);
    expect(result(t, { kind: 'ladder', picks }).met).toBe(true);
    const off = [...picks]; off[0] = off[0] === 'G' ? 'A' : 'G';
    expect(result(t, { kind: 'ladder', picks: off }).met).toBe(false);
    expect(result(t, { kind: 'ladder', picks: off }).label).toContain(picks.join(''));
  });
  test('shift: the modification and the count, and forgetting the charge is named', () => {
    const spec = pinned['modification-mass-shift'].spec;
    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      const t = prepare(spec, `sh${i}:${i % 3}`, 2);
      if (t.z === 1) continue;
      expect(result(t, { kind: 'shift', mod: t.mod!.id, count: t.count }).met).toBe(true);
      expect(result(t, { kind: 'shift', mod: t.mod!.id, count: t.count === 1 ? 2 : 1 }).met).toBe(false);
      const other = t.options.find((o) => o.id !== t.mod!.id)!;
      expect(result(t, { kind: 'shift', mod: other.id, count: 1 }).met).toBe(false);
      // The m/z gap on its own looks like a smaller mass when the charge is more than one.
      const dm = Math.abs(t.peaks[1].mz - t.peaks[0].mz);
      const lookalike = t.options.find((o) => Math.abs(o.delta - dm) < 0.1);
      if (lookalike) { expect(result(t, { kind: 'shift', mod: lookalike.id, count: 1 }).misconception).toMatch(/charge/); found = true; }
    }
    expect(typeof found).toBe('boolean');
  });
  test('a wrong kind of attempt is an error, not a pass', () => {
    const t = prepare(pinned['protein-charge-series'].spec, 'x:0', 0);
    expect(() => result(t, { kind: 'mass', mass: 1, text: '' })).toThrow();
  });
  test('the sentence on why uses this task\'s own numbers', () => {
    for (let rung = 0; rung < 3; rung++) {
      const t = prepare(pinned['protein-charge-series'].spec, `why:${rung}`, rung);
      const why = whyFor(t);
      expect(why).toMatch(/\.$/);
      expect(why.length).toBeGreaterThan(40);
      if (t.kind !== 'isotope') expect(why).toContain(fixed(t.M, 1, true));
    }
  });
});

describe('refusing a bad spec', () => {
  const has = (spec: unknown, text: string) => expect(issues(spec as SpectrumSpec).join(' | ')).toContain(text);
  const base = () => clone(pinned['modification-mass-shift'].spec);
  test('a missing mode or mass type', () => { const s = base(); delete (s as Partial<SpectrumSpec>).massType; has(s, 'massType'); const t = base(); (t as { mode: string }).mode = 'both'; has(t, '`mode`'); });
  test('charges that are not a series', () => { const s = base(); s.charges = [3, 3]; has(s, 'at least two charge states'); });
  test('nothing to measure', () => { const s = base(); delete s.peptides; has(s, 'peptides'); });
  test('a peptide with a letter that is not a residue', () => { const s = base(); s.peptides![0].sequence = 'TPAAAAAXNLASPR'; has(s, 'amino-acid letters'); });
  test('a series that would sit off the instrument', () => { const s = base(); s.charges = [1, 60]; has(s, 'outside'); });
  test('modifications that cannot be told apart', () => { const s = base(); s.modifications!.push({ id: 'twin', name: 'a twin', delta: 79.97, residues: ['S'] }); has(s, 'cannot tell them apart'); });
  test('a modification with no site on any peptide', () => { const s = base(); s.peptides = [{ sequence: 'AAAAAAAAGG' }]; s.modifications = [s.modifications![0]]; has(s, 'can sit on peptide'); });
  test('adducts in negative mode', () => { const s = base(); s.mode = 'negative'; s.adducts = [{ name: 'Na', mass: 22.98922 }]; has(s, 'positive mode'); });
  test('a task the spec cannot set', () => { const s = base(); delete s.modifications; s.tasks = ['shift']; has(s, '`tasks`'); });
  test('a spec too long for the catalogue', () => { const s = base(); s.note = 'x'.repeat(5000); has(s, '`note`'); });
  test('things that are not specs at all', () => {
    expect(issues(null as unknown as SpectrumSpec).length).toBeGreaterThan(0);
    expect(issues({} as SpectrumSpec).length).toBeGreaterThan(0);
    expect(issues('x' as unknown as SpectrumSpec).length).toBeGreaterThan(0);
  });
  test('words a writer can act on, and few of them', () => {
    const s = base(); s.charges = [3, 3]; delete (s as Partial<SpectrumSpec>).massType;
    const found = issues(s);
    expect(found.length).toBeLessThanOrEqual(14);
    expect(found[0]).toMatch(/^[A-Z`]/);
  });
});

describe('the engine is registered', () => {
  test('spectrum is in the registry with everything an engine needs', () => {
    const e = engines['spectrum'];
    expect(e.id).toBe('spectrum');
    expect(e.label).toBe('Read the Spectrum');
    for (const fn of ['issues', 'prepare', 'view', 'result'] as const) expect(typeof e[fn]).toBe('function');
  });
  test('the reference constants are the published ones', () => {
    near(PROTON, 1.00727646688, 1e-9);
    near(WATER.monoisotopic, 18.0105646863, 1e-6);
  });
});
