const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(require('path').join(__dirname, '..', 'data', 'nafdac_products.db'));

console.log('== the query the site runs when you pick "Drugs" (id 1) ==');
console.log("   WHERE LOWER(products.product_category_id) LIKE '%%1%%'\n");
console.log('The leaked SQL shows this is the real query used for the category filter.');
console.log('Category ids present in the data: 1, 2, 5, 6, 7, 12');
console.log('A LIKE %1% substring match also matches id 12.\n');

const names = { 1: 'Drugs', 2: 'Vaccines and Biologics', 5: 'Medical devices', 6: 'Veterinary', 7: 'Herbals and Nutraceuticals', 12: 'Disinfectants' };
const rows = db.prepare('SELECT category, COUNT(*) n FROM products GROUP BY category').all();
console.log('row counts by category in our snapshot:');
for (const r of rows) console.log(`  ${String(r.n).padStart(5)}  ${r.category}`);

const drugs = db.prepare("SELECT COUNT(*) n FROM products WHERE category = 'Drugs'").get().n;
const disinfect = db.prepare("SELECT COUNT(*) n FROM products WHERE category = 'Disinfectants'").get().n;
console.log(`\nIf "Drugs" (id 1) is filtered with LIKE '%1%':`);
console.log(`  returns ${drugs} Drugs rows PLUS ${disinfect} Disinfectants (id 12) rows = ${drugs + disinfect}`);
console.log(`  i.e. ${disinfect} unrelated products leak into the "Drugs" result set.`);

console.log('\nEarlier recon observed: picking "Drugs" -> recordsFiltered = 7480');
console.log(`Our snapshot total for Drugs only           = ${drugs}`);

console.log('\n\n== same pattern on the approval-date column ==');
const d2023 = db.prepare("SELECT COUNT(*) n FROM products WHERE LOWER(approval_date) LIKE '%2023%'").get().n;
console.log(`  searching approval date "2023" -> ${d2023} rows (substring, not a real date filter)`);

console.log('\n== reg-number search, same pattern ==');
const exact = db.prepare('SELECT COUNT(*) n FROM products WHERE nafdac = ?').get('04-0858').n;
console.log(`  '04-0858' exact match -> ${exact} row(s); LIKE %04-0858% would also catch any longer id containing it.`);

db.close();