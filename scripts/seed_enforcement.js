const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../config');
const { ensureEnforcementTable } = require('./enforcement_schema');

// Enforcement actions and lab cases — real, regulator-attributed evidence that
// is not a numbered public alert. See scripts/enforcement_schema.js for why this
// is a separate table rather than a row in `hazard_alerts`.
//
// Every row below was written from a source that was opened and read, not from
// a social-media "fake products" list. Each carries its publisher and URL so a
// reader can check it. Two rules are enforced by test:library:
//
//   * No row may claim an alert number. NAFDAC did not publish one for any of
//     these, so we do not invent one.
//   * A row we could not substantiate is stored with finding_status
//     'not_a_finding' instead of being dropped or dressed up as a hazard. Those
//     rows are never shown to users; they exist so the negative result is
//     recorded once, with its reason, and not quietly reinvented later.

const ACTIONS = [
  // ---------------- Enforcement actions ----------------
  {
    action_key: 'aba-2024-12-15',
    authority: 'NAFDAC',
    action_date: '2024-12-15',
    location: 'Aba Cemetery Market, Abia State, Nigeria',
    summary:
      'Operation Clean Up Aba: NAFDAC searched 240 shops at Aba Cemetery Market that were operating as illegal ' +
      'factories, seized counterfeit food and drink worth about ₦5bn and destroyed over 1,500 cartons.',
    brands: [
      'Fanta', 'Coca-Cola', 'Schweppes', 'Lacasera', 'Sprite', 'Hollandia Yoghurt',
      'Hollandia', 'Super Commando Energy Drink', 'Super Commando', 'Fayrouz',
      'Amstel Malt', 'Peak Sachet Milk', 'Peak', 'Cowbell Sachet Milk', 'Cowbell',
      'Peak Chocolate Drink', 'Miksi Sachet Milk', 'Miksi', 'Cadbury Chocolate Drink',
      'Cadbury', 'Ovaltine', 'Eva Non-Alcoholic Drink', 'Eva', 'Evra Non-Alcoholic Drink',
      'Evra', 'Cartel', 'Seaman Schnapps', 'Hennessy', 'Four Cousins', 'Carlo Rossi',
      'Chelsea London Dry Gin', 'McDowells', 'Black Label', "Gordon's", 'Martell',
      'Campari', 'Smirnoff Ice',
    ],
    finding_status: 'action_taken',
    evidence_note:
      'NAFDAC described the method: contaminated water, hazardous chemicals, saccharin, artificial colouring ' +
      'and re-used dirty bottles with cloned packaging; alcohol adulterated with sugar and starch instead of ' +
      'fruit. This is one press statement about one raid — it evidences that counterfeits of these brands ' +
      'exist, but it names no batches and no alert number, so it can never support a batch-level verdict. ' +
      'The DG statement also lists "Jenney" alongside Hennessy, which appears to be a transcription error; ' +
      'it is not treated as a separate brand here.',
    source_url: 'https://acnntv.com/health-risk-alert-nafdac-shuts-down-250-factories-making-fake-beverages-in-abia/',
    source_publisher: 'ACNNTV, quoting the NAFDAC Director-General’s statement to PUNCH Healthwise',
  },
  {
    action_key: 'aba-hollandia-revalidation-2025-01-22',
    authority: 'NAFDAC',
    action_date: '2025-01-22',
    location: 'Aba, Abia State, Nigeria',
    summary:
      'Three warehouses in Aba were found stockpiling expired Hollandia Yoghurt for illegal revalidation — ' +
      're-labelling old stock with fresh dates.',
    brands: ['Hollandia Yoghurt'],
    finding_status: 'action_taken',
    evidence_note:
      'A distinct fraud mode from counterfeiting: genuine-looking packaging carrying an expiry date the ' +
      'manufacturer did not set. Follow-up to the 15 Dec 2024 Aba operation.',
    source_url: 'https://acnntv.com/health-risk-alert-nafdac-shuts-down-250-factories-making-fake-beverages-in-abia/',
    source_publisher: 'ACNNTV, quoting the NAFDAC Director-General’s statement to PUNCH Healthwise',
  },
  {
    action_key: 'nasarawa-rice-2024-12',
    authority: 'NAFDAC',
    action_date: '2024-12-20',
    location: 'Karu Local Government Area, Nasarawa State, Nigeria',
    summary:
      'NAFDAC shut down eight rice shops and a warehouse seizing over 1,600 bags of counterfeit rice worth ' +
      'about ₦5bn, and extended the raid to Wuse and Garki markets in Abuja.',
    brands: ['Big Bull Rice', 'Big Bull', 'Royal Stallion Rice', 'Royal Stallion', 'Tomato Aposo Rice', 'Tomato Aposo'],
    finding_status: 'action_taken',
    evidence_note:
      'The fraud here is bag repackaging, not a counterfeit formulation: authentic rice from questionable ' +
      'sources was rebagged into branded sacks. NAFDAC also destroyed empty branded bags held for ' +
      'repackaging. Reported 20 Dec 2024; the operation itself ran in the second half of December 2024.',
    source_url: 'https://thesun.ng/nafdac-busts-warehouse-shops-seizes-n5bn-counterfeit-rice-in-nasarawa/',
    source_publisher: 'The Sun, quoting NAFDAC',
  },
  {
    action_key: 'rivers-rice-2025-03',
    authority: 'NAFDAC',
    action_date: '2025-03-20',
    location: 'Port Harcourt (Woji, Mile 3, Mile 1 markets), Rivers State, Nigeria',
    summary:
      'NAFDAC, working with the producer of Big Bull Rice, raided shops in Port Harcourt and seized over 120 ' +
      'counterfeit bags from more than 10 shops, along with empty counterfeit Big Bull Rice bags held for ' +
      'repacking and the tools to do it.',
    brands: ['Big Bull Rice', 'Big Bull', 'Cap Rice', 'Stallion Rice', 'Tomato Rice', 'Mama Pride'],
    finding_status: 'action_taken',
    evidence_note:
      'NAFDAC’s Rivers State Coordinator gave the features that distinguish genuine Big Bull Rice: a distinct ' +
      'shiny ribbon across the threaded top, better bag quality and an authentic logo. Treat that as the ' +
      'agency’s own guidance, not as a laboratory finding. Cap Rice, Stallion Rice, Tomato Rice and Mama ' +
      'Pride were named as "other rice brands" present at a shop trading counterfeit Big Bull — being named ' +
      'is not the same as having been individually tested.',
    source_url: 'https://punchng.com/nafdac-seizes-120-bags-of-counterfeit-rice-in-rivers/',
    source_publisher: 'Punch, quoting NAFDAC',
  },
  {
    action_key: 'dr-really-extra-2019-03',
    authority: 'NAFDAC',
    action_date: '2019-03-29',
    location: 'Nigeria',
    evidence_class: 'destruction_and_lab_case',
    summary:
      'NAFDAC destroyed 190 cartons of diclofenac tablets at a general destruction exercise, listed in the ' +
      'Director-General’s speech as "De Really Extra" — an unregistered diclofenac brand sold door to door.',
    brands: ['Dr. Really', 'Dr. Really Extra', 'De Really Extra', 'Really Extra Diclofenac 50mg'],
    finding_status: 'action_taken',
    evidence_note:
      'CAREFUL — this is a lookalike pair and the copy must not imply the original is safe. Dr. Really Extra ' +
      'is an unregistered copycat of Yef Real Extra, which is genuinely registered as NAFDAC A11-0298. ICIR ' +
      'bought Dr. Really Extra from a door-to-door seller and had it analysed at the College of Medicine, ' +
      'University of Lagos (certificate 12 Apr 2019): it passed the active-ingredient assay, but NAFDAC’s ' +
      'analyst called it an illegal, criminally produced product with no manufacturer address, unregistered ' +
      'and undated, with no NAFDAC number, batch number or expiry date on the pack or blister. Separately, ' +
      'the registered original Yef Real Extra itself failed its own assay below the 90–110% specification. ' +
      'NAFDAC’s speech spells the brand "De Really Extra"; the laboratory investigation spells it "Dr. Really ' +
      'Extra". Both spellings are recorded so either finds this row.',
    source_url: 'https://www.icirnigeria.org/toxic-tablets-counterfeit-pills-i-killer-drugs-that-damage-nigerians-health/',
    source_publisher: 'ICIR investigation (28 Jun 2019), citing NAFDAC’s 29 Mar 2019 destruction-exercise speech',
  },

  // ---------------- Looked, found nothing ----------------
  // These never reach a user. They record the negative result and the reason, so
  // the same names are not researched again or, worse, quietly turned into a
  // hazard claim later.
  {
    action_key: 'ndlea-tramadol-2022-10',
    authority: 'NDLEA',
    action_date: '2022-10-09',
    location: 'Lagos airport, Nigeria',
    evidence_class: 'law_enforcement_seizure',
    summary:
      'NDLEA intercepted 2.4 million tramadol tablets smuggled from Pakistan: 7 cartons of 250mg branded ' +
      '"Tamral" and 45 cartons of 225mg branded "TramaKing".',
    brands: ['Tamral', 'TramaKing', 'New Royal', 'New Tramadol'],
    finding_status: 'not_a_finding',
    evidence_note:
      'NOT a product-quality finding, so it must not enter the regulator register. NDLEA is a law-enforcement ' +
      'body, not a product regulator, and an interception of an illicit opioid at the border says nothing ' +
      'about the quality of any pack on a Nigerian shelf. The documented Tamral strength is 250mg; the ' +
      '"Tamral 225mg" seen in viral lists appears to be a confusion with the TramaKing 225mg line.',
    source_url: 'https://www.thecable.ng/ndlea-intercepts-2-4m-tramadol-tablets-smuggled-from-pakistan-at-lagos-airport/',
    source_publisher: 'TheCable',
  },
  {
    action_key: 'unsubstantiated-reliance-extra',
    authority: 'none found',
    action_date: '2026-10-04',
    evidence_class: 'unsubstantiated_claim',
    summary:
      'A circulated list names "Reliance Extra Diclofenac 50mg" as counterfeit. No regulator source, alert, ' +
      'enforcement record or laboratory result for that name was found.',
    brands: ['Reliance Extra Diclofenac 50mg'],
    finding_status: 'not_a_finding',
    evidence_note:
      'It appears only inside recycled social-media compilations. Possibly a transcription of "Reliance ' +
      'Diclofenac". Recorded so it is not re-researched; a lead is not a verdict and must never be shown ' +
      'as a hazard.',
    source_url: 'research/RESEARCH_FINDINGS.md',
    source_publisher: 'Vouch research, 4 Oct 2026 — no regulator source located',
  },
  {
    action_key: 'unsubstantiated-oral-b',
    authority: 'NAFDAC',
    action_date: '2026-10-04',
    evidence_class: 'naming_confusion',
    summary:
      'A circulated list names "Oral-B" as a counterfeit toothbrush. NAFDAC’s counterfeit toothpaste alert ' +
      '041/2026 is for ORACIRE+, not Oral-B.',
    brands: ['Oral-B'],
    finding_status: 'not_a_finding',
    evidence_note:
      'The confusion has a documented cause: NAFDAC published the photos for alert 041/2026 under filenames ' +
      'beginning "OralB", a naming slip on their side. Adding Oral-B as an alias of that alert would ' +
      'wrongly implicate a genuine brand, so the matcher is deliberately left not to match it.',
    source_url: 'https://nafdac.gov.ng/public-alert-no-041-2026-alert-on-suspected-counterfeit-oracire-toothpaste/',
    source_publisher: 'NAFDAC alert 041/2026 (photo filenames)',
  },
];

function main() {
  const dbPath = path.resolve(process.env.DATABASE_PATH || databasePath);
  const db = new DatabaseSync(dbPath);
  ensureEnforcementTable(db);

  const insert = db.prepare(`
    INSERT INTO enforcement_actions
      (action_key, authority, action_date, location, evidence_class, summary, brands,
       finding_status, evidence_note, source_url, source_publisher, source_country)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (action_key) DO UPDATE SET
      authority = excluded.authority,
      action_date = excluded.action_date,
      location = excluded.location,
      evidence_class = excluded.evidence_class,
      summary = excluded.summary,
      brands = excluded.brands,
      finding_status = excluded.finding_status,
      evidence_note = excluded.evidence_note,
      source_url = excluded.source_url,
      source_publisher = excluded.source_publisher
  `);

  for (const action of ACTIONS) {
    insert.run(
      action.action_key,
      action.authority,
      action.action_date,
      action.location ?? null,
      action.evidence_class || 'enforcement_action',
      action.summary,
      JSON.stringify(action.brands || []),
      action.finding_status || 'action_taken',
      action.evidence_note ?? null,
      action.source_url,
      action.source_publisher,
      action.source_country || 'NG'
    );
  }

  const totals = db
    .prepare(
      `SELECT finding_status, COUNT(*) AS rows FROM enforcement_actions GROUP BY finding_status`
    )
    .all();
  const brands = db
    .prepare("SELECT brands FROM enforcement_actions WHERE finding_status = 'action_taken'")
    .all()
    .reduce((n, row) => n + JSON.parse(row.brands).length, 0);

  console.log(
    JSON.stringify(
      { database: dbPath, seeded: ACTIONS.length, by_status: totals, brands_indexed: brands },
      null,
      2
    )
  );
  db.close();
}

if (require.main === module) main();
module.exports = { ACTIONS };