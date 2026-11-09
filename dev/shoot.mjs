// Looks at every screen of Hands On in the kit's mock host: screenshots at a page size and at a narrow Session Mode panel
// size, in light and dark, with real mouse drags on the plot and the dials. Also runs the kit's readability audit on
// what each screen shows.
//
//   (in the kit folder)   bun run dev "../../Hands On" --port 4176        (never port 1420)
//   MNX_CHROMIUM=<chrome.exe> node dev/shoot.mjs http://127.0.0.1:4176 shots [filter]
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
mkdirSync(out, { recursive: true });

const BASE = { mode: 'match', scheme: 'light', accent: null, corners: 8, edges: 'lines', reducedMotion: false, moreColours: true, solidBackdrop: false, lineWidth: 1, lineStrength: 100, shadowStrength: 100 };
const LOOKS = {
  light: { ...BASE },
  dark: { ...BASE, scheme: 'dark' },
  square: { ...BASE, corners: 0, edges: 'lines' },
  'dark-round-shadows': { ...BASE, scheme: 'dark', corners: 16, edges: 'shadows' },
  mono: { ...BASE, moreColours: false },
};
const SIZES = { page: { width: 900, height: 1000 }, panel: { width: 420, height: 900 }, mid: { width: 640, height: 900 } };
const ACT = { langmuir: 'ho-dial-langmuir-binding', beer: 'ho-dial-beer-lambert', decay: 'ho-dial-first-order-decay' };

// Each view: the level to set, the activity, and steps. A step is [kind, a, b].
const VIEWS = [
  { name: 'home', level: 'auto', steps: [['waitFor', '[data-view=home]']] },
  { name: 'r0-ask', level: '0', act: 'langmuir', steps: [['waitFor', '[data-choice=up]']] },
  { name: 'r0-play', level: '0', act: 'langmuir', steps: [['waitFor', '[data-choice=up]'], ['click', '[data-choice=down]'], ['waitFor', '[data-role=sliders]'], ['wait', 900]] },
  { name: 'r1-ask', level: '1', act: 'beer', steps: [['waitFor', '[data-action=lock]'], ['wait', 300]] },
  { name: 'r1-drag', level: '1', act: 'beer', steps: [['waitFor', '[data-action=lock]'], ['wait', 300], ['dragRing', 0.45], ['wait', 150]] },
  { name: 'r1-play', level: '1', act: 'beer', steps: [['waitFor', '[data-action=lock]'], ['wait', 300], ['dragRing', 0.6, true], ['click', '[data-action=lock]'], ['waitFor', '[data-role=sliders]'], ['wait', 900], ['turnDial', 0, 0.7]] },
  { name: 'r1-quantity', level: '1', act: 'decay', steps: [['waitFor', '[data-action=lock]'], ['wait', 300], ['dragRing', 0.4]] },
  { name: 'r1-quantity-play', level: '1', act: 'decay', steps: [['waitFor', '[data-action=lock]'], ['wait', 300], ['dragRing', 0.3, true], ['click', '[data-action=lock]'], ['waitFor', '[data-role=sliders]'], ['wait', 900]] },
  { name: 'r2-ask', level: '2', act: 'langmuir', steps: [['waitFor', '[data-role=answer]'], ['fill', '[data-role=answer]', '0.4']] },
  { name: 'r2-play', level: '2', act: 'beer', steps: [['waitFor', '[data-role=answer]'], ['fill', '[data-role=answer]', '0.3'], ['click', '[data-action=check]'], ['waitFor', '[data-role=sliders]'], ['wait', 900]] },
  { name: 'r2-unit', level: '2', act: 'decay', steps: [['waitFor', '[data-role=answer]'], ['fill', '[data-role=answer]', '12'], ['click', '[data-action=check]'], ['wait', 200]] },
  { name: 'after', level: '0', act: 'langmuir', steps: [['waitFor', '[data-choice=up]'], ['click', '[data-choice=up]'], ['waitFor', '[data-role=after]'], ['wait', 400]] },
  { name: 'end-confirm', level: '0', act: 'langmuir', steps: [['waitFor', '[data-choice=up]'], ['click', '[data-action=end]'], ['waitFor', '[data-action=confirm-end]']] },
];

const browser = await chromium.launch({ executablePath: process.env.MNX_CHROMIUM || undefined });
const problems = [];

async function ringBox(frame) {
  const box = await frame.locator('.ho-m--ring .ho-m__dot').first().boundingBox();
  return box;
}

for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const view of VIEWS) {
    if (only && !`${sizeName}-${view.name}`.includes(only)) continue;
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
    const frameBox = async () => (await (await page.$('#addon-frame')).boundingBox());
    try {
      if (view.act) await frame.locator(`[data-activity=${ACT[view.act]}]`).first().click({ timeout: 8000 });
      for (const [type, a, b] of view.steps) {
        if (type === 'click') await frame.locator(a).first().click({ timeout: 8000 });
        else if (type === 'fill') await frame.locator(a).first().fill(b, { timeout: 8000 });
        else if (type === 'waitFor') await frame.locator(a).first().waitFor({ state: 'visible', timeout: 15000 });
        else if (type === 'wait') await page.waitForTimeout(a);
        else if (type === 'dragRing') {
          // Press on the ring and drag it a share of the plot's height (or width, for a quantity) from where it starts.
          const ring = await ringBox(frame);
          const area = await frame.locator('.ho-area').first().boundingBox();
          const quantity = (await frame.locator('[data-role=question]').innerText()).includes('along the line');
          const fx = ring.x + ring.width / 2; const fy = ring.y + ring.height / 2;
          const tx = quantity ? area.x + area.width * a : fx;
          const ty = quantity ? fy : area.y + area.height * (1 - a);
          await page.mouse.move(fx, fy);
          await page.mouse.down();
          await page.mouse.move((fx + tx) / 2, (fy + ty) / 2, { steps: 6 });
          await page.mouse.move(tx, ty, { steps: 10 });
          if (b) await page.mouse.up();
        } else if (type === 'turnDial') {
          const input = frame.locator('.ho-range').nth(a);
          const box = await input.boundingBox();
          await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width * b, box.y + box.height / 2, { steps: 12 });
          await page.mouse.up();
          await page.waitForTimeout(200);
        }
      }
    } catch (e) { problems.push(`${sizeName}/${view.name}: ${String(e.message).split('\n')[0]}`); await context.close(); continue; }
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
      if (['light', 'dark', 'dark-round-shadows'].includes(lookName)) {
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
