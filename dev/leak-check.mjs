// Lists where a Find the Error correction may already be on screen: in the title or summary, in a true sentence, or in another passage.
// A run of one activity meets three passages, and the title and summary stay in view, so any of these can hand over the answer.
//
//   bun dev/leak-check.mjs [first] [last]     file numbers in name order, both counted from 1
//
// It compares words, so it cannot judge meaning: each line is a place for a person to read, not a fault. It looks for the words the
// correction has and the false sentence lacks, because those are what the student is meant to supply.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'content', 'spot');
const STOP = new Set(`about above after again against also although always among another because been before being below between both
but cannot could does doing down during each either every first from further have having here into itself just like made make makes many
more most much must near next only other others over same should since some such than that their them then there these they this those
through thus under until upon very were what when where which while whose will with within without would your`.split(/\s+/));

const words = (text) => new Set((text.toLowerCase().match(/[a-zα-ω0-9][a-zα-ω0-9'+-]{3,}/g) ?? []).map((w) => w.replace(/s$/, '')).filter((w) => !STOP.has(w)));
const overlap = (key, text) => { const seen = words(text); return [...key].filter((w) => seen.has(w)); };

const names = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const first = Number(process.argv[2] ?? 1);
const last = Number(process.argv[3] ?? names.length);
let flagged = 0;

for (const name of names.slice(first - 1, last)) {
  const activity = JSON.parse(readFileSync(join(DIR, name), 'utf8'));
  const passages = activity.spec.passages;
  const found = [];
  passages.forEach((passage, p) => {
    const bad = passage.s.find((s) => !s.ok);
    if (!bad) return;
    const key = new Set([...words(passage.correction)].filter((w) => !words(bad.t).has(w)));
    if (key.size < 2) return;
    const need = Math.max(2, Math.ceil(key.size * 0.5));
    const check = (where, text) => {
      const hit = overlap(key, text);
      if (hit.length >= need) found.push(`  passage ${p + 1} [${[...key].join(' ')}] ${where} has ${hit.join(', ')}: ${text.slice(0, 130)}`);
    };
    check('title', activity.title);
    check('summary', activity.summary);
    passages.forEach((other, o) => {
      for (const s of other.s) if (s.ok) check(o === p ? 'its own passage' : `passage ${o + 1}`, s.t);
      if (o !== p && other.correction) check(`passage ${o + 1}'s correction`, other.correction);
    });
  });
  if (found.length) {
    flagged += 1;
    console.log(`${name}\n${found.join('\n')}`);
  }
}
console.log(`\n${flagged} of ${Math.min(last, names.length) - first + 1} files flagged.`);
