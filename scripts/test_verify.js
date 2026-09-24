const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3777;
const BASE = `http://127.0.0.1:${PORT}`;

const cases = [
  { label: 'inactive registration', nafdac: '04-0858', product_name: '10% Dextrose (500/1000 mL)**', expected: 'verified_inactive', match: 'dextrose' },
  { label: 'duplicate active registration', nafdac: '04-7953', product_name: 'Emgyl 400 Tablets', expected: 'verified', match: 'emgyl' },
  { label: 'duplicate disambiguation', nafdac: 'A4-1205', product_name: 'Dermovate Cream', expected: 'verified', match: 'dermovate' },
  { label: 'duplicate disambiguation', nafdac: 'A4-1205', product_name: 'Ebu 200 Tablets', expected: 'verified_inactive', match: 'ebu' },
  { label: 'unknown registration', nafdac: '99-9999', product_name: 'Whatever', expected: 'not_found' },
  { label: 'wrong product name', nafdac: 'A4-1205', product_name: 'Random Product XYZ', expected: 'mismatch' },
  { label: 'wrong manufacturer', nafdac: 'A4-1205', product_name: 'Dermovate Cream', manufacturer: 'Wrong Company Name', expected: 'mismatch', reason: 'manufacturer_mismatch' },
  { label: 'matching manufacturer', nafdac: 'A4-1205', product_name: 'Dermovate Cream', manufacturer: 'Glaxo Operations UK Limited', expected: 'verified_inactive' },
  { label: 'active registration', nafdac: 'A11-0009', product_name: 'Alben Paracetamol Drops##', expected: 'verified', match: 'alben' },
  { label: 'active registration with manufacturer', nafdac: 'A11-0009', product_name: 'Alben Paracetamol Drops##', manufacturer: 'Alben Healthcare Industries Limited', expected: 'verified' },
  { label: 'trimmed registration', nafdac: '  04-6868  ', product_name: 'Mirapicin Capsules', expected: 'verified', match: 'mirapicin' },
  { label: 'active duplicate preference', nafdac: '04-7953', product_name: 'Emgyl 400 Tablets', expected: 'verified', match: 'emgyl' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, GROQ_API_KEY: '' },
  });

  try {
    await waitForServer();
    let passed = 0;

    for (const testCase of cases) {
      const query = new URLSearchParams({
        nafdac: testCase.nafdac,
        product_name: testCase.product_name,
      });
      if (testCase.manufacturer) query.set('manufacturer', testCase.manufacturer);

      const response = await fetch(`${BASE}/verify?${query}`);
      assert.equal(response.status, 200, `${testCase.label}: expected HTTP 200`);
      const result = await response.json();
      assert.equal(result.status, testCase.expected, `${testCase.label}: unexpected verdict`);
      assert.equal(result.debug, undefined, `${testCase.label}: public response exposed debug data`);
      if (testCase.reason) assert.equal(result.reason, testCase.reason, `${testCase.label}: unexpected reason`);

      const record = result.matched || result.closest_match;
      if (testCase.match) {
        assert.ok(record, `${testCase.label}: expected a registry record`);
        assert.match(record.product_name, new RegExp(testCase.match, 'i'));
      }
      if (testCase.expected === 'not_found') assert.equal(record, undefined);

      passed++;
      console.log(`PASS ${String(passed).padStart(2)}/${cases.length} ${testCase.label}`);
    }

    console.log(`\n${passed}/${cases.length} verification tests passed`);
  } finally {
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
