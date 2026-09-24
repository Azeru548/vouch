const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const fuzz = require('fuzzball');
const fs = require('fs');
const path = require('path');
const { databasePath: DB_PATH, port: PORT, visionModel: VISION_MODEL } = require('./config');

const WEB_DIR = path.join(__dirname, 'web');
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const NAFDAC_RE = /^[A-Z0-9]{1,3}-\d{3,6}$/i;

if (!fs.existsSync(DB_PATH)) {
  throw new Error(`Database not found at ${DB_PATH}. Run npm run ingest or set DATABASE_PATH.`);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

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

app.post('/api/extract', async (req, res) => {
  if (!GROQ_KEY) {
    return res.status(503).json({ error: 'vision_not_configured', detail: 'Set GROQ_API_KEY on the server to enable photo extraction.' });
  }
  const { image } = req.body || {};
  if (!image || typeof image !== 'string' || !image.startsWith('data:image')) {
    return res.status(400).json({ error: 'bad_image', detail: 'Expected a data:image/... base64 string.' });
  }

  const prompt =
    'Find the NAFDAC registration number on this product packaging photo. ' +
    'Return ONLY a JSON object with exactly these keys: ' +
    '{"nafdac_number": string|null, "found": boolean}. ' +
    'Rules: ' +
    '- nafdac_number is REQUIRED. Set found=false and nafdac_number to null only if no NAFDAC number is visible at all. ' +
    '- Copy the number exactly as printed, including the hyphen and any leading letters. ' +
    '- Do not return a product name.';

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        signal: AbortSignal.timeout(25000),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
      }),
    });

    const body = await upstream.json();
    if (!upstream.ok) {
      return res.status(502).json({ error: 'vision_upstream_error', detail: 'Photo reading service is unavailable.' });
    }

    const raw = body?.choices?.[0]?.message?.content ?? '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: 'vision_bad_json', detail: 'Photo reading returned an invalid response.' });
    }

    const nafdac_number = typeof parsed.nafdac_number === 'string' ? parsed.nafdac_number.trim().toUpperCase() : null;
    const found = parsed.found === true;
    const format_valid = nafdac_number != null && NAFDAC_RE.test(nafdac_number);

    res.json({
      nafdac_number,
      found,
      format_valid,
      // The number alone is enough to proceed; the user always types the product name.
      usable: found && format_valid,
    });
  } catch (err) {
    res.status(502).json({ error: 'vision_request_failed', detail: 'Photo reading timed out or could not be reached.' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ vision_enabled: Boolean(GROQ_KEY), vision_model: VISION_MODEL });
});

app.get('/api/health', (req, res) => {
  db.prepare('SELECT 1 AS ok').get();
  res.json({ status: 'ok' });
});

function normalizeProductName(name) {
  if (name == null) return '';
  return String(name)
    .replace(/[#*$]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const selectCands = db.prepare(
  `SELECT id, nafdac, product_name, strength, form, route, applicant,
          manufacturer, category, approval_date, expiry_date, status
   FROM products WHERE nafdac = ? COLLATE NOCASE`
);

app.get('/verify', (req, res) => {
  const { nafdac, product_name, manufacturer } = req.query;

  if (!nafdac) {
    return res.status(400).json({ error: 'missing required param: nafdac' });
  }
  if (product_name == null) {
    return res.status(400).json({ error: 'missing required param: product_name' });
  }
  if (String(nafdac).length > 32 || String(product_name).length > 200 || String(manufacturer ?? '').length > 200) {
    return res.status(400).json({ error: 'input_too_long' });
  }

  const rows = selectCands.all(String(nafdac).trim());
  if (rows.length === 0) {
    return res.json({ status: 'not_found', nafdac });
  }

  const normName = normalizeProductName(product_name);
  const normManu = manufacturer != null ? normalizeProductName(manufacturer) : null;

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
    'This product is registered but its NAFDAC approval is currently inactive.';

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
    },
    score: best.name_score,
  };

  if (process.env.EXPOSE_VERIFY_DEBUG === 'true') {
    payload.debug = {
      input: { nafdac, product_name, manufacturer: manufacturer ?? null },
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

  res.json(payload);
});

app.use(express.static(WEB_DIR));

app.listen(PORT, () => {
  console.log(`verify endpoint listening on http://localhost:${PORT}`);
  console.log(`web UI: http://localhost:${PORT}/`);
  console.log(`vision extraction: ${GROQ_KEY ? 'enabled (' + VISION_MODEL + ')' : 'DISABLED (set GROQ_API_KEY)'}`);
});