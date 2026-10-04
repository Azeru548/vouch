// Diagnostic: for every alert our DB keyed by URL instead of an alert number,
// can we recover the real number from the stored title or source URL?
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

const { alertNumberFromTitleOrUrl } = require('./nafdac_alert_parser');

const db = new DatabaseSync(databasePath, { readOnly: true });
const rows = db.prepare(
  "select alert_number, product_name, source_url from hazard_alerts where source_country='NG' and alert_number like 'http%'"
).all();

const existing = new Set(
  db.prepare("select alert_number from hazard_alerts where source_country='NG'").all().map((r) => r.alert_number)
);

let recoverable = 0;
let notRecoverable = 0;
const clashes = [];
const unfixed = [];

for (const r of rows) {
  const fixed = alertNumberFromTitleOrUrl(r.product_name, r.source_url, r.alert_date);
  if (!fixed) { notRecoverable++; unfixed.push(r); continue; }
  recoverable++;
  if (fixed !== r.alert_number && existing.has(fixed)) {
    clashes.push({ row: r.alert_number, wouldBecome: fixed, title: r.product_name.slice(0, 70) });
  }
}

console.log(`URL-keyed alerts:        ${rows.length}`);
console.log(`recoverable to a number: ${recoverable}`);
console.log(`still no number:         ${notRecoverable}`);
console.log(`would collide with an existing number: ${clashes.length}\n`);

console.log('--- collisions (need care, not a blind UPDATE) ---');
for (const c of clashes) console.log(`  ${c.wouldBecome}  ${c.title}`);

console.log('\n--- still no number after fix (first 25) ---');
for (const u of unfixed.slice(0, 25)) console.log(`  ${u.product_name.slice(0, 76)}`);
