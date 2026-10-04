// Rebuild the alert photo manifest from the harvest logs, without re-crawling.
//
// The harvest runs printed one line per alert that yielded photos:
//   [12/405] 022/2026 -> 2 photo(s) Coglaet.png, Coglaet2.png
// Those lines are enough to reconstruct the manifest, and rebuilding from them
// costs no requests to nafdac.gov.ng (which rate-limits hard once you hammer it).
//
// Usage: node scripts/build_photo_manifest.js recon/harvest*.log
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

const logs = process.argv.slice(2);
if (!logs.length) { console.error('usage: node scripts/build_photo_manifest.js <log...>'); process.exit(1); }

const db = new DatabaseSync(databasePath, { readOnly: true });
const alerts = new Map(
  db.prepare("select alert_number, product_name, hazard, alert_date, source_url from hazard_alerts where source_country='NG'")
    .all().map((r) => [r.alert_number, r])
);

const PHOTO_DIR = path.join(__dirname, '..', 'recon', 'photos');
const onDisk = new Set(fs.existsSync(PHOTO_DIR) ? fs.readdirSync(PHOTO_DIR) : []);

const manifest = [];
const seen = new Set();

for (const log of logs) {
  if (!fs.existsSync(log)) { console.error(`skip (missing): ${log}`); continue; }
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    const m = line.match(/^\[\d+\/\d+\]\s+(\S+)\s+->\s+(\d+) photo\(s\)\s*(.*)$/);
    if (!m) continue;
    const [, alertNumber, , fileList] = m;
    if (seen.has(alertNumber)) continue;
    seen.add(alertNumber);
    const files = fileList.split(',').map((s) => s.trim()).filter(Boolean);
    const meta = alerts.get(alertNumber) || {};
    const slugDir = alertNumber.replace(/[^\w.-]+/g, '_');
    const images = files.map((file) => {
      const localName = `${slugDir}__${file}`;
      const img = { file, alt: '', cls: '', source_log: path.basename(log) };
      if (onDisk.has(localName)) {
        img.local = path.join('recon', 'photos', localName);
        img.kb = Math.round(fs.statSync(path.join(PHOTO_DIR, localName)).size / 1024);
      }
      return img;
    });
    manifest.push({
      alert_number: alertNumber,
      product_name: meta.product_name || '',
      alert_date: meta.alert_date || '',
      hazard: meta.hazard || '',
      source_url: meta.source_url || '',
      images,
    });
  }
}

manifest.sort((a, b) => String(b.alert_date).localeCompare(String(a.alert_date)));

const outPath = path.join(__dirname, '..', 'research', 'alert_photo_manifest.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

const total = manifest.reduce((n, m) => n + m.images.length, 0);
const haveLocal = manifest.reduce((n, m) => n + m.images.filter((i) => i.local).length, 0);
console.log(`alerts with product photos: ${manifest.length}`);
console.log(`product photos total:        ${total}`);
console.log(`downloaded to disk:          ${haveLocal}`);
console.log(`manifest: ${outPath}`);