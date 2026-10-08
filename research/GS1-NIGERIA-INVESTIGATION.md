# GS1 NIGERIA — PRODUCT REGISTRY INVESTIGATION

**Date of investigation:** 2026-10-07
**Scope:** Research and technical investigation only. No application code, schema, adapters, or migrations were touched. No scraping/crawling was performed: all observations come from normal page loads, the registry's own public website behaviour, and a small number (~15) of ordinary HTTP requests at a gentle rate.
**Evidence labels used throughout:** `CONFIRMED` = directly established from an official source or observed behaviour. `INFERRED` = logically inferred from observed behaviour, not directly stated. `UNKNOWN` = could not be established from public sources.

---

## 1. Executive summary

GS1 Nigeria operates a **public, unauthenticated product website at `https://productregistry.gs1ng.org/`** ("Products Mart") that is backed by a plain JSON API requiring no API key. A product record exposes **GTIN, brand, company name + physical address, category, packaging type/level, net weight/content, product description, ingredients, storage/direction text, life span, front/back images, listing date, social links — and, critically for Vouch, a `nafdacNumber` field.** Coverage is genuinely cross-category: pharmaceuticals (3,602 records), food/beverages (2,243), herbs/spices (1,187), cosmetics (1,057), biscuits (637) in the five brick categories we measured (8,726 total; other categories exist and were not enumerated). Records are brand-owner-maintained and fresh (a listing dated the day before this audit was observed).

Technically, this is the product-identity source Vouch currently lacks: structured, GTIN-keyed, NAFDAC-linked, free, and robots.txt explicitly allows all crawling.

**Contractually, nothing is confirmed.** The public data-recipient terms restrict API data to internal/"Value-Added Product" use and prohibit redistribution; the registry's own Terms of Service grant only a vague "limited license … for its intended purposes" and say unauthorized use of content is strictly prohibited. Whether a consumer verification app may store, cache, display, or re-expose registry records is **UNKNOWN — requires written clarification from GS1 Nigeria.**

**Recommendation: TIER B (important secondary source), with a documented upgrade path to Tier A pending written licensing confirmation.** Biggest unknown: written permission to store/cache/display GS1 registry records and whether Vouch qualifies as a "Value-Added Product".

---

## 2. Product Registry findings

| Question | Answer | Label |
|---|---|---|
| What is it? | "The GS1 Nigeria Product Registry … a centralized, trusted digital platform — the official database for all registered GTINs belonging to brand owners and manufacturers in Nigeria." (gs1ng.org/solutions/) | CONFIRMED |
| Marketing framing | "A Commercial Platform, Not Just a Compliance Tool" — product discovery, buyer links, buyer interest indicators | CONFIRMED |
| Who populates it? | GS1 Nigeria members (brand owners/manufacturers) list their products through the member portal (`membershipportal.gs1ng.org`) | CONFIRMED (site) / listing flow INFERRED from ToS + portal |
| Is it pharma-only? | No. Nav categories observed: PHARMACEUTICAL, FOOD/BEVERAGES, HERBS/SPICES, COSMETICS, BISCUITS/COOKIES, plus FRESH (farm produce), FASHION (apparel), HEALTH, LEATHER/CRAFT banners | CONFIRMED (UI) |
| Import handling / foreign products | A foreign GTIN lookup (`5000112637922`, UK-issued) returned **HTTP 204 No Content** — the NG registry does not resolve non-615 GTINs | CONFIRMED (this endpoint) |
| GS1 prefix observed | All sampled GTINs start `615` (6151/6152/6154/6156 = GS1 Nigeria prefix range) | CONFIRMED (sample) |
| Contains non-Nigerian GS1 members? | No evidence of any; all sampled records are 615-prefixed | INFERRED from sample |

**Measured coverage (page-1 requests, `totalCount` field):**

| Brick category | Brick code | totalCount |
|---|---|---|
| Pharmaceutical Drugs | 10005845 | 3,602 |
| Food/Beverage/Tobacco Variety Packs | 10000590 | 2,243 |
| Herbs/Spices (Shelf Stable) | 10000049 | 1,187 |
| Cosmetics — Complexion | 10000532 | 1,057 |
| Biscuits/Cookies (Shelf Stable) | 10000161 | 637 |
| **Sum of measured bricks** | | **8,726** |

Other categories (fresh/farm produce, fashion/apparel, leather, etc.) exist in the UI; **registry-wide total: UNKNOWN** (not enumerated — no crawl performed).

---

## 3. Public-access findings

- **Exact URL:** `https://productregistry.gs1ng.org/` — CONFIRMED (homepage link "View our product registry" on gs1ng.org).
- **Publicly accessible without login:** CONFIRMED. Full product list, category browsing, pagination, product detail pages, and name search all work for an unauthenticated visitor. "Sign In" (Google Identity Services) exists but gates only member features.
- **Registry ToS explicitly contemplates non-members:** "This Site is intended for showcasing our members' products to a larger audience. Additionally, **non-members can use our site to learn more about a product and its owner.**" — CONFIRMED (`/policy/termsofservice`).
- **robots.txt:** `User-agent: * / Allow: /` plus `Sitemap: https://productregistry.gs1ng.org/prodtrail_index.xml` — CONFIRMED. Automated fetching is **not disallowed** by robots.txt (note: robots permissiveness ≠ licensing permission).
- **Search capabilities (public UI):**
  - Product-name search: `GET /api/product/searchterm?term=peak` returned matching products with pagination UI ("1 of 20") — CONFIRMED (name search works; partial matches work: "peak" matched "Peak", suggesting substring/starts-with behaviour).
  - GTIN search: URL-routed per product (`/products/product-detail/01/<GTIN>`), not a text-box GTIN search on the registry itself.
  - Brand/manufacturer/category as *search fields*: not observed as dedicated inputs — category filtering is the nav; company search exists only on the Verified-by-GS1 site. UNKNOWN beyond observed behaviour.
- **Individual product pages:** public, stable URLs, structured data loaded from a JSON endpoint — CONFIRMED.
- **Product detail page exposes structured data:** CONFIRMED (via its own API call, §5).
- **A public search/listing endpoint exists:** CONFIRMED (§7).

---

## 4. Product record schema

Field table for an actual publicly visible record (`/api/product/gtin?gtin=6156000578545`, pharma; cross-checked against food/cosmetics/herbs samples):

| Field | Example | Present? | Source | Structured? | Required? |
|---|---|---|---|---|---|
| GTIN | `6156000578545` | YES | Product Registry | YES (JSON string) | YES (key) |
| Product name | `STARNICILLIN Ampicillin B.P. 250mg Capsules` | YES | `productDescription` | YES | ? |
| Brand | `STARNICILLIN` | YES | `brandName` | YES | ? (often noisy, see §18) |
| Manufacturer | `PETSOW LABORATORIES LIMITED` | YES | `companyName` | YES | ? |
| Company/brand owner address | `PLOT 8-10, EZIAMA INDUSTRIAL ESTATE, …, NIGERIA` | YES | `address` (free text) | NO (unstructured) | ? |
| Category | `Pharmaceutical Drugs` | YES | `category` | YES | ? |
| Product description | same as name + longer text | YES | `productDescription` | YES | ? |
| Package size | `72.73` + unit `GRM` | YES | `netweight` + `netcontent` | YES (split numeric/unit) | ? |
| Packaging type | `Carton` / `Cup` / `Pouch Bag` / `Shrinkwrap` | YES | `packagingType` | YES | ? |
| Packaging level | `Each` / `Inner Pack` | YES | `packagingLevel` | YES | ? |
| Country | only via free-text `address` | PARTIAL | address string | NO | ? |
| Image (front/back) | `Resources\Images\ProductImages\brand_26080272\6156000578545_frontimg_…jpeg` | YES (both; some records have back only or front only) | `frontImage`/`backImage`, served from `membershipservices.gs1ng.org` | YES (path) | NO |
| NAFDAC number | `04-4697` | YES on many records (sparse outside pharma — see §15) | `nafdacNumber` | YES | NO |
| Barcode | the GTIN itself | YES | `gtin` | YES | YES |
| Status (active/expired) | — | **NO** | — | — | — |
| Date created (listing) | `2026-10-06T14:47:08.4164316` | YES | `dateOfListing` | YES (ISO) | ? |
| Last updated | — | **NO** (only `dateOfListing`) | — | — | — |
| Ingredients | `AMPICILLIN 250` | YES (often null outside pharma) | `ingredients` | YES | NO |
| Allergen info | null in all samples | FIELD EXISTS, null | `allergenInfo` | YES | NO |
| Storage information | `Store in a cool clean place…` | YES on pharma, often null elsewhere | `storageInformation` | YES | NO |
| Direction of use | `As directed by Physician` | YES on pharma, often null elsewhere | `directionOfUse` | YES | NO |
| Life span | `3` + `years` | YES on many | `lifeSpan`/`lifeSpanUnit` | YES | NO |
| Company website / socials | all null/empty in samples | FIELD EXISTS | `companyWebsite, facebook, instagram, twitter` | YES | NO |
| Ingredients/registration id | `26080272` | YES | `registrationId` (appears to be the member/company account id — also used in image paths `brand_<registrationId>`) | YES | ? |
| Paid flag | `false` | YES | `isPaid` | YES | ? |
| Custom fields | `[]`/null | YES | `customFields` | YES | NO |

No image-level or batch/expiry/serial fields exist on the registry record. The public UI presents a subset (GTIN, Category, Brand, Net Content, Life Span, Package Level, Package Type, NAFDAC Number, Description, Company Info, Storage/Instructions/Ingredients) — the underlying API returns more than the UI shows.

---

## 5. API findings

**There is no documented, published GS1 Nigeria API** (no developer docs, base URL, or auth docs found on gs1ng.org). However, the public website is an Angular SPA backed by an unauthenticated JSON API — **technically observable, not officially documented.** Endpoints observed through normal browser/network inspection:

| Endpoint | Method | Params | Response | Auth |
|---|---|---|---|---|
| `/api/product/featureproduct` | GET | — | `[{gtin, frontImage, backImage, description, brandName}]` | none |
| `/api/products/all?page&size&catlevel=brick&code` | GET | `page`, `size`, `catlevel=brick`, `code=<brickId>` | `{productDTO:[…full records…], totalCount}` | none |
| `/api/product/gtin?gtin=<GTIN>` | GET | `gtin` | full product DTO (§4); **HTTP 204** if unknown | none |
| `/api/product/searchterm?term=<q>` | GET | `term` | `[{gtin, description, image, companyWebsite, facebook, instagram, twitter}]` | none |

- **Authentication:** none required for the above — CONFIRMED (ordinary fetches with a browser UA returned 200).
- **Rate limits:** none observed at ~15 gentle requests — CONFIRMED at this volume only; **documented limits: UNKNOWN.**
- **Pagination:** `page`/`size` with `totalCount` — CONFIRMED (UI offers 10/20/30/50; category paging observed to page 361 for pharma at size 10).
- **Public status:** it is *clearly intended for public website functionality* (it powers the public site) — CONFIRMED. Whether its use by third-party clients is *permitted by contract* is UNKNOWN (§8).
- **Is it:** (1) public — yes technically; (2) member-only — no; (3) paid — no observed charge; (4) enterprise-only — no; (5/6/7) available through GS1 Nigeria/Global/provider — no published offering found. Labels: technical answers CONFIRMED; contractual answer UNKNOWN.
- The **Verified by GS1** site (`gs1vbgservices.gs1ng.org`) also has a public search UI (GTIN / GLN / company name+country) protected by **invisible reCAPTCHA**; an automated unauthenticated search produced **no XHR response** in this investigation, so its API endpoint, request/response schema, and limits are **UNKNOWN** (no bypass attempted). — CONFIRMED (UI exists; captcha present).

---

## 6. Batch/bulk findings

- **Public bulk download (CSV/JSON/XML dump): NONE found** — CONFIRMED by absence across gs1ng.org pages, registry site, robots/sitemap.
- **Batch querying:** "Different capabilities are also available for querying the Registry such as single GTIN query (via web interface), **batch querying or API connection**" — but framed as member capabilities: "**All members of GS1** can have access to the global GS1 Registry Platform through any participating local GS1 office, using Verified by GS1 to query GTINs." — CONFIRMED (gs1ng.org/retail/).
- **GET ALL:** the data-recipient terms state "**GS1 Nigeria is authorised to commercialise GET ALL as an offering to their Licensees**" — i.e. a bulk product exists, but as a commercial licensee offering — CONFIRMED (terms); **pricing UNKNOWN**.
- **GDSN:** exists as a data-distribution channel (§17) — potentially a structured bulk-ish path for suppliers/recipients, not a public dump.

**Answer to "Can Vouch legally and technically obtain a large product dataset?":**
Technically: a large dataset could be assembled via the public paginated endpoint (not attempted, and **not recommended before licensing clarity**). Legally: **UNKNOWN.** The only expressly licensed bulk route is paid licensee **GET ALL** (Outcome **B/C**); without any agreement, the honest current state is **F (unknown)** leaning **D (batch via membership)** for legitimate documented access.

---

## 7. Membership findings

- GS1 Nigeria membership is **mandatory to register products** and to access Verified by GS1: "Companies need to be a member of GS1 Nigeria to access Verified by GS1" (VbG FAQ) and registry ToS eligibility: "Be an existing GS1 Nigeria member…" — CONFIRMED.
- To get GTINs: CAC certificate, utility bill, signed membership document, proof of payment; GTIN allocation requires renewal while in use ("scale of fees") — CONFIRMED (membership FAQs).
- **Can a software company join as a data recipient without owning GTINs?** UNKNOWN — no published "data recipient membership" path found (the data-recipient terms exist, implying data recipients are a recognized category, but signup details are absent).
- **Developer/API plan, API inclusion in membership, extra API fee, batch inclusion, GET ALL price, GDSN price:** all **UNKNOWN — contact GS1 Nigeria.** No public fee schedule page could be located (FAQ references a "scale of fees" table; `/scale-of-fees/` returns 404; no fee link found in site navigation).
- Member portal: `https://membershipportal.gs1ng.org/auth/login` — CONFIRMED (link only; not accessed).

---

## 8. Licensing findings

Two published documents matter; a third could not be read.

**A. `gs1ng.org/terms-and-conditions-data-recipients/` (read in full) — CONFIRMED text:**
- Applies to "MO Data Recipients" and "Data Out Solutions".
- *API solution:* "The Data Recipient may not use, sell, sublicense, distribute or otherwise make available the Data to third parties, **unless such use is part of a Value-Added Product** and complies with this Terms of Use." Third parties (including agents/sub-contractors) must be bound equally; breach → immediate removal of API access.
- *Other solution offerings:* "may use the Data **solely within its own business … excluding any commercial use** (i.e. any use where the Data is sold, leased, licensed or otherwise made available…)" and "shall not be allowed to share, release, submit or allow extraction of the Data by any party other than its own employees or agents."
- GS1 Nigeria may commercialize **GET ALL** to Licensees.
- No warranty; verifications are "automated logical checks"; data explicitly **not suitable for regulatory purposes**.
- **"Value-Added Product" is NOT defined anywhere on the public pages** → `UNKNOWN — requires written clarification from GS1 Nigeria.`

**B. Product Registry `/policy/termsofservice` (read in full) — CONFIRMED text:**
- Eligibility: members must be members to *register products*; "non-members can use our site to learn more about a product and its owner."
- IP: all content (including images) "owned or licensed to GS1 Nigeria"; user gets "a limited, non-exclusive license to use the Site **solely for its intended purposes**. **Unauthorized use of any content is strictly prohibited.**"
- **Silent on:** programmatic access, API use, caching, storage, redistribution, derived data, commercial use of *product facts*. → those answers are UNKNOWN, not approved.

**C. "Verified by GS1 Terms of Use"** — linked from the gs1ng.org footer as a **Google Drive PDF** (`drive.google.com/file/d/10qS8RQ4Ue_Q7dwGCwpw8lQUe8V2OUrtI`); the page path `gs1ng.org/verified-by-gs1-terms-of-use/` returns **404**. The PDF could not be text-extracted with available tooling (binary download) → **content UNKNOWN; should be read manually before any decision.**

**Implication for Vouch:** the data-recipient terms most plausibly govern the *Verified-by-GS1/registry-platform data outputs*; the registry website ToS governs the *public site*. Neither grants an explicit right to store/cache/re-display records. Applicability of each document to the other's data is itself UNKNOWN.

---

## 9. Storage/caching findings

| Action | Answer | Label |
|---|---|---|
| Store returned GS1 product data in Vouch's DB | Not expressly permitted, not expressly prohibited for public-registry site content; **prohibited (absent VAP) for Data-Out API data** | UNKNOWN — requires written clarification |
| Cache query results | No clause found either way (public site); API terms bar making data available to third parties, caching intent unstated | UNKNOWN — requires written clarification |

---

## 10. User-display findings

| Action | Answer | Label |
|---|---|---|
| Display GS1-derived product info to end users | Registry ToS says non-members may "learn more about a product and its owner" via the site — suggests consumer display of facts is in the spirit of the intended purpose; but "unauthorized use of any content is strictly prohibited" and no display license is granted explicitly | INFERRED (permitted in spirit) / UNKNOWN (explicitly) |
| Display product images | Images are "owned or licensed to GS1 Nigeria"; publicly fetchable (observed HTTP 200, `image/jpeg`) but third-party display license unstated; image paths are stable and public | technically CONFIRMED public, legally UNKNOWN |
| Say "GS1 reports this GTIN as associated with Brand X" | Attributive, factual restatement; not addressed by any published clause | UNKNOWN — requires written clarification |

---

## 11. Commercial-use findings

- For the **non-API data-recipient solutions**: "excluding any commercial use" — CONFIRMED prohibited.
- For **API data**: commercial use possible only "as part of a Value-Added Product" (undefined) — CONFIRMED restriction, UNKNOWN applicability.
- For the **public registry website**: no commercial-use clause — UNKNOWN.
- Monetizing a Vouch service built on GS1 data: **UNKNOWN — requires written clarification.**

---

## 12. GTIN findings

- GTIN types explained by GS1 Nigeria: GTIN-8/12/13/14, GS1-128, DataMatrix, QR — CONFIRMED (membership FAQs).
- The registry is fundamentally **GTIN → product record** (one record per GTIN, §5 endpoint) — CONFIRMED, with the record carrying attributes (Verified by GS1's role is checking *attribute presence* for a GTIN — CONFIRMED, VbG FAQ).
- **Variants get separate GTINs:** GS1 rules require "every significant change (size, color, type, model, measure…) involves a NEW GTIN" — CONFIRMED (FAQ). Observed: two near-identical STARNICILLIN records with different GTINs (6156000578545 / 6156000578538) — variant-vs-duplicate ambiguity is real (§18).
- Net weight + net content unit + packaging level/type are present, so **250 ml vs 500 ml vs 1 L can be distinguished** — CONFIRMED (fields exist; quality varies).
- **Batch/lot/serial/expiry are NOT registry fields** — CONFIRMED absent (lifeSpan only). Batch-level identity remains outside GS1 registry scope (it belongs to DataMatrix/serialization/EPCIS — §17 context).

---

## 13. Company/GLN findings

- Company name + physical address: present on every sampled record — CONFIRMED.
- Company website/socials: fields exist, all null/empty in samples — CONFIRMED (sample).
- **GLN:** exposed on the Verified-by-GS1 site as a separate "Verify Location/party" search — CONFIRMED (UI); GLN **not** present in registry product DTOs — CONFIRMED.
- Legal entity status/country fields: not structured (address free text only) — CONFIRMED absent.
- `registrationId` appears to be GS1 Nigeria's internal member/account id (appears in image paths `brand_<registrationId>`) — INFERRED. This is a usable **company key** for Vouch's Company→Brand→GTIN model, but is internal, not a GLN.
- **Model feasibility:** Company(owns)→brand/GTIN is *partially* supportable today (companyName+address+registrationId), full GLN linkage requires the Verified-by-GS1 company search — INFERRED.

---

## 14. Image findings

- Product images served from `https://membershipservices.gs1ng.org/Resources/Images/ProductImages/brand_<registrationId>/<GTIN>[_frontimg|_backimg]_<timestamp>.<ext>` — CONFIRMED.
- Publicly downloadable without auth (HEAD → 200, `image/jpeg`, 112 KB sample) — CONFIRMED.
- Front and back images both exist for many records (back image often the label — potentially valuable to Vouch: ingredients/NAFDAC panel text) — CONFIRMED (sample).
- Caching/redisplay by a third party: **UNKNOWN** (registry ToS IP clause). No large-scale downloads were performed.

---

## 15. NAFDAC linkage findings

**The GTIN ↔ NAFDAC bridge exists — this is the single most valuable finding for Vouch.** `nafdacNumber` is a first-class field on registry records:

| Category (page-1 samples) | `nafdacNumber` present |
|---|---|
| Pharmaceutical Drugs (n=10) | **10/10** (e.g. `04-4697`) |
| Herbs/Spices (n=5) | **3/5** (e.g. `08-2427`) |
| Food/Beverage (n=10) | 1/10 (e.g. `01-9059`) |
| Biscuits/Cookies (n=10) | 1/10 |
| Cosmetics (n=10) | 0/10 |

Corpus-wide fill rate per category: **UNKNOWN** (samples are page-1 only, no crawl). Regulatory *status/expiry* is **NOT** in the record — GS1 supplies the identifier, not the regulatory verdict (consistent with the ToS disclaimer that GS1 verifications are "not suitable for any regulatory purpose").

**Proposed architecture validated:** `GTIN → GS1 identity + nafdacNumber → NAFDAC evidence → recall evidence` — the join key already exists in GS1's own schema, at least for regulated categories. Do not assume it exists for every product (observed sparse outside pharma/food).

---

## 16. Imported-product findings

- Foreign GTIN (5000112637922) → HTTP 204 in the NG registry — CONFIRMED: **GS1 Nigeria's Product Registry does not resolve foreign GTINs.**
- Whether **Verified by GS1 / GS1 Registry Platform** resolves foreign GTINs: members can query "the global GS1 Registry Platform" through local MOs (CONFIRMED capability statement, retail page) — so global resolution presumably exists behind VbG, but was **not demonstrated** (public VbG search is reCAPTCHA-gated and no result was obtained) → INFERRED / behavior UNKNOWN.
- Practical consequence: products sold in Nigeria but carrying foreign-issued GTINs will be absent from the NG registry; Vouch's imported-goods coverage needs VbG/global access or another source.

---

## 17. GDSN findings

- What it is: Global Data Synchronisation Network — standardised product master-data exchange between suppliers and data recipients via certified data pools (gs1ng.org/gdsn/) — CONFIRMED (page describes benefits for "data suppliers" and "data recipients").
- Does GS1 Nigeria operate/access a data pool? The page references "our independent solution" for healthcare/retail but **names no data pool, no provider, no API, no pricing** — UNKNOWN.
- Can technology companies consume GDSN data? In general GDSN requires a certified data-pool connection and trading relationships — INFERRED from the standard's design; GS1-NG specifics UNKNOWN.
- Different from Verified by GS1? Yes — GDSN = supply-chain master-data sync; VbG = identity verification registry — CONFIRMED (distinct solutions on gs1ng.org).
- Relevant to consumer verification? Indirectly (richer attributes: allergens, nutrients, images per NPC/GDSN description) — INFERRED.
- Expensive / commercial agreement needed? UNKNOWN — presumed yes (certified data pool + membership) — INFERRED.
- **Long-term architecture verdict: investigate only after GS1 Nigeria contact is established; not needed for Vouch Phase 1–6.**

**System comparison table (§6 of brief):**

| System | Purpose | Product fields | Public? | Member? | API? | Batch? | Cost |
|---|---|---|---|---|---|---|---|
| Product Registry (productregistry.gs1ng.org) | Showcase/discover NG-registered GTINs | Full record incl. GTIN, brand, company, category, images, `nafdacNumber` (§4) | YES (browse + JSON) | Only to *contribute* | undocumented JSON (public) | via pagination (undocumented) | Free (observed) |
| Verified by GS1 (gs1vbgservices.gs1ng.org) | Verify attribute presence for a GS1 key | Basic: brand, target market, net content, functional name (VbG FAQ) | Search UI public (reCAPTCHA) | Membership required for access per FAQ | "API connection" (member) | Yes (member) | UNKNOWN |
| National Product Catalog (NPC) | Rich item/price data (nutrients, allergens, images) | Much richer | NO — "limited to NPC subscribers" | Yes + supplier–retailer agreement | UNKNOWN | UNKNOWN | UNKNOWN |
| GS1 Registry Platform | Global identity registry hosted by GS1 | GS1 keys/attributes | NO | Via member MOs | via MO | via MO | UNKNOWN |
| GDSN | Supply-chain master-data sync | Very rich (via data pool) | NO | Yes (certified data pool) | Yes (data pool) | Yes (sync) | UNKNOWN |

---

## 18. Sample-data quality observations

Sample = first page of 5 brick categories (10/10/5/10/10 records) + 1 featured-products payload + 1 detail record + 1 name search. **No crawl performed.**

| Category | n | NAFDAC# | Images | Ingredients | Completeness notes |
|---|---|---|---|---|---|
| Pharmaceutical | 10 | 10/10 | front+back present in sample | present | Rich: storage, directions, lifeSpan |
| Food/Beverage | 10 | 1/10 | present | often present | Address sometimes short/partial (`YAKUBU GOWON WAY, JOS,`) |
| Cosmetics | 10 | 0/10 | present | mostly null | Sparsest: storage/directions null; `brandName` often a generic ("HAND AND BODY LOTION") |
| Herbs/Spices | 5 | 3/5 | present | present | Good |
| Biscuits | 10 | 1/10 | present | mixed | Good |

- **Obvious duplicates/variants:** STARNICILLIN Ampicillin 250mg appears under GTINs 6156000578545 and 6156000578538 with *identical* description/netweight — either carton-level duplicates or indistinguishable variants — INFERRED duplicate risk; Vouch must not collapse GTINs blindly.
- **Brand field noise:** `brandName` sometimes equals the product description (`PEARS BABY CREAM PROMO 60X125G`), sometimes the company (`YALE FOODS LIMTED`, typo as written), sometimes a true brand (`STARNICILLIN`) — real data-quality issue for a `brand` attribute.
- **Freshness evidence:** `dateOfListing` observed: 2026-10-06 (1 day before audit), 2026-10-03, 2026-09-21, 2026-08-17 — brand owners list continuously — INFERRED continuously-updated, no separate updated_at/status field.
- **Stale-record detection:** impossible from the payload (no expiry/deleted flag) — UNKNOWN.
- **Verdict for Vouch usefulness:** high identity value (GTIN + company + NAFDAC + images), moderate text-quality issues, no regulatory status — usable as *identity evidence*, never as a verdict.

---

## 19. Unknowns

1. Whether Vouch may **store, cache, display, or re-expose** registry records (public site ToS is silent and content-use-restrictive).
2. Whether Vouch qualifies as a **"Value-Added Product"** under the data-recipient terms (term is undefined publicly).
3. The content of the **Verified by GS1 Terms of Use PDF** (Google Drive binary; not machine-readable with available tooling).
4. **Pricing**: membership scale of fees, API/batch pricing, GET ALL pricing, GDSN pricing — no public fee page located (404 at `/scale-of-fees/`).
5. Registry-wide **record total** (only 5 bricks enumerated: 8,726) and per-category `nafdacNumber` fill rates corpus-wide.
6. Whether a **non-manufacturer technology company** can join as a data recipient.
7. **Rate limits** and abuse policy of the undocumented JSON endpoints.
8. **Verified by GS1 search API** endpoint/schema (reCAPTCHA-gated; not bypassed).
9. Whether **VbG/Registry Platform** resolves foreign GTINs for non-members (stated capability for members only).
10. Whether the registry and VbG share one underlying store (registry `registrationId` vs VbG company/GLN model).
11. Image licensing for third-party display.
12. Freshness semantics: is `dateOfListing` creation-only? Are deletions/updates tracked anywhere public?

---

## 20. Questions requiring direct GS1 Nigeria confirmation

*(Prepared, NOT sent — see §23.)*

1. Can a technology company join GS1 Nigeria as a data recipient without being a GTIN-owning manufacturer?
2. Can Vouch access the Product Registry programmatically?
3. Is there a public API? What are its base URL, terms, and rate limits?
4. What API fields are available?
5. Is batch GTIN lookup available?
6. Is bulk GET ALL available?
7. What does it cost?
8. Can Vouch cache returned records?
9. Can Vouch store returned records in its own database?
10. Can Vouch display those records to consumers?
11. Can Vouch combine GS1 data with NAFDAC/PPB/Open Food Facts/user-generated evidence?
12. Can Vouch expose derived verification results through its own API?
13. Does this qualify as a GS1 "Value-Added Product"? (Please define "Value-Added Product".)
14. Can Vouch commercially operate such a service?
15. What attribution is required?
16. Are product images licensed for third-party display?
17. Does GS1 Nigeria provide foreign GTIN resolution (or via Verified by GS1 / the GS1 Registry Platform)?
18. Is GDSN access available to Vouch?
19. What is the pricing for API/batch/bulk access?
20. What agreement would Vouch need to sign?
21. (addendum) May we read the Verified by GS1 Terms of Use — is there a non-Drive URL?
22. (addendum) Is the undocumented JSON API behind productregistry.gs1ng.org sanctioned for third-party use?

---

## 21. Vouch recommendation

### TIER B — IMPORTANT SECONDARY SOURCE (with a documented path to Tier A)

**Why not Tier A today:** the data is technically everything Vouch needs, but *every storage/display/redistribution question is contractually unconfirmed*, there is no documented API, and the only expressly licensed bulk route (GET ALL) is a paid licensee offering. Building an ingestion pipeline on top of an undocumented endpoint while the applicable terms are ambiguous would violate Vouch's own rule: *"Do NOT scrape a site just because its data is visible in a browser"* and *"Licensing must be part of the ingestion decision."*

**Why not Tier C/D:** Tier C ("lookup-only") understates what is publicly observable — the paginated public API plus robots.txt allowance make local storage *technically* straightforward; Tier D is wrong because nothing observed blocks the relationship — GS1 Nigeria positions the registry as a discovery platform for a broad audience and explicitly welcomes non-members.

**Path to Tier A (in order):**
1. Send the §20 questions; obtain written answers on storage/display/commercial use and the VAP definition.
2. Read the VbG Terms PDF.
3. If permission granted (free or via a modest data-recipient agreement): build a GS1 adapter as a *product-identity evidence source* keyed on GTIN, with `nafdacNumber` feeding Vouch's regulatory join — likely the strongest identity source available for Nigeria.
4. Until then: GS1 may be used only as a **manual, per-GTIN human lookup** during research, and the public website may be browsed as a normal visitor.

---

## 22. Evidence / source URLs

| # | URL | What it established |
|---|---|---|
| 1 | https://gs1ng.org/ | Product Registry + Verified by GS1 entry links; VbG positioning ("GS1 Registry Platform … queried globally through GS1 Member Organisations") |
| 2 | https://gs1ng.org/solutions/ | "official database for all registered GTINs belonging to brand owners and manufacturers in Nigeria"; Digital Profile; commercial-platform framing |
| 3 | https://gs1ng.org/retail/ | Query modes: single GTIN / batch / API; member access to global Registry Platform |
| 4 | https://gs1ng.org/verified-by-gs1-faqs/ | VbG = basic-attribute verification; membership required; NPC vs VbG vs Barcode Check distinctions |
| 5 | https://gs1ng.org/terms-and-conditions-data-recipients/ | Data-recipient restrictions; Value-Added Product clause; GET ALL commercialization; internal-use-only for non-API solutions |
| 6 | https://gs1ng.org/gdsn/ | GDSN supplier/recipient benefits; no data-pool/pricing detail |
| 7 | https://gs1ng.org/membership-faqs/ | Membership requirements; GTIN types; "scale of fees" reference |
| 8 | https://productregistry.gs1ng.org/ | Public registry UI ("Products Mart"), categories, featured products |
| 9 | https://productregistry.gs1ng.org/robots.txt | `Allow: /` + sitemap |
| 10 | https://productregistry.gs1ng.org/policy/termsofservice | Registry Terms: member/non-member purposes; IP/content restrictions |
| 11 | https://productregistry.gs1ng.org/api/products/all?page=1&size=10&catlevel=brick&code=10005845 (and codes 10000590, 10000049, 10000532, 10000161) | Category listings, `totalCount`, full record schema |
| 12 | https://productregistry.gs1ng.org/api/product/gtin?gtin=6156000578545 | Full product DTO incl. `nafdacNumber: 04-4697`, `dateOfListing` |
| 13 | https://productregistry.gs1ng.org/api/product/gtin?gtin=5000112637922 | HTTP 204 — foreign GTIN not resolved |
| 14 | https://productregistry.gs1ng.org/api/product/searchterm?term=peak | Public name search endpoint |
| 15 | https://productregistry.gs1ng.org/products/product-detail/01/6156000578545 | Public detail page rendering of the record |
| 16 | https://gs1vbgservices.gs1ng.org/ | Public VbG UI (GTIN/GLN/company search), invisible reCAPTCHA |
| 17 | https://membershipservices.gs1ng.org/Resources/Images/ProductImages/… | Public image hosting (HTTP 200, image/jpeg) |
| 18 | https://drive.google.com/file/d/10qS8RQ4Ue_Q7dwGCwpw8lQUe8V2OUrtI/view | "Verified by GS1 Terms of Use.pdf" — binary, NOT extracted (UNKNOWN) |
| 19 | https://gs1ng.org/verified-by-gs1-terms-of-use/ | HTTP 404 (page does not exist) |
| 20 | https://gs1ng.org/scale-of-fees/ | HTTP 404 (no public fee schedule located) |

**Method note:** All web observations were made through a normal headless Chromium (Playwright) browsing session and a handful of ordinary HTTP GETs with a standard browser User-Agent. No authentication was used or bypassed, no CAPTCHA was solved or defeated, no endpoints were brute-forced, no bulk harvesting, crawling, or image downloading was performed, and nothing was written to any Vouch code, schema, or database during this investigation.
