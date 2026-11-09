import { describe, expect, test } from 'bun:test';
import { pinnedFor } from './pinned';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildNet, clampOf, issues, levelName, prepare, propagate, result, steady, whySentence, type Dir, type NetAttempt, type NetSpec, type NetTask,
} from '../src/engines/network/logic';
import { engines } from '../src/engines/registry';

const ROOT = join(import.meta.dir, '..');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const content: Record<string, { id: string; spec: NetSpec }> = {};
const pinned = pinnedFor<{ id: string; spec: NetSpec }>('network');
for (const f of readdirSync(join(ROOT, 'content', 'network'))) if (f.endsWith('.json')) content[f.replace('.json', '')] = readJson('content', 'network', f);
const fixtures: Record<string, NetSpec> = {};
for (const f of readdirSync(join(ROOT, 'test', 'fixtures', 'network'))) if (f.endsWith('.json')) fixtures[f.replace('.json', '')] = readJson('test', 'fixtures', 'network', f);
const specs: Array<[string, NetSpec]> = [...Object.entries(content).map(([k, v]) => [k, v.spec] as [string, NetSpec]), ...Object.entries(fixtures)];
const clone = (s: NetSpec) => JSON.parse(JSON.stringify(s)) as NetSpec;

/** What happens to each node, by id, when the named changes are made. */
function effect(spec: NetSpec, ...ids: string[]): Record<string, Dir> {
  const net = buildNet(spec);
  const before = steady(net).state;
  const ps = ids.map((id) => spec.perturbations.find((p) => p.id === id)!);
  const after = propagate(net, before, clampOf(net, ps)).after;
  return Object.fromEntries(spec.nodes.map((n, i) => [n.id, after[i] > before[i] ? 'up' : after[i] < before[i] ? 'down' : 'same'])) as Record<string, Dir>;
}

describe('the shipped activities are fit to use', () => {
  for (const [name, spec] of specs) {
    test(`${name} has no issues and fits the catalogue`, () => {
      expect(issues(spec)).toEqual([]);
      expect(JSON.stringify(spec).length).toBeLessThanOrEqual(4096);
    });
  }
  test('there are real activities and two from other subjects', () => {
    expect(Object.keys(content).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(fixtures).sort()).toEqual(['ecology-wolves', 'economics-interest-rate']);
  });
});

describe('what the lectures say, worked out by the engine', () => {
  test('trp operon (012): losing the repressor switches transcription on, but the attenuator still stops the mRNA', () => {
    const e = effect(pinned['trp-operon'].spec, 'norepr');
    expect(e.tx).toBe('up'); // 012:p61, p64
    expect(e.genes).toBe('same'); // 012:p82-p83: with tryptophan-tRNA high the polymerase terminates
    expect(e.enz).toBe('same');
  });
  test('trp operon: with no tryptophan the repressor is inactive and the leader does not terminate', () => {
    const e = effect(pinned['trp-operon'].spec, 'starve');
    expect(e.active).toBe('down'); // p62-p63
    expect(e.tx).toBe('up'); // p61
    expect(e.term).toBe('down'); // p78-p80
    expect(e.genes).toBe('up');
    expect(e.enz).toBe('up');
  });
  test('trp operon: removing the repressor and the attenuator together lets the genes be made even with tryptophan', () => {
    expect(effect(pinned['trp-operon'].spec, 'norepr', 'noterm').genes).toBe('up'); // p85: two adjacent ways of regulating
  });
  test('eIF2 (031): salubrinal pushes translation down, GADD34 or blocking the prion protein brings it back', () => {
    const spec = pinned['eif2-integrated-stress'].spec;
    expect(effect(spec, 'salub')).toMatchObject({ eifp: 'up', trans: 'down', syn: 'down' }); // p43, p47
    expect(effect(spec, 'gadd34')).toMatchObject({ eifp: 'down', trans: 'up', syn: 'up' }); // p47, p49
    expect(effect(spec, 'shprp')).toMatchObject({ eifp: 'down', trans: 'up', syn: 'up' }); // p47, p49
    expect(effect(spec, 's51a')).toMatchObject({ trans: 'up' }); // p106
  });
  test('DNA damage (057): after damage the checkpoint holds the cycle, and losing p53, ATM or p21 lets it go on', () => {
    const spec = pinned['dna-damage-checkpoint'].spec;
    const net = buildNet(spec);
    const b = steady(net).state;
    const at = (id: string) => levelName(b[net.index.get(id) as number]);
    expect(at('p53')).toBe('high'); // pp3
    expect(at('cdk')).toBe('off'); // pp5, pp7
    expect(at('prog')).toBe('off'); // pp7
    for (const id of ['nop53', 'noatm', 'repair', 'nop21']) expect(effect(spec, id)).toMatchObject({ cdk: 'up', prog: 'up' }); // ck6
    expect(effect(spec, 'nop53', 'no25').prog).toBe('same'); // without Cdc25 there is still no Cdk activity
  });
  test('TOR (031): rapamycin, hypoxia and starvation all keep 4E-BP on eIF4E, but the IRES message is not cut by rapamycin', () => {
    const spec = pinned['tor-cap-dependent-translation'].spec;
    expect(effect(spec, 'rapamycin')).toMatchObject({ tor: 'down', bp: 'up', cbc: 'down', cap: 'down', ires: 'same' }); // p67, p70, p71, p74
    for (const id of ['hypoxia', 'starve']) expect(effect(spec, id)).toMatchObject({ tor: 'down', bp: 'up', cap: 'down' }); // p66, p85, p86
  });
  test('what the model cannot say is never asked: no question says an IRES message stays put in hypoxia', () => {
    const spec = pinned['tor-cap-dependent-translation'].spec;
    for (const p of spec.perturbations.filter((q) => q.node === 'hyp' || q.node === 'nutr')) expect(p.outputs ?? spec.outputs).not.toContain('ires'); // p87, p88
    expect(spec.edges.some((e) => e.from === 'hyp' && e.to === 'ires' && e.notModelled)).toBe(true);
  });
  test('an arrow marked notModelled carries nothing', () => {
    const spec = pinned['trp-operon'].spec;
    expect(effect(spec, 'starve').trp).toBe('down'); // the enzymes do not feed it back
    expect(spec.edges.some((e) => e.notModelled)).toBe(true);
  });
});

describe('a spec from another subject runs with no code change', () => {
  test('economics: dearer money cools investment, jobs and prices', () => {
    expect(effect(fixtures['economics-interest-rate'], 'hike')).toMatchObject({ borrow: 'up', invest: 'down', jobs: 'down', price: 'down' });
  });
  test('ecology: taking the wolves away lets the deer eat the grass and the birds go', () => {
    expect(effect(fixtures['ecology-wolves'], 'cull')).toMatchObject({ wolves: 'down', deer: 'up', grass: 'down', birds: 'down' });
    expect(effect(fixtures['ecology-wolves'], 'pack')).toMatchObject({ deer: 'down', grass: 'up', birds: 'up' });
  });
  test.each(Object.entries(fixtures))('%s sets sensible questions at every rung', (_n, spec) => {
    for (let rung = 0; rung < 3; rung++) {
      for (let i = 0; i < 40; i++) {
        const t = prepare(spec, `fixture${i}:${i % 3}`, rung);
        expect(t.announce.length).toBeGreaterThan(5);
        expect(t.outputs.length).toBeGreaterThan(0);
      }
    }
  });
  test('the engine code mentions no subject', () => {
    const words = ['trp', 'operon', 'tryptophan', 'repressor', 'p53', 'eif2', 'kinase', 'translation', 'protein', 'cell', 'gene', 'checkpoint', 'wolf', 'deer', 'interest', 'economy', 'ribosome', 'dna'];
    for (const file of ['engines/network/logic.ts', 'engines/network/view.ts', 'engines/network/network.css']) {
      const text = readFileSync(join(ROOT, 'src', file), 'utf8').toLowerCase().replace(/\bgenerat\w*/g, '').replace(/\bgeneral\w*/g, '');
      for (const word of words) expect(`${file}: ${text.includes(word) ? word : ''}`).toBe(`${file}: `);
    }
  });
});

describe('settling', () => {
  const chain = (): NetSpec => ({
    nodes: [
      { id: 'a', label: 'Source', x: 12, y: 50 },
      { id: 'b', label: 'Middle', x: 37, y: 50 },
      { id: 'c', label: 'Far end', x: 62, y: 50 },
      { id: 'd', label: 'Helper', x: 87, y: 50, level: 'off' },
    ],
    edges: [
      { from: 'a', to: 'b', sign: '+', reason: 'The source drives the middle.' },
      { from: 'b', to: 'c', sign: '+', reason: 'The middle drives the far end.' },
    ],
    outputs: ['c'],
    perturbations: [{ id: 'x', node: 'a', kind: 'remove', label: 'Remove the source' }, { id: 'y', node: 'b', kind: 'block', label: 'Block the middle' }],
  });
  test('a plain chain settles', () => expect(issues(chain())).toEqual([]));
  test('a feedback loop that keeps changing is refused in words', () => {
    const s = chain();
    s.edges.push({ from: 'c', to: 'b', sign: '-', reason: 'The far end shuts the middle.' });
    const found = issues(s).join(' | ');
    expect(found).toContain('does not settle');
    expect(found).toContain('notModelled');
  });
  test('a loop that rests in different places depending on where it starts is refused', () => {
    const s = chain();
    s.edges = [
      { from: 'b', to: 'c', sign: '+', reason: 'The middle drives the far end.' },
      { from: 'c', to: 'b', sign: '+', reason: 'The far end drives the middle.' },
      { from: 'a', to: 'd', sign: '+', reason: 'The source drives the helper.' },
    ];
    s.nodes[1].needs = 'any'; s.nodes[2].needs = 'any';
    expect(issues(s).join(' | ')).toContain('does not settle');
  });
  test('the same loop marked notModelled is accepted, and a change does not cross it', () => {
    const s = chain();
    s.edges.push({ from: 'c', to: 'a', notModelled: 'The far end feeds back on the source. That loop is left out.' });
    expect(issues(s)).toEqual([]);
    const t = chain();
    t.edges.push({ from: 'c', to: 'd', notModelled: 'The far end would feed the helper. That is left out.' });
    expect(effect(t, 'x').d).toBe('same');
  });
});

describe('setting a question', () => {
  test('the same seed gives the same task, and seeds differ', () => {
    for (const [, spec] of specs) {
      for (let rung = 0; rung < 3; rung++) expect(JSON.stringify(prepare(spec, 'run1:0', rung))).toBe(JSON.stringify(prepare(spec, 'run1:0', rung)));
    }
    const seen = new Set(Array.from({ length: 30 }, (_, i) => prepare(pinned['eif2-integrated-stress'].spec, `s${i}:${i % 3}`, 0).announce));
    expect(seen.size).toBeGreaterThan(2);
  });
  test('every task is consistent with the rules, for every spec, rung and seed', () => {
    for (const [, spec] of specs) {
      for (let rung = 0; rung < 3; rung++) {
        for (let i = 0; i < 40; i++) {
          const t = prepare(spec, `c${i}:${i % 3}`, rung);
          const net = t.net;
          expect(propagate(net, t.before, clampOf(net, t.changes)).after).toEqual(t.after);
          // Replaying the hops lands on the answer, and each hop starts where the last left the node.
          const replay = t.before.slice();
          for (const step of t.steps) for (const hop of step.hops) { expect(replay[hop.node]).toBe(hop.from); replay[hop.node] = hop.to; }
          expect(replay).toEqual(t.after);
          for (const o of t.outputs) {
            const k = net.index.get(o) as number;
            expect(t.truth[o]).toBe(t.after[k] > t.before[k] ? 'up' : t.after[k] < t.before[k] ? 'down' : 'same');
            expect(t.changes.some((c) => c.node === o)).toBe(false);
          }
          expect(t.showSigns).toBe(rung === 0);
          if (rung < 2) { expect(t.mode).toBe('predict'); expect(t.changes.length).toBe(1); }
          if (t.changes.length === 2) expect(t.changes[0].node).not.toBe(t.changes[1].node);
          if (t.mode === 'identify') {
            expect(t.options.length).toBeGreaterThanOrEqual(3);
            expect(t.options.some((o) => o.id === t.answer)).toBe(true);
            const picture = (after: readonly number[]) => t.outputs.map((x) => { const k = net.index.get(x) as number; return after[k] > t.before[k] ? 'up' : after[k] < t.before[k] ? 'down' : 'same'; }).join();
            for (const o of t.options) {
              if (o.id === t.answer) continue;
              const p = spec.perturbations.find((q) => q.id === o.id)!;
              expect(picture(propagate(net, t.before, clampOf(net, [p])).after)).not.toBe(picture(t.after));
            }
          }
        }
      }
    }
  });
  test('rung 2 gives both a double change and a backwards question across seeds', () => {
    const modes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      for (const spec of [pinned['trp-operon'].spec, pinned['eif2-integrated-stress'].spec]) {
        const t = prepare(spec, `m${i}:${i % 3}`, 2);
        modes.add(t.mode === 'identify' ? 'identify' : t.changes.length === 2 ? 'double' : 'single');
      }
    }
    expect(modes.has('identify')).toBe(true);
    expect(modes.has('double')).toBe(true);
  });
  test('every hop after the first came along an arrow that carries a reason', () => {
    for (const [, spec] of specs) {
      for (let i = 0; i < 30; i++) {
        const t = prepare(spec, `h${i}:${i % 3}`, i % 3);
        t.steps.forEach((step, k) => step.hops.forEach((hop) => {
          if (k === 0) { expect(hop.via).toEqual([]); return; }
          expect(hop.via.length).toBeGreaterThan(0);
          for (const e of hop.via) { expect(spec.edges[e].notModelled).toBeUndefined(); expect((spec.edges[e].reason ?? '').length).toBeGreaterThan(5); }
        }));
      }
    }
  });
});

describe('judging an attempt', () => {
  const answerRight = (t: NetTask): NetAttempt => (t.mode === 'identify' ? { kind: 'identify', pick: t.answer } : { kind: 'predict', answers: { ...t.truth } });
  test('the right answer is met, in words a student can read, with a sentence on why', () => {
    for (const [, spec] of specs) {
      for (let rung = 0; rung < 3; rung++) {
        for (let i = 0; i < 10; i++) {
          const t = prepare(spec, `r${i}:${i % 3}`, rung);
          const r = result(t, answerRight(t));
          expect(r.met).toBe(true);
          expect(r.label.length).toBeGreaterThan(20);
          expect(r.label.length).toBeLessThanOrEqual(200);
          expect(r.why).toBe(whySentence(t));
          expect(r.why).toMatch(/\.$/);
          expect(r.misconception).toBeUndefined();
        }
      }
    }
  });
  test('a reversed answer is missed and named', () => {
    const t = prepare(pinned['trp-operon'].spec, 'wrong:0', 0);
    const answers = { ...t.truth };
    const moved = t.outputs.find((o) => t.truth[o] !== 'same') as string;
    answers[moved] = t.truth[moved] === 'up' ? 'down' : 'up';
    const r = result(t, { kind: 'predict', answers });
    expect(r.met).toBe(false);
    expect(r.misconception).toMatch(/blocks/);
  });
  test('saying "same" where it moves is a different slip from spreading a change that stops', () => {
    const t = prepare(pinned['trp-operon'].spec, 'wrong:1', 0);
    const moved = t.outputs.find((o) => t.truth[o] !== 'same');
    expect(moved).toBeTruthy();
    expect(result(t, { kind: 'predict', answers: { ...t.truth, [moved as string]: 'same' } }).misconception).toMatch(/no effect/);
    const still = t.outputs.find((o) => t.truth[o] === 'same');
    if (still) expect(result(t, { kind: 'predict', answers: { ...t.truth, [still]: 'up' } }).misconception).toMatch(/holds steady/);
  });
  test('a missing answer is an error, not a pass', () => {
    const t = prepare(pinned['trp-operon'].spec, 'x:0', 0);
    expect(() => result(t, { kind: 'identify', pick: 'a' })).toThrow();
  });
});

describe('refusing a bad spec', () => {
  const has = (spec: unknown, text: string) => expect(issues(spec as NetSpec).join(' | ')).toContain(text);
  const base = () => clone(fixtures['ecology-wolves']);
  test('too few nodes', () => { const s = base(); s.nodes = s.nodes.slice(0, 3); s.edges = []; has(s, '4 to 9 nodes'); });
  test('an arrow to a node that is not there', () => { const s = base(); s.edges[0].to = 'nope'; has(s, '`from` and `to`'); });
  test('an arrow with no reason', () => { const s = base(); delete s.edges[0].reason; has(s, '`reason`'); });
  test('an arrow with no sign', () => { const s = base(); delete s.edges[0].sign; has(s, '`sign`'); });
  test('two nodes on top of each other', () => { const s = base(); s.nodes[1].x = 14; s.nodes[1].y = 52; has(s, 'on top of each other'); });
  test('an arrow that runs behind another node', () => {
    const s = base();
    s.nodes[1].x = 87; s.nodes[2].x = 37; s.nodes[3].x = 62; s.nodes[3].y = 84;
    has(s, 'runs behind');
  });
  test('two activators with no rule for them', () => {
    const s = base();
    s.edges.push({ from: 'hunters', to: 'grass', sign: '+', reason: 'A made-up arrow for the test.' }, { from: 'wolves', to: 'grass', sign: '+', reason: 'Another made-up arrow for the test.' });
    has(s, 'needs');
  });
  test('a level that would be ignored', () => { const s = base(); s.nodes[3].level = 'low'; has(s, 'would be ignored'); });
  test('a change that does nothing', () => { const s = base(); s.perturbations.push({ id: 'dud', node: 'hunters', kind: 'remove', label: 'Remove the hunting' }); has(s, 'changes nothing'); });
  test('a change that touches a marked output', () => { const s = base(); s.perturbations[2].outputs = ['deer', 'grass']; has(s, 'also marked as an output'); });
  test('a change that moves nothing alone or with anything else', () => {
    const s = base();
    s.nodes.push({ id: 'spare', label: 'Idle node', x: 87, y: 84, level: 'high' });
    s.perturbations.push({ id: 'idle', node: 'spare', kind: 'remove', label: 'Remove the idle node' });
    has(s, 'nothing to predict');
  });
  test('a spec too long for the catalogue', () => { const s = base(); s.note = 'x'.repeat(5000); has(s, 'allows 4096'); });
  test('a notModelled arrow with no explanation', () => { const s = base(); s.edges.push({ from: 'grass', to: 'deer', notModelled: 'short' }); has(s, '`notModelled`'); });
  test('things that are not specs at all', () => {
    expect(issues(null as unknown as NetSpec).length).toBeGreaterThan(0);
    expect(issues({} as NetSpec).length).toBeGreaterThan(0);
    expect(issues('x' as unknown as NetSpec).length).toBeGreaterThan(0);
  });
  test('words a writer can act on, and few of them', () => {
    const s = base(); s.edges[0].to = 'nope';
    const found = issues(s);
    expect(found.length).toBeLessThanOrEqual(14);
    expect(found[0]).toMatch(/^[A-Z`]/);
  });
});

describe('the engine is registered', () => {
  test('network is in the registry with everything an engine needs', () => {
    const e = engines['network'];
    expect(e.id).toBe('network');
    expect(e.label).toBe('Knock It Out');
    for (const fn of ['issues', 'prepare', 'view', 'result'] as const) expect(typeof e[fn]).toBe('function');
  });
});
