function ensureReportsTable(db) {
  // Community reports live beside the registry snapshot.
  // Rows with is_seed = 1 are DEMO/SEED data only, not real user reports.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nafdac_number TEXT NOT NULL,
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
    );
  `);

  const columns = db.prepare('PRAGMA table_info(reports)').all().map((column) => column.name);
  if (!columns.includes('latitude')) db.exec('ALTER TABLE reports ADD COLUMN latitude REAL');
  if (!columns.includes('longitude')) db.exec('ALTER TABLE reports ADD COLUMN longitude REAL');
  if (!columns.includes('is_seed')) db.exec('ALTER TABLE reports ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_number_country_created ON reports (nafdac_number, country, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_session_created ON reports (session_id, created_at)');
}

module.exports = { ensureReportsTable };
