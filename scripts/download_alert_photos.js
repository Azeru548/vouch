// Download the product photos listed in the manifest, skipping files already on disk.
//
// nafdac.gov.ng rate-limits hard once you hammer it (the first harvest got cut off
// after ~250 files), so this paces itself, retries, and is safe to re-run.
//
// Usage: node scripts/download_alert_photos.js [--limit N] [--delay MS]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'research', 'alert_photo_manifest.json');
const PHOTO_DIR = path.join(ROOT, 'recon', 'photos');

const args = process.argv.slice(2);
const num = (flag, dflt) => { const i = args.indexOf(flag); return i > -1 ? Number(args[i + 1]) : dflt; };
const LIMIT = num('--limit', Infinity);
const DELAY = num('--delay', 700);
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function targetName(entry, img) {
  const slug = entry.alert_number.replace(/[^\w.-]+/g, '_');
  return `${slug}__${img.file}`;
}

async function tryFetch(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { ok: false, status: 'empty' };
  return { ok: true, bytes: buf.length, buf, finalUrl: res.url };
}

// NAFDAC has rotated a chunk of its older uploads, and the www host 404s where
// the bare host works. When both fail we fall back to the Wayback Machine, which
// is the only place those product shots still exist.
async function download(url, dest, tries = 2) {
  const bare = url.replace('https://www.nafdac.gov.ng', 'https://nafdac.gov.ng');
  const candidates = [bare, url];
  const attempted = new Set();

  for (const candidate of candidates) {
    if (attempted.has(candidate)) continue;
    attempted.add(candidate);
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const r = await tryFetch(candidate);
        if (r.ok) { fs.writeFileSync(dest, r.buf); return { ok: true, bytes: r.bytes, via: 'live' }; }
        if (r.status === 429 || r.status === 403) { await sleep(8000 * attempt); continue; }
        break; // a hard 404 will not fix itself
      } catch (e) {
        if (attempt === tries) break;
        await sleep(2000 * attempt);
      }
    }
  }

  const wayback = `https://web.archive.org/web/2024id_/${bare}`;
  try {
    const r = await tryFetch(wayback);
    if (r.ok) { fs.writeFileSync(dest, r.buf); return { ok: true, bytes: r.bytes, via: 'wayback' }; }
    return { ok: false, status: `404 live, archive ${r.status}` };
  } catch (e) {
    return { ok: false, status: `404 live, archive err ${e.message}` };
  }
}

async function main() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  const todo = [];
  for (const entry of manifest) {
    for (const img of entry.images) {
      const name = targetName(entry, img);
      const dest = path.join(PHOTO_DIR, name);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { img.local = path.join('recon', 'photos', name); img.kb = Math.round(fs.statSync(dest).size / 1024); continue; }
      todo.push({ entry, img, dest, name });
    }
  }

  const slice = todo.slice(0, LIMIT);
  console.log(`already on disk: ${manifest.reduce((n, e) => n + e.images.filter((i) => i.local).length, 0)}`);
  console.log(`to download:     ${todo.length} (this run: ${slice.length})`);

  let ok = 0;
  let bad = 0;
  for (let i = 0; i < slice.length; i++) {
    const { entry, img, dest, name } = slice[i];
    if (!img.url) {
      bad++;
      img.download_error = 'no source url in manifest';
      continue;
    }
    // prefer the bare host: the www form 404s where the bare host works
    const url = img.url.replace('https://www.nafdac.gov.ng', 'https://nafdac.gov.ng');
    const r = await download(url, dest);
    if (r.ok) {
      ok++;
      img.local = path.join('recon', 'photos', name);
      img.kb = Math.round(r.bytes / 1024);
      img.url = url;
      img.via = r.via;
    } else {
      bad++;
      img.download_error = r.status;
      img.url = url;
    }
    if ((i + 1) % 25 === 0 || i === slice.length - 1) {
      console.log(`  ${i + 1}/${slice.length}  ok=${ok} failed=${bad}`);
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2)); // checkpoint
    }
    // Wayback lookups are slow and rate-limited too; only pace when we go there.
    await sleep(DELAY);
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  const haveLocal = manifest.reduce((n, e) => n + e.images.filter((i) => i.local).length, 0);
  console.log(`\ndownloaded this run: ${ok}, failed: ${bad}`);
  console.log(`total on disk now:   ${haveLocal} / ${manifest.reduce((n, e) => n + e.images.length, 0)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });