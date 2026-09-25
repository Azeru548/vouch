const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopServer(server) {
  if (server.exitCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 2000);
    server.once('exit', finish);
    server.kill();
  });
}

const PORT = 38000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const CACHE_PATH = path.join(os.tmpdir(), `vouch-smoke-cache-${process.pid}.db`);

const staticChecks = [
  ['/', 'text/html'],
  ['/styles.css', 'text/css'],
  ['/app.js', 'javascript'],
  ['/api/config', 'application/json'],
  ['/api/health', 'application/json'],
];

const verifyCases = [
  { status: 'verified', query: { nafdac: 'A11-0009', product_name: 'Alben Paracetamol Drops' } },
  { status: 'verified_inactive', query: { nafdac: '04-0858', product_name: '10% Dextrose (500/1000 mL)' } },
  { status: 'mismatch', query: { nafdac: 'A4-1205', product_name: 'Random Product XYZ' } },
  { status: 'not_found', query: { nafdac: '99-9999', product_name: 'Whatever' } },
  { status: 'verified', query: { nafdac: '  04-6868  ', product_name: 'Mirapicin Capsules' } },
];

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Server did not become ready');
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', CACHE_DATABASE_PATH: CACHE_PATH },
  });
  try {
    await waitForServer();

    for (const [route, expectedType] of staticChecks) {
      const response = await fetch(BASE + route);
      assert.equal(response.status, 200, `${route}: expected HTTP 200`);
      assert.match(response.headers.get('content-type') || '', new RegExp(expectedType));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }

    const missing = await fetch(`${BASE}/verify?nafdac=A11-0009`);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'missing required param: product_name');

    const extraction = await fetch(`${BASE}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'data:image/jpeg;base64,/9j/4AAQ' }),
    });
    assert.equal(extraction.status, 503);
    assert.equal((await extraction.json()).error, 'vision_not_configured');

    for (const testCase of verifyCases) {
      const response = await fetch(`${BASE}/verify?${new URLSearchParams(testCase.query)}`);
      const result = await response.json();
      assert.equal(result.status, testCase.status);
      assert.equal(result.debug, undefined);
    }

    const cacheWrite = await fetch(`${BASE}/api/napams/cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nafdac: 'D1-9999', product_name: 'Cached Product', status: 'Active' }),
    });
    assert.equal(cacheWrite.status, 201);
    const cached = await fetch(`${BASE}/verify?nafdac=D1-9999&product_name=Cached%20Product`);
    const cachedResult = await cached.json();
    assert.equal(cachedResult.status, 'verified');
    assert.equal(cachedResult.matched.source, 'napams_manual');

    console.log(`${staticChecks.length} static checks, validation checks, ${verifyCases.length} verdict checks, and NAPAMS cache check passed`);
  } finally {
    await stopServer(server);
    fs.rmSync(CACHE_PATH, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
