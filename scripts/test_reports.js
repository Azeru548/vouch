const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PORT = 39200 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const MAIN_PATH = path.join(os.tmpdir(), `vouch-reports-main-${process.pid}.db`);
const CACHE_PATH = path.join(os.tmpdir(), `vouch-reports-cache-${process.pid}.db`);

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

async function postReport(body) {
  const response = await fetch(`${BASE}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  setup.prepare(`INSERT INTO products (nafdac, product_name, status, manufacturer, country) VALUES (?, ?, ?, ?, ?)`)
    .run('RPT-KE-001', 'report test tablets', 'Active', 'Report Test Ltd', 'KE');
  setup.close();

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', DATABASE_PATH: MAIN_PATH, CACHE_DATABASE_PATH: CACHE_PATH },
  });

  try {
    await waitForServer();
    const session = crypto.randomUUID();
    const report = {
      nafdac_number: 'RPT-KE-001',
      country: 'KE',
      location_area: 'Westlands, Nairobi',
      note: 'Automated test report',
      session_id: session,
      scan_result: { status: 'verified', country: 'KE' },
    };

    const invalid = await postReport({ ...report, location_area: '' });
    assert.equal(invalid.status, 400);

    for (let index = 1; index <= 3; index++) {
      const created = await postReport({ ...report, location_area: `Area ${index}`, note: `Automated test report ${index}` });
      assert.equal(created.status, 201, `report ${index}: expected HTTP 201`);
    }

    const flagged = await (await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac: 'RPT-KE-001', product_name: 'Report Test Tablets', country: 'KE' })}`)).json();
    assert.equal(flagged.status, 'verified');
    assert.equal(flagged.community_flag?.flagged, true);
    assert.equal(flagged.community_flag?.report_count, 3);
    assert.deepEqual(flagged.community_flag?.recent_locations, ['Area 3', 'Area 2', 'Area 1']);

    const nigeria = await (await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac: 'RPT-KE-001', product_name: 'Report Test Tablets', country: 'NG' })}`)).json();
    assert.equal(nigeria.status, 'not_found');
    assert.equal(nigeria.community_flag, undefined);

    const limiter = crypto.randomUUID();
    for (let index = 1; index <= 5; index++) {
      const created = await postReport({ ...report, nafdac_number: 'RPT-KE-002', location_area: `Limiter ${index}`, note: `Rate test ${index}`, session_id: limiter, scan_result: { status: 'not_found', country: 'KE' } });
      assert.equal(created.status, 201, `rate report ${index}: expected HTTP 201`);
    }
    const limited = await postReport({ ...report, nafdac_number: 'RPT-KE-002', location_area: 'Limiter 6', note: 'Rate test 6', session_id: limiter, scan_result: { status: 'not_found', country: 'KE' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'report_rate_limited');

    const listed = await (await fetch(`${BASE}/api/reports?country=KE`)).json();
    assert.ok(Array.isArray(listed.reports) && listed.reports.length >= 8);
    for (const item of listed.reports) {
      assert.equal(item.session_id, undefined);
      assert.equal(item.photo_url, undefined);
      assert.equal(typeof item.is_seed, 'boolean');
    }

    console.log('Report API, community flag, country isolation, and rate-limit checks passed');
  } finally {
    await stopServer(server);
    fs.rmSync(MAIN_PATH, { force: true });
    fs.rmSync(CACHE_PATH, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
