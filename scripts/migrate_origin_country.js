const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

// The Kenya ingest stored the PPB listing's "origin" (country of manufacture)
// in `products.category`, because the snapshot predates the idea that category
// means product type. The NG rows use `category` correctly (product_category
// from the Greenbook), so a global rename would be wrong — only KE rows get
// moved, into an explicit `origin_country` column.
//
// Safe to re-run: the copy step is skipped once `origin_country` exists, and a
// final report shows what is left in each column.
const dbPath = process.env.DATABASE_PATH || databasePath;
const db = new DatabaseSync(dbPath);

const columns = new Set(db.prepare('PRAGMA table_info(products)').all().map((column) => column.name));
if (!columns.has('origin_country')) {
  db.exec('ALTER TABLE products ADD COLUMN origin_country TEXT');
}

// KE rows whose category holds an origin country and whose origin_country slot
// is still empty get copied across, then category is cleared.
const moved = db.prepare(`
  UPDATE products
  SET origin_country = category, category = NULL
  WHERE country = 'KE' AND category IS NOT NULL AND origin_country IS NULL
`).run();

const ke = db.prepare(`
  SELECT COUNT(*) AS n,
         SUM(category IS NOT NULL) AS with_category,
         SUM(origin_country IS NOT NULL) AS with_origin
  FROM products WHERE country = 'KE'
`).get();
const ng = db.prepare('SELECT COUNT(*) AS n FROM products WHERE country = ?').get('NG');

console.log(JSON.stringify({
  database: dbPath,
  rows_moved: moved.changes,
  kenya: ke,
  nigeria_rows: ng.n,
  note: 'KE category now holds product type (null from PPB listing); origin_country holds the manufacture country.',
}, null, 2));

db.close();
