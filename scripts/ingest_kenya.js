const { DatabaseSync } = require('node:sqlite');
const cheerio = require('cheerio');
const { databasePath } = require('../config');
const { ensureCountryColumn } = require('./migrate_country');

const PAGE_URL = 'https://products.pharmacyboardkenya.org/ppb_admin/pages/public_view_retention_products.php';
const AJAX_URL = 'https://products.pharmacyboardkenya.org/ppb_admin/xcrud/xcrud_ajax.php';
const LIMIT = 100;
const DELAY_MS = 300;
const ORDER_BY = 'tbl_vw_all_items_prims_gbt.product_registration_no';
const ORDER = 'asc';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function text($, element) {
  return $(element).text().replace(/\s+/g, ' ').trim();
}

function getInput($, name) {
  return $(`input[name="${name}"]`).attr('value') || '';
}

async function bootstrap() {
  const response = await fetch(PAGE_URL, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`Kenya page bootstrap failed: HTTP ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const state = {
    key: getInput($, 'key'),
    orderby: getInput($, 'orderby'),
    order: getInput($, 'order'),
    limit: getInput($, 'limit') || String(LIMIT),
    instance: getInput($, 'instance'),
    task: getInput($, 'task') || 'list',
  };
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ');

  if (!state.key || !state.instance || !cookie) {
    throw new Error('Kenya bootstrap did not provide a session cookie and XCRUD state');
  }
  return { cookie, state };
}

function buildPayload(session, start) {
  return new URLSearchParams({
    'xcrud[key]': session.state.key,
    'xcrud[orderby]': ORDER_BY,
    'xcrud[order]': ORDER,
    'xcrud[start]': String(start),
    'xcrud[limit]': String(LIMIT),
    'xcrud[instance]': session.state.instance,
    'xcrud[task]': session.state.task,
    'xcrud[column]': '',
    'xcrud[phrase]': '',
    'xcrud[search]': '',
  });
}

function updateSessionFromHtml(session, html) {
  const $ = cheerio.load(html);
  const key = getInput($, 'key');
  const instance = getInput($, 'instance');
  if (key) session.state.key = key;
  if (instance) session.state.instance = instance;
  const orderby = getInput($, 'orderby');
  const order = getInput($, 'order');
  const task = getInput($, 'task');
  if (orderby) session.state.orderby = orderby;
  if (order) session.state.order = order;
  if (task) session.state.task = task;
}

async function requestPage(session, start) {
  const response = await fetch(AJAX_URL, {
    method: 'POST',
    headers: {
      Accept: 'text/html, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Cookie: session.cookie,
      Origin: 'https://products.pharmacyboardkenya.org',
      Referer: PAGE_URL,
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: buildPayload(session, start),
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`Kenya XCRUD request failed: HTTP ${response.status}`);
  if (html.includes('verification key is out of date') || html.includes('xcrud-error')) {
    const error = new Error('Kenya XCRUD verification key expired');
    error.retryable = true;
    throw error;
  }
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  if (setCookies.length > 0) session.cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  updateSessionFromHtml(session, html);
  return html;
}

function parsePage(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('table.xcrud-list tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 11) return;
    rows.push({
      reg: text($, cells.eq(1)),
      name: text($, cells.eq(2)),
      active_ingredient: text($, cells.eq(3)),
      form: text($, cells.eq(4)),
      origin: text($, cells.eq(5)),
      local_foreign: text($, cells.eq(6)),
      manufacturer: text($, cells.eq(7)),
      applicant: text($, cells.eq(8)),
      approval_date: text($, cells.eq(9)),
      expiry_date: text($, cells.eq(10)),
    });
  });

  const starts = $('.pagination a')
    .map((_, link) => Number($(link).attr('data-start')))
    .get()
    .filter(Number.isFinite);
  const maxStart = starts.length > 0 ? Math.max(...starts) : 0;
  return { rows, maxStart };
}

function normalizeProductName(name) {
  return name.replace(/[#*$]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function mapRow(row) {
  return {
    nafdac: row.reg,
    product_name: normalizeProductName(row.name),
    strength: null,
    form: row.form || null,
    route: null,
    applicant: row.applicant || null,
    manufacturer_id: null,
    category: row.origin || null,
    approval_date: row.approval_date || null,
    expiry_date: row.expiry_date || null,
    status: 'Active',
    manufacturer: row.manufacturer || null,
    country: 'KE',
  };
}

(async () => {
  const startedAt = Date.now();
  const db = new DatabaseSync(databasePath);
  ensureCountryColumn(db);
  db.prepare('DELETE FROM products WHERE country = ?').run('KE');
  const insert = db.prepare(`
    INSERT INTO products (nafdac, product_name, strength, form, route, applicant,
                          manufacturer_id, category, approval_date, expiry_date, status,
                          manufacturer, country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let session = await bootstrap();
  let sessionRefreshes = 0;
  let pageCount = 0;
  let maxStart = 0;
  let targetMaxStart = null;
  let paginationDrift = 0;
  let expectedRows = null;
  let parsingIssues = [];
  let duplicateRows = 0;
  let lastPageRows = 0;
  const seenRows = new Set();

  for (let start = 0; ; start += LIMIT) {
    let html;
    try {
      html = await requestPage(session, start);
    } catch (error) {
      if (!error.retryable || sessionRefreshes >= 2) throw error;
      sessionRefreshes++;
      console.log(`session refresh ${sessionRefreshes} at start=${start}`);
      session = await bootstrap();
      html = await requestPage(session, start);
    }

    const page = parsePage(html);
    pageCount++;
    lastPageRows = page.rows.length;
    maxStart = Math.max(maxStart, page.maxStart);
    if (start === 0) {
      targetMaxStart = page.maxStart;
      expectedRows = targetMaxStart + LIMIT;
      console.log(`reported pagination: ${Math.floor(targetMaxStart / LIMIT) + 1} pages, expected at least ${expectedRows} rows`);
    } else if (page.maxStart !== targetMaxStart) {
      paginationDrift++;
    }
    if (page.rows.length === 0 && start > 0) throw new Error(`Kenya page ${pageCount} returned no rows at start=${start}`);

    db.exec('BEGIN');
    for (const row of page.rows) {
      if (!row.reg || !row.name) {
        parsingIssues.push({ start, row });
        continue;
      }
      const product = mapRow(row);
      const dedupeKey = [product.nafdac, product.product_name, product.manufacturer].join('\u0000');
      if (seenRows.has(dedupeKey)) duplicateRows++;
      seenRows.add(dedupeKey);
      insert.run(
        product.nafdac, product.product_name, product.strength, product.form, product.route,
        product.applicant, product.manufacturer_id, product.category, product.approval_date,
        product.expiry_date, product.status, product.manufacturer, product.country,
      );
    }
    db.exec('COMMIT');

    console.log(`page=${pageCount} start=${start} rows=${page.rows.length}`);

    if (targetMaxStart !== null && start >= targetMaxStart) break;
    if (page.rows.length < LIMIT) break;
    await sleep(DELAY_MS);
  }

  expectedRows = (targetMaxStart ?? maxStart) + lastPageRows;
  const rowsInDb = db.prepare("SELECT COUNT(*) AS count FROM products WHERE country = 'KE'").get().count;
  const missingRegistration = db.prepare("SELECT COUNT(*) AS count FROM products WHERE country = 'KE' AND (nafdac IS NULL OR TRIM(nafdac) = '')").get().count;
  const missingName = db.prepare("SELECT COUNT(*) AS count FROM products WHERE country = 'KE' AND (product_name IS NULL OR TRIM(product_name) = '')").get().count;
  const countries = db.prepare('SELECT country, COUNT(*) AS count FROM products GROUP BY country ORDER BY country').all();
  const sample = db.prepare("SELECT nafdac, product_name, manufacturer, country FROM products WHERE country = 'KE' ORDER BY id LIMIT 3").all();

  console.log(JSON.stringify({
    rows_ingested: rowsInDb,
    expected_rows: expectedRows,
    gap: expectedRows - rowsInDb,
    page_count: pageCount,
    session_refreshes: sessionRefreshes,
    pagination_drift: paginationDrift,
    duplicate_rows_skipped: duplicateRows,
    missing_registration: missingRegistration,
    missing_name: missingName,
    parsing_issues: parsingIssues.length,
    countries,
    sample,
    duration_ms: Date.now() - startedAt,
  }, null, 2));

  db.close();
  if (rowsInDb !== expectedRows || parsingIssues.length > 0 || missingRegistration > 0 || missingName > 0) {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
