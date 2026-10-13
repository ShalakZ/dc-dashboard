# W9c: the Roles editor offers to tick what a permission needs, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Roles editor, ticking a permission whose needed permissions are not ticked opens a small popover at that checkbox that offers to tick them right there; unticking a permission that other ticked ones need offers to untick those too. The `?` help bubble stops being clipped by the permission grid (Task 0).

**Architecture:** Front end only. `PERMISSION_NEEDS` (already in `frontend/src/lib/roleEditor.ts`, drives the inline hint) stays the single table; new pure helpers there turn "this checkbox was just toggled" into an offer and into plain words. A new `DependencyPrompt` component draws the offer as a non-modal card with `position: fixed`, placed by the `placeTip` of Task 0, sitting in the DOM right after the checkbox's label so Tab order and the Modal's focus trap just work. `RoleEditor` holds ONE `offer` state; every offer comes from a click or key on a checkbox, never from loading, Start from or Duplicate.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library (`userEvent`), Playwright (`frontend/e2e`), CSS in `@layer w6` with tokens only.

**Spec:** `.superpowers/sdd/overnight-w7/W9c-role-dependencies.md` (the owner's request and rulings D1 to D6), with the data in `docs/superpowers/plans/2026-10-13-w9b-roles-ui.md` section "Permission audit".

## Global Constraints
- Front end only: no migration, no backend, no API change; `git diff main --stat -- backend` is empty at the end. Do not touch the widgets.
- UI rules (`ui-design-rules`): simple and clean; no cream or off-white background, italic accents, numbered labels, monospace labels or pill buttons; tokens only inside `@layer w6`; inline-SVG icons; readable in light and dark and all four presets (eight looks).
- Playwright matches names by case-insensitive SUBSTRING: every new `role`, `aria-label`, heading and button text is audited against `getByLabel(`/`getByRole(` values in `frontend/e2e/*.ts` (Task 4).
- Implementers run only: `cd frontend && npx vitest run <files>`, `npm run typecheck`, `npm run build`, the e2e type-check `cd frontend && npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck e2e/*.ts 2>&1 | grep -v -E "TS2307|TS2580|TS7006"` (must print nothing), `bash -n`, git, grep, and node scripts using `playwright-core` against a scratch stack or a Vite dev server for a LOOK. Never `docker`, `scripts/*` or `npx playwright test`.
- One commit per task, `git add` named files only, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Words the owner sees come from the catalogue labels as the grid shows them ("See users"), never ids.

## Review Focus
1. The popover is never clipped, never causes a scroll bar, never covers the checkbox it is about; readable at 1024 and 1440 in light, dark and two presets. (Task 2 CSS test; Task 4 e2e geometry; whole-wave browser review.)
2. Keyboard and screen reader: the popover is a named group (its sentence), focus lands on the primary button, Tab/Shift+Tab are sensible, Escape closes only it, focus returns to the checkbox, the editor's existing keyboard tests still pass. (Task 2 and 3 tests, Task 4 e2e.)
3. The table is true: every "needs" matches the real page requirement. (Task 1 tests against `PAGE_NEED`; the whole-wave review ticks each in isolation on the scratch build.)
4. No prompt storms: Start from, Duplicate, opening a role and the server's data never prompt; five quick ticks leave at most one popover. (Task 3 tests.)
5. Saving is unchanged (exactly the ticked ids) and a dismissed prompt loses nothing. (Task 3 and 4 tests.)

## Rulings taken while planning
- **R1 The prompt renders INLINE with `position: fixed`, not as a portal on `document.body`.** Why: `Modal` keeps the focus inside its dialog (`keepFocus` pulls any focus that lands outside back to the first field) and wraps Tab over the dialog's own controls, so a body portal could never keep the focus we move onto its button, and it would sit at the far end of the tab order. Inline after the label it is inside the dialog, directly after its checkbox in Tab order, and `position: fixed` is not clipped by the `.table-wrap` / `.role-editor-body` scrolling boxes (Task 0's bug was `position: absolute`). It still uses Task 0's `placeTip`. Cost if wrong: a future `transform` or `filter` on a dialog ancestor would make `fixed` relative to it; the CSS test and the e2e geometry check pin this.
- **R2 It follows its checkbox on scroll and resize instead of closing** (the tip closes). Why: a prompt that vanishes when the mouse wheel moves is a lost offer, and the late scroll event after a keyboard focus (the reason `usePopover` has a settle window) cannot hurt a popover that just repositions. Cost: it can float over the dialog's heading or the Save row if its checkbox is scrolled out of `.role-editor-body` (plan review M-9); the next click closes it. Parked in the backlog, not fixed.
- **R3 `role="group"` named by its sentence (`aria-labelledby`), not `role="dialog"`.** Why: the focus moves into it, so a screen reader announces the group name; a second `dialog` inside the modal would break every `getByRole("dialog")` count in the e2e suite. Cost if wrong: a reviewer may prefer `alertdialog`; one attribute.
- **R4 D3 (the untick offer) is kept.** Same component, same rules, about 25 extra lines in the helper and one more branch in the editor. The decline word for it is "Leave ticked" ("Keep" alone does not say what is kept).
- **R5 The sentence is the hint's own:** "Change users also needs See users to show anything." (one shared builder, `needSentence`), so the hint and the popover can never disagree. With several needs the popover says "... also needs these to show anything:" and lists them. Cost if wrong: wording tweak in one function.
- **R6 Leaving counts as "Not now":** a press outside and focus moving outside (Tab past the buttons, clicking a field) decline the offer; Escape and the Not now button hand the focus back to the checkbox. A focus that moves outside is left where the user put it. An outside PRESS only refocuses the checkbox when the focus was still inside the card (so it never falls to `<body>`; the browser's own mousedown then moves it to whatever was pressed).
- **R7 The table is closed under "needs"** (if A needs B and B needs C, A lists C too; true today) and a test pins it, so one level of lookup is exact and "Also tick" can never leave a new gap. Cost if wrong: a future table edit fails the test, which says what to add.

- **R8 The card has an "arming delay": for its first 400 ms it ignores the pointer (CSS `pointer-events: none`, a keyframe `from` frame held with `animation-fill-mode: backwards`), so a click aimed at the next checkbox goes through to it.** Why (plan review I-3, measured in Chromium): the card's buttons sit exactly over the next checkboxes of the same column, and ticking down a column is the normal way to fill the grid; a click 300 ms after the first tick would otherwise hit "Also tick N permissions" or "Also untick N permissions". With the delay the click lands on the checkbox the user aimed at, which declines the offer (R6) and ticks that box. No JS timer, so the jsdom tests are unaffected; the keyboard is unaffected. Cost if wrong: a deliberate click on a button within 400 ms goes to the box beneath (the card closes, nothing is lost); under reduced motion the app's global rule may remove the delay (then no protection, still correct).
- **R9 A press on the card's own text or padding keeps the card open and the focus where it is** (`onMouseDown` on the card calls `preventDefault()` unless the target is a button). Why (review I-2): without it Chromium moves the focus to the nearest focusable ancestor, the Modal's `.dialog` (`tabIndex=-1`), which is "outside the card" and declines the offer. It also stops text selection in the sentence; harmless.
- **R10 A new offer remounts the card** (`key` = a counter bumped by every toggle that sets an offer). Why (review I-1): two offers in a row on the same checkbox (a keyboard tick, then a keyboard untick) would otherwise reuse the old card: no refocus, no re-measure, new words under an old position.
- **R11 `aria-describedby` points at the list** when there is one (review M-7), so a screen reader that lands on "Also tick 3 permissions" hears the three names.

## File map
- Task 0: the six files of commit `34c4d61` (`components/InfoTip.tsx` + test, `lib/placeTip.ts` + test, `app.css` + `app.css.test.ts`).
- Task 1: `frontend/src/lib/roleEditor.ts` (+ `roleEditor.test.ts`).
- Task 2: create `frontend/src/components/DependencyPrompt.tsx` (+ `.test.tsx`), `frontend/src/styles/role-prompt.css` (+ `.css.test.ts`); modify `frontend/src/main.tsx` (one import line).
- Task 3: `frontend/src/components/RoleEditor.tsx` (+ `RoleEditor.test.tsx`).
- Task 4: create `frontend/e2e/w9c.spec.ts`; modify `frontend/e2e/playwright.config.ts`, `README.md`, `docs/superpowers/backlog.md`, `docs/superpowers/plans/2026-10-11-w7-owner-feedback-roadmap.md`, this plan's boxes and execution log.

---

### Task 0: carry the help-bubble fix

**Files:** the six files of `34c4d61` (above). **Produces:** `placeTip(trigger: Box, bubble: {width,height}, viewport: {width,height}, gap = 6): TipPlacement` in `frontend/src/lib/placeTip.ts` (`{ top, left, placement: "below" | "above" }`, window coordinates), used by Task 2.

- [ ] **Step 1:** `git cherry-pick 34c4d61` (from branch `fix-infotip-overflow`). Resolve a conflict if W7k touched the neighbouring tip rules or `InfoTip` (W7k merged first; expect none).
- [ ] **Step 2:** `cd frontend && npx vitest run src/lib/placeTip.test.ts src/components/InfoTip.test.tsx src/app.css.test.ts src/components/RoleEditor.test.tsx src/components/PageCard.test.tsx src/pages/TariffsPage.test.tsx src/pages/StoragePage.test.tsx` all green; `npm run typecheck`.
- [ ] **Step 3 (controller, look once):** on the scratch build, a `?` near the right edge of the Roles grid at 1024 and 1440: fully visible, grid shows no sideways scroll bar. (Done together with the scratch stack of Task 4; tick this step then.)
- [ ] **Step 4:** `git worktree remove /home/ziad/Projects/DC_Dashboard_fix2` and `git branch -D fix-infotip-overflow`.

### Task 1: the offer logic and the table's tests

**Files:** Modify `frontend/src/lib/roleEditor.ts`; Test `frontend/src/lib/roleEditor.test.ts`.

**Interfaces:**
- Consumes: `PERMISSIONS`, `PermissionId`, `isPermissionId` from `./permissions`; `joinWords` and `PERMISSION_NEEDS` already in the file; `PAGE_NEED` from `../components/navItems` (tests only). The test file additionally imports `PERMISSION_LABELS` and `type PermissionId` from `./permissions`, `PAGE_NEED` from `../components/navItems`, and `needSentence`, `offerFor`, `offerWords` from `./roleEditor` (the Opus plan review ran this block verbatim: 35 of 35 green against the real table).
- Produces (exact):
```ts
export function missingNeeds(id: PermissionId, ticked: ReadonlySet<string>): PermissionId[]            // needs of id not ticked, in the table's order
export function dependentsOf(id: PermissionId, ticked: ReadonlySet<string>): PermissionId[]            // ticked permissions (not id) that list id as a need, catalogue order
export interface DependencyOffer { kind: "tick" | "untick"; id: PermissionId; others: PermissionId[] } // others is never empty
export function offerFor(id: string, before: ReadonlySet<string>): DependencyOffer | null              // before = the ticks BEFORE the click
export function needSentence(id: string, missing: readonly string[], labelOf: (id: string) => string): string
export interface OfferWords { sentence: string; items: string[]; accept: string; decline: string }
export function offerWords(offer: DependencyOffer, labelOf: (id: string) => string): OfferWords
```

Rules: `offerFor` returns null for an id this build does not know; a click on a TICKED id is an untick (offer = its ticked dependents, computed on the set without it); a click on an unticked id is a tick (offer = `missingNeeds`). `permissionGaps` is rewritten on `missingNeeds` (same output). The inline hint in `RoleEditor` will use `needSentence` (Task 3).

Words (exact strings, `L` = `labelOf`):
- tick, one missing `o`: sentence `${L(id)} also needs ${L(o)} to show anything.`; items `[]`; accept `Also tick ${L(o)}`; decline `Not now`.
- tick, several: sentence `${L(id)} also needs these to show anything:`; items = the labels in `others` order; accept `Also tick ${n} permissions`; decline `Not now`.
- untick, one dependent `o`: sentence `${L(o)} needs ${L(id)} to show anything. Also untick ${L(o)}?`; items `[]`; accept `Also untick ${L(o)}`; decline `Leave ticked`.
- untick, several: sentence `These need ${L(id)} to show anything. Also untick them?`; items = labels; accept `Also untick ${n} permissions`; decline `Leave ticked`.
- `needSentence(id, missing, L)` = `${L(id)} also needs ${joinWords(missing.map(L))} to show anything.`

- [ ] **Step 1: Failing tests** in `roleEditor.test.ts` (new `describe` blocks; keep the existing ones):
```ts
describe("PERMISSION_NEEDS is a sound table", () => {
  it("is closed: whatever a need itself needs is listed too, so one lookup is exact", () => {
    for (const id of PERMISSIONS) for (const need of PERMISSION_NEEDS[id]) {
      for (const deeper of PERMISSION_NEEDS[need]) expect(PERMISSION_NEEDS[id], `${id} needs ${need} needs ${deeper}`).toContain(deeper);
    }
  });
  it("has no cycle and no permission needing itself", () => {
    const visit = (id: PermissionId, path: PermissionId[]) => {
      expect(path, `cycle through ${id}`).not.toContain(id);
      for (const need of PERMISSION_NEEDS[id]) visit(need, [...path, id]);
    };
    for (const id of PERMISSIONS) visit(id, []);
  });
  it("lists no duplicate need", () => {
    for (const id of PERMISSIONS) expect(new Set(PERMISSION_NEEDS[id]).size, id).toBe(PERMISSION_NEEDS[id].length);
  });
  it("agrees with the pages: for an all-of page need, the first id lists all the others", () => {
    for (const [page, need] of Object.entries(PAGE_NEED)) {
      if (!Array.isArray(need)) continue;
      const [opens, ...rest] = need as PermissionId[];
      for (const other of rest) expect(PERMISSION_NEEDS[opens], `${page}: ${opens} should list ${other}`).toContain(other);
    }
  });
  it("makes every action permission need the See of its own area", () => {
    // the area is the id's prefix; "tariffs.edit" needs "tariffs.view" and so on. roles.manage and *.view ids are exempt,
    // and diagnostics.run (works without diagnostics.view: the W9b audit table, row diagnostics.run) is the one real exception.
    for (const id of PERMISSIONS) {
      const [area, action] = id.split(".");
      if (action === "view" || id === "roles.manage" || id === "diagnostics.run") continue;
      expect(PERMISSION_NEEDS[id], id).toContain(`${area}.view`);
    }
  });
});

describe("offerFor", () => {
  it("offers to tick the See that a just-ticked Change lacks", () => {
    expect(offerFor("users.edit", new Set())).toEqual({ kind: "tick", id: "users.edit", others: ["users.view"] });
  });
  it("offers all the missing needs in the table's order, and none that are ticked", () => {
    expect(offerFor("dashboards.edit", new Set(["dashboards.view"]))).toEqual({ kind: "tick", id: "dashboards.edit", others: ["assets.view", "discovery.view"] });
  });
  it("offers nothing when every need is ticked, or the permission needs nothing", () => {
    expect(offerFor("users.edit", new Set(["users.view"]))).toBeNull();
    expect(offerFor("assets.view", new Set())).toBeNull();
  });
  it("offers to untick the ticked permissions that need a just-unticked one", () => {
    expect(offerFor("users.view", new Set(["users.view", "users.edit"]))).toEqual({ kind: "untick", id: "users.view", others: ["users.edit"] });
    expect(offerFor("users.view", new Set(["users.view", "audit.view"]))).toBeNull();
  });
  it("lists the dependents in catalogue order", () => {
    const before = new Set(["assets.view", "tariffs.edit", "assets.edit", "assets.delete"]);
    expect(offerFor("assets.view", before)?.others).toEqual(["assets.edit", "assets.delete", "tariffs.edit"]);
  });
  it("offers nothing for an id this build does not know", () => {
    expect(offerFor("zzz.new", new Set())).toBeNull();
  });
});

describe("offerWords", () => {
  const L = (id: string) => PERMISSION_LABELS[id as PermissionId] ?? id;
  it("words a tick offer for one need like the hint", () => {
    expect(offerWords({ kind: "tick", id: "users.edit", others: ["users.view"] }, L)).toEqual({
      sentence: "Change users also needs See users to show anything.", items: [], accept: "Also tick See users", decline: "Not now",
    });
  });
  it("lists several needs and counts them on the button", () => {
    const words = offerWords({ kind: "tick", id: "dashboards.edit", others: ["assets.view", "discovery.view"] }, L);
    expect(words.sentence).toBe("Change dashboards also needs these to show anything:");
    expect(words.items).toEqual(["See the Assets Tree", "See scans and the graph"]);
    expect(words.accept).toBe("Also tick 2 permissions");
  });
  it("words an untick offer for one and for several dependents", () => {
    expect(offerWords({ kind: "untick", id: "users.view", others: ["users.edit"] }, L)).toEqual({
      sentence: "Change users needs See users to show anything. Also untick Change users?", items: [], accept: "Also untick Change users", decline: "Leave ticked",
    });
    const many = offerWords({ kind: "untick", id: "assets.view", others: ["assets.edit", "assets.delete"] }, L);
    expect(many.sentence).toBe("These need See the Assets Tree to show anything. Also untick them?");
    expect(many.accept).toBe("Also untick 2 permissions");
  });
  it("needSentence is the hint's sentence", () => {
    expect(needSentence("dashboards.edit", ["assets.view", "discovery.view"], L)).toBe("Change dashboards also needs See the Assets Tree and See scans and the graph to show anything.");
  });
});
```
Run the "action permission" test against the real table first. If another id fails, the table is wrong or the exemption is real: decide from the audit table, never loosen the test blindly, and record a Ruling.
- [ ] **Step 2: Run** `npx vitest run src/lib/roleEditor.test.ts` and see the new blocks fail (functions not defined).
- [ ] **Step 3: Implement** in `roleEditor.ts` (add `isPermissionId` to the `./permissions` import):
```ts
/** What `id` needs that is not ticked, in the table's order (the order the hint prints). The table is closed (tested), so one level is exact. */
export function missingNeeds(id: PermissionId, ticked: ReadonlySet<string>): PermissionId[] {
  return PERMISSION_NEEDS[id].filter((needed) => !ticked.has(needed));
}

/** The ticked permissions, other than `id`, that list `id` among their needs, in catalogue order. */
export function dependentsOf(id: PermissionId, ticked: ReadonlySet<string>): PermissionId[] {
  return PERMISSIONS.filter((other) => other !== id && ticked.has(other) && PERMISSION_NEEDS[other].includes(id));
}

/** What the editor offers right after a checkbox was clicked: `kind: "tick"` = `id` was just ticked and `others` are its unticked needs; `"untick"` = `id` was just unticked and `others` are the ticked ones that need it. */
export interface DependencyOffer { kind: "tick" | "untick"; id: PermissionId; others: PermissionId[] }

export function offerFor(id: string, before: ReadonlySet<string>): DependencyOffer | null {
  if (!isPermissionId(id)) return null;
  if (before.has(id)) {
    const after = new Set(before);
    after.delete(id);
    const others = dependentsOf(id, after);
    return others.length > 0 ? { kind: "untick", id, others } : null;
  }
  const others = missingNeeds(id, before);
  return others.length > 0 ? { kind: "tick", id, others } : null;
}
```
and `needSentence`, `OfferWords`, `offerWords` exactly as the Words block above; `permissionGaps` becomes `.map((id) => ({ id, missing: missingNeeds(id, ticked) }))`.
- [ ] **Step 4: Run** `npx vitest run src/lib/roleEditor.test.ts` green; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(w9c): the offer logic for the Roles editor (what a click on a checkbox offers) and the table's soundness tests`.

### Task 2: `DependencyPrompt` and its style

**Files:** Create `frontend/src/components/DependencyPrompt.tsx`, `DependencyPrompt.test.tsx`, `frontend/src/styles/role-prompt.css`, `frontend/src/styles/role-prompt.css.test.ts`; Modify `frontend/src/main.tsx` (add `import "./styles/role-prompt.css";` next to the other style imports).

**Interfaces:**
- Consumes: `placeTip`, `TipPlacement` from `../lib/placeTip` (Task 0).
- Produces:
```ts
export interface DependencyPromptProps {
  /** The checkbox the offer is about: the card sits under its label and the focus goes back to it. */
  anchor: RefObject<HTMLInputElement | null>;
  sentence: string;
  items: readonly string[];
  acceptLabel: string;
  declineLabel: string;
  onAccept: () => void;   // the parent applies the ticks and removes the prompt
  onDecline: () => void;  // Not now, Escape, a press outside, focus moving outside: the parent removes the prompt
}
export function DependencyPrompt(props: DependencyPromptProps): JSX.Element
```

Behaviour (each a test):
1. Renders `<div role="group" aria-labelledby=<sentence id> className="dep-prompt">` with the sentence in a `<p>`, the items in a `<ul>` only when there are some, and two buttons, both `type="button"` (`primary` class on the accept one). **`type="button"` is essential: the card sits inside the editor's `<form>`.** A test wraps it in a `<form onSubmit>` spy and clicks both buttons: no submit.
2. On mount the accept button gets the focus (`focus({ preventScroll: true })`).
3. Accept button: `onAccept()` then focus to the anchor. Decline button: `onDecline()` then focus to the anchor.
4. Escape (a `keydown` listener on `document` in the CAPTURE phase): `event.stopPropagation()`, `onDecline()`, focus to the anchor. A test mounts it inside the real `Modal` (with an `onClose` spy) and shows Escape calls `onDecline` and NOT `onClose` (show the prompt through a state toggle AFTER the Modal is up, as the editor does: the Modal's mount effect would otherwise move the focus to its first field after the prompt focused its button).
5. `pointerdown` on the document outside the card: `onDecline()`; if the focus was inside the card at that moment it is moved to the anchor first (R6), otherwise untouched. `pointerdown` inside the card: nothing. R9: `fireEvent.mouseDown` on the sentence is `defaultPrevented`; on either button it is not.
6. `focusin` on something outside the card that is not the anchor: `onDecline()`, focus untouched. Focus on the anchor (Shift+Tab back to the checkbox): stays open.
7. Placement: a `useLayoutEffect` computes `placeTip(rect of anchor.closest("label") ?? anchor, {width,height of the card}, {window.innerWidth, innerHeight})` and sets `style={{ top, left }}` (first render at `0, 0`, measured before paint, like `InfoTip`); it recomputes on `scroll` (window, capture) and `resize`. Test with `vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { ... })` returning a rectangle by `this.classList.contains("dep-prompt")` / `this.tagName === "LABEL"` (jsdom's window is 1024 by 768) that the card's style equals `placeTip`'s answer, that a window `scroll` event after the label's rect changed moves it, and that the listeners are removed on unmount.
8. The callbacks are read through a ref (`latest.current`), so the listeners are registered once on mount and a parent that re-renders with new function identities does not re-register or refocus.
9. The effects register/clean up all listeners; React StrictMode double-mount leaves one set.
10. R11: with items, the group has `aria-describedby` = the `<ul>`'s id; without items it has none.

Sketch (the implementer may refine, the behaviours above are the contract):
```tsx
export function DependencyPrompt({ anchor, sentence, items, acceptLabel, declineLabel, onAccept, onDecline }: DependencyPromptProps) {
  const card = useRef<HTMLDivElement>(null);
  const accept = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const listId = useId();
  const [place, setPlace] = useState<TipPlacement | null>(null);
  const latest = useRef({ onAccept, onDecline });
  useEffect(() => { latest.current = { onAccept, onDecline }; });

  useLayoutEffect(() => {
    const box = card.current;
    if (!box) return;
    const put = () => {
      const at = anchor.current?.closest("label") ?? anchor.current;
      if (!at) return;
      const { width, height } = box.getBoundingClientRect();
      setPlace(placeTip(at.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight }));
    };
    put();
    window.addEventListener("scroll", put, true);
    window.addEventListener("resize", put);
    return () => { window.removeEventListener("scroll", put, true); window.removeEventListener("resize", put); };
  }, [anchor]);

  useEffect(() => {
    const box = card.current;
    if (!box) return;
    accept.current?.focus({ preventScroll: true });
    const inside = (target: EventTarget | null) => target instanceof Node && box.contains(target);
    const decline = (refocus: boolean) => {
      latest.current.onDecline();
      if (refocus) anchor.current?.focus();
    };
    const declineByPress = () => decline(inside(document.activeElement)); // the focus must not fall to <body> when the card's own button had it (R6)
    // Capture + stopPropagation: the Modal around us closes on Escape too (a document listener in the bubble phase); one press closes only the top-most thing.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      decline(true);
    };
    const onDown = (event: PointerEvent) => { if (!inside(event.target)) declineByPress(); };
    const onFocusIn = (event: FocusEvent) => { if (!inside(event.target) && event.target !== anchor.current) decline(false); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [anchor]);

  return (
    <div
      ref={card}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={items.length > 0 ? listId : undefined}
      className="dep-prompt"
      style={place ? { top: place.top, left: place.left } : { top: 0, left: 0 }}
      onMouseDown={(event) => { if (!(event.target instanceof HTMLButtonElement)) event.preventDefault(); }} // R9: a press on the text must not move the focus to the Modal
    >
      <p id={titleId}>{sentence}</p>
      {items.length > 0 && <ul id={listId}>{items.map((item) => <li key={item}>{item}</li>)}</ul>}
      <div className="dep-prompt-actions">
        <button type="button" ref={accept} className="primary" onClick={() => { latest.current.onAccept(); anchor.current?.focus(); }}>{acceptLabel}</button>
        <button type="button" onClick={() => { latest.current.onDecline(); anchor.current?.focus(); }}>{declineLabel}</button>
      </div>
    </div>
  );
}
```
CSS `role-prompt.css` (own file, `@layer w6`, tokens only, scoped by `.dep-prompt`): `position: fixed; z-index: 5` (inside the dialog's own stacking context; the tip bubble is 1100, toasts 900), `width: max-content; max-width: min(320px, calc(100vw - 16px))`, `display: grid; gap: 8px; padding: 12px 14px`, `border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg); color: var(--text); box-shadow: var(--shadow-pop)`, `font-size: var(--fs-sm); line-height: 1.45; text-align: left; overflow-wrap: anywhere`, `p { margin: 0 }`, `ul { margin: 0; padding-left: 18px }`, `.dep-prompt-actions { display: flex; flex-wrap: wrap; gap: 8px }`, a fade-in with `transition: opacity var(--motion)` and `@starting-style { .dep-prompt { opacity: 0 } }`, and the R8 arming delay: `.dep-prompt { animation: dep-prompt-arm 1ms linear 400ms backwards; } @keyframes dep-prompt-arm { from { pointer-events: none; } }` (the `from` frame is held during the 400 ms delay by `backwards`, then the card is normal; the test pins that this is the ONLY animation in the file and that its keyframes set nothing but `pointer-events`).

- [ ] **Step 1: Failing tests** `DependencyPrompt.test.tsx` for behaviours 1 to 9 (copy the `PointerEvent` polyfill `beforeAll`/`afterAll` from `RoleEditor.test.tsx` lines 14 to 22; build a small host that renders a `<label><input type="checkbox"/>…</label>` and the prompt, with `vi.fn()` callbacks) and `role-prompt.css.test.ts` (read the file with `readFileSync` like `feedback-toasts.css.test.ts`): exactly one top-level `.dep-prompt` rule (filter with `r.at.length === 1`: `parseRules` also returns the one inside `@starting-style`, as `feedback-toasts.css.test.ts:61` does) with `position: fixed`; a z-index between 1 and 100; no colour literal (`#hex`, `rgb(`, `hsl(`) anywhere in the file; the file is inside `@layer w6`; the R8 keyframes as described. Add `role-prompt.css` to the per-file guard list in `app.css.test.ts` (the `it.each([... "feedback-confirm.css"])` list: one `@layer w6` block, nothing outside, no raw colour). **I-4, the ancestors guard:** a test in `role-prompt.css.test.ts` parses `app.css`, `themes.css` and every `styles/*.css`; for every rule whose selector names `.dialog-backdrop`, `.dialog`, `.role-editor`, `.role-editor-body`, `.table-wrap`, `.role-grid`, `.role-perm`, `.role-sensitive` or `.role-summary`, the body must not match `/(^|[;\s])(transform|filter|backdrop-filter|contain|container-type|container|content-visibility|will-change|perspective|clip-path|mask)\s*:/` (a fixed card's containing block would silently become that ancestor). `.table-wrap.dense { container-type: inline-size }` (`styles/pages-sources.css:14`) is exempt by its exact selector, with a comment, and a second test asserts that `RoleEditor.tsx` renders `className="table-wrap"` without `dense`.
- [ ] **Step 2: Run** both, see them fail.
- [ ] **Step 3: Implement** the component, the CSS and the import.
- [ ] **Step 4: Run** `npx vitest run src/components/DependencyPrompt.test.tsx src/styles/role-prompt.css.test.ts src/components/Modal.test.tsx`; `npm run typecheck`.
- [ ] **Step 5: A LOOK** (implementer, a `playwright-core` script against a Vite dev server with a harness page built from the real `.dialog`, `.role-editor-body` and `.role-grid` classes, as Task 0's author did, or against the controller's scratch stack if it is up): the card under a checkbox in the Change column at 1024 is fully inside the window, does not cover its checkbox, and the grid shows no scroll bar. Write what was seen in the task report.
- [ ] **Step 6: Commit** `feat(w9c): DependencyPrompt, a small fixed card that offers to tick what a permission needs`.

### Task 3: wire it into the editor

**Files:** Modify `frontend/src/components/RoleEditor.tsx`; Test `frontend/src/components/RoleEditor.test.tsx`.

**Interfaces:** Consumes `offerFor`, `offerWords`, `needSentence`, `DependencyOffer` (Task 1) and `DependencyPrompt` (Task 2).

Design:
- State `const [offer, setOffer] = useState<DependencyOffer | null>(null)`.
- `toggle(id)`: `const next = new Set(ticked); if (!next.delete(id)) next.add(id); setTicked(next); setOffer(offerFor(id, ticked));` (the render's `ticked` is the "before"; clicks are discrete events, React re-renders between them). A toggle always replaces the offer (a new tick or untick supersedes an open prompt, and unticking the very checkbox that has a tick-offer closes it).
- R10: `const [serial, setSerial] = useState(0)`; `toggle` also does `setSerial((n) => n + 1)`, and the card is rendered with `key={serial}` (pass it from `EditorForm` to `Item` as a prop used only as the card's key).
- `chooseStart` also does `setOffer(null)`. Nothing else sets an offer: not the initial state, not Duplicate (a new editor mounts), not loading a role.
- `accept`: `setTicked((prev) => { const next = new Set(prev); for (const id of offer.others) { if (offer.kind === "tick") next.add(id); else next.delete(id); } return next; }); setOffer(null);`
- `decline`: `setOffer(null)`.
- `Item` gets `offer`, `words`, `onAccept`, `onDecline` props (only the item whose `entry.id === offer.id` gets them), owns `const input = useRef<HTMLInputElement>(null)` on the checkbox, and renders `<DependencyPrompt anchor={input} ... />` as the next sibling right after `</label>` (before the `InfoTip`) so Tab goes from the checkbox into it.
- The inline hint line uses `needSentence(gap.id, gap.missing, labelOf)` (same text as today).
- Built-in (read-only) role: the checkboxes are disabled, so no toggle, no offer.
- Saving is untouched: `tickedIds()` is what is posted; the offer state is never read by `submit`.

- [ ] **Step 1: Failing tests** in `RoleEditor.test.tsx`, a new `describe("RoleEditor: offering what a permission needs")` (reuse `open`, `tick`, `box`, `summary`, `save`, `sentBody`, `sorted`):
  - ticking "Change users" on an empty new role opens a group named "Change users also needs See users to show anything." with buttons "Also tick See users" and "Not now"; the primary has the focus; the hint line in the summary is also there.
  - "Also tick See users" ticks both, the group is gone, the focus is on "Change users", the hint line is gone, Save posts exactly `["users.edit","users.view"]` (sorted).
  - "Not now" keeps only "Change users" ticked, the group is gone, the focus is on "Change users", the hint stays; unticking and ticking "Change users" again shows the prompt again (D4: re-prompts only after untick and tick), ticking an unrelated permission in between does not.
  - several needs: ticking "Change dashboards" with "See dashboards" ticked opens the list form with "Also tick 2 permissions"; one click ticks both.
  - Escape with the group open closes only the group: the dialog is still there; a second Escape closes the dialog (`onClose` called once).
  - a press outside (clicking the Name field) closes the group and keeps the tick.
  - at most one group after five quick ticks of permissions that each have unmet needs ("Change assets", "Change dashboards", "Change tariffs", "Change sources", "Change storage settings"): `screen.queryAllByRole("group", { name: /also needs/ })` has length at most 1 after each click.
  - untick: with "See users" and "Change users" ticked, unticking "See users" opens "Change users needs See users to show anything. Also untick Change users?" with "Also untick Change users" and "Leave ticked"; accept unticks both; "Leave ticked" leaves "Change users" ticked and the hint line visible; unticking something nobody needs opens nothing.
  - nothing prompts on: "Start from" Operator/Viewer; opening an edit of a custom role whose ticks break a dependency (no group, but the hint line); a built-in role (no checkbox can be clicked); and an open prompt is gone after "Start from".
  - R10: tick "Change tariffs", Not now, click "See tariffs" (a tick offer, no key change needed), Shift+Tab to "See tariffs" and press Space: the untick card "Change tariffs needs See tariffs to show anything. Also untick Change tariffs?" is a fresh card and its "Also untick Change tariffs" button has the focus.
  - the existing keyboard tests pass unchanged; add: focus "Change users", Space, the group's primary has the focus, Enter, both ticked and focus back on "Change users"; and Tab from "Change users" with the prompt open lands on the primary button first (DOM order).
  - the existing "hints" tests still pass.
- [ ] **Step 2: Run** `npx vitest run src/components/RoleEditor.test.tsx`; new ones fail, old ones pass or show only the expected prompt-induced changes (fix a test only where the prompt legitimately changes what it asserts, and say so in the report).
- [ ] **Step 3: Implement** as designed.
- [ ] **Step 4: Run** `npx vitest run src/components/RoleEditor.test.tsx src/components/RolesPanel.test.tsx src/components/DependencyPrompt.test.tsx src/lib/roleEditor.test.ts`; `npm run typecheck`; `npm run build`.
- [ ] **Step 5: Commit** `feat(w9c): the Roles editor offers to tick what a permission needs, and to untick what needs it`.

### Task 4: e2e, docs, gallery

**Files:** Create `frontend/e2e/w9c.spec.ts`; Modify `frontend/e2e/playwright.config.ts` (project `w9c`, `dependencies: ["w7k"]`, same `use` as `w9b`), `README.md` (one short paragraph in the Roles section: the editor offers to tick what a permission needs; no migration), `docs/superpowers/backlog.md` (next free section AH: leftovers), `docs/superpowers/plans/2026-10-11-w7-owner-feedback-roadmap.md` (a row O-28; check `W7k-audit-drawer-and-save-feedback.md` and `W7m-asset-kinds.md` first so the number is free), this plan's boxes and an Execution log. Edit docs with the Edit tool or anchored `sed -i` only, never a whole-file rewrite.

- [ ] **Step 1 (audit):** `grep -n "getByLabel(\|getByRole(" frontend/e2e/*.ts` for values that are a substring of "Also tick", "Not now", "Leave ticked", "also needs", the sentences of Task 1 or any permission label while a prompt is open; check that the existing `w9b.spec.ts` ticks (lines ~273, 319, 413, 509) each have their needs ticked first or are no-need permissions, and write the result in the report. Fix any lookup that could now match two elements.
- [ ] **Step 2:** `w9c.spec.ts` using the helpers of `w9b.spec.ts` (`asUser`, `openRoles`, `editor`, `tick`, `ADMIN`; copy the pieces, do not import across specs unless `w9b` already exports them) with these steps, each asserting what a person sees:
  1. New role (unique name): tick "Change users": the group "Change users also needs See users to show anything." is visible, its box is inside the window and does not overlap the checkbox's label (for this checkbox at its known position it is below it; near the bottom of the window `placeTip` flips the card above, so never assert "below" in general), and the grid's `.table-wrap` has `scrollWidth <= clientWidth`. Click "Also tick See users": both ticked, the group is gone, the focus is on "Change users". Save posts exactly `["users.edit","users.view"]`.
  2. Another new role: tick "Change tariffs", press "Not now": only "Change tariffs" ticked, the hint line is shown; Save posts exactly `["tariffs.edit"]`.
  3. Keyboard: focus "Change users", Space, the primary button is focused, Enter, both ticked and "Change users" focused. Then Space on another needy checkbox, Escape: the group is gone, the dialog is still visible, the checkbox is focused; Escape again closes the dialog.
  4. Untick offer: with "See users" and "Change users" ticked, untick "See users": the group "Change users needs See users to show anything. Also untick Change users?" shows; "Leave ticked" keeps "Change users" ticked.
  5. The `?` bubble of a permission in the Change column (right edge of the grid): open it (click); its box is inside the viewport (left >= 0, right <= viewport width) and `.table-wrap` has no sideways scroll.
  6. R8/R9, quick follow-up and a press on the text: tick "Change dashboards" (with "See dashboards" ticked) and, as soon as the group shows, click "Change sources" (Playwright waits until the card is armed or the box is hittable; use `page.mouse.click` at the old centre of "Change sources" taken BEFORE the first tick, within 300 ms): "Change sources" is ticked, the first group is gone, and at most one group is open (the one for "Change sources"). Then, with a group open, click the sentence text: the group stays open and the focus is unchanged.
  7. At 1024 and 1440 wide viewports: the same tick in the left (See), middle and right (Change) column; the card stays inside the window; screenshot each into the directory in `process.env.W9C_SHOTS` when set.
  Clean up every role the spec made (delete through the API at the end, as `w9b.spec.ts` does). Always answer or dismiss a prompt before touching what it covers (Playwright would wait for the covered checkbox forever).
- [ ] **Step 3:** the e2e type-check prints nothing.
- [ ] **Step 4:** the docs edits above; tick the boxes of Tasks 0 to 4 and write the Execution log skeleton.
- [ ] **Step 5: Commit** `test(w9c): e2e for the dependency prompt; docs (README, roadmap O-28, backlog AH)`.

## Controller steps after Task 4 (not implementer work)
Full frontend suite, typecheck, build; the isolated Playwright run in the scratch project `dcdash_e2e_w9c_vis` (web 18206, second port 18560; copy `drill-lib.sh`, `vis-up.sh`, `vis-rebuild.sh`, `drill-override.yaml` from `.superpowers/sdd/2026-10-13-w7k-feedback/` and edit the workspace path, prefix, ports and image tags; check the guard refuses `dcdash`); the Task 0 step 3 look; ONE whole-wave Opus review in a real browser (1920, 1440, 1024; light and dark; two presets; keyboard; each "needs" row ticked in isolation on the build: the page really shows nothing without its need); ONE fix wave; one scoped re-review; gallery `.superpowers/sdd/overnight-w7/gallery/W9c/`; `git diff main --stat -- backend` empty; the doc-reading backend tests (the 11 files of the W7k run, `.superpowers/sdd/2026-10-13-w7k-feedback/backend-doc-tests.log`) because README/backlog/roadmap changed; merge gate, backup, rebuild, hygiene check, push, markers, memory bullet, MORNING.

## Execution log
(controller fills this in)
