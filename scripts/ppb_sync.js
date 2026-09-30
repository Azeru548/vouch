const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { databasePath } = require('../config');
const { ensureHazardTable } = require('./hazard_schema');
const { ensureKnownFakesTable } = require('./fakes_schema');
const {
  parseRecallTableHtml, parseSafetyAlertsHtml,
} = require('./ppb_parser');

// Kenya freshness pipeline: Pharmacy and Poisons Board alerts join the same
// register and matching library as NAFDAC alerts, tagged source_country='KE'.
//
// Sources (web.pharmacyboardkenya.org — the old site; ppb.go.ke is a
// JS-rendered SPA with no server HTML to parse):
//   - Recalls by year: /products-recalled-2026/ … /product-recall-2023/
//     (one structured table per year; 2022 and older have no pages)
//   - Safety alerts: /safety-alerts/ (date + title + PDF download links)
//
// Every import writes BOTH hazard_alerts and known_fakes, mirroring the
// NAFDAC sync and the seed, so twin-table consistency always holds. Matching
// is country-filtered in server.js: a Kenyan check sees PPB rows, a Nigerian
// check sees NAFDAC rows — a flag on either side always names its authority.

const YEAR_PAGES = [
  { year: 2026, url: 'https://web.pharmacyboardkenya.org/products-recalled-2026/' },
  { year: 2025, url: 'https://web.pharmacyboardkenya.org/products-recalled-2025/' },
  { year: 2024, url: 'https://web.pharmacyboardkenya.org/Product recalled 2024/' },
  { year: 2023, url: 'https://web.pharmacyboardkenya.org/product-recall-2023/' },
];
const SAFETY_ALERTS_URL = 'https://web.pharmacyboardkenya.org/safety-alerts/';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

class PpbSyncError extends Error {}

async function fetchText(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new PpbSyncError(`PPB page returned HTTP ${res.status} for ${url}`);
  return res.text();
}

function alertNumberForEntry(entry) {
  if (entry.reference) return String(entry.reference).trim().replace(/\.+$/, ''); // 'REC/2026/016'
  // Safety alerts have no reference number; the URL slug is unique and stable.
  const slug = String(entry.source_url || '').replace(/\/$/, '').split('/').pop();
  return slug ? `ppb-${slug}`.slice(0, 120) : null;
}

function importPpbAlerts(db, { recallRows, safetyEntries }) {
  ensureHazardTable(db);
  ensureKnownFakesTable(db);

  const knownUrls = new Set([
    ...db.prepare('SELECT source_url FROM hazard_alerts').all().map((r) => r.source_url),
    ...db.prepare('SELECT source_url FROM known_fakes').all().map((r) => r.source_url),
  ]);
  // PPB sometimes lists the same reference twice with different links; the
  // library key is alert_number, so track it separately from URLs.
  const knownAlertNumbers = new Set(
    db.prepare('SELECT alert_number FROM known_fakes').all().map((r) => r.alert_number),
  );

  const insertHazard = db.prepare(`
    INSERT INTO hazard_alerts (alert_number, product_name, nafdac_number, batches, hazard, alert_type, manufacturer, source_url, alert_date, in_registry, source_country)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 'KE')
  `);
  const insertFake = db.prepare(`
    INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance, source_country)
    VALUES (?, ?, NULL, ?, ?, ?, '[]', 'drug', ?, ?, NULL, 'KE')
    ON CONFLICT (alert_number) DO NOTHING
  `);

  const imported = [];
  const skipped = { already_known: 0, duplicate_ref: 0, no_name: 0 };

  const run = (rows) => {
    for (const row of rows) {
      const url = row.source_url;
      // Recall rows carry a product name; safety-alert entries only have a
      // title, which becomes the name the register and matching key on.
      const productName = row.product_name || row.title;
      if (!productName) { skipped.no_name++; continue; }
      if (url && knownUrls.has(url)) { skipped.already_known++; continue; }

      const alertNumber = alertNumberForEntry(row) || url || `ppb-${Date.now()}`;
      if (knownAlertNumbers.has(alertNumber)) { skipped.duplicate_ref++; continue; }
      const isRecall = row.alert_type === 'recall' || String(row.reference || '').startsWith('REC/');
      const hazard = isRecall
        ? `PPB recall${row.status && row.status !== 'unspecified' ? ` (${row.status})` : ''}: ${row.reason || 'quality-related recall'}`
        : row.title || productName;
      const aliases = row.inn ? [row.inn] : [];
      const batches = JSON.stringify(Array.isArray(row.batches) ? row.batches : []);
      const date = row.date || new Date().toISOString().slice(0, 10);

      db.prepare('BEGIN').run();
      try {
        insertHazard.run(alertNumber, productName, batches, hazard, isRecall ? 'recall' : 'safety_alert', row.manufacturer || null, url || `https://web.pharmacyboardkenya.org/#${encodeURIComponent(alertNumber)}`, date);
        insertFake.run(alertNumber, productName, batches, hazard, url || `https://web.pharmacyboardkenya.org/#${encodeURIComponent(alertNumber)}`, productName, JSON.stringify(aliases));
        db.prepare('COMMIT').run();
      } catch (e) {
        db.prepare('ROLLBACK').run();
        throw e;
      }

      if (url) knownUrls.add(url);
      knownAlertNumbers.add(alertNumber);
      imported.push({ alert: alertNumber, product: productName, type: isRecall ? 'recall' : 'safety_alert' });
    }
  };

  run(recallRows);
  run(safetyEntries);

  return {
    imported: imported.length,
    skipped,
    by_type: {
      recall: imported.filter((r) => r.type === 'recall').length,
      safety_alert: imported.filter((r) => r.type === 'safety_alert').length,
    },
    sample: imported.slice(0, 5),
  };
}

function runSync({ pages = {}, safetyAlertsHtml = null } = {}) {
  const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
  const db = new DatabaseSync(dbPath);
  try {
    const recallRows = Object.entries(pages).flatMap(([year, html]) => parseRecallTableHtml(html, { year: Number(year) }));
    const safetyEntries = safetyAlertsHtml ? parseSafetyAlertsHtml(safetyAlertsHtml) : [];
    return importPpbAlerts(db, { recallRows, safetyEntries });
  } finally {
    db.close();
  }
}

async function main() {
  let pages = {};
  let safetyAlertsHtml = null;
  if (process.argv.includes('--fixture')) {
    const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
    pages = {
      2026: fx('ppb_recalls_2026.html'),
      2025: fx('ppb_recalls_2025.html'),
      2024: fx('ppb_recalls_2024.html'),
      2023: fx('ppb_recalls_2023.html'),
    };
    safetyAlertsHtml = fx('ppb_safety_alerts.html');
    console.error('[ppb-sync] using saved fixtures — no network');
  } else {
    for (const { year, url } of YEAR_PAGES) {
      pages[year] = await fetchText(url);
      await new Promise((r) => setTimeout(r, 400));
    }
    safetyAlertsHtml = await fetchText(SAFETY_ALERTS_URL);
  }
  const summary = runSync({ pages, safetyAlertsHtml });
  if (summary.imported === 0 && summary.skipped.already_known === 0) {
    throw new PpbSyncError('Parsed 0 rows from the live PPB pages — the layout may have changed.');
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { importPpbAlerts, runSync, fetchText, PpbSyncError, YEAR_PAGES, SAFETY_ALERTS_URL };
