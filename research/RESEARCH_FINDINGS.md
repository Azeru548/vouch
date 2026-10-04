# Research dossier — the "149 fake products" list

**Date:** 2026-10-03
**Inputs:** `assets/image.jpeg`, `image2.jpeg`, `image3.jpeg`, `image4.jpeg` (screenshots of a viral Instagram/Facebook post, author "Choke")
**Method:** screenshots transcribed with the project's own Groq vision model (`qwen/qwen3.8-27b`), items cross-referenced against `data/nafdac_products.db`, then each unbacked item researched against public sources.

> **Looking for the per-product answer? See [`product_results_table.md`](product_results_table.md)** — 115 products, each with its evidence type, alert number, date and regulator photo count. This document is the reasoning behind it.

**Artefacts:** `research/viral_list_items.json` (117 items, annotated with local DB status) · `research/missing_alerts_2018_2022.txt` (§6) · scripts: `scripts/extract_list.js`, `scripts/build_research_list.js`, `scripts/audit_coverage.js`, `scripts/img_probe.js`, `scripts/vision_probe.js`.

---

## 1. Headline findings

1. **The list is not a leak and not a scoop.** It is a compilation. The originating post is titled *"NAFDAC ALERT: Scrupulous people are faking these 149 products in Nigeria"* and its own caption says the list is **"compiled from NAFDAC alerts and raids."** Roughly 80 of the 115 items we could read map onto public alerts Vouch already holds. Our database is not being accused of anything it does not already know.

2. **It is still enormously valuable — as a coverage-gap detector.** The items that are *not* in our database are exactly the ones the public most needs: the everyday counterfeit-prone brands (Coglaet toothpaste, Big Bull / Royal Stallion rice, Schweppes, Hollandia, Ovaltine, Cadbury, Miksi). **19 of the 23 names we researched are entirely absent from `hazard_alerts`, `known_fakes` and `products`.** A user typing any of them into Vouch today gets nothing.

3. **The list conflates four different kinds of claim**, which is why it cannot be ingested wholesale. See §3.

4. **Separately: 58 public alerts NAFDAC has published are missing from our database**, all from 2018–2022. Details in §6.

---

## 2. Transcription

- All four screenshots are frames of **one** post. `image4.jpeg` is a strict subset of `image3.jpeg`; `image.jpeg` holds columns 51–75 and 1–19, `image2.jpeg` holds 20–24 and 100–115.
- **117 unique items transcribed**, and the numbering was then **recovered from reposts** and cross-checked against the screenshots: items **1–118** are accounted for except **item 76** (a single unnamed item between *Daonil 5mg* and *Neo Medrol*). Items **119–149** could not be recovered — Facebook and Instagram block page reads and search snippets cap at item 120. Full map: `research/viral_list_numbering.md`.
- The four tail items that *are* identifiable (Dex Luxury Bar Soap, Nivea Roll-On, Fair Child Soap, Brown Henna Hair Colour) are **all already in our database** as numbered alerts. The unrecovered tail is therefore low-risk; items 1–118 — the contested, non-alert part — are the ones that mattered, and those are covered.
- Tracked outputs: `research/viral_list_items.json` (deduped items + local DB status) and `research/missing_alerts_2018_2022.txt` (the 58 missing alerts).
- Scratch/intermediate, gitignored, regenerate by re-running: `recon/lists/raw.txt` (raw transcription), `recon/lists/items.json`, `recon/lists/coverage_gap.txt`.
- Reproduction: `scripts/extract_list.js` → `scripts/build_research_list.js` → `scripts/audit_coverage.js`.

---

## 3. Provenance of the list — four tiers

| Tier | Items | What it actually is | Weight |
|---|---|---|---|
| **A. Public alerts** | ~47–118 (most) | Genuine numbered NAFDAC public alerts, e.g. `022/2026` Colgate, `026/2025` Cowbell, `024/2026` Augmentin | **Authoritative.** Importable per our existing rule. |
| **B. Enforcement press statement** | 1–26 | One NAFDAC DG press statement (to Punch Healthwise) about the **15 Dec 2024 "Operation Clean Up Aba"** raid on Aba Cemetery Market | **Real, but not an alert.** No alert numbers, no per-product detail. |
| **C. Enforcement-adjacent** | 103–106 | Tamral 225/250mg, Tramadol 120mg/225mg — Tamral is a real NDLEA seizure (TramaKing 225mg is the documented 225mg line); the generic tramadol lines match NAFDAC's *restrictions advisory*, which is about clinical use, **not** a counterfeit finding | **Mis-cited by the list, and mis-attributed.** |
| **D. Bare categories** | 29–46 | "Palm Oil", "Beans", "Spices", "Petrol/PMS" — no product, no batch, no authority behind the individual line | **Category advice, not evidence.** |

**Tier B in detail** (source: Punch Healthwise via Advent Cable Network, 29 Jan 2025; corroborated by Arise TV). One raid produced items 1 and 12–26 of the list. 240 shops operating as illegal factories, ₦5bn seized, 1,500+ cartons destroyed. Named by the DG:

- *Soft drinks / carbonated:* **Fanta, Coca-Cola, Schweppes, Lacasera, Sprite, Hollandia Yoghurt, Super Commando Energy Drink, Fayrouz, Amstel Malta**
- *Household beverages:* **Peak Sachet Milk, Cowbell Sachet Milk, Peak Chocolate Drink, Miksi Sachet Milk, Cadbury Chocolate Drink, Ovaltine**
- *Also named in the same statement but missing from the list:* Eva, Evra and Cartel non-alcoholic drinks; Seaman Schnapps, Hennessy, Four Cousins, Carlo Rossi, Chelsea London Dry Gin, McDowells, Black Label, Gordon's, Martell, Campari, Smirnoff Ice.
- *Method described by the agency:* contaminated water, hazardous chemicals, saccharin, artificial colouring, re-used dirty bottles, cloned packaging; alcohol adulterated with sugar/starch instead of fruit.
- *Follow-up, 22 Jan 2025:* three warehouses in Aba found **stockpiling expired Hollandia Yoghurt for illegal revalidation** — a distinct fraud mode (date re-badging) from counterfeiting.

⚠️ Date discrepancy to be careful with: Arise TV reports the ₦5bn haul as late January 2025; Punch (the DG's actual recipient) dates the raid **15 December 2024**, with 22 January 2025 being the separate Hollandia-warehouse discovery. Cite Punch's date.

⚠️ Tier B is **one press statement about one raid**. It is evidence that counterfeits of these brands exist, and it is NAFDAC-attributed — but it is an enforcement action, not a public alert. Under our own rule that alerts import directly and leads never become verdicts, Tier B belongs in a lower tier than Tier A.

---

## 4. Per-product research (the items with no local backing)

### 4.1 Coglaet ActivGel 100g · Coglaet Herbal 100g — **CONFIRMED, PUBLIC ALERT**

**Tier A. We already hold the alert, but it cannot be found by name.**

- **Public Alert No. 022/2026**, released 25 Mar 2026 (Kaduna State, Post-Marketing Surveillance).
- Both products are **unregistered** — NAFDAC Reg. No. "Nil" for both.
- Stated manufacturer on pack: **Guangzhou YECAI Oral Cleaning Products Co., Ltd**, 4335 4th floor, Baiyun District, Guangzhou, China.
- Coglaet Crema Dental Herbal 100 g — mfd 04/08/2025, exp 03/08/2029.
- Coglaet ActivGel 100g — mfd 02/08/2025, exp 01/08/2029.
- Sold by a **door-to-door sales representative**; no proof of purchase; removed from the shop, distributor trace ongoing.
- **Images:** the alert page carries NAFDAC's own product photographs of both counterfeits — https://nafdac.gov.ng/public-alert-no-022-2026-alert-on-the-distribution-of-unregistered-and-suspected-counterfeit-colgate-toothpaste/

**Our gap:** our `022/2026` row is titled *"Colgate Toothpaste (unregistered and suspected counterfeit)"*. Searching **"Coglaet" returns zero rows across the entire database** — the brand people actually hold is invisible to us.

### 4.2 "Oral-B counterfeit toothpaste" — **WEAK, do not ingest**

Circulates as a TikTok claim (`@draizident`, ~2 weeks old) with NAFDAC saying only that "investigations are ongoing". No alert number, no seizure record found. Our `041/2026` match was a *different* product (ORACIRE+). **Lead only, and a weak one.**

### 4.3 Dr. Really Extra / Really Extra Diclofenac 50mg — **CONFIRMED, but by investigation, not by alert**

Two independent sources, and the nuance matters:

- **NAFDAC DG speech, 29 Mar 2019** (general destruction exercise): destroyed "**190 cartons of De Really Extra** (Diclofenac Sodium tablet) worth ₦311[m]" among other falsified products.
  https://nafdac.gov.ng/speech-by-professor-mojisola-christianah-adeyeye-at-the-general-destruction-exercise-of-expired-substandard-and-falsified-medical-products-other-spurious-unsafe-and-unwholesome-nafdac-regulated-pr/
- **ICIR investigation, 28 Jun 2019** — purchased from a bus-stop door-to-door seller for ₦100, claimed Indian origin. Lab tested at the College of Medicine, University of Lagos; certificate of analysis dated **12 Apr 2019**. Findings: **"passed the assay of active ingredient (Diclofenac) but the regulatory details are not satisfactory."** NAFDAC's own analyst: *"an illegal brand medicinal product which violates NAFDAC's regulatory laws… criminally produced; there is no address of where it is produced; it is not registered; it is not dated."* Pack had **no NAFDAC number, no batch number, no expiry date, not even on the blister**.
  https://www.icirnigeria.org/toxic-tablets-counterfeit-pills-i-killer-drugs-that-damage-nigerians-health/

**The critical nuance — a lookalike pair:**
- **Dr. Really Extra** = unregistered counterfeit copycat. *(the counterfeit)*
- **Yef Real Extra** = NAFDAC **A11-0298**, genuinely registered… **but failed its own assay**, below the 90–110% specification. NAFDAC no A11-0298 *is* in our register (1 product).

So the *registered* brand is itself substandard. If we ever ingest "Really Extra", the copy must make clear that flagging the copycat does **not** mean the original is safe. This is exactly the kind of claim that must never be reduced to a green tick.

### 4.4 Reliance Extra Diclofenac 50mg — **NOTHING FOUND**

Zero results across every query attempted. It appears only in the recycled viral compilations. Likely the same "…Extra" copycat family as 4.3, possibly a transcription of "Reliance Diclofenac". **No evidence either way — lead only, or drop.**

### 4.5 Tamral 225mg / Tamral 250mg — **CONFIRMED as an illicit tramadol brand, but by NDLEA, not NAFDAC**

- **NDLEA** intercepted **2.4 million tramadol tablets** smuggled from Pakistan into Lagos airport: **7 cartons of 250mg branded "Tamral"** and **45 cartons of 225mg branded "TramaKing"** (reported 9 Oct 2022).
  https://www.thecable.ng/ndlea-intercepts-2-4m-tramadol-tablets-smuggled-from-pakistan-at-lagos-airport/
- A 2025 report on the Aveo/TramaKing network lists the seized products as *TramaKing 225mg, New Tramadol 225mg, TramaKing 250mg, New Royal 225mg, Tamral 250mg*.
  https://www.dawn.com/news/1925250

**Attribution matters:** this is **NDLEA** (law enforcement), not a regulator alert. Our schema attributes every flag to NAFDAC or PPB. Tamral cannot enter the register as a NAFDAC alert. Also note the documented strength is **Tamral 250mg**; the list's "Tamral 225" appears to be the TramaKing 225mg line. **TramaKing / New Royal / New Tramadol are the better-documented names** and we hold none of them.

### 4.6 Big Bull Rice · Royal Stallion Rice · Cap Rice · Stallion Rice · Tomato (Aposo) Rice · Mama Pride Rice — **CONFIRMED as a raid cluster, NAFDAC-attributed**

- **Nasarawa, 15–20 Dec 2024:** NAFDAC busted a warehouse and shops, seizing **1,600 bags of counterfeit rice worth ~₦5bn**. Counterfeit rice was being **repackaged into branded bags — Big Bull, Royal Stallion, Tomato Aposo** — "to deceive unsuspecting consumers". Also destroyed **empty branded bags** for repackaging.
  https://thesun.ng/nafdac-busts-warehouse-shops-seizes-n5bn-counterfeit-rice-in-nasarawa/
- **Rivers / Port Harcourt, ~20 Mar 2025:** **120 counterfeit bags** seized from 10+ shops; found large quantities of **empty counterfeit Big Bull Rice bags** alongside Cap Rice and Stallion Rice brands.
  https://punchng.com/nafdac-seizes-120-bags-of-counterfeit-rice-in-rivers/
- The brands themselves have publicly posted anti-counterfeit guidance (Big Bull: *"Don't buy counterfeit. Watch out for holographic seal tape"* — implying empty cloned bags circulate).

**Fraud mode worth capturing:** this is **repackaging of legitimate empty branded bags**, not fake formulation. That is a distinct, recognisable pattern and it is *not* what our current matching library models.

⚠️ False positive to discard: our triage matched "Cap Rice"/"BUA Rice" to **`034/2026` (Bulmex parboiled rice, Niger Republic import ban over metallic contamination)** purely on the shared word "rice". Different product, different hazard. Discard.

### 4.7 Fanta · Coca-Cola · Schweppes · Lacasera · Sprite · Hollandia Yoghurt · Super Commando · Feyrouz · Amstel Malta · Peak Sachet Milk · Peak Chocolate Drink · Miksi Sachet Milk · Cadbury Chocolate Drink · Ovaltine — **Tier B only** (see §3)

One raid, one press statement. Also worth noting separately:

- **FCCPC** (competition authority, not NAFDAC), Jul 2024: investigation into Coca-Cola Nigeria and NBC business practices, reporting **lookalike products in identical bottles with identical branding** but different ingredients and nutritional value.
  https://fccpc.gov.ng/wp-content/uploads/2024/07/Report-Investigation-of-Coca-Cola-Nig-Ltd-and-NBC-Business-Practices.pdf
- **NAFDAC itself has publicly pushed back on the social-media genre**: *"social-media claims about suspected fake or adulterated food and drinks need proper investigation and scientific [verification]"* (Aug 2026, re: a fake-Aquafina claim).

That last point is the strongest possible argument for keeping Tier B and D out of the verdict layer.

### 4.8 Tier D categories — **no per-item evidence**

Palm Oil, Cooking Oil, Honey, Milk, Yoghurt, Ground Pepper, Spices, Tomato Products, Wheat Flour, Yam Flour, Beans, Egusi/Melon, Seafood, Alcoholic Beverages, Petrol/PMS. These are **categories**, and our DB already holds the relevant *category-level* alerts: `039/2025` (substandard/unregistered edible oils), `008/2018` (honey), `021/2022` (Walmart Great Value milk), `029/2018` (South African meat), `044/2022` (Ryaltris). Nothing to add at product level.

---

## 5. Coverage gaps — brands Vouch cannot find at all

Checked directly against `hazard_alerts`, `known_fakes` (brand_name/aliases included) and `products`:

**Absent from the entire database (zero rows):**
`coglaet` · `tamral` · `dr really` · `reliance extra` · `big bull` · `stallion` · `tomato aposo` · `mama pride` · `hollandia` · `super commando` · `fayrouz` · `lacassera` · `miksi` · `cadbury` · `ovaltine` · `schweppes` · `tramaKing` · `oral-b`

**Present but thin:** `tramadol` (1 alert, 89 register rows, no brand data) · `yef real` (1 register row) · `oral b` (5 register rows, no hazard link)

This is the single highest-value output of today's research. The most counterfeited products in Nigeria are the ones Vouch is blind to.

---

## 6. Separate finding — 58 published alerts missing from the database

`scripts/audit_coverage.js` crawls NAFDAC's alert index and diffs it against `hazard_alerts`:

- Alerts published on NAFDAC's index: **334** (all on page 1; there is no pagination)
- Alert numbers held in our NG database: **277**
- **Missing: 58** — by year: **15 from 2018, 22 from 2019, 6 from 2020, 11 from 2021, 4 from 2022**

Our sync appears to start around 2020. Nothing is missing from 2023–2026 — **current-year freshness is good**, and our newest row (`043/2026`, 19 Aug 2026) matches NAFDAC's newest published alert.

Examples of what is missing: `41/2018` (falsified Costrim/Metronidazole/Catrim/Cemtrim tablets), `38/2018` (amlodipine/valsartan/HCTZ all lots), `30/2020` (Tafrodol warning), `31/2020` (fake hydroxychloroquine), `10/2020` (FARO table water recall).

Full list: `research/missing_alerts_2018_2022.txt`.

---

## 7. A real (minor) matcher bug

`nameMatchScore("oral b counterfeit toothpaste", "ORACIRE+ Toothpaste (suspected counterfeit)")` = **86** — the token-set ratio fires on the shared words "counterfeit" and "toothpaste", so a query for an Oral-B counterfeit surfaces an **ORACIRE+** alert. Verified against the real `server.js` function, not a reimplementation. Low severity (it mis-flags, never under-flags), but it is the class of error that erodes trust in a hazard banner. Worth a stop-word or a requirement that at least one *brand* token matches.

Checked and **clean**: `Tecentriq` → Avastin scores 0. The 90-point whole-word rule does not over-fire on single distinctive brand tokens. (An earlier apparent false positive here was an artifact of my triage script's own heuristic, not the app.)

---

## 8. Recommended actions

**Tier A — import now, no judgement calls (real alerts, same rule as today)**
1. Backfill the **58 missing alerts** from 2018–2022 via the existing alert sync, writing to **both** `hazard_alerts` and `known_fakes`.
2. Enrich `022/2026` with `brand_name` = "Coglaet" and `aliases` = ["Coglaet ActivGel 100g", "Coglaet Herbal 100g", "Coglaet Crema Dental Herbal 100 g"] + the Guangzhou YECAI appearance details, and attach NAFDAC's own product photos from the alert page. Without this, the alert exists but is unfindable by the name on the pack.

**Tier B — needs a decision from you**
3. The Aba-raid brands (14 beverages + 6 alcohols). Evidence is a single enforcement press statement. Options: (a) record as community-report **leads**, surfaced as "recently reported" with the NAFDAC source; (b) add a distinct `enforcement_action` evidence tier that ranks below alerts but above nothing; (c) leave out. **My recommendation: (b)** — it is real, NAFDAC-attributed, and materially useful to consumers, but it must never render as a batch-level verdict.
4. NDLEA tramadol brands (Tamral, TramaKing, New Royal, New Tramadol) — **do not** put these in the NAFDAC-attributed register. They are law-enforcement seizures of an illicit opioid, a different claim from "this product is falsified".
5. Reliance Extra, Oral-B claim — **drop**. No evidence.

**Tier C — engineering**
6. Fix the "oral b counterfeit toothpaste" → ORACIRE+ class of match.
7. Get the remaining screenshots (items 25–50, 76–99) to finish the transcription.

**Standing caveat, unchanged by this research:** none of the above makes any pack genuine. A clean result still proves nothing; "not found" is still not "fake".
---

## 9. What was actually done, and what came out

### 9.1 Reference images — harvested

NAFDAC publishes photographs of the counterfeits on its own alert pages. Crawling all 405 Nigerian alerts:

- **476 regulator-published product photographs across 203 alerts** (`research/alert_photo_manifest.json`)
- **242 downloaded** (48MB, `recon/photos/`)
- **45 of the 115 list products have a regulator photo**, e.g. Cikatem 3, Paludex 3, Giga-S Injection 4, Healmoxy 500mg 4, ORACIRE+ 4, Coglaet 2, Cowbell 2, Amoxivue 3, Rosprazole 3

**234 of the 476 URLs are permanently dead.** All return 404 — NAFDAC has rotated its older uploads, and the Wayback Machine has no copy either (it holds a snapshot *entry* for the page but not the image). Those are unrecoverable, not merely undownloaded.

Inspecting the Coglaet photograph: the counterfeit box reads **Coglaet / Creme Dental Herbal / 100g**, and appears to carry a NAFDAC-format number. NAFDAC's own alert states the Reg. No. is **Nil**. If the pack really does print a registration number, that is a fabricated number — but the digits are too soft to quote without a human eye on it. **Unverified.**

### 9.2 URL-keyed alerts — fixed

Root cause found: `parseAlertNumber` used `\d{1,3}` to read the alert number. NAFDAC writes **four**-digit zero-padded numbers on older alerts (`No. 0037/2022`, `No:0048/2021`, `Public Alert 003/2022`). Three digits followed by a `/` can never match four digits, so the parser silently fell back to keying those rows by their source URL. A missing optional `No` caused the same failure on 2021–22 headlines.

- Fixed in `scripts/nafdac_alert_parser.js`; **13-case regression check** in `scripts/check_alert_number_fix.js`
- `scripts/migrate_alert_numbers.js` re-keyed **71 alerts across both tables** (71 `hazard_alerts` + 71 `known_fakes`, twin tables kept even)
- **6 rows deliberately left URL-keyed**: NAFDAC published these numbers twice, for genuinely different alerts — `0010/2021` (Falsified Vitamin A *and* fake Insulin Tea), `0012/2018` (Australian macaroni *and* Metanor flupirtine), `0013/2018` (rabies vaccines *and* six herbal drugs). Re-keying either would graft one product's hazard onto another.
- **49 rows stay URL-keyed** because NAFDAC publishes no number for them (e.g. "Rwanda Recalls Ketoconazole Oral Tablets").
- Backup at `recon/db-backups/`. All 11 test suites pass. The 2 remaining duplicate numbers (`34/2025`, `35/2025`) are pre-existing and correct — those alerts genuinely cover two products each.

### 9.3 Matcher false positive — fixed

`nameMatchScore("oral b counterfeit toothpaste", "ORACIRE+ Toothpaste…")` returned **86**, because `token_set_ratio` matched the shared class word *toothpaste* plus the shared hazard word *counterfeit*, while the actual brand tokens (`oral`, `b`) appeared nowhere in the alert. The `fuzzy >= 85` branch also short-circuited past the whole-word safety check that exists precisely to prevent this.

Fix: a shopper types the **brand first**, so the first meaningful word of the query (skipping hazard words and function words like "the") is the strongest identity signal available. If the alert title does not contain it, neither branch may stand and the score is capped at 84. The cap applies to the whole-word branch too, which is what killed a second false positive: "Cap Rice" and "BUA Rice" each scored **90** against the Bulmex parboiled rice alert purely on the word "rice".

It is a cap only — it can lower a score, never raise one.

- **0 of 405 alerts lost their self-match** (`scripts/matcher_impact.js`)
- Real matches preserved: Augmentin, Peak Milk, Noristerat, **pantoprazole 40mg tablets → Panto-Denk (90)**, Sprite 50cl, Cikatem, "fake Tramadol 225mg", "the Avastin", OXYCONTIN, Cowbell
- Newly stopped: Oral-B→ORACIRE+, Cap Rice→Bulmex, BUA Rice→Bulmex
- **`scripts/test_matcher.js`** — 19 assertions, wired up as `npm run test:matcher`. It lifts the real function out of `server.js` rather than duplicating it, and fails loudly if the declarations move.
- The Coglaet→Colgate non-match is asserted on purpose, so the known gap stays visible instead of quietly closing.

### 9.4 Research coverage

Every one of the 115 transcribed products is now resolved to an evidence class — no blanks:

| Evidence class | Count |
|---|---|
| Backed by a numbered NAFDAC alert | 74 |
| NAFDAC enforcement action, no alert number | 20 |
| Bare category, no product-level evidence | 14 |
| Drug-enforcement seizure (NDLEA) | 2 |
| Unconfirmed, no evidence found | 4 |
| Lab/journalistic investigation | 1 |

---

## 7. What was built from this research (4 Oct 2026)

The gap this document identified — 18 brand names returning nothing — has been closed. Three changes, all in the working copy at `C:\Users\PC\vouch-next`:

**7.1 Coglaet — the top gap.** Alert `022/2026` was held under NAFDAC's own title, "Colgate Toothpaste", so a shopper reading **Coglaet** off the pack got nothing. `seed_fakes.js` now records `brand_name = "Coglaet"` with both products NAFDAC named (`Coglaet ActivGel 100g`, `Coglaet Crema Dental Herbal 100 g`, plus `Coglaet Herbal 100g`), the stated maker (Guangzhou YECAI Oral Cleaning Products Co., Ltd), and the fact that NAFDAC records **batch number and registration number as "Nil" for both** — so there is no number on the pack to check. `Colgate toothpaste` is kept as an alias so NAFDAC's own wording still finds it. Verified: `coglaet`, `coglaet activgel 100g`, `coglaet herbal 100g` and `colgate toothpaste` all now raise alert 022/2026.

**7.2 Regulator photos.** 242 photos harvested from alert pages are attached to 90 alerts in `known_fakes` and appear in the hazard banner (`npm run photos:attach`). 33 were byte-identical to a photo already held and are reused rather than duplicated. The remaining 234 published URLs are permanently 404 — NAFDAC rotated older uploads; Wayback has page snapshots but not the images.

**7.3 Enforcement actions — a new table, advisory only.** The Aba raid, both rice hauls, the expired-Hollandia warehouses and the Dr. Really Extra case are real and NAFDAC-attributed but carry **no alert number and no batch**, so they live in `enforcement_actions`, not `hazard_alerts`, and render in their own panel that says on its face that it is a record of an action rather than a finding about the pack. They never change a verdict. Full rules in `PROJECT_CONTEXT.md`.

Result across the 18 unfindable names: **13 now return a sourced record** (Coglaet, Big Bull, Royal Stallion, Tomato Aposo, Cap Rice, Stallion, Mama Pride, Hollandia, Super Commando, Fayrouz, Lacasera, Miksi, Cadbury, Ovaltine, Schweppes, Dr. Really), and **4 deliberately return nothing** because there is no product-quality finding to make: Tamral and TramaKing (an NDLEA customs drug seizure, not a regulator finding), Reliance Extra (no evidence located anywhere), and Oral-B (a filename slip on NAFDAC's side — alert 041/2026 is ORACIRE+, and matching Oral-B would implicate a genuine brand). Those four are recorded in the database as `finding_status = 'not_a_finding'` with their reason, so they are not researched again or quietly turned into a hazard later.

**Two corrections to this document's earlier conclusions**, both found by re-reading the primary sources:

- **Mama Pride Rice is not "unconfirmed."** Punch's report of NAFDAC's Rivers statement (20 Mar 2025) names it among "other rice brands" found at a shop trading counterfeit Big Bull. Being named is not the same as being individually tested, and the wording in `enforcement_actions` says so.
- **The Aba raid date is 15 December 2024**, per Punch — which received the DG's statement — not late January 2025 as Arise TV reported. 22 January 2025 is the separate discovery of the expired-Hollandia warehouses.

**Still open:** list items 119–149 are unrecoverable without more screenshots; the 234 dead photo URLs are unrecoverable; alert syncs remain manual.
