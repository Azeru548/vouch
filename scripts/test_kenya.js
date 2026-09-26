const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PORT = 39000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const CACHE_PATH = path.join(os.tmpdir(), `vouch-kenya-test-cache-${process.pid}.db`);
const cases = [
  ['H2017CTD4509/R1', 'ACLOSARA-P'],
  ['21707/R1', 'ACP TABLETS'],
  ['H2008/18995/246/R1', 'BRUPAL-KID TABLETS'],
  ['H2026/CTD13636/29904', 'Paralife'],
  ['H2017/CTD4118/148', 'PROSTAFLO-F'],
];

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
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', CACHE_DATABASE_PATH: CACHE_PATH },
  });

  try {
    await waitForServer();
    for (const [nafdac, productName] of cases) {
      const response = await fetch(`${BASE}/verify?${new URLSearchParams({ nafdac, product_name: productName, country: 'KE' })}`);
      assert.equal(response.status, 200, `${nafdac}: expected HTTP 200`);
      const result = await response.json();
      assert.equal(result.status, 'verified', `${nafdac}: unexpected verdict`);
      assert.equal(result.country, 'KE');
      assert.equal(result.matched.country, 'KE');
      assert.equal(result.matched.source, 'kenya_ppb');
      assert.doesNotMatch(result.matched.product_name, /<[^>]+>|&(?:amp|lt|gt);/i);
    }
    console.log(`${cases.length} Kenya PPB lookups passed`);
  } finally {
    await stopServer(server);
    fs.rmSync(CACHE_PATH, { force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
