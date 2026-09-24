const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:3777';
const ASSETS = path.join(__dirname, '..', 'assets');

const files = fs.readdirSync(ASSETS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));

function toDataUrl(fp) {
  const ext = path.extname(fp).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch {}
    await sleep(250);
  }
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  console.log('config:', JSON.stringify(cfg));
  console.log('');

  try {
    for (const f of files) {
      const fp = path.join(ASSETS, f);
      const kb = Math.round(fs.statSync(fp).size / 1024);
      console.log(`======== ${f}  (${kb} KB) ========`);
      const t0 = Date.now();
      const r = await fetch(`${BASE}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: toDataUrl(fp) }),
      });
      const j = await r.json();
      console.log(`HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log('  raw model JSON :', j.raw !== undefined ? j.raw : JSON.stringify(j));
      console.log('  nafdac_number  :', JSON.stringify(j.nafdac_number));
      console.log('  product_name   :', JSON.stringify(j.product_name));
      console.log('  found          :', j.found);
      console.log('  format_valid   :', j.format_valid);
      console.log('  usable         :', j.usable);

      if (j.nafdac_number) {
        const vr = await (await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac: j.nafdac_number, product_name: j.product_name || 'x' })}`)).json();
        console.log(`  -> /verify with extracted reg: status=${vr.status} score=${vr.score ?? '-'}`);
      }
      console.log('');
    }
  } finally {
    server.kill();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
