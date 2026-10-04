// Pull the product photographs that NAFDAC publishes on its own alert pages.
// These are the regulator's photographs OF the counterfeit, which is the only
// kind of reference image we can attribute without inventing anything.
//
// Usage: node scripts/alert_images.js [alert_number ...]
//        node scripts/alert_images.js --list     (alerts in our DB with a nafdac.gov.ng source)
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');

function slugFor(url) {
  try { return new URL(url).pathname; } catch { return null; }
}

async function imagesOn(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; vouch-research)' } });
  if (!res.ok) return { status: res.status, images: [] };
  const html = await res.text();
  const images = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(tag);
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!src) continue;
    let u = src[1];
    if (/^data:/.test(u)) continue;                       // inline placeholder
    try { u = new URL(u, url).href; } catch { continue; }
    // NAFDAC themes upload product shots under /wp-content/uploads/
    if (!/\/wp-content\/uploads\//.test(u)) continue;
    if (/\.(svg|png|jpg|jpeg|gif|webp)(\?|$)/i.test(u)) {
      images.push({ url: u, alt: alt ? alt[1] : '', cls: cls ? cls[1] : '' });
    }
  }
  return { status: res.status, images };
}

async function main() {
  const args = process.argv.slice(2);
  const db = new DatabaseSync(databasePath, { readOnly: true });

  if (args[0] === '--list') {
    const rows = db.prepare(
      "select alert_number, product_name, source_url from hazard_alerts where source_country='NG' and source_url like '%nafdac.gov.ng%' order by alert_number desc"
    ).all();
    console.log(`alerts with a nafdac.gov.ng source: ${rows.length}`);
    for (const r of rows.slice(0, 40)) console.log(`  ${r.alert_number.padEnd(10)} ${r.product_name.slice(0, 60)}`);
    return;
  }

  const wanted = args.length
    ? db.prepare(
        `select alert_number, product_name, source_url from hazard_alerts
         where source_country='NG' and (alert_number = ? or product_name like ?)`
      ).all(args[0], `%${args[0]}%`)
    : db.prepare(
        "select alert_number, product_name, source_url from hazard_alerts where source_country='NG' and source_url like '%nafdac.gov.ng%' order by alert_number desc limit 12"
      ).all();

  for (const row of wanted) {
    const slug = slugFor(row.source_url);
    if (!slug) { console.log(`${row.alert_number}\tNO-SOURCE-URL\t${row.product_name}`); continue; }
    const { status, images } = await imagesOn(row.source_url);
    console.log(`${row.alert_number}\t${status}\t${images.length} img\t${row.product_name.slice(0, 50)}`);
    for (const i of images) console.log(`    ${i.url}   ${i.alt || i.cls || ''}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });