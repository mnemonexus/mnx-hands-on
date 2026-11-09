/**
 * Reading "350 µM", "5.7e3 M^-1 cm^-1" or "1.0 x 10^-4 M" as typed, and comparing it with an expected value in another
 * unit of the same kind. A student may answer in any unit that means the same thing: 350 µM is 0.35 mM.
 *
 * Units are broken into SI base dimensions. A name this file does not know ("AU", "£") counts as a unit of its own, so it
 * only matches itself. Pure: no DOM.
 */

type Dims = Record<string, number>;
interface Base { dims: Dims; factor: number; prefix: boolean }

const PI = Math.PI;
const BASES: Record<string, Base> = {
  s: { dims: { s: 1 }, factor: 1, prefix: true },
  min: { dims: { s: 1 }, factor: 60, prefix: false },
  h: { dims: { s: 1 }, factor: 3600, prefix: false },
  d: { dims: { s: 1 }, factor: 86400, prefix: false },
  Hz: { dims: { s: -1 }, factor: 1, prefix: true },
  m: { dims: { m: 1 }, factor: 1, prefix: true },
  'Å': { dims: { m: 1 }, factor: 1e-10, prefix: false },
  g: { dims: { kg: 1 }, factor: 1e-3, prefix: true },
  Da: { dims: { kg: 1 }, factor: 1.66054e-27, prefix: true },
  mol: { dims: { mol: 1 }, factor: 1, prefix: true },
  L: { dims: { m: 3 }, factor: 1e-3, prefix: true },
  l: { dims: { m: 3 }, factor: 1e-3, prefix: true },
  M: { dims: { mol: 1, m: -3 }, factor: 1000, prefix: true },
  Pa: { dims: { kg: 1, m: -1, s: -2 }, factor: 1, prefix: true },
  bar: { dims: { kg: 1, m: -1, s: -2 }, factor: 1e5, prefix: true },
  atm: { dims: { kg: 1, m: -1, s: -2 }, factor: 101325, prefix: false },
  N: { dims: { kg: 1, m: 1, s: -2 }, factor: 1, prefix: true },
  J: { dims: { kg: 1, m: 2, s: -2 }, factor: 1, prefix: true },
  cal: { dims: { kg: 1, m: 2, s: -2 }, factor: 4.184, prefix: true },
  W: { dims: { kg: 1, m: 2, s: -3 }, factor: 1, prefix: true },
  K: { dims: { K: 1 }, factor: 1, prefix: true },
  V: { dims: { kg: 1, m: 2, s: -3, A: -1 }, factor: 1, prefix: true },
  A: { dims: { A: 1 }, factor: 1, prefix: true },
  rad: { dims: { rad: 1 }, factor: 1, prefix: false },
  '°': { dims: { rad: 1 }, factor: PI / 180, prefix: false },
  deg: { dims: { rad: 1 }, factor: PI / 180, prefix: false },
  '%': { dims: {}, factor: 0.01, prefix: false },
};
const PREFIXES: Record<string, number> = {
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, d: 1e-1, c: 1e-2, m: 1e-3,
  'µ': 1e-6, 'μ': 1e-6, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18,
};

export interface UnitInfo { dims: Dims; factor: number }

const SUPERSCRIPTS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };
const unsuper = (text: string) => text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/g, (c) => SUPERSCRIPTS[c] ?? c);

function addDims(into: Dims, dims: Dims, power: number) {
  for (const [k, v] of Object.entries(dims)) {
    const next = (into[k] ?? 0) + v * power;
    if (next === 0) delete into[k]; else into[k] = next;
  }
}

/** One name with its power, like "cm^-1": the base, any prefix, and the exponent. */
function factorOf(token: string): { dims: Dims; factor: number; exp: number } | null {
  const m = /^(.*?)(?:\^?\(?(-?\d+)\)?)?$/.exec(unsuper(token).replace(/−/g, '-'));
  if (!m || !m[1]) return null;
  const name = m[1];
  const exp = m[2] !== undefined ? Number(m[2]) : 1;
  const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);
  if (own(BASES, name)) return { ...BASES[name], exp };
  if (name.length > 1) {
    const p = own(PREFIXES, name[0]) ? PREFIXES[name[0]] : undefined;
    const base = own(BASES, name.slice(1)) ? BASES[name.slice(1)] : undefined;
    if (p !== undefined && base?.prefix) return { dims: base.dims, factor: base.factor * p, exp };
  }
  // A name this file does not know is a unit of its own.
  return { dims: { [`#${name}`]: 1 }, factor: 1, exp };
}

/** "M^-1 cm^-1", "kJ/mol", "mol L-1", "µM": its size in SI and what it is a unit of. Null when it cannot be read. */
export function unitInfo(unit: string): UnitInfo | null {
  const text = unit.trim();
  if (!text) return { dims: {}, factor: 1 };
  const dims: Dims = {};
  let factor = 1;
  const [top, ...rest] = text.replace(/[·*]/g, ' ').split('/');
  for (const [part, sign] of [[top, 1], ...rest.map((r) => [r, -1] as const)] as [string, number][]) {
    for (const token of part.split(/\s+/).filter(Boolean)) {
      const f = factorOf(token);
      if (!f) return null;
      addDims(dims, f.dims, f.exp * sign);
      factor *= Math.pow(f.factor, f.exp * sign);
    }
  }
  return { dims, factor };
}

const sameDims = (a: Dims, b: Dims) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
};

/** A value in one unit as a value in another, or null when they measure different things. */
export function convert(value: number, from: string, to: string): number | null {
  const a = unitInfo(from); const b = unitInfo(to);
  if (!a || !b || !sameDims(a.dims, b.dims)) return null;
  return (value * a.factor) / b.factor;
}

/** True when a unit is a bare number (no unit, or a percentage): a student may leave it off. */
export function isDimensionless(unit: string): boolean {
  const info = unitInfo(unit);
  return !!info && Object.keys(info.dims).length === 0;
}

// ── What a student typed ─────────────────────────────────────────────────────

export type Typed = { ok: true; value: number; unit: string } | { ok: false; problem: string };

const MINUS = /[−–]/g;
const SUPER_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺';

/**
 * A number and the unit after it. Understands 0.35, .35, 1e-4, 1E-4, 1.0 x 10^-4, 1.0 × 10⁻⁴, 1.0*10-4 and a
 * comma used as a decimal point. Whatever follows the number is the unit.
 */
export function parseTyped(text: string): Typed {
  let raw = text.replace(MINUS, '-').trim();
  const money = /^([£$€])\s*(.*)$/.exec(raw);
  if (money) raw = `${money[2]} ${money[1]}`;
  if (!raw) return { ok: false, problem: 'Type a number first.' };
  const bare = /^10\s*\^\s*\(?\s*([+-]?\d+)\s*\)?\s*(.*)$/.exec(raw);
  if (bare) return { ok: true, value: Math.pow(10, Number(bare[1])), unit: bare[2].trim() };
  const m =new RegExp(`^([+-]?)\\s*(\\d+(?:[.,]\\d+)?|[.,]\\d+)\\s*(?:(?:[eE]\\s*([+-]?\\d+))|(?:[x×X*·]\\s*10\\s*(?:\\^|\\*\\*)?\\s*\\(?\\s*([+-]?\\d+|[${SUPER_DIGITS}]+)\\s*\\)?))?\\s*(.*)$`).exec(raw);
  if (!m) return { ok: false, problem: 'Start with the number, for example 0.35 mM.' };
  const [, sign, mantissa, e1, e2, unit] = m;
  const exponent = e1 !== undefined ? Number(e1) : e2 !== undefined ? Number(unsuper(e2)) : 0;
  const value = Number(`${sign}${mantissa.replace(',', '.')}`) * Math.pow(10, exponent);
  if (!Number.isFinite(value)) return { ok: false, problem: 'That number is too large to read.' };
  return { ok: true, value, unit: unit.trim() };
}

export type Reading =
  | { ok: true; value: number }
  | { ok: false; problem: string; kind: 'empty' | 'needs-unit' | 'wrong-unit' | 'unreadable' };

/** The typed text as a number in `expectedUnit`, or what is wrong with it, in words a student can act on. */
export function readAnswer(text: string, expectedUnit: string): Reading {
  const typed = parseTyped(text);
  if (!typed.ok) return { ok: false, kind: text.trim() ? 'unreadable' : 'empty', problem: typed.problem };
  if (!typed.unit) {
    if (isDimensionless(expectedUnit)) return { ok: true, value: typed.value };
    return { ok: false, kind: 'needs-unit', problem: `Include the unit, for example ${expectedUnit.replace(/\^\(?(-?\d+)\)?/g, '^$1')}.` };
  }
  if (!unitInfo(typed.unit)) return { ok: false, kind: 'unreadable', problem: `I could not read the unit "${typed.unit}".` };
  const value = convert(typed.value, typed.unit, expectedUnit);
  if (value === null) return { ok: false, kind: 'wrong-unit', problem: `"${typed.unit}" measures something else. This one is in ${expectedUnit || 'plain numbers'}.` };
  return { ok: true, value };
}
