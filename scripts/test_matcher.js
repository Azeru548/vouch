// Regression tests for nameMatchScore, lifted from the real server.js so this
// exercises the shipped implementation rather than a copy of it.
//
// Two behaviours are guarded:
//  1. A shared class word plus a shared hazard word must not manufacture a hit.
//     "oral b counterfeit toothpaste" (86) used to claim the ORACIRE+ alert.
//  2. The cases the matcher exists for must keep working: brand<->generic
//     bridging, reordered names, noise words, and every alert matching itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fuzz = require('fuzzball');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Pull the three declarations nameMatchScore depends on out of server.js.
function grab(re, label) {
  const m = re.exec(src);
  assert.ok(m, `could not locate ${label} in server.js - update this test`);
  return m[0];
}
const code = [
  grab(/const GENERIC_STOPWORDS = new Set\(\[[\s\S]*?\]\);/, 'GENERIC_STOPWORDS'),
  grab(/const HAZARD_WORDS = new Set\(\[[\s\S]*?\]\);/, 'HAZARD_WORDS'),
  grab(/const LEADING_NOISE = new Set\(\[[^\]]*\]\);/, 'LEADING_NOISE'),
  grab(/function nameMatchScore\([\s\S]*?\n\}/, 'nameMatchScore'),
  'module.exports = { nameMatchScore };',
].join('\n');

const mod = { exports: {} };
new Function('fuzz', 'module', code)(fuzz, mod);
const { nameMatchScore } = mod.exports;

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const score = (q, c) => nameMatchScore(norm(q), norm(c));

let pass = 0;
let fail = 0;
function check(label, actual, predicate, detail = '') {
  const ok = predicate(actual);
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${label}  got ${actual}${detail ? '  ' + detail : ''}`); }
}

console.log('--- the false positive this guards ---');
check(
  '"oral b counterfeit toothpaste" must not claim the ORACIRE+ alert',
  score('oral b counterfeit toothpaste', 'ORACIRE+ Toothpaste (suspected counterfeit)'),
  (v) => v < 85,
);
check(
  '"Colgate counterfeit toothpaste" must still claim the Colgate alert',
  score('Colgate counterfeit toothpaste', 'Colgate Toothpaste (unregistered and suspected counterfeit)'),
  (v) => v >= 85,
);
check(
  '"Oral-B counterfeit toothpaste" must not claim the Colgate alert',
  score('Oral-B counterfeit toothpaste', 'Colgate Toothpaste (unregistered and suspected counterfeit)'),
  (v) => v < 85,
);

console.log('\n--- matches that must survive ---');
const mustMatch = [
  ['Augmentin 625mg', 'Alert on Counterfeit Augmentin 625mg Tablets (Batch No. AC3N) in Nigeria'],
  ['Peak Milk', 'Alert on Counterfeit Peak Milk in Circulation'],
  ['Noristerat Injection 200mg', 'Alert on the Sale of Counterfeit Noristerat Injection 200mg in Nigeria'],
  ['pantoprazole 40mg tablets', 'Panto-Denk Pantoprazole Sodium 40mg'],
  ['Sprite 50cl', 'Alert on Unwholesome Sprite 50cl Glass Bottle Batch number AZ6 22:32'],
  ['Cikatem', 'Cikatem Suspension 180/1080mg'],
  ['fake Tramadol 225mg', 'Alert on Counterfeit Tramadol 225mg Tablets'],
  ['the Avastin', 'Alert on Confirmed Counterfeit of Avastin 400mg/16ml'],
  ['OXYCONTIN 80mg', 'Alert on Falsified OXYCONTIN 80mg identified in the WHO European Region'],
  ['Cowbell Our Milk', 'Alert on the Circulation of Counterfeit Cowbell "Our Milk" Milk in Nigeria'],
];
for (const [q, c] of mustMatch) check(`"${q}" -> "${c.slice(0, 46)}…"`, score(q, c), (v) => v >= 85);

console.log('\n--- unrelated pairs must stay apart ---');
const mustNotMatch = [
  ['Tecentriq', 'Alert on Confirmed Counterfeit of Avastin 400mg/16ml'],
  ['Cap Rice', 'Niger Republic Imposes Import Ban on Bulmex Parboiled Rice from India'],
  ['BUA Rice', 'Niger Republic Imposes Import Ban on Bulmex Parboiled Rice from India'],
  ['Pantoprazole', 'Alert on Counterfeit Ampicillin Capsules 500mg'],
  // Coglaet is the counterfeit brand NAFDAC's 022/2026 page names; our alert is
  // titled "Colgate". NOT matching is the documented gap, not a regression -
  // this is asserted here so the gap stays visible rather than silently closing.
  ['Coglaet Herbal 100g', 'Colgate Toothpaste (unregistered and suspected counterfeit)'],
];
for (const [q, c] of mustNotMatch) check(`"${q}" vs "${c.slice(0, 46)}…"`, score(q, c), (v) => v < 85);

console.log('\n--- every alert in the database must still match itself ---');
const db = new DatabaseSync(databasePath, { readOnly: true });
const alerts = db.prepare("select alert_number, product_name from hazard_alerts where source_country='NG'").all();
let selfLost = [];
for (const a of alerts) {
  const q = norm(a.product_name);
  if (q && score(q, q) < 85) selfLost.push(a);
}
check(`self-match for all ${alerts.length} alerts`, selfLost.length, (v) => v === 0,
  selfLost.length ? selfLost.slice(0, 5).map((a) => `${a.alert_number}:${a.product_name.slice(0, 30)}`).join(' | ') : '');

console.log(`\n${pass} passing, ${fail} failing`);
process.exit(fail ? 1 : 0);
