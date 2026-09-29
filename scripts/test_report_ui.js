const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = 39300 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', 'screenshots');
const PHOTO = path.join(__dirname, '..', 'assets', 'sharp-sample-image.jpg');
const MAIN_PATH = path.join(os.tmpdir(), `vouch-report-ui-main-${process.pid}.db`);
const CACHE_PATH = path.join(os.tmpdir(), `vouch-report-ui-cache-${process.pid}.db`);

async function stopServer(server) {
  if (server.exitCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 2000);
    server.once('exit', finish);
    server.kill();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Server did not become ready');
}

async function waitForIdle(page) {
  await page.waitForFunction(() => {
    const status = document.querySelector('#ocr-status');
    return status && !status.classList.contains('hidden') && !status.querySelector('.spinner');
  }, { timeout: 30000 });
}

async function waitForResult(page) {
  await page.waitForFunction(() => {
    const result = document.querySelector('#result .result');
    return result && !result.querySelector('.spinner');
  }, { timeout: 30000 });
}

async function verify(page, nafdac, productName) {
  await page.selectOption('#in-country', 'KE');
  await page.fill('#in-nafdac', nafdac);
  await page.fill('#in-name', productName);
  await page.click('#verify-form button[type=submit]');
  await waitForResult(page);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'nafdac_products.db'), MAIN_PATH);
  process.env.DATABASE_PATH = MAIN_PATH;
  require('./seed_reports.js');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', DATABASE_PATH: MAIN_PATH, CACHE_DATABASE_PATH: CACHE_PATH },
  });
  await waitForServer();

  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });

    // The photos come first, because the modal opens after the check and can
    // offer to attach each one individually. Files are processed one at a
    // time, so wait for both tiles rather than the read settling.
    await page.setInputFiles('#file-input', [PHOTO, PHOTO]);
    await page.waitForFunction(() => document.querySelectorAll('.photo-tile:not(.photo-tile-add)').length === 2, { timeout: 30000 });
    await waitForIdle(page);
    assert.equal(await page.locator('.photo-tile:not(.photo-tile-add)').count(), 2, 'both uploads become tiles');

    await verify(page, 'RPT-UI-001', 'UI Report Tablets');
    assert.match(await page.getAttribute('#result .result', 'class'), /r-notfound/);

    // The report prompt is now a modal, and it opens after every check. It
    // leads with the verdict strip so the shopper knows what they are
    // reporting on, and the pack shot is pre-selected for attachment.
    const modal = page.locator('#report-modal');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#report-form').count(), 1);
    assert.match(await page.locator('#report-modal-title').innerText(), /look different or damaged/i);
    assert.match(await page.locator('.modal-verdict').innerText(), /Not found/i);
    assert.match(await page.locator('.modal-verdict .result-badge').innerText(), /not found/i);

    await page.click('.issue-chips .chip:first-child');
    assert.equal(await page.locator('.issue-chips .chip.selected').count(), 1);
    assert.match(await page.locator('#report-note').inputValue(), /seal/i);
    await page.fill('#report-area', 'UI Test Area');
    assert.equal(await page.locator('#report-attach-tiles input').count(), 2);
    assert.equal(await page.locator('#report-attach-tiles input:checked').count(), 1, 'pack shot pre-selected');

    const [reportResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/report') && response.request().method() === 'POST'),
      page.click('#report-form button[type=submit]'),
    ]);
    assert.equal(reportResponse.status(), 201);
    await modal.waitFor({ state: 'detached', timeout: 20000 });

    const listed = await (await fetch(`${BASE}/api/reports?country=KE`)).json();
    assert.ok(listed.reports.some((item) => item.nafdac_number === 'RPT-UI-001' && item.product_name === 'UI Report Tablets' && item.location_area === 'UI Test Area'));

    // A check with no registration number is reportable too, and the modal
    // shows NAFDAC's own photo of the flagged pack when the library has one.
    await page.fill('#in-nafdac', '');
    await page.fill('#in-name', 'Cowbell Our Milk');
    await page.click('#verify-form button[type=submit]');
    await waitForResult(page);
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await page.locator('.modal-pack').innerText(), /no registration number entered/i);
    assert.ok(await page.locator('.modal-reference img').count() >= 1, 'the flagged pack photo should be shown');
    assert.match(await page.locator('.modal-reference-label').innerText(), /flagged pack/i);
    await page.screenshot({ path: path.join(OUT, 'report-modal.png') });

    // Escape closes without submitting, and leaves the check result in place.
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'detached', timeout: 10000 });
    assert.ok(await page.locator('#result .result').count() > 0);

    // A verified pack gets the blue registry-match badge in the modal too.
    await verify(page, '10737/R1', 'hyoscine butylbromide injection bp 20mg/ml');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await page.locator('.modal-verdict').innerText(), /Registry match/i);
    assert.match(await page.locator('.modal-verdict').innerText(), /Registered and active/i);
    await page.click('#report-no');
    await modal.waitFor({ state: 'detached', timeout: 10000 });

    for (const session of ['ui-extra-one', 'ui-extra-two']) {
      const extra = await fetch(`${BASE}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nafdac_number: 'RPT-UI-001',
          product_name: 'UI Report Tablets',
          country: 'KE',
          location_area: `UI Extra ${session}`,
          note: 'Threshold test report',
          session_id: session,
          scan_result: { status: 'not_found', country: 'KE' },
        }),
      });
      assert.equal(extra.status, 201);
    }

    await verify(page, 'RPT-UI-001', 'UI Report Tablets');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    await page.click('#report-no');
    await modal.waitFor({ state: 'detached', timeout: 10000 });

    await page.waitForSelector('.community-flag', { timeout: 15000 });
    assert.match(await page.locator('.community-flag').innerText(), /3 reports in the last 30 days/i);
    await page.screenshot({ path: path.join(OUT, 'report-flag.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log('Report modal, number-optional reporting, and threshold flag checks passed');
  } finally {
    await browser.close();
    await stopServer(server);
    fs.rmSync(MAIN_PATH, { force: true });
    fs.rmSync(CACHE_PATH, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
