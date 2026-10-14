# W7n: the owner's gold M becomes the logo and the favicon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner (2026-10-14, roadmap row O-30): "i want this to be the default logo, just the M in gold, same with the favicon". The app shows his mark (gold square, cream serif M, black wedge; never the white wordmark) in the top bar, in the first-load shell, on the sign-in page and in the browser tab, drawn from one source constant so a later Branding setting swaps one value.

**Architecture:** Front end plus static files only. Nothing under `backend/` changes, no migration, no API change, no Caddy change (decision N5). Static assets in `frontend/public/` (`logo-mark.svg`, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`) made by one committed script `frontend/scripts/make-brand-assets.mjs` from the owner's file `docs/brand/logo-original.svg`. One `BrandMark` component (an `<img>` of `BRAND_MARK_SRC`) replaces the drawn bolt tile in `Layout`, `AppShellSkeleton`, the static copy in `index.html` and `AuthBrand`. `index.html` gets the icon links.

**Tech Stack:** React 19, Vitest + Testing Library, plain CSS (`@layer w6` plus `themes.css`), `playwright-core` (already in `frontend/node_modules`; add NO dependency) for the generator and the e2e.

**Brief:** `.superpowers/sdd/overnight-w7/W7n-brand-mark.md` (rulings B1 to B6). **Resume (any fresh session):** continue executing this plan; read `git log --oneline` on `w7n-brand-mark` and the checkboxes below; ledger `.superpowers/sdd/2026-10-14-w7n-brand-mark/progress.md`. The W7h plan (`2026-10-12-w7h-first-load.md`) is the model for the first-load shell rules.

## Decisions taken here (the owner may overrule; none blocks the build)

N1. **The SVGs are derived, not typed.** `make-brand-assets.mjs` reads `docs/brand/logo-original.svg`, takes the whole `<path .../>` lines whose fill is `#D29E12` with `translate(33,32)` (the square), `#FCFBF7` (the M) and `#161616` (the wedge), in document order, and writes `logo-mark.svg` (`viewBox="33 32 155 150"`) and `favicon.svg` (`viewBox="33 29.5 155 155"`) around them, with no comment, no `width`/`height`, no metadata. So "the owner's paths byte for byte" holds by construction; a test pins it (the three `d` strings, fills and transforms equal the original's; no `#FFFFFF`; exactly three `<path`). The original is copied to `docs/brand/logo-original.svg` unchanged (10 KB).
N2. **Gold stays gold, and the one preset whose bar is gold gets a keyline.** The mark is an `<img>`, so nothing in a theme can tint it. The old tile (background, border, radius, the inner bolt SVG, `.auth-mark`'s navy tile) is removed. Measured: `#D29E12` against the four bars is about 5.2:1 (navy `#283354`), 4.7 (maroon `#7d0849`), 5.3 (graphite `#2b2f36`) and only **1.23:1 on desert-gold's `#deb406`**, where the square's edge would vanish. A new token `--brand-edge` (app.css `:root`: `transparent`; `themes.css` desert-gold: `#7a6100`, the dark gold the preset already uses for `--top-find-border`, about 3.1:1 on that bar) feeds `.brand .brand-mark { outline: 1px solid var(--brand-edge) }` on the bar only (not the sign-in page, where gold on the page reads). A test computes, for each of the four bars, `contrast(gold, --top-bg)` and requires at least 3:1 OR a `--brand-edge` that is at least 3:1 on that bar. Cost if wrong: one token and one rule; the mark file is untouched.
N3. **`BrandMark({ size, className = "brand-mark", label })`** renders `<img class src="/logo-mark.svg" width={Math.round(size * 155 / 150)} height={size} alt={label ?? ""} aria-hidden={label ? undefined : true}>`; `size` is the height (the owner's square is 155 by 150 units, so 28 gives 29 by 28 and 56 gives 58 by 56). `BRAND_MARK_SRC = "/logo-mark.svg"` is exported and is the only place the URL appears in `src/`. Every use today sits next to the visible name text (and in the minimized rail the `.lbl` stays in the DOM, visually clipped, so the name is still announced): the mark is decorative there, so no second "DC Dashboard" is read. `label` is for a mark standing alone (a future use; one unit test). Cost if wrong: one prop.
N4. **The favicon set.** `favicon.ico` holds 16, 32 and 48 px PNG frames (container written by hand, transparent); `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png` are drawn on an opaque `#D29E12` ground because iOS paints transparency black (the 2.5-unit bands above and below the square in `favicon.svg` become gold, 1.6 percent of the height; the M and the wedge are not scaled or moved). The generator renders `favicon.svg` with Chromium through `playwright-core` (`CHROMIUM_PATH` overrides the executable). The 16 px frame is looked at enlarged and judged in a Ruling; the owner's mark is kept faithful whatever it looks like.
N5. **Caddy is NOT changed.** Files in `/srv` that exist are served by the final `handle` (the `try_files {path} /index.html` only falls back for paths with no file), with `Cache-Control: no-cache` (revalidated with an ETag, a 304 per file) and the content type from the extension (an `.ico` is sniffed to `image/x-icon`). The brief asked for `max-age=86400`; that needs a third static handle, which `backend/tests/test_caddy_headers.py` pins (a 2-handle shape in both Caddyfiles), so it would change a backend test and both Caddyfiles for a saving of one conditional request per file, and a swapped logo (the parked Branding setting) would stay stale for a day. Task 4's e2e proves the real responses (200, image type, not HTML, no `immutable`). Cost if wrong: add one `@brand` matcher handle and update that test.
N6. **The static copy holds the same `<img>`** (`<img class="brand-mark" src="/logo-mark.svg" width="29" height="28" alt="" aria-hidden="true">`) and `AppShellSkeleton.test.tsx`'s parity test keeps the two equal. `index.html`'s `<head>` also gets `<link rel="preload" as="image" type="image/svg+xml" href="/logo-mark.svg">` so the mark is requested with the stylesheet, not after it (the explicit width and height already prevent any shift; the preload removes the pop-in). Cost if wrong: delete one line.
N7. **Head links:** `<link rel="icon" href="/favicon.ico" sizes="48x48">` first, then `<link rel="icon" type="image/svg+xml" href="/favicon.svg" sizes="any">` (the order and `sizes="any"` are what make Chromium prefer the SVG over the ICO), then `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`. No web manifest and no `theme-color` (not asked).
N8. **Sign-in, setup and "cannot reach the server" all use `AuthBrand`**, so one change covers three pages. The mark is 56 px high (58 wide, inside the brief's 48 to 64) beside the name, which keeps its text and the `p`. If the mark file fails to load, the 58 by 56 box stays empty and the name still shows (no shift); a test aborts the request.
N9. **Parked, not built:** the Branding setting (an administrator uploads a logo and a product name; this mark is the default). Goes to the backlog (next free section) with that description, and the roadmap row says so.
N10. **`ICONS.brand` (the bolt path in `Icon.tsx`) is deleted** once nothing uses it.
N11. **Process.** The lighter process of W7f to W7m: ONE Opus plan review, Sonnet implementers (one fresh per task), targeted tests per task, no per-task Opus review (no data, billing, migration, auth), then the controller's gates, the isolated Playwright run (project `w7n`, scratch ports 18207 and 18561), ONE whole-wave Opus review in a real browser, ONE fix wave, one scoped re-review. No backend suite (`git diff main --stat -- backend` stays empty; `uv run pytest tests/test_preferences_parity.py` runs once after Task 3 because it reads `index.html`).

## Global Constraints

- Hard bans (any one is a failure): no cream or off-white page background; no italic accent words; no numbered "01/02/03" labels; no monospace labels; no pill shapes (radius 4 to 8 px, 50% only for circles). The mark itself is the owner's artwork (its cream M is his) and is not restyled.
- Raw colours only in `src/themes.css` and `app.css`'s `:root` block; every other rule uses `var(--...)`. New rules go inside `@layer w6` of `app.css` (auth rules in `src/styles/pages-auth.css`). The frozen widget/editor block at the end of `app.css` is not edited. Do not touch the widgets.
- `theme-init.js` is not edited. The CSP stays as is (`img-src 'self' data: blob:` allows the files).
- Playwright matches names by case-insensitive SUBSTRING: Task 4 audits every `getByRole(`/`getByLabel(`/`getByText(`/`getByAltText(` value in `frontend/e2e/*.ts` against any new `alt`, `aria-label` or heading ("DC Dashboard" is already the name text).
- jsdom has no layout: unit tests check markup, attributes and stylesheet text; geometry is checked in a real browser.
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build`, the e2e type-check `npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"` (must print nothing), `node scripts/make-brand-assets.mjs` (Task 1), `cd backend && uv run pytest tests/test_preferences_parity.py` (Task 3), git, grep, `bash -n`, and `node` scripts with `playwright-core` against a Vite dev server THEY start (`npx vite --port 5207 --strictPort`, kill it when done; with no API behind it `/login` shows the "cannot reach the server" screen, which carries the same `AuthBrand`) for a LOOK. Never `docker`, `scripts/*`, `npx playwright test`; never edit `backend/`, `deploy/`, `.env`, `backups/`, `~/.claude`.
- One commit per task, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not push; `git add` named files only. Match the surrounding code (short comments only where the reason is not obvious). Branch `w7n-brand-mark`. A test this wave breaks on purpose is updated minimally and keeps its intent.

## Review Focus (inputs the happy path does not exercise)

1. The mark is exactly the owner's: render the cropped SVG and the same region of the original at 4x (canvas `getImageData` diff in one page) and compare; no white-wordmark pixel anywhere in `logo-mark.svg`, `favicon.svg` or the PNGs' ground.
2. Gold is `#D29E12` in every one of the eight looks and both modes; no double box; the square's edge reads on all four bars, **desert-gold included**, and on the dark sign-in card.
3. The favicon really appears: the links, the files, the content types; `/favicon.ico` no longer answers with the app's HTML; the 16 px frame is judged honestly.
4. No layout shift on first load; the static shell's mark equals the React one in size and place (compare boxes before and after React takes over); with the mark file blocked the bar keeps its geometry and the name.
5. The accessible name: one "DC Dashboard" for a screen reader (the text), the image decorative; the minimized rail still announces the name.
6. Nothing else about the bar, the rail or the sign-in card moved (heights, widths, content origin), and no `.brand-mark svg` or `.auth-mark` rule is left to rot.

## File map

- Create `docs/brand/logo-original.svg`, `frontend/scripts/make-brand-assets.mjs`, `frontend/public/{logo-mark.svg,favicon.svg,favicon.ico,apple-touch-icon.png,icon-192.png,icon-512.png}`, `frontend/src/brandAssets.test.ts`, `frontend/src/components/BrandMark.tsx` (+ `BrandMark.test.tsx`), `frontend/e2e/w7n.spec.ts`.
- Modify `frontend/src/components/Layout.tsx`, `AppShellSkeleton.tsx` (+ their tests), `Icon.tsx`, `frontend/src/pages/LoginPage.tsx`, `frontend/src/app.css` (+ `app.css.test.ts`), `frontend/src/themes.css` (+ `themes.css.test.ts`), `frontend/src/styles/pages-auth.css`, `frontend/index.html`, `frontend/e2e/playwright.config.ts`, README (short note), and at close-out the roadmap row O-30, backlog section AK, this plan's execution log.

### Task 1: Brand assets, generator and their tests

**Files:** create `docs/brand/logo-original.svg` (`cp` of `.superpowers/sdd/overnight-w7/assets/logo-original.svg`), `frontend/scripts/make-brand-assets.mjs`, the six `frontend/public/` files, `frontend/src/brandAssets.test.ts`.
**Produces:** the files above, committed; `node scripts/make-brand-assets.mjs` (run from `frontend/`) rewrites all six deterministically for the SVGs and re-renders the binaries.

- [ ] **Step 1: Write the failing test** `src/brandAssets.test.ts` (vitest runs from `frontend/`, as `theme-init.test.ts` does: `readFileSync("public/...")`, `readFileSync("../docs/brand/logo-original.svg")`). Cases: (a) `logo-mark.svg` has exactly three `<path`, no `#FFFFFF`/`#ffffff`, no `<!--`, no `width=`/`height=`, `viewBox="33 32 155 150"`, fills exactly `#D29E12`, `#FCFBF7`, `#161616` in that order; each of its `<path .../>` lines occurs verbatim in the original (`d`, fill and transform byte for byte); (b) `favicon.svg` has the same three path lines verbatim and `viewBox="33 29.5 155 155"`; (c) `favicon.ico`: bytes 0..5 are `00 00 01 00 03 00`, the directory has frames 16, 32, 48 (width byte = height byte), each entry's `offset + size` is inside the file, each frame starts with the PNG signature `89 50 4E 47 0D 0A 1A 0A` and its IHDR width and height equal the entry's; (d) `apple-touch-icon.png` is 180 by 180, `icon-192.png` 192, `icon-512.png` 512 (read IHDR: bytes 16..23 big-endian), each under 60 KB and with colour type 6 or 2; (e) `docs/brand/logo-original.svg` has 13 `<path` elements and contains the three mark path lines.
- [ ] **Step 2:** run it, see it fail (files missing).
- [ ] **Step 3: Write the generator.** Plain ESM, no dependency beyond `playwright-core` and `node:` modules; run from `frontend/` (resolve paths from `import.meta.url`). Sketch (write it fully, comments only where the reason is not obvious):

```js
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const GOLD = "#D29E12";
const original = readFileSync(new URL("../../docs/brand/logo-original.svg", import.meta.url), "utf8");
const pathLines = original.split("\n").filter((line) => line.startsWith("<path "));
const pick = (fill, transform) => {
  const hits = pathLines.filter((l) => l.includes(`fill="${fill}"`) && (!transform || l.includes(`transform="${transform}"`)));
  if (hits.length !== 1) throw new Error(`expected one path for ${fill}, found ${hits.length}`);
  return hits[0];
};
const mark = [pick(GOLD, "translate(33,32)"), pick("#FCFBF7"), pick("#161616")]; // square, M, wedge: document order
const svg = (viewBox) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n${mark.join("\n")}\n</svg>\n`;
// writeFileSync public/logo-mark.svg  <- svg("33 32 155 150");  public/favicon.svg <- svg("33 29.5 155 155")

function buildIco(frames /* [{ size, png: Buffer }] */) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size, at); dir.writeUInt8(size, at + 1); // 0 would mean 256; every frame here is smaller
    dir.writeUInt16LE(1, at + 4); dir.writeUInt16LE(32, at + 6); // planes, bits per pixel
    dir.writeUInt32LE(png.length, at + 8); dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...frames.map((f) => f.png)]);
}
// render(size, opaque): chromium page with viewport size x size, setContent(<style>html,body{margin:0;background:...}svg{display:block;width:Npx;height:Npx}</style> + favicon.svg text),
// screenshot({ omitBackground: !opaque, clip }) ; opaque = ground GOLD. ICO frames 16/32/48 transparent; 180, 192, 512 opaque.
// launch: chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
```

- [ ] **Step 4:** run `node scripts/make-brand-assets.mjs` and the test; all green. Run the generator a second time and confirm `git diff --stat` shows the two SVGs unchanged.
- [ ] **Step 5: LOOK.** With a `playwright-core` script, screenshot the 16, 32 and 48 px ICO frames (extract them from the ICO, or render the favicon at those sizes) enlarged 16x and look; write a Ruling line in your report about whether the M and the wedge are recognisable at 16 px (keep the mark faithful either way). Also render `logo-mark.svg` and the same region of the original at 4x in one page and diff them with canvas `getImageData` (report the number of differing pixels; zero or near zero expected).
- [ ] **Step 6: Commit** `feat(w7n): the owner's gold mark as static assets and a generator` (add the files by name; the binaries are a few KB each).

### Task 2: `BrandMark`, the top bar, the skeleton and the static shell

**Files:** create `src/components/BrandMark.tsx` (+ test); modify `Layout.tsx` (+ `Layout.test.tsx`), `AppShellSkeleton.tsx` (+ test), `Icon.tsx`, `index.html` (the static copy only), `app.css` (+ `app.css.test.ts`), `themes.css` (+ `themes.css.test.ts`).
**Consumes:** `/logo-mark.svg` from Task 1. **Produces:** `export const BRAND_MARK_SRC`, `export function BrandMark({ size, className, label }: { size: number; className?: string; label?: string })` as in N3.

- [ ] **Step 1: Tests first.** `BrandMark.test.tsx`: size 28 gives `width="29" height="28"`, size 56 gives `58`/`56`; `src` equals `BRAND_MARK_SRC` and `public/logo-mark.svg` exists; with no label: `alt=""`, `aria-hidden="true"`, class `brand-mark`; with `label="DC Dashboard"`: `alt="DC Dashboard"`, no `aria-hidden`; `className` is applied. `Layout.test.tsx`: the bar's `.brand` holds `img.brand-mark` (aria-hidden, src the constant) and the text "DC Dashboard" once; the existing minimized-label test stays. `AppShellSkeleton.test.tsx`: replace the `.brand-mark svg` expectation with the `img`; the parity test with `index.html` must pass after the paste. `app.css.test.ts`: no rule `.brand-mark` (or `.brand .brand-mark`) sets `background`, `border`, `border-radius`, `filter`, `mix-blend-mode` or `opacity`; no `.brand-mark svg` rule remains; `.brand .brand-mark` carries `outline: 1px solid var(--brand-edge)`. `themes.css.test.ts`: the N2 contrast rule over the four presets' `--top-bg` (reuse the file's `contrast`, `presetRule`, `customProperties` helpers), plus desert-gold's `--brand-edge` is not `transparent`.
- [ ] **Step 2:** implement `BrandMark`; in `Layout.tsx` and `AppShellSkeleton.tsx` replace `<span className="brand-mark" aria-hidden="true"><svg ...>{ICONS.brand}</svg></span>` with `<BrandMark size={28} />`; delete `brand` from `Icon.tsx` if nothing else uses it (grep).
- [ ] **Step 3: CSS.** In `app.css` replace the `.brand-mark` and `.brand-mark svg` rules (about lines 94 and 95) with `.brand-mark { flex: none; display: block; }` and `.brand .brand-mark { outline: 1px solid var(--brand-edge); }`; add `--brand-edge: transparent` to the `:root` block and `--brand-edge: #7a6100` to desert-gold's preset in `themes.css` (beside its `--top-find-border`). Check `.sk-shell`, the minimized rules and the `:root[data-shell="minimized"] .sk-shell[hidden]` twins still match (the twin test in `app.css.test.ts` must stay green; no rule there mentions the mark). Keep the old rule's neighbours (`.brand .lbl`) untouched.
- [ ] **Step 4:** paste the markup into `index.html`'s static copy: the `<span class="brand-mark" ...><svg>...</svg></span>` becomes `<img class="brand-mark" src="/logo-mark.svg" width="29" height="28" alt="" aria-hidden="true">` (the parity test prints the generated markup on a mismatch; paste that). Do NOT touch the `<head>` here (Task 3).
- [ ] **Step 5:** run the targeted tests (`BrandMark`, `Layout`, `AppShellSkeleton`, `app.css`, `themes.css`, `theme-init`), `npm run typecheck`, `npm run build`. LOOK (optional here; the controller looks at the signed-in bar in the scratch stack).
- [ ] **Step 6: Commit** `feat(w7n): BrandMark in the top bar, the skeleton and the first-load shell`.

### Task 3: Sign-in page, head links, serving check

**Files:** modify `src/pages/LoginPage.tsx` (+ its test and `ServerUnreachable.test.tsx` if they pin the old tile), `src/styles/pages-auth.css`, `frontend/index.html` (`<head>`), `src/brandAssets.test.ts` (a head describe).

- [ ] **Step 1: Tests first.** (a) `index.html`'s `<head>` has the three icon links of N7 with those `href`s and the preload of N6, and nothing else new; (b) `AuthBrand` renders `p.auth-brand` > `img.auth-mark` (58 by 56, `alt=""`, `aria-hidden`) + the text "DC Dashboard" once; Login, Setup and ServerUnreachable pages each still have exactly one `.auth-brand` and the page's single `h1`; (c) `pages-auth.css` has no `.auth-mark svg` rule and `.auth-mark` sets no `background`, `border`, `border-radius`, `filter`.
- [ ] **Step 2:** `AuthBrand` becomes `<p className="auth-brand"><BrandMark size={56} className="auth-mark" />DC Dashboard</p>` (import from `../components/BrandMark`); in `pages-auth.css` replace `.auth-mark`/`.auth-mark svg` with `.auth-mark { flex: none; display: block; }` and tune `.auth-brand` (gap 14 to 16 px, margin-bottom 22 to 24 px, the name one type step up if it looks right: `var(--fs-title)` is the token to try) so the sign-in card looks deliberate at 1440 and 1024, light and dark. The card width, its other rows and the page's centring do not change.
- [ ] **Step 3:** add the head links to `index.html` exactly as N6 and N7 say (no other head change).
- [ ] **Step 4:** run the targeted tests, `uv run pytest tests/test_preferences_parity.py` (from `backend/`), `npm run typecheck`, `npm run build`, then `grep -c 'rel="icon"' dist/index.html` (2), `ls dist` shows the six public files. LOOK at `/login` with the Vite dev server (the unreachable screen): the mark, the name, light and dark (`localStorage` `dcdash.appearance`), and `http://localhost:5207/favicon.ico` answers an image, not HTML.
- [ ] **Step 5: Commit** `feat(w7n): the mark on the sign-in page and the icon links in the head`.

### Task 4: The e2e project, the README note

**Files:** create `frontend/e2e/w7n.spec.ts`; modify `frontend/e2e/playwright.config.ts` (project `w7n`, `dependencies: ["w7m"]` or whatever the last project is, same `use` as its neighbours), README (a short "Brand assets" paragraph: where the files are, `cd frontend && node scripts/make-brand-assets.mjs`, that Chromium is needed, the owner's original in `docs/brand/`).
**Do not run Playwright** (the controller does). Type-check the spec with the e2e command above.

- [ ] **Step 1: The spec** (read the newest specs, `w7m.spec.ts` and `w7h.spec.ts`, for the login and helper style; seeded login `admin` / `correct-horse`; one signed-in `page` for the bar tests). Tests: (1) the served `/` HTML links the three icons; each linked URL and `/logo-mark.svg` answers 200 with a content type starting `image/` (never `text/html`), a non-empty body, no `immutable` in `Cache-Control`; the ICO body starts `00 00 01 00`; `logo-mark.svg` text has no `#FFFFFF`. (2) Signed in at 1600 wide: `.brand img.brand-mark` is visible, `naturalWidth > 0`, its box is 29 by 28, and the pixel the browser actually draws is the owner's gold: draw the `<img>` onto a canvas in the page and read a pixel inside the square away from the M (e.g. (3, 3) of 29 by 28 scaled up by drawing at 4x) equal to rgb(210,158,18); repeat for modes light and dark and two presets (set `data-mode`/`data-theme` on `<html>` in the page; the mark must not change). (3) Minimized sidebar (use the shell helper that the other specs use): the mark is still visible at 29 by 28 and `getByText("DC Dashboard")` still exists in the DOM. (4) Signed out in a fresh context: `/login` shows `.auth-brand img` visible at 58 by 56 with `naturalWidth > 0`. (5) The static shell: abort every request whose path starts `/assets/` (React never starts; `theme-init.js` still runs), open `/` and read the box of `.sk-shell .brand img` (29 by 28, visible, `naturalWidth > 0`); then open `/` unblocked and compare the signed-in bar's mark box (same x, y, width, height). (6) First load with a listener on `console` (type `error` or `warning`) and on responses: no status 400 or above and no console error or warning across `/login`, signing in and the home page. (7) With `**/logo-mark.svg` aborted, the bar's `.brand` box keeps its width and height and the text "DC Dashboard" shows.
- [ ] **Step 2:** audit `getByRole(`/`getByLabel(`/`getByText(`/`getByAltText(` values in `frontend/e2e/*.ts` for collisions with the new `img` (alt is empty, so there should be none; say so in the report).
- [ ] **Step 3:** project in `playwright.config.ts`, the e2e type-check prints nothing, README paragraph.
- [ ] **Step 4: Commit** `test(w7n): e2e for the brand mark and the icons; README note`.

## Execution log

(The controller adds one line per task and gate here and ticks the boxes; the ledger has the detail.)
