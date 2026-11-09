/**
 * Published reference numbers for mass spectrometry. These are the tables any textbook or database uses; nothing here
 * belongs to a course. Masses of the thing being measured, and of any modification, live in the spec, not here.
 *
 * Sources: the proton mass is the CODATA 2018 value (1.007276466621 u). Monoisotopic residue masses are the standard
 * amino-acid residue masses (as in the Unimod and ExPASy tables), and average residue masses are the IUPAC
 * atomic-weight sums for the same residues. The 13C minus 12C spacing is 1.003354835 u.
 */

export const PROTON = 1.007276466621;
/** The mass difference between 13C and 12C, which sets the spacing of an isotope cluster (divided by the charge). */
export const C13_SPACING = 1.003354835;
export const WATER = { monoisotopic: 18.010564684, average: 18.01528 } as const;
export type MassType = 'monoisotopic' | 'average';

/** One residue's mass in a chain, by one-letter code. Leucine and isoleucine are the same mass. */
export const RESIDUES: Record<MassType, Record<string, number>> = {
  monoisotopic: {
    G: 57.021464, A: 71.037114, S: 87.032028, P: 97.052764, V: 99.068414, T: 101.047679, C: 103.009185, L: 113.084064, I: 113.084064,
    N: 114.042927, D: 115.026943, Q: 128.058578, K: 128.094963, E: 129.042593, M: 131.040485, H: 137.058912, F: 147.068414,
    R: 156.101111, Y: 163.063329, W: 186.079313,
  },
  average: {
    G: 57.0519, A: 71.0788, S: 87.0782, P: 97.1167, V: 99.1326, T: 101.1051, C: 103.1388, L: 113.1594, I: 113.1594,
    N: 114.1038, D: 115.0886, Q: 128.1307, K: 128.1741, E: 129.1155, M: 131.1926, H: 137.1411, F: 147.1766,
    R: 156.1875, Y: 163.176, W: 186.2132,
  },
};

/** The residues a student chooses between, with leucine and isoleucine together because they cannot be told apart by mass. */
export const RESIDUE_CHOICES: Array<{ id: string; letters: string; three: string; name: string }> = [
  { id: 'G', letters: 'G', three: 'Gly', name: 'glycine' }, { id: 'A', letters: 'A', three: 'Ala', name: 'alanine' },
  { id: 'S', letters: 'S', three: 'Ser', name: 'serine' }, { id: 'P', letters: 'P', three: 'Pro', name: 'proline' },
  { id: 'V', letters: 'V', three: 'Val', name: 'valine' }, { id: 'T', letters: 'T', three: 'Thr', name: 'threonine' },
  { id: 'C', letters: 'C', three: 'Cys', name: 'cysteine' }, { id: 'L/I', letters: 'LI', three: 'Leu/Ile', name: 'leucine or isoleucine' },
  { id: 'N', letters: 'N', three: 'Asn', name: 'asparagine' }, { id: 'D', letters: 'D', three: 'Asp', name: 'aspartate' },
  { id: 'Q', letters: 'Q', three: 'Gln', name: 'glutamine' }, { id: 'K', letters: 'K', three: 'Lys', name: 'lysine' },
  { id: 'E', letters: 'E', three: 'Glu', name: 'glutamate' }, { id: 'M', letters: 'M', three: 'Met', name: 'methionine' },
  { id: 'H', letters: 'H', three: 'His', name: 'histidine' }, { id: 'F', letters: 'F', three: 'Phe', name: 'phenylalanine' },
  { id: 'R', letters: 'R', three: 'Arg', name: 'arginine' }, { id: 'Y', letters: 'Y', three: 'Tyr', name: 'tyrosine' },
  { id: 'W', letters: 'W', three: 'Trp', name: 'tryptophan' },
];

export const residueGroup = (letter: string) => (letter === 'L' || letter === 'I' ? 'L/I' : letter);

/** The neutral mass of a peptide: its residues and one water. */
export function peptideMass(sequence: string, type: MassType): number {
  let sum = WATER[type];
  for (const letter of sequence) {
    const m = RESIDUES[type][letter];
    if (m === undefined) throw new Error(`"${letter}" is not an amino-acid residue`);
    sum += m;
  }
  return sum;
}

/** m/z of an ion of neutral mass M carrying `z` charges: protons added in positive mode, taken off in negative mode. */
export const mzOf = (M: number, z: number, mode: 'positive' | 'negative') => (mode === 'positive' ? (M + z * PROTON) / z : (M - z * PROTON) / z);
/** Back from m/z and charge to the neutral mass. */
export const massFrom = (mz: number, z: number, mode: 'positive' | 'negative', proton = PROTON) => (mode === 'positive' ? z * (mz - proton) : z * (mz + proton));
/** m/z of [M + (z-1)H + A]z+, where A is the mass of the adduct ion that takes the place of one proton. */
export const adductMz = (M: number, z: number, adduct: number) => (M + (z - 1) * PROTON + adduct) / z;

/** y ion i (the last i residues, a water and a proton) and b ion i (the first i residues and a proton), singly charged. */
export function fragmentMzs(sequence: string, type: MassType): { y: number[]; b: number[] } {
  const r = [...sequence].map((l) => RESIDUES[type][l]);
  const y: number[] = [];
  const b: number[] = [];
  let acc = WATER[type] + PROTON;
  for (let i = r.length - 1; i >= 1; i--) { acc += r[i]; y.push(acc); }
  acc = PROTON;
  for (let i = 0; i < r.length - 1; i++) { acc += r[i]; b.push(acc); }
  return { y, b };
}
