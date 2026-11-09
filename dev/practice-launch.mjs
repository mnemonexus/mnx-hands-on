// The kit's mock host cannot launch an add-on as a practice-v1 activity (props.practice), which is how the app opens it from
// Session Mode, the recall queue and the planner. This adds props.practice to the `init` message inside the frame and checks
// that Hands On opens that activity directly (no list, no Back button), shows why it was offered, plays three rounds at each
// level and reports a practice result the host's checks accept.
//
//   (in the kit folder)   bun run dev "../../Hands On" --port 4176
//   MNX_CHROMIUM=<chrome.exe> node dev/practice-launch.mjs http://127.0.0.1:4176
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = process.env.MNX_KIT || resolve(HERE, '..', '..', 'mnx-addon-kit-release');
const { chromium } = createRequire(join(KIT, 'package.json'))('playwright');
const url = process.argv[2] || 'http://127.0.0.1:4176';
const catalogue = JSON.parse(readFileSync(join(HERE, '..', 'assets', 'practice', 'catalogue.json'), 'utf8'));

const browser = await chromium.launch({ executablePath: process.env.MNX_CHROMIUM || undefined });
const problems = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };

for (const entry of catalogue.activities) {
  for (const level of ['0', '1', '2']) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    await context.addInitScript(({ activityId, launch }) => {
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (data && data.kind === 'init' && data.props && !data.props.kind?.startsWith?.('addon-job')) {
          data.props.practice = { version: 1, activityId, launch, reason: 'it matches what you are studying', timeBudgetSeconds: 600 };
        }
      }, true);
    }, { activityId: entry.id, launch: entry.launch });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${url}?scenario=standalone-list&theme=light`);
    await page.evaluate(() => window.__mnxMock.ready());
    await page.evaluate((l) => window.__mnxMock.setSetting('level', l), level);
    await page.evaluate(() => window.__mnxMock.launch());
    await page.waitForFunction(() => window.__mnxMock.snapshot().currentReady);
    const frame = page.frameLocator('#addon-frame');
    const tag = `${entry.id} at level ${level}`;
    await frame.locator('[data-view=activity]').waitFor({ state: 'visible', timeout: 15000 });
    check(await frame.locator('[data-view=home]').count() === 0, `${tag}: opens the activity, not the list`);
    check(await frame.locator('[data-action=back]').count() === 0, `${tag}: no Back button`);
    check((await frame.locator('[data-role=reason]').innerText()).includes('it matches what you are studying'), `${tag}: shows why it was offered`);
    for (let round = 0; round < 3; round++) {
      if (level === '0') { await frame.locator('[data-choice]').nth(round % 3).click(); }
      else if (level === '1') { await frame.locator('[data-action=lock]').click(); }
      else {
        const unit = entry.launch.spec.asks[2].measure && entry.launch.spec.asks[2].measure !== 'y' ? 's' : '';
        await frame.locator('[data-role=answer]').fill(`0.3 ${unit}`.trim());
        await frame.locator('[data-action=check]').click();
      }
      await frame.locator('[data-role=after]').waitFor({ state: 'visible', timeout: 15000 });
      await frame.locator('[data-action=next]').click();
    }
    const state = await page.waitForFunction(() => window.__mnxMock.snapshot().results.length > 0).then(() => page.evaluate(() => window.__mnxMock.snapshot()));
    const row = state.results.at(-1);
    check(row.ok, `${tag}: the host's checks pass the result${row.ok ? '' : ` (${row.checks.filter((c) => !c.pass).map((c) => c.rule).join('; ')})`}`);
    check(errors.length === 0 && state.errors.length === 0, `${tag}: no errors${errors.length ? ` (${errors[0]})` : ''}`);
    await context.close();
  }
}
await browser.close();
process.exitCode = problems.length ? 1 : 0;
