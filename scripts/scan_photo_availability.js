// Fast availability scan: how many of the harvested photo URLs still resolve?
// Uses concurrent HEAD requests against the bare host, so it is quick.
//
// Usage: node scripts/scan_photo_availability.js
const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'research', 'alert_photo_manifest.json');
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36' };

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: UA, redirect: 'follow' });
    return res.status;
  } catch (e) {
    return `err:${e.message}`;
  }
}

async function pool(items, worker, size) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const todo = [];
  for (const entry of manifest) {
    for (const img of entry.images) {
      const name = `${entry.alert_number.replace(/[^\w.-]+/g, '_')}__${img.file}`;
      const dest = path.join(__dirname, '..', 'recon', 'photos', name);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
      if (!img.url) { todo.push({ name, url: null }); continue; }
      todo.push({ name, url: img.url.replace('https://www.nafdac.gov.ng', 'https://nafdac.gov.ng') });
    }
  }

  console.log(`scanning ${todo.length} missing images (8 concurrent)...`);
  const statuses = await pool(todo, (t) => (t.url ? head(t.url) : 'nourl'), 8);

  const counts = {};
  const dead = [];
  todo.forEach((t, i) => {
    const s = String(statuses[i]);
    counts[s] = (counts[s] || 0) + 1;
    if (s !== '200') dead.push({ ...t, status: s });
  });

  console.log('\nstatus breakdown:');
  for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(12)} ${n}`);
  }
  console.log(`\nalive: ${counts['200'] || 0}   dead: ${dead.length}`);
  fs.writeFileSync(path.join(__dirname, '..', 'recon', 'dead_photos.json'), JSON.stringify(dead, null, 2));
  console.log('dead list: recon/dead_photos.json');
}

main().catch((e) => { console.error(e.message); process.exit(1); });