import { describe, expect, test } from 'bun:test';
import { prepare as prepareSpot, result as spotResult, type SpotSpec } from '../src/engines/spot/logic';
import { buildReport } from '../src/report';

const passage = (name: string, covers?: string[]) => ({
  s: [
    { t: `${name} one.`, ok: true }, { t: `${name} two.`, ok: true },
    { t: `${name} three is false.`, ok: false }, { t: `${name} four.`, ok: true },
  ],
  correction: `${name} three is true as written here.`,
  repairs: [`${name} wrong repair.`, `${name} other wrong repair.`],
  ...(covers ? { covers } : {}),
});
const clean = { s: [{ t: 'A.', ok: true }, { t: 'B.', ok: true }, { t: 'C.', ok: true }, { t: 'D.', ok: true }] };

describe('rounds that say what they tested', () => {
  const spec: SpotSpec = { passages: [passage('First', ['pt_1']), passage('Second', ['pt_2']), passage('Third'), clean] };
  const tasks = Array.from({ length: 24 }, (_, i) => prepareSpot(spec, `seed${i}:${i % 3}`, 0));

  test('a round reports the points of the passage it showed', () => {
    for (const task of tasks) {
      const expected = task.correction.startsWith('First') ? ['pt_1'] : task.correction.startsWith('Second') ? ['pt_2'] : [];
      expect(spotResult(task, { pick: null }).covers).toEqual(task.falseAt < 0 ? [] : expected);
    }
  });

  test('a spec that names nothing per passage reports nothing', () => {
    const plain: SpotSpec = { passages: [passage('First'), passage('Second'), passage('Third')] };
    expect(spotResult(prepareSpot(plain, 'seed:0', 0), { pick: null }).covers).toBeUndefined();
  });

  test('the report carries it onto each criterion', () => {
    const report = buildReport({
      activityId: 'a', skill: 's', rung: 0, finished: true,
      rounds: [{ met: true, label: 'L', why: 'W', covers: ['pt_1'] }, { met: false, label: 'M', why: 'W', covers: [] }, { met: true, label: 'N', why: 'W' }],
    });
    expect(report.criteria.map((criterion) => criterion.covers)).toEqual([['pt_1'], [], undefined]);
  });
});
