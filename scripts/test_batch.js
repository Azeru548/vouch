const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureKnownFakesTable } = require('./fakes_schema');
const { ensureHazardTable } = require('./hazard_schema');

// Hybrid name+batch verification tests. Everything runs on a throwaway copy in
// the OS temp dir and boots the real server against it — no network, no live DB.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = 39600 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const MAIN_PATH = path.join(os.tmpdir(), `vouch-batch-main-${process.pid}.db`);
const CACHE_PATH = path.join(os.tmpdir(), `vouch-batch-cache-${process.pid}.db`);

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

(async () => {
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
  ensureKnownFakesTable(setup);
  ensureHazardTable(setup);

  // Kenya recall with two batch codes — the compound-match case.
  const insertHazard = setup.prepare(`
    INSERT INTO hazard_alerts (alert_number, product_name, nafdac_number, batches, hazard, alert_type, manufacturer, source_url, alert_date, in_registry, source_country)
    VALUES (?, ?, NULL, ?, ?, 'recall', 'Denk Pharma GmbH & Co. KG', ?, ?, 0, 'KE')
  `);
  const insertFake = setup.prepare(`
    INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance, source_country)
    VALUES (?, ?, NULL, ?, ?, ?, '[]', 'drug', ?, '[]', NULL, 'KE')
  `);
  const H = ['REC/2026/016', 'Panto-Denk', JSON.stringify(['6289', '6288']),
    'PPB recall (concluded): quality defect during ongoing stability studies',
    'https://web.pharmacyboardkenya.org/panto-denk/', '2026-07-28'];
  // Hazard params: alert, product, batches, hazard, url, date (manufacturer is literal).
  // Fake params:    alert, product, batches, hazard, url, brand.
  insertHazard.run(H[0], H[1], H[2], H[3], H[4], H[5]);
  insertFake.run(H[0], H[1], H[2], H[3], H[4], 'Panto-Denk');

  // Kenya recall with NO batch list — a whole-product recall.
  insertHazard.run('REC/2026/021', 'Amoxil Capsules 500mg', '[]',
    'PPB recall: all batches, failure to meet specification',
    'https://web.pharmacyboardkenya.org/amoxil/', '2026-08-14');
  insertFake.run('REC/2026/021', 'Amoxil Capsules 500mg', '[]',
    'PPB recall: all batches, failure to meet specification',
    'https://web.pharmacyboardkenya.org/amoxil/', 'Amoxil');

  setup.close();

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', DATABASE_PATH: MAIN_PATH, CACHE_DATABASE_PATH: CACHE_PATH },
  });
  server.output = '';
  server.stdout.on('data', (chunk) => { server.output += chunk; });
  server.stderr.on('data', (chunk) => { server.output += chunk; });

  let browserless = true;
  try {
    await waitForServer(server);

    // 1. Batch on the recall list → near-definitive tier.
    const hit = await check({ product_name: 'Panto-Denk', country: 'KE', batch: '6289' });
    assert.equal(hit.body.status, 'not_found');
    assert.equal(hit.body.hazard?.alert_number, 'REC/2026/016');
    assert.equal(hit.body.hazard?.batch_tier, 'batch_matched');
    assert.equal(hit.body.hazard?.source_country, 'KE');
    assert.equal(hit.body.batch, '6289');

    // 2. Same name, batch NOT on the list → honest bounded-reassurance tier.
    const off = await check({ product_name: 'Panto-Denk', country: 'KE', batch: '7777' });
    assert.equal(off.body.hazard?.alert_number, 'REC/2026/016');
    assert.equal(off.body.hazard?.batch_tier, 'batch_not_listed');

    // 3. No batch entered → product-level tier, alert still shown.
    const noBatch = await check({ product_name: 'Panto-Denk', country: 'KE' });
    assert.equal(noBatch.body.hazard?.batch_tier, 'product_level');

    // 4. Whole-product recall (no batch list): any batch still lands product_level.
    const whole = await check({ product_name: 'Amoxil capsules', country: 'KE', batch: '123' });
    assert.equal(whole.body.hazard?.batch_tier, 'product_level');

    // 5. Batch alone must never match anything — unrelated name, matching batch.
    const lone = await check({ product_name: 'Completely unrelated tonic', country: 'KE', batch: '6289' });
    assert.equal(lone.body.hazard, undefined);
    assert.equal(lone.body.suspects, undefined);

    // 6. Batch noise is normalized: separators and case never change the answer.
    const noisy = await check({ product_name: 'panto denk', country: 'KE', batch: 'wl-250 24' });
    // 'wl-250 24' is not on the Panto-Denk list → still the alert, not-listed tier.
    assert.equal(noisy.body.hazard?.batch_tier, 'batch_not_listed');

    // 7. Country scoping holds: the KE recall never fires for NG checks.
    const ng = await check({ product_name: 'Panto-Denk', country: 'NG', batch: '6289' });
    assert.equal(ng.body.hazard, undefined);

    // 8. Batch too long → 400, never a truncated silent match.
    const tooLong = await check({ product_name: 'Panto-Denk', country: 'KE', batch: 'x'.repeat(65) });
    assert.equal(tooLong.status, 400);

    console.log('batch tier tests pass (matched / not_listed / product_level, lone-batch refusal, normalization, country scope, limits)');
  } finally {
    await stopServer(server);
    fs.rmSync(MAIN_PATH, { force: true });
    fs.rmSync(CACHE_PATH, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
