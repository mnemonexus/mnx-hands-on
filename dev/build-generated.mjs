// Writes the Sort and Find the Error activities that can be made from data that already exists: every
// E:/MnemoNexus-data/claude-docs/packets/*/teaching.json read with its draft.json. Run with Bun (it imports the engines' logic):
//   bun dev/build-generated.mjs [--verbose] [--samples]
//
// What it writes: content/generated/<id>.json, one activity per file, with an `engine` field (the build reads it).
// Safe to re-run: the same data gives byte-identical files, the ids are made from the lecture number and the thing the activity
// is about, and the family is the lecture (Find the Error) or the pair of things (Sort), so a student's rung survives a re-run.
// Nothing ships that `issues` refuses: it is dropped and counted. Nothing in here names a subject.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKETS = process.env.MNX_PACKETS || 'E:/MnemoNexus-data/claude-docs/packets';
const OUT = join(ROOT, 'content', 'generated');
const VERBOSE = process.argv.includes('--verbose');
const SAMPLES = process.argv.includes('--samples');

const sortLogic = await import(pathToFileURL(join(ROOT, 'src', 'engines', 'sort', 'logic.ts')).href);
const spotLogic = await import(pathToFileURL(join(ROOT, 'src', 'engines', 'spot', 'logic.ts')).href);
const { standaloneProblem, similarity, contentWords } = sortLogic;

const SPEC_BUDGET = 3800;
// A Sort card that was masked carries the original sentence too, so a Sort spec may be longer (the engine allows 6200).
const SORT_BUDGET = 6000;
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
/** A short kebab-case name, cut at a word and not in the middle of one. */
const slug = (s, n) => {
  const full = s.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (full.length <= n) return full;
  const cut = full.slice(0, n + 1);
  const at = cut.lastIndexOf('-');
  return (at >= 6 ? cut.slice(0, at) : full.slice(0, n)).replace(/-+$/, '');
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, phrase) => phrase.length >= 2 && new RegExp(`(^|[^A-Za-z0-9])${esc(phrase)}(?:e?s)?([^A-Za-z0-9]|$)`, 'i').test(text);

// ── Text ─────────────────────────────────────────────────────────────────────

/** Markdown out, plain text in. */
function plain(md) {
  return md.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)/g, '').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1$2').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}
const ABBREV = /(?:\be\.g|\bi\.e|\bvs|\bFig|\bfigs|\bapprox|\bca|\bet al|\bcf|\bNo|\bDr|\bProf|\bSt|\bsp|\bspp|\bsubsp|\bc|\bvol|\bpp|\bp|\betc|\bResp|\b[A-Z])\.$/;
function sentences(paragraph) {
  const parts = paragraph.split(/(?<=[.!?])(?=\s+["'‘“(\[]?[A-Z0-9])/);
  const out = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    if (out.length && (ABBREV.test(out[out.length - 1]) || /^[a-z]/.test(s))) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
}
/** A sentence that can sit in a passage: whole, plain and not pointing at a slide. */
function sentenceProblem(s) {
  if (s.length < 30 || s.length > 300) return 'length';
  if (/\?\s*$/.test(s)) return 'question';
  if (!/[.!]["')’”\]]*$/.test(s)) return 'no full stop';
  if (/\b(slide|figure|fig\.|table \d|see |think about|you |your |lecturer|quiz|activity|exercise|poll|mentimeter|vle|panopto)\b/i.test(s)) return 'refers outside';
  if (/[|=]{1}|\\|\$|_{2}/.test(s) && /\|/.test(s)) return 'table';
  if ((s.match(/\(/g) ?? []).length !== (s.match(/\)/g) ?? []).length) return 'brackets';
  return null;
}

// ── Reading a packet ─────────────────────────────────────────────────────────

function readPacket(dir) {
  const tp = join(PACKETS, dir, 'teaching.json');
  const dp = join(PACKETS, dir, 'draft.json');
  if (!existsSync(tp)) return null;
  if (!existsSync(dp)) return { dir, missing: 'draft.json' };
  const teaching = JSON.parse(readFileSync(tp, 'utf8'));
  const draft = JSON.parse(readFileSync(dp, 'utf8'));
  const pk = /^(\d+)/.exec(dir)?.[1] ?? hash(dir);
  const points = [];
  draft.sections.forEach((sec, si) => sec.subsections.forEach((sub, ui) => sub.points.forEach((p) => points.push({ ...p, text: plain(p.text), si, ui, secTitle: sec.title, subTitle: sub.title }))));
  const concepts = new Map((draft.concepts ?? []).map((c) => [c.label.toLowerCase(), c]));
  return { dir, pk, teaching, draft, points, concepts, title: draft.title };
}

// ── Sort ─────────────────────────────────────────────────────────────────────

const COMPARING = /\b(compar\w*|versus|vs\.?|contrast\w*|differ\w*|distinguish\w*|between)\b/i;
const SHARED_WORDS = /\b(both|neither|compared|whereas|unlike|in contrast|in common|same as|instead of|rather than|as well as)\b/i;

/** The phrases that name a thing: its label and its aliases. */
function namesOf(info) {
  const c = info.concept;
  return [...new Set([info.label, ...(c?.aliases ?? [])].map((x) => x.trim()).filter((x) => x.length >= 2))];
}
/** Words that mark a thing: its label, aliases and summary, and words used in two or more of its statements. */
function contextWords(info) {
  const set = new Set(contentWords([...namesOf(info), info.concept?.summary ?? ''].join(' ')));
  const count = new Map();
  for (const p of info.points) for (const w of new Set(contentWords(p.text))) count.set(w, (count.get(w) ?? 0) + 1);
  for (const [w, n] of count) if (n >= 2) set.add(w);
  return set;
}

function entitiesOf(packet) {
  const by = new Map();
  for (const p of packet.points) {
    if (!p.about) continue;
    if (!by.has(p.about)) by.set(p.about, { label: p.about, concept: packet.concepts.get(p.about.toLowerCase()), points: [] });
    by.get(p.about).points.push(p);
  }
  // How many of the lecture's things use each word: a word used by many marks none of them.
  const df = new Map();
  for (const info of by.values()) for (const w of new Set(info.points.flatMap((p) => contentWords(p.text)))) df.set(w, (df.get(w) ?? 0) + 1);
  const rare = Math.max(2, Math.floor(by.size * 0.2));
  const out = [];
  for (const info of by.values()) {
    info.isRare = (w) => (df.get(w) ?? 0) <= rare;
    // A statement is a candidate when it can stand alone; the pair it ends up in decides the rest.
    info.usable = info.points.filter((p) => !standaloneProblem(p.text) && !sentenceProblem(p.text) && !SHARED_WORDS.test(p.text) && p.text.length <= 200);
    if (info.usable.length >= 3) { info.ctx = contextWords(info); info.names = namesOf(info); out.push(info); }
  }
  return out;
}

/** Why two things are worth setting side by side, as a score (0 means not worth it). */
function pairScore(a, b, notes) {
  const la = a.label.toLowerCase(), lb = b.label.toLowerCase();
  if (la.includes(lb) || lb.includes(la)) return 0;
  const na = a.names.map((x) => x.toLowerCase()), nb = b.names.map((x) => x.toLowerCase());
  if (na.some((x) => nb.includes(x))) return 0;
  // One named inside the other's summary is a part and its whole, not two things to tell apart.
  const sa = (a.concept?.summary ?? '').toLowerCase(), sb = (b.concept?.summary ?? '').toLowerCase();
  if (b.names.some((n) => n.length > 2 && mentions(sa, n)) || a.names.some((n) => n.length > 2 && mentions(sb, n))) return 0; // one names the other: a part and its whole, or a cause and its effect
  let score = 0;
  const secA = new Set(a.points.map((p) => p.si)), secB = new Set(b.points.map((p) => p.si));
  const shared = [...secA].filter((s) => secB.has(s));
  const subA = new Set(a.points.map((p) => `${p.si}.${p.ui}`)), subB = new Set(b.points.map((p) => `${p.si}.${p.ui}`));
  const sharedSub = [...subA].filter((s) => subB.has(s));
  if (!shared.length) return 0;
  score += 2;
  if (sharedSub.length) { score += 1; notes.push('same subsection'); }
  const titled = a.points.concat(b.points).some((p) => shared.includes(p.si) && (COMPARING.test(p.secTitle) || COMPARING.test(p.subTitle)));
  if (titled) { score += 4; notes.push('title sets up a comparison'); }
  else if (a.points.concat(b.points).some((p) => shared.includes(p.si) && /\band\b/i.test(p.subTitle))) score += 1;
  const wa = contentWords(a.label), wb = contentWords(b.label);
  if (wa.some((w) => wb.includes(w))) { score += 3; notes.push('labels share a word'); }
  // Kinds that match (two techniques, two proteins) are easier to confuse than a protein and a method.
  if (a.concept?.kind && a.concept.kind === b.concept?.kind && a.concept.kind !== 'concept') score += 1;
  score += Math.min(2, a.usable.length / 4 + b.usable.length / 4);
  return score;
}

// ── Masking: a card must not name its own bin ─────────────────────────────────

const POINTS_AT_PAGE = /^(?:examples?|cases?|figures?|slides?|plots?|graphs?|diagrams?|traces?|panels?|images?|pictures?|data|results?|experiments?|stud(?:y|ies)|questions?|problems?|sets?|samples?|bands?|peaks?|curves?|histograms?|tables?|schemes?|scenarios?)$/i;
const BARE = /^(?:of|in|on|at|for|from|with|and|or|by|to)$/i;
const PRE_DET = /\b(?:each|every|any|all|per|one|two|both|another|no|some|many|most|these|those|this|that)\s*$/i;
/** The words of a name, brackets taken out. */
const wordsOf = (name) => name.replace(/\([^)]*\)/g, ' ').match(/[A-Za-z0-9α-ωΑ-Ω][A-Za-z0-9α-ωΑ-Ω'’-]*/g) ?? [];
const SPECIAL_PLURALS = (w) => (/um$/i.test(w) ? [`${w.slice(0, -2)}a`] : /ix$/i.test(w) ? [`${w.slice(0, -2)}ices`] : /is$/i.test(w) ? [`${w.slice(0, -2)}es`] : []);

/** The forms of one thing's name that give it away: label, aliases, an abbreviation in brackets, and the head noun when no other bin shares it. */
function maskForms(info, group) {
  const others = group.filter((g) => g !== info);
  const otherWords = new Set(others.flatMap((o) => o.names.flatMap((n) => contentWords(wordsOf(n).join(' ')))));
  const forms = new Set();
  const heads = new Set();
  for (const n of info.names) {
    // A bracket after a space is an abbreviation or a gloss; one joined to a word, as in "poly(A)", is part of the name.
    const base = n.replace(/\s\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (base.length >= 2) forms.add(base);
    for (const m of n.matchAll(/\s\(([^)]{2,12})\)/g)) forms.add(m[1].trim());
  }
  for (const n of info.names) {
    const ws = wordsOf(n);
    const head = ws[ws.length - 1];
    if (head && head.length >= 4 && ws.length > 1 && !forms.has(head) && !contentWords(head).some((w) => otherWords.has(w))) { forms.add(head); heads.add(head.toLowerCase()); }
  }
  const list = [...forms].sort((x, y) => y.length - x.length);
  list.heads = heads;
  return list;
}
/** Words that mark one bin among the group, left in a card even after its names went: such a card still gives the answer away. */
function markerWords(group) {
  const per = group.map((g) => new Set(g.names.flatMap((n) => contentWords(wordsOf(n).join(' '))).filter((w) => w.length >= 4)));
  return per.map((set, i) => new Set([...set].filter((w) => !per.some((o, j) => j !== i && o.has(w)))));
}

/** Words that may stand just before or after a name without the stand-in reading wrongly: small grammar words, never a noun or an adjective. */
const FUNC = new Set(('of in on at by for with from to into through via than as between within over under during after before about against across and or but nor that which who because while when if whereas since although whether so then once until unless is are was were be been being has have had can could may might will would must should shall does do did not also only often usually typically always never cannot no both either neither all each than just still even now').split(' '));
/** The card with its bin's name replaced by "this" or "it". Returns { text } or { drop: reason }. */
function maskText(text, forms) {
  const heads = forms.heads ?? new Set();
  const abbr = forms.filter((f) => f.length <= 4 && f === f.toUpperCase());
  const long = forms.filter((f) => !abbr.includes(f));
  const plurals = new Set(forms.flatMap((f) => SPECIAL_PLURALS(f)).map((f) => f.toLowerCase()));
  let fail = null;
  let count = 0;
  const build = (list, flags) => {
    if (!list.length) return null;
    const alts = list.flatMap((f) => [f, ...(/\s/.test(f) ? [] : SPECIAL_PLURALS(f))]).map(esc).join('|');
    return new RegExp('(^|[^A-Za-z0-9α-ωΑ-Ω])((?:[Tt]he|[Aa]n?|THE|AN?)[ ]+)?(' + alts + ")(e?s|['’]s)?(?![A-Za-z0-9α-ωΑ-Ω])", flags);
  };
  const run = (re, input) => (!re ? input : input.replace(re, (...a) => {
    const [match, pre, art, name, tail] = a;
    const offset = a[a.length - 2];
    count++;
    const before = input.slice(0, offset + pre.length);
    const atStart = !/[A-Za-z0-9]/.test(before);
    const poss = /^['’]s$/.test(tail ?? '');
    const plural = (!!tail && !poss) || plurals.has(name.toLowerCase());
    const drop = (why) => { fail ??= why; return match; };
    let modifier = false;
    if (art && /^an?\s/i.test(art) && !atStart) return drop('name after "a"');
    if (!atStart && PRE_DET.test(before)) return drop('name after a determiner');
    // What stands just before: nothing, punctuation, a small grammar word, the article that went, or (for a proper name) anything.
    const prevRaw = (before.match(/(\S+)\s*$/) ?? [])[1];
    const prev = prevRaw && /^[A-Za-z][A-Za-z'’-]*$/.test(prevRaw) ? prevRaw : null;
    if (!atStart && prevRaw && !prev && !/^[,;:]$|[,;:]$/.test(prevRaw) && !/[.!?]$/.test(prevRaw)) return drop('name after a number or symbol');
    if (/\($/.test(before.trimEnd())) return drop('name inside brackets');
    if (/(?:^|[^,;:]\s)(?:and|or)\s*$/i.test(before) && !art) return drop('stand-in joined to another name');
    if (/^\s+(?:and|or)\s+(?:the\s+)?[A-Z]/.test(input.slice(offset + match.length))) return drop('stand-in joined to another name');
    const properName = /[A-Z0-9]/.test(name.slice(atStart ? 1 : 0)) || /[A-Z0-9]/.test(name.slice(1));
    const prevOk = atStart || !prev || art || FUNC.has(prev.toLowerCase()) || /[A-Z]/.test(prev[0]) || (!heads.has(name.toLowerCase()) && /(?:[^s]s|ed|ing)$/i.test(prev)) || (properName && !heads.has(name.toLowerCase()));
    if (!prevOk) return drop('name after a modifier');
    // What follows: punctuation, the end, or a verb or small grammar word. A noun after it ("it domain") would not read.
    const rest = input.slice(offset + match.length);
    const next = (rest.match(/^\s*([A-Za-z][A-Za-z'’-]*)/) ?? [])[1];
    if (!poss && next && !/^[,.;:)]/.test(rest)) {
      const w = next.toLowerCase();
      const verbish = FUNC.has(w) || /ed$|(?:ally|ively|ously|ently|antly|ibly|ably|ngly|edly)$/.test(w) || (plural ? !/s$/.test(w) : /s$/.test(w) && !/(?:ers|ors|ms|ics|ings|ness|tion|ions|ules|ides)$/.test(w) && w.length > 3);
      const after2 = (rest.replace(/^\s*[A-Za-z][A-Za-z'’-]*/, '').match(/^\s*([A-Za-z]+)/) ?? [])[1]?.toLowerCase() ?? '';
      const isS = /s$/.test(w) && !/(?:ss|us|is)$/.test(w);
      // A name that opens a noun phrase ("the GFP domain", "P450 enzymes") is replaced by "this" or "these", leaving the noun: "this domain".
      if (!FUNC.has(w) && (!verbish || (isS && /^(?:are|were|have|do|can|may|will|would|must|should|could|might|is|was|has|did|does)$/.test(after2)))) {
        if (plural) return drop('name before a noun, in the plural');
        // "The example" or "this figure" points at a page the student cannot see, so a card whose name was a modifier of such a noun goes.
        if (POINTS_AT_PAGE.test(w)) return drop('name before a noun that points at a page');
        if (!(art || atStart || !prev || FUNC.has(prev.toLowerCase()))) return drop('name after a modifier');
        modifier = true;
        // The stand-in is "this" or "these", and the noun stays under it ("this domain").
        return pre + (isS ? (atStart ? 'These' : 'these') : (atStart ? 'This' : 'this'));
      }
      // A lower-case name inside a sentence followed by a word in "s" may be a noun and its plural ("cyclin peaks"): only a name that opens the sentence or is capitalised is trusted.
      if (!plural && !FUNC.has(w) && /s$/.test(w) && !atStart && !/[A-Z0-9]/.test(name)) return drop('name before a word that may be a noun');
    } else if (!poss && rest.trim() && !/^\s*[,.;:)]/.test(rest) && !/^\s*[A-Za-z(]/.test(rest)) return drop('name before a symbol');
    // A plural name keeps its plural verb, so it becomes "they" where it is the subject and "them" elsewhere.
    const subject = atStart || /(?:[,;:]|\b(?:that|because|while|when|if|as|and|but|or|whereas|since|although|which|whether|so|then|once|until|unless))\s*$/i.test(before);
    if (plural) return pre + (poss ? (atStart ? 'Their' : 'their') : subject ? (atStart ? 'They' : 'they') : 'them');
    return pre + (poss ? (atStart ? 'Its' : 'its') : (atStart ? 'This' : 'it'));
  }));
  const out = run(build(abbr, 'g'), run(build(long, 'gi'), text)).replace(/\b(This|it|They|they|them)\s*\((?:it|them|they)\)/g, '$1').replace(/\((?:it|them|they)\)\s*/g, () => { fail ??= 'name inside brackets'; return ''; });
  if (fail) return { drop: fail };
  if (count > 1) return { drop: 'name appears more than once' };
  if (out !== text) {
    if (/\b(?:This|it|its|They|they|them|their)\s+(?:of|\()/.test(out)) return { drop: 'stand-in followed by "of"' };
    if (/^(?:This|They|It)\s+(?:is|are)\s+(?:less|more|fewer|greater|higher|lower|larger|smaller|faster|slower)\b/.test(out) && !/\bthan\b/.test(out)) return { drop: 'a comparison with nothing to compare to' };
    if (/\b(?:This|this|it|they|them)\s+(?:it|this|they|them)\b/.test(out)) return { drop: 'two stand-ins side by side' };
    if (/\b(?:and|or)\s+(?:it|them)\s+(?:are|were|have|and|or)\b|^(?:This|They)\s+(?:and|or)\b|\b(?:it|them)\s+(?:and|or)\s+[A-Z]/.test(out)) return { drop: 'stand-in joined to another name' };
    if (/^(?:In|On|At|For|With|Within|From|By|Of|Under|During|After|Before|Through|Unlike|Like|Compared|As)\s+(?:it|them)\b/.test(out)) return { drop: 'stand-in after an opening preposition' };
  }
  return { text: out };
}

/** The statements of `mine` that are fair to put against `others`: specific to it, and silent about them. Returns the cards and the count dropped. */
const LEANS = /\b(then|therefore|thus|hence|consequently|furthermore|moreover|however|nevertheless|the same|this|these|those|such|step \d|the latter|the former|respectively|in turn|as a result|in this case|here|lecture|exam|exams|students?|assessment|assessed|module|nobel|overlay|micrograph|example above|green|grey|marked|lane|lanes|stage \d|complex \d|the experiment|this experiment|being discussed|under discussion|was spotted|was added|were added|we |our )\b/i;
function fairCards(mine, others, stats) {
  const cards = [];
  const otherNames = others.flatMap((o) => o.names);
  // A statement points to a thing when it names it, or uses a word that belongs to that thing's label, aliases or summary and
  // to none of the others. It is unfair when it could just as well be said of another one.
  const core = (info) => new Set(contentWords([...info.names, info.concept?.summary ?? ''].join(' ')));
  const mineCore = core(mine);
  const otherCore = new Set(others.flatMap((o) => [...core(o)]));
  const otherOnly = new Set();
  for (const o of others) for (const w of o.ctx) if (!mine.ctx.has(w)) otherOnly.add(w);
  // What gives a card away is its own bin's name, and the name of any other. Both are masked or refused, never shown.
  const group = [mine, ...others];
  const forms = maskForms(mine, group);
  const markers = new Set(markerWords(group).flatMap((set) => [...set]));
  const otherCtx = new Set(others.flatMap((o) => [...o.ctx]));
  for (const p of mine.usable) {
    const words = contentWords(p.text);
    const naming = mine.names.some((n) => n.length >= 2 && mentions(p.text, n));
    const cue = words.filter((w) => mineCore.has(w) && !otherCore.has(w) && mine.isRare(w)).length >= 2;
    const reason = LEANS.test(p.text) ? 'leans on its context'
      : otherNames.some((n) => mentions(p.text, n)) ? 'names the other thing'
        : words.some((w) => otherOnly.has(w)) ? 'uses a word that marks the other thing'
          : !(naming || cue) ? 'could be said of either'
            : null;
    if (reason) { stats.cardsDropped++; stats.reasons[`card: ${reason}`] = (stats.reasons[`card: ${reason}`] ?? 0) + 1; continue; }
    const m = maskText(p.text, forms);
    const refuse = (why) => { stats.cardsDropped++; stats.reasons[`card: ${why}`] = (stats.reasons[`card: ${why}`] ?? 0) + 1; };
    if (m.drop) { refuse(`cannot be masked (${m.drop})`); continue; }
    const left = contentWords(m.text);
    const lowered = m.text.toLowerCase();
    if ([...markers].some((w) => new RegExp('(^|[^a-z0-9])' + esc(w)).test(lowered))) { refuse('a word of a bin name is left once masked'); continue; }
    if (left.some((w) => markers.has(w))) { refuse('a word of a bin name is left once masked'); continue; }
    // Once the name is gone, what is left must still point at this bin and not at the other.
    if (left.filter((w) => mine.ctx.has(w) && !otherCtx.has(w)).length < 1) { refuse('true of either once masked'); continue; }
    cards.push({ p, naming: false, t: m.text, full: m.text === p.text ? undefined : p.text });
  }
  return cards;
}

function pickCards(cards, max) {
  const ordered = cards.slice().sort((a, b) => (a.naming - b.naming) || (a.p.priority ?? 2) - (b.p.priority ?? 2) || Math.abs(a.t.length - 110) - Math.abs(b.t.length - 110) || (a.t < b.t ? -1 : 1));
  const out = [];
  for (const c of ordered) {
    if (out.length >= max) break;
    if (out.some((x) => similarity(x.t, c.t) > 0.5)) continue;
    out.push(c);
  }
  return out;
}

function buildSortSpec(group, maxPer) {
  const trial = { cardsDropped: 0, reasons: {} };
  const per = group.map((g, i) => pickCards(fairCards(g, group.filter((_, j) => j !== i), trial), maxPer));
  if (per.some((list) => list.length < 3)) return null;
  // Two bins must not hold the same sentence in other words.
  for (let i = 0; i < per.length; i++) for (let j = i + 1; j < per.length; j++) {
    per[j] = per[j].filter((c) => !per[i].some((x) => similarity(x.t, c.t) > 0.65));
    if (per[j].length < 3) return null;
  }
  const label = (g) => g.label;
  const bins = group.map((g) => ({ label: clip(label(g), 60), ...(g.concept?.summary && g.concept.summary.length <= 200 ? { note: g.concept.summary } : {}) }));
  const cards = [];
  const longest = Math.max(...per.map((l) => l.length));
  for (let k = 0; k < longest; k++) per.forEach((list, bi) => {
    const c = list[k];
    if (!c) return;
    cards.push({ t: c.t, ...(c.full ? { full: c.full } : {}), bin: bi, why: clip(`This is about ${clip(label(group[bi]), 90)}.`, 190), _p: c.p.id });
  });
  const spec = { bins, cards: cards.map(({ _p, ...rest }) => rest) };
  return { spec, cites: cards.map((c) => c._p), trial };
}

function sortActivities(packet, stats) {
  const infos = entitiesOf(packet);
  const notes = new Map();
  const pairs = [];
  for (let i = 0; i < infos.length; i++) for (let j = i + 1; j < infos.length; j++) {
    const n = [];
    const s = pairScore(infos[i], infos[j], n);
    if (s >= 5 && n.length) pairs.push({ a: infos[i], b: infos[j], score: s, notes: n });
  }
  pairs.sort((x, y) => y.score - x.score || (x.a.label + x.b.label < y.a.label + y.b.label ? -1 : 1));
  stats.pairsSeen += pairs.length;
  const used = new Set();
  const acts = [];
  for (const pr of pairs) {
    if (acts.length >= 4) break;
    if (used.has(pr.a.label) || used.has(pr.b.label)) continue;
    // A third thing joins when it pairs well with both.
    let group = [pr.a, pr.b];
    const third = infos
      .filter((c) => !used.has(c.label) && c !== pr.a && c !== pr.b)
      .map((c) => ({ c, s: Math.min(pairScore(pr.a, c, []), pairScore(pr.b, c, [])) }))
      .filter((x) => x.s >= 5)
      .sort((x, y) => y.s - x.s || (x.c.label < y.c.label ? -1 : 1))[0];
    let built = null;
    if (third) {
      group = [pr.a, pr.b, third.c];
      for (const max of [5, 4]) { built = buildSortSpec(group, max); if (built && JSON.stringify(built.spec).length <= SORT_BUDGET) break; built = null; }
    }
    if (!built) {
      group = [pr.a, pr.b];
      for (const max of [8, 7, 6, 5, 4]) { built = buildSortSpec(group, max); if (built && JSON.stringify(built.spec).length <= SORT_BUDGET) break; built = null; }
    }
    if (!built) { stats.candidatesDropped++; stats.reasons['sort pair: not enough fair statements'] = (stats.reasons['sort pair: not enough fair statements'] ?? 0) + 1; continue; }
    stats.cardsDropped += built.trial.cardsDropped;
    for (const [k, v] of Object.entries(built.trial.reasons)) stats.reasons[k] = (stats.reasons[k] ?? 0) + v;
    const problems = sortLogic.issues(built.spec);
    if (problems.length) { stats.activitiesDropped++; stats.reasons[`sort issues: ${problems[0].slice(0, 60)}`] = (stats.reasons[`sort issues: ${problems[0].slice(0, 60)}`] ?? 0) + 1; if (VERBOSE) console.log(`  dropped sort ${group.map((g) => g.label).join(' / ')}: ${problems.join(' | ')}`); continue; }
    group.forEach((g) => used.add(g.label));
    const names = group.map((g) => g.label);
    const idTail = group.map((g) => slug(g.label, group.length === 3 ? 14 : 20) || hash(g.label)).join('-');
    const id = `ho-sort-${packet.pk}-${idTail}`.slice(0, 64).replace(/-+$/, '');
    const terms = termsFor(packet, group);
    if (terms.length < 3) { stats.activitiesDropped++; stats.reasons['sort: too few terms'] = (stats.reasons['sort: too few terms'] ?? 0) + 1; continue; }
    const listed = names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
    acts.push({
      engine: 'sort', id,
      title: clip(`Sort: ${listed}`, 90),
      summary: clip(`Statements from the lecture arrive one at a time. Throw each into ${names.length === 2 ? 'the right bin' : 'the right one of three bins'}, or into "both", then see them side by side.`, 300),
      level: group.length === 3 ? 3 : 2,
      minutes: 3,
      terms,
      skills: ['telling-apart'],
      family: `sort-${packet.pk}-${idTail}`.slice(0, 64).replace(/-+$/, ''),
      cite: built.cites.slice(0, 40).map((c) => `${packet.pk}:${c}`),
      spec: built.spec,
    });
  }
  return acts;
}

/** Phrases a lecture would use, from the things themselves and the concepts of the sections they sit in. */
function termsFor(packet, group, extraPoints = []) {
  const out = [];
  const add = (phrase) => {
    const p = phrase.trim();
    if (p.length < 3 || p.length > 60) return;
    const single = !/\s/.test(p);
    // A single plain word never matches, so keep one only when it is a name (capital, digit, Greek) or a long technical word.
    if (single && !(/[A-Z0-9α-ωΑ-Ω]/.test(p.slice(1)) || /[0-9]/.test(p) || p.length >= 9)) return;
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  };
  for (const g of group) namesOf(g).forEach(add);
  const sections = new Set(group.flatMap((g) => g.points.map((p) => p.si)));
  for (const p of extraPoints) sections.add(p.si);
  const here = [];
  for (const si of sections) for (const p of packet.points) if (p.si === si && p.about) here.push(p.about);
  for (const label of [...new Set(here)]) {
    const c = packet.concepts.get(label.toLowerCase());
    add(label);
    for (const a of c?.aliases ?? []) add(a);
    if (out.length >= 12) break;
  }
  if (out.length < 3) for (const c of packet.concepts.values()) { add(c.label); if (out.length >= 6) break; }
  return out.slice(0, 12);
}

// ── Find the Error ───────────────────────────────────────────────────────────

function oneSentence(text) {
  const t = plain(text);
  const first = sentences(t)[0] ?? t;
  return first;
}

/** The lesson of one part as a run of clean sentences, with a break wherever a paragraph could not be read. */
function lessonRuns(part) {
  const runs = [];
  let run = [];
  for (const l of part.lesson ?? []) {
    for (const para of l.markdown.split(/\n{2,}/)) {
      const text = para.trim();
      const skip = !text || /(^|\n)\s*([-*•]|\d+[.)])\s/.test(text) || text.includes('|') || /^#/.test(text);
      if (skip) { if (run.length) runs.push(run); run = []; continue; }
      for (const s of sentences(plain(text))) {
        if (sentenceProblem(s)) { if (run.length) runs.push(run); run = []; } else run.push(s);
      }
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/** A sentence that only points forward ("The consequence follows directly."), so a passage must not end on it. */
const leadIn = (s) => s.length < 55 || /(follows|as follows|is clear|are clear|next|consider|now)[.:]?$/i.test(s.trim());
/** Every sentence shares some of its words with the rest of the passage, so the passage is about one thing. */
function coherent(sentences) {
  return sentences.every((t, i) => {
    const mine = new Set(contentWords(t));
    const rest = new Set(sentences.filter((_, j) => j !== i).flatMap((x) => contentWords(x)));
    if (!mine.size) return true;
    return [...mine].filter((w) => rest.has(w)).length / mine.size >= 0.1;
  });
}
const startsNeedingBefore = (s) => { const p = standaloneProblem(s); return !!p && p.startsWith('starts with'); };

/** One planted falsehood in a run of true sentences, or a reason it cannot be done fairly. */
function plant(run, idea, fix, size) {
  const scores = run.map((s) => similarity(s, fix) + 0.5 * similarity(s, idea));
  let best = 0;
  scores.forEach((v, i) => { if (v > scores[best]) best = i; });
  if (scores[best] < 0.2) return { reason: 'no sentence says what the fix says' };
  if (similarity(run[best], fix) < 0.1 && similarity(run[best], idea) < 0.2) return { reason: 'the idea and the sentence are about different things' };
  if (similarity(idea, run[best]) < 0.12) return { reason: 'would read as a splice' };
  // A falsehood must be false on its own: nearly all it says should already be in what it corrects, or it leans on its question.
  const ideaWords = new Set(contentWords(idea));
  const known = new Set([...contentWords(fix), ...contentWords(run[best])]);
  if (ideaWords.size && [...ideaWords].filter((w) => known.has(w)).length / ideaWords.size < 0.4) return { reason: 'says more than the sentence it replaces' };
  const ratio = idea.length / run[best].length;
  if (ratio < 0.45 || ratio > 2.2) return { reason: 'would read as a splice (length)' };
  if (best + 1 < run.length && startsNeedingBefore(run[best + 1])) return { reason: 'the next sentence leans on the one replaced' };
  // Every window of `size` sentences that holds the sentence; one is fair only if no other sentence in it says the truth or
  // the falsehood again, since two sentences that disagree leave the student unable to say which is wrong.
  const len = Math.min(size, run.length);
  const fair = [];
  let clash = false;
  for (let start = Math.max(0, best - len + 1); start <= Math.min(best, run.length - len); start++) {
    if (startsNeedingBefore(run[start])) continue;
    const win = run.slice(start, start + len);
    const at = best - start;
    if (win.some((s, i) => i !== at && (similarity(s, fix) >= 0.3 || similarity(s, idea) >= 0.3))) { clash = true; continue; }
    fair.push({ start, at, interior: at > 0 && at < len - 1 });
  }
  if (!fair.length) return { reason: clash ? 'another sentence says the same thing' : 'fewer than four clean sentences around it' };
  fair.sort((a, b) => (b.interior - a.interior) || Math.abs(a.at - len / 2) - Math.abs(b.at - len / 2));
  const pick = fair[0];
  const win = run.slice(pick.start, pick.start + len);
  if (win.length < 4) return { reason: 'fewer than four clean sentences around it' };
  if (leadIn(win[win.length - 1])) return { reason: 'the passage would end on a lead-in' };
  if (!coherent(win.map((t, i) => (i === pick.at ? idea : t)))) return { reason: 'the sentences are not about one thing' };
  const about = (win.join(' ') + ' ' + fix).toLowerCase();
  if (anchors(idea).some((a) => !about.includes(a.toLowerCase()))) return { reason: 'brings in a name or number the passage never mentions' };
  if (anchors(fix).some((a) => !(about + ' ' + idea.toLowerCase()).includes(a.toLowerCase()))) return { reason: 'the correction leans on a worked example the passage does not have' };
  return { sentences: win.map((t, i) => ({ t: i === pick.at ? idea : t, ok: i !== pick.at })), at: pick.at };
}

/** Two questions are about the same facts when they target a common point of the lecture. */
const tied = (x, p) => (x.c.q.targets ?? []).some((t) => (p.q.targets ?? []).includes(t));
function ideaProblem(idea) {
  const p = standaloneProblem(idea);
  if (p) return p;
  if (/\b(I|my|me|you|your)\b/.test(idea)) return 'spoken in the first or second person';
  if (/\b(might|maybe|perhaps|probably|possibly)\b/i.test(idea)) return 'hedged, so it is not plainly false';
  if (!/[.!]$/.test(idea.trim()) && idea.length > 90) return 'not a plain sentence';
  if (/^(thinks|forgets|believes|assumes|confuses|treats|expects|says|takes|uses|reads|counts|mixes|misses|ignores|applies|supposes|gives|calls|writes|answers|states|describes|explains|predicts|compares|equates|mistakes|attributes)\b/i.test(idea)) return 'written about a student, not as a statement';
  return null;
}
/** Numbers and names in a sentence, other than its first word: things the passage must already mention for it to belong there. */
function anchors(sentence) {
  const rest = sentence.replace(/^\S+\s*/, '');
  return (rest.match(/\b\d[\d.,]*\b|\b[A-Z][A-Za-z0-9-]{2,}\b/g) ?? []).filter((x) => !/^(The|This|That|These|Those|It|Its|DNA|RNA)$/.test(x));
}
/** A word a sentence needs: an option that has none is a phrase, not a statement. */
const VERB = /\b(is|are|was|were|has|have|had|can|cannot|could|does|do|did|will|would|must|should|may|means|makes|gives|shows|causes|leads|occurs|forms|binds|moves|requires|produces|increases|decreases|depends|acts|keeps|stays|falls|rises)\b/i;
const withStop = (s) => (/[.!]["')’”]*$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

function spotActivities(packet, stats) {
  const entries = [];
  const pool = [];
  packet.teaching.parts.forEach((part, pi) => {
    const runs = lessonRuns(part);
    for (const q of part.questions ?? []) for (const [wi, w] of (q.wrongIdeas ?? []).entries()) pool.push({ pi, q, w, wi, part, runs });
  });
  const planted = [];
  for (const c of pool) {
    const idea = withStop(c.w.idea);
    const why = ideaProblem(idea);
    const fixAll = plain(c.w.fix);
    let fix = oneSentence(fixAll);
    if (standaloneProblem(fix) || fix.length < 35) fix = fixAll;
    const fixProblem = standaloneProblem(fix) ?? (fix.length > 230 ? 'too long' : null);
    const reject = (r) => { stats.passagesDropped++; stats.reasons[`passage: ${r}`] = (stats.reasons[`passage: ${r}`] ?? 0) + 1; if (VERBOSE) console.log(`  ${packet.pk} ${c.q.id}: ${r}`); };
    if (why) { reject(`idea ${why.slice(0, 40)}`); continue; }
    if (fixProblem) { reject(`correction ${fixProblem.slice(0, 40)}`); continue; }
    // The passage is the lesson's own prose around the point, or the question's model answer when the lesson has no room.
    const ansS = sentences(plain(c.q.answer)).filter((s) => !sentenceProblem(s));
    const lessonS = c.runs.flat();
    // The question's model answer says the truth the idea contradicts; the lesson sentences closest to it give the passage its first lines.
    let pad = [];
    for (const run of c.runs) for (let i = 0; i + 3 <= run.length; i++) {
      const seg = run.slice(i, i + 3);
      const v = seg.reduce((sum, x) => sum + similarity(x, c.q.answer), 0);
      if (v > (pad.v ?? 0.3) && seg.every((x) => !ansS.includes(x))) { pad = seg; pad.v = v; }
    }
    const sources = [...c.runs, [...pad, ...ansS]];
    let made = null, last = 'no run of sentences to draw on';
    for (const run of sources) {
      if (run.length < 4) continue;
      for (const size of [6, 5, 4]) {
        const r = plant(run, idea, withStop(fix), size);
        if (r.sentences) { made = { ...r, size }; break; }
        last = r.reason;
      }
      if (made) break;
    }
    if (!made) { reject(last); continue; }
    if (similarity(idea, withStop(fix)) < 0.12) { reject('the correction does not answer the idea'); continue; }
    planted.push({ ...c, idea, fix: withStop(fix), made });
  }
  // Wrong repairs come from wrong ideas that are never planted, so a falsehood shown as a statement is shown once.
  const plantedIdeas = new Set(planted.map((p) => norm(p.idea)));
  const spare = pool.map((c) => ({ c, idea: withStop(c.w.idea), own: c.q.id })).filter((x) => !plantedIdeas.has(norm(x.idea)) && !ideaProblem(x.idea) && x.idea.length <= 200);
  // Wrong options of the part's multiple-choice questions are wrong statements about the same facts.
  packet.teaching.parts.forEach((part, pi) => {
    for (const q2 of part.questions ?? []) for (const o of q2.options ?? []) {
      if (o.correct) continue;
      const t = withStop(plain(o.text));
      if (!VERB.test(t) || t.split(/\s+/).length < 6 || t.length < 30 || t.length > 200 || ideaProblem(t) || /^(because|yes|no|neither|none|all|both|how|why|what)\b/i.test(t) || /\b(none|all) of the above\b/i.test(t)) continue;
      spare.push({ c: { pi, q: q2 }, idea: t, own: q2.id, option: true });
    }
  });
  const useCount = new Map();
  const finished = [];
  for (const p of planted) {
    const cands = spare
      .map((x) => ({ ...x, s: similarity(x.idea, p.fix) + similarity(x.idea, p.idea) + (x.c.pi === p.pi ? 0.15 : 0) + (x.own === p.q.id ? 0.3 : 0) }))
      .filter((x) => (!x.idea.includes(';') || p.fix.includes(';')) && similarity(x.idea, p.fix) + similarity(x.idea, p.idea) >= (x.c.pi === p.pi ? 0.12 : 0.22) && p.made.sentences.every((t) => similarity(t.t, x.idea) < 0.45) && anchors(x.idea).every((n) => (p.made.sentences.map((t) => t.t).join(' ') + ' ' + p.fix).toLowerCase().includes(n.toLowerCase())) && (useCount.get(x.idea) ?? 0) < 2 && x.idea.length / p.fix.length > 0.4 && x.idea.length / p.fix.length < 2.4 && similarity(x.idea, p.idea) < 0.7)
      .sort((a, b) => b.s - a.s || (a.idea < b.idea ? -1 : 1));
    const chosen = [];
    for (const x of cands) { if (chosen.length >= 2) break; if (chosen.every((y) => similarity(y.idea, x.idea) < 0.6) && similarity(x.idea, p.fix) < 0.6) chosen.push(x); }
    if (chosen.length < 2) { stats.passagesDropped++; stats.reasons['passage: no topical wrong repairs'] = (stats.reasons['passage: no topical wrong repairs'] ?? 0) + 1; continue; }
    for (const x of chosen) useCount.set(x.idea, (useCount.get(x.idea) ?? 0) + 1);
    finished.push({ qid: p.q.id, pi: p.pi, size: p.made.size, passage: { s: p.made.sentences, correction: p.fix, repairs: chosen.map((x) => x.idea) } });
  }
  // Passages with nothing wrong: the same kind of prose, from parts that planted nothing there, so a "none" is a fair answer.
  const none = [];
  packet.teaching.parts.forEach((part, pi) => {
    for (const run of lessonRuns(part)) {
      if (run.length < 4) continue;
      for (let st = 0; st + 4 <= run.length; st += 5) {
        const win = run.slice(st, st + Math.min(5, run.length - st));
        if (win.length >= 4 && !standaloneProblem(win[0]) && !leadIn(win[win.length - 1])) none.push({ pi, win });
      }
    }
  });
  stats.planted += planted.length; stats.finished += finished.length;
  return packSpots(packet, finished, none, stats);
}

function packSpots(packet, finished, none, stats) {
  const acts = [];
  const queue = finished.slice().sort((a, b) => (a.qid < b.qid ? -1 : 1));
  const noneUsed = new Set();
  const used = new Set(finished.flatMap((f) => f.passage.s.map((x) => norm(x.t))));
  const takeNone = (nearPi) => {
    const options = none.filter((n) => !noneUsed.has(n) && n.win.every((s) => !used.has(norm(s)))).sort((a, b) => Math.abs(a.pi - nearPi) - Math.abs(b.pi - nearPi));
    const n = options[0];
    if (!n) return null;
    noneUsed.add(n);
    n.win.forEach((s) => used.add(norm(s)));
    return { s: n.win.map((t) => ({ t, ok: true })) };
  };
  let guard = 0;
  while (queue.length && guard++ < 50) {
    const take = queue.length === 4 ? 2 : queue.length >= 3 ? 3 : queue.length;
    let batch = queue.splice(0, take);
    // About one passage in four is right; with three that is one in three, with four one in four.
    const wantNone = batch.length >= 3 ? 1 : 1;
    const extra = [];
    for (let k = 0; k < wantNone; k++) { const n = takeNone(batch[0].pi); if (n) extra.push(n); }
    if (batch.length + extra.length < 3) {
      stats.activitiesDropped++; stats.reasons['spot: too few passages to make a run'] = (stats.reasons['spot: too few passages to make a run'] ?? 0) + 1;
      continue;
    }
    // Shrink passages until the spec fits the catalogue.
    let spec = null;
    for (let cut = 0; cut <= 3 && !spec; cut++) {
      const passages = [...batch.map((b) => ({ ...b.passage, s: trimWindow(b.passage, cut) })), ...extra];
      // Put the "right" passage after the first, so the first round always has something to find.
      const ordered = [passages[0], ...passages.slice(1).sort((a, b) => (a.correction ? 0 : 1) - (b.correction ? 0 : 1))];
      const candidate = { passages: ordered };
      if (JSON.stringify(candidate).length <= SPEC_BUDGET) spec = candidate;
    }
    if (!spec) { stats.activitiesDropped++; stats.reasons['spot: spec too long for the catalogue'] = (stats.reasons['spot: spec too long for the catalogue'] ?? 0) + 1; continue; }
    const problems = spotLogic.issues(spec);
    if (problems.length) { stats.activitiesDropped++; stats.reasons[`spot issues: ${problems[0].slice(0, 70)}`] = (stats.reasons[`spot issues: ${problems[0].slice(0, 70)}`] ?? 0) + 1; if (VERBOSE) console.log(`  dropped spot ${batch[0].qid}: ${problems.join(' | ')}`); continue; }
    const first = batch[0].qid;
    const group = [];
    const termsPts = batch.map((b) => ({ si: packet.teaching.parts[b.pi].section ?? 0 }));
    const aboutLabels = [...new Set(packet.points.filter((p) => p.about && batch.some((b) => b.pi >= 0 && p.si === (packet.teaching.parts[b.pi].section ?? -1))).map((p) => p.about))];
    for (const label of aboutLabels.slice(0, 6)) group.push({ label, concept: packet.concepts.get(label.toLowerCase()), points: [] });
    const terms = termsFor(packet, group, termsPts);
    if (terms.length < 3) { stats.activitiesDropped++; stats.reasons['spot: too few terms'] = (stats.reasons['spot: too few terms'] ?? 0) + 1; continue; }
    acts.push({
      engine: 'spot',
      id: `ho-spot-${packet.pk}-${slug(first, 20) || hash(first)}`,
      title: clip(`Find the error: ${shortTopic(packet, batch)}`, 90),
      summary: 'A short passage from the lecture with one sentence that may be false. Tap it, or say that nothing is wrong, then pick what it should say.',
      level: 2,
      minutes: 3,
      terms,
      skills: ['spotting-errors'],
      family: `spot-${packet.pk}`,
      cite: batch.map((b) => `${packet.pk}:${b.qid}`),
      spec,
    });
  }
  return acts;
}

function trimWindow(passage, cut) {
  if (!cut) return passage.s;
  // Drop true sentences from the ends, never the false one, keeping at least four.
  let s = passage.s.slice();
  for (let k = 0; k < cut && s.length > 4; k++) {
    const f = s.findIndex((x) => !x.ok);
    if (f === s.length - 1 || (f > 1 && s.length - 1 - f > f)) s = s.slice(0, -1); else if (f > 0 && !startsNeedingBefore(s[1].t)) s = s.slice(1); else s = s.slice(0, -1);
  }
  return s;
}

function shortTopic(packet, batch) {
  const part = packet.teaching.parts[batch[0].pi];
  const sub = packet.draft.sections?.[part.section]?.subsections?.[part.subsection];
  return clip(sub?.title ?? packet.draft.sections?.[part.section]?.title ?? packet.title, 70);
}

// ── Run ──────────────────────────────────────────────────────────────────────

const stats = { cardsDropped: 0, passagesDropped: 0, candidatesDropped: 0, activitiesDropped: 0, pairsSeen: 0, planted: 0, finished: 0, reasons: {} };
const dirs = readdirSync(PACKETS).filter((d) => existsSync(join(PACKETS, d, 'teaching.json'))).sort();
const all = [];
const lines = [];
let lectures = 0;
for (const dir of dirs) {
  const packet = readPacket(dir);
  if (!packet) continue;
  if (packet.missing) { lines.push(`${dir.slice(0, 40).padEnd(40)} skipped: no ${packet.missing}`); continue; }
  lectures++;
  const before = { ...stats };
  const sorts = sortActivities(packet, stats);
  const spots = spotActivities(packet, stats);
  all.push(...sorts, ...spots);
  const d = (k) => stats[k] - before[k];
  lines.push(`${packet.pk} ${packet.dir.slice(4, 44).padEnd(40)} sort ${String(sorts.length).padStart(2)}  spot ${String(spots.length).padStart(2)}  | dropped: ${d('cardsDropped')} statements, ${d('passagesDropped')} passages, ${d('candidatesDropped')} pairs, ${d('activitiesDropped')} activities`);
}

// Ids must be unique across everything written.
const seen = new Set();
for (const a of all) { if (seen.has(a.id)) a.id = `${a.id.slice(0, 58)}-${hash(a.id + JSON.stringify(a.spec)).slice(0, 5)}`; seen.add(a.id); }

if (existsSync(OUT)) for (const f of readdirSync(OUT)) if (f.endsWith('.json')) rmSync(join(OUT, f));
mkdirSync(OUT, { recursive: true });
const ORDER = ['id', 'engine', 'title', 'summary', 'level', 'minutes', 'terms', 'skills', 'family', 'cite', 'spec'];
for (const a of all) writeFileSync(join(OUT, `${a.id}.json`), JSON.stringify(Object.fromEntries(ORDER.map((k) => [k, a[k]])), null, 1) + '\n');

console.log(lines.join('\n'));
const sortN = all.filter((a) => a.engine === 'sort').length, spotN = all.filter((a) => a.engine === 'spot').length;
console.log(`\n${lectures} lectures with a teaching.json and a draft.json: ${all.length} activities written to content/generated (sort ${sortN}, spot ${spotN}).`);
console.log(`Dropped: ${stats.cardsDropped} statements from the pairs that were built, ${stats.passagesDropped} passage candidates, ${stats.candidatesDropped} pairs with too few fair statements, and ${stats.activitiesDropped} finished activities (refused by issues, too long, too few terms or too few passages).`);
console.log(`Find the Error: ${stats.planted} passages could be planted fairly, ${stats.finished} of them found three wrong repairs, and ${spotN} activities hold them.`);
console.log('Why:'); for (const [k, v] of Object.entries(stats.reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

if (SAMPLES) {
  const pick = (list, n) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
  console.log('\n=== SORT CARDS ===');
  for (const a of pick(all.filter((x) => x.engine === 'sort'), 10)) {
    console.log(`\n# ${a.title}  [${a.spec.bins.map((b) => b.label).join(' | ')}]`);
    a.spec.cards.slice(0, 5).forEach((c) => console.log(`  [${c.bin}] ${c.t}`));
  }
  console.log('\n=== SPOT PASSAGES ===');
  for (const a of pick(all.filter((x) => x.engine === 'spot'), 10)) {
    const p = a.spec.passages[0];
    console.log(`\n# ${a.title}`);
    p.s.forEach((x) => console.log(`  ${x.ok ? '   ' : 'XXX'} ${x.t}`));
    console.log(`  FIX: ${p.correction}\n  WRONG: ${p.repairs.join('  //  ')}`);
  }
}
