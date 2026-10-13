# W7i Acceptance Sweep and Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find what a user would find in W7e to W7h before the owner does (a real-browser sweep under bad conditions), fix it, clear the worth-doing parked leftovers, make the first load smaller and cacheable, polish the two diagnostic-script items, and hand the owner a click-through checklist.

**Architecture:** Front end (React 19, Vite 6, React Query) served by Caddy from the `web` image; diagnostics scripts in `scripts/` (PowerShell 5.1 and POSIX shell twins). No migration, no API change, no widget change. The sweep runs on a scratch Compose project `dcdash_e2e_w7i_*`; findings become tasks appended to this plan (Part A3).

**Tech Stack:** TypeScript/React, Vite, vitest (jsdom), Playwright (`frontend/e2e`), Caddy 2, PowerShell 5.1, bash/awk.

**Spec:** `.superpowers/sdd/overnight-w7/W7i-polish-sweep.md` (the brief, Parts A to E; read it in full) and `.superpowers/sdd/overnight-w7/W8c-field-polish.md` findings 10 and 11.

## Global Constraints

- Front end, `deploy/`, `scripts/` and docs only. **No migration, no API/backend change.** (A fix that truly needs one is tiny, fully tested, and then the FULL backend suite runs; otherwise it is parked.) Do not touch the dashboard widgets (`components/dashboard/**`, `TrendChart`, `widgetFormat`, the editor grid).
- No restyling and no new features beyond Part D. UI rules (`ui-design-rules.md`): simple and clean; no cream or off-white page background, italic accents, numbered "01/02" labels, monospace labels or pill buttons; tokens only inside `@layer w6`; raw colours only in `themes.css`; inline-SVG icons.
- Playwright matches names by case-insensitive SUBSTRING: audit every `getByLabel(` / `getByRole(` value in `frontend/e2e/*.ts` against any new heading, `aria-label` or `<label>`.
- Offline workstation: no CDN, no external fonts, no new network dependency. Security headers (`deploy/security-headers.caddy`) stay as they are.
- Scripts run on a workstation (RDP, Windows PowerShell 5.1, not elevated): PowerShell 5.1 compatible, **ASCII only**, never print a secret (no command lines, no environment), report format `DCDASH-DIAG v1` keeps its sections in the same order.
- Implementers run only: `npx vitest run <files>`, `npm run typecheck`, `npm run build`, `bash -n`, `uv run pytest <script-test files>`, git, grep, `powershell.exe` for the script tests, node scripts with `playwright-core` against the scratch stack for a LOOK. **Never** `docker`, `scripts/*`, `npx playwright test`, or anything on Compose project `dcdash` / volume `dcdash_dbdata`. The controller runs Docker and the isolated Playwright suite.
- One commit per task; `git add` named files only; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- A task needing more than about half a day of change is parked with numbers, not started.

## Review Focus

1. A stale hashed chunk (a tab opened before a deploy asks for `/assets/index-OLD.js`) must answer **404 without `immutable`**, never `index.html` with a year of cache; and the SPA routes `/assets` and `/assets/<id>` (the Assets Tree page and an asset's page, same URL prefix as the hashed files) must still return `index.html`.
2. `encode` must not touch `/api/*` (SSE `/api/stream` uses `flush_interval -1`); `index.html` and the un-hashed `theme-init.js` must revalidate (`no-cache`), or an update shows the old page.
3. Chunk splitting keeps the lazy chunks lazy (echarts, xyflow, DashboardEditor stay out of the entry), keeps the offline build working, and does not create a circular-chunk load error on first paint.
4. The scripts print nothing sensitive: a listening process is reported by **name only**; when the lookup is denied the line says so ("owner hidden") instead of failing the section.
5. Hostile input: an unknown stored icon id, a 200-character kind, Arabic and emoji names, a 2,000-asset tree, an API that is down (Caddy answers 502), an expired session.

## File map

| File | Change |
|---|---|
| `deploy/Caddyfile`, `deploy/Caddyfile.tls` (`:443` block) | compression and cache headers (Task 1) |
| `scripts/check_web.sh`, `frontend/e2e/headers.spec.ts` | assertions for Task 1 |
| `frontend/vite.config.ts` | `manualChunks` for react, router, query (Task 2) |
| `frontend/src/auth/AppearanceProvider.tsx` (+ test) | `storage` listener (Task 5) |
| `frontend/src/lib/kindIcon.ts` (+ test) | `transfer` matched only as a switch (Task 5) |
| `README.md` | end-to-end list (Task 3), Upgrading to W7i note (Task 6) |
| `scripts/collect-diagnostics.ps1`, `scripts/collect-diagnostics.sh`, `backend/tests/test_scripts_diagnostics*.py`, `docs/field-debugging.md`, `docs/field-debugging-examples/` | owner process per port, log-tail noise (Task 4) |
| `.superpowers/sdd/overnight-w7/CLICKTHROUGH.md` | Task 5 (controller, git-ignored) |
| sweep fixes | Tasks 7 onwards, appended after Part A |

---

### Task 1: Web server compression and cache headers (D1a)

**Files:** Modify `deploy/Caddyfile`, `deploy/Caddyfile.tls` (the `:443` block; the `:80` redirect block has no file server), `scripts/check_web.sh`, `frontend/e2e/headers.spec.ts`, `backend/tests/test_caddy_headers.py` (a pytest that parses both Caddyfiles, no Docker; read it first: its parser wants one directive per line, braces at the end of the line, no trailing `# comments`).

**Today (measured on the BEFORE stack):** no `encode` (the 784 kB entry travels raw, 245 kB gzipped), no `Cache-Control` anywhere, and `/assets/nope.js` answers 200 `index.html`.

**Design (Caddy 2; you cannot run Docker, the controller verifies with `curl` on a built image):** keep `handle /api/*` exactly as it is (NO `encode` there: `/api/stream` uses `flush_interval -1`), then, in the same order, in both files (TLS: the `:443` block only):

```
	@hashed path_regexp hashed ^/assets/[^/]+\.(js|css|woff2?|svg|png|jpe?g|webp|ico)$
	handle @hashed {
		root * /srv
		header Cache-Control "public, max-age=31536000, immutable"
		encode zstd gzip
		file_server
	}

	handle {
		root * /srv
		header Cache-Control "no-cache"
		encode zstd gzip
		try_files {path} /index.html
		file_server
	}
```
`@hashed` has NO `try_files`, so a missing hashed file is a real 404. It keys on the extension, so the SPA routes `/assets`, `/assets/` and `/assets/4` have no match and fall to the last `handle` (they must still return `index.html`). **Every `handle_errors` block in both files gets `header Cache-Control "no-store"`** (an immediate set that overwrites: a `header` inside a `handle` is applied before `file_server` runs and the 404 is served on the same response writer, so without this a stale chunk's 404 would carry `immutable`; it also stops anything caching the 502 page). `/favicon.ico` falls through to `index.html` (200) and stays so: do not "fix" it.

- [ ] Edit both Caddyfiles as above.
- [ ] `backend/tests/test_caddy_headers.py`: add tests (pytest only, `uv run pytest backend/tests/test_caddy_headers.py`): both files contain the same `@hashed` matcher line and the same two static handles; `encode` never appears inside the `handle /api/*` block; every `handle_errors` block sets `Cache-Control`.
- [ ] `scripts/check_web.sh` (POSIX `sh`, `set -eu`; use GET with `-o /dev/null -D -`, not `-I`): `/` has `cache-control: no-cache`; the entry script named in `/` (regex on `src="(/assets/index-[^"]+\.js)"`) has `immutable` and, with `Accept-Encoding: gzip`, a `content-encoding` of gzip or zstd; `/assets/nope.js` is 404 and its headers carry no `immutable`; `/assets` is 200 and `no-cache`; the 304 check: send `/`'s ETag back as `If-None-Match` with `Accept-Encoding: gzip` and expect 304 (do the same for the entry script). `/api/health` is under the encoder's 512-byte minimum, so it proves nothing about `encode`: keep only the existing checks for it.
- [ ] `frontend/e2e/headers.spec.ts`: one new test with the same expectations through Playwright's `request`.
- [ ] `bash -n scripts/check_web.sh`; e2e type-check: `cd frontend && npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"` must print nothing.
- [ ] Commit `feat(web): compress static files, cache hashed assets for a year, revalidate the shell, never cache an error (D1)`.

### Task 2: Smaller first load: vendor chunks and a lazy Discovery page (D1b)

**Files:** Modify `frontend/vite.config.ts`, `frontend/src/App.tsx` (the `DiscoveryPage` import and route), `frontend/src/AppChunk.test.tsx` (read it: the two existing cases hold a mocked lazy module behind a gate).

**Measured by the plan review (use these as the BEFORE numbers):** entry `index-*.js` 784 kB raw / 245.9 kB gzip, eager CSS 80.6 / 16.0 kB. The entry holds app code 236 kB, react-dom 210, react-router 96, query 42, and **@xyflow/react + d3 + zustand about 185 kB (plus 16 kB of xyflow CSS)** that only the Discovery page uses. The lazy echarts chunk is ALSO named `index-*.js` (1,054 / 350 kB).

- [ ] **Vendor chunks.** `build.rollupOptions.output.manualChunks(id)`: `"react"` for `node_modules/(react|react-dom|scheduler)/`, `"router"` for `node_modules/react-router`, `"query"` for `node_modules/@tanstack/`, and `"echarts"` for `node_modules/(echarts|zrender|tslib|size-sensor)/` (so the lazy chunk has a recognisable name; only lazy chunks import them). NOTHING else (no catch-all vendor rule). This alone saves 0 bytes on a first load; its value is that vendor chunks stay cached across app-code changes.
- [ ] **Lazy Discovery.** Make `DiscoveryPage` lazy exactly like `DashboardsPage` (`lazy(() => import("./pages/DiscoveryPage").then((m) => ({ default: m.DiscoveryPage })))`, wrapped in `<Suspense fallback={loading}>` inside its `RequireRole`). Add a case to `AppChunk.test.tsx` (mock module behind a gate, as the existing cases do). Expected: the eager JS falls to about 574 kB raw / 177.8 kB gzip and 64.7 kB of CSS; xyflow CSS moves into the Discovery chunk's own stylesheet (the cascade is safe: xyflow's sheet is unlayered, every app override is in `@layer w6` or higher-specificity in `themes.css`).
- [ ] Verify: `npm run build` and read the size table; `dist/index.html` has `modulepreload` links for react, router, query only, no xyflow, no `echarts`, no Discovery; the Discovery chunk is not among the entry's static `import{` heads; the only remaining chunk-size warning is the lazy `echarts` chunk (do NOT raise `chunkSizeWarningLimit`); `npx vitest run src/AppChunk.test.tsx src/App` and anything that reads `vite.config.ts`. Report before and after bytes (raw and gzip) in your report; expect the known first-visit fallback twitch (backlog Z) on Discovery too.
- [ ] Two commits: `perf(web): split react, router, query and echarts into their own chunks (D1)`, `perf(web): load the Discovery page (and xyflow) only when it is opened (D1)`.

### Task 3: A tab left open across an update (found by the plan review, I1)

**Files:** Modify `frontend/src/main.tsx`, create `frontend/src/components/RouteError.tsx` (+ `RouteError.test.tsx`) and `frontend/src/lib/chunkReload.ts` (+ `chunkReload.test.ts`).

**Problem:** there is no error boundary and no `errorElement`, so when an open tab needs a lazy chunk the new build no longer has (`DashboardsPage`, `DashboardEditor`, `TrendChart`, each widget type, now Discovery), React Router shows its developer page "Unexpected Application Error!". After Task 1 a stale chunk is a 404 (before, it was `index.html` as JS): both reject the `import()`.

- [ ] `lib/chunkReload.ts`: `installChunkReload(storage = sessionStorage, reload = () => location.reload(), now = Date.now)` registers `window.addEventListener("vite:preloadError", ...)` that reloads ONCE and records the time in `sessionStorage` (`dcdash.chunkReload`); if the recorded time is under 10 s old it does nothing (a really broken deploy must not loop). It must NOT call `event.preventDefault()` (a prevented event makes the import resolve to `undefined` and the app's `.then((m) => ({ default: m.X }))` throws a TypeError). Called once from `main.tsx`. Test (vitest): first event reloads and stores the time; a second within 10 s does not; one after 10 s does; storage that throws does not throw (reload once, no guard).
- [ ] `components/RouteError.tsx`: the router route's `errorElement`: a plain panel in the existing notice style (`banner banner-warn warning`, `role="alert"`): "This page could not be loaded. It may have been updated; reload to continue." with a Reload button (`location.reload()`); no stack trace, no developer text. Test: a lazy module mock that rejects renders this panel, not "Unexpected Application Error".
- [ ] Commit `fix(web): an open tab reloads once when an update removed a chunk it needs, and a plain panel replaces the developer error page`.

### Task 4a: Diagnostic scripts, owner of a listening port (Part C, W8c finding 10)

**Files:** Modify `scripts/collect-diagnostics.ps1` (section "LOCAL PORTS", line ~534), `scripts/collect-diagnostics.sh` (`section_local_ports`, line ~589), `backend/tests/test_scripts_diagnostics.py`, `backend/tests/test_scripts_diagnostics_sh.py`, `docs/field-debugging.md`, `docs/field-debugging-examples/` (only if a stored script output shows the section).

`scripts/collect-diagnostics.ps1` is 675 lines and `test_script_sticks_to_powershell_51_syntax_and_stays_small` caps it at 700: raise the cap to 740 in the same commit with a one-line reason in the test, do not compress unrelated code.

- [ ] **PowerShell.** Keep `GetActiveTcpListeners()` as the source of the three lines (80, 443, 8000) and of every address (CIM shows a dual-stack socket once, as `::`). Use CIM ONLY to map port to owner pid: `$j = Get-NetTCPConnection -State Listen -AsJob`, `Wait-Job $j -Timeout 5`; on a timeout `Stop-Job`, `Remove-Job -Force` and every owner reads `owner hidden (the lookup did not answer in 5 s)`; wrap the whole lookup in try/catch so a missing NetTCPIP module gives `owner hidden (the lookup was refused)` and never fails the section. Names from ONE `Get-Process` into a pid-to-name hashtable (not one call per row), name only (never command line, path or user). Line: `port 8000: something is listening on 127.0.0.1 (owner: node, pid 4120)`. Then a block `other listening ports (up to 40):` with rows de-duplicated by (port, pid), addresses joined: `  135  0.0.0.0, ::  svchost (pid 2564)`, sorted by port, then `... and N more`. Emit every line through `Add-Line` as the existing code does (it already scrubs and applies `-Mask`; do NOT call `Get-Masked` again; `0.0.0.0`, `::` and `127.x` stay as they are).
- [ ] **Shell.** `ss -ltnp` (fallback `netstat -ltnp`): take the `users:(("name",pid=N,...))` field(s): name and pid only, never `fd=`; no `users:` field (not root, another user's process) or `-` in netstat's column prints `owner hidden`. The existing awk splits address and port at the last colon, which handles `0.0.0.0:80`, `*:443`, `[::]:8000`, `[::ffff:127.0.0.1]:3010`, `127.0.0.53%lo:53`. Same `other listening ports` block (cap 40).
- [ ] **Tests.** Shell: a fake `ss` / `netstat` first on PATH (the harness already builds PATHs) with fixed output covering all the forms above, a row without `users:` and a row with two processes; assert name and pid, never `fd=`. PowerShell (real `powershell.exe` from WSL, memory `wsl-to-powershell-drill-env.md`: environment variables set in WSL do not reach it): run the script with `-NoProfile -Command "& { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); & '<script>' ...; $l.Stop() }"` and expect `powershell (pid <n>)` on that port; the fallback: define `function Get-NetTCPConnection { throw 'denied' }` before calling the script and expect `owner hidden`. `grep -nP '[^\x00-\x7F]'` on both scripts prints nothing.
- [ ] **Docs.** `docs/field-debugging.md`: describe the owner text and the new block; "the section list and order are unchanged: still DCDASH-DIAG v1"; under Docker Desktop the owner of 80/443 is a Docker process (`com.docker.backend`, `wslrelay` or `vpnkit`), not `caddy`; `System (pid 4)` is Windows' HTTP.sys (IIS, WinRM). Refresh the examples folder if a stored script output holds the old line.
- [ ] Commit `feat(scripts): name the owner of a listening port and list the other listeners`.

### Task 4b: Diagnostic scripts, log tail (Part C, W8c finding 11)

**Files:** the two scripts (the log section and the routine filter), the two test files, `docs/field-debugging.md`.

- [ ] Strip ANSI colour codes from the log text **before** the routine filter (`Test-Routine` in PowerShell, `FILTER_PROGRAM` in awk) as well as before scrubbing and clipping, so a colour-wrapped routine line is still recognised and the counts are right. Two forms: ESC `[` digits/semicolons `m`, and the bare form when the ESC byte was lost (`[0m`, `[37;1m`, `[0;32m`) with a regex that does NOT eat ordinary text such as `[5m]` (PowerShell `\[(?:\d{1,3}(?:;\d{1,3})*)?m(?!\])`; an equivalent ERE in awk, tested under the system awk, mawk and gawk as the existing fixtures are).
- [ ] Print one line per service block, only when that block's tail contains one of the two patterns: `known benign on a first start (Timescale image): "no usable system locales were found", "background worker ... trying to connect to template database, exiting"`.
- [ ] Tests: ANSI in both forms stripped (and `[5m]` kept); a colour-wrapped routine line is filtered; the note appears only when a pattern is present. PowerShell 5.1 compatible, ASCII only.
- [ ] Commit `feat(scripts): strip colour codes before the log filter and note first-boot noise`.

### Task 5: Parked leftovers worth doing (Part B)

**Files:** Modify `frontend/src/auth/AppearanceProvider.tsx` + `AppearanceProvider.test.tsx`, `frontend/src/lib/kindIcon.ts` + `kindIcon.test.ts`, `frontend/src/lib/sidebarState.ts` + its test, `README.md`.

Rulings (ledger): TAKEN: the `storage` listener, the README end-to-end list, `transfer` narrowed, the `matchMedia` try/catch (backlog AB). LEFT FOR THE OWNER: "Automatic by kind" (AA; a question in `CLICKTHROUGH.md`). PARKED with a reason: H6 (the two auth requests in parallel) and the unit test of a failing bootstrap (auth code; the D2 task covers the failure behaviour); the `/setup` empty frame (predates the wave); the catalogue gaps and the 16 px icon pairs (the owner's eye); the second static sign-in copy (decided after the D1 re-measure). ACCEPTED, not touched: skeleton table rows 42.6 px against 45 to 63 px, the 1024 px offsets of Storage and Sources, the blink band of chained skeletons, the first-visit twitch of the lazy fallback on Dashboards, Discovery and a dashboard (needs per-route fallbacks), a disabled primary button that reads as a quiet button (unless the sweep shows it confuses). DECIDED AFTER THE LARGE-TREE MEASUREMENT: the deep-tree indent.

- [ ] **Storage listener** (in `auth/AppearanceProvider.tsx`). Register once (`useEffect(..., [])`, read refs inside it). Ignore the event when `event.key !== MIRROR_KEY`, when `event.newValue === null` (another tab ran `localStorage.clear()`), when `JSON.parse` throws, **and while a local save is in flight or `wanted` differs from `confirmed`** (the mirror carries both keys: adopting another tab's stale view of the key this tab is saving would make the in-flight `flush()` send that stale key back and revert this tab's choice). Otherwise `normalizeAppearance(parsed)` and adopt through the existing `show(next)`, set `wanted = confirmed = next`, `setError(null)`. NEVER call `writeMirror`, no request. Tests: another tab's change applies to `<html>` and the profile dropdowns' state without `fetch`; an unrelated key, a null value, an unparsable value and an event during an in-flight save do nothing; removed on unmount.
- [ ] **`transfer`** (`lib/kindIcon.ts`). The matcher strips a final `s` after `words()`, so `Transfer Switches` yields `switches`/`switche`, never `switch`. Join adjacent tokens in `words()` the way `data` + `centre` is joined: `transfer` followed by `/^switch(?:es)?$/` becomes `transferswitch`, and put `transferswitch` (not `transfer`) in the `kindCircuit` set. Tests: `Transfer Switch`, `Automatic Transfer Switch`, `Static Transfer Switch`, `Transfer Switches` and `TransferSwitch` are circuit; `Fuel Transfer Pump` becomes generic and `Transfer Room` a room; `Transfer Switchgear` stays a panel.
- [ ] **`matchMedia`** (`lib/sidebarState.ts`, `initialSidebar()`): a `matchMedia` that throws must not break the app: wrap in try/catch and fall back to the stored choice. Test: a throwing `matchMedia` stub.
- [ ] **README.** Rewrite the end-to-end list ("Nine specs") from `frontend/e2e/playwright.config.ts` (the project order there is the truth: every spec file in `frontend/e2e/`).
- [ ] `npx vitest run src/auth/AppearanceProvider src/lib/kindIcon src/lib/sidebarState`; `npm run typecheck`; one commit per item (four commits).

### Task 6: "Can't reach the server" (D2; sweep finding F1, SECURITY-SENSITIVE: a per-task Opus read before it counts as done)

**Evidence (API stopped in the scratch stack, Caddy answers 502):** (a) a fresh load of ANY page shows the sign-in page with no message: the bootstrap's `/api/setup` fails, the `finally` clears `loading`, there is no user, `RequireAuth` redirects to `/login` (and remembers the path), and the console shows one error. (b) A page already open shows the bare red text `502 Bad Gateway` where its content was. (c) It recovers by itself about 5 s after the API returns. The user cannot tell "the server is down" from "my session ended".

**Files:** Modify `frontend/src/api/client.ts` (+ `client.test.ts`), `frontend/src/auth/AuthProvider.tsx` (+ `AuthProvider.test.tsx`), `frontend/src/auth/RequireAuth.tsx` (+ `RequireAuth.test.tsx`), `frontend/src/components/Layout.tsx` (mount the notice beside `RoleChangedNotice`); create `frontend/src/lib/serverReach.ts` (+ test), `frontend/src/components/ServerNotice.tsx` (+ test), `frontend/src/components/ServerUnreachable.tsx` (+ test), `frontend/e2e/w7i.spec.ts` (+ a `w7i` project in `playwright.config.ts` after `w7h`).

Rules:
1. `api/client.ts`: a `fetch` that rejects (network) throws `ApiError(0, "Can't reach the server. Check the network and try again.")` (today the raw `TypeError` escapes; `lib/diagnostics.ts` has its own `TypeError` handling and must keep working: read it and its tests); an ApiError of status 502, 503 or 504 describes as `The server is not answering (status N). It may be restarting; try again in a moment.` whatever its body. `export const isUnreachable = (e: unknown) => e instanceof ApiError && [0, 502, 503, 504].includes(e.status)`.
2. `lib/serverReach.ts`: a tiny store (`useSyncExternalStore`): `request()` reports every outcome; a result with `isUnreachable` counts a failure, any other completed response (any status below 500, and 500 itself: the server answered) resets it; **two consecutive failures** set `down`; one success clears it. `useServerDown(): boolean`. No timers of its own.
3. `ServerNotice` (banner, `role="status"`, classes `banner banner-warn warning` like `RoleChangedNotice`): `Can't reach the server. This page keeps trying and updates by itself when it is back.` and a `Retry now` button that calls `queryClient.refetchQueries({ type: "active" })`. Shown inside `Layout` only while `useServerDown()` is true.
4. `AuthProvider` bootstrap: a failure of `/api/setup` or `/api/me` for which `isUnreachable` is true sets a new `unreachable: true` (in the context, with `retryNow(): void`) and schedules a retry after 3 s, 6 s, 10 s, then every 15 s, until one succeeds (then `unreachable` clears and the normal path runs: setup needed, user, or 401 meaning signed out). `loading` becomes false after the first attempt as today. Every other outcome is unchanged: `/api/me` answering 401 is "signed out", never "unreachable"; a failure that is NOT `isUnreachable` behaves exactly as today. **An error never produces a signed-in user, and `unreachable` never redirects.** The retry timer is cleared on unmount and `retryNow` while a request is out starts no second one.
5. `RequireAuth`: when `unreachable` (after the `loading` branch, before `setupNeeded` and `!user`): `body = <ServerUnreachable />` , **no `<Navigate>`, no write of `RETURN_KEY`**, the URL stays. `ServerUnreachable` is a centred card in the sign-in card style (reuse its classes; no new colours): heading `Can't reach the server`, text `The server is not answering. It may be starting or restarting. This page tries again every few seconds.`, a `Retry now` button (`useAuth().retryNow`). `LoginPage` and `SetupPage` already print `error.message`, which now reads the friendly text when the API is down.
6. Tests: AuthProvider: setup needed; no session (401 on `/api/me` goes to sign-in); session ok; deactivated (401); a network error on `/api/setup` gives `unreachable`, no user, no redirect, and a later success signs in; 502 and 503 on `/api/me` give `unreachable`; unmount cancels the retry; `retryNow` starts one request. RequireAuth: unreachable renders the panel, not `Navigate`, and `sessionStorage` `RETURN_KEY` is untouched. serverReach: one failure is not down, two are, a 404 resets, a 500 resets. e2e `w7i.spec.ts`: (a) `page.route("**/api/me", r => r.fulfill({ status: 502 }))` on a deep link shows the panel at the same URL, and after `page.unroute` + `Retry now` the page loads; (b) with every `/api/**` except `/api/stream` answered 502 on a loaded page the notice appears, and disappears after `unroute`; (c) removing the session cookie and clicking a sidebar link still lands on the sign-in page.
7. Commit in two: `feat(web): say when the server cannot be reached instead of showing the sign-in page`, `test(e2e): w7i spec for an unreachable server`.

### Task 7: A long kind no longer pushes the page sideways (sweep finding F2)

**Evidence:** an asset whose kind is 200 characters without spaces (the API allows it; kinds are free text from the Add asset dialog) makes the document 997 px wider than a 1440 px window on `/assets` (the summary's "By kind" row: `.kind-list li` > `.kind-name`) and 861 px wider on `/assets/<id>` (the header's sub line, `.page-head .sub`, runs under the Edit and Add asset buttons and off screen). At 1024 px: 1203 and 1067 px. The tree row already ellipsizes the kind and is fine.

**Files:** Modify `frontend/src/styles/pages-assets.css` (`.kind-list`, `.kind-name`, `.kind-count`), `frontend/src/app.css` (`.page-head .sub`, inside `@layer w6`), `frontend/src/app.css.test.ts` (or the CSS test that pins rule text; read how the W7h rules are pinned), `frontend/e2e/w7i.spec.ts` (append one test; the file is created by Task 6).

- [ ] Rules: `.page-head .sub { min-width: 0; overflow-wrap: anywhere; }` (it sits in the `minmax(0, 1fr)` column, so it then wraps inside it, never under the actions); `.kind-list li { min-width: 0; }`, `.kind-name { min-width: 0; overflow-wrap: anywhere; }` with the icon `svg.i { flex: none; }` so the glyph keeps 16 px, and the `li` allowed to wrap its count below a long name (`flex-wrap: wrap` on the list item if it is flex, else leave). No restyling: a normal kind looks exactly as before (compare before and after screenshots of a normal kind at 1440).
- [ ] Test: a rule-text test for the new declarations (jsdom has no layout); e2e in `w7i.spec.ts`: create an asset through the API with a 200-character kind (`K`.repeat(200)) and a normal one, open `/assets` and `/assets/<id>` at 1440 and 1024, expect `document.documentElement.scrollWidth <= document.documentElement.clientWidth` and that the Edit button's box is not overlapped by the sub line text box (right edge of the `.sub` box <= left edge of `.actions`), then delete the asset through the API.
- [ ] Look: screenshots of both pages at 1440 for the 200-character kind (admin / `correct-horse` on the scratch stack http://127.0.0.1:18199, asset id 28 has the long kind): say what you saw.
- [ ] Commit `fix(web): a very long asset kind wraps instead of widening the page`.

### Task 8: Fixes from the Opus read of Task 6 (auth; report `.superpowers/sdd/2026-10-12-w7i-polish-sweep/task6-review-report.md`, read it: it has the exact fixes and the scratch tests)

**Files:** `frontend/src/pages/SetupPage.tsx` (+ create `SetupPage.test.tsx`), `frontend/src/components/ServerNotice.tsx` (+ test), `frontend/src/auth/AuthProvider.tsx` (+ `AuthProvider.test.tsx`), `frontend/e2e/w7i.spec.ts`.

- [ ] **I-1 (Important).** `/setup` redirects to `/login` while the server is unreachable (`SetupPage.tsx:15`; `setupNeeded` is still false), so a first install opened while the API starts ends on a sign-in form with no account. Fix: read `unreachable` from `useAuth()` and render `<ServerUnreachable />` before the redirect line (`if (!loading && unreachable) return <ServerUnreachable />;`), so `/setup` stays and shows "First-run setup" once a retry answers `needed: true`. Tests (`SetupPage.test.tsx`, scratch tests S1 and S4 in the report): unreachable keeps `/setup`; a later `needed: true` shows the form.
- [ ] **I-2 (Important).** After recovery the notice disappears but a page whose query failed (Users has no polling) keeps its error, though the notice promised it "updates by itself". In `ServerNotice`, when `down` goes from true to false, `queryClient.refetchQueries({ type: "active", predicate: (q) => q.state.status === "error" })` (code in the report). Test: a query in error, `noteReach(false)` twice, then `noteReach(true)`, assert the refetch.
- [ ] **M-1.** In `AuthProvider`'s `attempt()` replace `throw error` (an unhandled rejection from `void attempt()`) by `console.error(error); return;` (the `finally` still clears `loading`). Add tests: a 500, 403, 404 and 422 on `/api/setup` and on `/api/me`, at the first load and on a retry after an outage, each ending with `unreachable: false`, no user and `/login`.
- [ ] **M-2.** `if (!cancelled && !superseded) setUnreachable(false)` (line ~139).
- [ ] **M-3.** Two guard tests: (a) hold `/api/setup`, sign in, release it with `needed: true` or another user: the signed-in user stays and `setupNeeded` stays false; (b) hold the fetch, unmount, release a network failure: no timer is left armed.
- [ ] **M-4.** Validate the `/api/me` body before `replaceUser`: an object with a string `username` and a `role` that is a key of `ROLE_LEVEL`; anything else is treated as the non-unreachable error path (M-1's). Test: a 200 `text/html` body from `/api/me` leaves no user.
- [ ] **M-8.** `{ timeout: 20_000 }` on the expect at `w7i.spec.ts:54`.
- Not taken (rulings): M-5 (dev-only proxy 500), M-6 (Retry feedback), M-7 (503 detail), M-9 (live-region, same as `RoleChangedNotice`).
- [ ] Targeted tests (`npx vitest run src/auth src/pages/SetupPage src/components/ServerNotice src/lib/serverReach src/api`), `npm run typecheck`, the e2e type-check from Task 1, then two commits: `fix(web): /setup stays put while the server is unreachable, and a recovered server refetches pages that failed`, `test(web): pin the other bootstrap failures and the stale-result guards`.

### Task 11: Fix wave from the sweep (Important and cheap Minors of `findings-human.md`; read it, with `findings.md`)

Taken (one commit each, small and local, no restyling): E1, K1 (the cheap option), D1's edges, Minor 2, 8, 6, 5, 12, 3. Parked with a reason (backlog AC): B1 (Billing grid: sticky header and column, a scroll box height; the 732 kB payload is a 2,000-asset case and the API is not compressed because of the SSE stream), D1's fitView, Minor 1 (one focus rule: an accessibility session), 4 (a styled confirm dialog: a feature), 7 (deep-tree indent: measured, no cheap rule), 9, 10, 11, 13, K1's proper roving-tabindex tree.

**Files:** as each item says. Read each file before editing; match the neighbouring tests; audit `frontend/e2e/*.ts` for names that a new link, title or label would collide with (Playwright matches names by case-insensitive SUBSTRING: a new link named "Skip the tree" collides with any `getByRole("link", { name: /skip/i })`).

- [ ] **E1.** `components/AssetForm.tsx` (~line 84): the icon grid's `onKeyDown`: Escape closes the grid, stops propagation (so the dialog stays open and the typed name stays) and returns focus to the "Change icon" button. A second Escape (grid closed) still closes the dialog. Test in `AssetForm.test.tsx` (keyboard: type a name, open the grid, Escape: dialog still there, name kept, focus on Change icon; Escape again: dialog closes).
- [ ] **K1.** With thousands of assets a keyboard user passes thousands of tree stops before the page's own controls. Add, as the first focusable element INSIDE the tree column, a link `Skip the tree` styled like the existing "Skip to content" link (find it in `Layout.tsx` and `app.css`: visible only on focus, tokens only), whose activation moves focus to the asset detail pane (give the pane `id="asset-detail"` and `tabIndex={-1}`; use a click/Enter handler that calls `.focus()`, not only `href="#..."`, because the router owns the hash). Test: the link is the first tab stop in the tree column and activating it focuses the pane; an e2e case appended to `frontend/e2e/w7i.spec.ts` (focus the link with Tab from the sidebar, press Enter, `document.activeElement.id === "asset-detail"`). Audit the e2e for `skip` collisions.
- [ ] **D1 edges.** `pages/DiscoveryPage.tsx` (the `ReactFlow` element): `edgesFocusable={false}` so the graph's edges are not Tab stops with no visible ring; nodes stay focusable. If a unit test can assert the prop through the existing mocks, add it; otherwise say so in the report.
- [ ] **Minor 2.** The sign-in and first-run setup errors show the API's lowercase text ("invalid username or password"): show it with a capital first letter (display only, in `LoginPage.tsx` and `SetupPage.tsx`; do not change `ApiError`). Tests.
- [ ] **Minor 8.** `document.title` per route in `Layout.tsx` (a small map by path prefix: `/assets` Assets Tree, `/dashboards` Dashboards, `/billing` Billing, `/sources` Sources, `/scans` Scans, `/discovery` Discovery, `/users` Users, `/settings` Settings, `/tariffs` Tariffs, `/storage` Storage, `/audit` Audit log, `/diagnostics` Diagnostics, `/password` Change password; unknown: `DC Dashboard`), as `"<Page> · DC Dashboard"`, set in an effect on the pathname. Tests; check no e2e or unit test pins the old title.
- [ ] **Minor 6.** `AssetPicker.tsx` (~line 94): "0 of 20 selected" reads as if there were 20 assets: change to `0 selected (up to 20)` and update the tests that pin the text.
- [ ] **Minor 5.** `pages/SettingsPage.tsx`: the two Save buttons (General filled, Sign-in protection quiet) get the same style (the filled `primary` one, as the other pages' main save button). Tests if they pin classes.
- [ ] **Minor 12.** At 1024 px the four summary tiles of the Assets Tree summary wrap 3 + 1 ("Cost today" alone). Make them 2 + 2 below the width where four fit (CSS only, in `styles/pages-assets.css`, tokens only; look at 1440, 1024 and 800 before and after with `playwright-core`, say what you saw). Pin the rule text in `app.css.test.ts` if that is how its neighbours are pinned.
- [ ] **Minor 3.** Right-to-left names in a tree row are cut from the start (asset 25, Arabic, on the scratch stack http://127.0.0.1:18199 shows the END of the name): put `dir="auto"` on the tree row's name element (the one with the ellipsis) so the ellipsis falls on the logical end. LOOK: start a Vite dev server for the rehearsal (`cd frontend && VITE_API_TARGET=http://127.0.0.1:18199 npx vite --port 5197 &`), screenshot the tree rows for assets 25 and 26 before and after, then STOP the server; say what you saw. If `dir="auto"` makes a normal (left-to-right) name look different, drop it and say so.
- [ ] Targeted tests for every file you touched; at the end the full `npx vitest run` once, `npm run typecheck`, `npm run build`, the e2e type-check from Task 1.

### Task 9: Owner click-through checklist (Part E) — controller

`.superpowers/sdd/overnight-w7/CLICKTHROUGH.md`, at most 40 lines, plain language, numbered. Update steps first: `.\scripts\backup.ps1`, `git pull`, `docker compose up -d --build` (the laptop uses its own `compose.override.yaml`; confirm how `scripts/setup.ps1` invokes compose before writing the line), then `docker compose exec api alembic current` must print `0008 (head)` (the api container runs `alembic upgrade head` on start: compose.yaml line 47). Add one line: "Press Ctrl+F5 once if the page looks broken right after the update (the old `index.html` was cached without a rule)." Then per wave (W7e theme colours, the two dropdowns, the loading bar, icons; W7f skeletons: dev tools, Network, Slow 3G, reload; W7g icon preview and picker, Assets Tree; W7h a refresh shows the frame; W7i what changed), each item with what "right" looks like and what to report. Plus one question: Automatic icon by kind (Battery/CRAC/Fan/Pump/Sensor)? Copied into the MORNING section.

### Task 10: Docs close-out — controller, AFTER every other task

Backlog section AC, roadmap status, README "Upgrading to W7i (no migration)" (what changes at the web server: the first visit after the update downloads once, later visits are cached; the Ctrl+F5 hint), manual-test-notes, plan execution log and ticked boxes; memory bullet.

---

## Part A: the acceptance sweep (controller + ONE Opus reviewer; findings are appended below as Tasks 7+)

Method (fit to time and budget; the sweep is the stand-in for the owner's click-through):

1. **Order (plan review I6).** Implementers for Tasks 1 to 6 run one at a time in the background while the controller sweeps the BEFORE stack (`dcdash_e2e_w7i_vis`, untouched by their edits: it was built from main). The vis stack is rebuilt ONCE from the branch after the tasks land, for D1 "after", the gates and the final screenshots. The scripted metrics cover every view (done: 228 views, 0 mechanical findings); the Opus reviewer looks at every route in one look plus all eight looks on four representative pages, and at every view the metrics flagged, time-boxed to about 75 minutes. Minors are only fixed until the fix wave starts (about T+2.5 h); the rest are parked with a reason.
2. **Stacks.** `dcdash_e2e_w7i_vis` (ports 18199/18553, built from `main` 65d9fab = the BEFORE build, seeded by the whole Playwright suite) for coverage, conditions and the large tree; `dcdash_e2e_w7i_empty` (ports 18200/18554, same images, no seed) for the empty install. Every container action (stop `api`, restart, `psql` for the unknown icon id) is done by the controller through `dc` from `drill-lib.sh`.
3. **A1 coverage, scripted.** One Playwright-core script walks every route as `admin` across the 4 themes x light/dark x 1920/1440/1024 and records per view: horizontal overflow, console errors, failed requests, unlabelled controls, clipped text (scrollWidth over clientWidth on headings and buttons), and a screenshot sheet. The Opus reviewer judges the sheets and does the human pass: keyboard-only paths (sign-in, Assets Tree select/expand all/collapse all/filter, Add asset with each icon choice, Edit, Delete, the profile panel's two dropdowns, quick find, Dashboards create/edit/add one widget of each type, Billing, Users, Sources and a source's points, Scans, Tariffs, Storage, Audit and an entry, Diagnostics, Settings, sign out and in again so the theme comes back, a second browser profile, and the name "Assets Tree" everywhere the page is named).
4. **A2 conditions, scripted by the controller.** (1) CDP Slow 3G reloads of ten pages: skeleton, top bar, first-load shell. (2) `api` stopped (Caddy answers 502; also CDP offline, a different path): every page, then `api` started: no blank page, no endless skeleton, no console storm, a clear message, recovery without manual reload; whether a 502 on `/api/me` drops the user to sign-in (D2 trigger; a fix touches `AuthProvider`: its own task with a per-task Opus read). (3) Session cookie removed mid-use, then an action. (4) Empty install through the setup flow, first asset, first source, the empty state of every page. (5) Hostile data: long names, Arabic and emoji names, a 200-character kind, an asset whose stored icon id is unknown (set by `psql` in the scratch DB; the API would reject it). (6) A **2,000-asset tree** seeded **through the API** (a few levels deep); numbers for first render, scroll, filter typing, collapse all, expand all, quick find, the dashboard asset picker. Cheap wins are fixed; anything needing virtualization is parked with the numbers.
5. **A3 output.** `.superpowers/sdd/2026-10-12-w7i-polish-sweep/findings.md`, ranked Critical, Important, Minor, each with page, look, steps and screenshot. Every Critical and Important and every Minor under about 30 lines becomes a task below (one fix wave); the rest go to backlog section AC with a one-line reason.
6. **D2 (taken: Task 6).** Only if the sweep shows a bare error or blank page with the API down: ONE small global notice with Retry in the style of `RoleChangedNotice` / `CertificateNotice`. If the app already behaves well, say so and do nothing.
7. **Before and after.** Cold Fast-3G and **warm second-load** timings, bytes per chunk and gzip, response headers via `curl -I`, on the BEFORE stack and on a build of the final commit. The AB item (a refresh of `/login` is about 4 s white on cold Fast 3G with 4x CPU) is re-measured after Task 1; the second static copy is built only if it is still bad, otherwise parked with the numbers.

## Execution log

(filled in by the controller)
