# Category expansion — beyond pharmaceuticals

Written 4 Oct 2026. Planning document, not shipped code. Every number below was
**measured live**, not estimated — the commands that produced them are in
`recon/` and the fixtures are re-runnable.

**Scope of this plan:** Nigeria only. Food and cosmetics are the target
categories. Kenya (PPB) is deliberately excluded so the expansion stays tractable
and the `source_country` integrity rule stays trivially auditable.

---

## 1. Where the project actually stands

The registry is not "mostly pharma" — it is **exclusively** pharma:

| Country | Category | Rows |
|---|---|---|
| NG | Drugs | 7,483 |
| NG | Medical devices | 1,112 |
| NG | Vaccines and Biologics | 153 |
| NG | Herbals and Nutraceuticals | 128 |
| NG | Veterinary | 93 |
| NG | N/A | 11 |
| KE | *(null — human medicines only)* | 3,235 |

**Zero food, cosmetic, chemical or household rows.** Confirmed twice — once
against the live `products` table and once against the raw Greenbook dump in
`recon/full_dump_8977.json`, whose `category_name` field contains exactly six
values (Drugs 7,480 · Medical devices 1,112 · Vaccines 153 · Herbals 128 ·
Veterinary 93 · N/A 11). Food is simply not in the Greenbook.

So this is not a tuning exercise. **It is a new data source**, and finding that
source was the whole point of the scout.

The alert side is the opposite — it already spans categories, but barely:

```
NG drug 398   KE drug 161   NG food 3   NG cosmetic 2
```

Five non-drug entries out of 564. Food coverage in the UI is a rounding error.

---

## 2. Source found: the Food Products Database

NAFDAC publishes a **Food Products Database** at
`https://nafdac.gov.ng/food-products-database/`. The page is a WordPress shell —
no rows in the server-rendered HTML — but it embeds a **Ninja Tables** config
pointing at a public AJAX endpoint:

```
https://nafdac.gov.ng/wp-admin/admin-ajax.php
  ?action=wp_ajax_ninja_tables_public_action
  &table_id=19494
  &target_action=get-all-data
  &default_sorting=old_first
  &skip_rows=0&limit_rows=0
  &ninja_table_public_nonce=<nonce scraped from the page>
  &chunk_number=<0..>
```

This is the **same Ninja/Foo pattern the existing alert sync already parses**, so
the machinery is familiar. Requirements, all verified:

- a browser-like `User-Agent` (bare fetches get **406** — same as the alert page)
- `X-Requested-With: XMLHttpRequest` and a `Referer` of the page
- the nonce, scraped per fetch — **it is not stable and must not be hardcoded**
- pagination via `chunk_number`, **3,000 rows per chunk**, terminating on an
  empty chunk

### Measured shape

| Metric | Value |
|---|---|
| Total rows fetched | **28,481** (chunks 0–9; chunk 10 returns 0 = exhausted) |
| Unique `___id___` | 28,481 — no id collisions across chunk boundaries |
| **Distinct records** | **20,216 — 29.0% of fetched rows are exact duplicates** (see §3a) |
| Download size | ~1.78 MB per chunk, ~16 MB total |
| Fields | `productname`, `nafdacnumber`, `category`, `subcategory`, `packsize`, `presentation`, `applicantname`, `address`, `country`, `manufacturer`, `manufactureraddress`, `issuedate`, `expirydate`, `year`, `___id___` |
| Blank `nafdacnumber` | 962 (3.4%) |
| Issued | 2022 → 2025 only (3,122 / 4,791 / 8,189 / 11,417) |
| Expiry parseable | 27,031 (94.9%) |
| — still active at 2026-10-04 | **20,716 (76.6%)** |
| — lapsed | 6,315 (23.4%) |
| — unparseable/missing | 1,450 (5.1%) |
| **Imagery** | **None. The register has no image, photo or media field of any kind.** |

### 3a. The upstream feed is duplicated, and numbers are not unique

Two measured properties that change the ingestion and matching design:

**29% of rows are byte-identical duplicates.** Deduplicating on
`productname + nafdacnumber + subcategory + packsize + presentation +
applicantname + manufacturer + issuedate + expirydate` leaves **20,216 distinct
records**. The worst case is `A8-112507L` (VICTORIOX BREAD), which appears **63
times** — identical in all nine fields, including pack size `1000G`, applicant,
manufacturer and dates. Only the internal `___id___` differs.

This is upstream noise, not a data error on our side, but it must be collapsed
on ingest or the register will show the same bread 63 times. Keep the lowest
`___id___` per distinct record for traceability. Copy histogram: 18,684 records
appear once, 454 twice, 327 three times, and a long tail up to 63.

**A food registration number alone does not identify a product.** Of 25,906 rows
carrying a non-junk number, there are only 16,808 distinct numbers — **3,254
distinct numbers (19.4%) map to more than one row, covering 12,352 rows.** Even
`number + name` is not unique (3,074 pairs repeat). The disambiguator that does
work is the full tuple above, typically `number + name + pack_size`.

This is materially different from the drug register, where `/verify` looks up on
`nafdac` alone and gets away with it. **The food lookup must not assume a number
identifies one product** — see §6 Phase 2.

Subcategories are the real prize — this is a **taxonomy you can hang the UI on**
(full 28,481-row corpus, not a sample):

```
Beverages                      5,697
Bakery Wares                   4,486
Farm Produce                   4,393
Salts, Spices, Soups, Sauces…  1,992
Ready-to-Eat Savouries         1,951
Cereals and Cereal Products    1,549
Dairy Products and Analogues   1,387
Others                         1,384
Confectionery                  1,368
(blank)                          962
N/A                             949
Fats and oils, and Fat Emuls.   732
Fish and Fish Products           382
Sweeteners                      323
Fruits and Vegetables           167  +  "Fruits and vegetables"  162
Prepared Foods                  152  +  "Prepared foods"           32
Nutritional Foodstuffs          151
Salts, Spices, … and Protein    146
Edible Ices                      44
Meat and Meat Products           40
Eggs and Egg Products            24
Herbal Extracts with Vitamins     4
Vitamins &amp; Minerals only       2
NUTRACEUTICALS                    1
HERBAL                            1
```

Note the dirty edges a robust ingester must handle: `Fruits and Vegetables` vs
`Fruits and vegetables` differ only by case (167 + 162), `Prepared Foods` vs
`Prepared foods` again (152 + 32), `Vitamins &amp; Minerals` is unescaped HTML,
and there are free-text strays `NUTRACEUTICALS` / `HERBAL`. **Normalise
subcategory on ingest** — case-fold, trim, unescape entities, map the two stray
values — or the register's filter list will show near-duplicate buckets.

Junk in the number column is also present and must be filtered, not trusted.
Prefix distribution across all 28,481 rows:

```
A8  19,891      08      729      FCT     180
A5   2,818      Aug     429      N       179
A1     343      Jan     266      01      155
B1     307      G       344      C1      122
D1     277      NCZ     109      SWZ     106
(blank) 962
```

`Aug` (429), `Jan` (266), `FCT` (180), `N` (179), `G` (344) and `NCZ`/`SWZ` are
**not registration numbers** — truncated dates and filing codes that leaked into
the number column. Filter them explicitly; do not store them as numbers.

---

## 3. The blocker: the number regex rejects 71% of this data

`server.js:20`

```js
const NAFDAC_RE = /^[A-Z0-9]{1,3}-\d{3,6}$/i;
```

This is **drug-shaped**. Run against the 28,481 live food rows:

| | Rows | Share |
|---|---|---|
| Pass current regex | 8,224 | 28.9% |
| **Rejected** | **20,257** | **71.1%** |

Sample rejects:

```
A8-102316L   OZIGEO FOODS SOY MILK POWDER
A8-5412L     SOLOK GOLD REFINED PALM OLEIN OIL
A8-102426L   MUBAKO PARBOILED RICE
A8-102389L   SMS DAMBU (RICE GRITS)
```

The dominant food series is **`A8-`** (19,891 rows) and **`A5-`** (2,818), and both
routinely carry a **trailing `L`**. NAFDAC uses the letter suffix for listed and
herbal-style registrations. The regex's `\d{3,6}$` anchors to digits and
rejects every one of them.

### It is already broken today — this is a live bug, not a future one

The same regex run against rows **already in your own shipped DB** rejects 24 of
them:

```
A7-2363L   good morning cough tablets
A7-2366L   good morning cough syrup
A4-4479L   donistrep lozenges
A1-4924L   betadine
04 – 1486  fungusol lotion        (en-dash + spaces)
04- 9502   ponstan capsules       (internal space)
A4 - 5180  artemetrin tablet
```

Scope of the damage is narrow but real: `/verify` looks up on
`TRIM(nafdac) = ? COLLATE NOCASE` and **never consults the regex**, so a user who
types the number correctly still gets a correct verdict. The regex only gates
`format_valid`/`usable` on the **vision** path (`server.js:204`), which decides
whether an OCR'd number is auto-filled or flagged "format is not valid".

So the current behaviour is: *photograph a Ponstan pack, the model reads
`04-9502` correctly, and the app then tells the user the number it just read is
invalid.* Fixing the regex is a prerequisite for the food work and a bug fix in
its own right.

---

## 4. Cosmetics: no public register (a hard constraint)

The homepage advertises a "Registered Products (non drug) Database" covering
**Chemicals, Cosmetics, Devices, Food**. That page is
`https://nafdac.gov.ng/productstable/` — and it is an **empty shell**. The
rendered HTML contains:

```
DataTable with provided ID not found!
```

No Ninja table, no AJAX endpoint, no fetch URL. There is currently **no public,
machine-readable cosmetics register** to ingest.

This splits the two target categories cleanly:

- **Food → buildable now.** A real, structured, 28k-row source, verified live.
- **Cosmetics → not buildable now.** The only cosmetics coverage is the alert
  library (2 entries: ORACIRE+ `041/2026`, Coglaet `022/2026`) and the lead
  generator built on it.

Do **not** promise cosmetics verification on the strength of the food source.
Cosmetics should ship as *alert-and-lead coverage only*, with the UI stating
plainly that no register exists to check against. Re-scout later; the food
endpoint discovery method (WordPress page → Ninja config → AJAX) is the tool to
repeat.

Note the food table is genuinely food-only: a keyword scan for
cosmetic/toothpaste/shampoo returns 627 rows that are all **ice cream, dairy
creamer and beverages** — not personal care. Do not let a fuzzy keyword filter
promote those into a cosmetics category.

---

## 5. The honest limit: most packaged goods have no number

"Anything that comes in a pack" cannot be delivered by number-matching alone.
Soap, a phone charger, detergent and unbranded staples carry **no NAFDAC
registration number at all**. Chasing registrable goods covers a fraction of
that promise.

This forces a two-lane architecture, which should be the core design decision:

### Lane A — registrable goods
*(drugs, packaged food, cosmetics, chemicals, devices)*

Number + name + manufacturer against a per-category registry. Works today,
scaled per category. Verdict is meaningful.

### Lane B — non-registrable goods
*(household, electronics, textiles, unbranded staples)*

No number to check, so the honest verdict is assembled from the alert library,
community reports and appearance matching — **and the UI must say on its face
that absence of a number is not a defect**.

The trap in Lane B is sounding confident. The project's spine already forbids it:
*"Not found" is not "fake"*, and leads never become verdicts. Lane B must land on
something like *"this category has no register to check against — here is what we
know about this product"* rather than a vague suspicion badge. Lane B earns trust
by admitting its own limits; a vague red warning would destroy the credibility
the curated database took 564 rows to build.

---

## 6. Phased plan

### Phase 0 — Category-aware numbers (no new data, fixes a live bug)

Prerequisite for everything. Touches no new source.

1. Replace `NAFDAC_RE` with a category-aware validator that accepts the shapes
   actually printed:
   - `A8-102316L` — trailing letter suffix (listed/herbal series)
   - `04 – 1486`, `A4 - 5180` — en-dash / em-dash / spaced hyphen
   - `04- 9502` — internal whitespace
   - the food series `A5-`, `A8-` alongside drug `A1-`, `A4-`, `B4-`
2. **Normalise before comparing.** Add `normalizeNumber()` that folds dashes to
   `-`, strips whitespace, uppercases — and use it on both the user input and the
   stored value, so `/verify`'s `COLLATE NOCASE` equality becomes a canonical
   comparison rather than a string match. Do not weaken the lookup to a fuzzy
   match: exact-after-normalisation is what keeps a wrong number from matching a
   real one.
3. Reject the junk class explicitly — month fragments (`Aug` 429, `Jan` 266),
   filing codes (`FCT`, `NCZ`, `SWZ`, `N`, `G`), bare numerics, and anything over
   the existing 32-char cap. These are 1,500+ rows that would otherwise enter the
   register as fake "registration numbers".
4. Add `test:extract` and a new `test:numbers` case set covering the 24 known-bad
   rows above plus a sample of each rejected food shape. Assert normalisation
   round-trips: `04 – 1486` and `04-1486` must produce the same verdict.

**Exit criteria:** the 20,257 currently-rejected food numbers parse; the 24
existing drug rows parse; `npm test` and `npm run test:extract` green.

### Phase 1 — Food ingester (`npm run ingest:food`)

Model it on `ingest.js` + `alert_sync.js`: pure parser in its own module (no DB,
no network) so it is fixture-testable offline, exactly like
`nafdac_alert_parser.js`.

1. Fetch the page, scrape the nonce, paginate `chunk_number` until an empty
   chunk. **Throw `index_unparseable` if the first chunk yields 0 rows** — a live
   fetch that parses to nothing is a failure, not a clean no-op. This rule
   already exists for the alert sync; reuse it.
2. Parse into a new **`food_products`** table — do **not** overload `products`.
   Reasons: the schemas differ (pack size, presentation, subcategory, applicant
   vs applicant/strength/route), the two corpora have different refresh
   cadences, and `products` is the carefully-tuned `/verify` table with a
   documented decision logic. Keeping them separate preserves the ability to
   rebuild either independently.
3. **Deduplicate on ingest** (§3a) — collapse the 28,481 fetched rows to ~20,216
   distinct records, keeping the lowest `___id___` per distinct tuple for
   traceability. Without this the register shows one product 63 times.
4. Carry `source_country = 'NG'`, `subcategory`, `pack_size`, `presentation`,
   `applicant`, `issuedate`, `expirydate`, and the upstream `___id___` for
   idempotency.
5. Derive `status` from `expirydate` against the snapshot date — 76.6% active,
   23.4% lapsed. **Do not present a lapsed food registration as a live safety
   clearance**, and label the snapshot point-in-time exactly as the drug path
   already does.
6. Normalise `subcategory` on ingest (case-fold, trim, unescape HTML entities)
   and record the raw value alongside.
7. Skip rows whose `nafdacnumber` is blank or fails the junk filter — 962 rows
   (3.4%) — and **count them in the run summary** rather than dropping them
   silently.

**No images exist to import.** The feed carries no image/photo/media field, so
there is no pack photography for food at all. Do not synthesise any — see
integrity rule 6.

### Phase 2 — Category-aware verdicts

1. Accept a `category` on `/verify` (defaulting to the existing behaviour so no
   current caller breaks).
2. Look up `food_products` when the category is food, scoped to `NG`.
3. **A number alone is not sufficient for food** (§3a). The lookup returns a
   *set* of registrations, not a single row, and the name/pack-size match decides
   between them. Do not port the drug path's one-row-per-number assumption across
   unchanged — it is correct for drugs and wrong for food.
4. **Stop reporting a false `not_found`.** A tomato paste pack checked today
   answers "not found" because the food register was never loaded — that is a
   *gap*, and it reads identically to *counterfeit*. This is the single most
   damaging thing to get wrong, and it is why Phase 2 must ship with Phase 1
   rather than before it.
5. Distinguish "checked a register, absent" from "no register exists for this
   category" in the payload and the copy.

## 6a. How a food check would actually work

Answering the question directly — the answer is **number-first, name-disambiguated,
and text-only. There is no image comparison for food.**

| Signal | Source | Role in a food check |
|---|---|---|
| **Registration number** | `nafdacnumber` | Primary key. Read from the pack by the vision model, or typed. Normalised, then exact match. Narrows to a *set* of 1..63 registrations. |
| **Product name** | `productname` | Disambiguator within that set, and the fallback when there is no number. Fuzzy, as today. |
| **Pack size** | `packsize` | Tiebreaker. The field that actually separates otherwise-identical rows. |
| **Applicant / manufacturer** | `applicantname`, `manufacturer` | Optional cross-check, exactly like the drug path's manufacturer check. 96.6% populated. |
| **Presentation** | `presentation` | Free text describing the pack (`SACHET NYLON`, `soy powder in a food grade polythene pouch`). Useful as a *label* for the user, not a match key. |
| **Subcategory** | `subcategory` | Drives the register's filter UI. Not a match key. |
| **Image** | — | **Not available.** The feed has no imagery. |

**So: number → candidate set → name (+ pack size) → verdict**, with the food
register never being image-searchable. That is a real limitation, and it differs
from the drug path only in that the drug path also has no reference photos — the
photos in `web/fakes/` come from *alert* pages, not the Greenbook.

Two consequences worth stating plainly:

- **Food checks depend on the user photographing a legible registration number.**
  Without one, the check degrades to name-only against 20,216 rows, which is a
  much weaker signal than the drug path's exact-number lookup.
- **Image matching remains possible only against the alert library**, via the
  planned dHash work over the 246 regulator photos. That covers the 3 food and
  2 cosmetic *alerts* — not the 28,481 registrations.

### Phase 3 — Lane B, honestly

Category-filtered alert library + community reports, with copy that states the
limitation on the face of the panel. No new verdicts — reuse `verified` /
`mismatch` / `not_found` / `verified_inactive` and let the panel carry the nuance.

### Phase 4 — Schedule it

A GitHub Action calling the sync endpoints daily (SPEC §9 item 1). Note the food
ingester must **not** run on the free host tier's cron, and Render has no
persistent disk for the SQLite file — this is the deployment-hardening item in
SPEC §9 item 9. Worth resolving before the corpus is large enough that losing it
hurts.

---

## 7. Integrity rules this expansion must not break

Restated from `WHERE_THINGS_STAND.md` because the food work touches all of them:

1. **`source_country` on every row.** Food rows are `'NG'`. No exceptions.
2. **Twin-table writes stay atomic** — applies to alerts, and if a food row ever
   produces an alert-derived entry it must follow the same rule. Food
   registrations are *not* alerts and must not be written to `hazard_alerts`.
3. **No fabricated evidence.** A food row with no photo gets no photo. The UI
   says so, as it already does for the three photo-less drug alerts.
4. **"Not found" is not "fake."** Sharpest here: an unloaded food register must
   never render as a counterfeit signal.
5. **Never automate CAPTCHAs or authenticated APIs.** The Ninja endpoint is a
   public, unauthenticated, page-embedded nonce — comparable to the alerts page
   the project already syncs. If it ever starts demanding a login or a CAPTCHA,
   stop and switch to the manual-handoff pattern used for NAPAMS.
6. **Photos only from official alert pages.** The food register publishes no
   product imagery; there is nothing to harvest, and none should be invented.

## 8. Open questions

- **The nonce is per-request and possibly short-lived.** Confirm it survives a
  nightly cron run; if not, Phase 4 needs the nonce scrape inside the Action.
- **`issuedate` starts at 2022** (3,122 / 4,791 / 8,189 / 11,417 across
  2022–2025) — is that when NAFDAC digitised, or when these were registered?
  Affects how "fresh" the snapshot claims to be.
- **6 rows expire in year 0007 and 3 in 2927** — data-entry errors. Decide
  whether they are excluded or stored with a warning.
- **Is `A5-` beverages vs `A8-` food a reliable category signal**, or incidental?
  Worth measuring before leaning on the prefix for routing.
- **Does the food register have a `status` field upstream, or is expiry-derived
  active/lapsed our own inference?** If our own, the UI must not imply NAFDAC
  published that status. The 76.6% / 23.4% active-lapsed split is *our* maths
  from `expirydate`, not a NAFDAC-published status.
- **`FCT` appears 180 times in the number column** — is it "Food & Confectionery
  Temporary"? If it is a real filing class rather than junk, it needs its own
  category rather than being discarded with the month fragments.

---

## Appendix — reproducing the scout

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
curl -s -A "$UA" -o food.html "https://nafdac.gov.ng/food-products-database/"
NONCE=$(grep -oE 'ninja_table_public_nonce=[0-9a-f]+' food.html | head -1 | cut -d= -f2)
for CH in 0 1 2 3 4 5 6 7 8 9; do
  curl -s -A "$UA" -H "X-Requested-With: XMLHttpRequest" \
    -e "https://nafdac.gov.ng/food-products-database/" \
    -o "recon/foodchunks/c$CH.json" \
    "https://nafdac.gov.ng/wp-admin/admin-ajax.php?action=wp_ajax_ninja_tables_public_action&table_id=19494&target_action=get-all-data&default_sorting=old_first&skip_rows=0&limit_rows=0&ninja_table_public_nonce=$NONCE&chunk_number=$CH"
done
```

Chunks 0–9 hold 28,481 rows; chunk 10 returns `[]`. Fixtures land in `recon/`,
which is gitignored — the committed parser must be tested against a checked-in
fixture instead, following the pattern in `test_alert_sync.js`.
