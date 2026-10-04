// Build the working research list from the transcribed screenshots and annotate each
// item with what the local database already knows about it.
//
// Usage: node scripts/build_research_list.js [recon/lists/raw.txt]
// Output: recon/lists/items.json + a console summary
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const fuzzball = require('fuzzball');

const { databasePath } = require('../config');

const src = process.argv[2] || path.join(__dirname, '..', 'recon', 'lists', 'raw.txt');
const db = new DatabaseSync(databasePath);

// --- read + dedupe the transcription -----------------------------------------
const seen = new Map();
for (const raw of fs.readFileSync(src, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('===')) continue;
  const [nRaw, ...rest] = line.split('|');
  let name = rest.join('|').trim();
  const note = rest.length > 1 ? rest.slice(1).join('|').trim() : '';
  if (!name) continue;
  // the model sometimes appends UI text to the last visible row
  name = name.replace(/\.\s*Continue in co.*$/i, '').trim();
  if (!/[a-z]/i.test(name)) continue;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (seen.has(key)) continue;
  seen.set(key, {
    list_no: /^\d+$/.test(nRaw.trim()) ? Number(nRaw.trim()) : null,
    claim_name: name,
    claim_note: note,
  });
}

// --- what the local DB knows --------------------------------------------------
const alerts = db.prepare('select * from hazard_alerts where source_country = ?').all('NG');
const fakes = db.prepare('select * from known_fakes where source_country = ?').all('NG');
const products = db.prepare('select * from products').all();

function norm(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const fakeIndex = fakes.map((f) => ({
  alert_number: f.alert_number,
  product_name: f.product_name,
  brand: f.brand_name,
  aliases: f.aliases,
  photos: (() => { try { return JSON.parse(f.photos_json || '[]'); } catch { return []; } })(),
  norm: norm(f.product_name),
  normBrand: norm(f.brand_name),
  normAliases: norm(f.aliases),
}));
const alertIndex = alerts.map((a) => ({ alert_number: a.alert_number, product_name: a.product_name, norm: norm(a.product_name) }));

// 8,980 registry rows x 115 queries is far too much fuzzy work, so narrow the
// candidate set in SQL with the query's most distinctive token first.
const distinctTokens = (q) => q.split(' ').filter((w) => w.length >= 4 && !GENERIC_STOPWORDS.has(w));
function registryCandidates(q) {
  const toks = distinctTokens(q);
  if (!toks.length) return products;
  const hits = new Set();
  for (const t of toks.slice(0, 3)) {
    for (const p of db.prepare('select product_name from products where lower(product_name) like ?').all(`%${t}%`)) {
      hits.add(p.product_name);
    }
  }
  return [...hits].map((name) => ({ name, norm: norm(name) }));
}

// nameMatchScore mirrors server.js so triage reflects what the app would actually do.
const GENERIC_STOPWORDS = new Set(['tablet', 'tablets', 'capsule', 'capsules', 'injection', 'syrup', 'cream', 'ointment', 'suspension', 'drops', 'powder', ' Sachet'.trim(), 'infusion']);
function score(queryNorm, candNorm) {
  if (!queryNorm || !candNorm) return 0;
  if (queryNorm === candNorm) return 100;
  const words = queryNorm.split(' ').filter((w) => w.length >= 4 && !GENERIC_STOPWORDS.has(w) && !/^\d/.test(w));
  if (words.length && words.every((w) => candNorm.split(' ').includes(w))) return 90;
  return Math.max(fuzzball.partial_ratio(queryNorm, candNorm), fuzzball.token_sort_ratio(queryNorm, candNorm));
}

function bestMatch(q, list, normKey) {
  let best = null;
  for (const row of list) {
    const hay = normKey(row);
    const s = Math.max(score(q, hay), wordsHit(q, hay));
    if (!best || s > best.score) best = { ...row, score: s };
  }
  return best;
}
// brand + alias hits count too, mirroring hazardNamesFor() on the server
function wordsHit(q, hay) {
  const qw = q.split(' ').filter((w) => w.length >= 5);
  if (!qw.length) return 0;
  const hits = qw.filter((w) => hay.includes(w)).length;
  return hits / qw.length >= 0.99 ? 88 : 0;
}

const items = [...seen.values()].map((it) => {
  const q = norm(it.claim_name);
  const fk = bestMatch(q, fakeIndex, (r) => `${r.norm} ${r.normBrand} ${r.normAliases}`.trim());
  const al = bestMatch(q, alertIndex, (r) => r.norm);
  const pr = bestMatch(q, registryCandidates(q), (r) => r.norm);
  return {
    ...it,
    query_norm: q,
    local: {
      known_fake_hit: fk && fk.score >= 85 ? { alert_number: fk.alert_number, product_name: fk.product_name, score: Math.round(fk.score), photos: fk.photos.length } : null,
      alert_hit: al && al.score >= 85 ? { alert_number: al.alert_number, product_name: al.product_name, score: Math.round(al.score) } : null,
      in_registry: pr && pr.score >= 85 ? pr.name : null,
      nearest_registry: pr ? { name: pr.name, score: Math.round(pr.score) } : null,
    },
  };
});

const outPath = path.join(__dirname, '..', 'recon', 'lists', 'items.json');
fs.writeFileSync(outPath, JSON.stringify(items, null, 2));

// --- summary ------------------------------------------------------------------
const known = items.filter((i) => i.local.known_fake_hit).length;
const alerted = items.filter((i) => i.local.alert_hit).length;
const registered = items.filter((i) => i.local.in_registry).length;
const unknown = items.filter((i) => !i.local.known_fake_hit && !i.local.alert_hit).length;
console.log(`items: ${items.length}`);
console.log(`  already a known_fake: ${known}`);
console.log(`  already a hazard_alert: ${alerted}`);
console.log(`  in the NAFDAC registry: ${registered}`);
console.log(`  no local match (research needed): ${unknown}`);
console.log(`\nwrote ${outPath}`);