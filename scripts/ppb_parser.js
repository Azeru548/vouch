// Pure parsing helpers for Kenya PPB (Pharmacy and Poisons Board) alert
// pages. No database, no network — tests run against the committed fixtures.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#8211;|&#x2013;/gi, '\u2013')
    .replace(/&#8212;|&#x2014;/gi, '\u2014')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;|&#0?34;/gi, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cellText(cell) {
  return decodeEntities(cell.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// '28/07/2026' → '2026-07-28' (PPB's day-first table format).
function parsePpbDate(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text).trim());
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// '18th September 2023' → '2023-09-28' (the safety-alerts listing format).
function parsePpbLongDate(text) {
  const m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(String(text).trim());
  if (!m) return null;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// The recall table's status column vocabulary.
function normalizeRecallStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s.startsWith('ongoing')) return 'ongoing';
  if (s.startsWith('concluded')) return 'concluded';
  return 'unspecified';
}

// The safety-alerts listing is date/title pairs wrapping /download/ links.
// Link text is the title; the nearest preceding date paragraph is its date.
function parseSafetyAlertsHtml(html) {
  const entries = [];
  const seen = new Set();
  const linkRe = /<a[^>]+href="(https:\/\/web\.pharmacyboardkenya\.org\/download\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(linkRe)) {
    const sourceUrl = m[1].replace(/&amp;/g, '&');
    if (seen.has(sourceUrl)) continue;
    const title = cellText(m[2]);
    if (!title || title.length < 10) continue;
    // The date sits in a <p> just before the link's paragraph.
    const before = html.slice(0, m.index);
    const dateMatch = /(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s+\d{4})<\/(?:span|p)>/g;
    let lastDate = null;
    for (const d of before.matchAll(dateMatch)) lastDate = d[1];
    seen.add(sourceUrl);
    entries.push({
      title,
      source_url: sourceUrl,
      alert_date: parsePpbLongDate(lastDate || ''),
      alert_type: 'safety_alert',
    });
  }
  return entries;
}

// One recall-table row → fields. The 9-column layout is stable across year
// pages: S/N, date, reference, product (linked), INN, batches, manufacturer,
// reason, status.
function parseRecallRow(rowHtml, year) {
  const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
  if (cells.length < 9) return null;
  const [sn, dateText, ref, productCell, inn, batchesText, manufacturer, reason, status] = cells;
  // Header rows repeat the column names in some year tables; a real data row
  // always carries a numeric S/N ("16", "12.").
  if (!/^\d{1,3}\.?$/.test(String(sn))) return null;
  const link = /<a[^>]+href="(https:\/\/web\.pharmacyboardkenya\.org\/[^"]+)"/.exec(rowHtml);
  const product_name = productCell || null;
  if (!product_name || /^(product name|category)/i.test(product_name)) return null;
  return {
    reference: ref || null,
    product_name,
    inn: inn || null,
    batches: batchesText
      ? batchesText.split(/,|;|\band\b/i).map((b) => b.replace(/\./g, '').trim()).filter(Boolean)
      : [],
    manufacturer: manufacturer || null,
    reason: reason || null,
    status: normalizeRecallStatus(status),
    date: parsePpbDate(dateText) || (year ? `${year}-01-01` : null),
    source_url: link ? link[1].replace(/&amp;/g, '&') : null,
    sn,
  };
}

// The whole year-page table → parsed rows.
function parseRecallTableHtml(html, { year } = {}) {
  const table = /<table[\s\S]*?<\/table>/i.exec(html);
  if (!table) return [];
  const body = table[0].replace(/<t(head|foot)>[\s\S]*?<\/t\1>/gi, '');
  const out = [];
  for (const m of body.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const parsed = parseRecallRow(m[0], year);
    if (parsed) out.push(parsed);
  }
  // A reference number can appear twice when the site re-renders; keep first.
  const seen = new Set();
  return out.filter((row) => {
    const key = row.reference || row.product_name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  parsePpbDate,
  parsePpbLongDate,
  normalizeRecallStatus,
  parseSafetyAlertsHtml,
  parseRecallRow,
  parseRecallTableHtml,
  MONTHS,
};
