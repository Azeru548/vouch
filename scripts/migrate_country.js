const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

function ensureCountryColumn(db) {
  const columns = db.prepare('PRAGMA table_info(products)').all();
  if (!columns.some((column) => column.name === 'country')) {
    db.exec("ALTER TABLE products ADD COLUMN country TEXT NOT NULL DEFAULT 'NG'");
  }
  db.exec("UPDATE products SET country = 'NG' WHERE country IS NULL OR TRIM(country) = ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_country_nafdac ON products (country, nafdac)');
}

if (require.main === module) {
  const db = new DatabaseSync(databasePath);
  ensureCountryColumn(db);
  const counts = db.prepare('SELECT country, COUNT(*) AS count FROM products GROUP BY country ORDER BY country').all();
  console.log(JSON.stringify(counts, null, 2));
  db.close();
}

module.exports = { ensureCountryColumn };
