// Re-key alerts that were stored keyed by their source URL instead of an alert
// number, now that the parser handles NAFDAC's four-digit and No-less headlines.
//
// The 4-digit bug (\d{1,3} could never match 'No. 0037/2022') plus the missing
// optional 'No' left 126 alerts URL-keyed. 77 of them carry a recoverable
// number; the remaining 49 are NAFDAC notices that genuinely carry no alert
// number (e.g. 'Rwanda Recalls Ketoconazole Oral Tablets Over Safety Concerns')
// and must STAY keyed by URL.
//
// Both hazard_alerts and known_fakes are updated together, or the twin tables
// drift apart and matching silently loses half the row.
//
// Usage: node scripts/migrate_alert_numbers.js [--dry-run]
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');
const { alertNumberFromTitleOrUrl } = require('./nafdac_alert_parser');

const DRY = process.argv.includes('--dry-run');

function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(__dirname, '..', 'data', `nafdac_products.db.bak-${stamp}`);
  fs.copyFileSync(databasePath, dest);
  return dest;
}

function main() {
  const db = new DatabaseSync(databasePath);
  const rows = db.prepare(
    "select alert_number, product_name, source_url, alert_date from hazard_alerts where source_country='NG' and alert_number like 'http%'"
  ).all();

  const held = new Set(db.prepare("select alert_number from hazard_alerts").all().map((r) => r.alert_number));
  const fakeHeld = new Set(db.prepare("select alert_number from known_fakes").all().map((r) => r.alert_number));
  const plan = [];
  const skipped = [];
  const duplicated = [];
  const claimed = new Map();
  for (const r of rows) {
    const to = alertNumberFromTitleOrUrl(r.product_name, r.source_url, r.alert_date);
    if (!to) { skipped.push(`${r.product_name}  [no alert number published]`); continue; }
    if (held.has(to)) { skipped.push(`${r.product_name}  [number already held]`); continue; }
    if (fakeHeld.has(to)) { skipped.push(`${r.product_name}  [known_fakes already holds ${to}]`); continue; }
    // NAFDAC itself reused some numbers across two genuinely different alerts
    // (e.g. 0012/2018 covers both Australian macaroni and Metanor flupirtine).
    // Re-keying either would graft one product's hazard onto another, so both
    // rows stay keyed by URL.
    if (claimed.has(to)) {
      duplicated.push({ number: to, keep: claimed.get(to).product_name, skip: r.product_name });
      skipped.push(`${r.product_name}  [NAFDAC reused ${to} across two alerts]`);
      // undo the earlier claimant too - neither of the pair may be re-keyed
      const earlier = claimed.get(to);
      const idx = plan.findIndex((p) => p.from === earlier.alert_number);
      if (idx > -1) plan.splice(idx, 1);
      claimed.delete(to);
      continue;
    }
    claimed.set(to, r);
    plan.push({ from: r.alert_number, to });
  }

  console.log(`URL-keyed alerts:   ${rows.length}`);
  console.log(`will re-key:        ${plan.length}`);
  console.log(`left as URL-keyed:  ${skipped.length}`);
  console.log(`  - no number published:            ${skipped.filter((s) => s.includes('no alert number')).length}`);
  console.log(`  - number reused across 2 alerts:   ${duplicated.length * 2}`);
  console.log(`  - number already held elsewhere:  ${skipped.filter((s) => s.includes('already holds')).length}`);
  if (duplicated.length) {
    console.log('\nNAFDAC published these numbers twice, for different alerts:');
    for (const d of duplicated) {
      console.log(`  ${d.number}`);
      console.log(`      A: ${d.keep}`);
      console.log(`      B: ${d.skip}`);
    }
  }

  if (DRY) {
    console.log('\ndry run, nothing written');
    return;
  }

  const bak = backup();
  console.log(`\nbackup: ${path.relative(path.join(__dirname, '..'), bak)}`);

  const updHazard = db.prepare('UPDATE hazard_alerts SET alert_number = ? WHERE alert_number = ? AND source_country = ?');
  const updFake = db.prepare('UPDATE known_fakes SET alert_number = ? WHERE alert_number = ? AND source_country = ?');

  db.exec('BEGIN');
  try {
    let h = 0;
    let f = 0;
    for (const p of plan) {
      h += updHazard.run(p.to, p.from, 'NG').changes;
      f += updFake.run(p.to, p.from, 'NG').changes;
    }
    db.exec('COMMIT');
    console.log(`hazard_alerts rows updated: ${h}`);
    console.log(`known_fakes   rows updated: ${f}`);
    if (h !== f) console.log('\nWARNING: twin tables updated unevenly — investigate before shipping');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`rolled back: ${e.message}`);
    process.exit(1);
  }

  const stillUrl = db.prepare("select count(*) c from hazard_alerts where source_country='NG' and alert_number like 'http%'").get().c;
  const dupes = db.prepare(
    "select alert_number, count(*) c from hazard_alerts where source_country='NG' group by alert_number having c > 1"
  ).all();
  console.log(`\nURL-keyed alerts remaining: ${stillUrl} (expected ${skipped.length})`);
  console.log(`duplicate alert numbers:    ${dupes.length}`);
  db.close();
}

main();
