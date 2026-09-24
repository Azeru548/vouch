const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');
const db = new DatabaseSync(databasePath);

const dirty = db.prepare("SELECT COUNT(*) n FROM products WHERE nafdac != TRIM(nafdac)").get().n;
console.log('rows needing trim (before):', dirty);
console.log('examples before:', JSON.stringify(db.prepare("SELECT '['||nafdac||']' AS v FROM products WHERE nafdac != TRIM(nafdac) LIMIT 5").all()));

const info = db.prepare("UPDATE products SET nafdac = TRIM(nafdac) WHERE nafdac != TRIM(nafdac)").run();
console.log('rows affected (changes):', info.changes);

const after = db.prepare("SELECT COUNT(*) n FROM products WHERE nafdac != TRIM(nafdac)").get().n;
console.log('rows needing trim (after):', after);
console.log('examples after:', JSON.stringify(db.prepare("SELECT '['||nafdac||']' AS v FROM products WHERE nafdac IN ('04-6868','B4-2899') LIMIT 5").all()));
console.log('total rows:', db.prepare('SELECT COUNT(*) n FROM products').get().n);
db.close();