// Harvest the product photographs that NAFDAC publishes on its own alert pages.
//
// These matter for a specific reason: they are the REGULATOR'S photographs OF the
// counterfeit/falsified product. They are the only reference images we can attribute
// to an authority without inventing anything. News photos of "seized goods" are a
// weaker tier - we do not know what is in the frame.
//
// Usage: node scripts/harvest_alert_photos.js [--download] [--out recon/photos]
// Writes: research/alert_photo_manifest.json
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

const args = process.argv.slice(2);
const DOWNLOAD = args.includes('--download');
const START = (() => { const i = args.indexOf('--start'); return i > -1 ? Number(args[i + 1]) : 0; })();
const MERGE = args.includes('--merge');
const OUT = (() => {
  const i = args.indexOf('--out');
  return i > -1 ? args[i + 1] : path.join(__dirname, '..', 'recon', 'photos');
})();

// Site furniture that lives in the same uploads folder as the product shots.
const CHROME = /(logo|header|footer|banner|icon|avatar|profile|menu|search|sidebar|comment|author|son[_-]?png|fccpc|ndlea|cac[_-]?logo|nrs|reportgov|small_|nafdac-logo|badge|button|placeholder|loading)/i;

async function imagesOn(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; vouch-research)' } });
  if (!res.ok) return { status: res.status, images: [] };
  const html = await res.text();
  const out = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!src) continue;
    let u = src[1];
    if (/^data:/.test(u)) continue;
    try { u = new URL(u, url).href; } catch { continue; }
    if (!/\/wp-content\/uploads\//.test(u)) continue;
    if (!/\.(svg|png|jpg|jpeg|gif|webp)(\?|$)/i.test(u)) continue;
    const file = u.split('/').pop().split('?')[0];
    if (CHROME.test(file)) continue;
    if (/\.(svg|gif)(\?|$)/i.test(u)) continue;
    const alt = (/\balt\s*=\s*["']([^"']*)["']/i.exec(tag) || [, ''])[1];
    const cls = (/\bclass\s*=\s*["']([^"']*)["']/i.exec(tag) || [, ''])[1];
    out.push({ url: u, file, alt, cls });
  }
  // de-dupe by URL
  const seen = new Set();
  return { status: res.status, images: out.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true))) };
}

async function main() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const rows = db.prepare(
    "select alert_number, product_name, hazard, alert_date, source_url from hazard_alerts where source_country='NG' order by alert_date desc"
  ).all().slice(START);

  if (DOWNLOAD) fs.mkdirSync(OUT, { recursive: true });

  const manifest = [];
  let withPhotos = 0;
  let fetched = 0;

  for (const row of rows) {
    let res;
    try {
      res = await imagesOn(row.source_url);
    } catch (e) {
      console.error(`${row.alert_number}\tERROR\t${e.message}`);
      continue;
    }
    fetched++;
    if (!res.images.length) continue;
    withPhotos++;

    const slugDir = row.alert_number.replace(/[^\w.-]+/g, '_');
    const saved = [];
    for (const img of res.images) {
      const local = path.join(OUT, `${slugDir}__${img.file}`);
      if (DOWNLOAD) {
        try {
          const r = await fetch(img.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; vouch-research)' } });
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            fs.writeFileSync(local, buf);
            img.local = path.relative(path.join(__dirname, '..'), local);
            img.kb = Math.round(buf.length / 1024);
          }
        } catch (e) {
          img.download_error = e.message;
        }
      }
      saved.push(img);
    }
    manifest.push({
      alert_number: row.alert_number,
      product_name: row.product_name,
      alert_date: row.alert_date,
      hazard: row.hazard,
      source_url: row.source_url,
      images: saved,
    });
    console.error(`[${fetched}/${rows.length}] ${row.alert_number} -> ${saved.length} photo(s) ${saved.map((s) => s.file).join(', ')}`);
  }

  const outPath = path.join(__dirname, '..', 'research', 'alert_photo_manifest.json');
  let final = manifest;
  if (MERGE && fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const byAlert = new Map(prev.map((m) => [m.alert_number, m]));
    for (const m of manifest) byAlert.set(m.alert_number, m);
    final = [...byAlert.values()];
  }
  fs.writeFileSync(outPath, JSON.stringify(final, null, 2));

  const total = manifest.reduce((n, m) => n + m.images.length, 0);
  console.log(`\nalerts fetched: ${fetched}/${rows.length}`);
  console.log(`alerts with at least one product photo: ${withPhotos}`);
  console.log(`total product photos found: ${total}`);
  if (DOWNLOAD) console.log(`downloaded to ${OUT}`);
  console.log(`manifest: ${outPath}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });