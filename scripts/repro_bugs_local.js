// Local reproduction of the query bugs exposed by the Greenbook debug-SQL leak.
// Nothing here touches greenbook.nafdac.gov.ng. Everything runs in a throwaway
// in-memory SQLite DB built to mirror the real `products` schema.

const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');

db.exec(`
  CREATE TABLE products (
    product_id     INTEGER PRIMARY KEY,
    NAFDAC         TEXT,
    product_name   TEXT,
    product_category_id INTEGER,
    approval_date  TEXT,
    status         TEXT,
    deleted_at     TEXT
  );
`);

const insert = db.prepare(
  'INSERT INTO products (product_id, NAFDAC, product_name, product_category_id, approval_date, status, deleted_at) VALUES (?,?,?,?,?,?,NULL)'
);

// A tiny fixture with the same category ids the real data uses: 1 (Drugs) and 12 (Disinfectants).
const fixture = [
  [1, '04-0001', 'drug one',          1,  '2023-01-15', 'Active'],
  [2, '04-0002', 'drug two',          1,  '2023-07-02', 'Active'],
  [3, '05-0001', 'a disinfectant',   12,  '2024-02-10', 'Active'],
  [4, '12-0001', 'another disinfectant', 12, '2024-11-30', 'Active'],
  [5, '06-0001', 'veterinary thing',  6,  '2023-12-31', 'Inactive'],
];
for (const r of fixture) insert.run(...r);

console.log('='.repeat(72));
console.log('FIXTURE  (ids chosen to match the real dataset: 1=Drugs, 6=Veterinary, 12=Disinfectants)');
console.log('='.repeat(72));
for (const r of db.prepare('SELECT product_id, NAFDAC, product_name, product_category_id FROM products').all()) {
  console.log(`  id=${r.product_id}  ${r.NAFDAC}  ${String(r.product_name).padEnd(22)} category_id=${r.product_category_id}`);
}

console.log('\n' + '='.repeat(72));
console.log('BUG 1 - category filter uses a SUBSTRING match on an INTEGER column');
console.log('='.repeat(72));
console.log('\n  What the site actually runs when you pick "Drugs" (id 1):');
console.log("    SELECT ... WHERE LOWER(products.product_category_id) LIKE '%%1%%'\n");

const buggy = db.prepare("SELECT product_id, NAFDAC, product_name, product_category_id FROM products WHERE LOWER(product_category_id) LIKE ? AND deleted_at IS NULL").all('%1%');
const correct = db.prepare('SELECT product_id, NAFDAC, product_name, product_category_id FROM products WHERE product_category_id = ? AND deleted_at IS NULL').all(1);

console.log('  BUGGY result (LIKE %1%):');
for (const r of buggy) console.log(`    id=${r.product_id} ${r.NAFDAC} ${r.product_name} (category ${r.product_category_id})`);
console.log('\n  CORRECT result (category_id = 1):');
for (const r of correct) console.log(`    id=${r.product_id} ${r.NAFDAC} ${r.product_name} (category ${r.product_category_id})`);

const wrong = buggy.filter((b) => !correct.some((c) => c.product_id === b.product_id));
console.log(`\n  >>> ${buggy.length - correct.length} row(s) wrongly included: ${wrong.map((w) => `${w.NAFDAC} ${w.product_name} (category ${w.product_category_id})`).join(', ') || 'none'}`);

console.log('\n  Why: id 12 contains the substring "1", so Disinfectants match "Drugs".');
console.log('  Also note LOWER() on an integer column is meaningless.');
console.log('  Selecting id 5 would also match 15, 25, 51, 52... if such ids existed.');

console.log('\n' + '='.repeat(72));
console.log('BUG 2 - date filter is a substring match, not a date filter');
console.log('='.repeat(72));
console.log('\n  What the site runs for the "Approval date" box:');
console.log("    SELECT ... WHERE LOWER(products.approval_date) LIKE '%%2023%%'\n");
const dates = db.prepare("SELECT product_id, NAFDAC, product_name, approval_date FROM products WHERE LOWER(approval_date) LIKE ?").all('%2023%');
console.log('  Searching approval date "2023" returns:');
for (const r of dates) console.log(`    ${r.NAFDAC} ${r.product_name} -> ${r.approval_date}`);
console.log('\n  A user searching a specific date like "2023-07" gets a partial match,');
console.log('  and "2023" silently means "anywhere in 2023" rather than a real filter.');

console.log('\n' + '='.repeat(72));
console.log('NOT A BUG - the reg-number search is safely parameterised');
console.log('='.repeat(72));
console.log('\n  The leaked SQL uses a bound parameter, not interpolation:');
const stmt = db.prepare('SELECT product_id, NAFDAC FROM products WHERE LOWER(NAFDAC) LIKE ? AND deleted_at IS NULL');
console.log("    query   : ... WHERE LOWER(products.NAFDAC) LIKE ?");
console.log('    binding : ["%%04-0001%%"]');
console.log('\n  A classic injection payload is just another string to the driver:');
const evil = stmt.all("%' OR 1=1 --%");
console.log(`    input   : %' OR 1=1 --%`);
console.log(`    rows returned: ${evil.length}  <- treated as a literal substring, NOT executed\n`);
console.log('  This is why the finding is information disclosure, not SQL injection.');

db.close();
