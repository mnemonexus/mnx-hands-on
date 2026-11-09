/**
 * Read the Spectrum, the logic: no DOM. A spec says what is being measured (a mass range, or peptide sequences), how it is
 * ionised and which modifications may turn up. It never gives an answer. The engine builds a simulated spectrum from exact
 * physics (protons, the 13C spacing, residue masses), so a fresh problem is never short and a slip in a spec cannot teach
 * something false. Intensity is qualitative: heights are only illustrative.
 *
 * Rungs (the task is chosen by seed):
 *   0  isotope   one charge, from the spacing of isotope peaks
 *   1  pair      charge and mass, from two neighbouring peaks of a charge series (working shown on request)
 *   2  deconvolute  the mass from a whole series, unaided; ladder  a b or y ladder, a residue at a time;
 *      shift     which modification, and how many, from a mass shift
 */
import { hashSeed, rng, roundOf, type RoundResult } from '../../engine';
import { ExprError, compile } from '../../expr';
import {
  C13_SPACING, PROTON, RESIDUES, WATER, adductMz, fragmentMzs, massFrom, mzOf, peptideMass, residueGroup,
  type MassType,
} from './masses';

// ── The spec ─────────────────────────────────────────────────────────────────

export interface SpecMod { id: string; name: string; delta: number; residues?: string[] }
export interface SpecAdduct { name: string; mass: number }
export interface SpectrumSpec {
  mode: 'positive' | 'negative';
  /** Which mass the course uses: monoisotopic (the lightest isotopes) or average (weighted by abundance). */
  massType: MassType;
  /** A molecule whose mass is drawn from this range (in Da) for each problem. */
  mass?: { min: number; max: number; name?: string };
  /** Peptides, by sequence in one-letter code. A mass is worked out from each. */
  peptides?: Array<{ name?: string; sequence: string }>;
  modifications?: SpecMod[];
  /** The lowest and highest charge a series may hold. */
  charges: [number, number];
  /** Cations that may take the place of a proton, drawn as smaller satellite peaks (positive mode only). */
  adducts?: SpecAdduct[];
  /** Which fragment ladders may be read. */
  ions?: Array<'y' | 'b'>;
  /** Which tasks rung 2 may set. Default: every one the spec has what it needs for. */
  tasks?: Array<'deconvolute' | 'ladder' | 'shift'>;
  /** Da allowed either side of the true mass for typed masses. */
  tolerance?: number;
  note?: string;
}

export type Kind = 'isotope' | 'pair' | 'deconvolute' | 'ladder' | 'shift';
export interface Peak {
  id: number;
  mz: number;
  /** Relative height, 0 to 1. Only illustrative. */
  h: number;
  role: 'iso' | 'main' | 'adduct' | 'y' | 'b' | 'before' | 'after';
  z?: number;
  /** For fragment ions, the number in y3 or b5. */
  ion?: number;
  tag?: string;
}
export interface LadderRow { from: number | null; to: number; delta: number; answer: string; ask: string; label: string }

export type SpectrumAttempt =
  | { kind: 'charge'; z: number }
  | { kind: 'pair'; z: number; mass: number; text: string }
  | { kind: 'mass'; mass: number; text: string }
  | { kind: 'ladder'; picks: string[] }
  | { kind: 'shift'; mod: string; count: number };

export interface SpectrumTask {
  spec: SpectrumSpec;
  rung: number;
  kind: Kind;
  mode: 'positive' | 'negative';
  massType: MassType;
  decimals: number;
  peaks: Peak[];
  xmin: number;
  xmax: number;
  announce: string;
  question: string;
  /** The neutral mass of the thing measured, in Da. */
  M: number;
  /** The charge of an isotope cluster, or of both peaks of a shift. */
  z: number;
  /** For a pair: the charge on the right-hand peak, and the ids of the two neighbours (left then right). */
  n: number;
  pair: [number, number];
  /** Ids of the main peaks of a series, lowest m/z first. */
  series: number[];
  tolerance: number;
  ionKind: 'y' | 'b';
  sequence: string;
  rows: LadderRow[];
  mod: SpecMod | null;
  count: number;
  options: SpecMod[];
  /** For a shift: the sum of the true modification in Da. */
  delta: number;
}

// ── Reading what a student typed ─────────────────────────────────────────────

/** A mass as typed: a number, or a sum such as 15 * (824.85 - 1.00728), with or without Da or kDa. */
export function readMass(text: string): { ok: true; value: number } | { ok: false; problem: string } {
  let raw = text.replace(/[−–]/g, '-').replace(/[×·]/g, '*').trim();
  if (!raw) return { ok: false, problem: 'Type the mass first.' };
  let factor = 1;
  const unit = /\s*(k?Da|kDa|u)$/i.exec(raw);
  if (unit) { if (/^k/i.test(unit[1])) factor = 1000; raw = raw.slice(0, unit.index).trim(); }
  raw = raw.replace(/(\d),(\d{3})(?!\d)/g, '$1$2').replace(/(\d),(\d)/g, '$1.$2').replace(/\s+x\s+/g, '*');
  if (!/^[0-9eE.+\-*/() ^]+$/.test(raw)) return { ok: false, problem: 'Type a number, or a sum such as 15 * (824.85 - 1.007).' };
  try {
    const value = compile(raw, [])([]) * factor;
    if (!Number.isFinite(value)) return { ok: false, problem: 'That does not work out to a number.' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, problem: error instanceof ExprError ? `I could not read that sum: ${error.message}.` : 'I could not read that.' };
  }
}

// ── Numbers as words ─────────────────────────────────────────────────────────

/** A number to a fixed number of decimals, with a real minus sign and no thousands separator inside peak labels. */
export function fixed(value: number, decimals: number, group = false): string {
  const s = Math.abs(value).toFixed(decimals);
  const [int, frac] = s.split('.');
  const body = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int;
  return `${value < 0 && Number(s) !== 0 ? '−' : ''}${body}${frac ? `.${frac}` : ''}`;
}
export const chargeText = (z: number, mode: 'positive' | 'negative') => `${z}${mode === 'positive' ? '+' : '−'}`;
const joinWords = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

// ── Checking a spec ──────────────────────────────────────────────────────────

const LETTERS = new Set(Object.keys(RESIDUES.monoisotopic));
const MIN_MZ = 100;
const MAX_MZ = 6000;
export const MAX_SPEC_CHARS = 4096;
const SEPARATION = 0.02;

/** Every modification-and-count combination a shift may be, with its summed mass. */
export function shiftCandidates(mods: readonly SpecMod[]): Array<{ mod: SpecMod; count: number; total: number }> {
  return mods.flatMap((mod) => [1, 2, 3].map((count) => ({ mod, count, total: mod.delta * count })));
}

export function issues(input: SpectrumSpec): string[] {
  const out: string[] = [];
  const bad = (m: string) => { if (out.length < 14) out.push(m); };
  if (!input || typeof input !== 'object') return ['The spec is not an object.'];
  const spec = input;
  if (spec.mode !== 'positive' && spec.mode !== 'negative') bad('`mode` must be "positive" or "negative".');
  if (spec.massType !== 'monoisotopic' && spec.massType !== 'average') bad('`massType` must be "monoisotopic" or "average": say which mass the course uses.');
  const [lo, hi] = Array.isArray(spec.charges) ? spec.charges : [NaN, NaN];
  if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 1 && hi <= 60 && hi > lo)) bad('`charges` must be two whole numbers, lowest then highest, such as [2, 8]: a series needs at least two charge states.');
  const hasMass = !!spec.mass;
  const peptides = Array.isArray(spec.peptides) ? spec.peptides : [];
  if (!hasMass && !peptides.length) bad('Give a `mass` range or some `peptides` to measure.');
  if (spec.mass) {
    const { min, max } = spec.mass;
    if (!(typeof min === 'number' && typeof max === 'number' && min >= 200 && max <= 200000 && max - min >= 100)) bad('`mass` needs `min` and `max` in Da, at least 100 apart, between 200 and 200000.');
    if (spec.mass.name !== undefined && (typeof spec.mass.name !== 'string' || spec.mass.name.length > 60)) bad('`mass.name` is a short name, at most 60 characters.');
  }
  for (const [i, p] of peptides.entries()) {
    const seq = p?.sequence;
    if (typeof seq !== 'string' || !/^[A-Z]{6,30}$/.test(seq) || [...seq].some((l) => !LETTERS.has(l))) bad(`Peptide ${i + 1}: \`sequence\` must be 6 to 30 amino-acid letters (one-letter code, capitals).`);
  }
  const mods = Array.isArray(spec.modifications) ? spec.modifications : [];
  const ids = new Set<string>();
  for (const [i, m] of mods.entries()) {
    if (!m || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{1,23}$/.test(m.id)) { bad(`Modification ${i + 1}: \`id\` must be lower-case letters, digits or - (2 to 24 characters).`); continue; }
    if (ids.has(m.id)) bad(`Modification "${m.id}" is used twice.`);
    ids.add(m.id);
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) bad(`Modification "${m.id}": \`name\` must be a short name, at most 40 characters.`);
    if (!(typeof m.delta === 'number' && Number.isFinite(m.delta) && Math.abs(m.delta) >= 0.5 && Math.abs(m.delta) <= 1000)) bad(`Modification "${m.id}": \`delta\` must be the mass change in Da (0.5 to 1000, with its sign).`);
    if (m.residues !== undefined && (!Array.isArray(m.residues) || m.residues.some((r) => r !== 'N-term' && !LETTERS.has(r)))) bad(`Modification "${m.id}": \`residues\` must be amino-acid letters, or "N-term".`);
  }
  for (const a of spec.adducts ?? []) {
    if (!(typeof a?.name === 'string' && typeof a.mass === 'number' && a.mass > 1 && a.mass < 200)) bad('Each adduct needs a `name` and the `mass` of the cation in Da (above 1).');
  }
  if ((spec.adducts?.length ?? 0) > 0 && spec.mode === 'negative') bad('Adducts are only drawn in positive mode: remove them or set `mode` to "positive".');
  if (spec.ions !== undefined && (!Array.isArray(spec.ions) || !spec.ions.length || spec.ions.some((x) => x !== 'y' && x !== 'b'))) bad('`ions` must list "y", "b" or both.');
  if (spec.tasks !== undefined) {
    const have = kindsFor({ ...spec, tasks: undefined }, 2);
    if (!Array.isArray(spec.tasks) || !spec.tasks.length || spec.tasks.some((k) => !have.includes(k))) bad(`\`tasks\` must name tasks this spec can set: ${have.join(', ')}.`);
  }
  if (spec.tolerance !== undefined && !(typeof spec.tolerance === 'number' && spec.tolerance >= 0.05 && spec.tolerance <= 5)) bad('`tolerance` is a number of Da from 0.05 to 5.');
  if (spec.note !== undefined && (typeof spec.note !== 'string' || spec.note.length > 200)) bad('`note` must be a sentence of at most 200 characters.');
  if (out.length) return out;

  if (JSON.stringify(spec).length > MAX_SPEC_CHARS) bad(`The spec is ${JSON.stringify(spec).length} characters; the catalogue allows ${MAX_SPEC_CHARS}.`);
  // Every series must sit where an instrument measures.
  const masses = [...(spec.mass ? [spec.mass.min, spec.mass.max] : []), ...peptides.map((p) => peptideMass(p.sequence, spec.massType))];
  for (const M of masses) for (const z of [lo, hi]) {
    const x = mzOf(M, z, spec.mode);
    if (x < MIN_MZ || x > MAX_MZ) bad(`A mass of ${fixed(M, 1)} Da at charge ${z} sits at m/z ${fixed(x, 1)}, outside ${MIN_MZ} to ${MAX_MZ}. Narrow \`charges\` or the mass.`);
  }
  // Modifications must be told apart by mass.
  const all = shiftCandidates(mods);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (all[i].mod.id !== all[j].mod.id && Math.abs(all[i].total - all[j].total) < SEPARATION) bad(`${all[i].count} × ${all[i].mod.name} and ${all[j].count} × ${all[j].mod.name} differ by less than ${SEPARATION} Da, so a shift cannot tell them apart.`);
  }
  for (const pep of peptides) {
    if (mods.length && !shiftAnswers(spec, pep.sequence).length) bad(`No modification in the list can sit on peptide ${pep.sequence}. Add its \`residues\`, or a modification that fits.`);
  }
  if (!out.length) {
    for (let rung = 0; rung < 3; rung++) for (let k = 0; k < 24; k++) {
      try {
        const t = prepare(spec, `check${k}:${k % 3}`, rung);
        for (const p of t.peaks) if (!Number.isFinite(p.mz)) throw new Error('a peak is not a number');
        if (t.peaks.some((p) => p.mz < t.xmin || p.mz > t.xmax)) throw new Error('a peak falls outside the drawn range');
      } catch (error) { bad(`Could not set a question at rung ${rung}: ${(error as Error).message}`); break; }
    }
  }
  return out;
}

// ── Setting a question ───────────────────────────────────────────────────────

/** The modification and count pairs that may truly be applied to a peptide (it must have the sites for them). */
export function shiftAnswers(spec: SpectrumSpec, sequence: string | null): Array<{ mod: SpecMod; count: number }> {
  const found: Array<{ mod: SpecMod; count: number }> = [];
  for (const mod of spec.modifications ?? []) {
    let sites = 3;
    if (sequence && mod.residues?.length) sites = [...sequence].filter((l) => mod.residues!.includes(l)).length + (mod.residues.includes('N-term') ? 1 : 0);
    else if (sequence && !mod.residues) sites = 3;
    for (let count = 1; count <= Math.min(3, sites); count++) found.push({ mod, count });
  }
  return found;
}

function kindsFor(spec: SpectrumSpec, rung: number): Kind[] {
  if (rung === 0) return ['isotope'];
  if (rung === 1) return ['pair'];
  const kinds: Kind[] = ['deconvolute'];
  if (spec.peptides?.length && spec.mode === 'positive') kinds.push('ladder');
  if (spec.modifications?.length) kinds.push('shift');
  const wanted = spec.tasks?.length ? kinds.filter((k) => spec.tasks!.includes(k as 'deconvolute' | 'ladder' | 'shift')) : kinds;
  return wanted.length ? wanted : kinds;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const niceFloor = (x: number, step: number) => Math.floor(x / step) * step;
const niceCeil = (x: number, step: number) => Math.ceil(x / step) * step;
const poisson = (lambda: number, k: number) => {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
};

export const defaultTolerance = (spec: SpectrumSpec) => spec.tolerance ?? 0.5;
export const isotopeChargeTop = (zlo: number, zhi: number) => Math.max(Math.min(zhi, 12), Math.min(zhi, zlo + 4));

export function prepare(spec: SpectrumSpec, seed: string, rung: number): SpectrumTask {
  const rand = rng(seed);
  const round = roundOf(seed);
  const [zlo, zhi] = spec.charges;
  const mode = spec.mode;
  const kinds = kindsFor(spec, rung);
  const kind = kinds[(hashSeed(seed.replace(/:\d+$/, '')) + round) % kinds.length];
  const pickIn = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length) % list.length];

  // What is measured. A peptide for ladders and shifts that need one; otherwise either kind of analyte.
  const needsPeptide = kind === 'ladder';
  const usePeptide = !!spec.peptides?.length && (needsPeptide || !spec.mass || rand() < 0.5);
  const pep = usePeptide ? pickIn(spec.peptides as NonNullable<SpectrumSpec['peptides']>) : null;
  const M = pep ? peptideMass(pep.sequence, spec.massType) : round2((spec.mass as NonNullable<SpectrumSpec['mass']>).min + rand() * ((spec.mass as NonNullable<SpectrumSpec['mass']>).max - (spec.mass as NonNullable<SpectrumSpec['mass']>).min));
  const what = pep ? `The peptide ${pep.name ? `${pep.name} (${pep.sequence})` : pep.sequence}` : `${spec.mass?.name ? `A sample of ${spec.mass.name}` : 'A molecule of unknown mass'}`;
  const how = `${mode === 'positive' ? 'positive' : 'negative'} ion mode`;
  const massWord = spec.massType === 'monoisotopic' ? 'monoisotopic mass' : 'average mass';

  const task: SpectrumTask = {
    spec, rung, kind, mode, massType: spec.massType, decimals: 2, peaks: [], xmin: 0, xmax: 1, announce: '', question: '',
    M, z: 1, n: 0, pair: [0, 0], series: [], tolerance: defaultTolerance(spec), ionKind: 'y', sequence: pep?.sequence ?? '', rows: [],
    mod: null, count: 0, options: spec.modifications ?? [], delta: 0,
  };
  let nextId = 0;
  const add = (p: Omit<Peak, 'id'>): Peak => { const peak = { ...p, id: nextId++ }; task.peaks.push(peak); return peak; };

  if (kind === 'isotope') {
    // Isotope gaps stay readable up to charge 12. A spec that starts above that reads its own lowest few charges.
    const zTop = isotopeChargeTop(zlo, zhi);
    const z = zlo + Math.floor(rand() * (zTop - zlo + 1));
    const spacing = C13_SPACING / z;
    const lambda = 0.0005 * M;
    const centre = Math.round(lambda);
    const count = lambda < 3 ? Math.max(4, Math.min(6, Math.round(lambda + 3.2))) : 7;
    const first = spec.massType === 'monoisotopic' && lambda < 3 ? 0 : Math.max(0, centre - Math.floor(count / 2));
    const base = mzOf(M, z, mode) - (spec.massType === 'average' ? (centre - first) * spacing : 0);
    const shape = Array.from({ length: count }, (_, i) => poisson(lambda, first + i));
    const tallest = Math.max(...shape);
    shape.forEach((height, i) => { add({ mz: base + i * spacing, h: Math.max(0.06, height / tallest), role: 'iso', z }); });
    task.z = z;
    task.decimals = 3;
    task.xmin = base - 0.75 * spacing;
    task.xmax = base + (count - 1 + 0.75) * spacing;
    task.announce = `${what}, in ${how}. These peaks are all one ion, so each is an isotope of it.`;
    task.question = 'What is the charge on this ion? Measure the gap between two neighbouring peaks.';
    return task;
  }

  if (kind === 'pair' || kind === 'deconvolute') {
    const range = zhi - zlo + 1;
    const L = Math.min(range, kind === 'pair' ? 4 + Math.floor(rand() * 3) : 5 + Math.floor(rand() * 3));
    const z0 = zlo + Math.floor(rand() * (range - L + 1));
    const zTop = z0 + L - 1;
    const centreZ = z0 + (L - 1) / 2 + (rand() - 0.5);
    const sd = Math.max(1.1, L / 3.2);
    const adduct = mode === 'positive' ? spec.adducts?.[0] : undefined;
    for (let i = 0; i < L; i++) {
      const z = zTop - i;
      const h = Math.max(0.18, Math.exp(-0.5 * ((z - centreZ) / sd) ** 2)) * (0.88 + 0.24 * rand());
      task.series.push(add({ mz: mzOf(M, z, mode), h, role: 'main', z }).id);
    }
    const top = Math.max(...task.peaks.map((p) => p.h));
    for (const p of task.peaks) p.h = Math.min(1, p.h / top);
    if (adduct) {
      for (const id of [...task.series]) {
        if (rand() < 0.65) {
          const main = task.peaks[id];
          add({ mz: adductMz(M, main.z as number, adduct.mass), h: Math.max(0.1, main.h * (0.18 + 0.2 * rand())), role: 'adduct', z: main.z, tag: adduct.name });
        }
      }
    }
    const k = Math.floor(rand() * (L - 1));
    task.pair = [task.series[k], task.series[k + 1]];
    task.n = task.peaks[task.series[k + 1]].z as number;
    const mzs = task.peaks.map((p) => p.mz);
    const span = Math.max(...mzs) - Math.min(...mzs);
    const step = span > 600 ? 50 : span > 150 ? 20 : span > 40 ? 10 : 5;
    task.xmin = niceFloor(Math.min(...mzs) - 0.1 * span - step * 0.3, step);
    task.xmax = niceCeil(Math.max(...mzs) + 0.1 * span + step * 0.3, step);
    task.tolerance = defaultTolerance(spec);
    if (kind === 'pair') {
      task.announce = `${what} gives a series of peaks in ${how}. Each peak is the same molecule with a different number of charges. The two peaks marked are neighbours.`;
      task.question = `What charge does the right-hand marked peak carry, and what is the ${massWord} of the molecule, in Da?`;
    } else {
      task.announce = `${what} gives a series of peaks in ${how}. Each peak is the same molecule with a different number of charges.`;
      task.question = `What is the ${massWord} of the molecule, in Da? Work it out from the peaks, with no help.`;
    }
    return task;
  }

  if (kind === 'ladder') {
    const seq = (pep as NonNullable<typeof pep>).sequence;
    const ions = spec.ions ?? ['y', 'b'];
    task.ionKind = pickIn(ions);
    const frag = fragmentMzs(seq, spec.massType);
    const len = seq.length;
    const read = task.ionKind;
    const rowsWanted = Math.max(3, Math.min(4, read === 'y' ? len - 2 : len - 3));
    // Ion numbers to read: y1 to y(rows), or b2 to b(rows + 1).
    const readIons = read === 'y' ? Array.from({ length: rowsWanted }, (_, i) => i + 1) : Array.from({ length: rowsWanted + 1 }, (_, i) => i + 2);
    const readMz = (i: number) => (read === 'y' ? frag.y[i - 1] : frag.b[i - 1]);
    const lo = Math.min(...readIons.map(readMz)) - 22;
    const hi = Math.max(...readIons.map(readMz)) + 30;
    const entries: Array<Omit<Peak, 'id'>> = [];
    for (let i = 1; i < len; i++) {
      if (frag.y[i - 1] >= lo && frag.y[i - 1] <= hi) entries.push({ mz: frag.y[i - 1], h: read === 'y' ? 0.55 + 0.45 * rand() : 0.2 + 0.3 * rand(), role: 'y', ion: i, tag: `y${i}` });
      if (i >= 2 && frag.b[i - 1] >= lo && frag.b[i - 1] <= hi) entries.push({ mz: frag.b[i - 1], h: read === 'b' ? 0.55 + 0.45 * rand() : 0.2 + 0.3 * rand(), role: 'b', ion: i, tag: `b${i}` });
    }
    entries.sort((a, b) => a.mz - b.mz).forEach((e) => add(e));
    const idOf = (i: number) => (task.peaks.find((p) => p.role === read && p.ion === i) as Peak).id;
    const group = (letter: string) => residueGroup(letter);
    if (read === 'y') {
      task.rows.push({
        from: null, to: idOf(1), delta: frag.y[0] - WATER[spec.massType] - PROTON, answer: group(seq[len - 1]), ask: 'The last residue, from y1',
        label: 'y1 minus a water and a proton',
      });
      for (let i = 1; i < rowsWanted; i++) {
        task.rows.push({ from: idOf(i), to: idOf(i + 1), delta: frag.y[i] - frag.y[i - 1], answer: group(seq[len - 1 - i]), ask: `Next residue in from the end, y${i} to y${i + 1}`, label: `y${i + 1} minus y${i}` });
      }
    } else {
      for (let i = 2; i < 2 + rowsWanted; i++) {
        task.rows.push({ from: idOf(i), to: idOf(i + 1), delta: frag.b[i] - frag.b[i - 1], answer: group(seq[i]), ask: `Residue ${i + 1} from the start, b${i} to b${i + 1}`, label: `b${i + 1} minus b${i}` });
      }
    }
    task.decimals = 3;
    task.xmin = niceFloor(lo, 10);
    task.xmax = niceCeil(hi, 10);
    const total = task.rows.length;
    task.announce = `The peptide ${pep?.name ? `${pep.name} ` : ''}was broken in the spectrometer. These are its fragment ions, singly charged, in positive mode. The ${read} ions are the ones to read; the others are the other series.`;
    task.question = `Read the ${read} ladder ${total === 1 ? 'one residue' : `${total} residues`} at a time, ${read === 'y' ? 'from the C-terminus' : 'from the N-terminus'}.`;
    return task;
  }

  // shift
  const pool = shiftAnswers(spec, pep?.sequence ?? null);
  const unique = pool.filter((c) => shiftCandidates(spec.modifications as SpecMod[]).every((o) => o.mod.id === c.mod.id || Math.abs(o.total - c.mod.delta * c.count) >= SEPARATION));
  const chosen = pickIn(unique.length ? unique : pool);
  const z = zlo + Math.floor(rand() * (Math.min(zhi, zlo + 3) - zlo + 1));
  task.z = z;
  task.mod = chosen.mod;
  task.count = chosen.count;
  task.delta = chosen.mod.delta * chosen.count;
  const before = add({ mz: mzOf(M, z, mode), h: 0.9 + 0.1 * rand(), role: 'before', z });
  const after = add({ mz: mzOf(M + task.delta, z, mode), h: 0.55 + 0.35 * rand(), role: 'after', z });
  const gap = Math.abs(after.mz - before.mz);
  const lo = Math.min(before.mz, after.mz); const hi = Math.max(before.mz, after.mz);
  const pad = Math.max(1.6, gap * 0.9);
  task.decimals = 3;
  task.xmin = lo - pad;
  task.xmax = hi + pad;
  task.announce = `${what} was treated and some of it changed. Both peaks are the ${chargeText(z, mode)} ion, in ${how}. The marked peak is the molecule before treatment, with m/z ${fixed(before.mz, 3)}.`;
  task.question = 'Which modification does the shift show, and how many were added?';
  return task;
}

// ── Reading an attempt ───────────────────────────────────────────────────────

const peak = (t: SpectrumTask, id: number) => t.peaks[id];
const nearLeftRight = (t: SpectrumTask) => ({ left: peak(t, t.pair[0]), right: peak(t, t.pair[1]) });

/** The charge on the right-hand peak worked out from the pair, before rounding (it should be close to whole). */
export function chargeFromPair(left: number, right: number, mode: 'positive' | 'negative', p = PROTON): number {
  return mode === 'positive' ? (left - p) / (right - left) : (left + p) / (right - left);
}

/** The pair's working, in the order a student would do it, with this task's own numbers. */
export function workingFor(t: SpectrumTask, z?: number): string[] {
  const d = t.decimals;
  if (t.kind === 'isotope') {
    const s = C13_SPACING / t.z;
    return [
      `Neighbouring isotope peaks are one 13C apart, 1.003 mass units, so on the m/z scale they are 1.003 ÷ z apart.`,
      `Here the gap is ${fixed(s, d)}, so z = 1.003 ÷ ${fixed(s, d)} = ${fixed(C13_SPACING / s, 2)}, which is ${t.z}.`,
    ];
  }
  const { left, right } = nearLeftRight(t);
  if (!left || !right || t.kind === 'ladder' || t.kind === 'shift') return [];
  const sign = t.mode === 'positive' ? '−' : '+';
  const p = fixed(PROTON, 5);
  const n = chargeFromPair(left.mz, right.mz, t.mode);
  const lines = [
    `Neighbouring peaks differ by one charge. The left peak, m₁ = ${fixed(left.mz, 2)}, carries one more charge than the right peak, m₂ = ${fixed(right.mz, 2)}.`,
    `The charge on the right peak is n = (m₁ ${sign} ${p}) ÷ (m₂ − m₁) = ${fixed(t.mode === 'positive' ? left.mz - PROTON : left.mz + PROTON, 3)} ÷ ${fixed(right.mz - left.mz, 2)} = ${fixed(n, 2)}. It must come out close to a whole number.`,
    t.mode === 'positive'
      ? `The mass is M = n × (m₂ − ${p}), which takes off the n protons the ion gained.`
      : `The mass is M = n × (m₂ + ${p}), which puts back the n protons the ion lost.`,
  ];
  if (z !== undefined && Number.isInteger(z) && z >= 1) {
    const m1 = massFrom(left.mz, z + 1, t.mode);
    const m2 = massFrom(right.mz, z, t.mode);
    lines.push(`If n = ${z}: the right peak gives ${fixed(m2, 1, true)} Da and the left peak, at ${z + 1}, gives ${fixed(m1, 1, true)} Da. ${Math.abs(m1 - m2) <= 1 ? 'They agree, so this fits.' : `They are ${fixed(Math.abs(m1 - m2), 1, true)} Da apart, so ${z} cannot be right.`}`);
  }
  return lines;
}

const massWords = (t: SpectrumTask, M: number) => `${fixed(M, 1, true)} Da`;

function pairWhy(t: SpectrumTask): string {
  const { left, right } = nearLeftRight(t);
  const n = t.n;
  const nCalc = chargeFromPair(left.mz, right.mz, t.mode);
  return `Neighbouring peaks differ by one charge, so n = (m₁ ${t.mode === 'positive' ? '−' : '+'} 1.007) ÷ (m₂ − m₁) = ${fixed(nCalc, 2)}, which is ${n}; the mass is ${n} × (${fixed(right.mz, 2)} ${t.mode === 'positive' ? '−' : '+'} 1.007) = ${massWords(t, t.M)}.`;
}

export function whyFor(t: SpectrumTask, a?: SpectrumAttempt): string {
  switch (t.kind) {
    case 'isotope': return `Neighbouring isotope peaks are 1.003 mass units apart, so their gap on the m/z scale is 1.003 ÷ z. The gap here is ${fixed(C13_SPACING / t.z, 3)}, so z = ${t.z}.`;
    case 'pair': return pairWhy(t);
    case 'deconvolute': {
      const mid = Math.floor((t.series.length - 1) / 2);
      const left = t.peaks[t.series[mid]]; const right = t.peaks[t.series[mid + 1]];
      const n = right.z as number;
      return `Take two neighbouring peaks, ${fixed(left.mz, 2)} and ${fixed(right.mz, 2)}: n = ${fixed(chargeFromPair(left.mz, right.mz, t.mode), 2)}, which is ${n}, so the mass is ${n} × (${fixed(right.mz, 2)} ${t.mode === 'positive' ? '−' : '+'} 1.007) = ${massWords(t, t.M)}.`;
    }
    case 'ladder': {
      const letters = t.rows.map((r) => r.answer).join(', ');
      return `Each gap between neighbouring ${t.ionKind} ions is one residue (${t.ionKind === 'y' ? 'the first is the last residue plus a water and a proton' : 'b ions each carry one more residue'}). Reading the gaps gives ${letters}.`;
    }
    case 'shift': {
      const mod = t.mod as SpecMod;
      const dm = Math.abs(t.peaks[1].mz - t.peaks[0].mz);
      return `The peaks are ${fixed(dm, 3)} apart in m/z, and the charge is ${t.z}, so the mass changed by ${fixed(dm, 3)} × ${t.z} = ${fixed(dm * t.z, 2)} Da. That is ${t.count} × ${mod.name} (${fixed(mod.delta, 2)} Da each).`;
    }
    default: return a ? '' : '';
  }
}

export const massClose = (t: SpectrumTask, mass: number) => Math.abs(mass - t.M) <= t.tolerance;

export function result(t: SpectrumTask, a: SpectrumAttempt): RoundResult {
  const why = whyFor(t, a);
  switch (t.kind) {
    case 'isotope': {
      if (a.kind !== 'charge') throw new Error('An isotope round needs a charge.');
      const met = a.z === t.z;
      return {
        met,
        label: `Reads the charge as ${chargeText(t.z, t.mode)} from isotope peaks ${fixed(C13_SPACING / t.z, 3)} apart`,
        why,
        misconception: met ? undefined : a.z === 1 ? 'Takes every isotope gap to be one unit, whatever the charge' : a.z < t.z ? 'Reads too low a charge from the isotope gap' : 'Reads too high a charge from the isotope gap',
      };
    }
    case 'pair': {
      if (a.kind !== 'pair') throw new Error('A pair round needs a charge and a mass.');
      const okZ = a.z === t.n;
      const okM = massClose(t, a.mass);
      const met = okZ && okM;
      let misconception: string | undefined;
      if (!met) {
        const { right } = nearLeftRight(t);
        const forgot = t.n * right.mz;
        if (a.z === t.n + 1 || a.z === t.n - 1) misconception = 'Mixes up which neighbouring peak has the extra charge';
        else if (Math.abs(a.mass - forgot) <= t.tolerance) misconception = t.mode === 'positive' ? 'Forgets to take off the protons the ion gained' : 'Forgets to put back the protons the ion lost';
        else if (Math.abs(a.mass - right.mz) <= t.tolerance + 1) misconception = 'Takes the m/z as if it were the mass, with no charge';
        else if (okZ) misconception = 'Slips in the arithmetic after finding the charge';
      }
      return { met, label: `Finds charge ${chargeText(t.n, t.mode)} and a mass of ${fixed(t.M, 1, true)} Da from two neighbouring peaks`, why, misconception };
    }
    case 'deconvolute': {
      if (a.kind !== 'mass') throw new Error('A deconvolution round needs a mass.');
      const met = massClose(t, a.mass);
      let misconception: string | undefined;
      if (!met) {
        const mids = t.series.map((id) => t.peaks[id]);
        if (mids.some((p) => Math.abs(a.mass - (p.z as number) * p.mz) <= t.tolerance)) misconception = t.mode === 'positive' ? 'Forgets to take off the protons the ion gained' : 'Takes protons off where the ion lost them, instead of putting them back';
        else if (mids.some((p) => Math.abs(a.mass - p.mz) <= t.tolerance + 1)) misconception = 'Takes the m/z as if it were the mass, with no charge';
      }
      return { met, label: `Works out a mass of ${fixed(t.M, 1, true)} Da from a series of charge states`, why, misconception };
    }
    case 'ladder': {
      if (a.kind !== 'ladder') throw new Error('A ladder round needs a pick for each gap.');
      const wrong = t.rows.filter((r, i) => a.picks[i] !== r.answer);
      const letters = t.rows.map((r) => r.answer).join('');
      let misconception: string | undefined;
      if (wrong.length) {
        const close = wrong.some((r, _i) => {
          const i = t.rows.indexOf(r);
          const pick = a.picks[i];
          const m = (id: string) => RESIDUES[t.massType][id === 'L/I' ? 'L' : id];
          return pick && m(pick) !== undefined && Math.abs(m(pick) - m(r.answer)) < 0.1;
        });
        misconception = close ? 'Mistakes one residue for another that is close in mass' : 'Names a residue that does not match the gap between the ions';
      }
      return { met: wrong.length === 0, label: `Reads the ${t.ionKind} ladder as ${letters}${t.ionKind === 'y' ? ' from the C-terminus' : ' from the third residue on'}`, why, misconception };
    }
    case 'shift': {
      if (a.kind !== 'shift') throw new Error('A shift round needs a modification and a count.');
      const met = a.mod === (t.mod as SpecMod).id && a.count === t.count;
      let misconception: string | undefined;
      if (!met) {
        const dm = Math.abs(t.peaks[1].mz - t.peaks[0].mz);
        const chosen = t.options.find((o) => o.id === a.mod);
        if (chosen && Math.abs(chosen.delta * a.count - dm) < SEPARATION * 5 && t.z > 1) misconception = 'Forgets to multiply the m/z shift by the charge';
        else if (chosen && chosen.id === (t.mod as SpecMod).id) misconception = 'Counts the wrong number of modifications from the shift';
        else misconception = 'Matches the shift to the wrong modification';
      }
      return { met, label: `Finds that the shift is ${t.count} × ${(t.mod as SpecMod).name} (${fixed(t.delta, 2)} Da)`, why, misconception };
    }
  }
}
