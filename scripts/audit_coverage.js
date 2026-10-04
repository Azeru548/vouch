// Authoritative coverage audit: fetch NAFDAC's index with the project's OWN
// parser and diff the result against what we hold.
//
// The first version of this audit used its own regex for "Public Alert No...",
// which silently skipped rows whose titles start differently ("Regulatory
// Clarification on Deleject...", "Blacklisting of Aveo Pharmaceuticals...").
// That undercounted the index and invented a phantom gap. This version reuses
// scripts/nafdac_alert_parser.js so the measurement matches the importer.
//
// Usage: node scripts/audit_coverage.js
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');
const { parseIndexHtml, alertNumberFromTitleOrUrl } = require('./nafdac_alert_parser');

const INDEX = 'https://nafdac.gov.ng/category/recalls-and-alerts/';

async function main() {
  const res = await fetch(INDEX, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; vouch-audit)' } });
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  const rows = parseIndexHtml(await res.text());

  const db = new DatabaseSync(databasePath, { readOnly: true });
  const held = db.prepare("select alert_number, source_url, product_name, alert_date from hazard_alerts where source_country='NG'").all();
  const heldNums = new Set(held.map((r) => r.alert_number));
  const heldUrls = new Set(held.map((r) => r.source_url).filter(Boolean));

  const missingNum = [];
  const missingUrl = [];
  let noNumber = 0;

  for (const row of rows) {
    const num = alertNumberFromTitleOrUrl(row.title, row.source_url, row.alert_date);
    if (!num) { noNumber++; continue; }
    if (heldNums.has(num)) continue;
    // present, but not under that number
    if (heldUrls.has(row.source_url)) continue;
    missingNum.push({ number: num, title: row.title, url: row.source_url, date: row.alert_date });
  }

  // the reverse: rows we hold whose URL is no longer on the index at all
  const indexUrls = new Set(rows.map((r) => r.source_url));
  const orphans = held.filter((r) => r.source_url && !indexUrls.has(r.source_url));

  console.log(`index rows parsed (project parser): ${rows.length}`);
  console.log(`  of those, NAFDAC published no alert number: ${noNumber}`);
  console.log(`NG alert rows we hold:                        ${held.length}`);
  console.log('');
  console.log(`index entries genuinely absent from our DB:    ${missingNum.length}`);
  console.log(`rows we hold whose source URL left the index:   ${orphans.length}`);

  if (missingNum.length) {
    console.log('\n--- absent ---');
    for (const m of missingNum) console.log(`  ${m.number.padEnd(10)} ${m.date || '        '} ${m.title.slice(0, 92)}`);
  }
  if (orphans.length) {
    console.log('\n--- held but no longer on the index (may just be pagination) ---');
    for (const o of orphans.slice(0, 15)) console.log(`  ${o.alert_number} ${o.product_name.slice(0, 70)}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
