const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { databasePath } = require('../config');
const { ensureKnownFakesTable } = require('./fakes_schema');

// Known-fake reference library, built from official NAFDAC alert pages.
//
// Alert facts (product name, NAFDAC number, batches, hazard, source) come from
// `hazard_alerts` so the two can never drift. What this file adds is the
// library metadata: what category the product is, which brand and aliases it is
// known by, and — where we can state it honestly — how the fake pack looks.
//
// `appearance` is intentionally left null for the drug entries. Those already
// have official NAFDAC photos on disk, and `npm run enrich:fake-appearance`
// fills their descriptors in from the photo. We do not invent pack details.
const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
const FAKES_DIR = path.join(__dirname, '..', 'web', 'fakes');

const libraryMeta = {
  // ---- Drugs (official NAFDAC photos available) ----
  '029/2025': { category: 'drug', brand_name: 'Embacef', aliases: ['Embacef 125', 'Embacef Powder for Oral Suspension'] },
  '030A/2025': { category: 'drug', brand_name: 'Artemetrin', aliases: ['Artemetrin DS', 'Artemetrin DS Tablets'] },
  '030B/2025': { category: 'drug', brand_name: 'Ciprofit', aliases: ['Ciprofit 500', 'Ciprofit Tablets'] },
  '024/2025': { category: 'drug', brand_name: 'Amoxivue', aliases: ['Amoxivue 500mg', 'Amoxivue Capsules'] },
  '023/2026': { category: 'drug', brand_name: 'Projeanil', aliases: ['Re-granil', 'Proguanil 100mg'] },
  '019/2026': { category: 'drug', brand_name: 'Otrivin', aliases: ['Otrivin Nasal Drops', 'Otrivin 0.05%'] },
  '05/2025': { category: 'drug', brand_name: 'Cikatem', aliases: ['Cikatem Suspension', 'Cikatem 180/1080mg'] },
  '035/2026': { category: 'drug', brand_name: 'Menofix', aliases: ['Menofix Composition'] },
  '020/2026': { category: 'drug', brand_name: 'ViroActive+', aliases: ['ViroActive', 'Viro Active'] },
  '03/2026': { category: 'drug', brand_name: 'Risperdal', aliases: ['Risperdal 2mg'] },

  // ---- Food and drink ----
  // Appearance notes below restate what the alert itself describes; they are
  // not inferred from photos we do not hold.
  // Alert 018/2026 carries no product photo, so the descriptor below is the
  // only reference this entry can offer.
  '018/2026': {
    category: 'food',
    brand_name: 'Cerelac',
    aliases: ['Cerelac Mixed Fruits', 'Cerelac Wheat', 'Cerelac infant cereal'],
    appearance: 'Infant cereal carton or tin. Counterfeit and unregistered packs are sold beside genuine Cerelac, so compare the batch code, the printed registration number and how crisp the brand logo print is.',
  },
  '026/2025': {
    category: 'food',
    brand_name: 'Cowbell',
    aliases: ['Cowbell Our Milk', 'Cowbell Milk 12g sachet'],
    appearance: 'Small 12 g sachet of milk powder. The counterfeit copies the Cowbell brand name, registration number and packaging design, so compare the sachet seal, the shade of the printed colours and the sharpness of the print.',
  },
  '039/2025': {
    category: 'food',
    brand_name: null,
    aliases: ['unregistered cooking oil', 'substandard edible oil', 'imported vegetable oil'],
    appearance: 'Imported or repackaged cooking oil in a bottle or jerrycan, often unbranded or labelled without a registration number. Sold mainly through informal markets and neighbourhood stores.',
  },

  // ---- Cosmetics ----
  '041/2026': {
    category: 'cosmetic',
    brand_name: 'ORACIRE+',
    aliases: ['Oracire Plus', 'Oracire toothpaste'],
    appearance: 'Toothpaste outer carton and tube. Suspected counterfeit ORACIRE+ s differ from the genuine pack in tube print, carton finish and the layout of the batch code.',
  },
  '022/2026': {
    category: 'cosmetic',
    brand_name: 'Colgate',
    aliases: ['Colgate toothpaste'],
    appearance: 'Toothpaste outer carton and tube. The unregistered packs mimic Colgate branding but differ in how the logo is printed, the weight statement and the batch code.',
  },
};

// Official NAFDAC product photos, downloaded once and served from /fakes/.
// Every URL below was read out of the alert page itself, so the photo is
// NAFDAC's own image of the flagged pack, not something we supplied.
//
// Three alerts publish no product photo at all (018/2026 Cerelac, 34/2025 and
// 35/2025 amoxicillin suspensions). Those entries fall back to their written
// `appearance` descriptor — we do not substitute a lookalike image.
const photosByAlert = {
  '029/2025': ['https://nafdac.gov.ng/wp-content/uploads/2025/08/Embacef.png', 'https://nafdac.gov.ng/wp-content/uploads/2025/08/Embacef1.png'],
  '030A/2025': ['https://nafdac.gov.ng/wp-content/uploads/2025/09/Artemetrin.png', 'https://nafdac.gov.ng/wp-content/uploads/2025/09/Artemetrin1.png'],
  '030B/2025': ['https://nafdac.gov.ng/wp-content/uploads/2025/09/Ciprofit.png', 'https://nafdac.gov.ng/wp-content/uploads/2025/09/Ciprofit1.png'],
  '024/2025': ['https://nafdac.gov.ng/wp-content/uploads/2025/08/Amoxivue.jpg', 'https://nafdac.gov.ng/wp-content/uploads/2025/08/Amoxivue1.jpg'],
  '023/2026': ['https://nafdac.gov.ng/wp-content/uploads/2026/04/Projeanil-996x1024.png', 'https://nafdac.gov.ng/wp-content/uploads/2026/04/ReGranil-1024x942.png'],
  '019/2026': ['https://nafdac.gov.ng/wp-content/uploads/2026/03/Otrivin.png', 'https://nafdac.gov.ng/wp-content/uploads/2026/03/Otrivin1.png'],
  '05/2025': ['https://nafdac.gov.ng/wp-content/uploads/2025/03/Cikatem-300x287.png', 'https://nafdac.gov.ng/wp-content/uploads/2025/03/Cikatem1-222x300.png'],
  '035/2026': ['https://nafdac.gov.ng/wp-content/uploads/2026/07/Menofix.jpg', 'https://nafdac.gov.ng/wp-content/uploads/2026/07/Menofix1.jpg'],
  '020/2026': ['https://nafdac.gov.ng/wp-content/uploads/2026/03/ViroActive.png'],
  '03/2026': ['https://nafdac.gov.ng/wp-content/uploads/2026/01/3.jpg', 'https://nafdac.gov.ng/wp-content/uploads/2026/01/4.jpg'],

  // ---- Food, drink and cosmetics ----
  '026/2025': ['https://nafdac.gov.ng/wp-content/uploads/2025/08/Cowbell.png', 'https://nafdac.gov.ng/wp-content/uploads/2025/08/Cowbell1-e1755765759957.png'],
  '039/2025': ['https://nafdac.gov.ng/wp-content/uploads/2025/12/Fino.png', 'https://nafdac.gov.ng/wp-content/uploads/2025/12/Fino1.png', 'https://nafdac.gov.ng/wp-content/uploads/2025/12/Fino2.png'],
  '022/2026': ['https://nafdac.gov.ng/wp-content/uploads/2026/04/Coglaet.png', 'https://nafdac.gov.ng/wp-content/uploads/2026/04/Coglaet2.png'],
  // NAFDAC published the ORACIRE+ counterfeit photo under filenames beginning
  // "OralB" — a naming slip on their side. The images sit directly under the
  // "Counterfeit Product Photo" heading of alert 041/2026, so they are the
  // right pack for this alert.
  '041/2026': ['https://nafdac.gov.ng/wp-content/uploads/2026/08/OralB.png', 'https://nafdac.gov.ng/wp-content/uploads/2026/08/OralB1.png'],
};

function fullSize(url) {
  return url.replace(/-\d+x\d+(?=\.\w+$)/, '');
}

async function download(url, dest) {
  const full = fullSize(url);
  for (const candidate of [full, url]) {
    try {
      const res = await fetch(candidate, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) continue;
      fs.writeFileSync(dest, buf);
      return { url: candidate, bytes: buf.length };
    } catch {}
  }
  return null;
}

(async () => {
  fs.mkdirSync(FAKES_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureKnownFakesTable(db);

  const alerts = db.prepare('SELECT alert_number, product_name, nafdac_number, batches, hazard, source_url FROM hazard_alerts').all();
  if (alerts.length === 0) throw new Error('hazard_alerts is empty — run npm run seed:hazards first');

  const insert = db.prepare(`
    INSERT INTO known_fakes (alert_number, product_name, nafdac_number, batches, hazard, source_url, photos_json, category, brand_name, aliases, appearance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (alert_number) DO UPDATE SET
      product_name = excluded.product_name,
      nafdac_number = excluded.nafdac_number,
      batches = excluded.batches,
      hazard = excluded.hazard,
      source_url = excluded.source_url,
      photos_json = excluded.photos_json,
      category = excluded.category,
      brand_name = excluded.brand_name,
      aliases = excluded.aliases,
      appearance = excluded.appearance
  `);

  // known_fakes is keyed by alert_number, but a couple of alerts cover two
  // products (e.g. 35/2025 = Annmox and Jawamox). Merge those into one library
  // row carrying both names, rather than letting the last one overwrite the
  // first. Both names then match through aliases and token_set_ratio.
  const groups = new Map();
  for (const alert of alerts) {
    const group = groups.get(alert.alert_number) || [];
    group.push(alert);
    groups.set(alert.alert_number, group);
  }

  const report = [];
  const byCategory = {};
  for (const [alertNumber, group] of groups) {
    const meta = libraryMeta[alertNumber] || { category: 'drug', brand_name: null, aliases: [] };
    const names = group.map((row) => row.product_name);
    const alert = {
      alert_number: alertNumber,
      product_name: names.join(' / '),
      nafdac_number: [...new Set(group.map((row) => row.nafdac_number).filter(Boolean))][0] ?? null,
      batches: JSON.stringify([...new Set(group.flatMap((row) => {
        try {
          const parsed = JSON.parse(row.batches || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }))]),
      hazard: [...new Set(group.map((row) => row.hazard))].join(' '),
      source_url: group[0].source_url,
    };
    const aliases = group.length > 1 ? [...meta.aliases, ...names] : meta.aliases;
    const slug = alert.alert_number.replace('/', '-');
    const local = [];
    let n = 0;
    for (const url of photosByAlert[alert.alert_number] || []) {
      n++;
      const ext = (url.match(/\.(jpe?g|png|webp|gif)$/i) || [])[1] || 'jpg';
      const dest = path.join(FAKES_DIR, `${slug}-${n}.${ext.toLowerCase()}`);
      if (process.env.SKIP_PHOTO_DOWNLOAD === 'true' && fs.existsSync(dest)) {
        local.push(`/fakes/${path.basename(dest)}`);
        continue;
      }
      const done = await download(url, dest);
      if (done) local.push(`/fakes/${path.basename(dest)}`);
      await new Promise((r) => setTimeout(r, 400));
    }

    insert.run(
      alert.alert_number, alert.product_name, alert.nafdac_number, alert.batches, alert.hazard, alert.source_url,
      JSON.stringify(local), meta.category, meta.brand_name, JSON.stringify(aliases), meta.appearance || null,
    );

    byCategory[meta.category] = (byCategory[meta.category] || 0) + 1;
    report.push({
      alert: alert.alert_number,
      category: meta.category,
      photos: local.length,
      appearance: meta.appearance ? 'text' : 'pending enrichment',
      ...(group.length > 1 ? { merged_products: names } : {}),
    });
  }

  const totals = db.prepare('SELECT COUNT(*) AS total, SUM(appearance IS NOT NULL) AS with_appearance FROM known_fakes').get();
  console.log(JSON.stringify({ database: dbPath, dir: FAKES_DIR, alerts: alerts.length, library_rows: totals.total, by_category: byCategory, with_appearance: totals.with_appearance, report }, null, 2));
  db.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
