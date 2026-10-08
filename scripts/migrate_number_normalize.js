// Rewrite registration numbers into the canonical form that server.js now
// compares against.
//
// Why: Phase 0 makes /verify canonicalise whatever the user types before
// looking it up. That only helps if the STORED value is canonical too, or
// `04-1486` would stop matching the row currently stored as `04 – 1486`. So the
// stored side has to move with it.
//
// Scope, measured against the shipped database before writing anything:
//   - 17 of 12,212 products rows change
//   - 0 hazard_alerts rows change (all 11 numbered alerts already canonical)
//   - 0 known_fakes rows change
//   - reports are untouched: their numbers are SEED-* demo keys, not
//     registration numbers, and must not be rewritten
//
// Rows whose "number" is not a registration number are deliberately NOT
// rewritten. `Not available yet`, `NA`, `2 X 7` and the `4/1/NNNN` family are
// upstream junk or unverified numbers recorded as-is; canonicalising them into
// `NOTAVAILABLEYET` would turn a visible data-quality problem into a
// plausible-looking fake number. They are left alone and reported instead.
//
// Two rows collide when normalised (`04-1508` and `04 – 1508`; the Kenyan
// `H2016/CTD 2476/275/R1` pair). Both are the same product recorded twice, so the
// merge is correct — but the duplicate is reported rather than silently deleted.
//
// Usage:
//   node scripts/migrate_number_normalize.js --dry-run
//   node scripts/migrate_number_normalize.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');
const { normalizeNumber, describeRejection, isPlausibleRegistrationNumber } = require('./number_normalize');

const DRY = process.argv.includes('--dry-run');

function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(__dirname, '..', 'data', `nafdac_products.db.bak-${stamp}`);
  fs.copyFileSync(databasePath, dest);
  return dest;
}

function main() {
  const rows = new DatabaseSync(databasePath, { readOnly: true })
    .prepare("SELECT id, nafdac, product_name, country FROM products WHERE nafdac IS NOT NULL AND TRIM(nafdac) <> ''")
    .all();

  const rewrites = [];
  const untouchedJunk = [];

  for (const row of rows) {
    const from = String(row.nafdac).trim();
    const to = normalizeNumber(from);
    if (from === to) continue;
    // Validate against the family's own rule, not the NG one: a Kenyan row such
    // as `CTD 2718/R1` or `H2011/5719b/R1` is a real PPB number and must still be
    // canonicalised, or normalisation would skip exactly the rows that need it.
    const reason = isPlausibleRegistrationNumber(from, row.country) ? null : describeRejection(from) || 'wrong_shape';
    if (reason) {
      // Not a registration number in any printing. Leave the row exactly as it
      // is so the data-quality problem stays visible.
      untouchedJunk.push({ id: row.id, from, reason, product: row.product_name });
      continue;
    }
    rewrites.push({ id: row.id, from, to, product: row.product_name, country: row.country });
  }

  // Collisions must be computed over ALL rows, not only the ones being
  // rewritten — otherwise a change that lands on top of an already-canonical
  // row is invisible, which is exactly the case worth reporting.
  const byNormalized = new Map();
  for (const row of rows) {
    const key = normalizeNumber(row.nafdac);
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push({ id: row.id, from: String(row.nafdac).trim(), product: row.product_name, country: row.country });
  }
  const collisions = [...byNormalized.entries()].filter(
    ([, group]) => group.length > 1 && new Set(group.map((g) => g.from)).size > 1
  );

  console.log(`products rows scanned : ${rows.length}`);
  console.log(`would be rewritten    : ${rewrites.length}`);
  console.log(`left as-is (not a number): ${untouchedJunk.length}`);
  console.log(`collisions after normalising: ${collisions.length}`);
  for (const [key, group] of collisions) {
    const countries = [...new Set(group.map((g) => g.country))];
    console.log(`  ${key} <- ${group.map((g) => `${JSON.stringify(g.from)} (id ${g.id}, ${g.product})`).join(', ')}`);
    if (countries.length === 1) {
      // Same product recorded twice in the same country. Safe: /verify already
      // scores multiple rows for one number and prefers an Active one. Reported
      // rather than silently merged because the two rows are not identical.
      console.log(`     same country (${countries[0]}) - duplicate rows, no merge performed`);
    } else {
      // Different countries sharing a number would break country scoping, the
      // project's core integrity rule. Refuse rather than merge.
      throw new Error(`REFUSING: ${key} spans countries ${countries.join('/')} — merging would break source_country scoping`);
    }
  }
  if (untouchedJunk.length > 0) {
    console.log('left as-is:');
    for (const j of untouchedJunk) console.log(`  id ${j.id} ${JSON.stringify(j.from)} [${j.reason}] ${j.product}`);
  }

  if (DRY) {
    console.log('\n--dry-run: no changes written.');
    return;
  }
  if (rewrites.length === 0) {
    console.log('\nnothing to rewrite.');
    return;
  }

  const dest = backup();
  console.log(`\nbackup: ${dest}`);

  const db = new DatabaseSync(databasePath);
  db.exec('BEGIN');
  try {
    for (const r of rewrites) db.prepare('UPDATE products SET nafdac = ? WHERE id = ?').run(r.to, r.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const verify = new DatabaseSync(databasePath, { readOnly: true })
    .prepare("SELECT COUNT(*) AS c FROM products WHERE nafdac IS NOT NULL AND TRIM(nafdac) <> '' AND nafdac <> UPPER(REPLACE(REPLACE(nafdac, ' ', ''), '–', '-'))")
    .get();
  console.log(`rewritten: ${rewrites.length} (rows still non-canonical: ${verify.c})`);
}

main();
