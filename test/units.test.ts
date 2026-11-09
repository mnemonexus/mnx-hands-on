import { describe, expect, test } from 'bun:test';
import { convert, parseTyped, readAnswer } from '../src/units';

describe('numbers as people type them', () => {
  test('plain, scientific and written-out powers of ten', () => {
    const v = (text: string) => { const r = parseTyped(text); if (!r.ok) throw new Error(r.problem); return r; };
    expect(v('0.35').value).toBe(0.35);
    expect(v('.35').value).toBe(0.35);
    expect(v('0,35').value).toBe(0.35);
    expect(v('1e-4 M').value).toBe(1e-4);
    expect(v('1.0 x 10^-4 M')).toMatchObject({ value: 1e-4, unit: 'M' });
    expect(v('1.0 × 10⁻⁴ M').value).toBeCloseTo(1e-4, 15);
    expect(v('5.7*10^3 M^-1 cm^-1')).toMatchObject({ unit: 'M^-1 cm^-1' });
    expect(v('10^-6 M').value).toBe(1e-6);
    expect(v('−3 kJ/mol')).toMatchObject({ value: -3, unit: 'kJ/mol' });
    expect(v('£4')).toMatchObject({ value: 4, unit: '£' });
  });
  test('words are not numbers', () => {
    expect(parseTyped('about ten').ok).toBe(false);
    expect(parseTyped('').ok).toBe(false);
  });
});

describe('units', () => {
  test('prefixes and compound units convert', () => {
    expect(convert(350, 'µM', 'mM')).toBeCloseTo(0.35, 12);
    expect(convert(1, 'mol/L', 'M')).toBeCloseTo(1, 12);
    expect(convert(1, 'mol dm^-3', 'mM')).toBeCloseTo(1000, 9);
    expect(convert(2, 'min', 's')).toBe(120);
    expect(convert(5, 'cm', 'm')).toBeCloseTo(0.05, 12);
    expect(convert(1, 'M^-1 cm^-1', 'M-1 cm-1')).toBeCloseTo(1, 12);
    expect(convert(1, 'kJ/mol', 'J mol^-1')).toBeCloseTo(1000, 9);
    expect(convert(90, '°', 'rad')).toBeCloseTo(Math.PI / 2, 12);
    expect(convert(50, '%', '')).toBeCloseTo(0.5, 12);
  });
  test('different things do not convert', () => {
    expect(convert(1, 'M', 's')).toBeNull();
    expect(convert(1, 'm', 's')).toBeNull();
    expect(convert(1, '£', '$')).toBeNull();
    expect(convert(1, 'AU', 'M')).toBeNull();
  });
  test('an answer is read in the unit that was asked for', () => {
    expect(readAnswer('350 µM', 'mM')).toEqual({ ok: true, value: expect.closeTo(0.35, 12) });
    expect(readAnswer('0.35', '')).toEqual({ ok: true, value: 0.35 });
    expect(readAnswer('35 %', '')).toEqual({ ok: true, value: expect.closeTo(0.35, 12) });
    expect(readAnswer('21 s', 's')).toEqual({ ok: true, value: 21 });
    expect(readAnswer('0.35', 'mM')).toMatchObject({ ok: false, kind: 'needs-unit' });
    expect(readAnswer('0.35 s', 'mM')).toMatchObject({ ok: false, kind: 'wrong-unit' });
    expect(readAnswer('', 'mM')).toMatchObject({ ok: false, kind: 'empty' });
    expect(readAnswer('abc', 'mM')).toMatchObject({ ok: false, kind: 'unreadable' });
  });
});
