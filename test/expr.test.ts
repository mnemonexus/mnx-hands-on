import { describe, expect, test } from 'bun:test';
import { ExprError, compile, symbolsOf } from '../src/expr';

const calc = (src: string, names: string[] = [], values: number[] = []) => compile(src, names)(values);

describe('the formula parser', () => {
  test('arithmetic and precedence', () => {
    expect(calc('1 + 2 * 3')).toBe(7);
    expect(calc('(1 + 2) * 3')).toBe(9);
    expect(calc('10 / 4 - 1')).toBe(1.5);
    expect(calc('2 ^ 3 ^ 2')).toBe(512);
    expect(calc('-2 ^ 2')).toBe(-4);
    expect(calc('2 ^ -1')).toBe(0.5);
    expect(calc('-(1 + 2)')).toBe(-3);
    expect(calc('1e-6 * 1e6')).toBeCloseTo(1, 12);
    expect(calc('.5 + 0.25')).toBe(0.75);
  });
  test('functions and constants', () => {
    expect(calc('ln(exp(2))')).toBeCloseTo(2, 12);
    expect(calc('log10(1000)')).toBeCloseTo(3, 12);
    expect(calc('sqrt(16) + abs(-3)')).toBe(7);
    expect(calc('min(3, 1, 2) + max(1, 5)')).toBe(6);
    expect(calc('sin(pi / 2)')).toBeCloseTo(1, 12);
    expect(calc('2 * pi')).toBeCloseTo(Math.PI * 2, 12);
  });
  test('symbols, including Greek letters and digits', () => {
    expect(calc('L / (Kd + L)', ['L', 'Kd'], [2, 2])).toBe(0.5);
    expect(calc('ε * c * l', ['ε', 'c', 'l'], [5690, 1e-4, 1])).toBeCloseTo(0.569, 12);
    expect(calc('Abs0 * exp(-kobs * t)', ['Abs0', 'kobs', 't'], [0.4, Math.LN2, 1])).toBeCloseTo(0.2, 12);
    expect(symbolsOf('L / (Kd + L) * pi')).toEqual(['L', 'Kd']);
  });
  test('says where a formula is wrong', () => {
    const fails = (src: string, names: string[] = []) => { try { compile(src, names); } catch (e) { return e as ExprError; } return null; };
    expect(fails('1 +')?.message).toContain('ends');
    expect(fails('(1 + 2')?.message).toContain('")"');
    expect(fails('2x', ['x'])?.message).toContain('"*"');
    expect(fails('foo + 1')?.message).toContain('"foo"');
    expect(fails('sqrt(1, 2)')?.message).toContain('takes 1');
    expect(fails('nope(1)')?.message).toContain('"nope"');
    expect(fails('1 $ 2')?.position).toBe(2);
    expect(fails('')?.message).toContain('empty');
  });
  test('cannot run code: only the listed words mean anything', () => {
    for (const hostile of ['constructor', 'process.exit()', 'this', '__proto__', 'alert(1)', 'Function("return 1")()', '"a"', 'x[0]', 'x = 1']) {
      expect(() => compile(hostile, ['x'])).toThrow();
    }
    expect(() => compile('toString', ['x'])).toThrow();
  });
  test('does not recurse without limit', () => {
    expect(() => compile('('.repeat(200) + '1' + ')'.repeat(200))).toThrow();
  });
});
