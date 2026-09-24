const BASE = 'https://greenbook.nafdac.gov.ng';

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function nrnParams(regno) {
  const c = (i, data, extra = {}) => Object.assign({}, {
    [`columns[${i}][data]`]: data,
    [`columns[${i}][name]`]: data,
    [`columns[${i}][searchable]`]: 'true',
    [`columns[${i}][orderable]`]: 'true',
    [`columns[${i}][search][value]`]: '',
    [`columns[${i}][search][regex]`]: 'false',
  }, extra);
  const q = new URLSearchParams({
    draw: '1', start: '0', length: '2',
    'search[value]': '', 'search[regex]': 'false', _: Date.now(),
  });
  const c0 = c(0, 'product_name');
  q.append('columns[0][data]', c0['columns[0][data]']);
  q.append('columns[0][name]', c0['columns[0][name]']);
  q.append('columns[0][searchable]', c0['columns[0][searchable]']);
  q.append('columns[0][orderable]', c0['columns[0][orderable]']);
  q.append('columns[0][search][value]', c0['columns[0][search][value]']);
  q.append('columns[0][search][regex]', c0['columns[0][search][regex]']);
  const c5 = c(5, 'NAFDAC', { [`columns[5][search][value]`]: regno });
  q.append('columns[5][data]', c5['columns[5][data]']);
  q.append('columns[5][name]', c5['columns[5][name]']);
  q.append('columns[5][searchable]', c5['columns[5][searchable]']);
  q.append('columns[5][orderable]', c5['columns[5][orderable]']);
  q.append('columns[5][search][value]', c5['columns[5][search][value]']);
  q.append('columns[5][search][regex]', c5['columns[5][search][regex]']);
  return q.toString();
}

async function step1() {
  console.log('== STEP 1: homepage ==');
  const r = await fetch(BASE + '/', { headers: UA, redirect: 'follow' });
  const t = await r.text();
  console.log(`status=${r.status} type=${r.headers.get('content-type')} bytes=${t.length}`);
  console.log(`verdict: ${t.includes('NAFDAC Greenbook') ? 'real content' : 'check'}\n`);
}

async function step3() {
  console.log('== STEP 3: direct JSON query (NRN=04-0858) ==');
  const url = `${BASE}/?${nrnParams('04-0858')}`;
  const r = await fetch(url, { headers: { ...UA, ...XHR } });
  const j = await r.json();
  console.log(`status=${r.status} type=${r.headers.get('content-type')} recordsFiltered=${j.recordsFiltered}`);
  console.log('sample record keys:', Object.keys(j.data[0]).join(', '));
  console.log('NAFDAC match:', j.data[0].NAFDAC, '|', j.data[0].product_name, '\n');
}

async function step5() {
  console.log('== STEP 5: rate-limit (5x, 3s apart) ==');
  const url = `${BASE}/?${nrnParams('04-0858')}`;
  for (let i = 1; i <= 5; i++) {
    const t0 = Date.now();
    const r = await fetch(url, { headers: { ...UA, ...XHR } });
    const ms = Date.now() - t0;
    console.log(`req ${i}: HTTP ${r.status} ${(ms / 1000).toFixed(2)}s type=${r.headers.get('content-type')}`);
    if (i < 5) await new Promise((s) => setTimeout(s, 3000));
  }
}

(async () => { await step1(); await step3(); await step5(); })();