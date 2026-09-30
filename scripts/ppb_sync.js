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
// Primary source (since 2026-09): ppb.go.ke's public PostgREST API — the same
// structured backend the portal's own pages render from (recalls,
// safety_communications, rapid_alerts), read with the site's public anon key.
// It carries fields the old HTML tables never had: is_active, the INN generic
// name, and a full reason text.
// Fallback source: the old web.pharmacyboardkenya.org pages the first sync
// used (per-year recall tables + safety-alert listing), kept for the day the
// API endpoint moves.
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

// Public anon key the ppb.go.ke portal ships in its own bundle — it gates
// nothing; the portal hands the same data to every visitor's browser.
const PPB_API_BASE = 'https://ppb.go.ke/rest/v1';
const PPB_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const PPB_API_PAGE_SIZE = 1000;

class PpbSyncError extends Error {}

async function fetchText(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new PpbSyncError(`PPB page returned HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchApiTable(table, columns) {
  const headers = {
    apikey: PPB_API_KEY,
    Authorization: `Bearer ${PPB_API_KEY}`,
    Accept: 'application/json',
    'User-Agent': BROWSER_HEADERS['User-Agent'],
  };
  const all = [];
  for (let offset = 0; ; offset += PPB_API_PAGE_SIZE) {
    const url = `${PPB_API_BASE}/${table}?select=${encodeURIComponent(columns)}&order=id&limit=${PPB_API_PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new PpbSyncError(`PPB API returned HTTP ${res.status} for ${table}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new PpbSyncError(`PPB API returned a non-array for ${table}`);
    all.push(...rows);
    if (rows.length < PPB_API_PAGE_SIZE) break;
  }
  return all;
}

// The API's batch cell keeps PPB's free-text style ("6289,6288, 6097 and
// 5397."); splitting mirrors what the HTML-table parser does.
function splitBatchCell(text) {
  return String(text || '')
    .split(/,|;|\band\b/i)
    .map((b) => b.replace(/\./g, '').trim())
    .filter(Boolean);
}

function apiUrlFor(table, row) {
  if (row.pdf_url && /^https?:\/\//.test(row.pdf_url)) return row.pdf_url;
  const type = table === 'recalls' ? 'Recall' : table === 'safety_communications' ? 'Safety+Communication' : 'Rapid+Alert';
  return `https://ppb.go.ke/alerts-recalls?type=${type}`;
}

// API rows → the same entry shape the HTML parsers produce, so the importer
// below does not care where a row came from.
async function fetchApiAlerts() {
  const [recalls, safetyComms, rapidAlerts] = await Promise.all([
    fetchApiTable('recalls', 'id, product_name, reference_number, reasons, status, recall_date, inn_name, batch_number, manufacturer, pdf_url'),
    fetchApiTable('safety_communications', 'id, title, published_date, pdf_url'),
    fetchApiTable('rapid_alerts', 'id, title, alert_date, pdf_url'),
  ]);
  const recallRows = recalls.map((row) => ({
    reference: row.reference_number,
    product_name: row.product_name,
    inn: row.inn_name || null,
    batches: splitBatchCell(row.batch_number),
    manufacturer: row.manufacturer || null,
    reason: row.reasons || null,
    status: String(row.status || '').toLowerCase() || 'unspecified',
    date: row.recall_date || null,
    source_url: apiUrlFor('recalls', row),
    alert_type: 'recall',
  }));
  // PPB's API titles carry literal tabs/newlines from their CMS rich text;
  // collapse them so register listings and matching see clean single spaces.
  const cleanTitle = (t) => String(t || '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const safetyEntries = [
    ...safetyComms.map((row) => ({ title: cleanTitle(row.title), date: row.published_date || null, source_url: apiUrlFor('safety_communications', row) })),
    ...rapidAlerts.map((row) => ({ title: cleanTitle(row.title), date: row.alert_date || null, source_url: apiUrlFor('rapid_alerts', row) })),
  ].filter((entry) => entry.title);
  return { recallRows, safetyEntries };
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

function runSync({ recallRows = null, safetyEntries = null, pages = {}, safetyAlertsHtml = null } = {}) {
  const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
  const db = new DatabaseSync(dbPath);
  try {
    const recalls = recallRows ?? Object.entries(pages).flatMap(([year, html]) => parseRecallTableHtml(html, { year: Number(year) }));
    const safety = safetyEntries ?? (safetyAlertsHtml ? parseSafetyAlertsHtml(safetyAlertsHtml) : []);
    return importPpbAlerts(db, { recallRows: recalls, safetyEntries: safety });
  } finally {
    db.close();
  }
}

async function main() {
  let summary = null;
  let source = 'api';
  if (!process.argv.includes('--fixture')) {
    try {
      const api = await fetchApiAlerts();
      if (api.recallRows.length + api.safetyEntries.length === 0) throw new PpbSyncError('PPB API returned 0 rows across all tables');
      summary = runSync({ recallRows: api.recallRows, safetyEntries: api.safetyEntries });
    } catch (apiError) {
      console.error(`[ppb-sync] API failed (${apiError.message}) — falling back to the old-site scrape.`);
      source = 'scrape';
    }
  }
  if (!summary) {
    source = process.argv.includes('--fixture') ? 'fixture' : 'scrape';
    let pages = {};
    let safetyAlertsHtml = null;
    if (source === 'fixture') {
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
    summary = runSync({ pages, safetyAlertsHtml });
  }
  if (summary.imported === 0 && summary.skipped.already_known === 0) {
    throw new PpbSyncError('Parsed 0 rows from PPB — the API or page layout may have changed.');
  }
  console.log(JSON.stringify({ ...summary, source }, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { importPpbAlerts, runSync, fetchText, fetchApiAlerts, PpbSyncError, YEAR_PAGES, SAFETY_ALERTS_URL };
