const { DatabaseSync } = require('node:sqlite');
const { databasePath: DB_PATH } = require('../config');

const BASE = 'https://greenbook.nafdac.gov.ng';
const DELAY_MS = 300;
const PER_PAGE = {};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

(async () => {
  const db = new DatabaseSync(DB_PATH);
  db.exec('CREATE TABLE IF NOT EXISTS manufacturers (id INTEGER PRIMARY KEY, name TEXT)');

  let page = 1;
  let parsedPages = 0;
  let totalParsed = 0;

  console.time('enrich');
  while (true) {
    const url = page === 1 ? `${BASE}/manufacturers` : `${BASE}/manufacturers?page=${page}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} page=${page}`);
    const html = await res.text();

    const cards = [...html.matchAll(/manufacturer\/products\/(\d+)"[\s\S]*?<h5>(.*?)<\/h5>/g)]
      .map((m) => [m[1], unescapeHtml(m[2])]);

    if (cards.length === 0) break;
    PER_PAGE[page] = cards.length;

    const stmt = db.prepare('INSERT OR REPLACE INTO manufacturers (id, name) VALUES (?, ?)');
    db.exec('BEGIN');
    for (const [id, name] of cards) stmt.run(Number(id), name);
    db.exec('COMMIT');

    totalParsed += cards.length;
    parsedPages++;
    console.log(`page=${page} manufacturers=${cards.length} last="${cards[cards.length - 1][1]}"`);
    page++;
    await sleep(DELAY_MS);
  }
  console.timeEnd('enrich');

  const mCount = db.prepare('SELECT COUNT(*) AS n FROM manufacturers').get().n;
  console.log(`\nparsed pages=${parsedPages} manufacturers in DB=${mCount}`);

  const distinctIds = db.prepare(
    'SELECT COUNT(DISTINCT manufacturer_id) AS n FROM products WHERE manufacturer_id IS NOT NULL'
  ).get().n;
  console.log(`distinct manufacturer_id referenced by products: ${distinctIds}`);

  const matched = db.prepare(
    'SELECT COUNT(*) AS n FROM products WHERE manufacturer_id IN (SELECT id FROM manufacturers)'
  ).get().n;
  const unmatched = db.prepare(
    'SELECT COUNT(*) AS n FROM products WHERE manufacturer_id IS NULL OR manufacturer_id NOT IN (SELECT id FROM manufacturers)'
  ).get().n;
  console.log(`products with matched manufacturer: ${matched}`);
  console.log(`products unmatched (null or no such manufacturer): ${unmatched}`);

  const orphans = db.prepare(`
    SELECT p.manufacturer_id, COUNT(*) AS c FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE m.id IS NULL GROUP BY p.manufacturer_id ORDER BY c DESC
  `).all();
  if (orphans.length) {
    console.log('orphan manufacturer_ids (no name found):');
    for (const o of orphans) console.log(`  ${o.manufacturer_id} x${o.c}`);
  }

  if (!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'manufacturer')) {
    db.exec('ALTER TABLE products ADD COLUMN manufacturer TEXT');
  }
  db.exec(`
    UPDATE products SET manufacturer =
      (SELECT name FROM manufacturers WHERE manufacturers.id = products.manufacturer_id)
  `);
  const withName = db.prepare(
    'SELECT COUNT(*) AS n FROM products WHERE manufacturer IS NOT NULL AND manufacturer != ""'
  ).get().n;
  console.log(`products now with manufacturer name: ${withName}`);

  const sample = db.prepare(
    'SELECT NAFDAC AS reg, manufacturer_id, manufacturer FROM products WHERE manufacturer_id = 5'
  ).all();
  console.log('sample (manufacturer_id=5):', JSON.stringify(sample[0]));

  console.log(`\nDB updated: ${DB_PATH}`);
  db.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});