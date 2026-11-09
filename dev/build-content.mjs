// Turns content/<engine>/*.json into what the pack ships, after checking every spec with its engine's own `issues`:
//   assets/practice/catalogue.json   the practice-v1 catalogue (validated with the kit's own validator)
// and keeps manifest.json's `assets` list in step.
//
// Each content file is one activity: catalogue fields plus `spec`. The engine is the folder name. This script reads
// src/engines/<engine>/logic.ts, so it must be run with Bun (it imports TypeScript):
//   bun dev/build-content.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = process.env.MNX_KIT || join(ROOT, '..', 'mnx-addon-kit-release');
const { validatePracticeCatalogue } = await import(pathToFileURL(join(KIT, 'sdk', 'src', 'practice.mjs')).href);
const { NAMES_COVERS } = await import(pathToFileURL(join(ROOT, 'src', 'credit.ts')).href);

const problems = [];
const warnings = [];
const bad = (where, message) => problems.push(`${where}: ${message}`);
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { bad(file, `not valid JSON (${error.message})`); return null; }
};

const skills = readJson(join(ROOT, 'content', 'skills.json')) ?? {};
const surfacesOf = (minutes) => (minutes <= 5 ? ['study', 'recall', 'planner'] : ['study', 'planner']);
const ACTIVITY_KEYS = ['id', 'title', 'summary', 'level', 'minutes', 'terms', 'skills', 'family', 'requires', 'cite', 'covers', 'spec'];

// `covers` names lecture points as <packet>:<point id>, the same form as `cite`. The catalogue carries them as the study
// document's item ids, which the document works out the same way, so a passed activity can stand in for questions on them.
const PACKETS = process.env.MNX_PACKETS || 'E:/MnemoNexus-data/claude-docs/packets';
const hash = (value) => {
  let h1 = 2166136261, h2 = 52711;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 16777619);
    h2 = Math.imul(h2 ^ code, 1540483477);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`.slice(0, 12);
};
const pointItems = new Map();
const itemsOfPacket = (packet) => {
  if (pointItems.has(packet)) return pointItems.get(packet);
  const items = new Map();
  const folder = existsSync(PACKETS) ? readdirSync(PACKETS).find((name) => name.startsWith(`${packet}-`)) : null;
  if (folder && existsSync(join(PACKETS, folder, 'draft.json'))) {
    const draft = JSON.parse(readFileSync(join(PACKETS, folder, 'draft.json'), 'utf8'));
    draft.sections.forEach((section, s) => section.subsections.forEach((subsection, u) => {
      for (const point of subsection.points) items.set(point.id, `pt_${hash(`${point.text.trim().toLowerCase()}|${s}|${u}`)}`);
    }));
  }
  pointItems.set(packet, items);
  return items;
};
// Find the Error and Knock It Out reach only some of their passages or changes in a run, so what they test is named per round.
const ROUND_LISTS = { spot: 'passages', network: 'perturbations' };
const MAX_PER_ROUND = 3;
const itemOf = (activity, file, ref) => {
  const [packet, point] = String(ref).split(':');
  const item = itemsOfPacket(packet).get(point);
  if (!item) bad(file, `\`covers\` names ${ref}, which is not a point in that lecture's draft`);
  if (!(activity.cite ?? []).includes(ref)) bad(file, `\`covers\` names ${ref}, which \`cite\` does not`);
  return item ?? null;
};
const roundItems = (engineId, activity, file) => {
  const key = ROUND_LISTS[engineId];
  const rounds = key ? activity.spec[key] ?? [] : [];
  if (!rounds.some((round) => round.covers?.length)) return { spec: activity.spec, items: [] };
  if (activity.covers?.length) bad(file, `\`covers\` is on the ${key} here, so leave it off the activity`);
  const items = [];
  const list = rounds.map((round, index) => {
    if (!round.covers?.length) return round;
    if (round.covers.length > MAX_PER_ROUND) bad(file, `${key} ${index + 1} names ${round.covers.length} points in \`covers\`; at most ${MAX_PER_ROUND}`);
    const covers = round.covers.flatMap((ref) => { const item = itemOf(activity, file, ref); return item ? [item] : []; });
    items.push(...covers);
    return { ...round, covers };
  });
  return { spec: { ...activity.spec, [key]: list }, items: [...new Set(items)] };
};
const withoutRoundCovers = (engineId, spec) => {
  const key = ROUND_LISTS[engineId];
  return key && spec[key] ? { ...spec, [key]: spec[key].map(({ covers, ...round }) => round) } : spec;
};
const coveredItems = (activity, file) => {
  const refs = activity.covers ?? [];
  if (!refs.length) return [];
  if (refs.length > activity.minutes + 1) bad(file, `\`covers\` names ${refs.length} points; a ${activity.minutes} minute activity can stand in for at most ${activity.minutes + 1}`);
  return [...new Set(refs.flatMap((ref) => {
    const [packet, point] = String(ref).split(':');
    const item = itemsOfPacket(packet).get(point);
    if (!item) bad(file, `\`covers\` names ${ref}, which is not a point in that lecture's draft`);
    if (!(activity.cite ?? []).includes(ref)) bad(file, `\`covers\` names ${ref}, which \`cite\` does not`);
    return item ? [item] : [];
  }))];
};

const catalogue = { version: 1, skills: {}, activities: [] };
const engineIds = readdirSync(join(ROOT, 'content'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const counts = {};
let skippedSpot = 0;

// content/generated/ holds what dev/build-generated.mjs wrote: each file names its engine in an `engine` field.
const logics = new Map();
async function logicOf(id, where) {
  if (logics.has(id)) return logics.get(id);
  const logicFile = join(ROOT, 'src', 'engines', id, 'logic.ts');
  let logic = null;
  if (!existsSync(logicFile)) bad(where, `there is no engine at src/engines/${id}/logic.ts`);
  else {
    logic = await import(pathToFileURL(logicFile).href);
    if (typeof logic.issues !== 'function') { bad(logicFile, 'must export `issues(spec)`'); logic = null; }
  }
  logics.set(id, logic);
  return logic;
}

for (const folder of engineIds) {
  const generated = folder === 'generated';
  if (!generated && !(await logicOf(folder, `content/${folder}`))) continue;

  for (const name of readdirSync(join(ROOT, 'content', folder)).filter((f) => f.endsWith('.json')).sort()) {
    const file = `content/${folder}/${name}`;
    const a = readJson(join(ROOT, file));
    if (!a) continue;
    const engineId = generated ? a.engine : folder;
    // Generated Find the Error passages are not good enough to ship: they need to be written, not generated. The engine, its tests and fixtures stay.
    if (generated && engineId === 'spot') { skippedSpot++; continue; }
    const logic = await logicOf(engineId, file);
    if (!logic) continue;
    for (const key of Object.keys(a)) if (!ACTIVITY_KEYS.includes(key) && !(generated && key === 'engine')) bad(file, `"${key}" is not a field an activity has`);
    if (typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(a.id)) bad(file, '`id` must be kebab-case, 3 to 64 characters');
    if (!a.id?.startsWith('ho-')) bad(file, '`id` must start with "ho-"');
    if (catalogue.activities.some((x) => x.id === a.id)) bad(file, `\`id\` "${a.id}" is used twice`);
    if (typeof a.title !== 'string' || !a.title.trim() || a.title.length > 90) bad(file, '`title` must be plain words, at most 90 characters');
    if (typeof a.summary !== 'string' || a.summary.length > 300) bad(file, '`summary` must be one or two sentences, at most 300 characters');
    if (![1, 2, 3].includes(a.level)) bad(file, '`level` must be 1, 2 or 3');
    if (typeof a.minutes !== 'number' || a.minutes < 2 || a.minutes > 8) bad(file, '`minutes` must be 2 to 8');
    if (!Array.isArray(a.terms) || a.terms.length < 3 || a.terms.length > 12) bad(file, '`terms` must list 3 to 12 phrases a lecture would use');
    if (!Array.isArray(a.skills) || !a.skills.length || a.skills.some((s) => !skills[s])) bad(file, '`skills` must name ids from content/skills.json');
    if (!a.spec || typeof a.spec !== 'object') { bad(file, '`spec` is missing'); continue; }
    for (const message of logic.issues(a.spec)) bad(file, message);
    if (logic.tells) for (const message of logic.tells(a.spec)) warnings.push(`${file}: ${message}`);

    const family = a.family ?? a.id.replace(/^ho-/, '');
    const rounds = roundItems(engineId, a, file);
    // The app opens the spec with `covers` filled in, which is longer, so that is the one that has to pass.
    if (rounds.spec !== a.spec) for (const message of logic.issues(rounds.spec)) bad(file, `with \`covers\` filled in: ${message}`);
    // `covers` is always checked; the host gets it from every engine that names what a round tested (src/credit.ts), and from Sort it gets none.
    const earned = [...coveredItems(a, file), ...rounds.items];
    const covers = NAMES_COVERS.has(engineId) ? earned : [];
    const launchSpec = NAMES_COVERS.has(engineId) ? rounds.spec : withoutRoundCovers(engineId, a.spec);
    for (const s of a.skills ?? []) if (skills[s]) catalogue.skills[s] = { label: skills[s].label };
    catalogue.activities.push({
      id: a.id, title: a.title, summary: a.summary, minutes: a.minutes, level: a.level,
      terms: [...new Set(a.terms)], skills: a.skills, surfaces: surfacesOf(a.minutes), family,
      ...(a.requires ? { requires: a.requires } : {}),
      ...(covers.length ? { covers } : {}),
      launch: { engine: engineId, spec: launchSpec },
    });
    counts[engineId] = (counts[engineId] ?? 0) + 1;
  }
}

if (problems.length) {
  for (const p of problems) console.error(`ERROR ${p}`);
  console.error(`\nContent has ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was built.`);
  process.exit(1);
}
validatePracticeCatalogue(catalogue);

const out = join(ROOT, 'assets');
rmSync(join(out, 'practice'), { recursive: true, force: true });
mkdirSync(join(out, 'practice'), { recursive: true });
writeFileSync(join(out, 'practice', 'catalogue.json'), JSON.stringify(catalogue));

// The manifest lists exactly the files the pack ships.
const manifestPath = join(ROOT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.assets = [{ logicalPath: 'assets/practice/catalogue.json', mimeType: 'application/json' }];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`built ${catalogue.activities.length} activities (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}) in ${Object.keys(catalogue.skills).length} skills`);
if (warnings.length) console.log(`${warnings.length} warnings:\n${warnings.map((w) => `  ${w}`).join('\n')}`);
if (skippedSpot) console.log(`left out ${skippedSpot} generated Find the Error activities: their passages need to be written, not generated`);
