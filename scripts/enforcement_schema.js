// Shared schema for enforcement actions: the enforcement/lab evidence that is
// real and regulator-attributed but is NOT a numbered public alert.
//
// Why this is separate from `hazard_alerts`: an alert is a numbered, published
// notice with a per-product finding ("batches X and Y of product Z are
// counterfeit"). An enforcement action is a raid or a destruction exercise — real
// NAFDAC action, but with no alert number and no per-product batch detail. The
// viral "fake products" lists that circulate in Nigeria are largely built from
// this second kind of evidence, so dropping it would leave the everyday brands
// shoppers actually worry about (Schweppes, Hollandia, Big Bull rice) unfindable.
//
// The distinction is kept in the schema rather than blurred in the UI, because
// the two carry very different weight:
//
//   finding_status = 'action_taken'    NAFDAC (or PPB) seized / destroyed goods.
//   finding_status = 'not_a_finding'   we looked and there is no regulator
//                                      finding to record — e.g. a law-enforcement
//                                      drug seizure that is not a product-quality
//                                      finding, or a viral claim we could not
//                                      substantiate.
//
// `not_a_finding` rows are never surfaced to users. They exist so the negative
// result is recorded once, with its source, instead of being re-researched (or
// quietly invented) later. See scripts/seed_enforcement.js.
//
// `action_key` is OUR identifier for the action ("aba-2024-12-15"), not an
// alert number. No row here may be given a number NAFDAC did not publish.

const ENFORCEMENT_FINDING_STATUSES = ['action_taken', 'not_a_finding'];

function ensureEnforcementTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enforcement_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_key TEXT NOT NULL UNIQUE,
      authority TEXT NOT NULL,
      action_date TEXT NOT NULL,
      location TEXT,
      evidence_class TEXT NOT NULL DEFAULT 'enforcement_action',
      summary TEXT NOT NULL,
      brands TEXT NOT NULL DEFAULT '[]',
      finding_status TEXT NOT NULL DEFAULT 'action_taken'
        CHECK (finding_status IN ('action_taken', 'not_a_finding')),
      evidence_note TEXT,
      source_url TEXT NOT NULL,
      source_publisher TEXT NOT NULL,
      source_country TEXT NOT NULL DEFAULT 'NG'
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_enforcement_status ON enforcement_actions (finding_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_enforcement_country ON enforcement_actions (source_country)');
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

module.exports = { ensureEnforcementTable, parseJsonArray, ENFORCEMENT_FINDING_STATUSES };