const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Kenya PPB freshness-pipeline tests. Everything runs on a throwaway copy of
// the real database in the OS temp dir; the PPB pages are the committed
// fixtures, never the network.

const { parseRecallTableHtml, parseSafetyAlertsHtml, parsePpbDate, parsePpbLongDate, normalizeRecallStatus } = require('./ppb_parser');
const { importPpbAlerts, runSync } = require('./ppb_sync');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// --- Parser unit checks ---
assert.equal(parsePpbDate('28/07/2026'), '2026-07-28');
assert.equal(parsePpbDate('1/1/2025'), '2025-01-01');
assert.equal(parsePpbDate('nope'), null);
assert.equal(parsePpbLongDate('18th September 2023'), '2023-09-18');
assert.equal(parsePpbLongDate('4-Mar-2022'), null); // different format, not the long form
assert.equal(parsePpbLongDate('garbage'), null);
assert.equal(normalizeRecallStatus('Concluded'), 'concluded');
assert.equal(normalizeRecallStatus('Ongoing'), 'ongoing');
assert.equal(normalizeRecallStatus(''), 'unspecified');

const recalls2026 = parseRecallTableHtml(fx('ppb_recalls_2026.html'), { year: 2026 });
assert.ok(recalls2026.length >= 10, `2026 table should parse, saw ${recalls2026.length}`);
const panto = recalls2026.find((r) => r.product_name === 'Panto-Denk');
assert.ok(panto, 'Panto-Denk row parsed');
assert.equal(panto.reference, 'REC/2026/016');
assert.equal(panto.date, '2026-07-28');
assert.equal(panto.status, 'concluded');
assert.ok(panto.batches.includes('6289'), 'batch list parsed');
assert.ok(panto.source_url.includes('pharmacyboardkenya.org'), 'row links to the report page');
assert.ok(panto.inn, 'INN captured as alias');

// All four year fixtures parse to non-empty sets.
for (const year of [2023, 2024, 2025, 2026]) {
  const rows = parseRecallTableHtml(fx(`ppb_recalls_${year}.html`), { year });
  assert.ok(rows.length > 0, `${year} table should parse`);
}

// Safety alerts: dedupe by URL, dates parsed where the long format applies.
const safety = parseSafetyAlertsHtml(fx('ppb_safety_alerts.html'));
assert.ok(safety.length >= 15, `safety alerts should parse, saw ${safety.length}`);
const uniqueUrls = new Set(safety.map((s) => s.source_url));
assert.equal(uniqueUrls.size, safety.length, 'safety alerts deduped by URL');
const tamedol = safety.find((s) => /Tamedol/i.test(s.title));
assert.ok(tamedol, 'Tamedol alert present');
assert.equal(tamedol.alert_date, '2023-09-18');

// --- Import lifecycle on a throwaway DB ---
const tmpDb = path.join(os.tmpdir(), `vouch-ppb-test-${process.pid}.db`);
fs.copyFileSync(path.join(__dirname, '..', 'data', 'nafdac_products.db'), tmpDb);
// runSync resolves the database from the environment on every call — point it
// at the throwaway copy so the real database is never written by tests.
process.env.DATABASE_PATH = tmpDb;
const db = new DatabaseSync(tmpDb);
// Start KE rows from zero: the live database may already hold rows from a
// real PPB sync, and the lifecycle below needs a deterministic first run.
db.exec("DELETE FROM known_fakes WHERE source_country = 'KE'");
db.exec("DELETE FROM hazard_alerts WHERE source_country = 'KE'");

try {
  const pages = {
    2026: fx('ppb_recalls_2026.html'),
    2025: fx('ppb_recalls_2025.html'),
    2024: fx('ppb_recalls_2024.html'),
    2023: fx('ppb_recalls_2023.html'),
  };
  const safetyHtml = fx('ppb_safety_alerts.html');

  const first = runSync({ pages, safetyAlertsHtml: safetyHtml });
  assert.ok(first.imported > 20, `first PPB import should bring the corpus, saw ${first.imported}`);
  assert.ok(first.by_type.recall > 0);
  assert.ok(first.by_type.safety_alert > 0);

  // Every imported row is tagged KE and has both table rows.
  const keFakes = db.prepare("SELECT COUNT(*) AS n FROM known_fakes WHERE source_country = 'KE'").get().n;
  const keHazards = db.prepare("SELECT COUNT(*) AS n FROM hazard_alerts WHERE source_country = 'KE'").get().n;
  assert.equal(keFakes, first.imported, 'every import wrote a known_fakes row');
  assert.equal(keHazards, first.imported, 'every import wrote a hazard_alerts row');

  const pantoFake = db.prepare("SELECT * FROM known_fakes WHERE product_name = 'Panto-Denk'").get();
  assert.ok(pantoFake, 'Panto-Denk in library');
  assert.equal(pantoFake.source_country, 'KE');
  assert.equal(JSON.parse(pantoFake.aliases).includes('Pantoprazole Sodium Sesquihydrate'), true, 'INN stored as alias');
  assert.equal(JSON.parse(pantoFake.batches).includes('6289'), true, 'batches stored');

  // NAFDAC rows in the copy are untouched and still NG.
  const ngFakes = db.prepare("SELECT COUNT(*) AS n FROM known_fakes WHERE source_country = 'NG'").get().n;
  assert.ok(ngFakes >= 400, `NG rows intact, saw ${ngFakes}`);

  // Idempotency.
  const second = runSync({ pages, safetyAlertsHtml: safetyHtml });
  assert.equal(second.imported, 0, 'second PPB import adds nothing');

  // Twin-table consistency across BOTH countries.
  const orphans = db.prepare(`
    SELECT COUNT(*) AS n FROM known_fakes k
    WHERE NOT EXISTS (SELECT 1 FROM hazard_alerts h WHERE h.source_url = k.source_url)
  `).get().n;
  assert.equal(orphans, 0, `every library row needs a hazard twin, found ${orphans}`);

  console.log(`ppb-sync: parser (${recalls2026.length} rows 2026, ${safety.length} safety alerts), import (${first.imported} KE), idempotency, twin-table consistency passed`);
} finally {
  db.close();
  fs.rmSync(tmpDb, { force: true });
}
