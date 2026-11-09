import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEdits, cellLevels, evalCell, issues, prepare, result, whySentence,
  type BChange, type BreakSpec, type BreakTask,
} from '../src/engines/construct/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const content: Record<string, { id: string; spec: BreakSpec }> = {};
if (existsSync(join(ROOT, 'content', 'construct'))) for (const f of readdirSync(join(ROOT, 'content', 'construct'))) if (f.endsWith('.json')) content[f.replace('.json', '')] = readJson('content', 'construct', f);
const fixtures: Record<string, BreakSpec> = {};
for (const f of readdirSync(join(ROOT, 'test', 'fixtures', 'construct'))) if (f.endsWith('.json')) fixtures[f.replace('.json', '')] = readJson('test', 'fixtures', 'construct', f);
const clone = (s: BreakSpec) => JSON.parse(JSON.stringify(s)) as BreakSpec;
const change = (spec: BreakSpec, id: string) => spec.changes.find((c) => c.id === id) as BChange;

/** The cell's level name in each condition, for one change on each copy. */
function reads(spec: BreakSpec, ...ids: Array<string | null>): string[] {
  return cellLevels(spec, spec.conditions, ids.map((id) => (id ? change(spec, id) : null))).map((n) => spec.readout.levels[n]);
}

describe('the shipped activities are fit to use', () => {
  for (const [name, a] of Object.entries(content)) {
    test(`${name} has no issues and fits the catalogue`, () => {
      expect(issues(a.spec)).toEqual([]);
      expect(JSON.stringify(a.spec).length).toBeLessThanOrEqual(4096);
    });
  }
  for (const [name, spec] of Object.entries(fixtures)) {
    test(`fixture ${name} has no issues`, () => { expect(issues(spec)).toEqual([]); });
  }
  test('the engine is registered', () => { expect(engines.construct?.id).toBe('construct'); });
});

describe('a spec from another subject runs with no code change (a workshop with a shared supply)', () => {
  const spec = fixtures['workshop-motors'];
  test('the normal machine turns when the lock is off and stops when it is on', () => {
    expect(reads(spec, null)).toEqual(['turning', 'stopped']);
  });
  test('one machine: a missing part stops it, taking the lock away does nothing where it was not on', () => {
    expect(reads(spec, 'nogen')).toEqual(['stopped', 'stopped']);
    expect(reads(spec, 'nosw')).toEqual(['stopped', 'stopped']);
    expect(reads(spec, 'nomotor')).toEqual(['stopped', 'stopped']);
    expect(reads(spec, 'nolock')).toEqual(['turning', 'turning']);
  });
  test('order matters when the rule asks for it', () => {
    expect(reads(spec, 'swapped')).toEqual(['stopped', 'stopped']);
  });
  test('two machines: a generator lost on one is supplied by the other (shared), a part lost on its own machine is not', () => {
    expect(reads(spec, 'nogen', 'nosw')).toEqual(['turning', 'stopped']); // machine 1 has switch and motor and takes power made by machine 2
    expect(reads(spec, 'nosw', 'nomotor')).toEqual(['stopped', 'stopped']); // no one machine has both
    expect(reads(spec, 'nogen', 'nogen')).toEqual(['stopped', 'stopped']);
  });
  test('the engine says which pairs complement, and why', () => {
    const task = prepare(spec, 'x:1', 2);
    expect(task.copies.length).toBe(2);
    expect(typeof task.complement).toBe('boolean');
    expect(whySentence(task)).toMatch(/complement/);
  });
});

describe('a second subject: a lamp circuit with levels, alternatives, adding and orientation', () => {
  const spec = fixtures['lamp-circuit'];
  test('normal', () => { expect(reads(spec, null)).toEqual(['dim', 'bright']); });
  test('removing the socket loses the extra brightness only when the battery is there', () => { expect(reads(spec, 'nosocket')).toEqual(['dim', 'dim']); });
  test('an oriented part is ruined by turning it round, an unoriented one is not', () => {
    expect(reads(spec, 'flipdiode')).toEqual(['dark', 'dark']);
    expect(reads(spec, 'flipsocket')).toEqual(['dim', 'bright']);
  });
});

describe('the rules, one at a time', () => {
  const base = (): BreakSpec => ({
    parts: [{ id: 'p', label: 'Alpha' }, { id: 'q', label: 'Beta' }, { id: 'r', label: 'Gamma' }],
    factors: [{ id: 'f', label: 'Factor F', always: true }, { id: 'g', label: 'Factor G', needs: ['h'] }, { id: 'h', label: 'Factor H' }],
    conditions: [{ id: 'a', label: 'With H', has: ['h', 'g'] }, { id: 'b', label: 'Without H', has: ['g'] }],
    readout: { name: 'output', levels: ['off', 'low', 'on'] },
    rules: [{ effect: 'needs', part: 'p', factor: 'f' }, { effect: 'blocks', part: 'q', factor: 'g', by: 2 }, { effect: 'needs', part: 'r' }],
    changes: [{ id: 'dq', kind: 'delete', part: 'q', label: 'Delete Beta' }, { id: 'dp', kind: 'delete', part: 'p', label: 'Delete Alpha' }],
  });
  test('a factor that needs another is off without it, so its block does not hold', () => {
    expect(reads(base(), null)).toEqual(['off', 'on']);
    expect(reads(base(), 'dq')).toEqual(['on', 'on']);
  });
  test('a partial mutation spoils only the factors it names', () => {
    const s = base();
    s.changes.push({ id: 'mq', kind: 'mutate', part: 'q', affects: ['f'], label: 'Mutate Beta' });
    expect(reads(s, 'mq')).toEqual(['off', 'on']);
    s.changes.push({ id: 'mq2', kind: 'mutate', part: 'q', affects: ['g'], label: 'Mutate Beta in the G site' });
    expect(reads(s, 'mq2')).toEqual(['on', 'on']);
  });
  test('alternative needs share a group', () => {
    const s = base();
    s.rules = [{ effect: 'needs', part: 'p', group: 'x' }, { effect: 'needs', part: 'q', group: 'x' }];
    expect(reads(s, 'dq')).toEqual(['on', 'on']);
    expect(reads(s, 'dp')).toEqual(['on', 'on']);
    expect(reads(s, 'dp', 'dq')).toEqual(['on', 'on']); // each copy still has one
    s.changes.push({ id: 'both', label: 'Delete Alpha and Beta', edits: [{ kind: 'delete', part: 'p' }, { kind: 'delete', part: 'q' }] });
    expect(reads(s, 'both')).toEqual(['off', 'off']);
  });
  test('a factor that is taken away is absent in every copy', () => {
    const s = base();
    s.changes.push({ id: 'nof', kind: 'remove', factor: 'f', label: 'Take away F' });
    expect(reads(s, 'nof')).toEqual(['off', 'off']);
  });
  test('the cell reads the strongest of its copies, and the factors reach both', () => {
    const s = base();
    expect(reads(s, 'dp', null)).toEqual(['off', 'on']);
    const ev = evalCell(s, s.conditions[0], [applyEdits(s, [change(s, 'dp')]).copy, applyEdits(s, []).copy], []);
    expect(ev.copies.map((c) => c.level)).toEqual([0, 0]);
  });
});

describe('questions are set at every rung, from the setup, never typed', () => {
  for (const [name, spec] of [...Object.entries(fixtures), ...Object.entries(content).map(([k, v]) => [k, v.spec] as [string, BreakSpec])]) {
    test(`${name}: rungs 0, 1 and 2 give tasks the engine can mark`, () => {
      for (let rung = 0; rung < 3; rung++) for (let round = 0; round < 3; round++) {
        const task: BreakTask = prepare(spec, `s:${round}`, rung);
        expect(task.asked.length).toBeGreaterThanOrEqual(1);
        expect(prepare(spec, `s:${round}`, rung)).toEqual(task); // same seed, same task
        const comp = task.copies.length > 1 ? task.complement : undefined;
        const right = result(task, { levels: Object.fromEntries(task.asked.map((c, i) => [c.id, task.truth[i]])), complement: comp });
        expect(right.met).toBe(true);
        expect(right.why.length).toBeGreaterThan(20);
        const wrong = result(task, { levels: Object.fromEntries(task.asked.map((c, i) => [c.id, (task.truth[i] + 1) % spec.readout.levels.length])), complement: comp });
        expect(wrong.met).toBe(false);
      }
    });
  }
  test('rung 2 sets two copies with a different change on each, and mixes complementing with not', () => {
    const spec = fixtures['workshop-motors'];
    const seen = new Set<boolean>();
    for (let round = 0; round < 6; round++) {
      const t = prepare(spec, `mix:${round}`, 2);
      expect(t.copies.length).toBe(2);
      expect(t.changes[0].id).not.toBe(t.changes[1].id);
      seen.add(t.complement as boolean);
    }
    expect(seen.size).toBe(2);
  });
});

describe('a spec with a mistake is refused, in words a writer can act on', () => {
  const ok = () => clone(fixtures['workshop-motors']);
  test('unknown ids and clashes', () => {
    const s = ok(); s.rules[0].part = 'zzz';
    expect(issues(s).join(' ')).toMatch(/part/);
    const t = ok(); t.factors[0].madeBy = 'nowhere';
    expect(issues(t).join(' ')).toMatch(/madeBy/);
    const u = ok(); u.conditions[0].has = ['mains'];
    expect(issues(u).join(' ')).toMatch(/given factors/);
  });
  test('a factor that depends on itself', () => {
    const s = ok(); s.factors[1].needs = ['mains']; s.factors[0].needs = ['lock'];
    expect(issues(s).join(' ')).toMatch(/depends on itself/);
  });
  test('a blocks rule needs a factor, and a notModelled rule needs a reason', () => {
    const s = ok(); s.rules.push({ effect: 'blocks', part: 'motor' });
    expect(issues(s).join(' ')).toMatch(/needs a `factor`/);
    const t = ok(); t.rules.push({ effect: 'blocks', part: 'motor', factor: 'lock', notModelled: 'no' });
    expect(issues(t).join(' ')).toMatch(/notModelled/);
  });
  test('nothing to break', () => {
    const s = ok(); s.conditions = [{ id: 'locked', label: 'Lock on', has: ['lock'] }]; s.rules = [{ effect: 'needs', part: 'sw', factor: 'mains' }];
    expect(issues(s).join(' ')).toMatch(/nothing to break|lowest level/);
  });
  test('a spec that is too long', () => {
    const s = ok(); s.story = 'x'.repeat(5000);
    expect(issues(s).join(' ')).toMatch(/characters/);
  });
});

describe('a rule the model cannot show is marked, and carries nothing', () => {
  test('a notModelled rule changes no reading', () => {
    const s = clone(fixtures['workshop-motors']);
    const before = reads(s, null);
    s.rules.push({ effect: 'blocks', part: 'motor', factor: 'lock', notModelled: 'The real lock only slows the motor, which the two levels cannot show.' });
    expect(issues(s)).toEqual([]);
    expect(reads(s, null)).toEqual(before);
  });
});

describe('the engine code names no subject', () => {
  test('no engine file mentions a course word', () => {
    const words = ['dna', 'rna', 'promoter', 'operator', 'enhancer', 'repressor', 'polymerase', 'genes?\\b', 'protein', 'lactose', 'tryptophan', 'splicing', 'spliceosome', 'mirna', 'ribosome', 'codon', 'transcript', 'nucleo', 'sigma'];
    for (const file of ['engines/construct/logic.ts', 'engines/construct/view.ts', 'engines/construct/construct.css']) {
      const text = readFileSync(join(ROOT, 'src', file), 'utf8').toLowerCase();
      for (const word of words) expect(`${file}: ${new RegExp(`\\b${word}`).test(text) ? word : ''}`).toBe(`${file}: `);
    }
  });
});
