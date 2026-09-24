const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');
const db = new DatabaseSync(databasePath);
console.log('active count:', db.prepare("SELECT COUNT(*) n FROM products WHERE status='Active'").get().n);
console.log('active paracetamol samples:', JSON.stringify(db.prepare("SELECT nafdac, product_name, manufacturer, status FROM products WHERE status='Active' AND product_name LIKE '%paracetamol%' LIMIT 3").all(), null, 1));
console.log('active dup regs (multi-row, good for tie test):', JSON.stringify(db.prepare("SELECT nafdac, COUNT(*) c FROM products WHERE status='Active' GROUP BY nafdac HAVING c>1 ORDER BY c DESC LIMIT 5").all()));
for (const row of db.prepare("SELECT p.nafdac, p.product_name, p.manufacturer, p.status FROM products p WHERE p.status='Active' AND p.nafdac IN (SELECT nafdac FROM products WHERE status='Active' GROUP BY nafdac HAVING COUNT(*)>1) LIMIT 6").all()) {
  console.log('  ', JSON.stringify(row));
}
db.close();