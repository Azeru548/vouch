// Schema for alerts the freshness sync discovered on NAFDAC's alerts index but
// which no human has reviewed yet. Nothing here affects verification: rows sit
// in `pending_alerts` until dismissed or promoted into `hazard_alerts` by hand.
//
// Lifecycle:
//   status 'new'       — seen on NAFDAC's feed, not yet reviewed
//   status 'dismissed' — a human looked and decided it is not a product threat
//                        (advisory notices, foreign regulators' routine recalls,
//                        infrastructural warnings). Kept so future syncs don't
//                        re-surface it.
//   Deleting the row after promotion is intentional: once an alert lives in
//   `hazard_alerts` it is no longer "pending", and the sync matches on
//   source_url to know that.
function ensurePendingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL UNIQUE,
      alert_number TEXT,
      alert_date TEXT,
      alert_type TEXT,
      product_type TEXT,
      manufacturer TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'dismissed')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_alerts (status)');
}

module.exports = { ensurePendingTable };
