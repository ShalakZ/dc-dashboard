# w38: the shapes page reads the SAME tag text from every address form

Wave w38, tier **M** (Ruling in the ledger), branch `wave/w38` from main 65949a7. Brief: `.waves/w38.md` (R1 to R9 are its rulings; this plan refines them). Migration: none (0019 stays free). Permission: none. API: none (every answer keeps its fields).
Scratch stack: vis `dcdash_e2e_w38_vis` ports **18266/18620** (both free in `ss -ltn` and in no other `.waves/w*.md`); look stack 18267/18621 only if the review wants one.

## Goal
A tag that the server shows as `ns=3;s=20403:QatarMV2.PDUA01_PM0_P` (numbered), `ns=3;s=QatarMV2.PDUA01_PM0_P` (stable) or with a DisplayName of any kind (`QatarMV2.PDUA01_PM0_P`, `PM0_P`, `Active power`) gets ONE text, `PDUA01_PM0_P`, so one shape and one asset name (`PDUA01`) on the shapes page, in the Review and in Discovery's count.

## Facts checked in the code (main 65949a7)
- `member_text(address, name)` is `shapes/core.py:96-104`. Callers, all with `(address, name)`: `core.py:162` (`build_shapes`), `api/shapes.py:102,126`, `api/discovery.py:249` (`_count_ruled`), `shapes/lines.py:328` (`parts_needed`), `lines.py:421`, `lines.py:488` (`build_lines`). No other code reads a member's `.name` to make a text (grep `\.name` over `shapes/` and `api/shapes.py`: only `_example` and the Find needle). The signature stays.
- Today: numbered id gives `tag_name(address)`; otherwise the NAME when it differs from the address; only a name equal to the address is parsed with `_STABLE_FORM`. A numbered id and the stable form agree whenever the cluster has no dot; they differ only for `ns=3;s=1:Site.` (numbered: `Site.` from `tag_name`, no stable match): so the numbered test stays FIRST.
- With "Stable tag addresses" on, the browse stores the stable address but a missing DisplayName falls back to the RAW numbered id (`opcua_browse.py:58`), so that point's text today is the whole `ns=3;s=20403:Site.X01_P`. The new rule fixes this too (the name is no longer read for a stable-form id).
- The asset preview of a row is computed in the browser: `ShapeRow.tsx:37` -> `derivedAsset` -> `exampleText` (`frontend/src/lib/shapes.ts:75-78`, a copy of today's rule). `namePartsWarning` (`shapes.ts:238`) also prints `exampleText(example)`; changing `exampleText` fixes both. `exampleText` has no other importer (grep over `src` and `e2e`).
- `_STABLE_FORM` = `(?:ns=[0-9]+;)?s=[^.\s]*\.(\S+)`, `fullmatch`. The JS twin uses `^...$` without the `m` flag (equal to `fullmatch`; JS `$` does not match before a final newline without `m`... it matches only at the very end, and `\S+` cannot take a newline anyway).
- The brief says the doc sentence is at `docs/mapping-large-sources.md:21`: it is at **line 19** (the bullet "The text is the tag name the server gave."). Backlog numbering: the last heading is `## BV` (w37), so this wave takes **BW**; roadmap **O-68** (O-67 is the newest row). CHANGELOG is 67,196 bytes (limit 80,000).
- Known regex difference between the two languages (LESSONS A12): Python `\s` also takes U+001C to U+001F and U+0085, JS `\s` also takes U+FEFF; both take U+00A0. The shared fixture pins U+00A0 and a plain space; the other three are parked in BW (no real id holds them).

## Decisions
- R1/R2 as the brief says. Rule: numbered -> `tag_name`; else `_STABLE_FORM.fullmatch` group 1 whatever the name; else the name. Cluster = FIRST dot segment only.
- R3 not gated on the source's option; R5 `_STABLE_FORM` stays in `shapes/core.py`; R6 saved rules are shown and kept, never remapped; R7 byte-identity; R8 gates; R9 reviews. All as in the brief.
- R4 stands: `exampleText` mirrors the rule; ONE shared fixture `backend/tests/fixtures/tag_texts.json` (`[{address, name, text}]`), written from the Python function and read by both suites.
- Parallelism: T2 (front end) and T3 (backend tests) touch disjoint files and run together after T1, with path-limited commits.

## Existing tests that will change (A1 grep, done)
- `backend/tests/test_shapes.py:35-37` test name (false for stable ids after R1); its cases stay true. New cases join.
- Must pass unchanged (checked by reading): `test_shapes.py:52-57`, `test_api_shapes.py:138-153` (twin), `test_shapes_lines.py:510,740`, `test_api_discovery.py:923-972` (`rules_new` pins, all 0). Their stable-form members have names equal to the tag or to the id, so the text is the same under the new rule.
- `frontend/src/lib/shapes.test.ts:33-39` (`derivedAsset`) and `42-45` (`exampleText`) keep passing; a fixture loop joins.
- `frontend/src/test/shapesFixtures.ts`, `ShapeRow.test.tsx`, `SourceShapesPage.test.tsx`, `ReviewShapesDialog.test.tsx`: node ids are numbered with names equal to the tags, or opaque (`a2`): unchanged text. The `Solo`/`a` example (no dot): unchanged.
- `frontend/e2e/w36.spec.ts:396` pins `Asset: PDUA01` on the numbered simulator: must still pass.
- `docs/mapping-large-sources.md:19` (the sentence); `docs/screens.md` has no sentence about the text. No test reads that paragraph; `test_docs_links.py` runs after the edit.
- Numeric pins: none (`29 shapes`, `15,000`, `1,001` are built from numbered ids with names equal to tags).

## LESSONS B checklists that apply
- A ported matcher gets a shared sample file read by both suites (`kind_samples.json` pattern): T1 and T2.
- Regexes differ between languages (A12, back end pack 6): NBSP case in the fixture.
- No new permission, table, migration, popover or CSS: those checklists do not apply.

## File map
- `backend/dcdash/shapes/core.py` (T1: `member_text`, docstrings).
- `backend/tests/test_shapes_text_identity.py` (T0, new) and the route-level hash test in `backend/tests/test_api_shapes.py` (T0).
- `backend/tests/fixtures/tag_texts.json` (T1, new); `backend/tests/test_shapes.py`, `test_shapes_lines.py` (T1).
- `frontend/src/lib/shapes.ts`, `frontend/src/lib/shapes.test.ts` (T2).
- `backend/tests/test_api_shapes.py`, `test_api_discovery.py` (T3).
- `docs/mapping-large-sources.md`, `CHANGELOG.md`, `docs/superpowers/backlog.md`, the roadmap, this plan (T4).
- Nothing under `core/`, `figures/`, `ingest/`, `collector/` or `connectors/` (proved with `git diff --stat main...HEAD -- <those>` printing nothing).

## Tasks (one commit each, `git add` named files only)
- [ ] **T0 Byte-identity (R7), on main's code, before any code change.** `test_shapes_text_identity.py`: sha256 of `json.dumps(obj, sort_keys=True)` for `[shape_json(s) for s in shapes]` + `[m.address for m in other]` of `build_shapes` over: `scada_members(200, 4190)`; the `plain()` sets of `test_shapes.py`; a non-OPC-UA set (Modbus `40001`.. with names, HTTP paths, file tags `PDU-A01.kWh`, numeric `ns=2;i=9` ids, `NS=3;S=Site.X`, `nsu=`, `ns=3;s=NoDotHere`, `ns=3;s=Site. spaced`); and the numbered set with friendly names. In `test_api_shapes.py`: the same hash over the route's answer for `small_source` and `scada_rows(...)` (answer minus `source_id` and `assets`). No set may hold a dotted stable-form id whose name differs from its tag (that changes on purpose). Hashes are computed by running the code on main, pasted as constants; the commit message says so.
- [ ] **T1 The rule and its tests.** `member_text` + docstring + module docstring line; the fixture; `test_shapes.py` (rename the test at 35; same tag, same text and shape in three forms and four DisplayName kinds; both grammars; the fixture loop incl. NBSP); `test_shapes_lines.py` (stable-form source with cluster-carrying DisplayNames: Review samples show `PDUA01` as part 1, no blocking check; two clusters with the same tag in the stable form block through `apart`). T0's hashes must still hold.
- [ ] **T2 The browser's copy (R4).** `exampleText` + doc comment; `shapes.test.ts` loop over `tag_texts.json` (`readFileSync("../backend/tests/fixtures/tag_texts.json")`, as `kindSamples.test.ts`), existing cases kept. Nothing else in `frontend/`. Then the per-task Opus review of T1 and T2 together (R9).
- [ ] **T3 Saved rules (R6) and the count.** `test_api_shapes.py`: a `stable_addresses: true` source whose DisplayNames carry the cluster; a saved rule under the OLD key and one under the new key; GET shapes: only the new shape carries a rule, no new field; `GET /shape-rules` lists both; a PUT of the merged set keeps the orphan (the cap is already pinned by the `range(301)` case of `test_a_bad_rule_body_is_a_422_and_stores_nothing` and by `test_exactly_300_rules_are_accepted`: cite, add none; `test_the_shapes_answer_carries_the_saved_rule_of_each_key_or_null` already pins that a rule of a shape the source no longer has is not shown). `test_api_discovery.py` (1,001 points): `large.rules_new` counts only the new key's points.
- [ ] **T4 Docs and close-out.** `docs/mapping-large-sources.md:19`; `test_docs_links.py`; CHANGELOG (about 900 bytes); backlog BW; roadmap O-68; this plan's log; gallery (look at the shapes page at 1440 and 1024 on the vis stack).

## Gates (R8)
Targeted backend: `test_shapes.py test_shapes_lines.py test_api_shapes.py test_api_discovery.py test_discovery_logic.py test_docs_links.py test_shapes_text_identity.py`. Front end: `npx vitest run src/lib/shapes.test.ts`, then `npm test` and `npm run build` under `flock /tmp/dcdash-heavy.lock`, `npm run typecheck`, the e2e type check. `frontend/e2e/w36.spec.ts` on a vis stack built from the FINAL tree (`vis-single-up.sh`, `spec-run.sh`, `drill-lib.sh` copied from `.waves/w37/`), judged by `N passed, 0 failed`. No full backend suite and no full Playwright chain (brief R8; `exampleText` is imported only by the shapes page).

## Review focus
1. Every caller still gets the same text for the same member (`parts_needed` and `build_lines` derive from the text `build_shapes` grouped by).
2. Nothing changes for any address that is neither numbered nor a stable-form string id (R7 hashes); the numbered form is untouched.
3. `exampleText` and `member_text` agree on every row of `tag_texts.json`.
4. No saved rule is removed or rewritten; the orphan's fate is pinned by a test.
5. The diff touches nothing under `core/`, `figures/`, `ingest/`, `collector/`, `connectors/`.

## Execution log
(filled in as tasks finish)
