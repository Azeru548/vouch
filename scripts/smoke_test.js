const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = 'http://127.0.0.1:3777';

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
    env: { ...process.env, GROQ_API_KEY: '' },
  });
  let banner = '';
  server.stdout.on('data', (data) => { banner += data; });

  try {
    await waitForServer();
    assert.match(banner, /web UI/);

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

    console.log(`${staticChecks.length} static checks, validation checks, and ${verifyCases.length} verdict checks passed`);
  } finally {
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
