// Looks at Knock It Out and Read the Spectrum in the kit's mock host: screenshots at a page, a mid and a narrow panel size,
// in light, dark and a square-cornered look, with real clicks and taps. Also runs the kit's readability audit on every screen.
//
//   (in the kit folder)   bun run dev "../../Hands On" --port 4176        (never port 1420)
//   MNX_CHROMIUM=<chrome.exe> node dev/shoot-engines.mjs http://127.0.0.1:4176 <out dir> [filter] [sizes] [looks]
//     sizes: comma list of page,mid,panel   looks: comma list of light,dark,square,round-dark,mono
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
const lookNames = (process.argv[6] || 'light,dark,square').split(',');
mkdirSync(out, { recursive: true });

const BASE = { mode: 'match', scheme: 'light', accent: null, corners: 8, edges: 'lines', reducedMotion: false, moreColours: true, solidBackdrop: false, lineWidth: 1, lineStrength: 100, shadowStrength: 100 };
const LOOKS = {
  light: { ...BASE },
  dark: { ...BASE, scheme: 'dark' },
  square: { ...BASE, corners: 0, edges: 'lines' },
  'round-dark': { ...BASE, scheme: 'dark', corners: 16, edges: 'shadows' },
  mono: { ...BASE, moreColours: false },
};
const ALL_SIZES = { page: { width: 900, height: 1000 }, panel: { width: 420, height: 900 }, mid: { width: 640, height: 900 } };
const ACT = {
  trp: 'ho-network-trp-operon', dna: 'ho-network-dna-damage', eif2: 'ho-network-eif2-stress', tor: 'ho-network-tor-cap',
  cs: 'ho-spectrum-charge-series', lad: 'ho-spectrum-059-ladder-of-the-lecture-peptides', shift: 'ho-spectrum-060-which-modification',
};

// A view: the level, the activity, and steps. A step is [kind, a, b].
const VIEWS = JSON.parse(process.env.VIEWS_JSON || 'null') || (await import(pathToFileURL(join(HERE, 'shoot-views.mjs')).href)).VIEWS;

const browser = await chromium.launch({ executablePath: process.env.MNX_CHROMIUM || undefined });
const problems = [];

for (const sizeName of sizeNames) {
  const size = ALL_SIZES[sizeName];
  for (const view of VIEWS) {
    if (only && !`${sizeName}-${view.name}`.includes(only)) continue;
    if (view.sizes && !view.sizes.includes(sizeName)) continue;
    const context = await browser.newContext({ viewport: { width: 1360, height: 1100 }, reducedMotion: view.reduced ? 'reduce' : 'no-preference' });
    // A view may fix the clock and the random source so a run's seed, and so its first question, is known.
    if (view.now) await context.addInitScript(`(() => { const t = ${view.now}; Date.now = () => t; Math.random = () => 0.5; })()`);
    const page = await context.newPage();
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
        else if (type === 'clickNth') await frame.locator(a).nth(b).click({ timeout: 8000 });
        else if (type === 'fill') await frame.locator(a).first().fill(b, { timeout: 8000 });
        else if (type === 'waitFor') await frame.locator(a).first().waitFor({ state: 'visible', timeout: 15000 });
        else if (type === 'wait') await page.waitForTimeout(a);
        else if (type === 'scroll') await frame.locator(a).first().scrollIntoViewIfNeeded();
        else if (type === 'eval') { const handle = await (await page.$('#addon-frame')).contentFrame(); await handle.evaluate(a); }
      }
    } catch (e) { problems.push(`${sizeName}/${view.name}: ${String(e.message).split('\n')[0]}`); await context.close(); continue; }
    await page.waitForTimeout(300);
    const handle = await (await page.$('#addon-frame')).contentFrame();
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
    await context.close();
  }
}
await browser.close();
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('no problems');
