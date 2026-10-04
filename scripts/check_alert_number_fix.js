// Quick regression check for the alert-number parser fix.
const p = require('./nafdac_alert_parser.js');

const cases = [
  ['Public Alert No. 0037/2022 - European Rapid Alert System', null, '0037/2022'],
  ['Public Alert No. 043/2026-NAFDAC Places Products', null, '043/2026'],
  ['Public Alert No.35/2025 - Alert on Recall', null, '035/2025'],
  ['Updated Public Alert No. 030A/2025 - Sale of Substandard', null, '030A/2025'],
  ['Public Alert No:0043 - Products Contaminated With Ethylene Glycol', '2022-08-01', '0043/2022'],
  ['Public Alert No. 42 - NAFDAC Alert And Sensitization', '2023-01-15', '042/2023'],
  ['Public Alert 003/2022 - Recall of Clobetasol', null, '003/2022'],
  ['Public Alert 0011/2022 - TCP HOT Acquisition', null, '0011/2022'],
  ['Public Alert: 019/2022 - Recall of Hugold CBD Oil', null, '019/2022'],
  ['Public Alert 018/2022 - Recall of Diazepam Retubes', null, '018/2022'],
  ['Public Alert: 012/2022 - Australia ACCC', null, '012/2022'],
  ['no number here', null, '012/2026'],
  ['Regulatory Clarification on Deleject Disposable Needle Public Alert', null, '012/2026'],
];

let fail = 0;
for (const [title, date, want] of cases) {
  const got = p.alertNumberFromTitleOrUrl(title, 'https://nafdac.gov.ng/public-alert-no-12-2026-something/', date);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${String(got).padEnd(10)} want ${String(want).padEnd(10)} ${title.slice(0, 58)}`);
}
console.log(fail ? `\n${fail} failing` : `\nall ${cases.length} passing`);
process.exit(fail ? 1 : 0);
