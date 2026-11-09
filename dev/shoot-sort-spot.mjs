// Looks at Sort and Find the Error in the kit's mock host: screenshots at a page size, a narrow Session Mode panel and a
// middle size, in light, dark and dark with round corners and shadows, with real clicks and the kit's readability audit on what
// each screen shows.
//
//   (in the kit folder)   bun run dev "../../Hands On" --port 4176        (never port 1420)
//   MNX_CHROMIUM=<chrome.exe> node dev/shoot-sort-spot.mjs http://127.0.0.1:4176 <out folder> [filter]
//
// The script reads assets/practice/catalogue.json to know which sentence is false, so it can play the engine the way a student
// who knows would (the page itself never says).
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MNX_ADDON_ROOT || resolve(HERE, '..');
const KIT = process.env.MNX_KIT || resolve(ROOT, '..', 'mnx-addon-kit-release');
const { chromium } = createRequire(join(KIT, 'package.json'))('playwright');
const { auditScript } = await import(pathToFileURL(join(KIT, 'tools', 'src', 'contrast.mjs')).href);

const url = process.argv[2] || 'http://127.0.0.1:4176';
const out = resolve(process.argv[3] || 'shots');
const only = process.argv[4];
mkdirSync(out, { recursive: true });
const catalogue = JSON.parse(readFileSync(join(ROOT, 'assets', 'practice', 'catalogue.json'), 'utf8'));
const byId = new Map(catalogue.activities.map((a) => [a.id, a]));

const BASE = { mode: 'match', scheme: 'light', accent: null, corners: 8, edges: 'lines', reducedMotion: false, moreColours: true, solidBackdrop: false, lineWidth: 1, lineStrength: 100, shadowStrength: 100 };
const LOOKS = {
  light: { ...BASE },
  dark: { ...BASE, scheme: 'dark' },
  square: { ...BASE, corners: 0, edges: 'lines' },
  'dark-round-shadows': { ...BASE, scheme: 'dark', corners: 16, edges: 'shadows' },
  mono: { ...BASE, moreColours: false },
};
const SHOTS = ['light', 'dark', 'dark-round-shadows'];
const SIZES = { page: { width: 900, height: 1000 }, panel: { width: 420, height: 900 }, mid: { width: 640, height: 900 } };

const SORT2 = process.env.SORT2 || 'ho-sort-033-cytochrome-p450-laccase';
const SORT3 = process.env.SORT3 || 'ho-sort-063-replication-tautomer-strand';
const SPOT = process.env.SPOT || 'ho-spot-033-p02q2';
for (const id of [SORT2, SORT3, SPOT]) if (!byId.has(id)) throw new Error(`The catalogue has no ${id}; set SORT2, SORT3 or SPOT.`);
const falseTexts = byId.get(SPOT).launch.spec.passages.flatMap((p) => p.s.filter((s) => !s.ok).map((s) => s.t));
const corrections = new Map(byId.get(SPOT).launch.spec.passages.filter((p) => p.correction).map((p) => [p.correction, p]));

// A step is [kind, a, b]. `fn` steps get the frame, the page and the helpers.
const sleep = (page, ms) => page.waitForTimeout(ms);
const VIEWS = [
  { name: 'sort-r0-ask', level: '0', act: SORT2, steps: [['waitFor', '[data-role=card]'], ['wait', 450]] },
  { name: 'sort-r0-bounce', level: '0', act: SORT2, steps: [['waitFor', '[data-role=card]'], ['fn', 'bounce']] },
  { name: 'sort-r0-mid', level: '0', act: SORT2, steps: [['waitFor', '[data-role=card]'], ['fn', 'settle', 3], ['wait', 500]] },
  { name: 'sort-r0-end', level: '0', act: SORT2, steps: [['waitFor', '[data-role=card]'], ['fn', 'settle', 99], ['waitFor', '[data-role=after]'], ['wait', 500]] },
  { name: 'sort-r1-ask', level: '1', act: SORT2, steps: [['waitFor', '[data-role=card]'], ['wait', 450]] },
  { name: 'sort-r1-end', level: '1', act: SORT2, steps: [['waitFor', '[data-role=card]'], ['fn', 'settle', 99], ['waitFor', '[data-role=after]'], ['wait', 500]] },
  { name: 'sort-r2-ask', level: '2', act: SORT3, steps: [['waitFor', '[data-role=card]'], ['wait', 450]] },
  { name: 'sort-r2-bounce', level: '2', act: SORT3, steps: [['waitFor', '[data-role=card]'], ['fn', 'bounce']] },
  { name: 'sort-r2-end', level: '2', act: SORT3, steps: [['waitFor', '[data-role=card]'], ['fn', 'settle', 99], ['waitFor', '[data-role=after]'], ['wait', 500]] },
  { name: 'sort-unclear', level: '0', act: SORT2, steps: [['waitFor', '[data-role=card]'], ['click', '[data-action=unclear]'], ['wait', 500]] },
  { name: 'spot-r0-ask', level: '0', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['wait', 400]] },
  { name: 'spot-r1-ask', level: '1', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['wait', 400]] },
  { name: 'spot-r2-ask', level: '2', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['wait', 400]] },
  { name: 'spot-repair', level: '1', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['fn', 'tapFalse'], ['waitFor', '[data-role=repair] .mnx-choice'], ['wait', 300]] },
  { name: 'spot-right', level: '1', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['fn', 'tapFalse'], ['waitFor', '[data-role=repair] .mnx-choice'], ['fn', 'chooseRight'], ['waitFor', '[data-role=fix]'], ['wait', 700]] },
  { name: 'spot-wrong-repair', level: '1', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['fn', 'tapFalse'], ['waitFor', '[data-role=repair] .mnx-choice'], ['fn', 'chooseWrong'], ['waitFor', '[data-role=fix]'], ['wait', 700]] },
  { name: 'spot-tapped-true', level: '1', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['fn', 'tapTrue'], ['waitFor', '[data-role=after]'], ['wait', 700]] },
  { name: 'spot-none', level: '1', act: SPOT, steps: [['waitFor', '[data-role=passage]'], ['click', '[data-action=none]'], ['waitFor', '[data-role=after]'], ['wait', 700]] },
];

const browser = await chromium.launch({ executablePath: process.env.MNX_CHROMIUM || undefined });
const problems = [];

/** What the helpers do in the frame. */
async function run(fn, frame, page, arg) {
  if (fn === 'bounce') {
    // Press the first bin until a statement bounces back, so the reason and the shaken card are on screen.
    for (let i = 0; i < 12; i++) {
      const wrong = await frame.locator('[data-role=card][data-state=wrong]').count();
      if (wrong) { await sleep(page, 150); return; }
      const bins = await frame.locator('[data-action^=bin-]').count();
      for (let b = 0; b < bins - 1; b++) {
        await frame.locator(`[data-action=bin-${b}]`).first().click({ timeout: 4000 });
        await sleep(page, 360);
        if (await frame.locator('[data-role=card][data-state=wrong]').count()) { await sleep(page, 150); return; }
      }
      await sleep(page, 700);
    }
  } else if (fn === 'settle') {
    // Play on: every statement is tried in each bin in turn until it settles; stop after `arg` statements have settled.
    let guard = 0;
    while (guard++ < 120) {
      if (await frame.locator('[data-role=after]').isVisible().catch(() => false)) return;
      const settled = await frame.locator('.ho-sort-mini').count();
      if (settled >= arg) return;
      const bins = await frame.locator('[data-action^=bin-]').count();
      const before = settled;
      for (let b = 0; b < bins - 1; b++) {
        await frame.locator(`[data-action=bin-${b}]`).first().click({ timeout: 4000 }).catch(() => undefined);
        await sleep(page, 380);
        if ((await frame.locator('.ho-sort-mini').count()) > before) break;
      }
      await sleep(page, 650);
    }
  } else if (fn === 'tapFalse') {
    for (const t of falseTexts) {
      const el = frame.locator('.ho-spot-s', { hasText: t.slice(0, 40) }).first();
      if (await el.count()) { await el.click({ timeout: 4000 }); return; }
    }
    throw new Error('this passage has no false sentence (try again)');
  } else if (fn === 'tapTrue') {
    const sentences = frame.locator('.ho-spot-s');
    const n = await sentences.count();
    for (let i = 0; i < n; i++) {
      const text = await sentences.nth(i).innerText();
      if (!falseTexts.some((t) => text.startsWith(t.slice(0, 40)))) { await sentences.nth(i).click({ timeout: 4000 }); return; }
    }
  } else if (fn === 'chooseRight') {
    await frame.locator('[data-role=repair] .mnx-choice[data-right=true]').first().click({ timeout: 4000 });
  } else if (fn === 'chooseWrong') {
    await frame.locator('[data-role=repair] .mnx-choice[data-right=false]').first().click({ timeout: 4000 });
  }
}

for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const view of VIEWS) {
    if (only && !`${sizeName}-${view.name}`.includes(only)) continue;
    let done = false;
    // A Find the Error run may land on a passage that has nothing wrong; try again a few times for the views that need one.
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`${sizeName}/${view.name}: page error ${e.message}`));
      await page.goto(`${url}?scenario=standalone-list&theme=light`);
      await page.evaluate(() => window.__mnxMock.ready());
      await page.evaluate((level) => window.__mnxMock.setSetting('level', level), view.level);
      await page.evaluate(() => window.__mnxMock.launch());
      await page.waitForFunction(() => window.__mnxMock.snapshot().currentReady);
      await page.evaluate(({ width, height }) => { const f = document.getElementById('addon-frame'); f.style.width = `${width}px`; f.style.height = `${height}px`; f.style.margin = '0'; f.parentElement.style.alignItems = 'flex-start'; f.parentElement.style.justifyContent = 'flex-start'; }, size);
      const frame = page.frameLocator('#addon-frame');
      try {
        await frame.locator(`[data-activity=${view.act}]`).first().click({ timeout: 8000 });
        for (const [type, a, b] of view.steps) {
          if (type === 'click') await frame.locator(a).first().click({ timeout: 8000 });
          else if (type === 'waitFor') await frame.locator(a).first().waitFor({ state: 'visible', timeout: 15000 });
          else if (type === 'wait') await page.waitForTimeout(a);
          else if (type === 'fn') await run(a, frame, page, b);
        }
        done = true;
      } catch (e) {
        const retry = /no false sentence/.test(String(e.message)) || (view.name.startsWith('spot-') && attempt < 7);
        if (!retry || attempt === 7) problems.push(`${sizeName}/${view.name}: ${String(e.message).split('\n')[0]}`);
        await context.close();
        continue;
      }
      await page.waitForTimeout(300);
      const handle = await (await page.$('#addon-frame')).contentFrame();
      await handle.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(s); })()`);
      const found = new Map();
      for (const [lookName, look] of Object.entries(LOOKS)) {
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
        if (SHOTS.includes(lookName)) {
          const fb = await (await page.$('#addon-frame')).boundingBox();
          await page.screenshot({ path: join(out, `${sizeName}-${view.name}-${lookName}.png`), clip: { x: fb.x, y: fb.y, width: size.width, height: Math.min(size.height, 1100) } });
        }
      }
      for (const row of [...found.values()].slice(0, 8)) problems.push(`${sizeName}/${view.name}: hard to read "${row.text}" (${row.element}) ${row.ratio}:1 needs ${row.required}:1 in ${row.looks.join(', ')}`);
      await context.close();
    }
  }
}
await browser.close();
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('no problems');
