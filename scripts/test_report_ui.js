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
    await verify(page, 'RPT-UI-001', 'UI Report Tablets');
    assert.match(await page.getAttribute('#result .result', 'class'), /r-notfound/);
    assert.equal(await page.locator('#report-form').count(), 1);

    await page.setInputFiles('#file-input', PHOTO);
    await waitForIdle(page);
    await page.click('.issue-chips .chip:first-child');
    assert.equal(await page.locator('.wizard-page[data-page="2"]:not(.hidden)').count(), 1);
    await page.fill('#report-area', 'UI Test Area');
    await page.fill('#report-note', 'UI end-to-end test report');
    await page.click('#report-next-2');
    assert.equal(await page.locator('.wizard-page[data-page="3"]:not(.hidden)').count(), 1);
    assert.equal(await page.isEnabled('#report-photo'), true);
    await page.check('#report-photo');
    const [reportResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/report') && response.request().method() === 'POST'),
      page.click('#report-form button[type=submit]'),
    ]);
    assert.equal(reportResponse.status(), 201);

    const listed = await (await fetch(`${BASE}/api/reports?country=KE`)).json();
    assert.ok(listed.reports.some((item) => item.nafdac_number === 'RPT-UI-001' && item.location_area === 'UI Test Area'));

    for (const session of ['ui-extra-one', 'ui-extra-two']) {
      const extra = await fetch(`${BASE}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nafdac_number: 'RPT-UI-001',
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
    await page.waitForSelector('.community-flag', { timeout: 15000 });
    assert.match(await page.locator('.community-flag').innerText(), /3 reports in the last 30 days/i);
    await page.screenshot({ path: path.join(OUT, 'report-flag.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log('Report UI and threshold flag checks passed');
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
