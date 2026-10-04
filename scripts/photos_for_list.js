// Which items on the viral list have regulator-published reference photos?
// Cross-references the harvested photo manifest against the transcribed list items.
//
// Usage: node scripts/photos_for_list.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'alert_photo_manifest.json'), 'utf8'));
const items = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'viral_list_items.json'), 'utf8'));
const db = new DatabaseSync(databasePath, { readOnly: true });

function norm(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const rows = [];
for (const m of manifest) {
  rows.push({
    alert_number: m.alert_number,
    product_name: m.product_name,
    alert_date: m.alert_date,
    n: m.images.length,
    local: m.images.filter((i) => i.local).length,
    norm: norm(m.product_name),
  });
}

const results = [];
for (const it of items) {
  const q = norm(it.claim_name);
  if (!q) continue;
  const qw = q.split(' ').filter((w) => w.length >= 4);
  if (!qw.length) continue;
  let best = null;
  for (const r of rows) {
    const rw = new Set(r.norm.split(' '));
    const hits = qw.filter((w) => rw.has(w)).length;
    if (!hits) continue;
    const coverage = hits / qw.length;
    if (!best || coverage > best.coverage) best = { ...r, coverage };
  }
  results.push({
    item: it.claim_name,
    matched_alert: best && best.coverage >= 0.99 ? best : null,
    partial: best && best.coverage < 0.99 ? `${Math.round(best.coverage * 100)}% (${best.alert_number})` : null,
  });
}

const withPhotos = results.filter((r) => r.matched_alert);
console.log(`list items: ${items.length}`);
console.log(`items matching an alert that has photos: ${withPhotos.length}`);
console.log(`items with NO photo evidence: ${items.length - withPhotos.length}`);
console.log(`\nalerts with photos: ${rows.length}, total photos: ${rows.reduce((n, r) => n + r.n, 0)}\n`);

console.log('--- items WITH regulator photos ---');
for (const r of withPhotos) {
  const a = r.matched_alert;
  console.log(`  ${String(a.local).padStart(3)}/${a.n} img  ${a.alert_number.padEnd(10)} ${r.item.slice(0, 44)}`);
}
console.log('\n--- items WITHOUT any photo evidence ---');
for (const r of results.filter((x) => !x.matched_alert)) {
  console.log(`  ${r.item}${r.partial ? '   [partial ' + r.partial + ']' : ''}`);
}

fs.writeFileSync(path.join(__dirname, '..', 'research', 'list_photo_coverage.json'), JSON.stringify(results, null, 2));