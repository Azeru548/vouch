const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { databasePath } = require('../config');
const { ensurePendingTable } = require('./pending_schema');
const { ensureHazardTable } = require('./hazard_schema');
const { ensureKnownFakesTable } = require('./fakes_schema');

// Stage 3 of the freshness pipeline: human promotion.
//
// `npm run alerts:promote <pending-id> …` moves one pending alert into the
// curated tables, where it immediately participates in verification and shows
// as a register entry. Deliberately manual and one at a time: an unreviewed
// alert must never automatically affect verdicts.
//
// The core (`promotePending` / `dismissPending`) is exported so the server's
// admin endpoints share the exact same logic; the CLI is a thin wrapper.
//
// What promotion needs:
//   name       required — the pack people check
//   category   required for known_fakes: drug|food|cosmetic|device|chemical|other
//   hazard     defaults to the alert title
//   aliases    optional alias list for name matching
//   appearance optional look description
//   nafdac     optional, when the alert cites one
//   batches    optional batch list
//   brand      optional brand name
// Photos stay empty: they can only come from the official alert page, added by
// hand afterwards — we do not fabricate reference images.

const VALID_CATEGORIES = ['drug', 'food', 'cosmetic', 'device', 'chemical', 'other'];

class PromoteError extends Error {}

function requirePendingRow(db, id) {
  const row = db.prepare('SELECT * FROM pending_alerts WHERE id = ?').get(id);
  if (!row) throw new PromoteError(`No pending alert with id ${id}`);
  return row;
}

function dismissPending(db, id) {
  const row = requirePendingRow(db, id);
  db.prepare("UPDATE pending_alerts SET status = 'dismissed' WHERE id = ?").run(id);
  return { dismissed: row.source_url };
}

function promotePending(db, id, meta = {}) {
  const row = requirePendingRow(db, id);
  const name = String(meta.name || '').trim();
  const category = String(meta.category || '').trim();
  if (!name) throw new PromoteError('Promotion needs a product name.');
  if (!VALID_CATEGORIES.includes(category)) {
    throw new PromoteError(`--category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  const aliases = Array.isArray(meta.aliases) ? meta.aliases.map((s) => String(s).trim()).filter(Boolean) : [];
  const batches = Array.isArray(meta.batches) ? meta.batches.map((s) => String(s).trim()).filter(Boolean) : [];
  const hazard = String(meta.hazard || row.title).trim() || row.title;
  const alertNumber = row.alert_number || row.source_url;

  // Guard against NAFDAC re-posting an alert we already curate under a new URL
  // ("Updated Public Alert No. …"). Promoting that must not silently overwrite
  // the curated entry — the human should review the existing row instead.
  const existing = db.prepare('SELECT source_url FROM known_fakes WHERE alert_number = ?').get(alertNumber);
  if (existing && existing.source_url !== row.source_url) {
    throw new PromoteError(`Alert ${alertNumber} is already curated from a different source page (${existing.source_url}). Review the existing entry instead.`);
  }

  db.prepare('BEGIN').run();
  try {
    // hazard_alerts: one row per product. Rows without an alert number (old
    // pre-numbered notices) keep the URL as a unique identifier.
    db.prepare(`
      INSERT INTO hazard_alerts (alert_number, product_name, nafdac_number, batches, hazard, alert_type, manufacturer, source_url, alert_date, in_registry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT DO NOTHING
    `).run(
      alertNumber,
      name,
      meta.nafdac ? String(meta.nafdac).trim() : null,
      JSON.stringify(batches),
      hazard,
      row.alert_type || 'safety_alert',
      row.manufacturer || null,
      row.source_url,
      row.alert_date || new Date().toISOString().slice(0, 10),
    );

    db.prepare(`
      INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance)
      VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
      ON CONFLICT (alert_number) DO UPDATE SET
        product_name = excluded.product_name,
        hazard = excluded.hazard
    `).run(
      alertNumber,
      name,
      meta.nafdac ? String(meta.nafdac).trim() : null,
      JSON.stringify(batches),
      hazard,
      row.source_url,
      category,
      meta.brand ? String(meta.brand).trim() : null,
      JSON.stringify(aliases),
      meta.appearance ? String(meta.appearance).trim() : null,
    );

    // Promoted — no longer pending.
    db.prepare('DELETE FROM pending_alerts WHERE id = ?').run(id);
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }

  return {
    promoted: {
      id: Number(id),
      product: name,
      category,
      alert: row.alert_number,
      url: row.source_url,
    },
  };
}

// ---- CLI ----
const USAGE = `Usage:
  npm run alerts:promote -- <id> --name "Product name" --category drug [--hazard "..."] [--aliases "a,b"] [--appearance "..."] [--nafdac "A4-1234"] [--batches "B1,B2"] [--brand "Brand"]
  npm run alerts:promote -- --dismiss <id>
  npm run alerts:promote -- --show <id>`;

function parseArgs(argv) {
  const args = { flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dismiss' || a === '--show') { args[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
      continue;
    }
    args.id = a; // first bare argument is the pending id
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
  const db = new DatabaseSync(dbPath);
  ensurePendingTable(db);
  ensureHazardTable(db);
  ensureKnownFakesTable(db);

  if (args.show) {
    const row = db.prepare('SELECT * FROM pending_alerts WHERE id = ?').get(args.show);
    console.log(row ? JSON.stringify(row, null, 2) : `No pending alert with id ${args.show}`);
    db.close();
    return;
  }

  if (args.dismiss) {
    if (!args.id) { console.error(`${USAGE}`); process.exitCode = 1; db.close(); return; }
    try {
      console.log(JSON.stringify(dismissPending(db, args.id), null, 2));
    } catch (e) {
      console.error(`${e.message}\n${USAGE}`);
      process.exitCode = 1;
    }
    db.close();
    return;
  }

  if (!args.id) { console.error(`${USAGE}`); process.exitCode = 1; db.close(); return; }
  const f = args.flags;
  try {
    const result = promotePending(db, args.id, {
      name: f.name, category: f.category, hazard: f.hazard,
      aliases: f.aliases ? f.aliases.split(',') : [],
      batches: f.batches ? f.batches.split(',') : [],
      appearance: f.appearance, nafdac: f.nafdac, brand: f.brand,
    });
    result.note = 'Photos stay empty until official alert-page images are added by hand.';
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exitCode = 1;
  }
  db.close();
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
}

module.exports = { promotePending, dismissPending, PromoteError, VALID_CATEGORIES };
