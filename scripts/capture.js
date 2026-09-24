const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = __dirname;
const logLines = [];
let jsonCount = 0;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const record = (line) => {
    logLines.push(line);
    console.log(line);
  };

  page.on('request', (req) => {
    const p = req.url();
    if (p.startsWith('https://greenbook.nafdac.gov.ng') || p.includes('nafdac')) {
      let extra = '';
      const ph = req.postData();
      if (ph) extra = ' POSTDATA=' + ph;
      record(`[REQ] ${req.method()} ${p}${extra}`);
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith('https://greenbook.nafdac.gov.ng')) return;
    const ct = res.headers()['content-type'] || '';
    const status = res.status();
    const looksJson = ct.includes('application/json');
    record(`[RES] ${status} ${ct} ${url}`);
    if (looksJson || url === 'https://greenbook.nafdac.gov.ng/') {
      try {
        const body = await res.text();
        const isJson = body.trim().startsWith('{') || body.trim().startsWith('[');
        if (isJson) {
          jsonCount++;
          const name = `resp_json_${jsonCount}.json`;
          fs.writeFileSync(path.join(OUT, name), body);
          record(`[JSON] saved ${name} (${body.length} bytes). First 300 chars: ${body.slice(0, 300).replace(/\n/g, ' ')}`);
        }
      } catch (e) {
        record(`[ERR] reading body of ${url}: ${e.message}`);
      }
    }
  });

  // Phase A: just load the homepage, let DataTables fire its initial AJAX
  record('---- PHASE A: homepage load ----');
  await page.goto('https://greenbook.nafdac.gov.ng/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  // How many rows were rendered on first draw?
  const rowCount0 = await page.locator('.data-table tbody tr').count();
  record('initial tbody rows: ' + rowCount0);

  // Phase B: search by product name (simulates user typing in "Product Name" box)
  record('---- PHASE B: product-name search "paracetamol" ----');
  await page.fill('#search_product', 'paracetamol');
  await page.dispatchEvent('#search_product', 'keyup');
  await page.waitForTimeout(3000);
  const rowCount1 = await page.locator('.data-table tbody tr').count();
  record('paracetamol search tbody rows: ' + rowCount1);
  const firstRow1 = await page.locator('.data-table tbody tr').first().innerText().catch(() => 'n/a');
  record('first row text: ' + JSON.stringify(firstRow1).slice(0, 500));

  // Phase C: search by NAFDAC reg. no. (simulates user typing in "NAFDAC Reg. No." box)
  record('---- PHASE C: NRN search "04-" ----');
  await page.fill('#search_product', '');
  await page.dispatchEvent('#search_product', 'keyup');
  await page.fill('#search_nrn', '04-');
  await page.dispatchEvent('#search_nrn', 'keyup');
  await page.waitForTimeout(3000);
  const rowCount2 = await page.locator('.data-table tbody tr').count();
  record('NRN "04-" search tbody rows: ' + rowCount2);
  const firstRow2 = await page.locator('.data-table tbody tr').first().innerText().catch(() => 'n/a');
  record('first row text: ' + JSON.stringify(firstRow2).slice(0, 500));

  // Phase D: clear NRN, pick "Drugs" category
  record('---- PHASE D: category = Drugs ----');
  await page.fill('#search_nrn', '');
  await page.dispatchEvent('#search_nrn', 'keyup');
  await page.selectOption('#product_categtory', '1');
  await page.waitForTimeout(3000);
  const rowCount3 = await page.locator('.data-table tbody tr').count();
  record('Drugs category tbody rows: ' + rowCount3);

  await page.screenshot({ path: path.join(OUT, 'page_final.png'), fullPage: false });
  fs.writeFileSync(path.join(OUT, 'network_log.txt'), logLines.join('\n'));
  record('Total JSON responses captured: ' + jsonCount);
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});