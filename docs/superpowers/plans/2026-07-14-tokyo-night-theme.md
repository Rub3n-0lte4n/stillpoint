# Tokyo Night Theme + Themed Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the neon "Tokyo Night" patron theme and make the reading stage's gradients follow the active theme (midnight pixel-identical).

**Architecture:** Four `--stage-*` tokens defaulted in `:root` to the stage's current hardcoded values, consumed by `.stage`; each theme block (3 existing + new tokyo) overrides them. One THEMES entry in `patron.js` drives gating, picker, status-bar sync, and persistence. Spec: `docs/superpowers/specs/2026-07-14-tokyo-night-theme-design.md`.

**Tech Stack:** Vanilla CSS custom properties + ES modules; `node:test`; raw-CDP headless Chrome for E2E + screenshots.

## Global Constraints

- No Co-Authored-By trailers on commits; commit style `type(scope): lowercase description`; no em dashes or rule-of-three in user-facing copy (a four-item factual theme enumeration is allowed).
- Midnight's stage must not change: token defaults are copied verbatim from the current `.stage` rule.
- Focal amber / guides / halo untouched in every theme.
- `sw.js` CACHE_VERSION v45 → v46 exactly once, final task.

---

### Task 1: THEMES entry + patron tests (TDD)

**Files:**
- Modify: `test/patron.test.mjs:22,26`
- Modify: `js/patron.js:10-16`

**Interfaces:**
- Produces: `THEMES` includes `{ id:"tokyo", name:"Tokyo Night" }` (last). `isPatronTheme("tokyo") === true`. Task 2's CSS block and Task 3's E2E rely on the `tokyo` id.

- [x] **Step 1: Update the pinned assertions to expect 5 themes**

`test/patron.test.mjs` line 22 becomes:

```js
ok(THEMES.length === 5 && THEMES[0].id === "midnight", "5 themes, midnight first/default");
```

Line 26 becomes:

```js
ok(isPatronTheme("garden") === true && isPatronTheme("abyss") === true && isPatronTheme("ember") === true && isPatronTheme("tokyo") === true, "other themes are patron-only");
```

- [x] **Step 2: Run to verify failure**

Run: `node test/patron.test.mjs`
Expected: FAIL on "5 themes" (list still has 4).

- [x] **Step 3: Add the theme to `js/patron.js`**

The THEMES array becomes:

```js
export const THEMES = [
  { id:"midnight", name:"Midnight" },
  { id:"ember",    name:"Ember Atelier" },
  { id:"garden",   name:"Night Garden" },
  { id:"abyss",    name:"Abyss" },
  { id:"tokyo",    name:"Tokyo Night" },
];
```

- [x] **Step 4: Verify green**

Run: `node test/patron.test.mjs` → all pass. Then `npm test` → green.

- [x] **Step 5: Commit**

```bash
git add js/patron.js test/patron.test.mjs
git commit -m "feat(theme): tokyo night joins the patron shelf"
```

---

### Task 2: Stage tokens + theme blocks + copy

**Files:**
- Modify: `styles.css` — `:root` token area (~line 24, next to `--glow-a/b`), `.stage` rule (~399-412), the three `html[data-theme=…]` blocks (~985-1012), new tokyo block after abyss
- Modify: `index.html:586` (patron pitch enumeration)

**Interfaces:**
- Consumes: `tokyo` id from Task 1.
- Produces: `--stage-sheen/--stage-core/--stage-edge/--stage-vign` tokens; `html[data-theme="tokyo"]` block. Task 3 asserts computed styles per theme.

- [x] **Step 1: Default stage tokens in `:root`**

After the `--glow-b` line in `:root`, add (values copied verbatim from the current `.stage` rule):

```css
    /* the reading stage's ground — themable (defaults = midnight, pixel-identical) */
    --stage-sheen:rgba(197,163,255,0.07);
    --stage-core:rgba(36,23,54,0.78);
    --stage-edge:rgba(11,7,19,0.62);
    --stage-vign:rgba(7,4,14,0.55);
```

- [x] **Step 2: Consume them in `.stage`**

The `background:` and `box-shadow:` declarations of `.stage` become:

```css
    background:
      radial-gradient(120% 90% at 50% 0%, var(--stage-sheen), transparent 55%),
      radial-gradient(760px 320px at 50% 52%, var(--stage-core), var(--stage-edge));
    border:1px solid var(--hair);
    box-shadow:var(--e-3), inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 0 rgba(0,0,0,0.4), inset 0 0 90px var(--stage-vign);
```

- [x] **Step 3: Stage overrides in the three existing theme blocks**

Append inside `html[data-theme="ember"]{…}`:

```css
    --stage-sheen:rgba(255,184,148,0.06); --stage-core:rgba(54,28,16,0.78);
    --stage-edge:rgba(16,8,5,0.62); --stage-vign:rgba(12,6,3,0.55);
```

Inside `html[data-theme="garden"]{…}`:

```css
    --stage-sheen:rgba(159,232,192,0.06); --stage-core:rgba(16,44,30,0.78);
    --stage-edge:rgba(6,16,11,0.62); --stage-vign:rgba(4,12,8,0.55);
```

Inside `html[data-theme="abyss"]{…}`:

```css
    --stage-sheen:rgba(156,195,255,0.06); --stage-core:rgba(20,32,58,0.78);
    --stage-edge:rgba(6,10,19,0.62); --stage-vign:rgba(4,7,14,0.55);
```

Also update the patron-block comment ("the focal amber never changes" stays true; drop the stage-stays-midnight implication): the comment becomes

```css
  /* Patron themes — token overrides only (incl. the stage ground); the focal
     amber never changes. Dark hue-shifts by design: every rgba/contrast in the
     app assumes dark ground. */
```

- [x] **Step 4: Add the tokyo block after abyss (verbatim from the spec)**

```css
  html[data-theme="tokyo"]{
    --bg-deep:#07070d; --bg-0:#0a0a12; --bg-1:#10101c; --bg-2:#171728;
    --surface:rgba(32,26,48,0.55); --surface-2:rgba(46,34,66,0.45); --surface-inset:rgba(10,8,18,0.5);
    --hair:rgba(255,120,170,0.13); --hair-strong:rgba(255,120,170,0.24); --hair-soft:rgba(255,120,170,0.06);
    --ink-bright:#fff5fa; --ink:#f0e7f2; --ink-soft:#cdbcd4; --ink-mute:#a693b0;
    --amethyst:#ff6b9d; --amethyst-deep:#ff2d55; --rose:#5bc8ff; --focus-dim:#c4b3c8;
    --glow-a:rgba(255,45,120,0.14); --glow-b:rgba(60,180,255,0.10);
    --glow-amethyst:0 22px 60px -24px rgba(255,45,85,0.5);
    --stage-sheen:rgba(255,92,150,0.06); --stage-core:rgba(26,18,38,0.78);
    --stage-edge:rgba(8,7,15,0.62); --stage-vign:rgba(6,5,12,0.55);
  }
```

- [x] **Step 5: Copy sweep**

`index.html:586`: "…reading themes made only for patrons: Ember Atelier, Night Garden, Abyss." becomes "…reading themes made only for patrons: Ember Atelier, Night Garden, Abyss, Tokyo Night." (README does not enumerate themes; no other mentions.)

- [x] **Step 6: Contrast check (spec: --ink-mute ≥5:1 on --bg-0)**

Run this Node one-liner; expected ≥ 5.

```bash
node -e 'const L=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};const r=(L("#a693b0")+.05)/(L("#0a0a12")+.05);console.log(r.toFixed(2))'
```

If < 5, lighten `--ink-mute` (e.g. `#b09dbb`) and re-run until ≥ 5; record the final hex.

- [x] **Step 7: Commit**

```bash
git add styles.css index.html
git commit -m "feat(theme): neon tokyo night; the stage ground finally follows the theme"
```

---

### Task 3: E2E + screenshots + ship

**Files:**
- Modify: `sw.js:6` → `"stillpoint-v46"`
- Create (scratchpad): `cdp-themes.mjs`

**Interfaces:**
- Consumes: the built app; unlock code (enter via `Patron.unlock`-equivalent: set `fp_patron_v1` the way `js/patron.js` persists it — read the module to mirror the exact shape at write time).
- Produces: green E2E, five theme screenshots for the user, live deploy.

- [x] **Step 1: Bump `sw.js` to v46**

- [x] **Step 2: E2E script (scratchpad, raw CDP on :9224, server :8111)**

Checks: for each theme id (midnight, ember, garden, abyss, tokyo): grant patron state in localStorage first (mirror `js/patron.js`'s stored shape exactly), reload, `applyTheme` via the real Theme seg buttons in the settings panel, then assert (a) `document.documentElement.dataset.theme` correct (absent for midnight); (b) `getComputedStyle(document.querySelector(".stage")).background` differs between themes and, for midnight, equals the value captured on the PRE-change deployed site (fetch live stillpointreader.com stage computed value first, compare) — pixel-identity guarantee; (c) `meta[name=theme-color]` equals the theme's `--bg-0`; (d) with patron state cleared, clicking Tokyo Night opens the patron pitch and the theme does NOT apply; (e) at 1280×900 and 390×844, `#themeSeg`'s scrollWidth ≤ clientWidth of its container and the fifth button's right edge sits inside the settings panel (no clipping) — if it clips on desktop, add `#themeSeg{flex-wrap:wrap;border-radius:22px}` outside the mobile media query and re-check. Screenshot landing + reader per theme (`Page.captureScreenshot`) into the scratchpad.

- [x] **Step 3: Run it**

Expected: all checks green, 0 exceptions, 10 screenshots written.

- [x] **Step 4: Full suite, commit, deploy**

```bash
npm test   # green
git add sw.js
git commit -m "chore(sw): v46 lights the neon"
git push
```

Poll `https://stillpointreader.com/sw.js` for v46; confirm live `styles.css` contains `data-theme="tokyo"`. Show the user the screenshots for hex tuning.
