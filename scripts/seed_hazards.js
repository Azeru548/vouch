const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { ensureHazardTable } = require('./hazard_schema');
const { databasePath } = require('../config');

// Curated from NAFDAC Recalls and Safety Alerts detail pages
// (nafdac.gov.ng/category/recalls-and-alerts/), collected manually
// September 2026. in_registry reflects our Greenbook snapshot at seed time.
const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);

const alerts = [
  { alert_number: '029/2025', product_name: 'Embacef 125 Powder for Oral Suspension', nafdac_number: 'A4-9040', batches: ['PEDSE001'], hazard: 'Recall: reconstituted suspension caked after day one; confirmed poor quality', alert_type: 'recall', manufacturer: 'Laborate Pharmaceutical India', source_url: 'https://nafdac.gov.ng/public-alert-no-029-2025-notice-to-recall-embacef-125-powder-for-oral-suspension/', alert_date: '2025-08-27', in_registry: 0 },
  { alert_number: '030A/2025', product_name: 'Artemetrin DS Tablets 80/480mg', nafdac_number: 'A4-3164', batches: ['Q011G'], hazard: 'Substandard: 59.2% artemether / 71.2% lumefantrine vs 90-110% limits', alert_type: 'safety_alert', manufacturer: 'A.C. Drugs Ltd', source_url: 'https://nafdac.gov.ng/public-alert-no-030a-2025-sale-of-confirmed-substandard-artemetrin-ds-tablets/', alert_date: '2025-09-19', in_registry: 1 },
  { alert_number: '030B/2025', product_name: 'Ciprofit 500 Tablets', nafdac_number: '04-7405', batches: ['all'], hazard: 'Falsified: 5.7% ciprofloxacin content', alert_type: 'safety_alert', manufacturer: 'Impact Pharmaceutical Ltd (stated)', source_url: 'https://nafdac.gov.ng/updated-public-alert-no-030b-2025-sale-of-confirmed-falsified-ciprofit-500/', alert_date: '2025-09-19', in_registry: 0 },
  { alert_number: '024/2025', product_name: 'Amoxivue Amoxicillin 500mg Capsules', nafdac_number: 'A4-100178', batches: ['322584'], hazard: 'Recall: significantly low API content', alert_type: 'recall', manufacturer: 'Sparsh Bio-Tech Pvt Ltd', source_url: 'https://nafdac.gov.ng/public-alert-no-024-2025-recall-of-amoxivue-amoxicillin-500mg-capsules-due-to-significantly-low-active-pharmaceutical-ingredient-api-content/', alert_date: '2025-08-06', in_registry: 0 },
  { alert_number: '35/2025', product_name: 'Annmox Amoxicillin Suspension 125mg/5ml', nafdac_number: 'A11-0329', batches: ['360M'], hazard: 'Substandard: low API content; mop-up ordered', alert_type: 'safety_alert', manufacturer: 'Jawa International Ltd', source_url: 'https://nafdac.gov.ng/public-alert-no-35-2025-substandard-batches-of-annmox-amoxicillin-suspensions-125mg-5ml-and-jawamox-amoxicillin-suspension-125mg-5ml-manufactured-by-jawa-international-ltd-due-to-low-ac/', alert_date: '2025-10-22', in_registry: 1 },
  { alert_number: '35/2025', product_name: 'Jawamox Amoxicillin Suspension 125mg/5ml', nafdac_number: '04-1139', batches: ['4290M', '4231M'], hazard: 'Substandard: low API content; mop-up ordered', alert_type: 'safety_alert', manufacturer: 'Jawa International Ltd', source_url: 'https://nafdac.gov.ng/public-alert-no-35-2025-substandard-batches-of-annmox-amoxicillin-suspensions-125mg-5ml-and-jawamox-amoxicillin-suspension-125mg-5ml-manufactured-by-jawa-international-ltd-due-to-low-ac/', alert_date: '2025-10-22', in_registry: 1 },
  { alert_number: '34/2025', product_name: 'Astamocil Amoxicillin Suspension 125mg/5ml', nafdac_number: 'A4-8681', batches: ['826024'], hazard: 'Substandard batch; mop-up ordered', alert_type: 'safety_alert', manufacturer: 'Sam-Ace Ltd', source_url: 'https://nafdac.gov.ng/public-alert-no-34-2025-substandard-astamocil-amoxicillin-suspension-125mg-5ml-batch-no-826024-and-astamentin-amoxicillin-clavulanic-acid-suspension-batch-nos-0503024-0501724/', alert_date: '2025-10-22', in_registry: 0 },
  { alert_number: '34/2025', product_name: 'Astamentin Amoxicillin/Clavulanic Acid Suspension', nafdac_number: 'A11-0341', batches: ['0501724', '0503024'], hazard: 'Substandard batches; mop-up ordered', alert_type: 'safety_alert', manufacturer: 'Sam-Ace Ltd', source_url: 'https://nafdac.gov.ng/public-alert-no-34-2025-substandard-astamocil-amoxicillin-suspension-125mg-5ml-batch-no-826024-and-astamentin-amoxicillin-clavulanic-acid-suspension-batch-nos-0503024-0501724/', alert_date: '2025-10-22', in_registry: 0 },
  { alert_number: '023/2026', product_name: 'Projeanil / Re-granil Proguanil 100mg', nafdac_number: '04-6433', batches: ['BN600'], hazard: 'Counterfeit: printed NRN 04-6433 belongs to Feroglobin B12 Capsules', alert_type: 'safety_alert', manufacturer: 'Apple King Industry / Jamila Export Lab (stated)', source_url: 'https://nafdac.gov.ng/public-alert-no-023-2026-alert-on-counterfeit-brands-of-proguanil-projeanil-and-re-granil-tablet-b-p-100mg-with-fake-nafdac-registration-number-04-6433-found-in-nigeria/', alert_date: '2026-03-25', in_registry: 0 },
  { alert_number: '019/2026', product_name: 'Otrivin Nasal Drops 0.05% Children', nafdac_number: '04-5350', batches: ['7U8T (counterfeit)'], hazard: 'Mop-up of all Otrivin; counterfeit batch in circulation', alert_type: 'safety_alert', manufacturer: 'Novartis (genuine)', source_url: 'https://nafdac.gov.ng/public-alert-no-019-2026-alert-on-mop-up-of-all-otrivin-nasal-drops-0-05-and-0-1/', alert_date: '2026-03-14', in_registry: 0 },
  { alert_number: '05/2025', product_name: 'Cikatem Suspension 180/1080mg', nafdac_number: 'A11-100025', batches: ['ALS063'], hazard: 'Falsified: printed NRN belongs to Cikatem Tablet 20/120mg, not the suspension', alert_type: 'safety_alert', manufacturer: 'Michelle Laboratories (stated)', source_url: 'https://nafdac.gov.ng/public-alert-no-05-2025-alert-on-the-circulation-of-falsified-cikatem-artemether-180mg-lumefantrine-1080mg-with-falsified-nafdac-registration-number-nrn-a11-100025/', alert_date: '2025-03-11', in_registry: 0 },
  { alert_number: '035/2026', product_name: 'Menofix Composition', nafdac_number: null, batches: [], hazard: 'Unregistered product on sale (no NRN exists)', alert_type: 'safety_alert', manufacturer: null, source_url: 'https://nafdac.gov.ng/public-alert-no-035-2026-alert-on-the-marketing-and-sale-of-unregistered-menofix-composition/', alert_date: '2026-07-18', in_registry: 0 },
  { alert_number: '020/2026', product_name: 'ViroActive+ (purported HIV cure)', nafdac_number: null, batches: [], hazard: 'Unregistered drug with false curative claims', alert_type: 'safety_alert', manufacturer: null, source_url: 'https://nafdac.gov.ng/public-alert-no-020-2026-alert-on-unregistered-viroactive-drug-purported-to-cure-hiv/', alert_date: '2026-03-14', in_registry: 0 },
  { alert_number: '03/2026', product_name: 'Risperdal 2mg Tablets (unauthorized brand)', nafdac_number: null, batches: [], hazard: 'Unauthorized/unregistered brand formulation', alert_type: 'safety_alert', manufacturer: 'Johnson & Johnson (genuine holder)', source_url: 'https://nafdac.gov.ng/public-alert-no-03-2026-alert-on-the-circulation-of-an-unauthorized-and-unregistered-risperdal-2-mg-tablets-brand-formulation-in-nigeria/', alert_date: '2026-01-09', in_registry: 0 },
];

const db = new DatabaseSync(dbPath);
ensureHazardTable(db);
db.prepare('DELETE FROM hazard_alerts').run();
const insert = db.prepare(`
  INSERT INTO hazard_alerts (alert_number, product_name, nafdac_number, batches, hazard, alert_type, manufacturer, source_url, alert_date, in_registry)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const alert of alerts) {
  insert.run(
    alert.alert_number, alert.product_name, alert.nafdac_number,
    JSON.stringify(alert.batches), alert.hazard, alert.alert_type,
    alert.manufacturer, alert.source_url, alert.alert_date, alert.in_registry,
  );
}
console.log(JSON.stringify({ database: dbPath, hazard_alerts: alerts.length }, null, 2));
db.close();
