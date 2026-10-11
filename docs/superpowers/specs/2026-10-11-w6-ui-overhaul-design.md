# W6 UI overhaul: design spec

Date: 2026-10-11. Status: look approved by the owner ("Yes, build it", 2026-10-11) with the four decisions below; the Opus plan review is next. Branch `w6-ui-overhaul` (from main b821ba7).
Reference mockup: `.superpowers/sdd/2026-10-11-w6-ui-overhaul/mockups/option-a2.html` (open it in a browser; it is the visual source of truth, this document is the build contract).

## 1. Goal, scope, bans, decisions

**Goal.** One clean, quiet, functional look across the app: "still simple for the user to use and understand, all while looking clean and slick and functional" (owner). A Sunbird-like shell: a grouped left sidebar, white content, a page header per page, tinted status chips, tables with a second muted line.

**In scope.** The shell (`Layout.tsx`), `app.css`, the shared pieces (`Modal`, `ConfirmDeleteDialog`, forms, `AssetTree`, `AuditFilterBar`, `AuditPager`, notices, tiles) and every page: Assets, Asset, Dashboards list, Billing, Sources, Source points, Scans, Discovery (its chrome, not the graph nodes' logic), Users, Settings, Tariffs, Storage, Audit, Audit entry, Password, Login, Setup, Not found.

**Out of scope (keeps its current look).** The dashboard widgets (everything inside `.widget-frame`) and the dashboard editor's grid (`.dash-grid*`, `.react-grid-*`, `.widget-actions`, `.widget-preview`, `.editor-cols`, `.picker-*`, `.issues`). Section 5 lists the frozen rules. No behaviour, route, API or wording change anywhere, except the few markup changes this spec names. Headings, button names, link names and labels stay word for word (tests find them by name).

**Hard bans** (any one is a failure): a cream or off-white page background; italic accent words in headings; numbered "01/02/03" labels; monospace labels; pill buttons (radius is 4 to 8 px, never 999px). Also none of: gradient blobs, glassmorphism, emoji icons, a drop shadow on every card. Icons are inline SVG, 24-unit viewBox, 1.7 stroke, `aria-hidden="true"`.

**Owner decisions (2026-10-11).** (1) Option A is the base: dark sidebar, white content, blue accent #1d5bd8, comfortable density. (2) The sidebar colour is quantum navy rgb(40, 51, 84) = `#283354`. (3) The nav sidebar is expandable and minimizable by hand (option B's idea). (4) The Assets screen uses option B's layout: the tree as its own full-height column beside the detail, B's status shape icons, B's per-node "+" button and B's legend. (5) The tree column is on the Assets LIST page only for now; the owner wants it on each asset's page (/assets/:id) too "e2e eventually": recorded as follow-up F-1 in the backlog, not built here. (6) The dashboard editor's dialogs (widget editor, new dashboard, unsaved changes) take the new buttons and fields; only the widgets and the editor grid stay as they are. (7) The signed-in user reads as the name with the role written out below it (Administrator / Operator / Viewer), not `name (role)`.

## 2. Tokens

All tokens live in one `:root` block at the top of `app.css`. **Rule: no raw colour in a component rule, only `var(--…)`.** The only exceptions are the frozen widget/editor rules (section 5), which keep their literals so they cannot drift, and the few literals `app.css.test.ts` reads (see section 5, test changes).

```css
:root {
  /* content */
  --accent: #1d5bd8; --accent-hover: #174bb5; --accent-tint: #e8effc; --accent-ink: #163f94;
  --bg: #ffffff; --surface: #f6f8fb; --row-hover: #fafbfd; --border: #e1e5ec; --border-strong: #cdd3dd;
  --text: #172033; --text-2: #596579; --text-disabled: #6b7484; --ring: #1d5bd8;
  /* sidebar, all derived from quantum navy */
  --side-bg: #283354; --side-bg-hover: #313d63; --side-bg-active: #3a4772;
  --side-text: #b8c2dc; --side-text-strong: #ffffff; --side-muted: #9aa6c4; --side-rule: #3a4569;
  --side-accent: #8fb2ff; --side-avatar-bg: #3a4772; --side-avatar-text: #dce4f7;
  --tooltip-bg: #172033; --tooltip-text: #ffffff;
  /* status: text / fill / border */
  --ok: #136c37;   --ok-tint: #e3f3e9;
  --warn: #8a4b00; --warn-tint: #fcefd6; --warn-line: #f1d29e; --warn-ink: #6b3a00; --warn-bg: #fdf3e1; --warn-icon: #a85d00;
  --crit: #b0202a; --crit-tint: #fce8e8;
  --info: #1d4fb8; --info-tint: #e7eefc; --info-line: #c5d6f6; --info-ink: #173f8f;
  --stale: #545d6b; --stale-tint: #eceef2;
  --danger: #c0262d; --danger-hover: #a51f25;
  --backdrop: rgba(10, 16, 28, 0.55);
  /* type: 12 / 13 / 14 / 16 / 18 / 22 / 28 */
  --font: "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif;
  --fs-xs: 12px; --fs-sm: 13px; --fs-base: 14px; --fs-md: 16px; --fs-lg: 18px; --fs-title: 22px; --fs-figure: 28px;
  /* spacing, radius, elevation, motion, sizes */
  --row-y: 11px; --row-x: 14px; --gutter: 28px;          /* 22px below 1180px */
  --radius: 6px; --radius-sm: 4px; --radius-lg: 8px;
  --shadow-dialog: 0 18px 50px rgba(10, 16, 28, 0.28); --shadow-tip: 0 4px 14px rgba(10, 16, 28, 0.25);
  --motion: 150ms ease;
  --side-w-open: 236px; --side-w-closed: 64px; --tree-w: 280px; --tree-w-closed: 44px; /* tree 248px below 1180px */
}
```

Measured contrast (WCAG 2.x). Content: white on accent 5.93; accent on white 5.93; text 16.27; text-2 5.90; disabled 4.71; chip ok 5.66, warning 5.98, critical 5.78, info 6.30, stale 5.73; white on danger 5.90; banner ink on warn-bg 8.56. Sidebar on #283354: white 12.41; `--side-text` 6.97 (5.96 on the hover fill, but hover text turns white, 10.62); `--side-muted` 5.10 **on plain navy only** (4.36 on the hover fill, so never put muted text on hover/active fills); white on the active fill 9.04; `--side-accent` 5.90 (4.29 on the active fill, non-text, needs 3:1); navy on the accent brand mark 5.90; avatar 7.09; tooltip 16.27. **`--accent` #1d5bd8 is 2.09:1 on the navy and must never appear on the sidebar** (text, icon, indicator or focus ring); `--side-accent` is the sidebar's accent.

Focus: `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }`; inside `.side` the outline colour is `--side-accent`; form controls use offset 0 and also colour their border. `prefers-reduced-motion: reduce` turns every transition off.

## 3. The shell

`Layout.tsx` renders, in this order:

```
<a class="skip-link" href="#main">Skip to content</a>        (unchanged behaviour: focuses #main, no hash)
<div class="shell" data-sidebar="expanded|minimized">
  <aside class="side" id="sidebar">
    <nav aria-label="Main">                                  (the ONLY navigation landmark on any page)
      <div class="brand">mark + <span class="lbl">DC Dashboard</span></div>
      <div class="nav-groups">
        <div class="nav-group" role="group" aria-labelledby="nav-monitor"><span class="nav-heading" id="nav-monitor">Monitor</span> Assets, Dashboards, Billing</div>
        <div ... "Operate">     Sources, Scans, Discovery            (only if hasRole("operator"))
        <div ... "Administer">  Users, Settings, Tariffs, Storage, Audit (only if hasRole("admin"))
      </div>
      <div class="side-foot">
        <div class="who"><span class="avatar" aria-hidden>U</span><span class="lbl"><span class="who-name">{username}</span><span class="who-role">{ROLE_LABEL[role]}</span></span></div>
        <NavLink class="side-row" to="/password">Password</NavLink>
        <button class="side-row">Sign out</button>
        <button class="side-row side-toggle" aria-controls="sidebar" aria-expanded>…Minimize sidebar | Expand sidebar</button>
      </div>
    </nav>
  </aside>
  <main id="main" tabIndex={-1} className={wide ? "wide" : undefined}>
    <div class="shell-notices"><RoleChangedNotice/>{admin && <CertificateNotice/>}</div>
    <Outlet/>
  </main>
</div>
```

- Each link is `<NavLink className="side-row">` with `<svg class="i">` + `<span class="lbl">Name</span>`. NavLink already sets `aria-current="page"`; the active style keys on that attribute. Groups are `div`s with `role="group"`, **never `<ul>`** (journey.spec queries the only list on the Assets page), and the group heading is a `span`, not an `h2` (the page's `h1` stays the first heading).
- The role gating is today's, link for link. A group whose links are all gated away is not rendered.
- **The user block (owner decision 7):** the name on one line and the role written out below it, `ROLE_LABEL = { admin: "Administrator", operator: "Operator", viewer: "Viewer" }` defined in `Layout.tsx`. The old single text run `{username} ({role})` is gone, so the tests that look for it change in B2 (section 5). The avatar letter is `username[0].toUpperCase()`. Minimized, the block shows only the avatar; name and role stay in the DOM (visually hidden) and appear in the tooltip.
- **Labels are hidden with CSS only, never removed from the DOM.** Minimized, `.lbl` and `.nav-heading` get the visually-hidden style; screen readers and `getByRole("link", { name })` still see them. A minimized row shows its `.lbl` as a tooltip on `:hover` and `:focus-visible` (positioned right of the rail, `--tooltip-*` colours); `.nav-groups` switches to `overflow: visible` while minimized so the tooltip is not clipped. Group headings collapse to a 1px `--side-rule` divider.
- **Toggle.** One `<button>` in the foot; its visible (or, minimized, visually hidden) label is its accessible name: "Minimize sidebar" / "Expand sidebar", plus `aria-expanded`. Focus stays on it after a click. Width transition 150 ms on `.side`, none under reduced motion, and none on first paint (add the transition class one frame after mount).
- **State and persistence** in `frontend/src/lib/sidebarState.ts` (not `lib/layout.ts`, that name is taken): `initialSidebar(): "expanded" | "minimized"` returns `"minimized"` when `typeof window.matchMedia === "function" && matchMedia("(max-width: 1179.98px)").matches`, otherwise the stored value, otherwise `"expanded"`. `saveSidebar(state)` writes `localStorage["dcdash.sidebar"]`. Every storage read and write is wrapped in try/catch (private windows, blocked storage); a failure means "not remembered", never an error. jsdom has no `matchMedia`, so tests start expanded. No resize listener: the width rule decides the start state only, and the user can always expand.
- **Layout CSS.** `.shell { display: flex; min-height: 100vh }`; `.side { position: sticky; top: 0; height: 100vh; width: var(--side-w); flex: none }` with `--side-w` switched by `[data-sidebar]`; `.side nav` is a full-height flex column with `.nav-groups` scrolling (thin scrollbar in `--side-bg-active`). `main { flex: 1; min-width: 0; max-width: 1200px; padding: 0 var(--gutter) 48px }` (the `min-width: 0` is what lets wide tables scroll inside main instead of the page), `main.wide { max-width: none }` (pinned by a test).
- **Wide pages.** `WIDE` (Billing, one dashboard) is unchanged. Billing's `.table-scroll` scrolls sideways inside main; its sticky first column background becomes `var(--bg)`.
- **Assets page (flush).** `main:has(.assets-layout) { max-width: none; padding: 0 }`; the page's own detail area restores the gutter. `.shell-notices` has `padding: 12px var(--gutter) 0` and `:empty { display: none }` (both notices render `null` when quiet), so a notice never sits flush against the tree column.
- **Discovery (one window tall).** Replace the old `#root:has(.graph-page) > nav` block with: `.shell:has(.graph-page) { height: 100vh }`, `main:has(.graph-page) { max-width: none; display: flex; flex-direction: column; min-height: 0 }`, `.graph-page { flex: 1; min-height: 0; … }` (the rest of the graph block unchanged). The canvas keeps its 320px minimum.
- **Login, Setup** render outside the Layout: a centred 400px card on `--surface`, brand mark above the `h1`, same fields and buttons.

## 4. Component rules

- **Buttons.** Base `button` (all bare buttons in the app): 34px high, `0 14px` padding, `--radius`, 1px `--border-strong`, white, `--fs-sm` 500. Variants by class: `.primary` (accent fill, white text), `button.danger` (keep the class name: danger fill, white), `.quiet` (no border, accent text, accent-tint hover; for row actions such as Edit), `.danger-quiet` (crit text, crit-tint hover; for Remove/Delete in rows). `:disabled` = 0.55 opacity, `not-allowed`. `[aria-pressed="true"]` (Audit quick filters) = accent-tint fill, accent-ink text, accent border. Icon-only buttons use `.icon-btn` (28px square) and must have an `aria-label`. Each page has at most one `.primary`.
- **Links.** Accent, no underline, underline on hover; inside running text (`p a`) always underlined.
- **Fields.** `label` stays `display: grid; gap: 6px` with the label text `--fs-sm` 600; text-like `input`s (never checkboxes or radios, see section 5), `select`, `textarea`: 38px (textarea auto), `0 12px`, `--radius`, `--border-strong`; focus = 2px `--ring` outline offset 0 + ring-coloured border. Help text `.muted` `--fs-xs`; an error under a field is `.error` (crit, 600, `--fs-xs`); a field with `aria-invalid="true"` gets a crit border. Checkboxes: `label.inline` / `.check` row with `accent-color: var(--accent)`. `fieldset`: 1px `--border`, `--radius`, `legend` `--fs-sm` 600. `form` keeps `max-width: 480px`.
- **Tables.** Inside a `.table-wrap` (1px `--border`, `--radius`, `overflow-x: auto`); bare tables still look right without it. `th`: `--fs-xs` 600 `--text-2` on `--surface`, 9px/14px, `white-space: nowrap`, `position: sticky; top: 0` when the wrap scrolls vertically (`.dialog-rows`). `td`: `--row-y`/`--row-x`, bottom border only, middle-aligned; row hover `--row-hover`. Two-line cells: `<span class="strong">` + `<span class="sub">`. `td.num`/`th.num`: right-aligned, `tabular-nums`. `table.billing`: keep `nowrap`, the sticky row header (background `var(--bg)`), and the muted shaded cell (section 5). `td code` keeps `overflow-wrap: anywhere`.
- **Status chips** (`.chip` + one of `.chip-ok`, `.chip-stale`, `.chip-warn`, `.chip-bad`, `.chip-off`): 22px, `0 8px`, `--radius-sm`, `--fs-xs` 600, tinted fill + status ink, and a shape before the word: filled dot ok, hollow dot stale, triangle warning, diamond bad, dash disabled. The word is always there (colour plus shape plus word). **The widget header's `<span class="chip chip-warn">` keeps its old outlined look via the frozen rules** (section 5).
- **Status icons** (`.st` + `.st-ok|stale|warn|bad|off`), option B's shapes, used where only a mark fits (tree nodes, legend). A bare icon carries `role="img" aria-label="<status>"`.
- **Notices and banners.** `.banner` (flex, icon + text + optional action link right, `--radius`, 1px border): `.banner-warn` (warn-bg/line/ink, the collector-late case, RoleChangedNotice, certificate expiring), `.banner-info`. `.notice` (neutral, 3px left rule) for "not polled" style notes. Plain `p.error` / `p.warning` stay inline text (crit / warn ink), `role="alert"` unchanged.
- **Dialogs.** `.dialog-backdrop` (`--backdrop`, z 1000, centred, 16px padding). `.dialog`: white, `--radius-lg`, `--shadow-dialog`, padding 22px 24px, `display: grid; gap: 16px`, `h2` `--fs-lg` 600. Widths: `.dialog` 960px (review, widget editor), `.dialog.narrow` 440px (`Modal`), `.dialog.confirm` 480px. The last `.row` of buttons in a dialog is right-aligned (`justify-content: flex-end`) with Cancel before the primary. `tr.conflict td` uses `--crit-tint`.
- **Page header.** New `components/PageHeader.tsx`: `<header class="page-head">` with optional crumbs (`<p class="crumbs">`, **not a `<nav>`**), the `h1` (unchanged text), an optional `.sub` line and an `.actions` slot. 22px/600 title, bottom border `--border`, 22px below.
- **Filter bar and pager (Audit).** `.filter-bar` = a `--surface` panel (1px `--border`, `--radius`, 12px 16px) holding the existing `.row`s; labels sit above controls (`label` grid). Quick filters are normal buttons with the `aria-pressed` style. The pager is a `.row` with First/Previous/Next/Last as normal buttons, the page text `.muted`, right-aligned rows-per-page.
- **Asset tree column** (`AssetsPage`, option B). `.assets-layout` = flex row; `.tree-col` (`aria-label="Asset tree"`, a `section`, not a `nav`) is `position: sticky; top: 0; height: 100vh; width: var(--tree-w)`, right border `--border-strong`. Header: `h2` "Assets", a top-level add `.icon-btn` (admin only, `aria-label="Add a top-level asset"`, opens the same dialog as "Add asset" with no parent), and the column toggle `.icon-btn` (`aria-label` "Minimize asset tree" / "Expand asset tree", `aria-expanded`, `aria-controls` the body). Then a filter input (label "Filter assets", visually hidden; filters by name or kind, keeps ancestors of matches), the scrolling tree, and the legend (`div role="group" aria-label="Status key"`, **not a list**). Minimized: 44px `--surface` strip with only the toggle (focus stays on it). State in `localStorage["dcdash.assetTree"]`, same try/catch helper. Nodes: `ul.tree` / nested `ul` (the only lists on the page), each `.node` row = disclosure `button.twisty` (`aria-expanded`, `aria-label="Children of <name>"`; a leaf gets a 20px spacer), status icon (when the asset has a status), the name `Link` (ellipsis, `title` = full name), `.kind` (`--fs-xs`, hidden below 1180px), and the `.add` button (`aria-label="Add child of <name>"`, svg plus, admin only, `disabled` while locked). Selected: `.node.is-selected` (accent-tint fill, 3px inset accent bar, accent-ink 600) and `aria-current="true"` on its link. Branches start expanded; collapsed children get `hidden`.
- **Tiles** (`AssetPage`, `CostTile`, `EnergyTile`): keep the class names `.tile` and `.big` (unit and e2e tests locate them); restyle as option A's tile: 1px `--border`, `--radius`, 14px 16px, label `.muted` `--fs-sm`, figure `.big` `--fs-figure` 600 tabular-nums; laid out in a `.tiles` grid (`repeat(auto-fit, minmax(170px, 1fr))`, 16px gap). `.tile .big.muted` keeps `--text-2`.
- **Empty, loading, error.** Empty list = `.empty` (dashed `--border-strong`, centred icon in accent-tint, `h3`, one line of help, the primary action). Loading = `p.muted` "loading…" (text unchanged). Error = `p.error role="alert"` (unchanged).

## 5. Migration of `frontend/src/app.css`

Status: **K** kept as is, **R** restyled with tokens (selector kept), **X** replaced, **D** removed, **F** frozen (widget/editor, keep literally, do not touch).

| Selector | | Note |
|---|---|---|
| `*` | K | |
| `body` | R | font, `--text`, `--bg`. Stays ONE rule with exactly this selector (test helper). |
| `a` | R | accent links |
| `nav` | D | replaced by `.side nav`; a bare `nav` rule would restyle the sidebar |
| `nav .spacer` | D | the old bar's spacer |
| `main` | R | flex child, padding, `min-width: 0`, max-width 1200 |
| `main.wide` | K | pinned by test |
| `main:focus` | K | |
| `nav a[aria-current="page"]` | X | `.side-row[aria-current="page"]` (600 weight; update the test, below) |
| `.skip-link`, `.skip-link:focus` | R | tokens; keep `position: absolute` (pinned) |
| `table`, `th, td` | R | section 4; **the frozen rules re-pin the widget tables** |
| `form` | K | grid, max-width 480 |
| `label` | R | gap 6, `--fs-sm` 600 label text |
| `button` | R | section 4 base |
| `.error`, `.warning`, `.muted` | R | crit / warn ink / `--text-2`; `.muted` stays ONE rule with exactly this selector |
| `.row` | K | flex row; used by widgets too, so its rule does not change |
| `.tile`, `.tile .big` | R | option A tile; class names kept |
| `ul.tree, ul.tree ul`, `ul.tree li` | X | the tree column rules (section 4) |
| `.selected` | D | only `AssetTree` uses it; replaced by `.node.is-selected` (no test checks the class) |
| `textarea` | R | field look |
| `.panel` | R | `--surface` box, 1px `--border`, `--radius`; used by Scans, `SourcePanel`, DashboardEditor's conflict alert |
| graph block: `main:has(.graph-page)` (both), `#root:has(.graph-page)`, `#root:has(.graph-page) > nav` | X | section 3 Discovery rules |
| `.graph-page`, `.graph-page h1`, `.graph-page > .row`, `.graph-layout`, `.graph-canvas`, `.gpanel*` | R | border colours to tokens, sizes kept |
| `.gnode*`, `.offer-bar` | R | tokens only (border `--border-strong`, dashed kept, `.badge` crit); shapes and sizes unchanged |
| `.dialog-backdrop`, `.dialog`, `.dialog h2, .dialog p`, `.dialog h2` | R | section 4 |
| `.dialog fieldset`, `.dialog .field`, `.dialog label.inline`, `.dialog-rows`, `.dialog-rows table`, `.dialog input[type="number"]` | R | tokens, sizes kept |
| `.dialog tr.conflict td` | R | `--crit-tint` |
| `.dialog.confirm`, `.dialog.narrow` | K | widths |
| `button.danger` | R | `--danger` fill |
| `td code` | K | |
| `.table-scroll`, `table.billing th, table.billing td` | K | |
| `table.billing tbody th[scope="row"]` | R | background `var(--bg)` |
| `table.billing td.muted, table.billing td.muted .muted`, `table.billing td.muted` | F | literal #666 on #f4f4f4 (5.22:1, read by the test) |
| `td.num` | R | add `tabular-nums`, add `th.num` |
| `abbr[title]`, `ul.legend` | K | Billing legend |
| `.dash-head`, `.dash-head h1` | R | the dashboard page header gets the page-head type (title only) |
| `.row .spacer, .widget-head .spacer` | K | |
| `.dash-grid`, `.dash-cell`, `.widget-frame`, `.widget-head`, `.widget-head h3`, `.widget-notes`, `.widget-body`, `.widget-body table`, `.chip`, `.chip-warn`, `.stat .big`, `.stat .big small`, `.stat .big.muted`, `.stat > .muted:not(.big), .widget-body td:first-child`, `.gauge`, both `@media (max-width: 700px)` blocks | F | `.chip`/`.chip-warn` are moved to `.widget-frame .chip`, `.widget-frame .chip-warn` so the new global `.chip` can exist; see below |
| `.dash-grid-edit*`, `.widget-actions`, `.widget-actions button`, `.editor-cols*`, `.widget-preview`, `.asset-picker`, `.picker-list`, `.picker-row`, `.issues` | F | |

**Layering and the frozen island.** Everything W6 writes (all R/X/K rules and the new classes) goes inside one `@layer w6 { … }`. `:root` stays unlayered at the top; the island and then the frozen (F) rules stay **unlayered** at the end of the file: an unlayered rule beats any layered rule whatever its specificity, so no W6 rule can outrank a widget rule. But a property that only the W6 layer sets (say `white-space: nowrap` on `th`, a row-hover tint, a 34px button height) still reaches a widget, so the island resets those elements with `all: revert` (back to the browser default, as today) and re-adds the old literals. Scope `:is(.widget-frame, .widget-preview)` (shortened to `W` here):
- `W table { all: revert; border-collapse: collapse; width: 100%; margin: 8px 0 }` (the frozen `.widget-body table { margin: 0 }` comes later and wins the tie);
- `W th, W td { all: revert; border: 1px solid #000; padding: 4px 8px; text-align: left; vertical-align: top }` (keeps the browser's bold `th`; drops hover tint, last-row rule, nowrap, sticky, tabular-nums) and `W td.muted { color: #555 }`;
- `W button { all: revert; padding: 4px 10px; cursor: pointer }` and `W .widget-actions button { padding: 0 6px; font-size: 12px }` (`.widget-actions` renders inside the widget head, via `WidgetFrame`'s `actions` prop);
- `W .chip { all: revert; display: inline-block; padding: 0 6px; border: 1px solid #000; font-size: 12px; white-space: nowrap }`, `W .chip::before { content: none }`, `W .chip-warn { border-color: #b00; color: #b00 }` (these replace the old global `.chip`/`.chip-warn` rules, which would otherwise, unlayered, beat the new status chips everywhere).
Outside widgets the W6 layer must also stay off controls it was not designed for: field sizing applies only to text-like inputs (`text, password, number, date, time, datetime-local, search, email, url`), `select` and `textarea`, never to checkboxes and radios (the editor's `.picker-row`, `label.inline`, Users); and `.gnode button` keeps `height: auto; padding: 0 6px; font-size: 11px` so React Flow node sizes (and the discovery e2e drags) do not change. Plain `.muted`/`.error` text inside a widget takes the new ink (#596579 instead of #555, visually the same). Check by eye that a dashboard looks identical before and after B1 (screenshot `/dashboards/<id>` on main and on the branch at 1600 px, view and edit mode, compare).

**Widget and editor classes that must keep their look:** `.dash-head` (structure), `.dash-grid`, `.dash-cell`, `.dash-grid-edit`, `.widget-frame`, `.widget-head`, `.widget-drag-handle`, `.widget-notes`, `.widget-body`, `.widget-actions`, `.widget-preview`, `.chip`, `.chip-warn` (inside widgets), `.stat`, `.big` (under `.stat`), `.gauge`, `.editor-cols`, `.asset-picker`, `.picker-list`, `.picker-row`, `.issues`, `.react-grid-*`. `MUTED_FIGURE` in `lib/widgetFormat.ts` must stay equal to `.stat .big.muted`'s colour. Note: `.tile` and `CostTile`/`EnergyTile` are the Asset page's tiles, not widgets; they are restyled.

**Tests that pin CSS or markup, and what changes.**
- `app.css.test.ts`: (a) `declared()` reads hex literals only. Extend it to resolve `var(--name)` from the single `:root` block (and assert that `body` and `.muted` are each one rule with that exact selector). (b) In B2, when the old nav rule goes, replace the nav pin with `/\.side-row\[aria-current="page"\]\s*\{[^}]*font-weight:\s*600/`. (c) Keep the skip-link, `main.wide`, wrap and widget assertions unchanged. (d) Add: every sidebar token pair in section 2 is at least 4.5:1 (text) or 3:1 (`--side-accent` on `--side-bg-active`), and `--accent` is not used inside any `.side` rule.
- `Layout.test.tsx`: names and hrefs still pass; every `findByText(`u (${role})`)` lookup (the "user has loaded" signal, line 123 and others) changes to `findByText("u")` plus an assertion of the role word. Add: the toggle flips `aria-expanded` and its name; labels stay in the DOM when minimized; a throwing `localStorage` (`vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw … })`) still renders expanded; the stored "minimized" is applied.
- `AssetsPage.test.tsx`: line 48 `toHaveTextContent("+")` breaks (the button now holds an svg): assert the accessible name and `type="button"` only. Add: twisty collapses a branch, tree toggle, legend present.
- `AssetPage.test.tsx`: `.tile` / `.big` / `.muted` lookups pass if class names are kept.
- `App.test.tsx` line 84: passes (link still named "Assets").
- e2e: `journey.spec.ts:63` needs exactly one list on /assets (kept: no `ul` in nav or legend). `journey.spec.ts:64` clicks the "Selected: … (open page)" paragraph: keep that paragraph in the detail area (restyled) or change line 64 in the same batch. Six specs use `getByRole("navigation")` with strict mode: one `nav` only, and the user inside it. They assert `toContainText(`${username} (${role})`)` (`w3a:34`, `w3b:90`, `w3c:40`, `w3d:53`, `phase3:53`, `headers:93`): each changes to `toContainText(username)` and `toContainText(roleLabel(role))`, with `roleLabel` in a new `frontend/e2e/roles.ts` (`admin`→Administrator, `operator`→Operator, `viewer`→Viewer). `AuthProvider.refresh.test.tsx` renders its own `name (role)` text and does not use the Layout: unchanged. `w3b`/`phase3` use `.tile … .big`, `.dash-grid`, `.dash-grid-edit`, `.widget-preview .big`: kept. `DiscoveryPage.test`/`SourcePanel.test` query `complementary`: they render without the Layout, so the shell's `<aside>` does not collide; any new App-level test must name it (`{ name: "Source details" }`).

## 6. Rollout

Each batch leaves the app working and all tests green. Unit tests per batch, the full `npm test` + `npm run build` + `scripts/e2e.sh` at the end of batches 2 and 4.

**B1. Token layer and base elements** (`app.css`, `app.css.test.ts`). Add `:root`, restyle the element rules (`body`, `a`, `button`, fields, tables, `.muted/.error/.warning`), the frozen island, the new classes (`.chip-*`, `.st-*`, `.banner*`, `.notice`, `.empty`, `.page-head`, `.icon-btn`, button variants) unused yet. Keep the old `nav` rules (and their test pin) until B2; wrap them in the layer like the rest. By eye: every page still readable in the old top bar; a dashboard identical (compare screenshot). Tests: `app.css.test.ts`, `Layout.test.tsx`.

**B2. The shell** (`Layout.tsx`, new `lib/sidebarState.ts` + test, `AssetsPage.tsx`, `AssetTree.tsx`, `app.css` shell and tree sections, the graph block). Remove `nav`, `nav .spacer`, `nav a[aria-current]` (and switch its test pin, section 5), the old graph `#root` rules. By eye at 1440 and 1024: both sidebar states, tooltips on hover and Tab, skip link, Discovery exactly one window tall (no page scrollbar at 1600×1000 and 1024×768), Billing scrolls inside main, Assets tree column flush and sticky, both tree states. Tests: `Layout.test`, `AssetsPage.test`, `App.test`, `DiscoveryPage.test`, then the full suite and e2e.

**B3. Shared pieces** (`Modal.tsx`, `ConfirmDeleteDialog.tsx`, new `PageHeader.tsx`, `AuditFilterBar.tsx`, `AuditPager.tsx`, `CertificateNotice.tsx`, `RoleChangedNotice.tsx` (banner classes), `CostTile.tsx`, `EnergyTile.tsx`, `SourceForm`, `AssetForm`, `MappingForm`, `SchemaForm`, `ScopeForm` (button classes only)). Markup changes are class names and wrappers only. Tests: each component's own test file.

**B4. Page polish**, in five groups with disjoint files, so **4a to 4e may run in parallel** (each also touches only its own section at the end of `app.css`, marked `/* W6 4a */` etc., to avoid merge conflicts):
- 4a Assets + Asset: `AssetsPage.tsx` detail area (PageHeader with crumbs, meta `dl`, tiles), `AssetPage.tsx`, `MetricsTable.tsx`, `TrendChart.tsx` frame only. Tests: `AssetsPage.test`, `AssetPage.test`, `TrendChart.test`; e2e journey, w3a.
- 4b Sources + Source points + Scans + Discovery: `SourcesPage`, `SourcePointsPage`, `ScansPage`, `ScanProgress`, `JobStatus`, `DiscoveryPage` header, `graph/SourcePanel`, `graph/ReviewDialog`. Tests: their test files; e2e discovery, journey.
- 4c Billing + Tariffs: `BillingPage`, `TariffsPage`, `RangePicker`. Tests: `BillingPage.test`, `TariffsPage.test`; e2e phase3.
- 4d Users + Settings + Storage + Audit + Audit entry: `UsersPage`, `SettingsPage`, `StoragePage`, `AuditPage`, `AuditEntryPage`, `AuditEntryDetail`. Tests: their files; e2e w3c, w3d.
- 4e Login + Setup + Password + Not found + Dashboards list: `LoginPage`, `SetupPage`, `PasswordPage`, `NotFoundPage`, `DashboardsPage`. Tests: their files; e2e headers.
By eye per group: 1440 and 1024, sidebar both states, no horizontal page scroll, one primary button per page, every status shows a shape and a word.

## 7. Risks and checks

- **Graph page height.** The new flex row could let main grow past the window. Check: at 1600×1000 and 1024×768, `document.scrollingElement.scrollHeight === innerHeight` on /discovery; e2e discovery drags still land.
- **Wide tables.** Without `min-width: 0` on main, Billing pushes the page sideways. Check: no horizontal page scrollbar on /billing with a 31-day month; the sticky asset column stays.
- **Widgets next to the new style.** Leaks from the element rules. Check: the before/after dashboard screenshot is identical in the widget areas; `app.css.test` widget assertions unchanged.
- **Focus order and skip link.** Order: skip link, sidebar (brand, links, user, Password, Sign out, toggle), main. Check by Tab in a browser; `Layout.test` skip-link test; the minimized tooltip shows on focus.
- **Contrast.** The token test in `app.css.test.ts` (B1) computes every pair in section 2.
- **Storage that throws.** Private windows and tests. Check: the helper's try/catch and the `Layout.test` case with a throwing `getItem`/`setItem`.
- **No `matchMedia` in jsdom**, and jsdom's `innerWidth` is 1024. The start-state code guards with `typeof window.matchMedia === "function"` and never reads `innerWidth`; labels never leave the DOM, so name queries work in either state.
- **Strict-mode landmarks and lists in e2e.** One `nav`, no `ul` outside the tree on /assets, no `<nav>` breadcrumbs. Check: the e2e run at the end of B2.
- **Notices on the flush Assets page.** Check with a role change (RoleChangedNotice) that the banner has the gutter and the tree column starts below it.
