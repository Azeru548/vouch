# Vouch

Check a product pack against official registration records before you trust it.

Vouch is a mobile-first web app for shoppers in Nigeria and Kenya who hold a product in one hand and a phone in the other. Photograph the pack or type its details, and Vouch answers one of four verdicts in plain language: **registered and active**, **registered but approval not active**, **details don't match**, or **not found** — with official hazard alerts and community reports layered on top when they apply.

> Vouch compares your details with a local registry snapshot and curated alert data. It is not a guarantee of quality or authenticity, and it is not affiliated with NAFDAC or the Pharmacy and Poisons Board.

## What it does

- **Registry check** — the registration number + product name are matched against a local snapshot of the [NAFDAC Greenbook](https://greenbook.nafdac.gov.ng) (Nigeria) and the Kenya PPB product register (Kenya), with fuzzy name matching and an optional manufacturer cross-check. The registration number is optional: food, drinks and cosmetics often carry none.
- **Photo to number** — a pack photo is read by a vision model to find the NAFDAC number, and separately described so it can be compared against the known-fake library. Two narrow prompts, one photo.
- **Known-fake library** — a curated reference of NAFDAC-flagged counterfeit and unregistered products (drugs, foods, cosmetics) with official NAFDAC photos served offline. When the registry can't confirm a pack, similar library entries are shown as *leads, not findings*.
- **Hazard alerts** — 19 curated NAFDAC public alerts (recalls, counterfeits) matched by registration number or, for unregistered products, by fuzzy name. The alert banner always renders above the verdict.
- **Community reports** — after every check, a modal asks whether the pack looked different or damaged. Three reports about the same pack within 30 days raise a warning for everyone who checks it after that. Reports work with or without a registration number.
- **NAPAMS handoff** (Nigeria) — for unconfirmed numbers, Vouch opens the official [NAPAMS verifier](https://registration.nafdac.gov.ng/) and copies the number across. Results are cached locally only after a human completes the official check. Never automated.

## Quick start

Requirements: **Node 24+** (uses the built-in `node:sqlite` — no native modules, no build step).

```bash
npm install

# One-time data setup (seeds the shipped snapshot; the registry DB ships in data/)
npm run seed:hazards
npm run seed:fakes
npm run seed:reports        # demo data only, marked is_seed = 1

# Run
npm start
# UI  -> http://localhost:3777/
# API -> http://localhost:3777/verify?nafdac=A11-0009&product_name=alben%20paracetamol%20drops
```

Copy `.env.example` to `.env` and set `GROQ_API_KEY` to enable photo reading and pack description. Without it, the app still works fully by manual entry — the UI shows a banner explaining that.

| env var | default | purpose |
|---|---|---|
| `PORT` | `3777` | HTTP port |
| `DATABASE_PATH` | `data/nafdac_products.db` | registry + reports + alerts DB |
| `CACHE_DATABASE_PATH` | `data/napams_cache.db` | locally confirmed NAPAMS records |
| `GROQ_API_KEY` | — | enables `/api/extract` and `/api/describe` |
| `VISION_MODEL` | `qwen/qwen3.8-27b` | Groq multimodal model |

## How a check works

```
GET /verify?nafdac=A11-0009&product_name=alben+paracetamol+drops&country=NG
```

1. Registry lookup — exact match on the number (fuzzy on the name), Active status preferred among near-ties.
2. Hazard check — number-keyed, plus name-only matching for alerts that carry no number.
3. Community flag — ≥3 agreeing reports in 30 days, keyed by number or product name.
4. Known-fake leads — only attached to `not_found`/`mismatch`; a confirmed registration is never second-guessed.

Verdicts: `verified` · `verified_inactive` · `mismatch` · `not_found`. Warnings layer above the verdict — hazard, then community, then the registry result.

## Project layout

```
server.js            Express app: /verify, /report, /api/extract, /api/describe, /api/config, /api/health
web/                 Vanilla HTML/CSS/JS PWA — no framework, no build step
web/fakes/           Official NAFDAC photos of flagged packs, served offline
data/                SQLite registry snapshot + seed scripts' output
scripts/             Ingesters, seeders, and the test suites
recon/               Original research artifacts against the public registries
render.yaml          Render deployment blueprint
```

## Data sources and integrity rules

- The registry is a **point-in-time snapshot**, never presented as live truth. Re-pull with `npm run ingest` (destructive — recreates the DB).
- Known-fake entries are built from `hazard_alerts` (single source of truth) plus library metadata, so the two cannot drift.
- Photos come **only from the official alert pages**, never stock images or lookalikes. Alerts that publish no photo fall back to a written appearance descriptor, and the UI says so plainly.
- Seed rows in `reports` are demo data (`is_seed = 1`) and are labelled as such everywhere they surface.

## Tests

```bash
npm test                 # /verify logic (12 asserted cases) + smoke/security checks
npm run test:hazards     # hazard matching + banner ordering
npm run test:fakes       # known-fake library: migration, matching, lead UI
npm run test:reports     # report API, migration, community flag, rate limit
npm run test:report-ui   # report modal flow, Playwright
npm run test:e2e         # full desktop + mobile flows
```

Test suites spawn the real server against a temporary database and use per-process ports; they never touch the shipped data.

## Deployment

`render.yaml` defines a Render web service (`npm ci --omit=dev`, health check on `/api/health`). Set `GROQ_API_KEY` in the service's environment. Note that `getUserMedia` (camera) requires HTTPS or localhost.

## Further documentation

- [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) — deep technical context: full schema, tuned thresholds, data quirks, and known gaps. Written for contributors picking up the codebase.
- [`PRODUCT.md`](PRODUCT.md) — product brief: users, positioning, principles.
- [`DESIGN.md`](DESIGN.md) — the "Indigo Stamp" visual system and why green is deliberately absent.

## Scope and limits

- Registry data covers registered products only; PPB's public register is essentially human pharmaceuticals, so Kenyan non-drug packs rely on the known-fake path.
- The known-fake library is small and curated, not exhaustive. Appearance matching is a lead generator, not an identifier.
- Checks need a connection; the installed PWA shell opens offline with a clear note.
- No analytics, no third-party scripts — the content security policy is self-only.
