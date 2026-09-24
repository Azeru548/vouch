const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');
const db = new DatabaseSync(databasePath);

db.exec("UPDATE products SET manufacturer_id = CAST(CAST(manufacturer_id AS REAL) AS INTEGER) WHERE manufacturer_id LIKE '%.0'");

console.log('manufacturer_id types after fix:', db.prepare('SELECT DISTINCT typeof(manufacturer_id) FROM products LIMIT 5').all());
console.log('\'5\' sample:', JSON.stringify(db.prepare("SELECT NAFDAC AS reg, manufacturer_id, manufacturer FROM products WHERE manufacturer_id = 5 LIMIT 3").all()));
console.log('orphan check:', JSON.stringify(db.prepare('SELECT manufacturer_id, COUNT(*) c FROM products WHERE manufacturer_id NOT IN (SELECT id FROM manufacturers) GROUP BY manufacturer_id').all()));
console.log('total rows:', db.prepare('SELECT COUNT(*) n FROM products').get().n);
console.log('rows with manufacturer name:', db.prepare("SELECT COUNT(*) n FROM products WHERE manufacturer IS NOT NULL AND manufacturer != ''").get().n);
console.log('reg 04-0858 full record:', JSON.stringify(db.prepare("SELECT nafdac, product_name, strength, form, route, applicant, manufacturer, category, approval_date, expiry_date, status FROM products WHERE nafdac = '04-0858'").all()));
db.close();