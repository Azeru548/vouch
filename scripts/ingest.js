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

function ensureLiveSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
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
      status TEXT,
      manufacturer TEXT,
      country TEXT NOT NULL DEFAULT 'NG'
    );
    CREATE INDEX IF NOT EXISTS idx_products_nafdac ON products (nafdac);
    CREATE INDEX IF NOT EXISTS idx_products_country_nafdac ON products (country, nafdac);
    CREATE TABLE IF NOT EXISTS ingest_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      records_total INTEGER,
      rows_written INTEGER NOT NULL
    );
  `);
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!cols.includes('manufacturer')) db.exec('ALTER TABLE products ADD COLUMN manufacturer TEXT');
  if (!cols.includes('country')) db.exec("ALTER TABLE products ADD COLUMN country TEXT NOT NULL DEFAULT 'NG'");
  db.exec("UPDATE products SET country = 'NG' WHERE country IS NULL OR TRIM(country) = ''");
}

(async () => {
  const db = new DatabaseSync(DB_PATH);
  ensureLiveSchema(db);
  const before = db.prepare("SELECT COUNT(*) AS n FROM products WHERE country = 'NG'").get().n;
  console.log(`NG rows before refresh: ${before}`);

  db.exec('DROP TABLE IF EXISTS products_staging');
  db.exec(`
    CREATE TABLE products_staging (
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
  `);
  const insert = db.prepare(`
    INSERT INTO products_staging (nafdac, product_name, strength, form, route, applicant,
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

    db.exec('BEGIN');
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

  db.exec('BEGIN');
  db.prepare("DELETE FROM products WHERE country = 'NG'").run();
  db.exec(`
    INSERT INTO products (nafdac, product_name, strength, form, route, applicant,
                          manufacturer_id, category, approval_date, expiry_date, status,
                          manufacturer, country)
    SELECT nafdac, product_name, strength, form, route, applicant,
           manufacturer_id, category, approval_date, expiry_date, status,
           NULL, 'NG'
    FROM products_staging
  `);
  db.exec('DROP TABLE products_staging');
  const fetchedAt = new Date().toISOString();
  db.prepare('INSERT INTO ingest_meta (source, fetched_at, records_total, rows_written) VALUES (?, ?, ?, ?)')
    .run('greenbook', fetchedAt, recordsTotal, ingested);
  db.exec('COMMIT');

  const fromDb = db.prepare("SELECT COUNT(*) AS n FROM products WHERE country = 'NG'").get().n;
  console.log('\n==== SUMMARY ====');
  console.log(`recordsTotal reported : ${recordsTotal}`);
  console.log(`rows ingested         : ${ingested}`);
  console.log(`NG rows before        : ${before}`);
  console.log(`NG rows after         : ${fromDb}`);
  console.log(`net change            : ${fromDb - before}`);
  console.log(`fetched_at            : ${fetchedAt}`);
  if (ingested !== recordsTotal) {
    console.log('NOTE: discrepancy between recordsTotal and rows returned.');
  }

  const none = db.prepare("SELECT COUNT(*) AS n FROM products WHERE country = 'NG' AND (nafdac IS NULL OR nafdac = '')").get().n;
  console.log(`rows with empty/missing reg number: ${none}`);

  const dupes = db.prepare(`
    SELECT nafdac, COUNT(*) AS c, COUNT(DISTINCT product_name) AS distinct_names
    FROM products WHERE country = 'NG' GROUP BY nafdac HAVING c > 3 ORDER BY c DESC
  `).all();
  console.log(`reg numbers with >3 duplicate rows: ${dupes.length}`);
  const lines = [];
  for (const d of dupes) {
    const names = db.prepare(
      "SELECT DISTINCT product_name FROM products WHERE country = 'NG' AND nafdac = ? ORDER BY product_name LIMIT 5"
    ).all(d.nafdac).map((r) => r.product_name);
    const line = `${d.nafdac}\tcount=${d.c}\tdistinct_names=${d.distinct_names}\tproducts=${names.join(' | ')}`;
    lines.push(line);
    console.log('  ' + line);
  }
  fs.writeFileSync(DUPE_REPORT_PATH, lines.join('\n'));

  console.log(`\nDB written to: ${DB_PATH}`);
  console.log(`Duplicate report: ${DUPE_REPORT_PATH}`);
  db.close();
  if (ingested !== recordsTotal) process.exitCode = 1;
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
