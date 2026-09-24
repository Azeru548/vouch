const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = 'http://127.0.0.1:3777';
const OUT = path.join(__dirname, '..', 'screenshots');
const PHOTO = path.join(__dirname, '..', 'assets', 'sharp-sample-image.jpg');

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
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
  await page.fill('#in-nafdac', nafdac);
  await page.fill('#in-name', productName);
  await page.click('#verify-form button[type=submit]');
  await waitForResult(page);
  return page.getAttribute('#result .result', 'class');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: 'ignore',
    env: { ...process.env, GROQ_API_KEY: '' },
  });
  await waitForServer();

  const browser = await chromium.launch();
  const browserErrors = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => browserErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#picker-card').count(), 0);
    assert.equal(await page.getAttribute('#in-name', 'type'), 'text');
    assert.match(await page.locator('h1').innerText(), /Check the pack/i);

    await page.setInputFiles('#file-input', PHOTO);
    await waitForIdle(page);
    assert.match(await page.locator('#ocr-status').innerText(), /type the NAFDAC number/i);
    assert.equal(await page.inputValue('#in-name'), '');

    const inactiveClass = await verify(page, '04-0858', '10% Dextrose (500/1000 mL)');
    assert.match(inactiveClass, /r-inactive/);
    await page.screenshot({ path: path.join(OUT, 'vouch-desktop.png'), fullPage: true });

    const cases = [
      ['A11-0009', 'Alben Paracetamol Drops', 'r-verified'],
      ['A4-1205', 'Random Product XYZ', 'r-mismatch'],
      ['99-9999', 'Whatever', 'r-notfound'],
    ];

    for (const [nafdac, productName, expectedClass] of cases) {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      const resultClass = await verify(page, nafdac, productName);
      assert.match(resultClass, new RegExp(expectedClass));
      if (expectedClass === 'r-mismatch' || expectedClass === 'r-notfound') {
        assert.match(await page.locator('.report-note').innerText(), /reporting is planned/i);
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(horizontalOverflow <= 1, `Mobile layout overflows by ${horizontalOverflow}px`);
    await page.screenshot({ path: path.join(OUT, 'vouch-mobile.png'), fullPage: true });

    assert.deepEqual(browserErrors, []);
    console.log('Desktop and mobile browser checks passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
