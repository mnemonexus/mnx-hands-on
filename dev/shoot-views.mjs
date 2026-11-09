// The screens shoot-engines.mjs visits. A step is [kind, a, b]: click, clickNth, fill, waitFor, wait, scroll, eval (a script run inside the add-on).
const PICK_ALL = `(() => { const rows = [...document.querySelectorAll('.ho-net__row')]; rows.forEach((row, i) => row.querySelectorAll('button')[[2, 0, 1][i % 3]].click()); const opt = document.querySelector('[data-option]'); if (opt) opt.click(); })()`;
const AFTER = ['waitFor', '[data-role=after]'];

// Scripts run inside the add-on to play a round the way a careful student would (or a wrong way, to see the mistake show).
const PEAKS = `const peaks = [...document.querySelectorAll('.ho-sp__peak')].map((g) => ({ g, mz: Number(g.getAttribute('aria-label').replace(/[^0-9.]/g, '')), role: g.dataset.role, marked: g.querySelector('.ho-sp__ring').style.display !== 'none' }));
const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const click = (g) => { const r = g.querySelector('.ho-sp__stem').getBoundingClientRect(); g.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 1, clientY: r.y + 20 })); };`;
const SP_ISO = `(() => { ${PEAKS} const m = peaks.map((p) => p.mz).sort((a, b) => a - b); click(peaks.find((p) => p.mz === m[0]).g); click(peaks.find((p) => p.mz === m[1]).g); const z = Math.round(1.003355 / (m[1] - m[0])); document.querySelector('[data-z="' + z + '"]').click(); })()`;
const SP_ISO_WRONG = `(() => { ${PEAKS} const m = peaks.map((p) => p.mz).sort((a, b) => a - b); click(peaks.find((p) => p.mz === m[0]).g); click(peaks.find((p) => p.mz === m[1]).g); const z = Math.round(1.003355 / (m[1] - m[0])); const wrong = z < 12 ? z + 1 : z - 1; document.querySelector('[data-z="' + wrong + '"]').click(); })()`;
const SP_TAP_TWO = `(() => { ${PEAKS} const m = peaks.slice().sort((a, b) => a.mz - b.mz); click(m[1].g); click(m[2].g); })()`;
const SP_PAIR_TAP = `(() => { ${PEAKS} peaks.filter((p) => p.marked).forEach((p) => click(p.g)); })()`;
const SP_PAIR_RIGHT = `(() => { ${PEAKS} const [a, b] = peaks.filter((p) => p.marked).sort((x, y) => x.mz - y.mz); click(a.g); click(b.g); const n = Math.round((a.mz - 1.00728) / (b.mz - a.mz)); type(document.querySelector('[data-role=charge]'), String(n)); type(document.querySelector('[data-role=answer]'), n + ' * (' + b.mz + ' - 1.00728)'); })()`;
const SP_PAIR_WRONG = `(() => { ${PEAKS} const [a, b] = peaks.filter((p) => p.marked).sort((x, y) => x.mz - y.mz); click(a.g); click(b.g); const n = Math.round((a.mz - 1.00728) / (b.mz - a.mz)) + 1; type(document.querySelector('[data-role=charge]'), String(n)); type(document.querySelector('[data-role=answer]'), n + ' * (' + b.mz + ' - 1.00728)'); })()`;
const SP_DECONV_RIGHT = `(() => { ${PEAKS} const main = peaks.filter((p) => p.role === 'main').sort((x, y) => x.mz - y.mz); const a = main[1]; const b = main[2]; click(a.g); click(b.g); const n = Math.round((a.mz - 1.00728) / (b.mz - a.mz)); type(document.querySelector('[data-role=answer]'), n + ' * (' + b.mz + ' - 1.00728)'); })()`;
const MONO = `{ G: 57.021464, A: 71.037114, S: 87.032028, P: 97.052764, V: 99.068414, T: 101.047679, C: 103.009185, 'L/I': 113.084064, N: 114.042927, D: 115.026943, Q: 128.058578, K: 128.094963, E: 129.042593, M: 131.040485, H: 137.058912, F: 147.068414, R: 156.101111, Y: 163.063329, W: 186.079313 }`;
const LADDER_PICK = `const mono = ${MONO}; const nearest = (d) => Object.entries(mono).sort((x, y) => Math.abs(x[1] - d) - Math.abs(y[1] - d))[0][0];
const pickRow = (row, wrong) => { const d = Number(row.querySelector('[data-role=gap]').textContent.split(':').pop().replace('\\u2212', '-')); let id = nearest(d); if (wrong) id = id === 'G' ? 'A' : 'G'; row.querySelector('[data-res="' + id + '"]').click(); };`;
const SP_LADDER_ONE = `(() => { ${LADDER_PICK} pickRow(document.querySelector('[data-row="0"]'), false); pickRow(document.querySelector('[data-row="1"]'), true); })()`;
const SP_LADDER_ALL = `(() => { ${LADDER_PICK} document.querySelectorAll('.ho-sp__row').forEach((row, i) => { pickRow(document.querySelector('[data-row="' + i + '"]'), i === 2); }); })()`;
const SHIFT_SOLVE = `${PEAKS} const z = Number(/the (\\d+)[+\\u2212]/.exec(document.querySelector('[data-role=announce]').textContent)[1]); const before = peaks.find((p) => p.role === 'before'); const after = peaks.find((p) => p.role === 'after'); click(after.g);
const rows = [...document.querySelectorAll('.ho-sp__table tbody tr')].map((tr) => ({ name: tr.querySelector('th').textContent, delta: Number(tr.children[1].textContent.replace('\\u2212', '-')) }));
const dm = Math.abs(after.mz - before.mz) * z; let best = null; for (const r of rows) for (const c of [1, 2, 3]) { const e = Math.abs(r.delta * c - dm); if (!best || e < best.e) best = { r, c, e }; }
const buttons = [...document.querySelectorAll('[data-mod]')]; const pick = (name) => buttons.find((b) => b.textContent === name).click();`;
const SP_SHIFT_RIGHT = `(() => { ${SHIFT_SOLVE} pick(best.r.name); document.querySelector('[data-count="' + best.c + '"]').click(); })()`;
const SP_SHIFT_WRONG = `(() => { ${SHIFT_SOLVE} const other = rows.find((r) => r.name !== best.r.name); pick(other.name); document.querySelector('[data-count="' + best.c + '"]').click(); })()`;

export const VIEWS = [
  { name: 'home', level: 'auto', steps: [['waitFor', '[data-view=home]']], shotLooks: ['light'] },

  // ── Knock It Out ─────────────────────────────────────────────────────────
  { name: 'net-trp-r0-ask', level: '0', act: 'trp', steps: [['waitFor', '[data-engine=network]'], ['wait', 500]] },
  { name: 'net-trp-r0-picked', level: '0', act: 'trp', steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['wait', 300]] },
  { name: 'net-trp-r0-mid', level: '0', act: 'trp', steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['click', '[data-action=run]'], ['wait', 2300]] },
  { name: 'net-trp-r0-done', level: '0', act: 'trp', steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['click', '[data-action=run]'], AFTER, ['wait', 500]] },
  { name: 'net-trp-r1-ask', level: '1', act: 'trp', steps: [['waitFor', '[data-engine=network]'], ['wait', 400]], shotLooks: ['light', 'dark'] },
  { name: 'net-trp-r2-identify', level: '2', act: 'trp', now: 1700000000003, steps: [['waitFor', '[data-engine=network]'], ['wait', 300]] },
  { name: 'net-trp-r2-identify-done', level: '2', act: 'trp', now: 1700000000003, steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['click', '[data-action=run]'], AFTER, ['wait', 500]] },
  { name: 'net-trp-r2-double', level: '2', act: 'trp', now: 1700000000000, steps: [['waitFor', '[data-engine=network]'], ['wait', 300]] },
  { name: 'net-trp-r2-double-done', level: '2', act: 'trp', now: 1700000000000, steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['click', '[data-action=run]'], AFTER, ['wait', 500]] },
  { name: 'net-trp-note', level: '0', act: 'trp', steps: [['waitFor', '[data-engine=network]'], ['click', '[data-node=trp]'], ['wait', 200]], shotLooks: ['light'] },
  { name: 'net-trp-dotted', level: '0', act: 'trp', steps: [['waitFor', '[data-engine=network]'], ['wait', 300], ['eval', `document.querySelector('.ho-net__chip--no').dispatchEvent(new MouseEvent('click', { bubbles: true }))`], ['wait', 200]], shotLooks: ['light'] },
  { name: 'net-eif2-r0-done', level: '0', act: 'eif2', steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['click', '[data-action=run]'], AFTER, ['wait', 500]] },
  { name: 'net-dna-r1-ask', level: '1', act: 'dna', steps: [['waitFor', '[data-engine=network]'], ['wait', 400]] },
  { name: 'net-dna-r1-done', level: '1', act: 'dna', steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['click', '[data-action=run]'], AFTER, ['wait', 500]], shotLooks: ['light', 'dark'] },
  { name: 'net-trp-r0-reduced', level: '0', act: 'trp', reduced: true, steps: [['waitFor', '[data-engine=network]'], ['eval', PICK_ALL], ['click', '[data-action=run]'], AFTER, ['wait', 300]], shotLooks: ['light'] },

  // ── Read the Spectrum ────────────────────────────────────────────────────
  { name: 'sp-cs-r0-ask', level: '0', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['wait', 400]] },
  { name: 'sp-cs-r0-tapped', level: '0', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_TAP_TWO], ['click', '[data-action=working]'], ['wait', 300]] },
  { name: 'sp-cs-r0-done', level: '0', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_ISO], ['click', '[data-action=check]'], AFTER, ['wait', 400]] },
  { name: 'sp-cs-r0-wrong', level: '0', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_ISO_WRONG], ['click', '[data-action=check]'], AFTER, ['wait', 400]] },
  { name: 'sp-cs-r1-ask', level: '1', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['wait', 400]] },
  { name: 'sp-cs-r1-work', level: '1', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_PAIR_TAP], ['click', '[data-action=working]'], ['fill', '[data-role=charge]', '9'], ['wait', 300]] },
  { name: 'sp-cs-r1-done', level: '1', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_PAIR_RIGHT], ['click', '[data-action=check]'], AFTER, ['wait', 400]] },
  { name: 'sp-cs-r1-wrong', level: '1', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_PAIR_WRONG], ['click', '[data-action=check]'], AFTER, ['wait', 400]] },
  { name: 'sp-cs-r2-ask', level: '2', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['wait', 400]] },
  { name: 'sp-cs-r2-done', level: '2', act: 'cs', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_DECONV_RIGHT], ['click', '[data-action=check]'], AFTER, ['wait', 400]] },
  { name: 'sp-lad-r2-ask', level: '2', act: 'lad', steps: [['waitFor', '[data-engine=spectrum]'], ['wait', 400]] },
  { name: 'sp-lad-r2-mid', level: '2', act: 'lad', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_LADDER_ONE], ['wait', 400]] },
  { name: 'sp-lad-r2-done', level: '2', act: 'lad', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_LADDER_ALL], AFTER, ['wait', 600]] },
  { name: 'sp-lad-r2-b-done', level: '2', act: 'lad', now: 1700000000001, steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_LADDER_ALL], AFTER, ['wait', 600]] },
  { name: 'sp-lad-r2-ref', level: '2', act: 'lad', steps: [['waitFor', '[data-engine=spectrum]'], ['click', '[data-role=reference] summary'], ['wait', 300]], shotLooks: ['light', 'dark'] },
  { name: 'sp-shift-r2-ask', level: '2', act: 'shift', steps: [['waitFor', '[data-engine=spectrum]'], ['wait', 400]] },
  { name: 'sp-shift-r2-done', level: '2', act: 'shift', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_SHIFT_RIGHT], ['click', '[data-action=check]'], AFTER, ['wait', 400]] },
  { name: 'sp-shift-r2-wrong', level: '2', act: 'shift', steps: [['waitFor', '[data-engine=spectrum]'], ['eval', SP_SHIFT_WRONG], ['click', '[data-action=check]'], AFTER, ['wait', 400]] },
  { name: 'sp-shift-r1-ask', level: '1', act: 'shift', steps: [['waitFor', '[data-engine=spectrum]'], ['wait', 400]], shotLooks: ['light', 'dark'] },
];
