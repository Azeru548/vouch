# Vouch — Product Specification Sheet

**Version 1.1 · September 2026 · Status: live web app (PWA), pre-launch**

Vouch is a consumer product-safety tool for markets in Nigeria and Kenya. A shopper photographs or types what is
on a pack and gets a trustworthy verdict in under a minute, on a phone, with no training. Underneath that verdict
sits a deliberately built **intelligence database of counterfeit and dangerous products currently circulating in the
wild** — assembled from official regulator alerts, refreshed by automated syncs, and expanded by real-world
community reports.

This document is the product-facing spec. Engineering depth lives in
[`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md); the visual system in [`DESIGN.md`](DESIGN.md).

---

## 1. Mission and Main Goal

> **Build the most useful living database of counterfeit, substandard, falsified and unregistered products
> circulating in Nigerian and Kenyan markets — and put a trustworthy verdict on top of it for anyone holding a pack.**

Three properties make the database valuable rather than merely large:

1. **Every row is sourced.** Rows enter only from an official regulator publication (NAFDAC, PPB) or from
   verified community reports. We never invent a product, a photo, or a "looks like" description. Where official
   imagery does not exist, the entry says so plainly instead of substituting a lookalike.
2. **Every row is attributed.** A Kenyan shopper is flagged by Kenyan regulators, a Nigerian shopper by Nigerian
   ones. Flags never cross borders silently, and every warning names the authority that issued it.
3. **Every row stays fresh.** Automated syncs import new regulator publications without human review —
   the regulator is the source of truth; their alert *is* the review.

The consumer layer (verdicts, warnings, reporting) and the database layer (imports, matching, retention) are two
faces of one system: the verdict is only as good as the database, and the database only grows if checking is easy.

---

## 2. Who It Serves

| User | Scenario | What they get |
|---|---|---|
| **Shopper** | Holding a pack at a market stall, chemist, or supermarket | A five-second verdict: registered / not found / mismatch / inactive, plus any danger warnings |
| **Pharmacist / health worker** | Verifying stock or answering a customer | The same single flow — no modes, no training |
| **Regulator (indirect)** | NAFDAC / PPB publish alerts | Automatic import into the register and the matching library |
| **The database itself (the goal)** | Every check, every report, every sync | A growing, sourced, attributed corpus of dangerous products in circulation |

---

## 3. The Check — Core Feature

One flow, four possible verdicts, always with the danger layer on top:

1. **Input** — the user enters country, product name, and (optionally) a registration number, or photographs
   the pack (up to **4 photos**: the pack face and close-ups such as the registration panel).
2. **Extraction** — a vision model reads the registration number **across all photos** and describes the pack's
   appearance in text; both run in parallel as separate prompts.
3. **Lookup pipeline** (layered, in order):
   - **Registry check** — exact, case-insensitive match against the local snapshot for the selected country
     (NAFDAC Greenbook for NG, PPB registry for KE), then the NAPAMS manual-verification cache (NG).
   - **Hazard-alert match** — exact number match, else fuzzy name match (≥85 similarity), against the
     regulator alerts for that country. A hit raises a banner **above** the verdict.
   - **Known-fake library match** — name (product + brand + aliases, ≥85) and appearance (≥60, labelled as
     such) produce up to 3 **leads** — never verdicts — on `not_found`/`mismatch` results.
   - **Community flag** — ≥3 reports in 30 days agreeing on the same pack raise a community warning.
4. **Verdict** — one of:
   - **Registry match** (blue badge) — number + name confirmed against the registry;
   - **Not found** — no registry row (or no number given); leads may appear;
   - **Details mismatch** — number exists but name/manufacturer disagree;
   - **Approval not active** — registered but suspended/expired/discontinued.
5. **Report modal** — after *every* check the app asks "Did this pack look different or damaged?" The modal leads
   with the verdict strip (same badge as the result) so the user knows what they are reporting on, offers issue
   chips, a note, area, and optional photo attachment. Reports never change a verdict; they feed the community
   layer and the database.

Integrity rules that never bend:

- A confirmed registry match is never second-guessed by leads or community reports.
- Snapshot data is point-in-time and labelled as such; we never present it as live truth.
- Danger outranks reassurance: hazard → community → verdict, in that visual order.

---

## 4. The Flagged-Products Database — The Main Goal

### 4.1 What it holds today (September 2026)

| Layer | Rows | Source |
|---|---|---|
| **Registry (NG)** | 8,980 products | NAFDAC Greenbook snapshot |
| **Registry (KE)** | 3,235 products | Kenya PPB registry snapshot (human medicines) |
| **Flagged products (NG)** | 403 entries | NAFDAC public alerts 2013→2026 (14 with official photos) |
| **Flagged products (KE)** | 138 entries | Kenya PPB recalls 2023→2026 + safety alerts (110 recalls, 28 safety alerts) |
| **Community reports** | growing | User submissions after checks (NG + KE, country-isolated) |

**Total flagged-product corpus: 541 sourced, attributed entries** — every one traceable to a regulator page.

### 4.2 How the database grows

**Automated regulator syncs (the growth engine).** `npm run alerts:sync` (NAFDAC) and `npm run ppb:sync` (Kenya)
fetch the regulators' published alert listings, parse them, and import anything unseen **directly** — no review
queue, because the regulator's publication is the review. Skip rules protect integrity: URLs already known are
skipped (idempotency), alert numbers already hand-curated are never overwritten (NAFDAC's "Updated…" re-posts),
and a parse-to-zero live fetch fails loudly instead of silently doing nothing.

**Human curation (the quality layer).** 17 hand-tuned entries carry the depth automation cannot: official NAFDAC
photographs of the fake packs (14 rows), written appearance descriptors (15 rows), brand names and aliases. The
seed rebuilds them without ever inventing pack details.

**Community reports (the field layer).** Every check ends with the reporting prompt; reports about packs with no
registration number are keyed by product name at the same fuzzy bar used elsewhere. Photos are downscaled
client-side, GPS is rounded to ~110 m, and photo payloads expire after 180 days — the note and rough area are the
signal, not surveillance.

### 4.3 What each entry carries

Product name, the regulator's own hazard statement, alert/reference number, batches where cited, manufacturer,
date, the official source URL, auto-derived category (drug / food / cosmetic / device / chemical / other),
`source_country` (NG/KE), and — where they exist — the regulator's own photographs and written appearance text.

### 4.4 How matching uses it

- **Number-keyed matching** is exact and definitive: a flagged registration number raises the hazard banner.
- **Name matching** (fuzzy, ≥85) catches unregistered packs that have no number to check — the normal case for
  counterfeit food, drink and cosmetics.
- **Appearance matching** (≥60, labelled "matched on looks") turns the pack description the vision model writes
  into a lead against the library's appearance text.
- **Country scoping** filters everything: `hazardMatch` and the suspect search only see rows for the country of
  the check, and a flag can never silently cross a border.

---

## 5. Multi-Country Architecture

| | 🇳🇬 Nigeria | 🇰🇪 Kenya |
|---|---|---|
| **Registry source** | NAFDAC Greenbook snapshot (8,980) | PPB registry snapshot (3,235; pharma-only by source) |
| **Alert source** | NAFDAC public alerts/recalls | PPB recalls & safety alerts |
| **Alert corpus** | 403 entries (2013→) | 138 entries (2023→) |
| **Matching scope** | `source_country = 'NG'` | `source_country = 'KE'` |
| **Authority label in UI** | "NAFDAC, Nigeria" | "Pharmacy and Poisons Board (PPB), Kenya" |
| **Manual handoff** | NAPAMS (CAPTCHA-protected, never automated) | — (none; PPB has no equivalent public flow) |

One codebase, one schema, one UI. The country selector switches the registry, the alert scope, and the wording of
every warning. Adding a third country means: a registry snapshot, an alert sync script, a `source_country` value,
and an authority name — nothing else.

**Known limits, stated honestly:** the KE registry snapshot is human medicines only (PPB's public register), so
Kenyan food/cosmetic checks rely on the alert library; PPB's older site publishes recalls only from 2023 (their
new portal is JavaScript-only); NAFDAC's ORACIRE+ photos are published under "OralB" filenames by NAFDAC itself —
noted, not "fixed".

---

## 6. Feature Inventory

| # | Feature | State | Notes |
|---|---|---|---|
| 1 | Registry verification (number + name, fuzzy) | ✅ Shipped | 4 verdicts; manufacturer check optional |
| 2 | Multi-photo upload (up to 4) | ✅ Shipped | Thumbnails, remove buttons, number read across all shots |
| 3 | Photo → registration number (vision) | ✅ Shipped | Separate prompts; describe gated like extract |
| 4 | Known-fake library + leads | ✅ Shipped | Name/appearance matching; leads never verdicts |
| 5 | Hazard alerts with authority labels | ✅ Shipped | Banner above verdict; NG/KE scoped |
| 6 | Flagged-products register (`/alerts.html`) | ✅ Shipped | Blog-style; category + country filters; search; official photos |
| 7 | Automated alert syncs (NAFDAC + PPB) | ✅ Shipped | Direct import; idempotent; fixture-tested offline |
| 8 | Community reporting + modal | ✅ Shipped | Post-check modal; verdict strip; photo attach; rate limits |
| 9 | Community warnings (≥3 reports/30 days) | ✅ Shipped | Number- or name-keyed; country-isolated |
| 10 | NAPAMS manual handoff (NG) | ✅ Shipped | Never automated; caches manual verdicts |
| 11 | PWA install + offline shell | ✅ Shipped | Checks require connection; shell opens offline |
| 12 | Retention & privacy controls | ✅ Shipped | 900 KB photo cap, GPS rounding, 180-day photo expiry |
| 13 | dHash looks-matching (pixels vs pixels) | 🕐 Planned | Original "match by looks" idea; zero new deps |
| 14 | Alert-freshness scheduling | 🕐 Planned | Syncs are on-demand; cron/GitHub Action wiring pending |
| 15 | KE registry widening (food/cosmetics) | 🕐 Planned | Blocked on a public PPB source |
| 16 | Local-language UI | 💤 Deferred | Plain English first |

---

## 7. Data Integrity and Safety Rules

1. **Nothing enters the database unsourced.** Regulator publications or verified user reports — nothing else.
2. **No fabricated evidence.** If no official photo exists, the entry says so; we never generate lookalikes.
3. **Attribution is structural.** `source_country` is a column, not a label; matching is scoped by it.
4. **Leads are leads.** Library matches are framed as leads with a similarity score and source link; they never
   alter a verdict, and a confirmed registration is never second-guessed.
5. **Admin actions fail closed.** The sync trigger endpoint is disabled without `ADMIN_KEY` and rejects wrong keys.
6. **Privacy by design.** Rounded coordinates, capped and expiring photos, no session data in public APIs.

---

## 8. Update History

| Date | Version | Update |
|---|---|---|
| 2026-09-24 | 0.x | Project start; NG registry snapshot + basic number check |
| 2026-09-25 | 0.x | KE registry snapshot; country selector; fuzzy name matching |
| 2026-09-26 | 0.x | Community reports; hazard alerts; NAPAMS handoff; PWA shell |
| 2026-09-27 | 0.9 | Known-fake library seeded from NAFDAC alerts with official photos; report modal; number-optional reporting |
| 2026-09-29 | 1.0 | Multi-photo pipeline (up to 4); report modal with verdict strip; flagged-products register (`/alerts.html`); README |
| 2026-09-30 | 1.1 | **Freshness pipeline**: NAFDAC sync imports all alerts back to 2013 directly (17 → 403). **Multi-country intel**: PPB Kenya sync with `source_country` on every row; authority labels across the UI; country filter on the register (541 total entries). |

---

## 9. Roadmap — Toward the Main Goal

The database is the asset; every roadmap item either widens it, deepens it, or sharpens how it matches.

**Next (highest leverage)**
1. **Schedule the syncs** — a GitHub Action or cron calling `alerts:sync` + `ppb:sync` daily keeps the corpus
   fresh without anyone remembering to run it.
2. **dHash looks-matching** — perceptual hash of the user's photo vs the 14 official reference photos; the
   original "match by looks" idea, still unbuilt, zero new dependencies.
3. **Deepen the curated rows** — appearance descriptors and photos for the merged amoxicillin entries and the
   386 auto-imported rows (title-derived names need human enrichment to match well).

**Then**
4. **KE registry widening** — chase PPB food/cosmetic registration sources to close the Kenyan food-safety gap.
5. **Batch-number verification** — many recalls and fakes are batch-specific; expose batch entry + matching.
6. **Report-photo reuse** — with consent, attach community-report photos to register entries as field evidence
   (labelled as such, never presented as regulator imagery).

**Later**
7. More countries (Ghana FDA, Tanzania TMDA — same architecture, new sync scripts).
8. Push notifications for new alerts matching a user's saved checks.
9. Deployment hardening: persistent disk for the DB on Render + key rotation.

---

## 10. Links

- **App flow:** `server.js` (API), `web/` (PWA), `scripts/` (syncs, seeds, tests)
- **Engineering context:** [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) — schema, thresholds, data quirks
- **Product brief:** [`PRODUCT.md`](PRODUCT.md) · **Design system:** [`DESIGN.md`](DESIGN.md)
- **Public register:** `/alerts.html` · **API:** `GET /verify`, `GET /api/alerts`, `POST /report`
