const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { databasePath } = require('../config');
const { ensureKnownFakesTable, parseJsonArray } = require('./fakes_schema');
const { APPEARANCE_PROMPT, cleanAppearanceFields } = require('./fake_appearance');

// Fills in `known_fakes.appearance` for library entries that have an official
// photo but no written descriptor yet. Run after `npm run seed:fakes`.
//
//   npm run enrich:fake-appearance            # only rows missing a descriptor
//   npm run enrich:fake-appearance -- --force # re-describe every photographed row
//
// Needs GROQ_API_KEY. Without a photo, or without the key, it changes nothing.
const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
const WEB_DIR = path.join(__dirname, '..', 'web');
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const VISION_MODEL = process.env.VISION_MODEL || 'qwen/qwen3.8-27b';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function readPhotoDataUrl(relPath) {
  const file = path.join(WEB_DIR, relPath.replace(/^\//, ''));
  if (!fs.existsSync(file)) return null;
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mime) return null;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function describeOnce(dataUrl) {
  const upstream = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: VISION_MODEL,
      temperature: 0,
      max_tokens: 220,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: APPEARANCE_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  const body = await upstream.json();
  if (!upstream.ok) {
    const error = new Error(body?.error?.message || `vision upstream error (${upstream.status})`);
    error.rateLimited = upstream.status === 429 || /rate limit/i.test(body?.error?.message || '');
    // Groq states the cooldown in its message: "Please try again in 16.6s".
    const hint = (body?.error?.message || '').match(/try again in ([\d.]+)s/i);
    error.retryAfterMs = hint ? Math.ceil(Number(hint[1]) * 1000) + 1000 : null;
    throw error;
  }
  const raw = body?.choices?.[0]?.message?.content ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return cleanAppearanceFields(parsed);
}

// The free on-demand tier budgets ~7k input tokens per minute and one pack
// photo is a large fraction of that, so 429s are normal here, not errors.
// Wait out the cooldown Groq reports and retry a few times before giving up.
const MAX_ATTEMPTS = 5;

async function describe(dataUrl) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await describeOnce(dataUrl);
    } catch (error) {
      const exhausted = attempt === MAX_ATTEMPTS;
      if (!error.rateLimited || exhausted) throw error;
      const wait = error.retryAfterMs ?? 20000;
      console.error(`  rate limited; waiting ${Math.round(wait / 1000)}s before attempt ${attempt + 1}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

(async () => {
  if (!GROQ_KEY) {
    console.log(JSON.stringify({ skipped: true, reason: 'GROQ_API_KEY is not set — nothing to enrich' }, null, 2));
    return;
  }
  const force = process.argv.includes('--force');
  const db = new DatabaseSync(dbPath);
  ensureKnownFakesTable(db);

  const rows = db.prepare('SELECT alert_number, product_name, photos_json, appearance FROM known_fakes').all()
    .filter((row) => force || !row.appearance)
    .map((row) => ({ ...row, photos: parseJsonArray(row.photos_json) }))
    .filter((row) => row.photos.length > 0);

  const update = db.prepare('UPDATE known_fakes SET appearance = ? WHERE alert_number = ?');
  const report = [];

  for (const row of rows) {
    const dataUrl = readPhotoDataUrl(row.photos[0]);
    if (!dataUrl) {
      report.push({ alert: row.alert_number, status: 'photo missing on disk' });
      continue;
    }
    try {
      const fields = await describe(dataUrl);
      if (!fields.appearance) {
        report.push({ alert: row.alert_number, status: 'no usable descriptor returned' });
        continue;
      }
      update.run(fields.appearance, row.alert_number);
      report.push({ alert: row.alert_number, status: 'updated', appearance: fields.appearance });
    } catch (error) {
      report.push({ alert: row.alert_number, status: `failed: ${error.message}` });
    }
    // Space calls out even on success: the limit is per minute, and one big
    // photo can nearly fill it on its own.
    await new Promise((r) => setTimeout(r, 6000));
  }

  const totals = db.prepare('SELECT COUNT(*) AS total, SUM(appearance IS NOT NULL) AS with_appearance FROM known_fakes').get();
  console.log(JSON.stringify({ database: dbPath, model: VISION_MODEL, total: totals.total, with_appearance: totals.with_appearance, report }, null, 2));
  db.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
