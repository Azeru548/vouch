const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Freshness pipeline tests. Everything runs on a throwaway copy of the real
// database in the OS temp dir — the live DB is only ever *read* as a template,
// and the NAFDAC index is the committed fixture, never the network.

const { parseIndexHtml, parseAlertDate, parseAlertNumber, importAlerts, runSync } = require('./alert_sync');
const { deriveCategory, productFromTitle, normalizeAlertType, alertNumberFromTitleOrUrl } = require('./nafdac_alert_parser');
const { ensureKnownFakesTable } = require('./fakes_schema');
const { ensureHazardTable } = require('./hazard_schema');

const FIXTURE = path.join(__dirname, 'fixtures', 'nafdac_alerts_index.html');

// --- Parser unit checks ---
assert.equal(parseAlertDate('19-Aug-26'), '2026-08-19');
assert.equal(parseAlertDate('1-Sep-25'), '2025-09-01');
assert.equal(parseAlertDate('garbage'), null);

assert.equal(parseAlertNumber('Public Alert No. 043/2026-NAFDAC Places Products Marketed by Mofus Nigeria Ltd on Watchlist'), '043/2026');
assert.equal(parseAlertNumber('Public Alert No.35/2025 – Substandard batches of Annmox'), '035/2025');
assert.equal(parseAlertNumber('Updated Public Alert No. 030A/2025 - Sale of Confirmed Substandard ARTEMETRIN DS Tablets'), '030A/2025');
assert.equal(alertNumberFromTitleOrUrl('no number here', 'https://nafdac.gov.ng/public-alert-no-12-2026-something/'), '012/2026');

assert.equal(deriveCategory('Drugs'), 'drug');
assert.equal(deriveCategory('Food'), 'food');
assert.equal(deriveCategory('Cosmetics'), 'cosmetic');
assert.equal(deriveCategory('Chemicals'), 'chemical');
assert.equal(deriveCategory('Regulated Products'), 'other');
assert.equal(normalizeAlertType('Recalls'), 'recall');
assert.equal(normalizeAlertType('Blacklisting'), 'blacklist');
assert.equal(normalizeAlertType('Safety Alert'), 'safety_alert');

assert.equal(
  productFromTitle('Public Alert No. 043/2026-NAFDAC Places Products Marketed by Mofus Nigeria Ltd on Watchlist'),
  'NAFDAC Places Products Marketed by Mofus Nigeria Ltd on Watchlist',
);
assert.equal(productFromTitle('Blacklisting of Aveo Pharmaceuticals'), 'Blacklisting of Aveo Pharmaceuticals');

const html = fs.readFileSync(FIXTURE, 'utf8');
const rows = parseIndexHtml(html);
assert.ok(rows.length >= 300, `fixture should parse the full index, saw ${rows.length}`);
for (const row of rows) {
  assert.ok(row.title && row.source_url, 'every row needs title and url');
  assert.ok(row.source_url.startsWith('https://nafdac.gov.ng/'), 'url must be a nafdac.gov.ng page');
  assert.ok(row.alert_date === null || /^\d{4}-\d{2}-\d{2}$/.test(row.alert_date), 'date must be ISO or null');
}
const oracire = rows.find((r) => r.source_url.includes('041-2026'));
assert.ok(oracire, 'ORACIRE+ alert should be in the index');
assert.equal(oracire.alert_date, '2026-08-19');
assert.equal(oracire.product_type, 'Regulated Products');

// --- Import lifecycle on a throwaway DB ---
const tmpDb = path.join(os.tmpdir(), `vouch-sync-test-${process.pid}.db`);
fs.copyFileSync(path.join(__dirname, '..', 'data', 'nafdac_products.db'), tmpDb);
// runSync resolves the database from the environment on every call — point it
// at the throwaway copy so the real database is never written by tests.
process.env.DATABASE_PATH = tmpDb;
const db = new DatabaseSync(tmpDb);

try {
  // Start from an empty slate: drop earlier sync rows and the curated
  // library, then plant ONE curated pair to exercise the collision rule.
  db.exec('DELETE FROM known_fakes');
  db.exec('DELETE FROM hazard_alerts');
  ensureKnownFakesTable(db);
  ensureHazardTable(db);
  db.prepare(`
    INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance)
    VALUES ('041/2026', 'ORACIRE+ Toothpaste (curated)', NULL, '[]', 'hand-tuned row', 'https://nafdac.gov.ng/curated-oracire/', '["/fakes/041-2026-1.png"]', 'cosmetic', 'ORACIRE+', '["Oracire Plus"]', 'hand-written appearance')
  `).run();
  db.prepare(`
    INSERT INTO hazard_alerts (alert_number, product_name, nafdac_number, batches, hazard, alert_type, manufacturer, source_url, alert_date, in_registry)
    VALUES ('041/2026', 'ORACIRE+ Toothpaste (curated)', NULL, '[]', 'hand-tuned row', 'safety_alert', NULL, 'https://nafdac.gov.ng/curated-oracire/', '2026-08-19', 0)
  `).run();

  const first = importAlerts(db, rows);
  assert.ok(first.imported > 380, `first import should bring in the index, saw ${first.imported}`);
  assert.ok(first.skipped.curated_collision >= 1, 'the curated ORACIRE row must cause a collision skip');
  assert.equal(first.skipped.already_known, 0);

  // The curated row survived untouched; the colliding fixture row was skipped.
  const curated = db.prepare("SELECT * FROM known_fakes WHERE alert_number = '041/2026'").get();
  assert.equal(curated.product_name, 'ORACIRE+ Toothpaste (curated)');
  assert.equal(curated.source_url, 'https://nafdac.gov.ng/curated-oracire/');
  assert.ok(JSON.parse(curated.photos_json).length === 1, 'curated photos intact');

  // An imported row has the right shape: derived category, title as hazard,
  // NAFDAC's headline phrase as the product name, no photos or appearance.
  const cerelac = db.prepare("SELECT * FROM known_fakes WHERE source_url LIKE '%018-2026%'").get();
  assert.ok(cerelac, 'Cerelac alert imported');
  assert.equal(cerelac.category, 'food');
  assert.ok(cerelac.hazard.includes('Cerelac'), 'hazard carries the NAFDAC headline');
  assert.equal(JSON.parse(cerelac.photos_json).length, 0, 'imported rows carry no photos');
  assert.equal(cerelac.appearance, null);
  const cerelacHazard = db.prepare('SELECT * FROM hazard_alerts WHERE source_url LIKE ?').get('%018-2026%');
  assert.ok(cerelacHazard, 'matching hazard_alerts row exists');
  assert.equal(cerelacHazard.alert_type, 'safety_alert');

  // Idempotency: a second pass imports nothing and skips everything known.
  const second = importAlerts(db, rows);
  assert.equal(second.imported, 0, 'second import must add nothing');
  assert.ok(second.skipped.already_known >= first.imported);

  // Consistency: every library row must have a hazard_alerts twin with the
  // same URL — the seed and the sync each insert into both tables.
  const orphans = db.prepare(`
    SELECT COUNT(*) AS n FROM known_fakes k
    WHERE NOT EXISTS (SELECT 1 FROM hazard_alerts h WHERE h.source_url = k.source_url)
  `).get().n;
  assert.equal(orphans, 0, `every known_fakes row needs a hazard_alerts twin, found ${orphans} orphans`);

  // runSync (the file-level entry the CLI uses) behaves identically.
  const summary = runSync({ html });
  assert.equal(summary.imported, 0);
  assert.equal(summary.index_rows, rows.length);

  console.log(`alert-sync: parser (${rows.length} rows), direct import (${first.imported}), curated-collision skip, idempotency, and twin-table consistency passed`);
} finally {
  db.close();
  fs.rmSync(tmpDb, { force: true });
}
