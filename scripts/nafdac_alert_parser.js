// Pure parsing helpers for NAFDAC's Recalls and Safety Alerts index
// (https://nafdac.gov.ng/category/recalls-and-alerts/). No database, no
// network — everything here takes text in and returns data out, so tests run
// against the committed fixture.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8211;|&#x2013;/g, '\u2013')
    .replace(/&nbsp;/g, ' ');
}

function cellText(cell) {
  return decodeEntities(cell).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// '19-Aug-26' → '2026-08-19'. NAFDAC's two-digit year spans this century.
function parseAlertDate(text) {
  const m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = 2000 + Number(m[3]);
  return `${year}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

// 'Public Alert No. 043/2026-…' → '043/2026'. Tolerates 'No:' , 'No ', letter
// suffixes ('No. 030A/2025') and the missing leading zero NAFDAC sometimes
// drops ('Public Alert No.35/2025'). Numbers are padded to three digits, which
// is how the curated rows store them.
//
// The digit run must allow FOUR digits, not three: NAFDAC writes zero-padded
// four-digit numbers on older alerts ('No. 0037/2022', 'No:0048/2021'). A
// {1,3} bound can never match those, which silently pushed 126 alerts to be
// keyed by their source URL instead of an alert number.
//
// 'No' is also optional: older headlines drop it entirely ('Public Alert
// 003/2022', 'Public Alert 0011/2022').
function parseAlertNumber(title, fallbackYear) {
  const withNo = /(?:Alert|Notice)[^/]*?(?:No\.?\s*:?\s*)?(\d{1,4}[A-Z]?)\s*\/\s*(\d{4})/i;
  const m = withNo.exec(title);
  if (m) return `${m[1].toUpperCase().padStart(3, '0')}/${m[2]}`;

  // Some headlines carry the number but no year, e.g.
  // 'Public Alert No:0043 - Products Contaminated With Ethylene Glycol'.
  // The alert's own publication date supplies the year.
  if (fallbackYear && /^\d{4}$/.test(String(fallbackYear))) {
    const y = /(?:Alert|Notice)[^/]*?(?:No\.?\s*:?\s*)?(\d{1,4}[A-Z]?)\s*(?:[-–—:]|\s)(?!\d)/i.exec(title);
    if (y) return `${y[1].toUpperCase().padStart(3, '0')}/${fallbackYear}`;
  }
  return null;
}

function alertNumberFromTitleOrUrl(title, url, alertDate) {
  const year = alertDate ? String(alertDate).slice(0, 4) : null;
  const fromTitle = parseAlertNumber(title, year);
  if (fromTitle) return fromTitle;
  const slug = String(url).replace(/\/$/, '').split('/').pop() || '';
  const m = /(?:public-alert-no-?)(\d{1,4}[ab]?)-(\d{4})/i.exec(slug);
  if (m) return `${m[1].padStart(3, '0')}/${m[2]}`;
  if (year) {
    const s = /(?:public-alert-no-?)(\d{1,4}[ab]?)(?![-0-9])/i.exec(slug);
    if (s) return `${s[1].toUpperCase().padStart(3, '0')}/${year}`;
  }
  return null;
}

// The listing's product-type column mapped onto the known-fake library's
// category values. Anything unmapped lands on 'other'.
function deriveCategory(productType) {
  const t = String(productType || '').toLowerCase();
  if (t.includes('drug')) return 'drug';
  if (t.includes('food')) return 'food';
  if (t.includes('cosmetic')) return 'cosmetic';
  if (t.includes('chemical')) return 'chemical';
  if (t.includes('device')) return 'device';
  return 'other';
}

// 'Safety Alert' | 'Recall(s)' | 'Recall' | 'Blacklisting' → the lowercase
// token style the curated hazard_alerts rows use.
function normalizeAlertType(type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('recall')) return 'recall';
  if (t.startsWith('blacklist')) return 'blacklist';
  return 'safety_alert';
}

// 'Public Alert No. 043/2026-NAFDAC Places Products …' → 'NAFDAC Places
// Products …'. Falls back to the full title when there is no number prefix.
function productFromTitle(title) {
  const stripped = title
    .replace(/^.*?No\.?\s*:?\s*\d{1,3}[A-Z]?\s*\/\s*\d{4}\s*[-–—:]\s*/i, '')
    .replace(/^Updated\s+/i, '')
    .trim();
  return stripped || title;
}

// First <tr> … </tr> rows of the listing table whose first cell is a date.
// Rows live inside <tbody>; the header row's cells carry <th>, not dates.
function parseIndexHtml(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  for (const tr of html.matchAll(trRe)) {
    const cells = [...tr[1].matchAll(tdRe)].map((c) => cellText(c[1]));
    if (cells.length < 5) continue;
    if (!/^\d{1,2}-[A-Za-z]{3}-\d{2}$/.test(cells[0])) continue; // header/other tables
    const link = /<a[^>]+href="(https:\/\/nafdac\.gov\.ng\/[^"]+)"/.exec(tr[1]);
    if (!link) continue;
    const title = cells[1];
    if (!title) continue;
    rows.push({
      title,
      source_url: decodeEntities(link[1]),
      alert_date: parseAlertDate(cells[0]),
      alert_type: cells[2] || null,       // 'Safety Alert' | 'Recall' | 'Blacklisting'
      product_type: cells[3] || null,     // 'Drugs' | 'Food' | 'Cosmetics' | 'Regulated Products' | 'Chemicals'
      manufacturer: cells[4] || null,
    });
  }
  return rows;
}

module.exports = {
  parseIndexHtml,
  parseAlertDate,
  parseAlertNumber,
  alertNumberFromTitleOrUrl,
  deriveCategory,
  normalizeAlertType,
  productFromTitle,
};
