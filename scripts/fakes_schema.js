// Shared schema for the known-fake reference library.
//
// This is the name/appearance-keyed side of the threat picture. `hazard_alerts`
// is matched by NAFDAC number first (and by name only for rows with no number);
// `known_fakes` exists so a pack can be flagged when there is no registration
// number to check at all — which is the normal case for unregistered food,
// drinks and cosmetics.
const KNOWN_FAKE_CATEGORIES = ['drug', 'food', 'cosmetic', 'device', 'chemical', 'other'];

function ensureKnownFakesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS known_fakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_number TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL,
      nafdac_number TEXT,
      batches TEXT NOT NULL DEFAULT '[]',
      hazard TEXT NOT NULL,
      source_url TEXT NOT NULL,
      photos_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'drug',
      brand_name TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      appearance TEXT
    );
  `);

  // Earlier builds created this table without the library columns. Add them in
  // place so an existing snapshot keeps working.
  const columns = new Set(db.prepare('PRAGMA table_info(known_fakes)').all().map((column) => column.name));
  const addColumn = (name, declaration) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE known_fakes ADD COLUMN ${name} ${declaration}`);
  };
  addColumn('category', "TEXT NOT NULL DEFAULT 'drug'");
  addColumn('brand_name', 'TEXT');
  addColumn('aliases', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('appearance', 'TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_known_fakes_category ON known_fakes (category)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_known_fakes_name ON known_fakes (product_name COLLATE NOCASE)');
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

module.exports = { ensureKnownFakesTable, parseJsonArray, KNOWN_FAKE_CATEGORIES };
