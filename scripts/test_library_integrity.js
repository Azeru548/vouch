const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

// Integrity checks on the *shipped* library (data/nafdac_products.db), as
// opposed to the temp-database fixtures the other suites build.
//
// This guards the work of 2026-10-04: attaching the harvested regulator photos
// and correcting alert 022/2026 so the counterfeit toothpaste is findable by the
// name printed on the pack. Both are silent, easy-to-lose properties — a re-seed
// or a bad sync can drop them without any test failing otherwise.

// ---- 1. Every alert has a library row, both directions ----
const db = new DatabaseSync(path.resolve(process.env.DATABASE_PATH || databasePath));

const alertNumbers = db.prepare('SELECT DISTINCT alert_number FROM hazard_alerts').all().map((r) => r.alert_number);
const libraryNumbers = new Set(db.prepare('SELECT alert_number FROM known_fakes').all().map((r) => r.alert_number));

const missingFromLibrary = alertNumbers.filter((n) => !libraryNumbers.has(n));
assert.deepEqual(missingFromLibrary, [], `alerts with no known_fakes row: ${missingFromLibrary.join(', ')}`);

const alertSet = new Set(alertNumbers);
const orphans = [...libraryNumbers].filter((n) => !alertSet.has(n));
assert.deepEqual(orphans, [], `known_fakes rows with no alert: ${orphans.join(', ')}`);

// ---- 2. Every referenced photo exists on disk and is not empty ----
// A broken path renders as a missing image inside the hazard banner, which is
// worse than showing no photo at all.
const photoRows = db.prepare('SELECT alert_number, photos_json FROM known_fakes').all();
let photoCount = 0;
const broken = [];
for (const row of photoRows) {
  let photos = [];
  try {
    photos = JSON.parse(row.photos_json || '[]');
  } catch {
    broken.push(`${row.alert_number}: photos_json is not valid JSON`);
    continue;
  }
  assert.ok(Array.isArray(photos), `${row.alert_number}: photos_json is not an array`);
  for (const photo of photos) {
    photoCount++;
    const file = path.join(__dirname, '..', 'web', photo);
    if (!fs.existsSync(file)) broken.push(`${row.alert_number}: ${photo} missing`);
    else if (fs.statSync(file).size === 0) broken.push(`${row.alert_number}: ${photo} is empty`);
  }
}
assert.deepEqual(broken, [], `broken photo references:\n  ${broken.join('\n  ')}`);

// ---- 3. The harvested photos actually landed ----
// 234 of the 476 published URLs are permanently gone, so this asserts the
// count we can honestly hold, not a round number.
const withPhotos = photoRows.filter((r) => JSON.parse(r.photos_json || '[]').length > 0).length;
assert.ok(withPhotos >= 90, `expected regulator photos on at least 90 alerts, found ${withPhotos}`);
assert.ok(photoCount >= 240, `expected at least 240 photos on disk, found ${photoCount}`);

// ---- 4. A photo must not be attached twice under the same alert ----
const crypto = require('node:crypto');
for (const row of photoRows) {
  const photos = JSON.parse(row.photos_json || '[]');
  assert.equal(new Set(photos).size, photos.length, `${row.alert_number}: duplicate photo paths`);
  const byHash = new Map();
  for (const photo of photos) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'web', photo))).digest('hex');
    assert.ok(!byHash.has(hash), `${row.alert_number}: ${photo} is byte-identical to ${byHash.get(hash)}`);
    byHash.set(hash, photo);
  }
}

// ---- 5. Alert 022/2026 is findable by the name on the pack ----
// NAFDAC titles the alert "Colgate Toothpaste", but the packs it photographed
// are branded Coglaet. Without the corrected brand and aliases the alert exists
// yet a shopper reading "Coglaet" gets nothing.
const coglaet = db.prepare("SELECT brand_name, aliases FROM known_fakes WHERE alert_number = '022/2026'").get();
assert.ok(coglaet, 'alert 022/2026 has no known_fakes row');
assert.equal(coglaet.brand_name, 'Coglaet', '022/2026 brand_name should be the name on the pack');
const aliases = JSON.parse(coglaet.aliases || '[]');
for (const expected of ['Coglaet ActivGel 100g', 'Coglaet Herbal 100g', 'Colgate toothpaste']) {
  assert.ok(aliases.includes(expected), `022/2026 should be known as "${expected}"`);
}

// ---- 6. Enforcement actions carry their evidence, and invent nothing ----
// These rows exist because a raid is real evidence with no alert number. The
// two failure modes this guards: a row that claims an alert number NAFDAC never
// published, and a row with no source a reader could check.
const actions = db.prepare('SELECT * FROM enforcement_actions').all();
const surfaced = actions.filter((a) => a.finding_status === 'action_taken');
const withheld = actions.filter((a) => a.finding_status === 'not_a_finding');
assert.ok(surfaced.length >= 5, `expected at least 5 enforcement actions, found ${surfaced.length}`);
assert.ok(withheld.length >= 3, `expected the unsubstantiated names to be recorded, found ${withheld.length}`);

for (const action of actions) {
  assert.ok(action.source_url && action.source_publisher, `${action.action_key}: needs a source a reader can check`);
  // An enforcement action must not present itself as an alert. Citing a real
  // alert in a note is fine and often necessary (the Oral-B row explains itself
  // by pointing at 041/2026) — what is forbidden is the row's own identity or
  // summary claiming a number, because none was ever published for these.
  assert.ok(!/\d{2,4}\/\d{4}/.test(action.action_key), `${action.action_key}: key must not look like an alert number`);
  assert.ok(!/\balert\s*(no\.?|number)\b/i.test(action.summary), `${action.action_key}: summary must not claim to be an alert`);
  assert.ok(JSON.parse(action.brands).length > 0, `${action.action_key}: needs at least one brand`);
}

// A 'not_a_finding' row must never be reachable through the API or a result.
// Tamral/TramaKing are an NDLEA drug seizure, not a product-quality finding, and
// Oral-B is a naming confusion that would wrongly implicate a genuine brand.
const NDLEA_BRAND = 'tamral';
const anySurfaced = db
  .prepare("SELECT brands FROM enforcement_actions WHERE finding_status = 'action_taken'")
  .all()
  .flatMap((r) => JSON.parse(r.brands))
  .map((b) => b.toLowerCase());
for (const forbidden of [NDLEA_BRAND, 'tramaking', 'oral-b', 'reliance extra diclofenac 50mg']) {
  assert.ok(!anySurfaced.includes(forbidden), `"${forbidden}" is not a product-quality finding and must not be surfaced`);
}

console.log(
  `library integrity: ${alertNumbers.length} alerts, ${libraryNumbers.size} library rows, ` +
    `${withPhotos} alerts with regulator photos (${photoCount} photos), 022/2026 findable as Coglaet, ` +
    `${surfaced.length} enforcement actions (${withheld.length} unsubstantiated names withheld)`
);
db.close();