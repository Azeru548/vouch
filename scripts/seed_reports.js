const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { ensureReportsTable } = require('./reports_schema');
const { databasePath } = require('../config');

// DEMO/SEED DATA ONLY.
// Every row inserted here has is_seed = 1 and must be treated as sample
// map/report content, not real user-submitted community reports.
const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
const now = Date.now();
const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

// DEMO/SEED DATA ONLY: clustered sample reports for Nigeria and Kenya.
// The repeated SEED-NG-001 and SEED-KE-001 numbers intentionally cross the
// community-flag threshold so demos can show registry + flag layering.
const seeds = [
  { nafdac_number: 'SEED-NG-001', country: 'NG', location_area: 'Ikeja, Lagos', note: 'Seed demo report: pack looked resealed.', latitude: 6.6018, longitude: 3.3515, created_at: daysAgo(2) },
  { nafdac_number: 'SEED-NG-001', country: 'NG', location_area: 'Ikeja, Lagos', note: 'Seed demo report: batch label was smudged.', latitude: 6.6031, longitude: 3.3498, created_at: daysAgo(4) },
  { nafdac_number: 'SEED-NG-001', country: 'NG', location_area: 'Ikeja, Lagos', note: 'Seed demo report: seller could not explain expiry date.', latitude: 6.6002, longitude: 3.3530, created_at: daysAgo(6) },
  { nafdac_number: 'SEED-NG-001', country: 'NG', location_area: 'Wuse, Abuja', note: 'Seed demo report: same pack design seen elsewhere.', latitude: 9.0579, longitude: 7.4951, created_at: daysAgo(9) },
  { nafdac_number: 'SEED-NG-002', country: 'NG', location_area: 'Wuse, Abuja', note: 'Seed demo report: single sample for map coverage.', latitude: 9.0594, longitude: 7.4936, created_at: daysAgo(12) },
  { nafdac_number: 'SEED-KE-001', country: 'KE', location_area: 'Westlands, Nairobi', note: 'Seed demo report: unusual seal on bottle cap.', latitude: -1.2635, longitude: 36.8028, created_at: daysAgo(1) },
  { nafdac_number: 'SEED-KE-001', country: 'KE', location_area: 'Westlands, Nairobi', note: 'Seed demo report: print quality differed from pharmacy stock.', latitude: -1.2650, longitude: 36.8042, created_at: daysAgo(3) },
  { nafdac_number: 'SEED-KE-001', country: 'KE', location_area: 'Westlands, Nairobi', note: 'Seed demo report: customer reported odd taste.', latitude: -1.2621, longitude: 36.8011, created_at: daysAgo(7) },
  { nafdac_number: 'SEED-KE-001', country: 'KE', location_area: 'Kibera, Nairobi', note: 'Seed demo report: street vendor copy suspected.', latitude: -1.3133, longitude: 36.7846, created_at: daysAgo(10) },
  { nafdac_number: 'SEED-KE-002', country: 'KE', location_area: 'Nyali, Mombasa', note: 'Seed demo report: single sample for map coverage.', latitude: -4.0435, longitude: 39.6682, created_at: daysAgo(13) },
];

const db = new DatabaseSync(dbPath);
ensureReportsTable(db);
db.prepare('DELETE FROM reports WHERE is_seed = 1').run();
const insert = db.prepare(`
  INSERT INTO reports (nafdac_number, country, location_area, note, photo_url, scan_result, latitude, longitude, session_id, created_at, is_seed)
  VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1)
`);
for (const seed of seeds) {
  insert.run(
    seed.nafdac_number,
    seed.country,
    seed.location_area,
    seed.note,
    JSON.stringify({ status: 'not_found', country: seed.country, demo: true }),
    seed.latitude,
    seed.longitude,
    `seed-demo-${seed.country.toLowerCase()}`,
    seed.created_at,
  );
}
const counts = db.prepare('SELECT country, COUNT(*) AS count FROM reports WHERE is_seed = 1 GROUP BY country ORDER BY country').all();
console.log(JSON.stringify({ database: dbPath, seed_reports: counts }, null, 2));
db.close();
