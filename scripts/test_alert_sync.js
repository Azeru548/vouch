const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Freshness pipeline tests. Everything runs on a throwaway copy of the real
// database in the OS temp dir — the live DB is only ever *read* as a template,
// and the NAFDAC index is the committed fixture, never the network.

const { parseIndexHtml, parseAlertDate, parseAlertNumber, alertNumberFromTitleOrUrl, runSync } = require('./alert_sync');
const { dismissPending, promotePending, PromoteError } = require('./promote_alert');

const FIXTURE = path.join(__dirname, 'fixtures', 'nafdac_alerts_index.html');

// --- Parser unit checks ---
assert.equal(parseAlertDate('19-Aug-26'), '2026-08-19');
assert.equal(parseAlertDate('1-Sep-25'), '2025-09-01');
assert.equal(parseAlertDate('garbage'), null);

assert.equal(parseAlertNumber('Public Alert No. 043/2026-NAFDAC Places Products Marketed by Mofus Nigeria Ltd on Watchlist'), '043/2026');
assert.equal(parseAlertNumber('Public Alert No.35/2025 – Substandard batches of Annmox'), '035/2025');
assert.equal(parseAlertNumber('Updated Public Alert No. 030A/2025 - Sale of Confirmed Substandard ARTEMETRIN DS Tablets'), '030A/2025');
assert.equal(alertNumberFromTitleOrUrl('no number here', 'https://nafdac.gov.ng/public-alert-no-12-2026-something/'), '012/2026');

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

// --- Lifecycle on a throwaway DB ---
const tmpDb = path.join(os.tmpdir(), `vouch-sync-test-${process.pid}.db`);
fs.copyFileSync(path.join(__dirname, '..', 'data', 'nafdac_products.db'), tmpDb);
// runSync resolves the database from the environment on every call — point it
// at the throwaway copy so the real database is never written by tests.
process.env.DATABASE_PATH = tmpDb;
const db = new DatabaseSync(tmpDb);
// Start from a clean pending slate: the live database may already hold rows
// from a real sync, and the lifecycle below needs a deterministic first run.
db.exec('DELETE FROM pending_alerts');

try {
  const first = runSync({ html });
  assert.ok(first.imported > 0, 'first sync must import the unseen index rows');
  assert.equal(first.imported, first.pending_new);
  const importedCount = first.imported;

  // Idempotent: a second pass imports nothing new.
  const second = runSync({ html });
  assert.equal(second.imported, 0, 'second sync must import nothing');
  assert.equal(second.known_before, second.index_rows);

  // Curated rows are never re-imported: known_fakes URLs stay unknown to pending.
  const curatedUrls = db.prepare('SELECT source_url FROM known_fakes').all().map((r) => r.source_url);
  assert.ok(curatedUrls.length >= 15);
  const pendingUrls = new Set(db.prepare('SELECT source_url FROM pending_alerts').all().map((r) => r.source_url));
  for (const url of curatedUrls) assert.ok(!pendingUrls.has(url), `curated url ${url} must not be pending`);

  // Dismissal keeps the row but marks it.
  const anyPending = db.prepare("SELECT id FROM pending_alerts WHERE status = 'new' LIMIT 1").get();
  dismissPending(db, anyPending.id);
  assert.equal(db.prepare('SELECT status FROM pending_alerts WHERE id = ?').get(anyPending.id).status, 'dismissed');
  assert.throws(() => dismissPending(db, 999999), PromoteError);

  // Promotion moves a row into both curated tables and removes it from pending.
  const toPromote = db.prepare("SELECT * FROM pending_alerts WHERE status = 'new' LIMIT 1").get();
  assert.ok(toPromote.alert_number, 'fixture rows carry alert numbers');
  const result = promotePending(db, toPromote.id, {
    name: 'Test Promoted Product',
    category: 'food',
    aliases: ['Test Alias'],
    batches: ['B1'],
  });
  assert.equal(result.promoted.alert, toPromote.alert_number);
  const fakeRow = db.prepare('SELECT * FROM known_fakes WHERE alert_number = ?').get(toPromote.alert_number);
  assert.equal(fakeRow.product_name, 'Test Promoted Product');
  assert.equal(fakeRow.category, 'food');
  assert.equal(fakeRow.source_url, toPromote.source_url);
  const hazardRow = db.prepare('SELECT product_name FROM hazard_alerts WHERE alert_number = ?').get(toPromote.alert_number);
  assert.equal(hazardRow.product_name, 'Test Promoted Product');
  assert.ok(!db.prepare('SELECT 1 FROM pending_alerts WHERE id = ?').get(toPromote.id), 'promoted row leaves pending');

  // Promoting an alert number already curated from a DIFFERENT page is refused.
  const duplicate = db.prepare("SELECT * FROM pending_alerts WHERE status = 'new' AND alert_number = ? LIMIT 1").get('041/2026');
  if (duplicate) {
    assert.throws(() => promotePending(db, duplicate.id, { name: 'X', category: 'food' }), PromoteError);
  }

  // Promotion validation.
  const nextPending = db.prepare("SELECT id FROM pending_alerts WHERE status = 'new' LIMIT 1").get();
  assert.throws(() => promotePending(db, nextPending.id, { category: 'food' }), PromoteError);
  assert.throws(() => promotePending(db, nextPending.id, { name: 'X', category: 'vehicle' }), PromoteError);
  assert.throws(() => promotePending(db, 999999, { name: 'X', category: 'food' }), PromoteError);

  console.log(`alert-sync: parser (${rows.length} rows), sync import (${importedCount}) + idempotency, dismiss, promote, and guards passed`);
} finally {
  db.close();
  fs.rmSync(tmpDb, { force: true });
}
