const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { databasePath } = require('../config');
const { ensurePendingTable } = require('./pending_schema');
const { ensureHazardTable } = require('./hazard_schema');

// Freshness pipeline, stage 1: discovery.
//
// NAFDAC publishes new public alerts on the Recalls and Safety Alerts category
// page (https://nafdac.gov.ng/category/recalls-and-alerts/). As of September
// 2026 that page embeds every row of the listing server-side in one HTML table
// (Ninja Tables / FooTable), so one fetch yields the whole index — no
// pagination.
//
// The script diffs the index against what we already hold:
//   - `hazard_alerts` (curated, active)  — matched on source_url
//   - `pending_alerts` (seen/dismissed)  — matched on source_url
// Anything unseen is imported as status 'new'.
//
// Nothing imported here affects verification. Pending alerts surface only in
// the register's "awaiting review" section and in the admin queue until a human
// promotes them via `npm run alert:promote <id>`.
const ALERTS_INDEX_URL = process.env.ALERTS_INDEX_URL ||
  'https://nafdac.gov.ng/category/recalls-and-alerts/';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8211;|&#x2013;/g, '\u2013')
    .replace(/&nbsp;/g, ' ');
}

function cellText(cell) {
  return decodeEntities(cell).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// '19-Aug-26' → '2026-08-19'. NAFDAC's two-digit year spans this century.
function parseAlertDate(text) {
  const m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = 2000 + Number(m[3]);
  return `${year}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

// 'Public Alert No. 043/2026-…' → '043/2026'. Tolerates 'No:' , 'No ', letter
// suffixes ('No. 030A/2025') and the missing leading zero NAFDAC sometimes
// drops ('Public Alert No.35/2025'). Numbers are padded to three digits, which
// is how the majority of curated rows store them.
function parseAlertNumber(title) {
  const m = /(?:Alert|Notice)[^/]*?No\.?\s*:?\s*(\d{1,3}[A-Z]?)\s*\/\s*(\d{4})/i.exec(title);
  if (!m) return null;
  return `${m[1].toUpperCase().padStart(3, '0')}/${m[2]}`;
}

// First <tr> … </tr> whose first cell is a date row of the listing table.
// Rows live inside <tbody>; the header row's cells carry <th>, not dates.
function parseIndexHtml(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  for (const tr of html.matchAll(trRe)) {
    const cells = [...tr[1].matchAll(tdRe)].map((c) => cellText(c[1]));
    if (cells.length < 5) continue;
    if (!/^\d{1,2}-[A-Za-z]{3}-\d{2}$/.test(cells[0])) continue; // header/other tables
    const link = /<a[^>]+href="(https:\/\/nafdac\.gov\.ng\/[^"]+)"/.exec(tr[1]);
    if (!link) continue;
    const title = cells[1];
    if (!title) continue;
    rows.push({
      title,
      source_url: decodeEntities(link[1]),
      alert_date: parseAlertDate(cells[0]),
      alert_type: cells[2] || null,       // 'Safety Alert' | 'Recall' | 'Blacklisting'
      product_type: cells[3] || null,     // 'Drugs' | 'Food' | 'Cosmetics' | 'Regulated Products' | 'Chemicals'
      manufacturer: cells[4] || null,
    });
  }
  return rows;
}

function alertNumberFromTitleOrUrl(title, url) {
  const fromTitle = parseAlertNumber(title);
  if (fromTitle) return fromTitle;
  const slug = url.replace(/\/$/, '').split('/').pop() || '';
  const m = /(?:public-alert-no-?)(\d{1,3}[ab]?)-(\d{4})/i.exec(slug);
  if (m) return `${m[1].padStart(3, '0')}/${m[2]}`;
  return null;
}

function runSync({ html = null } = {}) {
  const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
  const db = new DatabaseSync(dbPath);
  ensurePendingTable(db);
  ensureHazardTable(db);

  const now = new Date().toISOString();

  let rows;
  if (html) {
    rows = parseIndexHtml(html);
  } else {
    throw new Error('runSync requires html (CLI fetch happens in main())');
  }

  const known = new Set([
    ...db.prepare('SELECT source_url FROM hazard_alerts').all().map((r) => r.source_url),
    ...db.prepare('SELECT source_url FROM pending_alerts').all().map((r) => r.source_url),
  ]);

  const insert = db.prepare(`
    INSERT INTO pending_alerts (title, source_url, alert_number, alert_date, alert_type, product_type, manufacturer, status, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
    ON CONFLICT (source_url) DO UPDATE SET last_seen = excluded.last_seen
  `);

  const imported = [];
  for (const row of rows) {
    if (known.has(row.source_url)) continue;
    insert.run(
      row.title, row.source_url,
      alertNumberFromTitleOrUrl(row.title, row.source_url),
      row.alert_date, row.alert_type, row.product_type, row.manufacturer,
      now, now,
    );
    imported.push(row);
  }

  const summary = {
    index_rows: rows.length,
    known_before: known.size,
    imported: imported.length,
    pending_new: db.prepare("SELECT COUNT(*) AS n FROM pending_alerts WHERE status = 'new'").get().n,
    sample: imported.slice(0, 5).map((r) => ({ title: r.title, date: r.alert_date, product_type: r.product_type })),
  };
  db.close();
  return summary;
}

// A live fetch that parses to zero rows means NAFDAC redesigned their listing —
// say so loudly rather than reporting a clean no-op.
function guardLiveSummary(summary) {
  if (summary.index_rows === 0) {
    throw new Error('Parsed 0 rows from the live NAFDAC index — the listing layout may have changed.');
  }
  return summary;
}

async function fetchIndex(url = ALERTS_INDEX_URL) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`NAFDAC index returned HTTP ${res.status}`);
  return res.text();
}

async function main() {
  let html = null;
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

// Only fetch and sync when run as a script. Tests and the server require this
// module for the parser and runSync — they must never trigger a live fetch.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { parseIndexHtml, parseAlertDate, parseAlertNumber, alertNumberFromTitleOrUrl, runSync, fetchIndex, guardLiveSummary };
