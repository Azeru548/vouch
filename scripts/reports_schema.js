// Community reports live beside the registry snapshot.
//
// A registration number is welcome but never required: food, drinks and
// cosmetics often carry none, and those are exactly the packs worth reporting.
// So `nafdac_number` is nullable and `product_name` carries the key we fall
// back to when grouping reports into a community warning.

const REPORTS_COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nafdac_number TEXT,
      product_name TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL CHECK (country IN ('NG', 'KE')) DEFAULT 'NG',
      location_area TEXT NOT NULL,
      note TEXT NOT NULL,
      photo_url TEXT,
      scan_result TEXT,
      latitude REAL,
      longitude REAL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_seed INTEGER NOT NULL DEFAULT 0 CHECK (is_seed IN (0, 1))
`;

function ensureReportsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reports (${REPORTS_COLUMNS});`);

  // Earlier builds created nafdac_number as NOT NULL. SQLite cannot relax a
  // constraint in place, so rebuild the table once, carrying every row over.
  const info = db.prepare('PRAGMA table_info(reports)').all();
  const numberColumn = info.find((column) => column.name === 'nafdac_number');
  const columns = new Set(info.map((column) => column.name));
  const hasProductName = columns.has('product_name');
  if (numberColumn && numberColumn.notnull === 1 && !hasProductName) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE reports RENAME TO reports_legacy');
      db.exec(`CREATE TABLE reports (${REPORTS_COLUMNS});`);
      db.exec(`
        INSERT INTO reports (id, nafdac_number, product_name, country, location_area, note, photo_url,
                             scan_result, latitude, longitude, session_id, created_at, is_seed)
        SELECT id, nafdac_number, '', country, location_area, note, photo_url,
               scan_result, latitude, longitude, session_id, created_at, is_seed
        FROM reports_legacy
      `);
      db.exec('DROP TABLE reports_legacy');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const current = new Set(db.prepare('PRAGMA table_info(reports)').all().map((column) => column.name));
  if (!current.has('latitude')) db.exec('ALTER TABLE reports ADD COLUMN latitude REAL');
  if (!current.has('longitude')) db.exec('ALTER TABLE reports ADD COLUMN longitude REAL');
  if (!current.has('is_seed')) db.exec('ALTER TABLE reports ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0');
  if (!current.has('product_name')) db.exec("ALTER TABLE reports ADD COLUMN product_name TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_number_country_created ON reports (nafdac_number, country, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_name_country_created ON reports (product_name COLLATE NOCASE, country, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_session_created ON reports (session_id, created_at)');
}

module.exports = { ensureReportsTable };
