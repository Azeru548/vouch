// Normalising and validating registration numbers.
//
// This module is deliberately pure — no database, no network — so it can be
// required by server.js, the ingesters, the migration and the test suites
// without any of them pulling in a side effect. It follows the same shape as
// naf_dac_alert_parser.js.
//
// Why this exists: `NAFDAC_RE = /^[A-Z0-9]{1,3}-\d{3,6}$/` was written against
// drug registrations and is still in the vision path, where it decides whether
// a number read off a photo is trusted. Run against the real corpus it is
// wrong in both directions:
//
//   - It REJECTS numbers NAFDAC actually prints. `A7-2363L` (good morning cough
//     tablets) and `A4-4479L` (donistrep) are in our own shipped snapshot. So
//     are `04 – 1486` (en-dash) and `04- 9502` (internal space). Photograph a
//     Ponstan pack, the model reads the number correctly, and the app then tells
//     the user the number it just read is invalid.
//   - It ACCEPTS things that are not registration numbers, because
//     `[A-Z0-9]{1,3}` will happily take a month name.
//
// The trailing-letter series matters most. NAFDAC uses a letter suffix for
// listed and herbal-style registrations, and the dominant food series is `A8-`,
// almost always written `A8-102316L`. A digit-anchored `$` rejects every one.
// Measured against the live Food Products Database: 20,257 of 28,481 food rows
// (71.1%) fail the old pattern.
//
// The fix is two separate jobs, kept separate on purpose:
//
//   normalizeNumber()   -> canonical form, so two printings of one number
//                          compare equal (exact match stays exact).
//   isPlausibleNumber() -> is this a shaped registration number at all, or junk?
//
// These must NOT be collapsed into one function. Normalisation decides how to
// compare; validation decides whether to trust. A row whose number column holds
// `Not available yet` must survive normalisation as text and still fail
// validation, rather than being mangled into `NOTAVAILABLEYET` and then stored
// as though it were a registration.

// Unicode dashes seen on packs and in the source data: hyphen-minus, the
// en/em dash block, minus sign, and the small/fullwidth forms printers emit.
const DASHES = /[\u002D\u058A\u05BE\u1400\u1806\u2010-\u2015\u2E17\u2E1A\u2E3A\u2E3B\u2E40\u301C\u3030\u30A0\uFE31\uFE32\uFE58\uFE63\uFF0D]/g;

/**
 * Canonical form of a registration number: uppercase, all whitespace removed,
 * every dash folded to a plain hyphen.
 *
 * `04 – 1486`, `04-1486` and `04 - 1486` all become `04-1486`, so an exact
 * string comparison finds them. That exactness is deliberate — normalising here
 * fixes formatting differences, it does NOT make lookalike numbers match.
 *
 * Non-numeric free text is passed through uppercased but is never treated as a
 * number by isPlausibleNumber().
 */
function normalizeNumber(value) {
  if (value == null) return '';
  return String(value).replace(DASHES, '-').replace(/\s+/g, '').toUpperCase();
}

// A registration number is an optional short alphanumeric series prefix, a
// hyphen, digits, and an optional letter suffix (the listed/herbal `...L`
// series). Both halves are optional-ish only in the sense that both real
// families are covered:
//
//   A11-0009      A4-9040       imported drugs
//   04-0858                       locally manufactured drugs
//   A8-102316L    A8-5412L      food (listed series, dominant in the food feed)
//   A7-2363L      A4-4479L      herbals / listed
//   A4-100178                    expanded six-digit numbering
//
// Anchored at both ends so month fragments (`Aug`, `Jan`), bare numerics
// (`83618`) and free text are rejected rather than half-matched.
const NUMBER_RE = /^[A-Z0-9]{1,4}-\d{2,7}[A-Z]?$/;

// Free text that occupies a number column upstream but is not a registration.
// Matched against the normalised value so `Not available yet` is caught whether
// or not the source had spaces in it.
const NOT_A_NUMBER = [
  /^N$/,
  /^N\/?A$/,
  /^NA$/,
  /^NONE$/,
  /^NULL$/,
  /^NOTAVAILABLEYET$/,
  /^NOTAVAILABLE$/,
  /^UNAVAILABLE$/,
  /^PENDING$/,
  /^CHECKNRN$/,
  /^CHECKREGNO$/,
  /^TBH$/,
];

/**
 * Is this a shaped registration number?
 *
 * Used to gate `format_valid` on the vision path and to filter junk on ingest.
 * It is NOT a validity oracle: a number can pass this and still be a counterfeit
 * that was never registered. It only answers "is this string shaped like a
 * registration number".
 */
function isPlausibleNumber(value) {
  const normalized = normalizeNumber(value);
  if (normalized === '') return false;
  if (NOT_A_NUMBER.some((re) => re.test(normalized))) return false;
  return NUMBER_RE.test(normalized);
}

/**
 * The Kenya (PPB) rule, unchanged in behaviour.
 *
 * PPB registration numbers are a different family entirely — `CTD2718/R1`,
 * `H2016/CTD2476/275/R1`, `10737/R1` — with slashes and no letter-series
 * prefix, so they are validated separately and never fed through NUMBER_RE.
 */
const PPB_RE = /^[A-Z0-9][A-Z0-9/.-]{2,31}$/;

function isPlausiblePpbNumber(value) {
  const normalized = normalizeNumber(value);
  if (normalized === '') return false;
  if (NOT_A_NUMBER.some((re) => re.test(normalized))) return false;
  return PPB_RE.test(normalized);
}

/**
 * Country-aware entry point, so callers do not have to remember which family a
 * given country uses.
 */
function isPlausibleRegistrationNumber(value, country = 'NG') {
  return String(country).trim().toUpperCase() === 'KE'
    ? isPlausiblePpbNumber(value)
    : isPlausibleNumber(value);
}

/**
 * Junk rows are filtered on ingest rather than silently dropped: the caller
 * counts them so a run summary can report what was skipped and why.
 */
function describeRejection(value) {
  const normalized = normalizeNumber(value);
  if (normalized === '') return 'blank';
  if (NOT_A_NUMBER.some((re) => re.test(normalized))) return 'not_a_number';
  if (!NUMBER_RE.test(normalized)) return 'wrong_shape';
  return null;
}

module.exports = {
  normalizeNumber,
  isPlausibleNumber,
  isPlausiblePpbNumber,
  isPlausibleRegistrationNumber,
  describeRejection,
  NUMBER_RE,
  PPB_RE,
};
