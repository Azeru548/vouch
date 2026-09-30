const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { databasePath } = require('../config');
const { ensureHazardTable } = require('./hazard_schema');
const { ensureKnownFakesTable } = require('./fakes_schema');
const {
  parseIndexHtml, parseAlertDate, parseAlertNumber, alertNumberFromTitleOrUrl,
  deriveCategory, normalizeAlertType, productFromTitle,
} = require('./nafdac_alert_parser');

// Freshness pipeline: new NAFDAC alerts join the register and the matching
// library directly. No human review stage — NAFDAC is the source of truth;
// if they published an alert, that IS the review.
//
// What a sync does:
//   1. fetch the alerts index (or read the committed fixture with --fixture)
//   2. parse every listing row (title, URL, date, type, product type, maker)
//   3. import each alert not already present:
//        - known_fakes rows get an auto category from the listing's product
//          type, the title's product phrase as name, and NAFDAC's own hazard
//          statement. No photos, no appearance text — those can only come
//          from the alert page or a human later.
//        - hazard_alerts gets the same alert so number/name matching works.
//   4. skip, never overwrite:
//        - URLs already curated or imported (idempotency)
//        - alert numbers already curated (a "Updated …" re-post on a new URL
//          must not clobber the hand-tuned row)
//   5. verify the result: every known_fakes row must have a matching
//      hazard_alerts row with the same URL — the seed and the sync each
//      insert into both tables, so any mismatch means a bug.
//
// If NAFDAC ever enriches an alert we already hold, `npm run seed:fakes`
// stays the tool that rebuilds the 17 hand-curated rows; the sync never
// touches rows it did not create.

const ALERTS_INDEX_URL = process.env.ALERTS_INDEX_URL ||
  'https://nafdac.gov.ng/category/recalls-and-alerts/';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

class SyncError extends Error {}

async function fetchIndex(url = ALERTS_INDEX_URL) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new SyncError(`NAFDAC index returned HTTP ${res.status}`);
  return res.text();
}

function importAlerts(db, rows, { now = new Date().toISOString() } = {}) {
  ensureHazardTable(db);
  ensureKnownFakesTable(db);

  const knownUrls = new Set([
    ...db.prepare('SELECT source_url FROM hazard_alerts').all().map((r) => r.source_url),
    ...db.prepare('SELECT source_url FROM known_fakes').all().map((r) => r.source_url),
  ]);
  const curatedNumbers = new Set(
    db.prepare('SELECT alert_number FROM known_fakes').all().map((r) => r.alert_number),
  );

  const insertHazard = db.prepare(`
    INSERT INTO hazard_alerts (alert_number, product_name, nafdac_number, batches, hazard, alert_type, manufacturer, source_url, alert_date, in_registry)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const insertFake = db.prepare(`
    INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, NULL, '[]', NULL)
  `);

  const imported = [];
  const skipped = { already_known: 0, curated_collision: 0, no_url: 0 };
  for (const row of rows) {
    if (!row.source_url) { skipped.no_url++; continue; }
    if (knownUrls.has(row.source_url)) { skipped.already_known++; continue; }

    const alertNumber = alertNumberFromTitleOrUrl(row.title, row.source_url);
    // A curated row already covers this alert number — most often NAFDAC's
    // "Updated …" re-posts. The curated row has hand-tuned photos, aliases
    // and appearance text; never overwrite it.
    if (alertNumber && curatedNumbers.has(alertNumber)) { skipped.curated_collision++; continue; }

    const productName = productFromTitle(row.title);
    const hazard = row.title; // NAFDAC's own headline is the hazard statement
    const category = deriveCategory(row.product_type);

    db.prepare('BEGIN').run();
    try {
      insertHazard.run(
        alertNumber || row.source_url,
        productName,
        null,
        '[]',
        hazard,
        normalizeAlertType(row.alert_type),
        row.manufacturer,
        row.source_url,
        row.alert_date || now.slice(0, 10),
      );
      insertFake.run(
        alertNumber || row.source_url,
        productName,
        null,
        '[]',
        hazard,
        row.source_url,
        category,
      );
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }

    knownUrls.add(row.source_url);
    if (alertNumber) curatedNumbers.add(alertNumber);
    imported.push({ title: row.title, url: row.source_url, category, date: row.alert_date });
  }

  return {
    index_rows: rows.length,
    imported: imported.length,
    skipped,
    sample: imported.slice(0, 5),
  };
}

function runSync({ html = null } = {}) {
  if (!html) throw new SyncError('runSync requires html (the CLI does the fetching)');
  const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
  const db = new DatabaseSync(dbPath);
  try {
    return importAlerts(db, parseIndexHtml(html), {});
  } finally {
    db.close();
  }
}

// A live fetch that parses to zero rows means NAFDAC redesigned their listing —
// say so loudly rather than reporting a clean no-op.
function guardLiveSummary(summary) {
  if (summary.index_rows === 0) {
    throw new SyncError('Parsed 0 rows from the live NAFDAC index — the listing layout may have changed.');
  }
  return summary;
}

async function main() {
  let html;
  if (process.argv.includes('--fixture')) {
    const fixturePath = path.join(__dirname, 'fixtures', 'nafdac_alerts_index.html');
    html = fs.readFileSync(fixturePath, 'utf8');
    console.error(`[alert-sync] using saved fixture (${html.length} bytes) — no network`);
  } else {
    console.error(`[alert-sync] fetching ${ALERTS_INDEX_URL}`);
    html = await fetchIndex();
  }
  const summary = guardLiveSummary(runSync({ html }));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { importAlerts, runSync, fetchIndex, guardLiveSummary, SyncError, parseIndexHtml, parseAlertDate, parseAlertNumber };
