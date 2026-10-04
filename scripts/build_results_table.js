// Build the per-product results table for the 117 transcribed list items.
//
// Every row is resolved from evidence we can point at:
//   - a numbered NAFDAC public alert in our database (number, date, source URL)
//   - a regulator-published product photograph we harvested
//   - a manual research note for the brands that have NO alert behind them
//
// Matching mirrors the app's own rules (token_set_ratio >= 85 plus the whole-word
// rule) so the table says the same thing the product would say, and a lone generic
// word like "rice" is not allowed to claim a match.
//
// Usage: node scripts/build_results_table.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const fuzz = require('fuzzball');
const { databasePath } = require('../config');

const ROOT = path.join(__dirname, '..');
const GENERIC_STOPWORDS = new Set([
  'tablet', 'tablets', 'capsule', 'capsules', 'injection', 'syrup', 'cream', 'ointment',
  'suspension', 'drops', 'powder', 'sachet', 'infusion', 'products', 'drinks', 'drink',
  'beverage', 'beverages', 'food', 'medicine', 'medicines', 'milk', 'oil', 'salt', 'soap',
  'water', 'rice', 'beans', 'spices', 'honey', 'meat', 'fish', 'seafood', 'poultry', 'flour',
]);

function norm(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Spellings drift between the screenshot, the note file and NAFDAC's own titles
// ("Relity"/"Reliance", "Powd"/"Powder"). Fold them before any lookup.
function canonical(s) {
  return norm(s)
    .replace(/\brelity\b/g, 'reliance')
    .replace(/\b(powd|powder)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The app's matcher, plus one extra guard the triage needs: a claim must rest on
// at least one distinctive token, so "Cap Rice" cannot claim a Bulmex rice alert.
function score(queryNorm, candidateNorm) {
  const fuzzy = fuzz.token_set_ratio(queryNorm, candidateNorm);
  if (fuzzy >= 85) return fuzzy;
  const words = queryNorm.split(' ').filter((w) => w.length >= 4 && !GENERIC_STOPWORDS.has(w) && !/^\d/.test(w));
  if (!words.length) return 0;
  const cand = new Set(candidateNorm.split(' '));
  return words.every((w) => cand.has(w)) ? 90 : 0;
}

function distinctive(tokens) {
  return tokens.filter((w) => w.length >= 4 && !GENERIC_STOPWORDS.has(w) && !/^\d/.test(w));
}

function main() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const alerts = db.prepare(
    "select alert_number, product_name, hazard, alert_date, source_url, batches from hazard_alerts where source_country='NG'"
  ).all().map((a) => ({ ...a, norm: norm(a.product_name) }));

  const manifest = new Map();
  for (const m of JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'alert_photo_manifest.json'), 'utf8'))) {
    manifest.set(m.alert_number, m);
  }

  const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'research_notes.json'), 'utf8'));
  const noteByName = new Map(Object.entries(notes).map(([k, v]) => [canonical(k), v]));

  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'viral_list_items.json'), 'utf8'));

  // The transcription produced a few near-duplicates from wrapped rows
  // ("...Powd" / "...Powder", "...Energy" / "...Energy Drink"). Fold them so the
  // table counts products, not lines on a screenshot.
  const merged = [];
  const byKey = new Map();
  for (const it of items) {
    const key = norm(it.claim_name)
      .replace(/\brelity\b/g, 'reliance')
      .replace(/\b(powd|powder|drink|drinks)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (byKey.has(key)) { byKey.get(key).variants.push(it.claim_name); continue; }
    byKey.set(key, { ...it, variants: [it.claim_name] });
    merged.push(byKey.get(key));
  }

  const rows = [];
  for (const it of merged) {
    const q = norm(it.variants[0]);
    // A note may be filed under any spelling the screenshot produced.
    const note = it.variants.map(canonical).map((v) => noteByName.get(v)).find(Boolean) || null;
    const qDist = distinctive(q.split(' '));

    let best = null;
    for (const a of alerts) {
      const aTokens = new Set(a.norm.split(' '));
      const covered = qDist.filter((w) => aTokens.has(w)).length;
      const coverage = qDist.length ? covered / qDist.length : 0;
      // A match needs a real distinctive-token agreement. Requiring 100% alone
      // is too strict (misses "Ginny Non-Dairy Creamer"), so accept either full
      // coverage or the app's own >=85 score with at least one distinctive token
      // shared. A lone generic word like "rice" can still never qualify.
      const s = score(q, a.norm);
      const ok = qDist.length > 0 && (coverage >= 0.999 || (s >= 85 && covered >= 1));
      if (!ok) continue;
      if (!best || s > best.score) best = { ...a, score: s };
    }

    const photos = best ? manifest.get(best.alert_number) : null;

    // A researched note beats a weak 90-point token overlap. Most such rows are
    // the Aba-raid brands, where "Peak Sachet Milk" would otherwise pair with the
    // unrelated 026/2023 Peak Milk alert purely on the word "Peak".
    const weakMatch = best && best.score < 95;
    const useNote = note && (!best || weakMatch);

    rows.push({
      item: it.variants.length > 1 ? it.variants[0] : it.claim_name,
      also_transcribed_as: it.variants.length > 1 ? it.variants.slice(1) : null,
      status: useNote ? note.status : (best ? 'alert' : (note ? note.status : 'no-evidence')),
      alert_number: useNote && note.status === 'alert' ? (best ? best.alert_number : null) : (best && !useNote ? best.alert_number : null),
      alert_title: best && !useNote ? best.product_name : (useNote && note.status === 'alert' ? best?.product_name ?? null : null),
      alert_date: best && !useNote ? best.alert_date : null,
      source_url: useNote ? (note.source || (best && best.source_url)) : (best && best.source_url),
      match_score: best && !useNote ? best.score : null,
      photos: photos ? photos.images.length : 0,
      photos_on_disk: photos ? photos.images.filter((i) => i.local).length : 0,
      note: note || null,
    });
  }

  rows.sort((a, b) => (b.match_score || 0) - (a.match_score || 0) || a.item.localeCompare(b.item));

  const byStatus = (s) => rows.filter((r) => r.status === s).length;
  console.log(`items: ${rows.length}`);
  console.log(`  backed by a numbered NAFDAC alert: ${byStatus('alert')}`);
  console.log(`  research note only:               ${byStatus('enforcement') + byStatus('law-enforcement') + byStatus('investigation') + byStatus('unconfirmed')}`);
  console.log(`  no evidence found:               ${byStatus('no-evidence')}`);
  console.log(`  items with regulator photos:     ${rows.filter((r) => r.photos > 0).length}`);

  fs.writeFileSync(path.join(ROOT, 'research', 'product_results.json'), JSON.stringify(rows, null, 2));

  // markdown table
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|');
  const lines = [];
  lines.push('# Per-product results — the 149-item viral list');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} from \`scripts/build_results_table.js\`. ${rows.length} products (the list has 149; items 119-149 were never recoverable and 2 screenshot lines were the same product spelled twice).`);
  lines.push('');
  lines.push('**Evidence column — what it actually means:**');
  lines.push('');
  lines.push('| Value | Meaning |');
  lines.push('|---|---|');
  lines.push('| `NAFDAC alert` | A numbered public alert backs this. Safe to show as an alert. |');
  lines.push('| `enforcement` | Real, NAFDAC-attributed, but from an enforcement action with no alert number. Never render as a batch verdict. |');
  lines.push('| `law-enforcement` | A drug-enforcement seizure (NDLEA), not a regulator finding that the product is falsified. |');
  lines.push('| `investigation` | Backed by a lab/journalistic investigation, not a numbered alert. |');
  lines.push('| `unconfirmed` | No evidence found. Do not assert. |');
  lines.push('| `—` | No product-level evidence; the list line is a bare category. |');
  lines.push('');
  lines.push('**Photos** = regulator-published photographs of the counterfeit, as `on disk / total`.');
  lines.push('');
  lines.push('| # | Product | Evidence | Alert | Date | Photos | Note |');
  lines.push('|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    const ev = r.status === 'alert' ? 'NAFDAC alert' : r.status === 'no-evidence' ? '—' : r.status;
    const alt = r.also_transcribed_as ? ` (also "${r.also_transcribed_as.join('", "')}")` : '';
    const num = r.alert_number ? `\`${esc(r.alert_number)}\`` : '—';
    lines.push(`| ${i + 1} | ${esc(r.item + alt)} | ${ev} | ${num} | ${esc(r.alert_date) || '—'} | ${r.photos ? `${r.photos_on_disk}/${r.photos}` : '—'} | ${esc(r.note ? r.note.text : '') || '—'} |`);
  });
  fs.writeFileSync(path.join(ROOT, 'research', 'product_results_table.md'), lines.join('\n'));
  console.log('\nwrote research/product_results_table.md and research/product_results.json');
}

main();