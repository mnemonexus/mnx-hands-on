// Looks at Break the Construct in the kit's mock host: screenshots at a page and a panel size, in light and dark, with real
// clicks, and runs the kit's readability audit on each screen.
//
//   (in the kit folder)   bun run dev "../Hands On" --port 4181        (never port 1420)
//   MNX_CHROMIUM=<chrome.exe> node dev/shoot-construct.mjs http://127.0.0.1:4181 <out dir> [filter]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = process.env.MNX_KIT || resolve(HERE, '..', '..', 'mnx-addon-kit-release');
const { chromium } = createRequire(join(KIT, 'package.json'))('playwright');
const { auditScript } = await import(pathToFileURL(join(KIT, 'tools', 'src', 'contrast.mjs')).href);

const url = process.argv[2] || 'http://127.0.0.1:4181';
const out = resolve(process.argv[3] || 'shots');
const only = process.argv[4];
mkdirSync(out, { recursive: true });

const BASE = { mode: 'match', scheme: 'light', accent: null, corners: 8, edges: 'lines', reducedMotion: false, moreColours: true, solidBackdrop: false, lineWidth: 1, lineStrength: 100, shadowStrength: 100 };
const LOOKS = { light: { ...BASE }, dark: { ...BASE, scheme: 'dark' } };
const SIZES = { page: { width: 900, height: 1100 }, panel: { width: 420, height: 1000 } };

// Picks the first level for the first condition and the last for the others, and answers the complement question "no".
const PICK = `(() => { const rows = [...document.querySelectorAll('.ho-brk__cond[data-cond-row]')]; rows.forEach((row, i) => { const b = row.querySelectorAll('.ho-brk__opt'); b[i % 2 === 0 ? 0 : b.length - 1].click(); }); const c = document.querySelector('[data-complement="false"]'); if (c) c.click(); })()`;
const AFTER = ['waitFor', '[data-phase=after]'];
const VIEWS = [
  { name: 'trp-r0-ask', act: 'ho-construct-012-trp-repressor-and-operator', level: '0', steps: [['waitFor', '[data-engine=break]'], ['wait', 400]] },
  { name: 'trp-r1-ask', act: 'ho-construct-012-trp-repressor-and-operator', level: '1', steps: [['waitFor', '[data-engine=break]'], ['wait', 400]] },
  { name: 'trp-r1-mid', act: 'ho-construct-012-trp-repressor-and-operator', level: '1', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], ['wait', 1100]] },
  { name: 'trp-r1-done', act: 'ho-construct-012-trp-repressor-and-operator', level: '1', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], AFTER, ['wait', 600]] },
  { name: 'trp-r2-ask', act: 'ho-construct-012-trp-repressor-and-operator', level: '2', steps: [['waitFor', '[data-engine=break]'], ['wait', 400]] },
  { name: 'trp-r2-mid', act: 'ho-construct-012-trp-repressor-and-operator', level: '2', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], ['wait', 1100]] },
  { name: 'trp-r2-done', act: 'ho-construct-012-trp-repressor-and-operator', level: '2', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], AFTER, ['wait', 600]] },
  { name: 'enh-r1-done', act: 'ho-construct-013-enhancer-at-a-distance', level: '1', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], AFTER, ['wait', 600]] },
  { name: 'tissue-r2-done', act: 'ho-construct-013-two-tissue-enhancers', level: '2', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], AFTER, ['wait', 600]] },
  { name: 'mir-r1-done', act: 'ho-construct-026-mir-214-site-in-atf4', level: '1', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], AFTER, ['wait', 600]] },
  { name: 'ires-r1-done', act: 'ho-construct-031-cap-or-ires', level: '1', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], AFTER, ['wait', 600]] },
  { name: 'splice-r0-done', act: 'ho-construct-025-intron-signals', level: '0', steps: [['waitFor', '[data-engine=break]'], ['eval', PICK], ['click', '[data-action=run]'], AFTER, ['wait', 600]] },
];

const browser = await chromium.launch({ executablePath: process.env.MNX_CHROMIUM || undefined });
const problems = [];
for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const view of VIEWS) {
    if (only && !`${sizeName}-${view.name}`.includes(only)) continue;
    // The mock host reloads whenever a file in the add-on is saved, which can close a page mid-way: try a view again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = problems.length;
      try { await oneView(sizeName, size, view); break; } catch (e) { problems.length = before; if (attempt === 2) problems.push(`${sizeName}/${view.name}: ${String(e.message).split('\n')[0]}`); }
    }
  }
}
async function oneView(sizeName, size, view) {
  {
    const context = await browser.newContext({ viewport: { width: 1360, height: 1200 } });
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
        else if (type === 'waitFor') await frame.locator(a).first().waitFor({ state: 'attached', timeout: 20000 });
        else if (type === 'wait') await page.waitForTimeout(a);
        else if (type === 'eval') { const handle = await (await page.$('#addon-frame')).contentFrame(); await handle.evaluate(a); }
      }
    } catch (e) { await context.close(); throw e; }
    await page.waitForTimeout(300);
    const handle = await (await page.$('#addon-frame')).contentFrame();
    if (!view.keepMotion) await handle.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(s); })()`);
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
      const fb = await (await page.$('#addon-frame')).boundingBox();
      await page.screenshot({ path: join(out, `construct-${sizeName}-${view.name}-${lookName}.png`), clip: { x: fb.x, y: fb.y, width: size.width, height: Math.min(size.height, 1200) } });
    }
    for (const row of [...found.values()].slice(0, 8)) problems.push(`${sizeName}/${view.name}: hard to read "${row.text}" (${row.element}) ${row.ratio}:1 needs ${row.required}:1 in ${row.looks.join(', ')}`);
    await context.close();
  }
}
await browser.close();
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('no problems');
