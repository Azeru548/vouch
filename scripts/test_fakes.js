const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureKnownFakesTable } = require('./fakes_schema');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = 39500 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const MAIN_PATH = path.join(os.tmpdir(), `vouch-fakes-main-${process.pid}.db`);
const CACHE_PATH = path.join(os.tmpdir(), `vouch-fakes-cache-${process.pid}.db`);

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

async function waitForServer(server) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Server did not become ready. Server output:\n${server.output || '(none)'}`);
}

async function check(params) {
  const response = await fetch(`${BASE}/verify?${new URLSearchParams(params)}`);
  return { status: response.status, body: await response.json() };
}

// The library columns were added to a table that already exists in the shipping
// snapshot, so the in-place migration is the first thing that must hold.
function checkSchemaMigration() {
  const legacyPath = path.join(os.tmpdir(), `vouch-fakes-legacy-${process.pid}.db`);
  fs.rmSync(legacyPath, { force: true });
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE known_fakes (
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
  legacy.prepare('INSERT INTO known_fakes (alert_number, product_name, hazard, source_url) VALUES (?, ?, ?, ?)')
    .run('999/2025', 'Legacy Row', 'pre-existing row', 'https://example.invalid');
  ensureKnownFakesTable(legacy);
  const columns = legacy.prepare('PRAGMA table_info(known_fakes)').all().map((column) => column.name);
  for (const name of ['category', 'brand_name', 'aliases', 'appearance']) {
    assert.ok(columns.includes(name), `known_fakes is missing migrated column: ${name}`);
  }
  const row = legacy.prepare('SELECT category, aliases FROM known_fakes WHERE alert_number = ?').get('999/2025');
  assert.equal(row.category, 'drug', 'existing rows should default to the drug category');
  assert.equal(row.aliases, '[]');
  legacy.close();
  fs.rmSync(legacyPath, { force: true });
  console.log('known_fakes migration guards pass (legacy table gains library columns, rows keep defaults)');
}

(async () => {
  checkSchemaMigration();

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
    .run('A11-0009', 'alben paracetamol drops', 'Active', 'Alben Healthcare', 'NG');
  setup.prepare('INSERT INTO products (nafdac, product_name, status, manufacturer, country) VALUES (?, ?, ?, ?, ?)')
    .run('A4-1205', 'dermovate cream', 'Active', 'Glaxo', 'NG');
  ensureKnownFakesTable(setup);
  const { ensureHazardTable } = require('./hazard_schema');
  ensureHazardTable(setup);
  const insertFake = setup.prepare(`
    INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertFake.run('018/2026', 'Cerelac Infant Cereal (counterfeit and unregistered)', null, '[]',
    'Counterfeit and unregistered Cerelac infant cereal found on sale', 'https://nafdac.gov.ng/alert-018', JSON.stringify(['/icons/seal.svg']),
    'food', 'Cerelac', JSON.stringify(['Cerelac Mixed Fruits', 'Cerelac Wheat']),
    'Infant cereal carton or tin, counterfeit packs sold beside genuine Cerelac.');
  insertFake.run('023/2026', 'Projeanil / Re-granil Proguanil 100mg', '04-6433', '["BN600"]',
    'Counterfeit: printed registration number belongs to another product', 'https://nafdac.gov.ng/alert-023', '[]',
    'drug', 'Projeanil', JSON.stringify(['Re-granil', 'Proguanil 100mg']), null);
  insertFake.run('026/2025', 'Cowbell "Our Milk" Sachet Milk Powder 12g (counterfeit)', null, '[]',
    'Counterfeit sachets copy the Cowbell brand name and packaging design', 'https://nafdac.gov.ng/alert-026', '[]',
    'food', 'Cowbell', JSON.stringify(['Cowbell Our Milk']),
    'Small 12 g sachet of milk powder. The counterfeit copies the Cowbell brand name and packaging design.');
  // Kenya PPB row — proves country-scoped matching and the authority labels.
  setup.prepare(`
    INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance, source_country)
    VALUES ('REC/2026/016', 'Panto-Denk', NULL, '["6289","6288"]', 'PPB recall (concluded): quality defect during ongoing stability studies', 'https://web.pharmacyboardkenya.org/panto-denk/', '[]', 'drug', 'Panto-Denk', '["Pantoprazole Sodium Sesquihydrate"]', NULL, 'KE')
  `).run();
  setup.prepare(`
    INSERT INTO hazard_alerts (alert_number, product_name, nafdac_number, batches, hazard, alert_type, manufacturer, source_url, alert_date, in_registry, source_country)
    VALUES ('REC/2026/016', 'Panto-Denk', NULL, '["6289","6288"]', 'PPB recall (concluded): quality defect during ongoing stability studies', 'recall', 'Denk Pharma GmbH & Co. KG', 'https://web.pharmacyboardkenya.org/panto-denk/', '2026-07-28', 0, 'KE')
  `).run();
  setup.close();

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', DATABASE_PATH: MAIN_PATH, CACHE_DATABASE_PATH: CACHE_PATH },
  });
  server.output = '';
  server.stdout.on('data', (chunk) => { server.output += chunk; });
  server.stderr.on('data', (chunk) => { server.output += chunk; });

  const browserErrors = [];
  let browser;
  try {
    await waitForServer(server);

    // 1. No registration number at all: the name alone finds a known fake.
    const byName = await check({ product_name: 'Cerelac', country: 'NG' });
    assert.equal(byName.body.status, 'not_found');
    assert.equal(byName.body.reason, 'no_number_provided');
    assert.equal(byName.body.nafdac, null);
    assert.equal(byName.body.suspects?.length, 1);
    assert.equal(byName.body.suspects[0].alert_number, '018/2026');
    assert.equal(byName.body.suspects[0].category, 'food');
    assert.equal(byName.body.suspects[0].matched_on, 'name');
    assert.ok(byName.body.suspects[0].photos.length > 0);

    // 2. Aliases and brand names count as name hits, not just the full title.
    const byAlias = await check({ product_name: 'Re-granil 100mg', country: 'NG' });
    assert.equal(byAlias.body.suspects?.[0]?.alert_number, '023/2026');

    // 3. An unrelated name produces no lead at all.
    const unrelated = await check({ product_name: 'Zzz Random Widget', country: 'NG' });
    assert.equal(unrelated.body.status, 'not_found');
    assert.equal(unrelated.body.suspects, undefined);

    // 4. Appearance text can match on its own when the name does not.
    const byLooks = await check({
      product_name: 'Zzz Random Widget',
      appearance: 'Small 12 g sachet of milk powder copying the Cowbell brand name and packaging design',
      country: 'NG',
    });
    assert.equal(byLooks.body.suspects?.[0]?.alert_number, '026/2025');
    assert.equal(byLooks.body.suspects[0].matched_on, 'appearance');

    // 5. A confirmed registration is never second-guessed by the library.
    const verified = await check({ nafdac: 'A11-0009', product_name: 'Alben Paracetamol Drops', country: 'NG' });
    assert.equal(verified.body.status, 'verified');
    assert.equal(verified.body.suspects, undefined);

    // 6. A pack the registry cannot confirm still gets its lead.
    const mismatch = await check({ nafdac: 'A4-1205', product_name: 'Cerelac infant cereal', country: 'NG' });
    assert.equal(mismatch.body.status, 'mismatch');
    assert.equal(mismatch.body.suspects?.[0]?.alert_number, '018/2026');

    // 6b. A Kenyan check matches the PPB row and names PPB as the authority.
    const ke = await check({ product_name: 'Panto-Denk', country: 'KE' });
    assert.equal(ke.body.status, 'not_found');
    assert.equal(ke.body.suspects?.[0]?.alert_number, 'REC/2026/016');
    assert.equal(ke.body.suspects[0].source_country, 'KE');
    assert.match(ke.body.suspects[0].authority, /Pharmacy and Poisons Board/);

    // 6c. The same name under NG must not see the PPB row — flags are scoped
    // to the country of the regulator that issued them.
    const ngIsolation = await check({ product_name: 'Panto-Denk', country: 'NG' });
    assert.equal(ngIsolation.body.suspects, undefined);

    // 7. Validation that must not regress.
    const missingName = await check({ nafdac: 'A11-0009' });
    assert.equal(missingName.status, 400);
    assert.equal(missingName.body.error, 'missing required param: product_name');

    const tooLong = await check({ product_name: 'Cerelac', appearance: 'x'.repeat(601), country: 'NG' });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, 'input_too_long');

    const badCountry = await check({ product_name: 'Cerelac', country: 'ZZ' });
    assert.equal(badCountry.status, 400);

    // 8. The description endpoint is gated exactly like number extraction.
    const describe = await fetch(`${BASE}/api/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'data:image/jpeg;base64,/9j/4AAQ' }),
    });
    assert.equal(describe.status, 503);
    assert.equal((await describe.json()).error, 'vision_not_configured');

    console.log('Known-fake API checks passed (name hit, alias hit, appearance-only hit, no lead, verified stays clean, mismatch lead, validation, describe gating)');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => browserErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.selectOption('#in-country', 'NG');
    await page.fill('#in-name', 'Cerelac');
    await page.click('#verify-form button[type=submit]');
    await page.waitForSelector('.suspect-panel', { timeout: 15000 });
    assert.match(await page.locator('.suspect-panel').innerText(), /Possible match in our flagged-products library/i);
    assert.match(await page.locator('.suspect').first().innerText(), /Cerelac/);
    assert.match(await page.locator('.suspect-cat').first().innerText(), /Food or drink/i);
    // No number entered, so the number-keyed NAPAMS handoff must stay away.
    // Reporting is different: it is offered after every check, and a pack with
    // no number is exactly the kind people need to report.
    assert.equal(await page.locator('.napams-panel').count(), 0);
    await page.locator('#report-modal').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await page.locator('.modal-pack').innerText(), /no registration number entered/i);
    await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'known-fake-lead.png') });
    // The modal sits over the result; close it and the lead is still there.
    await page.click('#report-no');
    await page.locator('#report-modal').waitFor({ state: 'detached', timeout: 10000 });
    assert.match(await page.locator('.suspect-panel').innerText(), /Possible match in our flagged-products library/i);
    await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'known-fake-lead.png'), fullPage: true });
    assert.deepEqual(browserErrors, []);
    console.log('Known-fake lead renders in the UI with no registration number, without the number-keyed panels');
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
