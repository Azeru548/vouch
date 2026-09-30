function ensureHazardTable(db) {
  // Curated and synced regulator alert records. The NAFDAC rows are collected
  // from nafdac.gov.ng detail pages (seed + alert sync); Kenya PPB rows come
  // from the PPB recalls/safety-alerts sync. `source_country` says which
  // regulator flagged the product — matching and every UI label key off it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hazard_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_number TEXT NOT NULL,
      product_name TEXT NOT NULL,
      nafdac_number TEXT,
      batches TEXT NOT NULL DEFAULT '[]',
      hazard TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      manufacturer TEXT,
      source_url TEXT NOT NULL,
      alert_date TEXT NOT NULL,
      in_registry INTEGER NOT NULL DEFAULT 0 CHECK (in_registry IN (0, 1))
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_hazards_nafdac ON hazard_alerts (nafdac_number)');

  // Rows written before the multi-country syncs existed are NAFDAC rows.
  const columns = new Set(db.prepare('PRAGMA table_info(hazard_alerts)').all().map((column) => column.name));
  if (!columns.has('source_country')) {
    db.exec("ALTER TABLE hazard_alerts ADD COLUMN source_country TEXT NOT NULL DEFAULT 'NG'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_hazards_country ON hazard_alerts (source_country)');
}

module.exports = { ensureHazardTable };
