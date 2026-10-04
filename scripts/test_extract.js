// Asserted test for the photo-reading pipeline (/api/extract).
//
// This used to be a print-only smoke script: it had no assertions, so three of
// five photos failing (or the whole endpoint 502ing) still exited 0. It now
// fails loudly, and splits the checks in two:
//
//   1. Contract checks — always run, no network. Bad image payloads are
//      rejected, and every response keeps the shape the UI depends on.
//   2. Live checks — only when GROQ_API_KEY is set. The sharp sample photo
//      must read the NAFDAC number printed on it (AB-102886). The softer photos
//      are not required to be legible, but must not error or return a
//      malformed number.
//
// The free Groq tier allows roughly 7,000 input tokens a minute and answers
// anything over that with 429, so the suite paces itself and waits out the
// "try again in Ns" the server now passes back.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Per-process port like the other suites. Using the app's own 3788 here made the
// suite silently talk to whatever dev server happened to be running, and then
// fail confusingly when that server was stopped mid-run.
const PORT = 39600 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const ASSETS = path.join(__dirname, '..', 'assets');

// The printed number on every one of these sample photos. Read off the pack by
// hand, not taken from a model run, so a regression cannot quietly "agree" with
// a wrong answer.
const SHARP_SAMPLE = 'sharp-sample-image.jpg';
const EXPECTED_SHARP_NUMBER = 'AB-102886';
// One photo set costs ~2,200 input tokens and the free tier allows 7,000/min.
const LIVE_PACE_MS = 21000;
const TINY_PIXEL = 'data:image/jpeg;base64,/9j/4AAQ';

const files = fs.readdirSync(ASSETS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const liveEnabled = Boolean(process.env.GROQ_API_KEY);

let passed = 0;
const failures = [];

function record(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function toDataUrl(fp) {
  const ext = path.extname(fp).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`;
}

async function postExtract(body) {
  const response = await fetch(`${BASE}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Calls /api/extract, waiting out rate limits rather than failing on them. */
async function extractWithRetry(payload, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result;
    try {
      result = await postExtract(payload);
    } catch (err) {
      // A dead server is a real failure, not a rate limit — say which it was.
      throw new Error(`server unreachable while reading ${label}: ${err.cause?.code || err.message}`);
    }
    const { status, body } = result;
    if (status === 429) {
      const waitMs = (body.retry_after_seconds || 15) * 1000;
      console.log(`       rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt})`);
      await sleep(waitMs + 500);
      continue;
    }
    return { status, body };
  }
  return { status: 429, body: { error: 'vision_rate_limited', detail: 'still rate limited after 3 attempts' } };
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT: String(PORT) },
  });
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${BASE}/api/config`)).ok) { up = true; break; } } catch {}
      await sleep(250);
    }
    if (!up) throw new Error(`server never came up on port ${PORT} — start it manually to see why: node server.js`);
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    console.log(`extract test — vision ${cfg.vision_enabled ? `enabled (${cfg.vision_model})` : 'disabled'}\n`);

    // ---- 1. Contract checks (no network) -------------------------------
    console.log('contract');
    const none = await postExtract({});
    record('  -> 400 bad_images with no images', () => {
      assert.equal(none.status, 400);
      assert.equal(none.body.error, 'bad_images');
    });

    const tooMany = await postExtract({ images: Array.from({ length: 5 }, () => TINY_PIXEL) });
    record('5 images are rejected as bad_images', () => {
      assert.equal(tooMany.status, 400);
      assert.equal(tooMany.body.error, 'bad_images');
    });

    const notDataUrl = await postExtract({ image: 'https://example.com/pack.jpg' });
    record('a remote URL is rejected as bad_images', () => {
      assert.equal(notDataUrl.status, 400);
      assert.equal(notDataUrl.body.error, 'bad_images');
    });

    // ---- 2. Live checks -------------------------------------------------
    if (!liveEnabled) {
      console.log('\nlive checks skipped — set GROQ_API_KEY to run them.');
    } else {
      console.log('\nlive (paced for the free-tier input limit, this takes a couple of minutes)');
      assert.ok(files.includes(SHARP_SAMPLE), `assets/ is missing ${SHARP_SAMPLE}, which the live check needs`);

      let firstLive = true;
      for (const f of files) {
        const fp = path.join(ASSETS, f);
        const isSharp = f === SHARP_SAMPLE;
        if (!firstLive) await sleep(LIVE_PACE_MS);
        firstLive = false;

        const t0 = Date.now();
        const { status, body } = await extractWithRetry({ image: toDataUrl(fp) }, f);
        const seconds = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  ${f}: HTTP ${status} in ${seconds}s -> ${JSON.stringify(body.nafdac_number)}`);

        record(`${f} returns a 200 extract response`, () => {
          assert.equal(status, 200, `expected 200, got ${status} ${JSON.stringify(body)}`);
        });
        record(`${f} keeps the response shape the UI reads`, () => {
          for (const key of ['nafdac_number', 'found', 'format_valid', 'usable']) {
            assert.ok(key in body, `missing "${key}"`);
          }
          assert.equal(typeof body.found, 'boolean');
          assert.equal(typeof body.format_valid, 'boolean');
          assert.equal(typeof body.usable, 'boolean');
          // usable is exactly "found and well formed" — the UI branches on it.
          assert.equal(body.usable, body.found && body.format_valid);
          // The endpoint deliberately never returns a name: users always type
          // it. Guard it, so nobody re-adds an unreliable OCR name field.
          assert.equal('product_name' in body, false, 'extract must not return product_name');
        });
        record(`${f} never returns a malformed number as valid`, () => {
          if (body.nafdac_number != null) {
            assert.match(body.nafdac_number, /^[A-Z0-9]{1,3}-\d{3,6}$/i, `"${body.nafdac_number}" is not a NAFDAC-shaped number`);
            assert.equal(body.format_valid, true, 'a NAFDAC-shaped number must be format_valid');
          }
        });

        if (isSharp) {
          record(`${f} reads the printed number ${EXPECTED_SHARP_NUMBER}`, () => {
            assert.equal(body.nafdac_number, EXPECTED_SHARP_NUMBER, `read "${body.nafdac_number}" instead`);
            assert.equal(body.found, true);
            assert.equal(body.format_valid, true);
            assert.equal(body.usable, true);
          });
          const vr = await (await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac: EXPECTED_SHARP_NUMBER, product_name: 'soda bottle' })}`)).json();
          record('the extracted number feeds straight into /verify', () => {
            // AB-102886 is a real printed number but is not in the snapshot, so
            // not_found is the correct outcome — the point is that the lookup
            // runs and returns a verdict rather than erroring.
            assert.equal(vr.status, 'not_found', `unexpected verdict ${vr.status}`);
          });
        }
      }
    }
  } finally {
    server.kill();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });