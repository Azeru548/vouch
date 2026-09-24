const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const { databasePath: DB_PATH } = require('../config');

const BASE = 'https://greenbook.nafdac.gov.ng';
const LENGTH = 500;
const DELAY_MS = 300;
const DUPE_REPORT_PATH = path.join(__dirname, 'duplicate_report.txt');

const HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildParams(start, draw) {
  const q = new URLSearchParams({
    draw: String(draw),
    'columns[0][data]': 'product_name',
    'columns[0][name]': 'product_name',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'true',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    'order[0][column]': '0',
    'order[0][dir]': 'asc',
    start: String(start),
    length: String(LENGTH),
    'search[value]': '',
    'search[regex]': 'false',
    _: String(Date.now()),
  });
  return q.toString();
}

function normalizeProductName(name) {
  if (name == null) return '';
  return String(name)
    .replace(/[#*$]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(r) {
  return {
    nafdac: r.NAFDAC,
    product_name: normalizeProductName(r.product_name),
    strength: r.strength,
    form: (r.form && r.form.name) || null,
    route: (r.route && r.route.name) || null,
    applicant: (r.applicant && r.applicant.name) || null,
    manufacturer_id: r.manufacturer_id,
    category: (r.product_category && r.product_category.name) || null,
    approval_date: r.approval_date,
    expiry_date: r.expiry_date,
    status: r.status,
  };
}

(async () => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nafdac TEXT,
      product_name TEXT,
      strength TEXT,
      form TEXT,
      route TEXT,
      applicant TEXT,
      manufacturer_id TEXT,
      category TEXT,
      approval_date TEXT,
      expiry_date TEXT,
      status TEXT
    );
    CREATE INDEX idx_products_nafdac ON products (nafdac);
  `);

  const insert = db.prepare(`
    INSERT INTO products (nafdac, product_name, strength, form, route, applicant,
                          manufacturer_id, category, approval_date, expiry_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let recordsTotal = null;
  let start = 0;
  let draw = 1;
  let ingested = 0;

  console.time('ingest');
  while (true) {
    const url = `${BASE}/?${buildParams(start, draw)}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} at start=${start}`);
    const j = await res.json();

    if (recordsTotal === null) recordsTotal = j.recordsTotal;
    else if (j.recordsTotal !== recordsTotal) {
      console.warn(`WARN recordsTotal changed: ${recordsTotal} -> ${j.recordsTotal} (start=${start})`);
      recordsTotal = j.recordsTotal;
    }

    const txn = db.exec('BEGIN');
    for (const row of j.data) {
      const p = pick(row);
      insert.run(p.nafdac, p.product_name, p.strength, p.form, p.route, p.applicant,
                 p.manufacturer_id, p.category, p.approval_date, p.expiry_date, p.status);
      ingested++;
    }
    db.exec('COMMIT');

    const got = j.data.length;
    const lastRow = got > 0 ? j.data[got - 1].product_name : '-';
    console.log(`start=${start} got=${got} recordsFiltered=${j.recordsFiltered} last="${lastRow}"`);

    start += LENGTH;
    draw++;
    if (start >= recordsTotal) break;
    await sleep(DELAY_MS);
  }
  console.timeEnd('ingest');

  const fromDb = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  console.log('\n==== SUMMARY ====');
  console.log(`recordsTotal reported : ${recordsTotal}`);
  console.log(`rows ingested         : ${ingested}`);
  console.log(`rows in DB            : ${fromDb}`);
  console.log(`gap (recordsTotal - ingested): ${recordsTotal - ingested}`);
  if (ingested !== recordsTotal) {
    console.log('NOTE: discrepancy between recordsTotal and rows returned.');
  }

  const none = db.prepare("SELECT COUNT(*) AS n FROM products WHERE nafdac IS NULL OR nafdac = ''").get().n;
  console.log(`rows with empty/missing reg number: ${none}`);

  const dupes = db.prepare(`
    SELECT nafdac, COUNT(*) AS c, COUNT(DISTINCT product_name) AS distinct_names
    FROM products GROUP BY nafdac HAVING c > 3 ORDER BY c DESC
  `).all();
  console.log(`reg numbers with >3 duplicate rows: ${dupes.length}`);
  const lines = [];
  for (const d of dupes) {
    const names = db.prepare(
      'SELECT DISTINCT product_name FROM products WHERE nafdac = ? ORDER BY product_name LIMIT 5'
    ).all(d.nafdac).map((r) => r.product_name);
    const line = `${d.nafdac}\tcount=${d.c}\tdistinct_names=${d.distinct_names}\tproducts=${names.join(' | ')}`;
    lines.push(line);
    console.log('  ' + line);
  }
  fs.writeFileSync(DUPE_REPORT_PATH, lines.join('\n'));

  console.log(`\nDB written to: ${DB_PATH}`);
  console.log(`Duplicate report: ${DUPE_REPORT_PATH}`);
  db.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});