# DESIGN.md — Vouch "Indigo Stamp" world

Replacement visual world locked by the user (direction seed 4f4b5c7f). No green anywhere: green is reserved for the official NAFDAC identity and must never appear.

## Palette

- Paper ground `--paper #f6f1e7`, deep paper `--paper-deep #ece3cf`, card `--card #fffdf7`
- Stamp ink `--ink #35318f`, deep ink `--ink-deep #23215f` (header pad, primary actions)
- Ink text `--ink-text #26233c`, soft `--ink-soft #57536f`, muted `--muted #655f52`
- Lines `--line #d9cfb6`, strong `--line-strong #b3a67f`
- Danger `--danger #b3261e` / deep `#7a1a14`; amber ink `#7c4d00` on `--amber-bg #fff1cf` with `--amber-line #d9a92f`; info blue `#1d4fa1` (Kenya markers)
- Hazard overprint: near-black `#2b0a08` with signal border `#ffb020`

## Type

Display: condensed grotesk stack (`Arial Narrow`, Liberation Sans Narrow, system fallback), uppercase, weight 800, tight tracking — the stamp voice. Body: system sans. Never a decorative serif; never green.

## Signature devices

- Verdict seal: 76px rotated (−7°) double-ring circular badge; ink color carries the verdict (indigo verified, amber inactive, red mismatch/not-found).
- Perforation divider: dotted row separating scan card from install/offline block.
- Step numbers: small rotated outline seals, not pills.
- Warnings layer physically: hazard overprint, then community flag, then verdict — dark blocks that interrupt the paper.

## Motion

One authored moment: the photo scan line. Everything else is instant state change. Reduced-motion respected.

## PWA

`manifest.webmanifest` (indigo theme, paper background, 192 + 512 maskable seal icons), `sw.js` app-shell cache (`vouch-shell-v2`, API never cached), `beforeinstallprompt` install CTA, offline note. Icons rasterized from `icons/seal.svg`. The report map was removed; no third-party tile, font, or script dependencies remain — CSP is self-only.
