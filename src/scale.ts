/** Axis maths and number formatting. Pure: no DOM, so the build script and the tests can use it. */

export type ScaleKind = 'linear' | 'log';
export interface Scale { min: number; max: number; scale: ScaleKind }

/** Where a value sits on its axis, 0 at the minimum and 1 at the maximum (may fall outside 0..1). */
export function toUnit(axis: Scale, value: number): number {
  if (axis.scale === 'log') return (Math.log(value) - Math.log(axis.min)) / (Math.log(axis.max) - Math.log(axis.min));
  return (value - axis.min) / (axis.max - axis.min);
}

/** The value at a place on the axis, the inverse of `toUnit`. */
export function fromUnit(axis: Scale, unit: number): number {
  if (axis.scale === 'log') return Math.exp(Math.log(axis.min) + unit * (Math.log(axis.max) - Math.log(axis.min)));
  return axis.min + unit * (axis.max - axis.min);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ── Ticks ────────────────────────────────────────────────────────────────────

export interface Tick { value: number; major: boolean }

/** Round steps of 1, 2 or 5 times a power of ten. */
function niceStep(range: number, target: number): number {
  const raw = range / target;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / power;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * power;
}

export function ticks(axis: Scale, target = 6): Tick[] {
  const out: Tick[] = [];
  if (axis.scale === 'log') {
    const lo = Math.floor(Math.log10(axis.min) + 1e-9);
    const hi = Math.ceil(Math.log10(axis.max) - 1e-9);
    for (let e = lo; e <= hi; e++) {
      for (let m = 1; m < 10; m++) {
        const value = m * Math.pow(10, e);
        if (value < axis.min * (1 - 1e-9) || value > axis.max * (1 + 1e-9)) continue;
        out.push({ value, major: m === 1 });
      }
    }
    // A long log axis gets crowded with decades; thin the labels, never the decades themselves.
    return out;
  }
  const step = niceStep(axis.max - axis.min, target);
  const first = Math.ceil(axis.min / step - 1e-9);
  for (let i = first; i * step <= axis.max + step * 1e-9; i++) out.push({ value: Number((i * step).toPrecision(12)), major: true });
  return out;
}

// ── Numbers as words ─────────────────────────────────────────────────────────

const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
export const superscript = (text: string) => text.replace(/[0-9-]/g, (c) => SUP[c] ?? c);

/** A number to `digits` significant figures, without a trailing zero. Small and large values use powers of ten. */
export function fmt(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '?';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-3) {
    const [m, e] = value.toExponential(digits - 1).split('e');
    const mantissa = String(Number(m));
    const exp = Number(e);
    return mantissa === '1' ? `10${superscript(String(exp))}` : mantissa === '-1' ? `−10${superscript(String(exp))}` : `${mantissa.replace('-', '−')} × 10${superscript(String(exp))}`;
  }
  return String(Number(value.toPrecision(digits))).replace('-', '−');
}

/** Superscript powers in a unit: "M^-1 cm^-1" reads "M⁻¹ cm⁻¹". */
export function prettyUnit(unit: string): string {
  return unit.replace(/\^\(?(-?\d+)\)?/g, (_, n: string) => superscript(n));
}

/** A value with its unit: "20 µM", "0.333", "5690 M⁻¹ cm⁻¹". */
export function withUnit(value: number, unit: string, digits = 3): string {
  const u = prettyUnit(unit);
  if (!u) return fmt(value, digits);
  if (/^[£$€]/.test(u)) return `${u}${fmt(value, digits)}`;
  return /^[%°]/.test(u) ? `${fmt(value, digits)}${u}` : `${fmt(value, digits)} ${u}`;
}

/** Axis labels are shorter: "10⁴", "0.01", "250". */
export function tickLabel(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e4 || abs < 1e-2) {
    const exp = Math.round(Math.log10(abs));
    if (Math.abs(abs / Math.pow(10, exp) - 1) < 1e-9) return `10${superscript(String(exp))}`;
  }
  return fmt(value, 3);
}

/** A first letter in capitals, for the start of a sentence. */
export const cap = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);
