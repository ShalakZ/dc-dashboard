# W6 UI overhaul: design spec

Date: 2026-10-11. Status: look approved by the owner ("Yes, build it", 2026-10-11) with the decisions below; Opus review done 2026-10-11, fixes applied. Branch `w6-ui-overhaul` (from main b821ba7).
Reference mockup: `.superpowers/sdd/2026-10-11-w6-ui-overhaul/mockups/option-a2.html` (open it in a browser; it is the visual source of truth, this document is the build contract).

## 1. Goal, scope, bans, decisions

**Goal.** One clean, quiet, functional look across the app: "still simple for the user to use and understand, all while looking clean and slick and functional" (owner). A Sunbird-like shell: a grouped left sidebar, white content, a page header per page, tinted status chips, tables with a second muted line.

**In scope.** The shell (`Layout.tsx`), `app.css`, the shared pieces (`Modal`, `ConfirmDeleteDialog`, forms, `AssetTree`, `AuditFilterBar`, `AuditPager`, notices, tiles) and every page: Assets, Asset, Dashboards list, Billing, Sources, Source points, Scans, Discovery (its chrome, not the graph nodes' logic), Users, Settings, Tariffs, Storage, Audit, Audit entry, Password, Login, Setup, Not found.

**Out of scope (keeps its current look).** The dashboard widgets (everything inside `.widget-frame`) and the dashboard editor's grid (`.dash-grid*`, `.react-grid-*`, `.widget-actions`, `.widget-preview`). The widget editor dialog's own pieces (`.editor-cols`, `.asset-picker`, `.picker-*`, `.issues`) keep their layout but take the dialog's tokens (decision 6). Section 5 lists the frozen rules. No behaviour, route, API or wording change anywhere, except the few markup changes this spec names. Headings, button names, link names and labels stay word for word (tests find them by name).

**Hard bans** (any one is a failure): a cream or off-white page background; italic accent words in headings; numbered "01/02/03" labels; monospace labels; pill buttons (radius is 4 to 8 px, never 999px). Also none of: gradient blobs, glassmorphism, emoji icons, a drop shadow on every card. Icons are inline SVG, 24-unit viewBox, 1.7 stroke, `aria-hidden="true"`.

**Owner decisions (2026-10-11).** (1) Option A is the base: dark sidebar, white content, blue accent #1d5bd8, comfortable density. (2) The sidebar colour is quantum navy rgb(40, 51, 84) = `#283354`. (3) The nav sidebar is expandable and minimizable by hand (option B's idea). (4) The Assets screen uses option B's layout: the tree as its own full-height column beside the detail, with B's per-node "+" button. **B's status icons on tree nodes and B's tree legend are NOT built** (review 2026-10-11, default pending the owner's answer): `Asset` has no status field and W6 changes no API. Follow-up **F-2** (a small backend field: per-asset status for the tree, then the icons and the legend) goes in the backlog beside F-1. B's status shapes (`.st-*`, the `.chip-*` shapes) stay defined and are used where the data exists (points, Sources, Users, banners). (5) The tree column is on the Assets LIST page only for now; the owner wants it on each asset's page (/assets/:id) too "e2e eventually": recorded as follow-up F-1 in the backlog, not built here. (6) The dashboard editor's dialogs (widget editor, new dashboard, unsaved changes) take the new buttons and fields; only the widgets and the editor grid stay as they are. (7) The signed-in user reads as the name with the role written out below it (Administrator / Operator / Viewer), not `name (role)`.

## 2. Tokens

All tokens live in one `:root` block at the top of `app.css`. **Rule: no raw colour in a component rule, only `var(--…)`.** The only exceptions are the frozen widget/editor rules (section 5), which keep their literals so they cannot drift, and the few literals `app.css.test.ts` reads (see section 5, test changes).

```css
:root {
  /* content */
  --accent: #1d5bd8; --accent-hover: #174bb5; --accent-tint: #e8effc; --accent-ink: #163f94;
  --bg: #ffffff; --surface: #f6f8fb; --row-hover: #fafbfd; --border: #e1e5ec; --border-strong: #cdd3dd;
  --field-border: #868fa0;   /* inputs, selects, textareas, checkboxes: 3.26:1 on white, 3.06:1 on --surface (WCAG 1.4.11) */
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

Measured contrast (WCAG 2.x). Content: white on accent 5.93; accent on white 5.93; text 16.27; text-2 5.90; disabled 4.71; chip ok 5.66, warning 5.98, critical 5.78, info 6.30, stale 5.73; white on danger 5.90; banner ink on warn-bg 8.56. Sidebar on #283354: white 12.41; `--side-text` 6.97 (5.96 on the hover fill, but hover text turns white, 10.62); `--side-muted` 5.10 **on plain navy only** (4.36 on the hover fill, so never put muted text on hover/active fills); white on the active fill 9.04; `--side-accent` 5.90 (4.29 on the active fill, non-text, needs 3:1); navy on the accent brand mark 5.90; avatar 7.09; tooltip 16.27. **`--accent` #1d5bd8 is 2.09:1 on the navy and must never appear on the sidebar** (text, icon, indicator or focus ring); `--side-accent` is the sidebar's accent. Non-text: `--field-border` 3.26 on white and 3.06 on `--surface` (the boundary of every field and checkbox needs 3:1; `--border-strong` is 1.50 and is for dividers and buttons only).

Focus: `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }`; `.side` redefines `--ring: var(--side-accent)` (`--ring` equals `--accent`, so the sidebar must override it); form controls use offset 0 and also colour their border. `prefers-reduced-motion: reduce` turns every transition off.

**No global element resets.** W6 must not port the mockup's `h1, h2, h3, p { margin: 0 }`, `button, input, select { font: inherit; color: inherit }` or a body line-height other than 1.4: they reach the widgets (the review measured widget paragraphs losing their 14px margins and every widget line growing). `body` keeps `font-size: 14px; line-height: 1.4`. Margin resets are scoped (`.page-head`, `.dialog`, `.empty`, `.tree-col`, `.side`); `font: inherit` on controls is scoped to the controls W6 styles (`button` base, text-like fields) and the island reverts it inside widgets.

## 3. The shell

`Layout.tsx` renders, in this order:

```
<a class="skip-link" href="#main">Skip to content</a>        (unchanged behaviour: focuses #main, no hash)
<div class="shell" data-sidebar="expanded|minimized">
  <div class="side" id="sidebar">                            (a div, not an <aside>: no extra unlabelled landmark)
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
        <button type="button" class="side-row side-toggle">…Minimize sidebar | Expand sidebar</button>   (no aria-expanded)
      </div>
    </nav>
  </div>
  <main id="main" tabIndex={-1} className={wide ? "wide" : undefined}>
    <div class="shell-notices"><RoleChangedNotice/>{admin && <CertificateNotice/>}</div>
    <Outlet/>
  </main>
</div>
```

- Each link is `<NavLink className="side-row">` with `<svg class="i">` + `<span class="lbl">Name</span>`. NavLink already sets `aria-current="page"`; the active style keys on that attribute. Groups are `div`s with `role="group"`, **never `<ul>`** (journey.spec queries the only list on the Assets page), and the group heading is a `span`, not an `h2` (the page's `h1` stays the first heading).
- The role gating is today's, link for link. A group whose links are all gated away is not rendered.
- **The user block (owner decision 7):** the name on one line and the role written out below it, `ROLE_LABEL = { admin: "Administrator", operator: "Operator", viewer: "Viewer" }` defined in `Layout.tsx`. The old single text run `{username} ({role})` is gone, so the tests that look for it change in B2 (section 5). The avatar letter is `username[0].toUpperCase()`. Minimized, the block shows only the avatar; name and role stay in the DOM (visually hidden) and appear in the tooltip.
- **Labels are hidden with CSS only, never removed from the DOM.** Minimized, `.lbl` and `.nav-heading` get the visually-hidden style; screen readers and `getByRole("link", { name })` still see them. Group headings collapse to a 1px `--side-rule` divider.
- **Tooltips (minimized only).** `.nav-groups` keeps `overflow-y: auto` in BOTH states (the review measured the minimized rail at 1024×620: with `overflow: visible` the last links painted over Password and Sign out with no scroll). So the tooltip is not a CSS-revealed `.lbl` but one shared element rendered by `Layout` (e.g. `<div class="side-tip" role="tooltip" id="side-tip" hidden>`), `position: fixed`, placed by a small handler: on `pointerenter` and `focus` of a minimized row it copies the row's label text, sets `top` from the row's `getBoundingClientRect()` (vertically centred) and `left` to `var(--side-w-closed)` + 8px, and shows it; it hides on `pointerleave` of BOTH the row and the tip (the tip has pointer events, so the pointer can move onto it: WCAG 1.4.13 hoverable), on `blur`, on scroll of `.nav-groups`, and on `Escape` (keydown listener on the document while shown: dismissible without moving pointer or focus). The tip is `aria-hidden="true"` (the row's own label is already its accessible name). `--tooltip-*` colours, `--radius-sm`, `--shadow-tip`. The avatar block shows the name and role the same way on hover. `.side` has `z-index: 40` (a sticky element is its own stacking context; without it the sticky `.tree-col` paints over the sidebar), the tip `z-index: 50`; dialogs stay at 1000.
- **Toggle.** One `<button type="button">` in the foot; its visible (or, minimized, visually hidden) label is its accessible name: "Minimize sidebar" / "Expand sidebar". **No `aria-expanded`** (the nav content is never hidden; the changing name is the state). Focus stays on it after a click. Width transition 150 ms on `.side`, none under reduced motion, and none on first paint (add the transition class one frame after mount).
- **State and persistence** in `frontend/src/lib/sidebarState.ts` (not `lib/layout.ts`, that name is taken): `initialSidebar(): "expanded" | "minimized"` returns `"minimized"` when `typeof window.matchMedia === "function" && matchMedia("(max-width: 1179.98px)").matches`, otherwise the stored value, otherwise `"expanded"`. `saveSidebar(state)` writes `localStorage["dcdash.sidebar"]`. Every storage read and write is wrapped in try/catch (private windows, blocked storage); a failure means "not remembered", never an error. jsdom has no `matchMedia`, so tests start expanded. No resize listener: the width rule decides the start state only, and the user can always expand.
- **Layout CSS.** `.shell { display: flex; min-height: 100vh }`; `.side { position: sticky; top: 0; z-index: 40; height: 100vh; width: var(--side-w); flex: none; --ring: var(--side-accent) }` with `--side-w` switched by `[data-sidebar]`; `.side nav` is a full-height flex column with `.nav-groups { flex: 1; min-height: 0; overflow-y: auto }` in both states (thin scrollbar in `--side-bg-active`); the foot stays outside the scrolling part. `main { flex: 1; min-width: 0; max-width: 1200px; padding: 0 var(--gutter) 48px }` (the `min-width: 0` is what lets wide tables scroll inside main instead of the page), `main.wide { max-width: none }` (pinned by a test).
- **Wide pages.** `WIDE` (Billing, one dashboard) is unchanged. Billing's `.table-scroll` scrolls sideways inside main; its sticky first column background becomes `var(--bg)`.
- **Assets page (flush).** `main:has(.assets-layout) { max-width: none; padding: 0 }`; the page's own detail area restores the gutter. `.shell-notices { padding-top: 12px }` and `:empty { display: none }` (both notices render `null` when quiet); only `main:has(.assets-layout) .shell-notices` adds the horizontal `var(--gutter)` (elsewhere main already has it, and a second gutter would put notices 56px in), so a notice never sits flush against the tree column.
- **Discovery (one window tall).** Replace the old `#root:has(.graph-page) > nav` block with: `.shell:has(.graph-page) { height: 100vh }`, `main:has(.graph-page) { max-width: none; display: flex; flex-direction: column; min-height: 0 }`, `.graph-page { flex: 1; min-height: 0; … }` (the rest of the graph block unchanged). The canvas keeps its 320px minimum.
- **Login, Setup** render outside the Layout: a centred 400px card (1px `--border`, `--radius-lg`, padding 28px) on the WHITE page background (`--bg`; never a `--surface` or other off-white page), brand mark above the `h1`, same fields and buttons.

## 4. Component rules

- **Buttons.** Base `button` (all bare buttons in the app): `min-height: 34px` (never a fixed `height`, so a wrapped label is not clipped), `0 14px` padding, `--radius`, 1px `--border-strong`, white, `--fs-sm` 500. Variants by class: `.primary` (accent fill, white text), `button.danger` (keep the class name: danger fill, white), `.quiet` (no border, accent text, accent-tint hover; for row actions such as Edit), `.danger-quiet` (crit text, crit-tint hover; for Remove/Delete in rows). `:disabled` = 0.55 opacity, `not-allowed`. `[aria-pressed="true"]` (Audit quick filters) = accent-tint fill, accent-ink text, accent border. Icon-only buttons use `.icon-btn` (28px square) and must have an `aria-label`. Each page has at most one `.primary`.
- **Links.** Accent, no underline, underline on hover; inside running text (`p a`) always underlined.
- **Fields.** `label` stays `display: grid; gap: 6px`, `--fs-sm`. Labels WRAP their controls (`<label>Name<input/></label>`), so the label's weight cascades: `label` itself is weight 600 only where it does not wrap a checkbox or radio, and every control and help line inside it resets to 400 (`label :is(input, select, textarea, .muted, .error) { font-weight: 400 }`). Checkbox and radio labels (`label.inline`, `.check`, `.picker-row`, `label:has(> input[type="checkbox"]), label:has(> input[type="radio"])`) are weight 400. Text-like inputs are `input:is(:not([type]), [type="text"], [type="password"], [type="number"], [type="date"], [type="time"], [type="datetime-local"], [type="search"], [type="email"], [type="url"])` (27 inputs in the app have no `type`; never checkboxes or radios), `select`, `textarea`: `min-height: 38px` (textarea auto), `0 12px`, `--radius`, 1px `--field-border`; focus = 2px `--ring` outline offset 0 + ring-coloured border. Help text `.field-help` / `label .muted` `--fs-xs`; an error under a field is `label .error` / `.field .error` (crit, 600, `--fs-xs`); a field with `aria-invalid="true"` gets a crit border. **The global `.muted`, `.error` and `.warning` rules set colour only** (no size, no weight: they also style widget text). Checkboxes: `accent-color: var(--accent)`, border `--field-border` where drawn. `fieldset`: 1px `--border`, `--radius`, `legend` `--fs-sm` 600. `form` keeps `max-width: 480px`.
- **Tables.** Inside a `.table-wrap` (1px `--border`, `--radius`, `overflow-x: auto`); bare tables still look right without it. `th`: `--fs-xs` 600 `--text-2` on `--surface`, 9px/14px, `white-space: nowrap`, `position: sticky; top: 0` when the wrap scrolls vertically (`.dialog-rows`). `td`: `--row-y`/`--row-x`, bottom border only, middle-aligned; row hover `--row-hover`. Two-line cells: `<span class="strong">` + `<span class="sub">`, **only in cells that no test matches by exact name**; a two-line cell keeps the same `td` (never becomes a `th`) and the same accessible name. The plan lists, per page task, the cells unit tests and e2e pin by exact text (e.g. the source name, the point address, the user name, the metric name, the audit action): those cells keep exactly their text; a second line goes in another column. `td.num`/`th.num`: right-aligned, `tabular-nums`. `table.billing`: keep `nowrap`, the sticky row header (background `var(--bg)`), and the muted shaded cell (section 5). `td code` keeps `overflow-wrap: anywhere`.
- **Status chips** (`.chip` + one of `.chip-ok`, `.chip-stale`, `.chip-warn`, `.chip-bad`, `.chip-off`): 22px, `0 8px`, `--radius-sm`, `--fs-xs` 600, tinted fill + status ink, and a shape before the word: filled dot ok, hollow dot stale, triangle warning, diamond bad, dash disabled. The word is always there (colour plus shape plus word). **The widget header's `<span class="chip chip-warn">` keeps its old outlined look via the frozen rules** (section 5).
- **Status icons** (`.st` + `.st-ok|stale|warn|bad|off`), option B's shapes, defined in B1 and used where only a mark fits and the data exists (points, Sources, Users). Not on tree nodes in W6 (no per-asset status: F-2). A bare icon carries `role="img" aria-label="<status>"`.
- **Notices and banners.** `.banner` (flex, icon + text + optional action link right, `--radius`, 1px border): `.banner-warn` (warn-bg/line/ink, the collector-late case, RoleChangedNotice, certificate expiring), `.banner-info`. `.notice` (neutral, 3px left rule) for "not polled" style notes. Plain `p.error` / `p.warning` stay inline text (crit / warn ink), `role="alert"` unchanged.
- **Dialogs.** `.dialog-backdrop` (`--backdrop`, z 1000, centred, 16px padding). `.dialog`: white, `--radius-lg`, `--shadow-dialog`, padding 22px 24px, `display: grid; gap: 16px`, `h2` `--fs-lg` 600. Widths: `.dialog` 960px (review, widget editor), `.dialog.narrow` 440px (`Modal`), `.dialog.confirm` 480px. The last `.row` of buttons in a dialog is right-aligned (`justify-content: flex-end`). Cancel before the primary: the DOM may be reordered ONLY where no test pins the order (check the component's and its page's tests); otherwise keep the DOM order and only right-align (never reorder visually with `order`/`row-reverse`, focus order must follow what is seen). `tr.conflict td` uses `--crit-tint`.
- **Page header.** New `components/PageHeader.tsx`: `<header class="page-head">` with optional crumbs (`<p class="crumbs">`, **not a `<nav>`**), the `h1` (unchanged text), an optional `.sub` line and an `.actions` slot. 22px/600 title, bottom border `--border`, 22px below.
- **Filter bar and pager (Audit).** `.filter-bar` = a `--surface` panel (1px `--border`, `--radius`, 12px 16px) holding the existing `.row`s; labels sit above controls (`label` grid). Quick filters are normal buttons with the `aria-pressed` style. The pager is a `.row` with First/Previous/Next/Last as normal buttons, the page text `.muted`, right-aligned rows-per-page.
- **Asset tree column** (`AssetsPage`, option B). `.assets-layout` = flex row; `.tree-col` (`aria-label="Asset tree"`, a `section`, not a `nav`) is `position: sticky; top: 0; height: 100vh; width: var(--tree-w)`, right border `--border-strong`. Header: the title `<p class="tree-title">Assets</p>` (**never a heading**: an `h2` "Assets" next to the page's `h1` "Assets" breaks four strict-mode e2e lookups, `journey:13`, `discovery:62`, `w3a:39`, `headers:104`, and would put a heading before the `h1`), a top-level add `.icon-btn` (admin only, `aria-label="Add a top-level asset"`, opens the same dialog as "Add asset" with no parent), and the column toggle `.icon-btn` (`aria-label` "Minimize asset tree" / "Expand asset tree", `aria-expanded`, `aria-controls` the body). Then a filter input (label "Filter assets", visually hidden; filters by name or kind, keeps ancestors of matches) and the scrolling tree. **No legend and no status icons** (F-2). Minimized: 44px `--surface` strip with only the toggle (focus stays on it). State in `localStorage["dcdash.assetTree"]`, same try/catch helper. Nodes: `ul.tree` / nested `ul` inside the parent `li` (the only lists on the page; `AssetsPage.test:23` finds a child link inside the parent's `li`), each `.node` row = disclosure `button.twisty` (`aria-expanded`, `aria-label="Children of <name>"`; a leaf gets a 20px spacer), the name `Link` (ellipsis, `title` = full name), `.kind` (`--fs-xs`, hidden below 1180px), and the `.add` button (`aria-label="Add child of <name>"`, svg plus, admin only, `disabled` while locked). Selected: `.node.is-selected` (accent-tint fill, 3px inset accent bar, accent-ink 600) and `aria-current="true"` on its link. Branches start expanded; collapsed children get `hidden`.
- **Assets detail area** (beside the tree column), exactly: the `h1` "Assets" (unchanged text, via `PageHeader`), a meta `dl` built from the list data only (for the selected asset: kind, parent, number of children), the "Selected: <name link> (open page)" paragraph (`journey:64` clicks it) and the admin buttons (Add asset, Edit, Delete). **No tiles, no new queries** (tiles stay on `AssetPage`). With nothing selected: the `h1`, "No assets yet." when empty, and the admin buttons.
- **Tiles** (`AssetPage`, `CostTile`, `EnergyTile`; between Task 3 and 4a `.tile` loses `inline-block` before `AssetPage` gets the `.tiles` wrapper: check by eye that the page stays readable): keep the class names `.tile` and `.big` (unit and e2e tests locate them); restyle as option A's tile: 1px `--border`, `--radius`, 14px 16px, label `.muted` `--fs-sm`, figure `.big` `--fs-figure` 600 tabular-nums; laid out in a `.tiles` grid (`repeat(auto-fit, minmax(170px, 1fr))`, 16px gap). `.tile .big.muted` keeps `--text-2`.
- **Empty, loading, error.** Empty list = `.empty` (dashed `--border-strong`, centred icon in accent-tint, `h3`, one line of help, the primary action). Loading = `p.muted` "loading…" (text unchanged). Error = `p.error role="alert"` (unchanged).

## 5. Migration of `frontend/src/app.css`

Status: **K** kept as is, **R** restyled with tokens (selector kept), **X** replaced, **D** removed, **F** frozen (widget/editor, keep literally, do not touch).

| Selector | | Note |
|---|---|---|
| `*` | K | inside the layer; the island re-adds `box-sizing: border-box` because `all: revert` wipes it |
| `body` | R | `font: 14px/1.4 var(--font)` (size and line-height unchanged), `--text`, `--bg`. Stays ONE rule with exactly this selector (test helper). |
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
| `label` | R | gap 6, `--fs-sm`; 600 only on non-checkbox labels, 400 inside (section 4 Fields) |
| `button` | R | section 4 base (`min-height: 34px`) |
| `.error`, `.warning`, `.muted` | R | crit / warn ink / `--text-2`, **colour only**; `.muted` stays ONE rule with exactly this selector |
| `.row` | K | flex row; used by widgets too, so its rule does not change |
| `.tile`, `.tile .big` | R | option A tile; class names kept |
| `ul.tree, ul.tree ul`, `ul.tree li` | X | the tree column rules (section 4); moved in B2b, kept (inside the layer) until then |
| `.selected` | D | only `AssetTree` uses it; replaced by `.node.is-selected` (no test checks the class) |
| `textarea` | R | field look |
| `.panel` | R | `--surface` box, 1px `--border`, `--radius`; used by Scans, `SourcePanel`, DashboardEditor's conflict alert |
| graph block: `main:has(.graph-page)` (both), `#root:has(.graph-page)`, `#root:has(.graph-page) > nav` | X | section 3 Discovery rules; replaced in B2a together with the shell (B1 only moves them into the layer unchanged, or /discovery breaks before `.shell` exists) |
| `.graph-page`, `.graph-page h1`, `.graph-page > .row`, `.graph-layout`, `.graph-canvas`, `.gpanel*` | R | border colours to tokens, sizes kept |
| `.gnode*`, `.offer-bar` | R | tokens only (border `--border-strong`, dashed kept, `.badge` crit); shapes and sizes unchanged; `.gnode button` adds `font-weight: 400` (the base 500 widened it 49.6→52.1px in the review's measurement) |
| (new) `.graph-canvas .react-flow__controls button` | R | `border-radius: 0; font-weight: 400`: xyflow's unlayered CSS wins only for the properties it sets, so the base button's radius and weight would otherwise reach React Flow's zoom controls |
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
| `.dash-grid`, `.dash-cell`, `.widget-frame`, `.widget-head`, `.widget-head h3`, `.widget-notes`, `.widget-body`, `.widget-body table`, `.stat .big`, `.stat .big small`, `.stat .big.muted`, `.stat > .muted:not(.big), .widget-body td:first-child`, `.gauge`, both `@media (max-width: 700px)` blocks | F | |
| `.chip`, `.chip-warn` (old widget chip) | X → F | moved into the island as `:is(.widget-frame, .widget-preview) .chip` / `.chip-warn` (see below); bare `.chip`/`.chip-warn` are now the layered status chips |
| `.dash-grid-edit*`, `.widget-actions`, `.widget-actions button`, `.widget-preview` | F | |
| `.editor-cols*`, `.asset-picker`, `.picker-list`, `.picker-row`, `.issues` | R | inside the widget-editor DIALOG, which takes the new controls (owner decision 6): tokens only (`.picker-list` border `--border`, radius `--radius`), sizes and layout kept; `.picker-row` labels weight 400 |

**Layering and the frozen island.** Everything W6 writes (all R/X/K rules and the new classes) goes inside one `@layer w6 { … }`. `:root` stays unlayered at the top; the island and then the frozen (F) rules stay **unlayered** at the end of the file: an unlayered rule beats any layered rule whatever its specificity, so no W6 rule can outrank a widget rule. But a property that only the W6 layer sets (say `white-space: nowrap` on `th`, a row-hover tint, a 34px button height) still reaches a widget, so the island resets those elements with `all: revert` (back to the browser default, as today) and re-adds the old literals. Scope `:is(.widget-frame, .widget-preview)` (shortened to `W` here):
- `W { color: #000; font: 14px/1.4 system-ui, sans-serif }` (pins what widgets inherit: without it every widget glyph turns #172033 in the new `--font` stack; the layered `.muted`/`.error` on child elements still win over inheritance);
- `W table { all: revert; box-sizing: border-box; border-collapse: collapse; width: 100%; margin: 8px 0 }` (the frozen `.widget-body table { margin: 0 }` comes later and wins the tie);
- `W th, W td { all: revert; box-sizing: border-box; border: 1px solid #000; padding: 4px 8px; text-align: left; vertical-align: top }` (keeps the browser's bold `th`; drops hover tint, last-row rule, nowrap, sticky, tabular-nums) and `W td.muted { color: #555 }`;
- `W button { all: revert; box-sizing: border-box; padding: 4px 10px; cursor: pointer }` and `W .widget-actions button { padding: 0 6px; font-size: 12px }` (`.widget-actions` renders inside the widget head, via `WidgetFrame`'s `actions` prop);
- `W .chip { all: revert; box-sizing: border-box; display: inline-block; padding: 0 6px; border: 1px solid #000; font-size: 12px; white-space: nowrap }`, `W .chip::before { content: none }`, `W .chip-warn { border-color: #b00; color: #b00 }` (these replace the old global `.chip`/`.chip-warn` rules, which would otherwise, unlayered, beat the new status chips everywhere).
Verified in Chromium by the review (old widget markup, old CSS vs this layering): table, th, td, chip and button boxes identical; the only computed differences were the inherited colour/font (pinned above), `box-sizing` (re-added above) and `.muted`/`.error` ink (accepted below).
Outside widgets the W6 layer must also stay off controls it was not designed for: field sizing applies only to text-like inputs (`:not([type])`, `text, password, number, date, time, datetime-local, search, email, url`), `select` and `textarea`, never to checkboxes and radios (the editor's `.picker-row`, `label.inline`, Users); and `.gnode button` keeps `min-height: 0; padding: 0 6px; font-size: 11px; font-weight: 400` so React Flow node sizes (and the discovery e2e drags) stay within a pixel (its new border is 1px instead of the browser's 2px). Plain `.muted`/`.error` text inside a widget takes the new ink (#596579 instead of #555, visually the same). Check by eye that a dashboard looks identical before and after B1 (screenshot `/dashboards/<id>` on main and on the branch at 1600 px, view and edit mode, compare).

**Widget and editor classes that must keep their look:** `.dash-head` (structure), `.dash-grid`, `.dash-cell`, `.dash-grid-edit`, `.widget-frame`, `.widget-head`, `.widget-drag-handle`, `.widget-notes`, `.widget-body`, `.widget-actions`, `.widget-preview`, `.chip`, `.chip-warn` (inside widgets), `.stat`, `.big` (under `.stat`), `.gauge`, `.react-grid-*`. (`.editor-cols`, `.asset-picker`, `.picker-*`, `.issues` keep their layout but take the dialog's tokens, decision 6.) `MUTED_FIGURE` in `lib/widgetFormat.ts` must stay equal to `.stat .big.muted`'s colour. Note: `.tile` and `CostTile`/`EnergyTile` are the Asset page's tiles, not widgets; they are restyled.

**Tests that pin CSS or markup, and what changes.**
- `app.css.test.ts`: (a) `declared()` reads hex literals only. Extend it to resolve `var(--name)` from the single `:root` block, and strip `/* … */` comments from the CSS first (a comment before `body {` or `.widget-frame {` would otherwise become part of the selector); assert that `body` and `.muted` are each one rule with that exact selector. (b) In B2a, when the old nav rule goes, replace the nav pin with `/\.side-row\[aria-current="page"\]\s*\{[^}]*font-weight:\s*600/`. (c) Keep the skip-link, `main.wide`, wrap and widget assertions unchanged. (d) Add: every token pair in section 2 at least 4.5:1 (text) or 3:1 (`--side-accent` on `--side-bg-active`, `--field-border` on `--bg` and on `--surface`); no rule whose selector contains `.side` uses `var(--accent…)`, and a `.side` rule sets `--ring: var(--side-accent)`. (e) The frozen set (section 5 "F", with the moved `:is(.widget-frame, .widget-preview) .chip` / `.chip-warn` selectors, not bare `.chip`) appears after the layer block, outside any `@layer`. (f) The same test file also reads every `src/styles/*.css`: each file is one `@layer w6 { … }` block and nothing outside it, has no raw colour (hex, `rgb(`, `hsl(`) outside `var(--…)`, and uses no `var(--accent…)` in a `.side` rule.
- `src/test/setup.ts`: add `localStorage.clear()` to the global `afterEach` (jsdom keeps localStorage for a whole test file; a toggle test that saves "minimized" would otherwise make later tests start minimized).
- `Layout.test.tsx`: names and hrefs still pass; every `findByText(`u (${role})`)` lookup (lines 123 and 175) changes to `findByText("u")` plus an assertion of the role word. Add: the toggle flips its name and `data-sidebar` and has no `aria-expanded`; labels stay in the DOM when minimized; a throwing `localStorage` (`vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw … })`) still renders expanded; the stored "minimized" is applied; the tooltip element appears on focus of a minimized link and Escape hides it (tooltip LOOK is by eye only: vitest runs with `css: false`).
- `AssetsPage.test.tsx`: line 48 `toHaveTextContent("+")` breaks (the button now holds an svg): assert the accessible name and `type="button"` only. Add: twisty collapses a branch, tree toggle (`aria-expanded`, body hidden), the filter keeps ancestors, no heading named "Assets" other than the `h1`.
- `AssetPage.test.tsx`: `.tile` / `.big` / `.muted` lookups pass if class names are kept.
- `App.test.tsx` line 84: passes (link still named "Assets").
- e2e: exactly one heading named "Assets" on /assets (`journey:13`, `discovery:62`, `w3a:39`, `headers:104`: hence the `p.tree-title`). `journey.spec.ts:63` needs exactly one list on /assets (kept: no `ul` in nav; no legend). `journey.spec.ts:64` clicks the "Selected: … (open page)" paragraph: keep that paragraph in the detail area (restyled) or change line 64 in the same batch. Six specs use `getByRole("navigation")` with strict mode: one `nav` only, and the user inside it. They assert `toContainText(`${username} (${role})`)` (`w3a:34`, `w3b:90`, `w3c:40`, `w3d:53`, `phase3:53`, `headers:93`): each changes to `toContainText(username)` and `toContainText(roleLabel(role))` on the user block (`page.getByRole("navigation").locator(".who")`, so a match elsewhere in the nav cannot pass it), with `roleLabel` in a new `frontend/e2e/roles.ts` (`admin`→Administrator, `operator`→Operator, `viewer`→Viewer). The e2e files are outside `tsconfig.json`; type-check them with `cd frontend && npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"`, which must print nothing (`@types/node` is not installed, so the 6 baseline errors about `node:fs`, `process` and the untyped `line` parameter are filtered; on main 2026-10-11 the filtered output is empty). `AuthProvider.refresh.test.tsx` renders its own `name (role)` text and does not use the Layout: unchanged. `w3b`/`phase3` use `.tile … .big`, `.dash-grid`, `.dash-grid-edit`, `.widget-preview .big`: kept. `DiscoveryPage.test`/`SourcePanel.test` query `complementary` (`SourcePanel`'s own `<aside>`); the shell uses `<div class="side">`, so it adds no complementary landmark.

## 6. Rollout

Each batch leaves the app working and all tests green. Unit tests per batch, the full `npm test` + `npm run build` + `scripts/e2e.sh` at the end of batches 2 (after 2b) and 4.

**B1. Token layer and base elements** (`app.css`, `app.css.test.ts`, the five empty `src/styles/pages-*.css`). Add `:root`, restyle the R/K element rules (`body`, `a`, `button`, fields, tables, `.muted/.error/.warning`), the frozen island, the new classes (`.chip-*`, `.st-*`, `.banner*`, `.notice`, `.empty`, `.page-head`, `.icon-btn`, button variants) unused yet. The X rules (old `nav` rules, `ul.tree*`, `.selected`, the `#root:has(.graph-page)` block) move into the layer UNCHANGED (with their test pin) and are replaced in B2a/B2b. By eye: every page still readable in the old top bar; a dashboard identical (compare screenshot). Tests: `app.css.test.ts`, `Layout.test.tsx`.

**B2a. The shell** (`Layout.tsx`, new `lib/sidebarState.ts` + test, `src/test/setup.ts` (localStorage clear), `e2e/roles.ts` + the six role-text e2e lines, `app.css` shell, sidebar, tooltip and Discovery sections). Remove `nav`, `nav .spacer`, `nav a[aria-current]` (and switch its test pin, section 5) and the old graph `#root` rules. By eye at 1440 and 1024 (and 1024×620): both sidebar states, tooltips on hover and Tab, Esc hides them, the rail scrolls on a short window, skip link, Discovery exactly one window tall (no page scrollbar at 1600×1000 and 1024×768), Billing scrolls inside main. Tests: `Layout.test`, `sidebarState.test`, `App.test`, `DiscoveryPage.test`, `app.css.test`.

**B2b. The asset tree column** (`AssetTree.tsx`, `AssetsPage.tsx` (tree column and the bare detail area of section 4), `AssetsPage.test.tsx`, `app.css` tree section; remove `ul.tree*` and `.selected`). By eye: tree column flush and sticky, both tree states, a 60-character name truncates, a notice keeps the gutter. Tests: `AssetsPage.test`, `App.test`, `app.css.test`; then the full suite and e2e.

**B3. Shared pieces** (`Modal.tsx`, `ConfirmDeleteDialog.tsx`, new `PageHeader.tsx`, `AuditFilterBar.tsx`, `AuditPager.tsx`, `CertificateNotice.tsx`, `RoleChangedNotice.tsx` (banner classes), `CostTile.tsx`, `EnergyTile.tsx`, `Figure.tsx`, `SourceForm`, `AssetForm`, `MappingForm`, `SchemaForm`, `ScopeForm` (button classes only), and the dashboard editor's dialogs (owner decision 6): `dashboard/WidgetEditor.tsx`, `dashboard/CreateDashboardDialog.tsx`, the unsaved-changes dialog in `dashboard/DashboardEditor.tsx` (that dialog only, not the grid)). Markup changes are class names and wrappers only, plus the Cancel-before-primary DOM reorder where no test pins the order (section 4 Dialogs). Tests: each component's own test file, `WidgetEditor.test`, `DashboardPage.edit.test`, `Layout.test` (the notices render in the shell).

**B4. Page polish**, in five groups with disjoint files, so **4a to 4e may run in parallel**, each in its own git worktree and branch (the plan says how). Page CSS goes ONLY into the group's own file `src/styles/pages-<group>.css`, inside its `@layer w6 { … }` block (never at the end of `app.css`, which is the unlayered frozen region):
- 4a Assets + Asset (`pages-assets.css`): `AssetsPage.tsx` detail area polish (section 4 "Assets detail area": no tiles), `AssetPage.tsx`, `MetricsTable.tsx`, `TrendChart.tsx` frame only, `RangePicker.tsx` (only `TrendChart` renders it). Tests: `AssetsPage.test`, `AssetPage.test`, `TrendChart.test`; e2e journey, w3a.
- 4b Sources + Source points + Scans + Discovery (`pages-sources.css`): `SourcesPage`, `SourcePointsPage`, `ScansPage`, `ScanProgress`, `JobStatus`, `DiscoveryPage` header, `graph/SourcePanel`, `graph/ReviewDialog`. Tests: their test files; e2e discovery, journey.
- 4c Billing + Tariffs (`pages-billing.css`): `BillingPage`, `TariffsPage`. Tests: `BillingPage.test`, `TariffsPage.test`; e2e phase3.
- 4d Users + Settings + Storage + Audit + Audit entry (`pages-admin.css`): `UsersPage`, `SettingsPage`, `StoragePage`, `AuditPage`, `AuditEntryPage`, `AuditEntryDetail`. Tests: their files; e2e w3c, w3d.
- 4e Login + Setup + Password + Not found + Dashboards list (`pages-auth.css`): `LoginPage`, `SetupPage`, `PasswordPage`, `NotFoundPage`, `DashboardsPage`. Tests: their files; e2e headers.
Crumbs: a crumb link never carries the name of a sidebar link (e2e clicks `getByRole("link", { name: "Assets" | "Sources" })` unscoped, e.g. `journey:16/39/44/61`); use plain text for such crumbs.
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
- **Short windows.** The minimized rail must scroll (`.nav-groups` `overflow-y: auto`) and Password, Sign out and the toggle stay reachable at 1024×620; the fixed tooltip follows its row and hides on scroll.
- **Exact-name e2e cells.** 21 e2e lookups use `getByRole("cell", { name, exact: true })`; the plan lists them per page task. A two-line or `th` cell there breaks e2e, which implementers cannot run.
- **Third-party CSS is unlayered** (React Flow, react-grid-layout): it beats every W6 rule for the properties it sets, and W6 rules still reach the properties it does not set (hence the React Flow controls rule in section 5).
