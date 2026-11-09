import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport } from '../src/report';
import { foundIt, issues, needsRepair, prepare, result, type SpotAttempt, type SpotSpec } from '../src/engines/spot/logic';
import { standaloneProblem } from '../src/engines/sort/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const history: SpotSpec = readJson('test', 'fixtures', 'spot', 'history-passages.json');
const generated: Array<{ id: string; spec: SpotSpec }> = readdirSync(join(ROOT, 'content', 'generated'))
  .filter((f) => f.endsWith('.json')).map((f) => readJson('content', 'generated', f)).filter((a) => a.engine === 'spot');
const generatedSorts: Array<{ spec: { cards: Array<{ t: string }> } }> = readdirSync(join(ROOT, 'content', 'generated'))
  .filter((f) => f.endsWith('.json')).map((f) => readJson('content', 'generated', f)).filter((a) => a.engine === 'sort');

const clone = (): SpotSpec => JSON.parse(JSON.stringify(history));
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

describe('the shipped activities are fit to use', () => {
  test('the history fixture has no issues', () => expect(issues(history)).toEqual([]));
  test('every generated Find the Error activity has no issues', () => {
    expect(generated.length).toBeGreaterThan(0);
    for (const a of generated) expect(`${a.id}: ${issues(a.spec).join(' | ')}`).toBe(`${a.id}: `);
  });
  test('the engine is registered by its one line', () => {
    expect(engines.spot?.id).toBe('spot');
    expect(engines.spot?.label).toBe('Find the Error');
  });
  test('a planted falsehood is never reused as a statement anywhere else', () => {
    const planted = new Set<string>();
    for (const a of generated) for (const p of a.spec.passages) for (const s of p.s) if (!s.ok) planted.add(norm(s.t));
    expect(planted.size).toBeGreaterThan(0);
    for (const a of generated) for (const p of a.spec.passages) {
      for (const s of p.s) if (s.ok) expect(`${a.id}: ${planted.has(norm(s.t))}`).toBe(`${a.id}: false`);
      for (const r of p.repairs ?? []) expect(`${a.id}: ${planted.has(norm(r))}`).toBe(`${a.id}: false`);
      if (p.correction) expect(planted.has(norm(p.correction))).toBe(false);
    }
    for (const a of generatedSorts) for (const c of a.spec.cards) expect(planted.has(norm(c.t))).toBe(false);
  });
  test('about one passage in four has nothing wrong, and never more than half', () => {
    let all = 0, none = 0;
    for (const a of generated) for (const p of a.spec.passages) { all++; if (p.s.every((s) => s.ok)) none++; }
    expect(none / all).toBeGreaterThan(0.1);
    expect(none / all).toBeLessThan(0.5);
  });
});

describe('what a writer is told', () => {
  test('two false sentences in one passage are refused', () => {
    const s = clone(); s.passages[0].s[0].ok = false;
    expect(issues(s).join(' ')).toContain('at most one is allowed');
  });
  test('a false sentence with no correction is refused', () => {
    const s = clone(); delete s.passages[0].correction;
    expect(issues(s).join(' ')).toContain('no "correction"');
  });
  test('a correction that leans on the sentence before it is refused', () => {
    const s = clone(); s.passages[0].correction = 'It was held for one year only.';
    expect(issues(s).join(' ')).toContain('needs the sentence before it');
  });
  test('repairs that repeat the correction, or offer the false sentence, are refused', () => {
    const a = clone(); a.passages[0].repairs = [a.passages[0].correction as string, 'Only one consul was elected, and he chose his own successor.'];
    expect(issues(a).join(' ')).toContain('not all different');
    const b = clone(); b.passages[0].repairs = ['A consul could rule for life if the Senate agreed.', 'Only one consul was elected, and he chose his own successor.'];
    expect(issues(b).join(' ')).toContain('false sentence itself');
  });
  test('a planted falsehood turning up as a true sentence or a repair elsewhere is refused', () => {
    const a = clone(); a.passages[2].s[1] = { t: 'A consul could rule for life if the Senate agreed.', ok: true };
    expect(issues(a).join(' ')).toContain('planted as false in another passage');
    const b = clone(); b.passages[1].repairs = ['A consul could rule for life if the Senate agreed.', 'x'.repeat(30)];
    expect(issues(b).join(' ')).toContain('planted as false in another passage');
  });
  test('too few passages, too short a passage and a spec with no error are refused', () => {
    const a = clone(); a.passages = a.passages.slice(0, 2);
    expect(issues(a).join(' ')).toContain('at least 3');
    const b = clone(); b.passages[0].s = b.passages[0].s.slice(0, 3);
    expect(issues(b).join(' ')).toContain('needs 4 to 7');
    const c = clone(); c.passages = c.passages.filter((p) => p.s.every((s) => s.ok)).concat(c.passages.filter((p) => p.s.every((s) => s.ok)), c.passages.filter((p) => p.s.every((s) => s.ok)));
    expect(issues(c).join(' ')).toContain('At least one passage needs a false sentence');
  });
});

describe('a spec from another subject runs with no code change', () => {
  test('history: the same seed gives the same round', () => {
    const a = prepare(history, 'h:1', 1), b = prepare(history, 'h:1', 1);
    expect(a).toEqual(b);
  });
  test('every task holds its false sentence (or none) and its three repairs', () => {
    for (let rung = 0; rung < 3; rung++) for (let i = 0; i < 60; i++) {
      const t = prepare(history, `s${i}:${i % 3}`, rung);
      const bad = t.sentences.filter((s) => !s.ok).length;
      expect(bad).toBeLessThanOrEqual(1);
      expect(t.falseAt).toBe(t.sentences.findIndex((s) => !s.ok));
      if (t.falseAt >= 0) {
        expect(t.options.length).toBe(3);
        expect(t.options.filter((o) => o.right).length).toBe(1);
        expect(t.options.find((o) => o.right)!.t).toBe(t.correction);
      } else expect(t.options).toEqual([]);
    }
  });
  test('rung 0 shows four sentences and rung 1 shows more', () => {
    for (let i = 0; i < 40; i++) {
      expect(prepare(history, `w${i}:0`, 0).sentences.length).toBe(4);
      expect(prepare(history, `w${i}:0`, 1).sentences.length).toBeGreaterThanOrEqual(4);
    }
    const longest = Math.max(...Array.from({ length: 40 }, (_, i) => prepare(history, `w${i}:0`, 1).sentences.length));
    expect(longest).toBe(5);
  });
  test('rung 2 puts the false sentence between two true ones', () => {
    for (let i = 0; i < 80; i++) {
      const t = prepare(history, `b${i}:${i % 3}`, 2);
      if (t.falseAt >= 0) {
        expect(t.falseAt).toBeGreaterThan(0);
        expect(t.falseAt).toBeLessThan(t.sentences.length - 1);
      }
    }
  });
  test('a run of three rounds meets three different passages', () => {
    for (let i = 0; i < 30; i++) {
      const firsts = [0, 1, 2].map((r) => prepare(history, `run${i}:${r}`, 1).sentences[0].t);
      expect(new Set(firsts).size).toBe(3);
    }
  });
  test('the options are in a different order on different seeds', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const t = prepare(history, `o${i}:0`, 0);
      if (t.falseAt >= 0) orders.add(t.options.map((o) => o.right).join());
    }
    expect(orders.size).toBeGreaterThan(1);
  });
  test('the sentence a window starts at never needs the one before it', () => {
    const firsts = new Set(generated.flatMap((a) => a.spec.passages.map((p) => p.s[0].t)));
    for (const a of generated) for (let i = 0; i < 30; i++) {
      const t = prepare(a.spec, `gen${i}:${i % 3}`, i % 3);
      expect(t.sentences.length).toBeGreaterThanOrEqual(4);
      expect(firsts.has(t.sentences[0].t) || standaloneProblem(t.sentences[0].t) === null).toBe(true);
    }
  });
});

describe('judging a round', () => {
  const errorTask = () => { for (let i = 0; i < 50; i++) { const t = prepare(history, `e${i}:0`, 0); if (t.falseAt >= 0) return t; } throw new Error('no error passage'); };
  const noneTask = () => { for (let i = 0; i < 50; i++) { const t = prepare(history, `n${i}:2`, 0); if (t.falseAt < 0) return t; } throw new Error('no clean passage'); };
  const rightRepair = (t: ReturnType<typeof errorTask>) => t.options.findIndex((o) => o.right);

  test('finding the false sentence and the repair is met, with the true version in the sentence on why', () => {
    const t = errorTask();
    const r = result(t, { pick: t.falseAt, repair: rightRepair(t) });
    expect(r.met).toBe(true);
    expect(r.why).toContain(t.correction);
    expect(r.misconception).toBeUndefined();
  });
  test('the right sentence with the wrong repair is not met, and names the idea believed', () => {
    const t = errorTask();
    const wrong = t.options.findIndex((o) => !o.right);
    const r = result(t, { pick: t.falseAt, repair: wrong });
    expect(r.met).toBe(false);
    expect(r.misconception).toContain('Believes');
    expect(r.why).toContain(t.correction);
  });
  test('tapping a true sentence, or saying none, misses a false sentence and names it', () => {
    const t = errorTask();
    const other = t.sentences.findIndex((s) => s.ok);
    const a = result(t, { pick: other });
    expect(a.met).toBe(false);
    expect(a.misconception).toContain('Takes as true');
    expect(a.why).toContain(t.correction);
    const b = result(t, { pick: null });
    expect(b.met).toBe(false);
    expect(b.misconception).toContain('Takes as true');
  });
  test('the second question is asked only when the false sentence was found', () => {
    const t = errorTask();
    expect(needsRepair(t, { pick: t.falseAt })).toBe(true);
    expect(needsRepair(t, { pick: 0 === t.falseAt ? 1 : 0 })).toBe(false);
    expect(needsRepair(t, { pick: null })).toBe(false);
  });
  test('a passage with nothing wrong: saying so is met, tapping a sentence is a doubt of a true one', () => {
    const t = noneTask();
    expect(foundIt(t, { pick: null })).toBe(true);
    expect(result(t, { pick: null }).met).toBe(true);
    const r = result(t, { pick: 1 });
    expect(r.met).toBe(false);
    expect(r.misconception).toContain('Doubts a true statement');
  });
  test('every label reads as a sentence a student can read, within the report limit', () => {
    for (let i = 0; i < 60; i++) {
      const t = prepare(history, `l${i}:${i % 3}`, i % 3);
      const attempt: SpotAttempt = t.falseAt >= 0 ? { pick: t.falseAt, repair: 0 } : { pick: null };
      const r = result(t, attempt);
      expect(r.label.length).toBeGreaterThan(20);
      expect(r.label.length).toBeLessThanOrEqual(200);
      expect((r.misconception ?? '').length).toBeLessThanOrEqual(120);
    }
  });
  test('the report carries one criterion per round and the wrong ideas', () => {
    const t = errorTask();
    const wrong = result(t, { pick: null });
    const right = result(t, { pick: t.falseAt, repair: rightRepair(t) });
    const report = buildReport({ activityId: 'ho-spot-x', skill: 'spotting-errors', rung: 0, rounds: [right, wrong, right], finished: true });
    expect(report.criteria.length).toBe(3);
    expect(report.misconceptions?.length).toBe(1);
    expect(report.valid).toBe(true);
  });
});

describe('the engine code mentions no subject', () => {
  test('spot/logic.ts, view.ts and spot.css', () => {
    const words = ['consul', 'roman', 'caxton', 'watt', 'protein', 'enzyme', 'kinetic', 'ligand', 'transcription', 'ribosome', 'spectrum', 'history', 'biology'];
    for (const file of ['logic.ts', 'view.ts', 'spot.css']) {
      const text = readFileSync(join(ROOT, 'src', 'engines', 'spot', file), 'utf8').toLowerCase();
      for (const word of words) expect(`${file}: ${text.includes(word) ? word : ''}`).toBe(`${file}: `);
    }
  });
});
