# Stillpoint — UI Elevation Design

*2026-06-26. Elevate the existing "Midnight Couture" identity a level — keep the soul, raise the craft. Restraint as the baseline; jewel-box richness only where attention is earned. Decluttering is welcome.*

## Decisions (locked with user)
- **Ambition:** Elevate, not redesign. Same identity, meaningfully higher craft.
- **Scope:** Full even sweep across all surfaces.
- **Open to change:** palette (enrich, same hues), typography (retune usage), layout/spacing, motion/depth — and removing clutter.
- **Character:** Restraint everywhere + a few jewel moments (reader stage, finish screen).
- **Dock:** Progressive disclosure — lead with Play + Speed + Mode; Chunk/Size/Aids/Navigate behind a calm "Reading settings" toggle. Everything stays reachable.

## Constraints (non-negotiable)
- Vanilla HTML/CSS/JS, no build step, single `styles.css`.
- Offline/PWA intact (bump `sw.js` CACHE_VERSION).
- Accessibility preserved or improved: contrast ≥ 4.5:1 for text, visible focus rings, `prefers-reduced-motion` respected, modal focus traps kept.
- No new external dependencies; CSP unchanged.

## 1. Foundations (do first — the "finished" lever)
- **Spacing tokens:** 8pt scale `--s-1..--s-8` = 4/8/12/16/24/32/48/64; 3 section-rhythm tiers. Replace ad-hoc margins.
- **Type scale:** modular scale as tokens; locked line-heights (display 1.05 / body 1.6 / UI 1.4); tuned Fraunces tracking + `font-optical-sizing:auto`; tabular figures for all numerics.
- **Elevation scale:** `--e-1` cards, `--e-2` floating dock, `--e-3` modals; one `--glow-focus` token. Retire one-off shadows.
- **Motion tokens:** `--t-fast 140ms / --t 220ms / --t-slow 360ms`; ease-out enter, ease-in exit. Apply consistently.
- **Palette:** same hues; add 1–2 tonal steps (deeper inset surface, brighter max-contrast ink, second hairline); lift borderline muted-text contrast.

## 2. Landing — declutter + rhythm
- Unify section spacing to the rhythm tiers.
- Subtract in the hero: fold the pace + repel lines into one quiet "fine print" line so the live demo is the clear centerpiece.
- Drop zone reads as the single primary; the backup/export block recedes (quieter, secondary) until relevant.
- Support tiers + recent-library items adopt the new elevation/radius/spacing.

## 3. Reader stage — jewel moment #1
- Refine the vignette into a focal "instrument": subtle top-light, faint floor-reflection under the focal word, more precise amber guide ticks, a more layered (less neon) focal glow, refined baseline + resting state.

## 4. Dock & controls — progressive disclosure
- Primary row always visible: Play/transport, Speed, Mode.
- Secondary controls (Chunk, Size, Reading aids, Navigate) collapse under a calm "Reading settings" toggle; state persisted in prefs.
- Unify segmented controls, slider thumb/track, transport buttons into one system (sizing, active state, elevation, focus).
- Touch targets ≥ 44px preserved.

## 5. Modals & moments — jewel moment #2
- Parsing / finish / how-it-works unified on the new elevation+radius+spacing.
- Finish screen becomes a real celebration: refined orb, elevated stat cards, gentle entrance.
- Toasts adopt the elevation system.

## Implementation staging (live review after each)
1. Foundations: token layer in `:root`, refactor existing rules to consume tokens (no visual regressions intended beyond intended polish).
2. Reader stage + dock (progressive disclosure) — needs small JS for the settings toggle + persistence.
3. Landing declutter + rhythm.
4. Modals/finish/toasts.

## Verification
- Review live at the local server after each stage; check 375px width + landscape.
- Verify reduced-motion (animations disabled) and keyboard focus rings on every control.
- Spot-check text contrast on the new tonal steps.
- `node --check` the JS; bump `sw.js` cache; confirm offline shell still lists all files.
