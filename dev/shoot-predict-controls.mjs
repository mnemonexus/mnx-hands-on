// Screenshots of Predict the Result and Choose Your Controls (and the Dial's question and reveal screens) in the kit's mock
// host, in light and dark, with real pointer drags. Also runs the kit's readability audit on what each screen shows.
//
//   (in the kit folder)   bun run dev "../../Hands On" --port 4192        (never port 1420)
//   MNX_CHROMIUM=<chrome.exe> node dev/shoot-predict-controls.mjs http://127.0.0.1:4192 <out folder> [filter] [width]
// Set MORE_LOOKS=1 to audit the square, round-with-shadows and single-colour looks as well.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = process.env.MNX_KIT || resolve(HERE, '..', '..', 'mnx-addon-kit-release');
const { chromium } = createRequire(join(KIT, 'package.json'))('playwright');
const { auditScript } = await import(pathToFileURL(join(KIT, 'tools', 'src', 'contrast.mjs')).href);

const url = process.argv[2] || 'http://127.0.0.1:4192';
const out = resolve(process.argv[3] || 'shots');
const only = process.argv[4];
const widths = process.argv[5] ? [Number(process.argv[5])] : [900];
mkdirSync(out, { recursive: true });

const BASE = { mode: 'match', scheme: 'light', accent: null, corners: 8, edges: 'lines', reducedMotion: false, moreColours: true, solidBackdrop: false, lineWidth: 1, lineStrength: 100, shadowStrength: 100 };
const LOOKS = { light: { ...BASE }, dark: { ...BASE, scheme: 'dark' } };
const EXTRA_LOOKS = { square: { ...BASE, corners: 0 }, 'dark-round-shadows': { ...BASE, scheme: 'dark', corners: 16, edges: 'shadows' }, mono: { ...BASE, moreColours: false } };

const A = {
  film: 'ho-predict-film-and-blots', emsa: 'ho-predict-emsa-competitor-supershift', sec: 'ho-predict-sec-two-detectors',
  rtpcr: 'ho-controls-rt-pcr-band', mir: 'ho-controls-mir-214-atf4',
  langmuir: 'ho-dial-langmuir-binding', beer: 'ho-dial-beer-lambert',
};

// Steps: [kind, a, b].
const VIEWS = [
  { name: 'predict-film-r1-ask', level: '1', act: 'film', steps: [['waitFor', '[data-role=palette]'], ['wait', 300]] },
  { name: 'predict-film-r1-placed', level: '1', act: 'film', steps: [['waitFor', '[data-role=palette]'], ['placeSome'], ['wait', 300]] },
  { name: 'predict-film-r1-reveal', level: '1', act: 'film', steps: [['waitFor', '[data-role=palette]'], ['placeSome'], ['click', '[data-action=run]'], ['waitFor', '[data-role=after]'], ['wait', 700]] },
  { name: 'predict-film-r0-ask', level: '0', act: 'film', steps: [['waitFor', '[data-role=palette]'], ['wait', 300]] },
  { name: 'predict-film-r2-ask', level: '2', act: 'film', steps: [['waitFor', '[data-role=mystery]'], ['wait', 300]] },
  { name: 'predict-emsa-r1-ask', level: '1', act: 'emsa', steps: [['waitFor', '[data-role=palette]'], ['wait', 300]] },
  { name: 'predict-emsa-r1-reveal', level: '1', act: 'emsa', steps: [['waitFor', '[data-role=palette]'], ['placeSome'], ['click', '[data-action=run]'], ['waitFor', '[data-role=after]'], ['wait', 700]] },
  { name: 'predict-sec-r1-ask', level: '1', act: 'sec', steps: [['waitFor', '[data-skin=trace]'], ['wait', 400]] },
  { name: 'predict-sec-r1-drawn', level: '1', act: 'sec', steps: [['waitFor', '[data-skin=trace]'], ['wait', 400], ['drawPeaks']] },
  { name: 'predict-sec-r1-reveal', level: '1', act: 'sec', steps: [['waitFor', '[data-skin=trace]'], ['wait', 400], ['drawPeaks'], ['click', '[data-action=run]'], ['waitFor', '[data-role=after]'], ['wait', 700]] },
  { name: 'controls-rtpcr-r0-ask', level: '0', act: 'rtpcr', steps: [['waitFor', '[data-role=conditions]'], ['wait', 300]] },
  { name: 'controls-rtpcr-r1-ask', level: '1', act: 'rtpcr', steps: [['waitFor', '[data-role=conditions]'], ['wait', 300]] },
  { name: 'controls-rtpcr-r1-chosen', level: '1', act: 'rtpcr', steps: [['waitFor', '[data-role=conditions]'], ['pickConds', 3], ['wait', 200]] },
  { name: 'controls-rtpcr-r1-reveal', level: '1', act: 'rtpcr', steps: [['waitFor', '[data-role=conditions]'], ['pickConds', 3], ['click', '[data-action=run]'], ['waitFor', '[data-role=after]'], ['wait', 600]] },
  { name: 'controls-mir-r2-reveal', level: '2', act: 'mir', steps: [['waitFor', '[data-role=conditions]'], ['pickConds', 2], ['click', '[data-action=run]'], ['waitFor', '[data-role=after]'], ['wait', 600]] },
  { name: 'dial-question', level: '0', act: 'langmuir', steps: [['waitFor', '[data-choice=up]'], ['wait', 300]] },
  { name: 'dial-reveal', level: '0', act: 'langmuir', steps: [['waitFor', '[data-choice=up]'], ['click', '[data-choice=down]'], ['waitFor', '[data-role=sliders]'], ['wait', 900]] },
  { name: 'dial-r1-question', level: '1', act: 'beer', steps: [['waitFor', '[data-action=lock]'], ['wait', 300]] },
  { name: 'dial-r1-reveal', level: '1', act: 'beer', steps: [['waitFor', '[data-action=lock]'], ['wait', 300], ['click', '[data-action=lock]'], ['waitFor', '[data-role=sliders]'], ['wait', 900]] },
];

const browser = await chromium.launch({ executablePath: process.env.MNX_CHROMIUM || undefined });
const problems = [];

for (const width of widths) {
  for (const view of VIEWS) {
    if (only && !view.name.includes(only)) continue;
    for (let attempt = 0; attempt < 4; attempt++) {
    const size = { width, height: 1200 };
    const context = await browser.newContext({ viewport: { width: Math.max(1360, width + 80), height: 1300 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`${width}/${view.name}: page error ${e.message}`));
    await page.goto(`${url}?scenario=standalone-list&theme=light`);
    await page.evaluate(() => window.__mnxMock.ready());
    await page.evaluate((level) => window.__mnxMock.setSetting('level', level), view.level);
    await page.evaluate(() => window.__mnxMock.launch());
    await page.waitForFunction(() => window.__mnxMock.snapshot().currentReady);
    await page.evaluate(({ width: w, height }) => { const f = document.getElementById('addon-frame'); f.style.width = `${w}px`; f.style.height = `${height}px`; f.style.margin = '0'; f.parentElement.style.alignItems = 'flex-start'; f.parentElement.style.justifyContent = 'flex-start'; }, size);
    const frame = page.frameLocator('#addon-frame');
    try {
      await frame.locator(`[data-activity=${A[view.act]}]`).first().click({ timeout: 8000 });
      for (const [type, a] of view.steps) {
        if (type === 'click') await frame.locator(a).first().click({ timeout: 8000 });
        else if (type === 'waitFor') await frame.locator(a).first().waitFor({ state: 'visible', timeout: 15000 });
        else if (type === 'wait') await page.waitForTimeout(a);
        else if (type === 'placeSome') await placeSome(page, frame);
        else if (type === 'drawPeaks') await drawPeaks(page, frame);
        else if (type === 'pickConds') {
          const cards = frame.locator('.ho-ctl__cond--pick');
          const n = await cards.count();
          for (let i = 0; i < Math.min(a, n); i++) await cards.nth(i).click();
        }
      }
    } catch (e) { problems.push(`${width}/${view.name}: ${String(e.message).split('\n')[0]}`); await context.close(); continue; }
    await page.waitForTimeout(300);
    // The dev server relaunches the add-on whenever a file in it changes; if that happened, take this view again.
    if ((await page.evaluate(() => window.__mnxMock.snapshot().launchCount)) !== 1 && attempt < 3) { await context.close(); continue; }
    const found = new Map();
    try {
    const handle = await (await page.$('#addon-frame')).contentFrame();
    await handle.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(s); })()`);
    const looks = process.env.MORE_LOOKS ? { ...LOOKS, ...EXTRA_LOOKS } : LOOKS;
    for (const [lookName, look] of Object.entries(looks)) {
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
      if (['light', 'dark'].includes(lookName)) {
        // The whole of the scrolling frame: grow the frame to its content height for the picture.
        const total = await handle.evaluate(() => document.querySelector('.ho-root')?.scrollHeight ?? document.body.scrollHeight);
        await page.evaluate((h) => { document.getElementById('addon-frame').style.height = `${h}px`; }, Math.min(total + 4, 2600));
        await page.waitForTimeout(250);
        const fb = await (await page.$('#addon-frame')).boundingBox();
        await page.screenshot({ path: join(out, `${view.name}-${width}-${lookName}.png`), clip: { x: fb.x, y: fb.y, width, height: Math.min(fb.height, 2600) }, fullPage: true });
        await page.evaluate((h) => { document.getElementById('addon-frame').style.height = `${h}px`; }, size.height);
      }
    }
    } catch (e) { await context.close(); if (attempt < 3) continue; throw e; }
    for (const row of [...found.values()].slice(0, 8)) problems.push(`${width}/${view.name}: hard to read "${row.text}" (${row.element}) ${row.ratio}:1 needs ${row.required}:1 in ${row.looks.join(', ')}`);
    await context.close();
    break;
    }
  }
}
await browser.close();
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('no problems');

/** Drag the first two palette chips into every editable lane, with real mouse moves, so the pictures show a plausible guess. */
async function placeSome(page, frame) {
  const chips = frame.locator('.ho-chipband');
  const lanes = frame.locator('.ho-lane[data-editable=true] .ho-lane__body');
  const laneCount = await lanes.count();
  const chipCount = await chips.count();
  for (let li = 0; li < laneCount; li++) {
    for (let ci = 0; ci < Math.min(chipCount, 2); ci++) {
      const cb = await chips.nth(ci).boundingBox();
      const lb = await lanes.nth(li).boundingBox();
      if (!cb || !lb) continue;
      const tx = lb.x + lb.width / 2;
      const ty = lb.y + lb.height * (0.28 + 0.34 * ((ci + li) % 2) + 0.1 * ci);
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await page.mouse.down();
      await page.mouse.move((cb.x + tx) / 2, (cb.y + ty) / 2, { steps: 5 });
      await page.mouse.move(tx, ty, { steps: 6 });
      await page.mouse.up();
    }
  }
}

/** Pull a few rings up in the first editable trace so it shows a drawn peak. */
async function drawPeaks(page, frame) {
  const card = frame.locator('.ho-trace-card[data-editable=true]').first();
  const rings = card.locator('.ho-m--ring .ho-m__dot');
  const n = await rings.count();
  const area = await card.locator('.ho-area').first().boundingBox();
  for (const [idx, h] of [[Math.round(n * 0.38), 0.55], [Math.round(n * 0.38) - 1, 0.25], [Math.round(n * 0.38) + 1, 0.25], [Math.round(n * 0.8), 0.3]]) {
    const b = await rings.nth(idx).boundingBox();
    if (!b) continue;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, area.y + area.height * (1 - h), { steps: 8 });
    await page.mouse.up();
  }
}
