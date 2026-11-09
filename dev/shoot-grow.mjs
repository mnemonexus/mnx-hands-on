// Looks at Grow, Arrest, Count in the kit's mock host: screenshots at a page, a mid and a narrow panel size, in light and dark
// (and a square-cornered look), with real mouse drags for the sketch. Also runs the kit's readability audit on every screen.
//
//   (in the kit folder)   bun run dev "../Hands On" --port 4176        (never port 1420)
//   MNX_CHROMIUM=<chrome.exe> node dev/shoot-grow.mjs http://127.0.0.1:4176 <out dir> [filter] [sizes] [looks]
//     sizes: comma list of page,mid,panel   looks: comma list of light,dark,square
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = process.env.MNX_KIT || resolve(HERE, '..', '..', 'mnx-addon-kit-release');
const { chromium } = createRequire(join(KIT, 'package.json'))('playwright');
const { auditScript } = await import(pathToFileURL(join(KIT, 'tools', 'src', 'contrast.mjs')).href);

const url = process.argv[2] || 'http://127.0.0.1:4176';
const out = resolve(process.argv[3] || 'shots');
const only = process.argv[4];
const sizeNames = (process.argv[5] || 'page,mid,panel').split(',');
const lookNames = (process.argv[6] || 'light,dark').split(',');
mkdirSync(out, { recursive: true });

const BASE = { mode: 'match', scheme: 'light', accent: null, corners: 8, edges: 'lines', reducedMotion: false, moreColours: true, solidBackdrop: false, lineWidth: 1, lineStrength: 100, shadowStrength: 100 };
const LOOKS = {
  light: { ...BASE },
  dark: { ...BASE, scheme: 'dark' },
  square: { ...BASE, corners: 0 },
  mono: { ...BASE, moreColours: false },
};
const SIZES = { page: { width: 900, height: 1000 }, mid: { width: 640, height: 900 }, panel: { width: 420, height: 900 } };
const ACT = {
  drug: 'ho-grow-056-drug-arrest-points', quiet: 'ho-grow-056-quiescence-and-release', wash: 'ho-grow-056-block-and-release',
  cdc: 'ho-grow-056-temperature-sensitive-cdc2', checks: 'ho-grow-057-three-checkpoints', p53: 'ho-grow-057-p53-p21-arrest',
  fork: 'ho-grow-063-fork-meets-lesion', bypass: 'ho-grow-064-bypass-polymerase-restart',
};

// Scripts run inside the add-on.
const PICK = (i) => `(() => { const b = [...document.querySelectorAll('[data-stage-pick]')]; b[${i}].click(); })()`;
const PICK_FIRST_WRONG = `(() => { const b = [...document.querySelectorAll('[data-stage-pick]')]; b[0].click(); })()`;
const TYPE = (v) => `(() => { const el = document.querySelector('[data-role=answer]'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const AFTER = ['waitFor', '[data-role=after]'];

// A view: the level, the activity, a fixed clock (so the seed, and so the treatment, is known), and steps.
// Steps: [click|fill|waitFor|wait|eval|draw|scrollTop, a, b]. `draw` takes a list of 0..1 heights, one per bar.
const peaky = (bins, centre, spread) => Array.from({ length: bins }, (_, i) => Math.max(0, Math.exp(-((i - centre) ** 2) / (2 * spread * spread))));
const VIEWS = [
  { name: 'r0-ask', level: '0', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['wait', 400]] },
  { name: 'r0-picked', level: '0', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['eval', PICK(3)], ['wait', 300]] },
  { name: 'r0-mid', level: '0', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['eval', PICK(3)], ['click', '[data-action=run]'], ['wait', 2700]] },
  { name: 'r0-done', level: '0', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['eval', PICK(3)], ['click', '[data-action=run]'], AFTER, ['wait', 700]] },
  { name: 'r0-done-wrong', level: '0', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['eval', PICK_FIRST_WRONG], ['click', '[data-action=run]'], AFTER, ['wait', 700]], shotLooks: ['light', 'dark'] },
  { name: 'r0-reduced', level: '0', act: 'drug', now: 1700000000000, reduced: true, steps: [['waitFor', '[data-engine=grow]'], ['eval', PICK(3)], ['click', '[data-action=run]'], AFTER, ['wait', 400]], shotLooks: ['light'] },

  { name: 'r1-ask', level: '1', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['wait', 400]] },
  { name: 'r1-sketch', level: '1', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['draw', peaky(14, 9.5, 1.2)], ['wait', 300]] },
  { name: 'r1-mid', level: '1', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['draw', peaky(14, 9.5, 1.2)], ['click', '[data-action=run]'], ['wait', 2700]] },
  { name: 'r1-done', level: '1', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['draw', peaky(14, 9.5, 1.2)], ['click', '[data-action=run]'], AFTER, ['wait', 900]] },
  { name: 'r1-checks-done', level: '1', act: 'checks', now: 1700000000001, steps: [['waitFor', '[data-engine=grow]'], ['draw', peaky(14, 6.5, 1.2)], ['click', '[data-action=run]'], AFTER, ['wait', 900]] },
  { name: 'r1-checks-ask', level: '1', act: 'checks', now: 1700000000001, steps: [['waitFor', '[data-engine=grow]'], ['wait', 300]], shotLooks: ['light', 'dark'] },
  { name: 'r1-control-ask', level: '1', act: 'cdc', now: 1700000000002, steps: [['waitFor', '[data-engine=grow]'], ['wait', 300]], shotLooks: ['light'] },
  { name: 'r1-fork-done', level: '1', act: 'fork', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['draw', peaky(15, 4, 0.8)], ['click', '[data-action=run]'], AFTER, ['wait', 900]] },
  { name: 'r1-p53-done', level: '1', act: 'p53', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['draw', peaky(14, 5, 1.5)], ['click', '[data-action=run]'], AFTER, ['wait', 900]], shotLooks: ['light', 'dark'] },

  { name: 'r2-ask', level: '2', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['wait', 400]] },
  { name: 'r2-typed', level: '2', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['eval', TYPE('40')], ['wait', 300]] },
  { name: 'r2-done', level: '2', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['eval', TYPE('40')], ['click', '[data-action=run]'], AFTER, ['wait', 900]] },
  { name: 'r2-time-done', level: '2', act: 'wash', now: 1700000000007, steps: [['waitFor', '[data-engine=grow]'], ['eval', TYPE('9')], ['click', '[data-action=run]'], AFTER, ['wait', 900]] },
  { name: 'r2-scrub', level: '2', act: 'drug', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['eval', TYPE('40')], ['click', '[data-action=run]'], AFTER, ['wait', 700], ['eval', `(() => { const r = document.querySelector('[data-role=scrub]'); r.value = String(Number(r.max) * 0.4); r.dispatchEvent(new Event('input', { bubbles: true })); })()`], ['wait', 300]], shotLooks: ['light'] },
  { name: 'r2-zone-note', level: '0', act: 'cdc', now: 1700000000000, steps: [['waitFor', '[data-engine=grow]'], ['click', '[data-stage=g2]'], ['wait', 300]], shotLooks: ['light'] },
];

const browser = await chromium.launch({ executablePath: process.env.MNX_CHROMIUM || undefined });
const problems = [];

for (const sizeName of sizeNames) {
  const size = SIZES[sizeName];
  for (const view of VIEWS) {
    if (only && !`${sizeName}-${view.name}`.includes(only)) continue;
    const context = await browser.newContext({ viewport: { width: 1360, height: 1100 }, reducedMotion: view.reduced ? 'reduce' : 'no-preference' });
    if (view.now) await context.addInitScript(`(() => { const t = ${view.now}; Date.now = () => t; Math.random = () => 0.5; })()`);
    const page = await context.newPage();
    try {
    page.on('pageerror', (e) => problems.push(`${sizeName}/${view.name}: page error ${e.message}`));
    await page.goto(`${url}?scenario=standalone-list&theme=light`);
    await page.evaluate(() => window.__mnxMock.ready());
    await page.evaluate((level) => window.__mnxMock.setSetting('level', level), view.level);
    await page.evaluate(() => window.__mnxMock.launch());
    await page.waitForFunction(() => window.__mnxMock.snapshot().currentReady);
    await page.evaluate(({ width, height }) => { const f = document.getElementById('addon-frame'); f.style.width = `${width}px`; f.style.height = `${height}px`; f.style.margin = '0'; f.parentElement.style.alignItems = 'flex-start'; f.parentElement.style.justifyContent = 'flex-start'; }, size);
    const frame = page.frameLocator('#addon-frame');
    const frameBox = async () => (await (await page.$('#addon-frame')).boundingBox());
    try {
      if (view.act) await frame.locator(`[data-activity=${ACT[view.act]}]`).first().click({ timeout: 8000 });
      for (const [type, a, b] of view.steps) {
        if (type === 'click') await frame.locator(a).first().click({ timeout: 8000 });
        else if (type === 'fill') await frame.locator(a).first().fill(b, { timeout: 8000 });
        else if (type === 'waitFor') await frame.locator(a).first().waitFor({ state: 'visible', timeout: 20000 });
        else if (type === 'wait') await page.waitForTimeout(a);
        else if (type === 'eval') { const handle = await (await page.$('#addon-frame')).contentFrame(); await handle.evaluate(a); }
        else if (type === 'draw') {
          const hit = frame.locator('.ho-gac__hit');
          await hit.scrollIntoViewIfNeeded();
          const box = await hit.boundingBox();
          const bins = a.length;
          const bw = box.width / bins;
          const y = (v) => box.y + box.height * (1 - v);
          await page.mouse.move(box.x + bw * 0.5, y(a[0]));
          await page.mouse.down();
          for (let i = 0; i < bins; i++) await page.mouse.move(box.x + bw * (i + 0.5), y(a[i]), { steps: 2 });
          await page.mouse.up();
        }
      }
    } catch (e) { problems.push(`${sizeName}/${view.name}: ${String(e.message).split('\n')[0]}`); await context.close().catch(() => undefined); continue; }
    await page.waitForTimeout(300);
    const handle = await (await page.$('#addon-frame')).contentFrame();
    const treat = await handle.evaluate(() => document.querySelector('[data-role=treatment]')?.textContent ?? '');
    if (sizeName === sizeNames[0]) console.log(`${view.name}: ${treat}`);
    await handle.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(s); })()`);
    const found = new Map();
    for (const lookName of lookNames) {
      const look = LOOKS[lookName];
      await page.evaluate((patch) => window.__mnxMock.setTheme(patch), look);
      await page.waitForTimeout(150);
      const r = await handle.evaluate(auditScript());
      for (const f of r.failures) {
        const key = `${f.element}|${f.text}`;
        const row = found.get(key) ?? { ...f, looks: [] };
        row.ratio = Math.min(row.ratio, f.ratio);
        row.looks.push(lookName);
        found.set(key, row);
      }
      if (!view.shotLooks || view.shotLooks.includes(lookName)) {
        const fb = await frameBox();
        await page.screenshot({ path: join(out, `${sizeName}-${view.name}-${lookName}.png`), clip: { x: fb.x, y: fb.y, width: size.width, height: Math.min(size.height, 1100) } });
      }
    }
    for (const row of [...found.values()].slice(0, 8)) problems.push(`${sizeName}/${view.name}: hard to read "${row.text}" (${row.element}) ${row.ratio}:1 needs ${row.required}:1 in ${row.looks.join(', ')}`);
    } catch (e) { problems.push(`${sizeName}/${view.name}: ${String(e.message).split('\n')[0]}`); }
    await context.close().catch(() => undefined);
  }
}
await browser.close();
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('no problems');
