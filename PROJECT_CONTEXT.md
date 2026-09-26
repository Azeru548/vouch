# Vouch — NAFDAC Product Verification Project Context

Read this first if you're continuing this project in a fresh session.

## What this is

A product-verification app: a user photographs a product pack (or types the details), and the app checks the NAFDAC registration number + product name against a local snapshot of the NAFDAC Greenbook database, then reports one of four verdicts.

Data sources are NAFDAC's public Greenbook (https://greenbook.nafdac.gov.ng) for bulk medicine/device records and official NAPAMS (https://registration.nafdac.gov.ng/) for user-confirmed per-number checks. Greenbook is stored in SQLite; NAPAMS results are cached locally only after the user completes the official verification.

## Layout

```
config.js            Shared runtime, database path, and vision model configuration
server.js            Express app: /verify, /api/extract, /api/config, /api/health, static web/
web/                 Vouch UI: index.html, styles.css, app.js (no framework, no build step)
.env.example         Non-secret environment template
data/
  nafdac_products.db SQLite, 8,977 product rows (~1.8 MB)
  napams_cache.db   Local, user-confirmed NAPAMS records; ignored by Git
scripts/             ingest + tests (see "Commands" below)
recon/               original recon artifacts: captured JSON responses, full dump, network logs
assets/              two test photos of a soda bottle (sharp + blurry)
screenshots/         visual proof of each verdict state
```

## Run it

```powershell
cd C:\Users\PC\nafdac-verify
node server.js
# UI  -> http://localhost:3777/
# API -> http://localhost:3777/verify?nafdac=04-0858&product_name=10%25%20Dextrose
```

Requires Node 24+ (uses built-in `node:sqlite`, no native modules). Runtime deps: `express`, `fuzzball`; Playwright is development-only. `DATABASE_PATH` defaults to `data/nafdac_products.db`.

## Database schema

`products` table, one row per registered product:

| column | notes |
|---|---|
| `id` | PK |
| `nafdac` | registration number, **indexed but NOT unique** (duplicates exist in source data) |
| `product_name` | normalized: `#`/`*`/`$` stripped, lowercased, whitespace collapsed |
| `strength`, `form`, `route`, `applicant`, `manufacturer`, `category` | text |
| `approval_date`, `expiry_date` | ISO-ish date strings, some have `-000001-11-30` placeholder sentinels |
| `status` | `Active` or `Inactive` |
| `manufacturer_id` | FK-ish id, kept even though name is denormalized in `manufacturer` |

Also a `manufacturers(id, name)` reference table (1,420 rows) scraped from `/manufacturers`.

`products.manufacturer_id` is stored as **TEXT** (node:sqlite bound JS numbers into a TEXT column as `'1318.0'`), normalized once to `'1318'`. Be aware if writing joins.

`napams_cache` is a separate writable local SQLite database created at `data/napams_cache.db`. It stores only records the user manually confirms after opening the official NAPAMS verifier: `nafdac`, `product_name`, optional manufacturer/applicant/category/notes, status, `source`, and `checked_at`. It is not a scraped mirror of NAPAMS.

`reports` lives in the main `data/nafdac_products.db`: `id, nafdac_number, country, location_area, note, photo_url, scan_result, latitude, longitude, session_id, created_at, is_seed`. Rows with `is_seed = 1` are DEMO/SEED data only. `POST /report` rate-limits to 5 reports/hour per session. `/verify` adds `community_flag {flagged, report_count, recent_locations}` when a number+country has ≥3 reports in 30 days. `GET /api/reports` exposes non-sensitive report data (no session IDs or photos). The report map was removed and replaced by the Safety Alerts feed: `/alerts.html` lists the curated `hazard_alerts` via `GET /api/alerts`, filterable by recall vs safety warning, linked from the home header and trust strip, and cached in the PWA shell.

`hazard_alerts` (same DB) holds 14 manually curated NAFDAC alerts: `alert_number, product_name, nafdac_number (nullable), batches (JSON), hazard, alert_type, manufacturer, source_url, alert_date, in_registry`. `/verify` runs two independent checks on every verdict: number-keyed match, plus fuzzy name match (≥85) against NULL-number rows so unregistered products like Menofix are caught. Hit responses carry `hazard {alert_number, hazard, alert_type, source_url, alert_date, batches}`; omitted otherwise. The hazard banner renders first, above verdict and community flag.

## The four verdicts

| status | meaning | UI treatment |
|---|---|---|
| `verified` | name ≥85, row status Active | green |
| `verified_inactive` | name ≥85, but NAFDAC approval inactive | amber + prominent warning message |
| `mismatch` | name <85, or manufacturer gate failed | red + "closest match — does not confirm" |
| `not_found` | no rows for that number | dark red dashed, different copy |

`mismatch` and `not_found` show a NAPAMS handoff panel. The button opens the official verifier and copies the entered number; after the user completes the official check, they may save the confirmed result to the local cache.

## /verify decision logic (do not casually change — it's tuned)

1. Query `WHERE nafdac = ? COLLATE NOCASE` after `TRIM()`ing the input. **Exact match, not LIKE.**
2. Normalize input name the same way ingestion normalized stored names.
3. Score every candidate with `fuzzball.token_set_ratio`.
4. If `manufacturer` param present, also score manufacturer, and rank by `name*0.7 + mfr*0.3`. If absent, rank by name only.
5. **Active-preference tiebreak:** take max rank, keep candidates within 3 points, prefer `status === 'Active'` if any exist there.
6. Verdict: name <85 → mismatch; else mfr provided and mfr <60 → mismatch + `reason: "manufacturer_mismatch"`; else status !== Active → `verified_inactive`; else verified.

Response: `{status, matched|closest_match, score, [reason], [message]}`. Development diagnostics are only included when the server starts with `EXPOSE_VERIFY_DEBUG=true`; public responses never include the candidate spread by default. Matched records include `source: greenbook` or `source: napams_manual`.

## Vision extraction

`POST /api/extract` proxies to Groq (`qwen/qwen3.8-27b`) with the image as base64. The API key is read from the `GROQ_API_KEY` env var server-side; the browser never sees it.

- Extracts **only** `nafdac_number` (+ `found`).
- Validates against `/^[A-Z0-9]{1,3}-\d{3,6}$/i` server-side, mirrored client-side.
- `product_name` is **always typed by the user** — never from OCR. This was a deliberate reversal: an earlier design suggested a name and offered a tap-to-confirm candidate list; it was removed because OCR names were unreliable and the tap list misled users.
- If no valid number, the number field is pre-filled for correction and the user types the rest manually.

Key gotchas learned the hard way:
- **`meta-llama/llama-4-scout-17b-16e-instruct` does not exist on the available Groq account** (404). Only `qwen/qwen3.8-27b` is multimodal there. Override with `VISION_MODEL` if that changes.
- **Asking the model for less produced better results.** When the prompt also requested a product name, the model returned wrong numbers (`B-102886`, `8-102886`) and garbage names (`"SOTL"`). With name extraction removed it reads the number correctly: `AB-102886`.
- The regex only validates *shape*, not correctness. A wrong-but-well-formed number will pass and land on `not_found`. That's the intended safety net, not a silent bad verification.
- `GET /api/config` reports whether vision is enabled so the UI can show a banner.

## NAPAMS handoff and local cache

- The UI opens `https://registration.nafdac.gov.ng/` in a new tab and copies the entered NAFDAC number to the clipboard when possible.
- The user completes the official CAPTCHA and verification manually; Vouch does not automate or bypass it.
- The form saves only a user-confirmed NAPAMS result to `data/napams_cache.db` through `POST /api/napams/cache`.
- Future checks search Greenbook and the local NAPAMS cache together. Cached records are clearly labelled as manually confirmed.
- The cache is local development data and is ignored by Git. Delete it to clear manually confirmed NAPAMS records.

Both are the same soda bottle. Printed NAFDAC number is **`AB-102886`**.

- `sharp-sample-image.jpg` — clear, reads correctly.
- `blurry-sample image.jpeg` — softer, less reliable.

Note: **`AB-102886` is not in the database** (`%102886%` returns 0 rows), so these photos correctly end in `not_found`. That is not a bug. The bottle is a good OCR test but a bad end-to-end "verified" test — for that use the numbers in the test list below.

## Commands

```powershell
npm.cmd test                         # 12 asserted /verify cases + smoke/security/cache checks
npm.cmd run test:e2e                 # Playwright desktop/mobile flow, NAPAMS handoff, all verdicts
npm.cmd run test:reports             # report API, community flag, rate limit (temp DB)
npm.cmd run test:report-ui           # UI report submission, threshold flag, map + screenshots (temp DB copy)
npm.cmd run seed:reports             # 10 DEMO seed reports (5 NG, 5 KE); modifies the configured DB
npm.cmd run test:extract             # sends each assets/ image through /api/extract
npm.cmd run ingest                   # re-pull Greenbook (destructive: recreates the DB)
npm.cmd run enrich:manufacturers     # refresh manufacturer names in the shared DB
node scripts\screenshot_states.js    # regenerates screenshots/ for all four verdicts
node scripts\migrate_trim_nafdac.js  # one-time TRIM fix, already applied
```

Useful reg numbers for manual testing:
- `A11-0009` "alben paracetamol drops" — Active, 1 row → `verified`
- `04-0858` "10% dextrose (500/1000 ml)" — Inactive, 1 row → `verified_inactive`
- `A4-1205` — 4 rows across two different products (Dermovate *and* Ebu 200 Tablets) → disambiguation test
- `04-7953` — 4 rows, mixed Active/Inactive, near-duplicate names → tiebreak test
- `04-6868` — was whitespace-dirty, proves the TRIM fix
- `99-9999` — not found

## Data quirks worth knowing

- **124 rows** had leading whitespace in `nafdac` (e.g. `" 04-6868"`). Fixed once; handler also TRIMs input. Don't reintroduce.
- **3 rows have an empty/null reg number.**
- Reg numbers are **not unique**. `A4-1205` covers two genuinely different products — almost certainly a NAFDAC data-entry error, not a duplicate.
- `04-7953` has rows named `emgyl 400 tablet`, `emgyl 400 tablet (triplicate)`, `emgyl 400 tablet_` — the `(triplicate)` variant scores only 73 and would fall into the mismatch band.
- Product names contain leftover artifacts (`#`, `*`, `$`, `_`) which ingestion strips.
- The `manufacturer` shown can differ from `applicant`; and a name-tied row may resolve to a different manufacturer than expected (Active-preference tiebreak changed A4-1205's winner to the Delpharm row).

## Status of work

Done: recon, ingestion, manufacturer enrichment, whitespace migration, `/verify` with all 4 verdicts, vision extraction, responsive Vouch UI, client-side image downscaling, security headers, NAPAMS handoff, local confirmed-result cache, and asserted API/smoke/browser tests. Deployment is intentionally deferred.

Not done / known gaps:
- NAPAMS is not a bulk source; the current flow is intentionally manual and CAPTCHA-safe.
- No automatic refresh of the local NAPAMS cache.
- No rate limiting or abuse monitoring yet.
- Camera (`getUserMedia`) needs HTTPS or localhost and will not work over a LAN IP.
- Groq uses a 25-second timeout but no retry/backoff or circuit breaker.
- The SQLite registry is a point-in-time snapshot with no scheduled refresh.

## Security findings (observed during recon, not yet reported)

Passive observations only, nothing exploited:
1. **SQL debug output leaked in every JSON response** — a `queries` array with raw SQL, bindings and timings, plus an `input` echo. Present in normal browser traffic, not just scripted requests. This is the one genuinely worth reporting. Observed queries are parameterized, so no evidence of SQL injection.
2. **Missing security headers** on the homepage: no CSP, HSTS, `X-Frame-Options`, or `X-Content-Type-Options`.
3. **Session cookies lack the `Secure` attribute** on an HTTPS site.
4. **Admin subdomain + storage layout disclosed** via `smpc` URLs (`admin.greenbook.nafdac.gov.ng/uploadImage/smpc_files/...`).
5. **Outdated front-end deps** — jQuery 1.9.1 (EOL, known XSS) loaded alongside 3.6.0, plus DataTables 1.10.16.
6. **Unbounded `length` param** on the JSON endpoint — served the full 8,977 rows in one 17.5 MB response.

The site exposes no security contact; route disclosure through official NAFDAC channels.

## Notes / gotchas for the next session

- `npm` may be blocked by PowerShell execution policy — use **`npm.cmd`**.
- Automated tests use a per-process port and temporary `CACHE_DATABASE_PATH`; they do not touch the real `data/napams_cache.db`.
- Scripts that spawn the server must point at `path.join(__dirname, '..', 'server.js')` since they now live in `scripts/`.
- The `GROQ_API_KEY` was set with `setx` (persisted to the user env). **It is also in this project's chat history — rotate it before any demo.** Remove with `[Environment]::SetEnvironmentVariable('GROQ_API_KEY',$null,'User')`.
- An unrelated `next dev` server runs from `C:\Users\PC\cgen\frontend` on port 3111; don't kill it when cleaning up port 3777.
