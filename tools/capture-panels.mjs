// Headless capture of every reproduction panel (works for all papers defined
// in index.html — panel list is auto-discovered from the [data-figures] rows).
//
// Usage:
//   npm run dev                                   # keep the dev server running
//   npm run capture [baseURL]                     # default http://localhost:5173/
//   SETTLE_MS=8000 npm run capture                # slower machine? extend settle
//
// Outputs, per panel <id>:
//   docs/screenshots/final/<id>-page.png    full page incl. HTML label overlay
//   docs/screenshots/final/<id>-canvas.png  WebGL canvas only (no labels)
// Prereq: `npx playwright install chromium` OR a system Edge/Chrome
// (the script falls back to msedge/chrome channels automatically).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://localhost:5173/';
const OUT = join(ROOT, 'docs', 'screenshots', 'final');
// Scene rebuild + double camera re-set (0.4 s / 0.8 s in main.js) + render.
const SETTLE = Number(process.env.SETTLE_MS || 5000);

async function launchBrowser() {
  // bundled chromium → system Edge → system Chrome
  for (const opts of [undefined, { channel: 'msedge' }, { channel: 'chrome' }]) {
    try {
      return { browser: await chromium.launch(opts), via: opts?.channel || 'chromium' };
    } catch (e) { /* try next */ }
  }
  throw new Error('no usable Chromium/Edge/Chrome for Playwright');
}

const { browser, via } = await launchBrowser();
console.log('browser:', via);
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', e => console.log('PAGE-ERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').includes('ready'),
    null, { timeout: 180000 },
  );
  await page.waitForTimeout(5000); // first-frame settle

  const panelIds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-figures]')]
      .flatMap(g => g.getAttribute('data-figures').split(','))
      .map(s => s.trim())
      .filter(Boolean),
  );
  if (!panelIds.length) throw new Error('no [data-figures] panels found');
  const only = process.env.PANELS ? process.env.PANELS.split(',').map(s => s.trim()) : null;
  const targets = only ? panelIds.filter(id => only.includes(id)) : panelIds;
  console.log(`panels: ${panelIds.join(', ')}`);

  mkdirSync(OUT, { recursive: true });
  for (const id of targets) {
    const btn = page.locator(`#btn-${id}`);
    if (await btn.count() !== 1) { console.log('MISS', id, 'button not unique'); continue; }
    await btn.click();
    await page.waitForTimeout(SETTLE);
    const state = await page.evaluate(() => ({
      status: document.getElementById('status')?.textContent || '',
      labels: document.querySelectorAll('.label-layer > div').length,
      err: window.__lastLabelError ?? null,
    }));
    if (state.status !== 'ready' || state.err) console.log('WARN', id, JSON.stringify(state));
    await page.screenshot({ path: join(OUT, `${id}-page.png`) });
    const dataUrl = await page.evaluate(
      () => window.__viewer.plugin.canvas3d.webgl.gl.canvas.toDataURL('image/png'),
    );
    writeFileSync(join(OUT, `${id}-canvas.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('OK', id, state.labels, 'labels');
  }
} finally {
  await browser.close();
}
console.log('done →', OUT);
