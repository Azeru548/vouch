// Blast-radius check for a proposed nameMatchScore fix.
//
// The current rule lets a fuzzy score >= 85 short-circuit past the whole-word
// safety check. That is why "oral b counterfeit toothpaste" (86) claims the
// ORACIRE+ alert: the only real overlap is the class word "toothpaste" plus the
// hazard word "counterfeit", and the brand tokens ("oral", "b") do not appear in
// the alert at all.
//
// Candidate fix: a shopper types the BRAND first ("colgate counterfeit
// toothpaste", "peak milk powder"). If the first meaningful word of the query is
// absent from the candidate, the fuzzy shortcut cannot be trusted, so cap the
// score below the match threshold. Purely a cap - it can never raise a score.
//
// Usage: node scripts/matcher_impact.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const fuzz = require('fuzzball');
const { databasePath } = require('../config');

// --- the current implementation, lifted verbatim from server.js --------------
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stopwordsMatch = src.match(/const GENERIC_STOPWORDS = new Set\(\[([\s\S]*?)\]\);/);
const GENERIC_STOPWORDS = new Set(
  stopwordsMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
);

function current(queryNorm, candidateNorm) {
  const fuzzy = fuzz.token_set_ratio(queryNorm, candidateNorm);
  if (fuzzy >= 85) return fuzzy;
  const queryWords = queryNorm.split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC_STOPWORDS.has(word) && !/^\d/.test(word));
  if (queryWords.length === 0) return 0;
  const candidateWords = new Set(candidateNorm.split(/[^a-z0-9]+/));
  return queryWords.every((word) => candidateWords.has(word)) ? 90 : 0;
}

// --- the candidate fix -------------------------------------------------------
// Words that describe the ALERT rather than identify the PRODUCT. They must not
// be allowed to carry a match on their own.
const HAZARD_WORDS = new Set([
  'counterfeit', 'counterfeits', 'falsified', 'fake', 'substandard', 'unwholesome',
  'suspected', 'confirmed', 'illegal', 'unregistered', 'banned', 'recall', 'recalled',
  'alert', 'alerts', 'notice', 'presence', 'circulation', 'sale', 'distribution',
  'identified', 'detected', 'batch', 'batches', 'product', 'products', 'warning',
]);
// Function words a shopper may prepend; they tell us nothing about identity.
const LEADING_NOISE = new Set(['the', 'a', 'an', 'my', 'this', 'that', 'some', 'of', 'for', 'and', 'new']);

function proposed(queryNorm, candidateNorm) {
  const score = current(queryNorm, candidateNorm);
  if (score < 85) return score;
  const candWords = new Set(candidateNorm.split(/[^a-z0-9]+/));
  // first meaningful word of the query = the brand a shopper typed first
  const first = queryNorm.split(/[^a-z0-9]+/).find(
    (w) => w.length >= 2 && !HAZARD_WORDS.has(w) && !LEADING_NOISE.has(w)
  );
  if (!first) return score;
  if (candWords.has(first)) return score;
  // The typed brand simply is not in this alert. Do not let a shared class word
  // plus a shared hazard word manufacture a hit.
  return Math.min(score, 84);
}

// --- measure -----------------------------------------------------------------
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const db = new DatabaseSync(databasePath, { readOnly: true });
const alerts = db.prepare(
  "select alert_number, product_name from hazard_alerts where source_country='NG'"
).all();

const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'viral_list_items.json'), 'utf8'));

// (a) self-match: every alert must still find itself
let selfLost = 0;
const selfGaps = [];
for (const a of alerts) {
  const q = norm(a.product_name);
  if (!q) continue;
  if (current(q, q) >= 85 && proposed(q, q) < 85) { selfLost++; selfGaps.push(a); }
}

// (b) the specific defect
const defectBefore = current(norm('oral b counterfeit toothpaste'), norm('ORACIRE+ Toothpaste (suspected counterfeit)'));
const defectAfter = proposed(norm('oral b counterfeit toothpaste'), norm('ORACIRE+ Toothpaste (suspected counterfeit)'));

// (c) pairs that MUST keep matching
const mustKeep = [
  ['Colgate counterfeit toothpaste', 'Colgate Toothpaste (unregistered and suspected counterfeit)'],
  ['oral b counterfeit toothpaste', 'Colgate Toothpaste (unregistered and suspected counterfeit)'],
  ['Augmentin 625mg', 'Alert on Counterfeit Augmentin 625mg Tablets (Batch No. AC3N) in Nigeria'],
  ['Peak Milk', 'Alert on Counterfeit Peak Milk in Circulation'],
  ['Noristerat Injection 200mg', 'Alert on the Sale of Counterfeit Noristerat Injection 200mg in Nigeria'],
  ['pantoprazole 40mg tablets', 'Panto-Denk Pantoprazole Sodium 40mg'],
  ['Sprite 50cl', 'Alert on Unwholesome Sprite 50cl Glass Bottle Batch number AZ6 22:32'],
  ['Cikatem', 'Cikatem Suspension 180/1080mg'],
  ['fake Tramadol 225mg', 'Alert on Counterfeit Tramadol 225mg Tablets'],
  ['the Avastin', 'Alert on Confirmed Counterfeit of Avastin 400mg/16ml'],
  ['OXYCONTIN 80mg', 'Alert on Falsified OXYCONTIN 80mg identified in the WHO European Region'],
];

// (d) viral list: how many alert-backed items keep their match
const beforeList = new Map();
const afterList = new Map();
for (const it of list) {
  const q = norm(it.claim_name);
  if (!q) continue;
  let bb = 0;
  let ba = 0;
  for (const a of alerts) {
    bb = Math.max(bb, current(q, norm(a.product_name)));
    ba = Math.max(ba, proposed(q, norm(a.product_name)));
  }
  beforeList.set(it.claim_name, bb);
  afterList.set(it.claim_name, ba);
}
const changedList = [...beforeList.keys()].filter((k) => (beforeList.get(k) >= 85) !== (afterList.get(k) >= 85));

console.log('=== (a) self-match regressions (every alert must find itself) ===');
console.log(`  lost: ${selfLost} / ${alerts.length}`);
for (const a of selfGaps.slice(0, 10)) console.log(`    ${a.alert_number} ${a.product_name.slice(0, 60)}`);

console.log('\n=== (b) the defect ===');
console.log(`  "oral b counterfeit toothpaste" vs ORACIRE+ : ${defectBefore} -> ${defectAfter}  ${defectAfter < 85 ? 'FIXED' : 'STILL BROKEN'}`);

console.log('\n=== (c) pairs that must keep matching ===');
for (const [q, c] of mustKeep) {
  const b = current(norm(q), norm(c));
  const a = proposed(norm(q), norm(c));
  const mark = (b >= 85) === (a >= 85) ? 'same' : (a >= 85 ? 'GAINED' : 'LOST');
  console.log(`  ${mark.padEnd(6)} ${String(b).padStart(3)} -> ${String(a).padStart(3)}  ${q}`);
}

console.log('\n=== (d) viral list items that changed match status ===');
console.log(`  changed: ${changedList.length} / ${beforeList.size}`);
for (const k of changedList) console.log(`    ${beforeList.get(k)} -> ${afterList.get(k)}  ${k}`);
