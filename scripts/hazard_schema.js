function ensureHazardTable(db) {
  // Curated NAFDAC public-alert records. Manually collected from
  // nafdac.gov.ng/recalls-and-alerts detail pages; not scraped.
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
}

module.exports = { ensureHazardTable };
