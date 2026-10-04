# Where things stand — read this first in a new session

Written 4 Oct 2026. This file is the continuity note for anyone (human or AI) picking
this folder up cold. It exists because this working copy is **not** the submitted
project, and a lot of context lives in the decision history rather than the code.

## The one thing to know

There are two copies of this app:

| Folder | What it is | Port |
|---|---|---|
| `C:\Users\PC\nafdac-verify` | The **submitted hackathon project. Frozen.** The team was forbidden from updating it. | 3777 |
| `C:\Users\PC\vouch-next` | **This folder.** All new work happens here. | 3788 |

This folder was created by copying the original (822 files, 161 MB, byte-identical,
git history intact — 25 commits, HEAD `1a5d38d`). The copy includes `.git`, and
**nothing in either folder has been committed or pushed since.** That was a
deliberate instruction; do not commit or push without asking.

Start it with:

```bash
cd /c/Users/PC/vouch-next && npm start
```

## What the app is

Vouch: photograph or type a Nigerian (NAFDAC) or Kenyan (PPB) product registration
number, get back one of four verdicts — `verified`, `verified_inactive`,
`mismatch`, `not_found` — layered with hazard alerts, community reports, known-fake
leads and enforcement actions.

## Rules that must not bend

These are the project's integrity spine. Every change is checked against them.

1. **`source_country` ('NG'|'KE')** on `hazard_alerts`, `known_fakes`,
   `enforcement_actions`. Every warning names the authority that issued it
   (NAFDAC Nigeria / PPB Kenya). Never blur the two countries together.
2. **Every writer inserts into BOTH twin tables** (`hazard_alerts` *and*
   `known_fakes`) in one transaction. They cannot be allowed to drift.
3. **Alerts import directly.** There is no human review queue, by decision of
   30 Sep 2026 — if NAFDAC published it, that *is* the review.
4. **No fabricated evidence, ever.** Leads never become verdicts. "Not found" is not
   "fake". A clean batch never proves a pack genuine. Fail-closed admin via
   `ADMIN_KEY`.
5. **Never automate or bypass CAPTCHAs or authenticated APIs.** The NAPAMS
   verifier is opened for the user to complete by hand.
6. **Photos come only from official alert pages** — never stock images or lookalikes.

## Work completed

### 1. Port separation
`config.js` → 3788, `.env.example`, README. `scripts/test_extract.js` and
`scripts/screenshot_states.js` read the port from `config` instead of hardcoding it.

### 2. Coglaet enrichment (alert 022/2026)
`brand_name` corrected `'Colgate'` → `'Coglaet'` in `scripts/seed_fakes.js`, with
4 aliases. Appearance text rewritten from the NAFDAC page's own facts: door-to-door
seller, Guangzhou YECAI Oral Cleaning Products Co. Ltd, batch + Reg. No. "Nil",
mfd 02/08/2025 & 04/08/2025, exp 01/08/2029 & 03/08/2029. Verified live: `coglaet`,
`coglaet toothpaste`, `coglaet activgel 100g`, `coglaet herbal 100g` and
`colgate toothpaste` all raise HAZARD 022/2026.

### 3. Harvested regulator photos
`scripts/attach_harvested_photos.js` (`npm run photos:attach`) reads
`research/alert_photo_manifest.json`, copies only images whose file exists, and
unions them into `known_fakes.photos_json` (curated photos first). Result: **90
alerts, 246 photos, 209 files copied**, 33 byte-identical duplicates reused, 191
URLs 404, 28 alerts skipped. Idempotent. `seed_fakes.js` was made re-seed-safe via
`harvestedPhotosFor()` so re-seeding cannot wipe them.

*Bug found on the way:* a dedupe guard was written as `` /^${slug}-/ `` — a regex
literal, so `${slug}` never interpolated and the dedupe silently never ran. Replaced
with `file.startsWith(slug + '-')`. **Watch for this class of mistake in template
literals in regexes.**

### 4. `enforcement_actions` table (new)
- `scripts/enforcement_schema.js` — table with `action_key UNIQUE`, `authority`,
  `action_date`, `location`, `evidence_class`, `summary`, `brands` (JSON),
  `finding_status CHECK IN ('action_taken','not_a_finding')`, `evidence_note`,
  `source_url`, `source_publisher`, `source_country`.
- `scripts/seed_enforcement.js` (`npm run seed:enforcement`) — 8 rows, 54 brand
  entries, idempotent. 5 `action_taken`, 3 `not_a_finding`. Every row's source was
  opened and read live before being written.
- Advisory only: it never changes a verdict.
- Deliberately has **no Kenya (PPB) rows** — none were invented.

**The not_a_finding policy.** Four names were researched and are explicitly *not*
findings, so they must never surface: **Tamral/TramaKing, Reliance Extra, Mama
Pride, Oral-B**. `npm run test:library` enforces this. (`Mama Pride Rice`
is recorded as `enforcement` in the research notes because Punch's report of
NAFDAC's 20 Mar 2025 Rivers statement does name it — but it is not in the surfaced
enforcement rows.)

**The brand-matching rule (took three attempts).** Final shipped rule: *every word of
the brand name* — punctuation stripped via `.replace(/[^\p{L}\p{N}\s]/gu, ' ')` —
must be present in the query's word set. Short forms are stored as explicit extra
brand rows.

- Attempt 1, whole-word regex on the brand: insufficient.
- Attempt 2, `fuzzball.token_set_ratio >= 92`: **failed** — `token_set_ratio` is
  containment-biased, so the bare query `"rice"` scored **100** against
  `"Big Bull Rice"`.
- Attempt 3, dropping `GENERIC_BRAND_WORDS`: still let `"tomato paste"` half-match
  `"Tomato Rice"`.

Note `fuzzball`'s API is snake_case: `token_set_ratio`, `partial_ratio`.
`GENERIC_BRAND_WORDS`, `brandIdentityTokens` and `ENFORCEMENT_MIN_FUZZY` are gone —
verified no dangling references.

### 5. `npm run test:library`
`scripts/test_library_integrity.js`. Six sections: twin-table coverage both
directions; every referenced photo exists, non-empty, valid JSON array; ≥90 alerts /
≥240 photos with photos; no duplicate path or byte-identical image per alert; 022/2026
findable as Coglaet with its 3 expected aliases; enforcement rows must have a source,
no `NN/NNNN`-shaped `action_key`, summary must not claim to be an alert, ≥1 brand,
≥5 surfaced / ≥3 withheld, and the four unsubstantiated names must not appear.

Negative-tested both ways: moving a photo off disk fails with `broken photo
references`; setting brands to `["Tamral"]` fails with `"tamral" is not a
product-quality finding and must not be surfaced`.

### 6. Photo-reading honesty (done 4 Oct 2026, most recent work)
`scripts/test_extract.js` had **no assertions at all** — it printed results and
always exited 0, so three of five photos failing still looked green. Now:

- **Contract checks** (always, no network): 0 images / 5 images / non-`data:` URL all
  rejected `400 bad_images`; response keeps `nafdac_number`/`found`/`format_valid`/
  `usable`; `usable === found && format_valid`; and the response must **not** carry
  `product_name`, which guards the deliberate "name is always typed by the user"
  decision. That missing field was the misleading `product_name: undefined` in the
  old output — the endpoint never returns it by design.
- **Live checks** (need `GROQ_API_KEY`): `assets/sharp-sample-image.jpg` must read
  **`AB-102886`** — the number physically printed on the bottle, transcribed by hand
  so a regression can't agree with a wrong answer. Then `/verify` must answer
  `not_found`, which is the *correct* verdict (`AB-102886` is real but absent from the
  snapshot). The four softer photos need not be legible but must return 200 and must
  never report a malformed number as valid.
- **Rate limits are no longer reported as outages.** Groq's free tier caps vision
  input at ~7,000 tokens/minute (~3 photo reads a minute) and answers over that with
  `429`. The server used to turn that into `502 vision_upstream_error` — "Photo
  reading service is unavailable" — telling users the reader was down when it just
  needed a few seconds. `visionUpstreamError()` in `server.js` now maps `429` →
  `429 vision_rate_limited`, parsing Groq's own "try again in 13.98s" into
  `retry_after_seconds` + a `Retry-After` header. `web/app.js` shows a "busy, tap the
  photos again" message. Any other non-OK upstream stays a 502.
- The suite uses **its own port** (`39600 + pid % 100`) instead of the app's 3788. It
  used to borrow 3788, which made it silently talk to whatever dev server was running
  and then fail confusingly when that server stopped mid-run.

Verified: 20/20 pass. Negative-tested by breaking `NAFDAC_RE` → exits **1** with
`reads the printed number AB-102886: false == true`.

### 7. Research corrections
`research/research_notes.json`: "Mama Pride Rice" `unconfirmed` → `enforcement`.
JSON revalidated, `node scripts/build_results_table.js` re-run. New section
"## 7. What was built from this research (4 Oct 2026)" in
`research/RESEARCH_FINDINGS.md`.

## Test suites

```bash
npm test                 # test_verify.js + smoke_test.js
npm run test:matcher     # brand matching
npm run test:hazards     # hazard matching + banner ordering
npm run test:reports     # report API, migration, community flag, rate limit
npm run test:fakes       # known-fake library: migration, matching, lead UI
npm run test:batch
npm run test:alert-sync  # NAFDAC parser + import lifecycle, no network
npm run test:ppb-sync    # PPB parser + import lifecycle, no network
npm run test:library     # library + photo + enforcement integrity
npm run test:kenya
npm run test:report-ui   # Playwright
npm run test:e2e         # Playwright desktop + mobile
npm run test:extract     # photo reading; needs GROQ_API_KEY, ~2 min
```

Seeding is idempotent (verified by re-running).

**Test status after the 4 Oct 2026 photo-reading change** — the last time
`server.js` was edited:

- Re-run and green against the current code: `test`, `test:library`,
  `test:matcher`, `test:hazards`, `test:reports`, `test:alert-sync`,
  `test:ppb-sync`, `test:batch`, `test:kenya`, and `test:extract` (20/20).
- **Not re-run since that change**: `test:fakes`, `test:report-ui`, `test:e2e`
  (the three Playwright/browser suites). They were green on the code as it stood
  before it. They should still be fine — `test:fakes` and `test:report-ui` start
  their server with `GROQ_API_KEY` unset, so they take the 503 path and never
  reach the changed vision code — but that is reasoning, not a fresh green run.
  Run them when the machine is not busy.

## Environment facts that will bite you

- **Windows + bash.** Use POSIX syntax and forward slashes. `C:\Users\PC` is
  `C:/Users/PC`. Never `dir`, `move`, `del`, `copy`, `findstr`, or PowerShell
  cmdlets. Never `> nul` (creates a literal file called `nul`).
- **Always capture the exit status when piping**, e.g.
  `npm test 2>&1 | tail -20; echo "EXIT=${PIPESTATUS[0]}"` — otherwise a failure
  hides behind `tail`'s success.
- **Orphan `node server.js` processes cause false-negative tests** by holding a
  port. Check with `netstat -ano | grep LISTENING | grep :3788`; kill with
  `taskkill //PID <pid> //F`.
- **Backgrounding inside a SYNC command does not survive tool cleanup** — a
  `(node server.js &)` server will be reaped. Use a proper BACKGROUND process and
  check its log for readiness.
- **`fuzzball` is snake_case.** `token_set_ratio`, `partial_ratio`.
- Test suites use per-process ports (`39400`/`39500`/`39600 + pid % 100`) and a
  temporary DB. They never touch the shipped data.

## Known limitations (do not re-investigate these)

- **234 published photo URLs permanently 404** — NAFDAC rotated older uploads.
  Wayback has page snapshots but not the images.
- **Viral-list items 119–149 unrecoverable** without more screenshots from the user.
- **KEBS S-mark register** needs KEBS cooperation or a future public KIMS endpoint.
  The full map is already in the `SPEC.md` roadmap item 5 — **do not re-scout.**
- **Alert syncs remain manual** — no cron on the free host tier. The `ADMIN_KEY`
  remote-trigger endpoint exists but no scheduler is wired.
- 3 test images in `assets/` (`image.jpeg`–`image4.jpeg`) are softer shots of the
  same bottle and currently read nothing. That is expected; they are only checked
  for "does not error, never returns a malformed number".

## If you only have time for one thing

Run `npm run test:library`. It is fast, needs no network and no API key, and it is
the suite that protects the rules above — twin tables, photo integrity, and the
not-a-finding policy. If it is green, the database has not drifted.