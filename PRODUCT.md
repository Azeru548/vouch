# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Consumer-facing first: any person holding a product pack at a market stall, chemist counter, or shop — phone in one hand, pack in the other. Pharmacists and health workers must also be able to use the same flow without a separate mode.

## Product Purpose

Let anyone check whether a medicine, food, drink, or regulated product is genuinely registered before buying or using it. It exists because counterfeit and unregistered products circulate in Nigeria and Kenya and ordinary buyers have no fast way to verify a pack. Success means a shopper can go from pack to a trustworthy verdict in under a minute, on a phone, with no training.

## Positioning

Layered verification no neighbor can truthfully copy with a single lookup: official registry match (NAFDAC Greenbook / Kenya PPB snapshot) plus live community-report flags plus curated NAFDAC hazard alerts, all shown on one screen with the hazard layer always on top.

## Operating Context

One-handed mobile use in markets, shops, and clinics, often on small screens and slow connections. The ritual is: see a pack, read or photograph its registration number, type the product name exactly as printed, get a verdict, optionally report. Camera use, photo upload, and the official NAPAMS handoff (Nigeria) are part of the flow. Verification needs a connection; the installed app shell must open offline with clear messaging.

## Capabilities and Constraints

Confirmed: registration-number + product-name verification against local NG/KE snapshots with fuzzy matching; optional manufacturer check; photo-to-number extraction via vision service; community reporting with session rate limits and 30-day flag threshold; curated NAFDAC hazard alerts with number-keyed and name-only matching; report density map; NAPAMS manual handoff (Nigeria only, CAPTCHA-protected, never automated).

Constraints: installable PWA, mobile-centric, app-shell offline only (checks require connection); plain simple English; no framework — vanilla HTML/CSS/JS served by Express; Node 24+, SQLite; snapshot data is point-in-time, never presented as live truth.

Undecided: local-language UI strings (deferred); full offline registry (rejected for now); push notifications (not discussed).

## Brand Commitments

Name Vouch. The redesign must NOT use green as a brand color — users must never confuse Vouch with the official NAFDAC government site. The existing green registry identity is discarded, not binding.

## Evidence on Hand

Live app at local Express server (`server.js`, `web/`); 8,977-row Nigeria snapshot plus 3,235-row Kenya snapshot in `data/nafdac_products.db`; 14 curated NAFDAC alerts in `hazard_alerts`; Playwright E2E with desktop/mobile screenshots in `screenshots/`. No testimonials, no press, no invented claims.

## Product Principles

1. The verdict must be readable at arm's length in under five seconds.
2. Never overclaim: snapshots, user reports, and official alerts are labeled for what they are.
3. Danger outranks reassurance — hazard and community warnings always sit above a clean registry result.
4. One flow serves shopper, pharmacist, and health worker; no modes, no training.
5. Every check ends with a next action: report, map, or official verifier.

## Accessibility & Inclusion

Plain simple English; big touch targets for one-handed use; visible focus and screen-reader-named verdicts; status never carried by color alone.
