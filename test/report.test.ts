import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePracticeCatalogue, validatePracticeResult } from '../../mnx-addon-kit-release/sdk/src/practice.mjs';
import type { RoundResult } from '../src/engine';
import { engines } from '../src/engines/registry';
import { NAMES_COVERS, creditFrom } from '../src/credit';
import { ROUNDS, buildReport, nextRung, passed } from '../src/report';
import { parseRung } from '../src/store';

const round = (met: boolean, label = 'Predicts that the thing rises when something changes', misconception?: string): RoundResult => ({ met, label, why: 'Because.', misconception });

describe('the rung', () => {
  test('passing a run moves up one and missing one moves down one, within 0 to 2', () => {
    expect(nextRung(0, true)).toBe(1);
    expect(nextRung(1, true)).toBe(2);
    expect(nextRung(2, true)).toBe(2);
    expect(nextRung(2, false)).toBe(1);
    expect(nextRung(1, false)).toBe(0);
    expect(nextRung(0, false)).toBe(0);
  });
  test('a run is passed when more than half the rounds are right', () => {
    expect(passed([round(true), round(true), round(false)])).toBe(true);
    expect(passed([round(true), round(false), round(false)])).toBe(false);
    expect(passed([round(true), round(false)])).toBe(false);
    expect(passed([round(true)])).toBe(true);
    expect(passed([])).toBe(false);
  });
  test('a stored rung is only trusted when it is 0, 1 or 2', () => {
    expect(parseRung('2', 3)).toBe(2);
    expect(parseRung('3', 3)).toBe(0);
    expect(parseRung('-1', 3)).toBe(0);
    expect(parseRung('x', 3)).toBe(0);
    expect(parseRung(null, 3)).toBe(0);
  });
});

describe('the report', () => {
  const base = { activityId: 'ho-test', skill: 'binding-curves', rung: 1 };
  test('one criterion per round, no grade, a shape the host accepts', () => {
    const r = buildReport({ ...base, rounds: [round(true), round(false, 'Places the value close to 0.5', 'Expected it to rise'), round(true)], finished: true });
    expect(() => validatePracticeResult(r)).not.toThrow();
    expect(r.valid).toBe(true);
    expect(r.criteria).toHaveLength(3);
    expect(r.criteria.map((c) => c.met)).toEqual([true, false, true]);
    expect(r.criteria.map((c) => c.id)).toEqual(['round-1', 'round-2', 'round-3']);
    expect(r.criteria.every((c) => c.skill === 'binding-curves' && c.weight === 1)).toBe(true);
    expect(r.misconceptions).toEqual(['Expected it to rise']);
    expect(r.skills?.[0]).toEqual({ id: 'binding-curves', evidence: 0.67 });
    expect(Object.keys(r)).not.toContain('grade');
    expect(r.note).toContain('moves up');
  });
  test('a run ended early does not count and has no criteria', () => {
    const r = buildReport({ ...base, rounds: [round(true)], finished: false });
    expect(r.valid).toBe(false);
    expect(r.criteria).toEqual([]);
    expect(() => validatePracticeResult(r)).not.toThrow();
  });
  test('a fixed level does not say the rung will move', () => {
    const r = buildReport({ ...base, rounds: [round(true), round(true), round(true)], finished: true, fixed: true });
    expect(r.note).not.toContain('Next time');
  });
  test('long words are clipped to what the host accepts', () => {
    const r = buildReport({ ...base, rounds: [round(true, 'x'.repeat(500), 'y'.repeat(500))], finished: true });
    expect(() => validatePracticeResult(r)).not.toThrow();
  });
  test('a run has three rounds', () => expect(ROUNDS).toBe(3));
});

describe('the built catalogue', () => {
  test('is valid and carries the engine and spec in each launch', () => {
    const file = join(import.meta.dir, '..', 'assets', 'practice', 'catalogue.json');
    const catalogue = JSON.parse(readFileSync(file, 'utf8'));
    expect(() => validatePracticeCatalogue(catalogue)).not.toThrow();
    expect(catalogue.activities.length).toBeGreaterThanOrEqual(3);
    for (const a of catalogue.activities) {
      expect(Object.keys(engines)).toContain(a.launch.engine);
      expect(typeof a.launch.spec).toBe('object');
      if (a.launch.engine === 'dial') expect(typeof a.launch.spec.expression).toBe('string');
      expect(a.family).toBeTruthy();
    }
  });
});

describe('a rung that gives the answer away names nothing it tested', () => {
  const covered = (met: boolean): RoundResult => ({ ...round(met), covers: ['item-1'] });
  test('below creditFrom every round says it tested nothing, so the host counts nothing from the activity list either', () => {
    const r = buildReport({ activityId: 'a', skill: 's', rung: 0, rounds: [covered(true), round(true), round(true)], finished: true, creditFrom: 1 });
    expect(r.criteria.map((c) => c.covers)).toEqual([[], [], []]);
    expect(validatePracticeResult(r)).toBeTruthy();
  });
  test('at creditFrom a round reports what it tested, and a round that names nothing still names nothing', () => {
    const r = buildReport({ activityId: 'a', skill: 's', rung: 1, rounds: [covered(true), round(true), round(true)], finished: true, creditFrom: 1 });
    expect(r.criteria[0].covers).toEqual(['item-1']);
    expect(r.criteria[1].covers).toBeUndefined();
  });
  test('with no creditFrom every rung counts as before', () => {
    const r = buildReport({ activityId: 'a', skill: 's', rung: 0, rounds: [covered(true)], finished: true });
    expect(r.criteria[0].covers).toEqual(['item-1']);
  });
  test('every engine but Sort names covers from its rung, and Find the Error from rung 1 because a passage at rung 0 is short', () => {
    expect(Object.fromEntries(Object.values(engines).map((e) => [e.id, creditFrom(e.id)]))).toEqual({
      construct: 1, controls: 1, dial: 1, grow: 0, network: 1, predict: 1, sort: 3, spectrum: 2, spot: 1,
    });
  });
  test('Sort is the one engine that never names covers', () => {
    expect([...NAMES_COVERS].sort()).toEqual(['construct', 'controls', 'dial', 'grow', 'network', 'predict', 'spectrum', 'spot']);
    expect(NAMES_COVERS.has('sort')).toBe(false);
  });
  test('the catalogue carries covers for the engines that name them, and none for Sort', () => {
    const catalogue = JSON.parse(readFileSync(join(import.meta.dir, '..', 'assets', 'practice', 'catalogue.json'), 'utf8'));
    const named = catalogue.activities.filter((a: { covers?: string[] }) => a.covers?.length);
    expect(named.length).toBeGreaterThan(0);
    for (const a of catalogue.activities) {
      if (a.launch.engine === 'sort') expect(`${a.id} ${JSON.stringify(a.covers ?? []) + (JSON.stringify(a.launch.spec).includes('"covers"') ? ' in spec' : '')}`).toBe(`${a.id} []`);
      for (const item of a.covers ?? []) expect(item).toMatch(/^pt_/);
    }
    expect(new Set(named.map((a: { launch: { engine: string } }) => a.launch.engine))).toContain('spot');
  });
});
