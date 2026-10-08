// Asserts the registration-number rules in scripts/number_normalize.js.
//
// This suite exists because the old pattern was drug-only and silently wrong in
// both directions: it rejected the listed/herbal `...L` suffix series and every
// dash-and-space printing, and it accepted month fragments. Every case below is
// a real value — either a row in the shipped database or a shape measured from
// the live NAFDAC Food Products Database.
//
// No network, no database, no server: the module under test is pure.
//   node scripts/test_numbers.js
const assert = require('assert');
const { normalizeNumber, isPlausibleNumber, isPlausibleRegistrationNumber, describeRejection } = require('./number_normalize');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n        ${err.message}`);
  }
}

function assertAll(value, expected, label) {
  assert.deepStrictEqual(value, expected, `${label}: got ${JSON.stringify(value)}, want ${JSON.stringify(expected)}`);
}

// 1. Numbers that NAFDAC actually prints and the old pattern rejected, because
//    they are rows in our own shipped snapshot. Rejecting these is the live bug
//    this work fixes: the vision path read the number, then told the user it was
//    invalid.
check('listed/herbal letter-suffix series is accepted', () => {
  assertAll(
    ['A7-2363L', 'A7-2366L', 'A7-2373L', 'A7-4147L', 'A7-4942L', 'A1-4924L', 'A4-4479L'].map(isPlausibleNumber),
    [true, true, true, true, true, true, true],
    'A-series with trailing L'
  );
});

check('en-dash, em-dash and spaced printings are accepted', () => {
  assertAll(
    ['04 – 1486', '04–1324', '04 – 1486', 'A4 - 5180', '04 - 1508', '04- 9502'].map(isPlausibleNumber),
    [true, true, true, true, true, true],
    'dash variants'
  );
});

check('the dominant food series from the live feed is accepted', () => {
  assertAll(
    ['A8-102316L', 'A8-5412L', 'A8-102426L', 'A5-102316L'].map(isPlausibleNumber),
    [true, true, true, true],
    'A8-/A5- food series'
  );
});

check('plain drug numbers still validate', () => {
  assertAll(
    ['A11-0009', 'A4-9040', '04-0858', 'A4-100178', 'A11-100025', '04-7405'].map(isPlausibleNumber),
    [true, true, true, true, true, true],
    'classic drug shapes'
  );
});

// 2. Junk. The old pattern's `[A-Z0-9]{1,3}` prefix would happily match a month.
check('junk in the food number column is rejected', () => {
  assertAll(
    ['Aug', 'Jan', 'FCT', 'N', 'G', 'NCZ', 'SWZ', '83618', '', '   ', '2 X 7', 'Not available yet', 'NA'].map(isPlausibleNumber),
    [false, false, false, false, false, false, false, false, false, false, false, false, false],
    'food-feed junk'
  );
});

check('rejections carry a reason', () => {
  assertAll(
    ['', '   ', 'Aug', 'Not available yet', 'NA', 'A8-102316L'].map(describeRejection),
    ['blank', 'blank', 'wrong_shape', 'not_a_number', 'not_a_number', null],
    'describeRejection'
  );
});

check('a bare barcode is not a registration number', () => {
  assert.strictEqual(isPlausibleNumber('8901234567890'), false, '12-13 digit barcode');
  assert.strictEqual(isPlausibleNumber('4006381333931'), false, '13 digit EAN');
});

// 3. Normalisation is what makes the exact lookup work again. These pairs are
//    the same number printed two ways and MUST canonicalise identically.
check('normalisation collapses printing differences', () => {
  assertAll(
    ['04 – 1486', '04-1486', '04 - 1486', '  04-1486  '].map(normalizeNumber),
    ['04-1486', '04-1486', '04-1486', '04-1486'],
    'normalizeNumber'
  );
  assert.strictEqual(normalizeNumber('a7-2363l'), 'A7-2363L', 'lowercase input');
  assert.strictEqual(normalizeNumber(null), '', 'null');
});

check('normalisation does not merge genuinely different numbers', () => {
  assert.notStrictEqual(normalizeNumber('A4-9040'), normalizeNumber('A4-9041'), 'adjacent numbers stay distinct');
  assert.notStrictEqual(normalizeNumber('A8-102316L'), normalizeNumber('A8-102316'), 'suffix is significant');
  assert.notStrictEqual(normalizeNumber('04-1486'), normalizeNumber('A4-1486'), 'series prefix is significant');
});

check('normalisation round-trips through validation', () => {
  for (const raw of ['A7-2363L', '04 – 1486', '04- 9502', 'A8-102316L']) {
    const canonical = normalizeNumber(raw);
    assert.strictEqual(isPlausibleNumber(canonical), true, `${raw} -> ${canonical} should validate`);
    assert.strictEqual(normalizeNumber(canonical), canonical, `${canonical} should be a fixed point`);
  }
});

// 4. Kenya keeps its own family. PPB numbers use slashes and no letter-series
//    prefix, so they must never be fed through the NG pattern.
check('Kenyan PPB numbers validate under KE, not NG', () => {
  assertAll(
    ['CTD2718/R1', 'H2016/CTD2476/275/R1', '10737/R1', '11968'].map((n) => isPlausibleRegistrationNumber(n, 'KE')),
    [true, true, true, true],
    'KE route'
  );
  assertAll(
    ['CTD2718/R1', 'H2016/CTD2476/275/R1'].map((n) => isPlausibleRegistrationNumber(n, 'NG')),
    [false, false],
    'NG route must not accept PPB shapes'
  );
});

check('country defaults to NG and is case-insensitive', () => {
  assert.strictEqual(isPlausibleRegistrationNumber('A7-2363L'), true, 'no country');
  assert.strictEqual(isPlausibleRegistrationNumber('A7-2363L', 'ng'), true, 'lowercase ng');
  assert.strictEqual(isPlausibleRegistrationNumber('CTD2718/R1', 'ke'), true, 'lowercase ke');
});

// 5. The distinction that keeps this honest: normalisation decides how to
//    compare, validation decides whether to trust. Free text must survive
//    normalisation as text and still fail validation, rather than being mangled
//    into something that looks like a registration number.
check('free text is never mangled into a plausible number', () => {
  assert.strictEqual(normalizeNumber('Not available yet'), 'NOTAVAILABLEYET', 'normalised but still text');
  assert.strictEqual(isPlausibleNumber('Not available yet'), false, 'and still not trusted');
  assert.strictEqual(describeRejection('Not available yet'), 'not_a_number', 'reported as such');
});

check('validation never accepts a shape with a digit suffix run too long', () => {
  assert.strictEqual(isPlausibleNumber('A8-12345678'), false, '8 digits');
  assert.strictEqual(isPlausibleNumber('A8-1234567'), true, '7 digits is in range');
});

console.log(`\n${passed}/${passed + failed} number tests passed`);
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
