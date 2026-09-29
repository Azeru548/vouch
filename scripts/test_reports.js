const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureReportsTable } = require('./reports_schema');
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

// Reports used to require a registration number. The packs people most need to
// report often have none, so the column was relaxed — and that has to survive a
// snapshot that already has rows in the old shape.
function checkReportsMigration() {
  const legacyPath = path.join(os.tmpdir(), `vouch-reports-legacy-${process.pid}.db`);
  fs.rmSync(legacyPath, { force: true });
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nafdac_number TEXT NOT NULL,
      country TEXT NOT NULL CHECK (country IN ('NG', 'KE')) DEFAULT 'NG',
      location_area TEXT NOT NULL,
      note TEXT NOT NULL,
      photo_url TEXT,
      scan_result TEXT,
      latitude REAL,
      longitude REAL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_seed INTEGER NOT NULL DEFAULT 0 CHECK (is_seed IN (0, 1))
    );
  `);
  legacy.prepare('INSERT INTO reports (nafdac_number, country, location_area, note, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('A11-0009', 'NG', 'Ikeja, Lagos', 'legacy row', 'legacy-session', '2026-01-01T00:00:00.000Z');

  ensureReportsTable(legacy);
  ensureReportsTable(legacy);

  const info = legacy.prepare('PRAGMA table_info(reports)').all();
  assert.equal(info.find((column) => column.name === 'nafdac_number').notnull, 0, 'nafdac_number must become optional');
  assert.ok(info.some((column) => column.name === 'product_name'), 'product_name must exist after migration');
  const rows = legacy.prepare('SELECT nafdac_number, product_name, location_area FROM reports').all();
  assert.equal(rows.length, 1, 'migration must not duplicate or drop rows');
  assert.equal(rows[0].nafdac_number, 'A11-0009');
  assert.equal(rows[0].product_name, '');
  assert.equal(rows[0].location_area, 'Ikeja, Lagos');
  legacy.close();
  fs.rmSync(legacyPath, { force: true });
  console.log('reports migration passes (legacy number column relaxed, rows preserved, rerun is safe)');
}

(async () => {
  checkReportsMigration();

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
      product_name: 'Report Test Tablets',
      country: 'KE',
      location_area: 'Westlands, Nairobi',
      note: 'Automated test report',
      session_id: session,
      scan_result: { status: 'verified', country: 'KE' },
    };

    const invalid = await postReport({ ...report, location_area: '' });
    assert.equal(invalid.status, 400);

    // The product name is the one field that is never optional.
    const nameless = await postReport({ ...report, product_name: '', session_id: crypto.randomUUID() });
    assert.equal(nameless.status, 400);

    for (let index = 1; index <= 3; index++) {
      const created = await postReport({ ...report, location_area: `Area ${index}`, note: `Automated test report ${index}` });
      assert.equal(created.status, 201, `report ${index}: expected HTTP 201`);
    }

    const flagged = await (await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac: 'RPT-KE-001', product_name: 'Report Test Tablets', country: 'KE' })}`)).json();
    assert.equal(flagged.status, 'verified');
    assert.equal(flagged.community_flag?.flagged, true);
    assert.equal(flagged.community_flag?.report_count, 3);
    assert.equal(flagged.community_flag?.reported_on, 'registration_number');
    assert.deepEqual(flagged.community_flag?.recent_locations, ['Area 3', 'Area 2', 'Area 1']);

    // A pack with no registration number at all is still reportable, and the
    // warning has to reach the next person who checks that product by name.
    const named = crypto.randomUUID();
    const nameReports = [
      { product_name: 'Cowbell Our Milk Sachet', location_area: 'Kibera, Nairobi' },
      { product_name: 'Cowbell Sachet Milk', location_area: 'Westlands, Nairobi' },
      { product_name: 'Cowbell our milk sachet', location_area: 'Nyali, Mombasa' },
    ];
    for (const [index, entry] of nameReports.entries()) {
      const created = await postReport({
        ...report,
        nafdac_number: undefined,
        product_name: entry.product_name,
        location_area: entry.location_area,
        note: `Name-keyed report ${index + 1}`,
        session_id: named,
        scan_result: { status: 'not_found', country: 'KE', product_name: entry.product_name },
      });
      assert.equal(created.status, 201, `name-keyed report ${index + 1}: expected HTTP 201`);
    }

    const byName = await (await fetch(`${BASE}/verify?${new URLSearchParams({ product_name: 'Cowbell Our Milk Sachet', country: 'KE' })}`)).json();
    assert.equal(byName.status, 'not_found');
    assert.equal(byName.reason, 'no_number_provided');
    assert.equal(byName.community_flag?.flagged, true);
    assert.equal(byName.community_flag?.report_count, 3);
    assert.equal(byName.community_flag?.reported_on, 'product_name');

    // One name-keyed report alone must not raise a warning.
    const lonely = await (await fetch(`${BASE}/verify?${new URLSearchParams({ product_name: 'Lonely Unknown Syrup', country: 'KE' })}`)).json();
    assert.equal(lonely.community_flag, undefined);

    const nigeria = await (await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac: 'RPT-KE-001', product_name: 'Report Test Tablets', country: 'NG' })}`)).json();
    assert.equal(nigeria.status, 'not_found');
    assert.equal(nigeria.community_flag, undefined);

    // Photos must arrive pre-downscaled: the 900 KB cap is the retention
    // policy pushed to the client.
    const hugePhoto = `data:image/jpeg;base64,${'A'.repeat(1400000)}`;
    const fatPhoto = await postReport({
      ...report,
      nafdac_number: 'RPT-KE-003',
      location_area: 'Photo Test Area',
      note: 'Oversized photo test',
      photo: hugePhoto,
      session_id: crypto.randomUUID(),
      scan_result: { status: 'not_found', country: 'KE' },
    });
    assert.equal(fatPhoto.status, 400);
    assert.equal(fatPhoto.body.error, 'invalid_photo');

    // Coordinates are stored rounded to ~110 m, not as precise GPS traces.
    const located = await postReport({
      ...report,
      nafdac_number: 'RPT-KE-003',
      location_area: 'GPS Test Area',
      note: 'Coordinate rounding test',
      latitude: -1.263481723,
      longitude: 36.80284519,
      session_id: crypto.randomUUID(),
      scan_result: { status: 'not_found', country: 'KE' },
    });
    assert.equal(located.status, 201);
    const verifyDb = new DatabaseSync(MAIN_PATH, { readOnly: true });
    const gpsRow = verifyDb.prepare('SELECT latitude, longitude FROM reports WHERE id = ?').get(located.body.id);
    verifyDb.close();
    assert.equal(gpsRow.latitude, -1.263);
    assert.equal(gpsRow.longitude, 36.803);

    const limiter = crypto.randomUUID();
    for (let index = 1; index <= 5; index++) {
      const created = await postReport({ ...report, nafdac_number: 'RPT-KE-002', location_area: `Limiter ${index}`, note: `Rate test ${index}`, session_id: limiter, scan_result: { status: 'not_found', country: 'KE' } });
      assert.equal(created.status, 201, `rate report ${index}: expected HTTP 201`);
    }
    const limited = await postReport({ ...report, nafdac_number: 'RPT-KE-002', location_area: 'Limiter 6', note: 'Rate test 6', session_id: limiter, scan_result: { status: 'not_found', country: 'KE' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'report_rate_limited');

    const listed = await (await fetch(`${BASE}/api/reports?country=KE`)).json();
    assert.ok(Array.isArray(listed.reports) && listed.reports.length >= 11);
    for (const item of listed.reports) {
      assert.equal(item.session_id, undefined);
      assert.equal(item.photo_url, undefined);
      assert.equal(typeof item.is_seed, 'boolean');
      assert.equal(typeof item.product_name, 'string');
    }
    const unnamedListing = listed.reports.find((item) => item.nafdac_number === null);
    assert.ok(unnamedListing, 'a report with no registration number must be listable');
    assert.equal(unnamedListing.product_name.length > 0, true);

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
