const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = 39400 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', 'screenshots');
const MAIN_PATH = path.join(os.tmpdir(), `vouch-hazards-main-${process.pid}.db`);
const CACHE_PATH = path.join(os.tmpdir(), `vouch-hazards-cache-${process.pid}.db`);

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

async function lookup(nafdac, productName, country = 'NG') {
  const response = await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac, product_name: productName, country })}`);
  assert.equal(response.status, 200, `${nafdac}: expected HTTP 200`);
  return response.json();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(MAIN_PATH, { force: true });
  fs.rmSync(CACHE_PATH, { force: true });
  const setup = new DatabaseSync(MAIN_PATH);
  setup.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nafdac TEXT,
      product_name TEXT,
      strength TEXT,
      form TEXT,
      route TEXT,
      applicant TEXT,
      manufacturer_id TEXT,
      category TEXT,
      approval_date TEXT,
      expiry_date TEXT,
      status TEXT,
      manufacturer TEXT,
      country TEXT NOT NULL DEFAULT 'NG'
    );
  `);
  setup.prepare('INSERT INTO products (nafdac, product_name, status, manufacturer, country) VALUES (?, ?, ?, ?, ?)')
    .run('A4-3164', 'artemetrin ds tablet', 'Active', 'A.C. Drugs Ltd', 'NG');
  setup.prepare('INSERT INTO products (nafdac, product_name, status, manufacturer, country) VALUES (?, ?, ?, ?, ?)')
    .run('A11-0009', 'alben paracetamol drops', 'Active', 'Alben Healthcare', 'NG');
  setup.close();
  process.env.DATABASE_PATH = MAIN_PATH;
  require('./seed_hazards.js');
  const fakesDir = path.join(__dirname, '..', 'web', 'fakes');
  const fakeFiles = fs.existsSync(fakesDir) ? fs.readdirSync(fakesDir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f)) : [];
  assert.ok(fakeFiles.length > 0, 'web/fakes must contain reference photos — run npm run seed:fakes first');
  const fakeSetup = new DatabaseSync(MAIN_PATH);
  fakeSetup.exec(`
    CREATE TABLE IF NOT EXISTS known_fakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_number TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL,
      nafdac_number TEXT,
      batches TEXT NOT NULL DEFAULT '[]',
      hazard TEXT NOT NULL,
      source_url TEXT NOT NULL,
      photos_json TEXT NOT NULL DEFAULT '[]'
    );
  `);
  fakeSetup.prepare(`INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('030A/2025', 'Artemetrin DS Tablets 80/480mg', 'A4-3164', '["Q011G"]', 'seed', 'https://example.invalid', JSON.stringify([`/fakes/${fakeFiles[0]}`]));
  fakeSetup.close();

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', DATABASE_PATH: MAIN_PATH, CACHE_DATABASE_PATH: CACHE_PATH },
  });

  const browserErrors = [];
  let browser;
  try {
    await waitForServer();

    const registryPlusHazard = await lookup('A4-3164', 'Artemetrin DS Tablet');
    assert.equal(registryPlusHazard.status, 'verified');
    assert.equal(registryPlusHazard.hazard?.alert_number, '030A/2025');
    assert.deepEqual(registryPlusHazard.hazard?.batches, ['Q011G']);
    assert.ok(Array.isArray(registryPlusHazard.hazard?.photos) && registryPlusHazard.hazard.photos.length > 0);
    assert.ok(registryPlusHazard.hazard.photos.every((src) => src.startsWith('/fakes/')));
    const photoRes = await fetch(`${BASE}${registryPlusHazard.hazard.photos[0]}`);
    assert.equal(photoRes.status, 200);

    const counterfeitNumber = await lookup('04-6433', 'Proguanil');
    assert.equal(counterfeitNumber.hazard?.alert_number, '023/2026');
    assert.match(counterfeitNumber.hazard?.hazard || '', /Feroglobin/i);

    const nameOnly = await lookup('UNKNOWN-0', 'Menofix');
    assert.equal(nameOnly.status, 'not_found');
    assert.equal(nameOnly.hazard?.alert_number, '035/2026');
    assert.equal(nameOnly.community_flag, undefined);

    const clean = await lookup('A11-0009', 'Alben Paracetamol Drops');
    assert.equal(clean.status, 'verified');
    assert.equal(clean.hazard, undefined);
    assert.equal(clean.community_flag, undefined);
    console.log('Hazard API checks passed (registry+hazard, counterfeit number, Menofix name-only, clean product)');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => browserErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.setInputFiles('#file-input', path.join(__dirname, '..', 'assets', 'sharp-sample-image.jpg'));
    await page.waitForFunction(() => {
      const status = document.querySelector('#ocr-status');
      return status && !status.classList.contains('hidden') && !status.querySelector('.spinner');
    }, { timeout: 30000 });
    await page.selectOption('#in-country', 'NG');
    await page.fill('#in-nafdac', 'A4-3164');
    await page.fill('#in-name', 'Artemetrin DS Tablet');
    await page.click('#verify-form button[type=submit]');
    await page.waitForSelector('.hazard-alert', { timeout: 15000 });
    await page.waitForSelector('.compare-panel', { timeout: 15000 });
    // Heading text is rendered uppercase by the global h1, h2, h3 rule, so match case-insensitively.
    assert.match(await page.locator('.compare-panel').innerText(), /Compare these two packs/i);
    assert.ok((await page.locator('.compare-panel figure:last-child img').count()) >= 1);
    const firstClass = await page.evaluate(() => document.querySelector('#result .result')?.firstElementChild?.className || '');
    assert.match(firstClass, /hazard-alert/);
    assert.match(await page.locator('.hazard-alert').innerText(), /030A\/2025/i);
    await page.screenshot({ path: path.join(OUT, 'hazard-flag.png'), fullPage: true });
    assert.deepEqual(browserErrors, []);
    console.log('Hazard banner renders first, above verdict and community flag');
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
    fs.rmSync(MAIN_PATH, { force: true });
    fs.rmSync(CACHE_PATH, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
