const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const fuzz = require('fuzzball');
const fs = require('fs');
const path = require('path');
const { databasePath: DB_PATH, cachePath: CACHE_PATH, port: PORT, visionModel: VISION_MODEL } = require('./config');
const { ensureReportsTable } = require('./scripts/reports_schema');
const { ensureHazardTable } = require('./scripts/hazard_schema');
const { ensureKnownFakesTable, parseJsonArray } = require('./scripts/fakes_schema');
const { ensureEnforcementTable } = require('./scripts/enforcement_schema');
const { APPEARANCE_PROMPT, cleanAppearanceFields } = require('./scripts/fake_appearance');
const { runSync, fetchIndex, guardLiveSummary } = require('./scripts/alert_sync');
const { normalizeNumber, isPlausibleRegistrationNumber } = require('./scripts/number_normalize');
const { timingSafeEqual } = require('node:crypto');

const WEB_DIR = path.join(__dirname, 'web');
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const NAPAMS_URL = 'https://registration.nafdac.gov.ng/';

// Registration-number shape and normalisation live in scripts/number_normalize.js
// so the server, the ingesters, the migration and the tests all share one
// definition. The old inline pattern here was drug-only: it rejected the
// listed/herbal `A7-2363L` suffix series and every dash-and-space printing
// (`04 – 1486`, `04- 9502`) that NAFDAC rows in our own snapshot actually carry,
// and it accepted month fragments like `Aug`.

if (!fs.existsSync(DB_PATH)) {
  throw new Error(`Database not found at ${DB_PATH}. Run npm run ingest or set DATABASE_PATH.`);
}

// Gates the freshness-pipeline sync endpoint. Unset = it is disabled entirely;
// wrong key = 401.
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const db = new DatabaseSync(DB_PATH, { readOnly: true });
if (!db.prepare('PRAGMA table_info(products)').all().some((column) => column.name === 'country')) {
  throw new Error('Database schema is missing products.country. Run npm run migrate:country.');
}
const reportsDb = new DatabaseSync(DB_PATH);
ensureReportsTable(reportsDb);
ensureHazardTable(reportsDb);
ensureKnownFakesTable(reportsDb);
ensureEnforcementTable(reportsDb);
const cacheDb = new DatabaseSync(CACHE_PATH);
cacheDb.exec(`
  CREATE TABLE IF NOT EXISTS napams_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nafdac TEXT NOT NULL,
    product_name TEXT NOT NULL,
    manufacturer TEXT NOT NULL DEFAULT '',
    applicant TEXT,
    category TEXT,
    status TEXT NOT NULL CHECK (status IN ('Active', 'Inactive')),
    source TEXT NOT NULL DEFAULT 'napams_manual',
    checked_at TEXT NOT NULL,
    notes TEXT,
    country TEXT NOT NULL DEFAULT 'NG',
    UNIQUE (nafdac, product_name, manufacturer)
  );
`);
if (!cacheDb.prepare('PRAGMA table_info(napams_cache)').all().some((column) => column.name === 'country')) {
  cacheDb.exec("ALTER TABLE napams_cache ADD COLUMN country TEXT NOT NULL DEFAULT 'NG'");
}
cacheDb.exec('CREATE INDEX IF NOT EXISTS idx_napams_cache_country_nafdac ON napams_cache (country, nafdac)');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Permissions-Policy': 'camera=(self), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.json({ limit: '12mb' }));

// Vision photo sets: every image must be a data URL, and the set is bounded
// so one request cannot exhaust the vision service's context window.
const MAX_VISION_IMAGES = 4;

function collectImages(body) {
  const images = [];
  for (const candidate of [body?.images, body?.image]) {
    if (Array.isArray(candidate)) images.push(...candidate);
    else if (typeof candidate === 'string' && candidate) images.push(candidate);
  }
  return images;
}

function validateImages(images) {
  if (images.length === 0 || images.length > MAX_VISION_IMAGES) {
    return { error: 'bad_images', detail: `Expected 1 to ${MAX_VISION_IMAGES} images.` };
  }
  for (const image of images) {
    if (typeof image !== 'string' || !image.startsWith('data:image')) {
      return { error: 'bad_images', detail: 'Expected data:image/... base64 strings.' };
    }
  }
  return null;
}

function imageContent(images) {
  return images.map((image) => ({ type: 'image_url', image_url: { url: image } }));
}

// Groq's free tier caps vision input at ~7,000 tokens/minute and answers a photo
// set over that cap with 429. That is *busy*, not *broken*, and the old code
// reported it as a 502 "service is unavailable" — telling users the photo
// reader was down when all it needed was a few seconds' wait. Groq states the
// wait in the error text ("Please try again in 13.98s"), so pass it straight on.
function visionUpstreamError(upstream, body) {
  if (upstream.status === 429) {
    const hint = JSON.stringify(body || '').match(/try again in\s+([\d.]+)\s*s/i);
    const retryAfter = hint ? Math.ceil(Number(hint[1])) : 15;
    return { status: 429, code: 'vision_rate_limited', retryAfter, detail: 'Photo reading is busy. Try again in a few seconds.' };
  }
  return { status: 502, code: 'vision_upstream_error', detail: 'Photo reading service is unavailable.' };
}

app.post('/api/extract', async (req, res) => {
  if (!GROQ_KEY) {
    return res.status(503).json({ error: 'vision_not_configured', detail: 'Set GROQ_API_KEY on the server to enable photo extraction.' });
  }
  const images = collectImages(req.body || {});
  const invalid = validateImages(images);
  if (invalid) {
    return res.status(400).json(invalid);
  }

  const country = req.body?.country === 'KE' ? 'KE' : 'NG';
  // Kenya: PPB registration numbers look like H10737/CTD456/2016/R1 and often
  // sit on the outer carton, while batch numbers are printed on every blister
  // and label — for a Kenyan pack the batch is usually the readable number.
  const numberLine = country === 'KE'
    ? 'Find the PPB (Pharmacy and Poisons Board) registration number AND the batch number across ALL of the photos. '
    : 'Find the NAFDAC registration number across ALL of the photos. ';
  const batchLine = country === 'KE'
    ? '{"registration_number": string|null, "batch_number": string|null, "found": boolean}. '
    : '{"nafdac_number": string|null, "found": boolean}. ';
  const batchRule = country === 'KE'
    ? '- batch_number is the manufacturer\'s batch/lot code (often labelled BATCH, LOT, B.No or MFG). Copy it exactly as printed; set it to null only if no batch code is visible. '
    : '';

  const prompt =
    'These are photos of the SAME product packaging (the pack itself, then close-ups such as the registration panel). ' +
    numberLine +
    'Return ONLY a JSON object with exactly these keys: ' +
    batchLine +
    'Rules: ' +
    (country === 'KE'
      ? '- found is true only if at least one of the two numbers is visible. '
      : '- nafdac_number is REQUIRED. Set found=false and nafdac_number to null only if no NAFDAC number is visible in any photo. ') +
    '- Copy the number exactly as printed, including hyphens, slashes and any leading letters. ' +
    batchRule +
    '- Prefer the sharpest, most legible rendering when the same number appears more than once. ' +
    '- Do not return a product name.';

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }, ...imageContent(images)],
          },
        ],
      }),
    });

    const body = await upstream.json();
    if (!upstream.ok) {
      const err = visionUpstreamError(upstream, body);
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(err.status).json({ error: err.code, detail: err.detail, ...(err.retryAfter ? { retry_after_seconds: err.retryAfter } : {}) });
    }

    const raw = body?.choices?.[0]?.message?.content ?? '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    const candidates = [];
    if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(parsed)) {
        if (/nafdac|registration|nrn/i.test(key) && typeof parsed[key] === 'string') {
          candidates.push(parsed[key]);
        }
      }
      if (typeof parsed.nafdac_number === 'string') candidates.unshift(parsed.nafdac_number);
    }
    const shapeMatch = raw.match(/[A-Z0-9]{1,4}-\d{2,7}[A-Z]?/i);
    if (shapeMatch) candidates.push(shapeMatch[0]);

    // Canonicalise before validating, so a number printed with an en-dash or
    // internal spaces (`04 – 1486`) is not reported to the user as malformed.
    const nafdac_number = candidates.length > 0 ? normalizeNumber(candidates[0]) || null : null;
    const found = (parsed && parsed.found === true) || nafdac_number != null;
    const format_valid = nafdac_number != null && isPlausibleRegistrationNumber(nafdac_number, country);

    // Batch/lot codes: taken from the model's batch_number key when present,
    // otherwise a loose scan of the raw text for a "BATCH/LOT: X" label.
    let batch_number = null;
    if (parsed && typeof parsed.batch_number === 'string' && parsed.batch_number.trim()) {
      batch_number = parsed.batch_number.trim().toUpperCase();
    } else {
      const batchMatch = raw.match(/\b(?:BATCH|LOT|B\.?NO)\b[.:= ]+([A-Z0-9][A-Z0-9-]{2,20})/i);
      if (batchMatch) batch_number = batchMatch[1].toUpperCase();
    }

    res.json({
      nafdac_number,
      found,
      format_valid,
      ...(country === 'KE' ? { batch_number } : {}),
      // The number alone is enough to proceed; the user always types the product name.
      usable: found && format_valid,
    });
  } catch (err) {
    res.status(502).json({ error: 'vision_request_failed', detail: 'Photo reading timed out or could not be reached.' });
  }
});

// Describes how a pack looks, so it can be compared against the known-fake
// library. Deliberately a separate endpoint from /api/extract: that prompt was
// narrowed to the NAFDAC number alone because asking for more made the model
// misread numbers. Never merge the two prompts.
app.post('/api/describe', async (req, res) => {
  if (!GROQ_KEY) {
    return res.status(503).json({ error: 'vision_not_configured', detail: 'Set GROQ_API_KEY on the server to enable pack description.' });
  }
  const images = collectImages(req.body || {});
  const invalid = validateImages(images);
  if (invalid) {
    return res.status(400).json(invalid);
  }

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 220,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: APPEARANCE_PROMPT }, ...imageContent(images)],
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const err = visionUpstreamError(upstream, null);
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(err.status).json({ error: err.code, detail: err.retryAfter ? 'Photo reading is busy. Try again in a few seconds.' : 'Pack description service is unavailable.', ...(err.retryAfter ? { retry_after_seconds: err.retryAfter } : {}) });
    }

    const body = await upstream.json();
    const raw = body?.choices?.[0]?.message?.content ?? '';
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    const fields = cleanAppearanceFields(parsed);
    if (!fields.appearance) {
      return res.status(502).json({ error: 'describe_failed', detail: 'The pack could not be described from this photo.' });
    }
    res.json(fields);
  } catch {
    res.status(502).json({ error: 'vision_request_failed', detail: 'Pack description timed out or could not be reached.' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    vision_enabled: Boolean(GROQ_KEY),
    vision_model: VISION_MODEL,
    appearance_enabled: Boolean(GROQ_KEY),
    napams_url: NAPAMS_URL,
    local_cache_enabled: true,
  });
});

const REPORT_RATE_LIMIT = 5;
const REPORT_RATE_WINDOW_MS = 60 * 60 * 1000;
const COMMUNITY_FLAG_THRESHOLD = 3;
const COMMUNITY_FLAG_WINDOW_DAYS = 30;
// Reports are community safety signals, not a photo archive. A downscaled
// attachment is enough to show "this is the pack I saw"; keeping full-size
// imagery indefinitely turns the reports table into a surveillance liability.
const REPORT_PHOTO_MAX_BYTES = 900000;
const REPORT_RETENTION_DAYS = 180;
const GEO_PRECISION = 3; // ~110 m at the equator; a market, not a doorway

function roundCoordinate(value) {
  const factor = 10 ** GEO_PRECISION;
  return Math.round(Number(value) * factor) / factor;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const AUTHORITY_NAMES = { NG: 'NAFDAC', KE: 'Pharmacy and Poisons Board (PPB)' };

// Batch codes are compared as upper-case alphanumerics: printed batch
// strings pick up dashes, spaces and OCR noise that mean nothing.
function normalizeBatch(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// The alerts' batch column is a JSON array, but PPB tables sometimes run
// several codes inside one element ("WL25024 WL25025"), so each element is
// split on whitespace too. De-duplicated: one printed code, one comparison.
function parseBatchList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.flatMap((item) => String(item).split(/\s+/)).map(normalizeBatch).filter(Boolean))];
  } catch {
    return [];
  }
}

// The batch tier decides how strongly a matched alert applies to the pack in
// the shopper's hand:
//   batch_matched    — the entered batch is on the alert's list. Near-definitive.
//   batch_not_listed — the alert is batch-specific and this batch is not on it.
//                      Bounded reassurance, never a green light: a counterfeiter
//                      can print any batch they like.
//   product_level    — no batch entered, or the alert lists no batches (e.g.
//                      "all batches" recalls). The alert applies product-wide.
function batchTierFor(batchesJson, batch) {
  const norm = batch ? normalizeBatch(batch) : null;
  const rowBatches = parseBatchList(batchesJson);
  if (!norm || rowBatches.length === 0) return 'product_level';
  return rowBatches.includes(norm) ? 'batch_matched' : 'batch_not_listed';
}

function toHazard(row, batchTier = 'product_level') {
  let batches = [];
  try {
    const parsed = JSON.parse(row.batches || '[]');
    if (Array.isArray(parsed)) batches = parsed.map(String);
  } catch {}
  let photos = [];
  try {
    const fake = reportsDb.prepare('SELECT photos_json FROM known_fakes WHERE alert_number = ?').get(row.alert_number);
    const parsed = JSON.parse(fake?.photos_json || '[]');
    if (Array.isArray(parsed)) photos = parsed.filter((p) => typeof p === 'string');
  } catch {}
  return {
    alert_number: row.alert_number,
    hazard: row.hazard,
    alert_type: row.alert_type,
    source_url: row.source_url,
    alert_date: row.alert_date,
    batches,
    batch_tier: batchTier,
    photos,
    source_country: row.source_country || 'NG',
    authority: AUTHORITY_NAMES[row.source_country || 'NG'] || 'NAFDAC',
  };
}

// Batch refines how a matched alert applies, but never widens matching: the
// alert is found by number or name exactly as before. A batch on its own
// matches nothing — short codes like "6289" collide across unrelated products.
function hazardMatch(nafdacNumber, normalizedName, country = 'NG', batch = null) {
  const numbered = reportsDb.prepare(
    'SELECT alert_number, hazard, alert_type, source_url, alert_date, batches, source_country FROM hazard_alerts WHERE nafdac_number = ? COLLATE NOCASE AND source_country = ? LIMIT 1'
  ).get(nafdacNumber, country);
  if (numbered) return toHazard(numbered, batchTierFor(numbered.batches, batch));
  if (!normalizedName) return undefined;
  const unnamed = reportsDb.prepare(
    'SELECT alert_number, product_name, hazard, alert_type, source_url, alert_date, batches, source_country FROM hazard_alerts WHERE nafdac_number IS NULL AND source_country = ?'
  ).all(country);
  const TIER_RANK = { batch_matched: 2, product_level: 1, batch_not_listed: 0 };
  let best = null;
  for (const row of unnamed) {
    // Best score across every name the alert is known by — brand string AND
    // generic/INN names — so a recall is findable either way a shopper types it.
    let score = 0;
    for (const name of hazardNamesFor(row.alert_number, row.product_name)) {
      score = Math.max(score, nameMatchScore(normalizedName, name));
    }
    if (score < 85) continue;
    const tier = batchTierFor(row.batches, batch);
    if (!best || TIER_RANK[tier] > TIER_RANK[best.tier] || (TIER_RANK[tier] === TIER_RANK[best.tier] && score > best.score)) {
      best = { row, score, tier };
    }
  }
  return best ? toHazard(best.row, best.tier) : undefined;
}

// Groups recent reports about the same pack and warns once enough people agree.
//
// A report is keyed by registration number when one was entered. Without a
// number — food, drinks and cosmetics — the product name is the only key there
// is, so it is compared with the same fuzzy 85 bar the rest of the app uses.
// The name comparison is only a grouping heuristic for a warning count; it
// never contributes to a verification verdict.
const COMMUNITY_NAME_SCORE = 85;

function communityFlag(nafdacNumber, productName, country) {
  const cutoff = new Date(Date.now() - COMMUNITY_FLAG_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = reportsDb.prepare(`
    SELECT nafdac_number, product_name, location_area
    FROM reports
    WHERE country = ? AND created_at >= ?
    ORDER BY created_at DESC
  `).all(country, cutoff);

  const number = String(nafdacNumber || '').trim().toLowerCase();
  const name = number ? '' : normalizeProductName(productName);
  const matches = rows.filter((row) => {
    if (number) return String(row.nafdac_number || '').toLowerCase() === number;
    if (!name) return false;
    const rowName = normalizeProductName(row.product_name);
    return rowName !== '' && fuzz.token_set_ratio(name, rowName) >= COMMUNITY_NAME_SCORE;
  });

  if (matches.length < COMMUNITY_FLAG_THRESHOLD) return undefined;
  return {
    flagged: true,
    report_count: matches.length,
    reported_on: number ? 'registration_number' : 'product_name',
    recent_locations: [...new Set(matches.map((row) => row.location_area))].slice(0, 5),
  };
}

app.post('/report', (req, res) => {
  // The registration number is optional: the pack people most need to report
  // may not have one at all. The product name is what we always require.
  const nafdacNumber = String(req.body?.nafdac_number || '').trim();
  const productName = String(req.body?.product_name || '').trim();
  const country = String(req.body?.country || '').trim().toUpperCase();
  const locationArea = String(req.body?.location_area || '').trim();
  const note = String(req.body?.note || '').trim();
  const photo = req.body?.photo;
  const latitude = req.body?.latitude ?? null;
  const longitude = req.body?.longitude ?? null;
  const sessionId = String(req.body?.session_id || '').trim();
  const scanResult = req.body?.scan_result;

  if (!productName || !['NG', 'KE'].includes(country) || !locationArea || !note || !sessionId || !isPlainObject(scanResult)) {
    return res.status(400).json({ error: 'product_name, country, location_area, note, session_id, and scan_result are required' });
  }
  if (nafdacNumber.length > 32 || productName.length > 200 || locationArea.length > 120 || note.length > 500 || sessionId.length > 64) {
    return res.status(400).json({ error: 'input_too_long' });
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }
  if ((latitude === null) !== (longitude === null)) {
    return res.status(400).json({ error: 'latitude and longitude must be provided together' });
  }
  if (latitude !== null && (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude)))) {
    return res.status(400).json({ error: 'invalid_coordinates' });
  }
  const lat = latitude === null ? null : Number(latitude);
  const lng = longitude === null ? null : Number(longitude);
  if (lat !== null && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) {
    return res.status(400).json({ error: 'invalid_coordinates' });
  }
  // Store coordinates rounded: the report is about a market or shop, and
  // precise GPS traces are not ours to keep.
  const roundedLat = lat === null ? null : roundCoordinate(lat);
  const roundedLng = lng === null ? null : roundCoordinate(lng);
  if (photo !== undefined && photo !== null && photo !== '') {
    if (typeof photo !== 'string' || !photo.startsWith('data:image/') || photo.length > REPORT_PHOTO_MAX_BYTES) {
      return res.status(400).json({ error: 'invalid_photo', detail: 'Photo attachments must stay under 900 KB — the app downscales before sending.' });
    }
  }
  let scanResultText;
  try {
    scanResultText = JSON.stringify(scanResult);
  } catch {
    return res.status(400).json({ error: 'invalid_scan_result' });
  }
  if (scanResultText.length > 25000) {
    return res.status(400).json({ error: 'scan_result_too_large' });
  }

  const createdAt = new Date().toISOString();
  const windowStart = new Date(Date.now() - REPORT_RATE_WINDOW_MS).toISOString();
  const recentCount = reportsDb.prepare(
    'SELECT COUNT(*) AS count FROM reports WHERE session_id = ? AND created_at >= ?'
  ).get(sessionId, windowStart).count;
  if (recentCount >= REPORT_RATE_LIMIT) {
    return res.status(429).json({ error: 'report_rate_limited', detail: 'Too many reports from this session. Try again later.' });
  }

  const info = reportsDb.prepare(`
    INSERT INTO reports (nafdac_number, product_name, country, location_area, note, photo_url, scan_result, latitude, longitude, session_id, created_at, is_seed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(nafdacNumber || null, productName, country, locationArea, note, photo || null, scanResultText, roundedLat, roundedLng, sessionId, createdAt);
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid), created_at: createdAt });
});

// Retention sweep: report notes and rough locations stay (they are the safety
// signal), but photo attachments are cleared after RETENTION_DAYS. Runs once
// per server start; cheap enough not to need a timer.
function sweepExpiredReportPhotos() {
  const cutoff = new Date(Date.now() - REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = reportsDb.prepare(
    'UPDATE reports SET photo_url = NULL WHERE photo_url IS NOT NULL AND created_at < ? AND is_seed = 0'
  ).run(cutoff);
  if (result.changes > 0) {
    console.log(`report retention: cleared ${result.changes} photo attachment(s) older than ${REPORT_RETENTION_DAYS} days`);
  }
}
sweepExpiredReportPhotos();

app.get('/api/reports', (req, res) => {
  const country = String(req.query.country || 'ALL').trim().toUpperCase();
  if (!['ALL', 'NG', 'KE'].includes(country)) {
    return res.status(400).json({ error: 'country must be ALL, NG, or KE' });
  }
  const rows = country === 'ALL'
    ? reportsDb.prepare(`
      SELECT id, nafdac_number, product_name, country, location_area, note, latitude, longitude, created_at, is_seed, scan_result
      FROM reports ORDER BY created_at DESC LIMIT 500
    `).all()
    : reportsDb.prepare(`
      SELECT id, nafdac_number, product_name, country, location_area, note, latitude, longitude, created_at, is_seed, scan_result
      FROM reports WHERE country = ? ORDER BY created_at DESC LIMIT 500
    `).all(country);
  res.json({
    reports: rows.map((row) => {
      let scanStatus = null;
      try {
        const parsed = JSON.parse(row.scan_result || 'null');
        if (isPlainObject(parsed) && typeof parsed.status === 'string') scanStatus = parsed.status;
      } catch {}
      return {
        id: row.id,
        nafdac_number: row.nafdac_number,
        product_name: row.product_name,
        country: row.country,
        location_area: row.location_area,
        note: row.note,
        latitude: row.latitude,
        longitude: row.longitude,
        created_at: row.created_at,
        is_seed: row.is_seed === 1,
        scan_status: scanStatus,
      };
    }),
  });
});

app.post('/api/napams/cache', (req, res) => {
  const nafdac = String(req.body?.nafdac || '').trim();
  const productName = String(req.body?.product_name || '').trim();
  const manufacturer = String(req.body?.manufacturer || '').trim();
  const applicant = String(req.body?.applicant || '').trim() || null;
  const category = String(req.body?.category || '').trim() || null;
  const notes = String(req.body?.notes || '').trim() || null;
  const country = String(req.body?.country || 'NG').trim().toUpperCase();
  const status = String(req.body?.status || '').trim();

  if (!nafdac || !productName || !['NG', 'KE'].includes(country) || !['Active', 'Inactive'].includes(status)) {
    return res.status(400).json({ error: 'nafdac, product_name, and a valid status are required' });
  }
  if (nafdac.length > 32 || productName.length > 200 || manufacturer.length > 200 || String(applicant ?? '').length > 200 || String(category ?? '').length > 200 || String(notes ?? '').length > 500) {
    return res.status(400).json({ error: 'input_too_long' });
  }

  const checkedAt = new Date().toISOString();
  cacheDb.prepare(`
    INSERT INTO napams_cache (nafdac, product_name, manufacturer, applicant, category, status, source, checked_at, notes, country)
    VALUES (?, ?, ?, ?, ?, ?, 'napams_manual', ?, ?, ?)
    ON CONFLICT (nafdac, product_name, manufacturer) DO UPDATE SET
      applicant = excluded.applicant,
      category = excluded.category,
      status = excluded.status,
      source = excluded.source,
      checked_at = excluded.checked_at,
      notes = excluded.notes,
      country = excluded.country
  `).run(nafdac, productName, manufacturer, applicant, category, status, checkedAt, notes, country);

  res.status(201).json({
    ok: true,
    record: { nafdac, product_name: productName, manufacturer, country, status, source: 'napams_manual', checked_at: checkedAt },
  });
});

app.get('/api/health', (req, res) => {
  db.prepare('SELECT 1 AS ok').get();
  res.json({ status: 'ok' });
});

function normalizeProductName(name) {
  if (name == null) return '';
  return String(name)
    .replace(/&#?\w+;/g, ' ')
    .replace(/[#*$]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Dosage forms and strengths appear in almost every product description and
// say nothing about WHICH product it is. Generic-name matching skips them.
const GENERIC_STOPWORDS = new Set([
  'mg', 'ml', 'tablets', 'tablet', 'capsules', 'capsule', 'injection', 'syrup',
  'suspension', 'solution', 'solutions', 'drops', 'cream', 'ointment', 'gel',
  'sachet', 'sachets', 'oral', 'pack', 'bottle', 'inj', 'tab', 'cap', 'dt',
]);

// Words that describe the ALERT rather than identify the PRODUCT. Two alerts can
// share "counterfeit toothpaste" and still be about entirely different brands, so
// these may not be allowed to carry a match on their own.
const HAZARD_WORDS = new Set([
  'counterfeit', 'counterfeits', 'falsified', 'fake', 'substandard', 'unwholesome',
  'suspected', 'confirmed', 'illegal', 'unregistered', 'banned', 'recall', 'recalled',
  'alert', 'alerts', 'notice', 'presence', 'circulation', 'sale', 'distribution',
  'identified', 'detected', 'batch', 'batches', 'product', 'products', 'warning',
]);

// Function words a shopper may prepend ("the Avastin", "fake Tramadol 225mg").
// They say nothing about identity, so they are skipped when looking for the brand.
const LEADING_NOISE = new Set(['the', 'a', 'an', 'my', 'this', 'that', 'some', 'of', 'for', 'and', 'new']);

// Shoppers type the generic name printed on the strip ("pantoprazole 40mg
// tablets"); regulators name recalls by brand ("Panto-Denk"). Fuzzy string
// distance cannot bridge that (34/100), so a second rule scores a hit when
// EVERY significant query word — the drug substance words, not dosage forms or
// strengths — appears as a whole word in the candidate. Whole-word is the
// safety: "pantoprazole" must never half-match "ampicillin".
function nameMatchScore(queryNorm, candidateNorm) {
  const candidateWords = new Set(candidateNorm.split(/[^a-z0-9]+/));

  // A shopper types the BRAND first, so the first meaningful word of the query is
  // the strongest identity signal there is. If this alert's title does not
  // contain it, the alert is about something else and neither rule below may
  // stand — "oral b counterfeit toothpaste" scored 86 against the ORACIRE+ alert
  // on nothing but the shared class word "toothpaste" and the shared hazard word
  // "counterfeit", and "Cap Rice" scored 90 against a Bulmex rice alert.
  //
  // This is a CAP, applied to whichever branch produces the score. It can only
  // lower a score, never raise one.
  const firstWord = queryNorm.split(/[^a-z0-9]+/)
    .find((w) => w.length >= 2 && !HAZARD_WORDS.has(w) && !LEADING_NOISE.has(w));
  const brandAbsent = Boolean(firstWord) && !candidateWords.has(firstWord);

  const fuzzy = fuzz.token_set_ratio(queryNorm, candidateNorm);
  if (fuzzy >= 85) return brandAbsent ? 84 : fuzzy;

  const queryWords = queryNorm.split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC_STOPWORDS.has(word) && !/^\d/.test(word));
  if (queryWords.length === 0) return 0;
  const wholeWordHit = queryWords.every((word) => candidateWords.has(word));
  if (!wholeWordHit) return 0;
  return brandAbsent ? 84 : 90;
}

// All the names an alert can be matched on: the register title plus the
// brand/INN metadata on its known_fakes twin (the syncs store PPB's INN there).
function hazardNamesFor(alertNumber, productName) {
  const names = [normalizeProductName(productName)];
  try {
    const fake = reportsDb.prepare('SELECT brand_name, aliases FROM known_fakes WHERE alert_number = ?').get(alertNumber);
    if (fake?.brand_name) names.push(normalizeProductName(fake.brand_name));
    for (const alias of parseJsonArray(fake?.aliases)) names.push(normalizeProductName(alias));
  } catch {}
  return names.filter(Boolean);
}

const selectGreenbook = db.prepare(
  `SELECT id, nafdac, product_name, strength, form, route, applicant,
          manufacturer, category, approval_date, expiry_date, status, country
   FROM products WHERE TRIM(nafdac) = ? COLLATE NOCASE AND country = ?`
);
const selectNapamsCache = cacheDb.prepare(
  `SELECT id, nafdac, product_name, NULL AS strength, NULL AS form, NULL AS route,
          applicant, manufacturer, category, NULL AS approval_date, NULL AS expiry_date,
          status, source, checked_at AS source_checked_at, country
   FROM napams_cache WHERE nafdac = ? COLLATE NOCASE AND country = ?`
);
const selectKnownFakes = reportsDb.prepare(
  `SELECT alert_number, product_name, nafdac_number, category, brand_name, aliases, appearance,
          hazard, batches, source_url, photos_json, source_country
   FROM known_fakes WHERE source_country = ?`
);

const selectEnforcementActions = reportsDb.prepare(
  `SELECT action_key, authority, action_date, location, evidence_class, summary, brands,
          evidence_note, source_url, source_publisher, source_country
   FROM enforcement_actions WHERE finding_status = 'action_taken' AND source_country = ?`
);

// Enforcement actions are a weaker class of evidence than a public alert: a raid
// or destruction exercise proves counterfeits of a brand exist, but names no
// batch and carries no alert number. They are attached to a result as a dated,
// sourced note and can never change a verdict.
//
// Matching is deliberately stricter than the known-fake library, because these
// rows cover ordinary brands (Fanta, Sprite, Ovaltine) rather than obscure
// counterfeit names — a loose match here would put a note under half the
// products in the country.
//
// A fuzzy score is the wrong tool: `token_set_ratio` rewards containment, so the
// bare word "rice" scored 100 against "Big Bull Rice" — the same shared-generic
// -word trap that once matched "Cap Rice" to a parboiled-rice ban. Even dropping
// generic words is not enough, because "tomato paste" then half-matched "Tomato
// Rice". So the rule is the strict one: every word of the brand name must be
// present in the query as a whole word. Short forms a shopper actually types
// ("Big Bull", "Peak", "Miksi") are stored as explicit extra brand entries
// rather than being guessed at match time.
function brandWords(brand) {
  return normalizeProductName(brand)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

function enforcementMatches(normName, country = 'NG') {
  if (!normName) return [];
  const queryWords = new Set(normName.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ').filter(Boolean));
  const notes = [];
  for (const row of selectEnforcementActions.all(country)) {
    const matched = [];
    for (const brand of parseJsonArray(row.brands)) {
      const words = brandWords(brand);
      if (words.length === 0) continue;
      if (words.every((word) => queryWords.has(word))) matched.push(brand);
    }
    if (matched.length === 0) continue;
    notes.push({
      action_key: row.action_key,
      authority: row.authority,
      action_date: row.action_date,
      location: row.location,
      evidence_class: row.evidence_class,
      summary: row.summary,
      matched_brands: matched,
      evidence_note: row.evidence_note,
      source_url: row.source_url,
      source_publisher: row.source_publisher,
      source_country: row.source_country,
    });
  }
  return notes.sort((a, b) => a.action_date.localeCompare(b.action_date));
}

// Threat-intel fallback against the known-fake library, for packs that have no
// registration number to check — unregistered food, drinks and cosmetics.
//
// This is advisory by design. It can only ever ADD a lead underneath a verdict
// we already reached; it never changes one. A name hit is held to the same 85
// bar the rest of the app uses. An appearance-only hit is allowed in at a lower
// score because free-text pack descriptions are noisy, and such hits are
// labelled `matched_on: 'appearance'` so the UI can say so plainly.
const SUSPECT_MIN_NAME_SCORE = 85;
const SUSPECT_MIN_APPEARANCE_SCORE = 60;
const SUSPECT_MAX = 3;

function toFakeCandidate(row) {
  return {
    alert_number: row.alert_number,
    product_name: row.product_name,
    category: row.category,
    brand_name: row.brand_name,
    appearance: row.appearance,
    hazard: row.hazard,
    batches: parseJsonArray(row.batches),
    source_url: row.source_url,
    photos: parseJsonArray(row.photos_json),
  };
}

function knownFakeSuspects(normName, normAppearance, country = 'NG', excludeAlertNumbers = []) {
  if (!normName && !normAppearance) return [];
  const excluded = new Set(excludeAlertNumbers);
  const scored = [];
  for (const row of selectKnownFakes.all(country)) {
    // An alert already raised as the hazard banner must not re-appear as a
    // soft "possible match" lead below it — the same fact twice reads as a
    // contradiction, not emphasis.
    if (excluded.has(row.alert_number)) continue;
    const names = [row.product_name, row.brand_name, ...parseJsonArray(row.aliases)].filter(Boolean);
    const nameScore = normName
      ? Math.max(...names.map((name) => fuzz.token_set_ratio(normName, normalizeProductName(name))))
      : 0;
    const appearanceScore = normAppearance && row.appearance
      ? fuzz.token_set_ratio(normAppearance, normalizeProductName(row.appearance))
      : 0;
    if (nameScore < SUSPECT_MIN_NAME_SCORE && appearanceScore < SUSPECT_MIN_APPEARANCE_SCORE) continue;
    scored.push({
      ...toFakeCandidate(row),
      name_score: nameScore,
      appearance_score: appearanceScore || null,
      score: Math.round(Math.max(nameScore, appearanceScore)),
      matched_on: appearanceScore > nameScore ? 'appearance' : 'name',
      source_country: row.source_country || 'NG',
      authority: AUTHORITY_NAMES[row.source_country || 'NG'] || 'NAFDAC',
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.product_name.localeCompare(b.product_name))
    .slice(0, SUSPECT_MAX);
}

app.get('/verify', (req, res) => {
  const { nafdac, product_name, manufacturer } = req.query;
  const country = String(req.query.country || 'NG').trim().toUpperCase();
  const appearanceParam = req.query.appearance;
  const batchParam = typeof req.query.batch === 'string' ? req.query.batch.trim() : '';
  // The registration number is optional. Without one we skip the registry
  // entirely and answer from the known-fake library alone.
  const hasNumber = nafdac != null && String(nafdac).trim() !== '';

  if (!['NG', 'KE'].includes(country)) {
    return res.status(400).json({ error: 'country must be NG or KE' });
  }
  if (product_name == null) {
    return res.status(400).json({ error: 'missing required param: product_name' });
  }
  if (
    String(nafdac ?? '').length > 32 ||
    String(product_name).length > 200 ||
    String(manufacturer ?? '').length > 200 ||
    String(appearanceParam ?? '').length > 600 ||
    batchParam.length > 64
  ) {
    return res.status(400).json({ error: 'input_too_long' });
  }

  // Canonicalise the typed number before looking it up, so `04 – 1486` and
  // `04-1486` resolve to the same row. This is still an EXACT comparison — it
  // fixes printing differences and never makes a lookalike number match.
  const normalizedNafdac = hasNumber ? normalizeNumber(nafdac) : '';
  const rows = hasNumber
    ? [
        ...selectGreenbook.all(normalizedNafdac, country).map((row) => ({ ...row, source: country === 'KE' ? 'kenya_ppb' : 'greenbook', source_checked_at: null })),
        ...selectNapamsCache.all(normalizedNafdac, country),
      ]
    : [];
  const normName = normalizeProductName(product_name);
  // Works with or without a number: a pack with none is still reportable, and
  // the warnings it earns must show up on the next check of the same name.
  const flag = communityFlag(normalizedNafdac, product_name, country);
  const normManu = manufacturer != null ? normalizeProductName(manufacturer) : null;
  const normAppearance = appearanceParam ? normalizeProductName(appearanceParam) : null;
  const hazard = hazardMatch(normalizedNafdac, normName, country, batchParam || null);
  const enforcement = enforcementMatches(normName, country);
  if (rows.length === 0) {
    const suspects = knownFakeSuspects(normName, normAppearance, country, hazard ? [hazard.alert_number] : []);
    return res.json({
      status: 'not_found',
      nafdac: hasNumber ? nafdac : null,
      country,
      ...(hasNumber ? {} : { reason: 'no_number_provided' }),
    ...(flag ? { community_flag: flag } : {}),
    ...(hazard ? { hazard } : {}),
    ...(batchParam ? { batch: batchParam } : {}),
    ...(suspects.length > 0 ? { suspects } : {}),
    ...(enforcement.length > 0 ? { enforcement_notes: enforcement } : {}),
    });
  }

  const scored = rows.map((row) => {
    const name_score = fuzz.token_set_ratio(normName, normalizeProductName(row.product_name));
    const item = { ...row, name_score };
    if (normManu !== null && row.manufacturer) {
      item.manufacturer_score = fuzz.token_set_ratio(normManu, normalizeProductName(row.manufacturer));
    }
    if (normManu !== null) {
      item.combined_score = name_score * 0.7 + (item.manufacturer_score ?? 0) * 0.3;
    }
    return item;
  });

  const rank = (s) => (normManu !== null ? s.combined_score : s.name_score);

  const maxRank = Math.max(...scored.map(rank));
  const nearTop = scored.filter((s) => maxRank - rank(s) <= 3);
  const activeNearTop = nearTop.filter((s) => s.status === 'Active');
  const best =
    activeNearTop.length > 0
      ? activeNearTop.reduce((a, b) => (rank(b) > rank(a) ? b : a))
      : nearTop.reduce((a, b) => (rank(b) > rank(a) ? b : a));

  const INACTIVE_MESSAGE =
    'This number is in the official records, but its approval is not active right now. It may have expired, been suspended, or be waiting for renewal. Check the expiry date on the pack, and ask a pharmacist if you are unsure.';

  const mfrScore = best.manufacturer_score ?? 0;
  const mfrProvided = normManu !== null;

  let status;
  let reason;
  let message;

  if (best.name_score < 85) {
    status = 'mismatch';
  } else if (mfrProvided && mfrScore < 60) {
    status = 'mismatch';
    reason = 'manufacturer_mismatch';
  } else if (best.status !== 'Active') {
    status = 'verified_inactive';
    message = INACTIVE_MESSAGE;
  } else {
    status = 'verified';
  }

  const key = status === 'mismatch' ? 'closest_match' : 'matched';

  const payload = {
    status,
    country,
    [key]: {
      id: best.id,
      nafdac: best.nafdac,
      product_name: best.product_name,
      strength: best.strength,
      form: best.form,
      route: best.route,
      applicant: best.applicant,
      manufacturer: best.manufacturer,
      category: best.category,
      approval_date: best.approval_date,
      expiry_date: best.expiry_date,
      status: best.status,
      source: best.source,
      source_checked_at: best.source_checked_at,
      country: best.country,
    },
    score: best.name_score,
  };

  if (process.env.EXPOSE_VERIFY_DEBUG === 'true') {
    payload.debug = {
      input: { nafdac, product_name, manufacturer: manufacturer ?? null, country },
      normalized_input: normName,
      candidate_count: scored.length,
      near_top: nearTop.map((s) => ({
        id: s.id,
        product_name: s.product_name,
        status: s.status,
        rank_score: rank(s),
      })),
      active_preferred: activeNearTop.length > 0,
      candidates: scored.map((s) => ({
        id: s.id,
        product_name: s.product_name,
        manufacturer: s.manufacturer,
        name_score: s.name_score,
        manufacturer_score: s.manufacturer_score ?? null,
        combined_score: s.combined_score ?? null,
      })),
    };
  }

  if (reason) payload.reason = reason;
  if (message) payload.message = message;
  if (flag) payload.community_flag = flag;
  if (hazard) payload.hazard = hazard;
  if (batchParam) payload.batch = batchParam;
  // Only attach library leads when the registry could NOT confirm the pack.
  // A confirmed registration is never second-guessed by this list.
  if (status === 'not_found' || status === 'mismatch') {
    const suspects = knownFakeSuspects(normName, normAppearance, country, hazard ? [hazard.alert_number] : []);
    if (suspects.length > 0) payload.suspects = suspects;
  }
  // Enforcement notes ride along on every verdict, including a confirmed one:
  // they are a dated record that counterfeits of a brand were seized, not a
  // claim about the pack in the user's hand.
  if (enforcement.length > 0) payload.enforcement_notes = enforcement;

  res.json(payload);
});

// ---- Admin: freshness pipeline trigger ----
// New NAFDAC alerts join the register and the matching library directly — no
// review stage. This endpoint only exists so the sync can be triggered
// remotely (hosting platforms without cron). Gated on ADMIN_KEY, fail closed:
// absent key = disabled, wrong key = 401.
function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ error: 'admin_disabled', detail: 'Set ADMIN_KEY on the server to enable the alerts sync.' });
    return false;
  }
  const provided = req.get('x-admin-key');
  const ok = typeof provided === 'string' && provided.length > 0 &&
    provided.length === ADMIN_KEY.length && timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_KEY));
  if (!ok) res.status(401).json({ error: 'unauthorized', detail: 'A valid x-admin-key header is required.' });
  return ok;
}

app.post('/api/alerts/sync', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const summary = guardLiveSummary(runSync({ html: await fetchIndex() }));
    res.json({ ok: true, ...summary });
  } catch (e) {
    if (String(e.message || '').includes('Parsed 0 rows')) {
      return res.status(502).json({ error: 'index_unparseable', detail: e.message });
    }
    res.status(502).json({ error: 'sync_failed', detail: 'NAFDAC alerts index could not be fetched or parsed.' });
  }
});

// Public listing of every product in the known-fake library. This backs the
// standalone alerts page — a plain, referenceable register of the flagged
// products the app matches against, with NAFDAC's own photos where they exist.
app.get('/api/alerts', (req, res) => {
  const country = req.query.country === 'KE' ? 'KE' : (req.query.country === 'NG' ? 'NG' : null);
  const rows = reportsDb.prepare(
    `SELECT alert_number, product_name, nafdac_number, batches, hazard, category,
            brand_name, aliases, appearance, source_url, photos_json, source_country
     FROM known_fakes
     ${country ? 'WHERE source_country = ?' : ''}
     ORDER BY source_country ASC, alert_number DESC`
  ).all(...(country ? [country] : []));
  res.set('Cache-Control', 'no-cache');
  res.json({
    count: rows.length,
    alerts: rows.map((row) => ({
      alert_number: row.alert_number,
      product_name: row.product_name,
      nafdac_number: row.nafdac_number,
      category: row.category,
      brand_name: row.brand_name,
      aliases: parseJsonArray(row.aliases),
      batches: parseJsonArray(row.batches),
      hazard: row.hazard,
      appearance: row.appearance,
      source_url: row.source_url,
      photos: parseJsonArray(row.photos_json),
      source_country: row.source_country || 'NG',
      authority: AUTHORITY_NAMES[row.source_country || 'NG'] || 'NAFDAC',
    })),
  });
});

// The enforcement-action list: raids, destruction exercises and lab cases that
// NAFDAC has made public but that carry no alert number. Returned separately
// from /api/alerts because the two are not the same kind of claim, and a client
// that merged them would let a press statement read as a numbered alert.
//
// Rows recorded as `not_a_finding` (names we investigated and could not
// substantiate) are deliberately absent: they are internal research notes, not
// something to show a shopper.
app.get('/api/enforcement', (req, res) => {
  const country = req.query.country === 'KE' ? 'KE' : (req.query.country === 'NG' ? 'NG' : null);
  const rows = reportsDb.prepare(
    `SELECT action_key, authority, action_date, location, evidence_class, summary, brands,
            evidence_note, source_url, source_publisher, source_country
     FROM enforcement_actions
     WHERE finding_status = 'action_taken' ${country ? 'AND source_country = ?' : ''}
     ORDER BY action_date DESC, action_key ASC`
  ).all(...(country ? [country] : []));
  res.set('Cache-Control', 'no-cache');
  res.json({
    count: rows.length,
    disclaimer:
      'Enforcement actions are real regulator actions, but they are not public alerts: they name no batch and ' +
      'carry no alert number, so they can never confirm or refute a specific pack.',
    actions: rows.map((row) => ({
      action_key: row.action_key,
      authority: row.authority,
      action_date: row.action_date,
      location: row.location,
      evidence_class: row.evidence_class,
      summary: row.summary,
      brands: parseJsonArray(row.brands),
      evidence_note: row.evidence_note,
      source_url: row.source_url,
      source_publisher: row.source_publisher,
      source_country: row.source_country || 'NG',
    })),
  });
});

app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(WEB_DIR, 'sw.js'));
});

// The registration-number rules live in one module so the client and the server
// cannot drift — app.js used to keep its own copy of the pattern, which is how
// the browser ended up rejecting `A7-2363L` while the server accepted it.
//
// There is no bundler here, so the CommonJS tail is rewritten into a browser
// global on the way out. The rewrite is anchored on the exact export block and
// throws if that block is ever restructured, rather than silently serving a
// module that defines nothing.
app.get('/number-normalize.js', (req, res) => {
  const source = fs.readFileSync(path.join(__dirname, 'scripts', 'number_normalize.js'), 'utf8');
  const exportBlock = /module\.exports\s*=\s*\{[\s\S]*?\};?\s*$/;
  if (!exportBlock.test(source)) {
    throw new Error('number_normalize.js no longer ends in a module.exports block; update /number-normalize.js');
  }
  const browserSource = source
    .replace(exportBlock, 'window.VouchNumbers = { normalizeNumber, isPlausibleNumber, isPlausiblePpbNumber, isPlausibleRegistrationNumber, describeRejection, NUMBER_RE, PPB_RE };')
    .replace(/^const /gm, '');
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').send(browserSource);
});

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(WEB_DIR, 'manifest.webmanifest'));
});

app.use(express.static(WEB_DIR));

app.listen(PORT, () => {
  console.log(`verify endpoint listening on http://localhost:${PORT}`);
  console.log(`web UI: http://localhost:${PORT}/`);
  console.log(`vision extraction: ${GROQ_KEY ? 'enabled (' + VISION_MODEL + ')' : 'DISABLED (set GROQ_API_KEY)'}`);
});