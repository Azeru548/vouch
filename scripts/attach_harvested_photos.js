const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

// Attach the regulator photos harvested from alert pages to the known-fake
// library, so the hazard banner can show the actual pack NAFDAC photographed.
//
// These photos are NAFDAC's own images, read out of the alert page by
// `harvest_alert_photos.js` and recorded in `research/alert_photo_manifest.json`
// (alert -> image URL, filename, and local path). Nothing here is supplied by
// us or inferred.
//
// Two rules keep this honest and repeatable:
//   1. Only images whose local file actually exists are attached. 234 of the
//      476 published URLs now 404 (NAFDAC rotated older uploads) and are simply
//      not referenced — we do not substitute a lookalike for a missing photo.
//   2. Existing photos are never dropped. Curated pack photos already in
//      `known_fakes` come first; harvested ones are appended.
//   3. A harvested image that is byte-identical to a photo already held for that
//      alert reuses the existing file instead of being copied again — for some
//      alerts the curated photo and the harvested one are the same NAFDAC image.
//
// Idempotent: copies nothing that is already in place, and unions rather than
// overwrites. Writes `web/fakes/harvested_photos.json`, which `seed_fakes.js`
// reads, so a re-seed does not wipe these attachments.

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'research', 'alert_photo_manifest.json');
const FAKES_DIR = path.join(ROOT, 'web', 'fakes');
const MAP_PATH = path.join(FAKES_DIR, 'harvested_photos.json');
const DRY_RUN = process.argv.includes('--dry-run');

function slugOf(alertNumber) {
  return alertNumber.replace(/[^a-z0-9]+/gi, '-');
}

function hashOf(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(`missing ${MANIFEST} — run harvest_alert_photos.js first`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const db = new DatabaseSync(path.resolve(process.env.DATABASE_PATH || databasePath));

  const knownAlerts = new Set(db.prepare('SELECT alert_number FROM hazard_alerts').all().map((r) => r.alert_number));
  const rows = new Map(db.prepare('SELECT alert_number, photos_json FROM known_fakes').all().map((r) => [r.alert_number, r]));
  const update = db.prepare('UPDATE known_fakes SET photos_json = ? WHERE alert_number = ?');

  fs.mkdirSync(FAKES_DIR, { recursive: true });

  const map = {};
  let copied = 0;
  let attached = 0;
  let duplicates = 0;
  let missingOnDisk = 0;
  let unknownAlerts = 0;
  let noLibraryRow = 0;

  for (const alert of manifest) {
    const alertNumber = alert.alert_number;
    if (!knownAlerts.has(alertNumber)) {
      unknownAlerts++;
      console.warn(`warning: alert ${alertNumber} is in the photo manifest but not in hazard_alerts — skipped`);
      continue;
    }
    const row = rows.get(alertNumber);
    if (!row) {
      noLibraryRow++;
      continue;
    }

    let n = 0;
    const paths = [];
    const seen = new Set();
    // Photos already held for this alert, keyed by content, so a re-harvest of
    // the same NAFDAC image does not land on disk twice.
    const held = new Map();
    const slug = slugOf(alertNumber);
    for (const file of fs.existsSync(FAKES_DIR) ? fs.readdirSync(FAKES_DIR) : []) {
      if (!file.startsWith(slug + '-')) continue;
      const full = path.join(FAKES_DIR, file);
      if (fs.statSync(full).isFile()) held.set(hashOf(full), `/fakes/${file}`);
    }
    for (const image of alert.images || []) {
      const local = image.local && path.resolve(ROOT, image.local);
      if (!local || !fs.existsSync(local)) {
        missingOnDisk++;
        continue;
      }
      // One entry per published URL: the same image can appear twice on a page
      // at different sizes.
      if (seen.has(image.url)) continue;
      seen.add(image.url);

      const hash = hashOf(local);
      if (held.has(hash)) {
        duplicates++;
        paths.push(held.get(hash));
        continue;
      }
      n++;
      const ext = (local.match(/\.(jpe?g|png|webp|gif)$/i) || [])[1] || 'jpg';
      const name = `${slug}-h${n}.${ext.toLowerCase()}`;
      const dest = path.join(FAKES_DIR, name);
      if (!DRY_RUN && !fs.existsSync(dest)) {
        fs.copyFileSync(local, dest);
        copied++;
      }
      held.set(hash, `/fakes/${name}`);
      paths.push(`/fakes/${name}`);
    }
    if (paths.length === 0) continue;

    map[alertNumber] = paths;

    let current = [];
    try {
      const parsed = JSON.parse(row.photos_json || '[]');
      current = Array.isArray(parsed) ? parsed : [];
    } catch {
      current = [];
    }
    const merged = [...new Set([...current, ...paths])];
    if (merged.length !== current.length) {
      attached++;
      if (!DRY_RUN) update.run(JSON.stringify(merged), alertNumber);
    }
  }

  if (!DRY_RUN) {
    fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
  }

  console.log(
    JSON.stringify(
      {
        dry_run: DRY_RUN,
        alerts_with_photos: Object.keys(map).length,
        photos_attached: Object.values(map).reduce((n, p) => n + p.length, 0),
        files_copied: copied,
        duplicate_images_reused: duplicates,
        published_images_404: missingOnDisk,
        alerts_not_in_register: unknownAlerts,
        alerts_without_library_row: noLibraryRow,
        library_rows_updated: attached,
        map_file: path.relative(ROOT, MAP_PATH),
      },
      null,
      2
    )
  );
  db.close();
}

main();