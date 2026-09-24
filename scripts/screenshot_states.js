const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:3777';
const OUT = path.join(__dirname, '..', 'screenshots');

const cases = [
  ['verified', 'A11-0009', 'Alben Paracetamol Drops'],
  ['verified_inactive', '04-0858', '10% Dextrose (500/1000 mL)'],
  ['mismatch', 'A4-1205', 'Random Product XYZ'],
  ['not_found', '99-9999', 'Whatever'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch {}
    await sleep(250);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(OUT, '00-initial.png'), fullPage: true });

    for (const [name, nafdac, pname] of cases) {
      await page.fill('#in-nafdac', nafdac);
      await page.fill('#in-name', pname);
      await page.fill('#in-mfr', '');
      await page.click('#verify-form button[type=submit]');
      await page.waitForFunction(() => {
        const r = document.querySelector('#result .result');
        return r && !r.querySelector('.spinner');
      });
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      const cls = await page.getAttribute('#result .result', 'class');
      console.log(`${name.padEnd(18)} -> rendered .${cls.replace('result ', '')}`);
    }

    console.log(errors.length ? `JS ERRORS: ${errors.join(' | ')}` : 'no JS errors');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
