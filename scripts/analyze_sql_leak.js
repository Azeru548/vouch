const fs = require('fs');
const path = require('path');

const RECON = path.join(__dirname, '..', 'recon');

function loadQueries(file) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(RECON, file), 'utf8'));
    return Array.isArray(j.queries) ? j.queries : null;
  } catch (e) {
    return null;
  }
}

const files = fs.readdirSync(RECON).filter((f) => f.endsWith('.json'));

console.log('==== WHICH CAPTURES CONTAIN THE DEBUG "queries" ARRAY ====\n');
for (const f of files) {
  const q = loadQueries(f);
  if (!q) continue;
  const j = JSON.parse(fs.readFileSync(path.join(RECON, f), 'utf8'));
  console.log(`${f.padEnd(24)} queries=${String(q.length).padEnd(3)} records=${j.data ? j.data.length : '-'}  hasInput=${'input' in j}`);
}

console.log('\n\n==== DISTINCT SQL SHAPES (from the small captures) ====\n');
const shapes = new Map();
for (const f of files) {
  const q = loadQueries(f);
  if (!q || q.length > 50) continue;
  for (const entry of q) {
    const norm = entry.query.replace(/\b\d+\b/g, 'N').replace(/'[^']*'/g, "'?'");
    if (!shapes.has(norm)) shapes.set(norm, { count: 0, sample: entry.query, bindings: entry.bindings, time: entry.time });
    shapes.get(norm).count++;
  }
}
for (const [k, v] of shapes) {
  console.log(`SQL   : ${v.sample}`);
  console.log(`bindings: ${JSON.stringify(v.bindings).slice(0, 120)}`);
  console.log(`time  : ${v.time} ms   (seen ${v.count}x)`);
  console.log('');
}

console.log('\n==== FULL DUMP: total queries and schema surface ====\n');
const full = loadQueries('full_dump_8977.json');
if (full) {
  console.log(`total queries executed for one full-table pull: ${full.length}`);

  const tables = new Set();
  const cols = new Set();
  const bindingKinds = new Set();
  let unparameterized = [];

  for (const e of full) {
    for (const m of e.query.matchAll(/`?(\w+)`?\.\*?\s*from\s+`?(\w+)`?/gi)) tables.add(m[2]);
    for (const m of e.query.matchAll(/select\s+(.+?)\s+from/gi)) {
      for (const c of m[1].split(',')) {
        const name = c.trim().replace(/`/g, '').split('.').pop().replace(/\s+as\s+.*/i, '');
        if (/^\w+$/.test(name)) cols.add(name);
      }
    }
    for (const b of e.bindings) bindingKinds.add(typeof b);
    // Anything interpolated directly rather than bound as a parameter?
    if (/\bwhere\b[^?]*\bLIKE\s+'(?!\?)/i.test(e.query)) unparameterized.push(e.query.slice(0, 200));
  }

  console.log(`tables referenced  : ${[...tables].sort().join(', ')}`);
  console.log(`columns selected  : ${[...cols].sort().join(', ')}`);
  console.log(`binding types seen: ${[...bindingKinds].join(', ')}`);
  console.log(`queries with an interpolated literal in a WHERE clause: ${unparameterized.length}`);
  unparameterized.slice(0, 5).forEach((q) => console.log('   ' + q));

  const slowest = [...full].sort((a, b) => b.time - a.time).slice(0, 5);
  console.log('\nslowest queries (info leak: query timing fingerprint):');
  for (const s of slowest) console.log(`  ${String(Math.round(s.time)).padStart(5)} ms  ${s.query.slice(0, 110)}`);
}
