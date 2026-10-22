import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuditEntry, AuditOutcome } from "../api/types";
import { AuthProvider } from "../auth/AuthProvider";
import type { PermissionId } from "../lib/permissions";
import { mockFetch, type Routes } from "../test/fetchMock";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { AuditDrawer } from "./AuditDrawer";

const NOW = new Date("2026-10-07T12:00:00Z");
const tariff = { tariff_id: 3, asset_id: 7, rate_per_kwh: 0.16, effective_from: "2026-10-13" };
const stored = (extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 51, user_id: 1, actor_id: 1, username: "admin", action: "tariff.created", detail: tariff, ts: "2026-10-07T10:00:00Z",
  refs: { asset: { "7": "Panel A" } }, ...extra,
});
const SENTENCE = "Created tariff 0.16 per kWh from 2026-10-13 for asset Panel A";

function show(ui: ReactElement, toasts = spyToasts()) {
  const view = render(<MemoryRouter>{toasts.wrap(ui)}</MemoryRouter>);
  return { ...view, toasts, dialog: () => screen.getByRole("dialog", { name: "Audit entry" }) };
}
const drawer = (props: Partial<Parameters<typeof AuditDrawer>[0]> = {}) => (
  <AuditDrawer entry={stored()} status="ready" timezone="Asia/Qatar" now={NOW} onClose={() => {}} {...props} />
);
const facts = (root: HTMLElement) =>
  Object.fromEntries([...root.querySelectorAll(".kv > div")].map((row) => [row.querySelector("dt")!.textContent, row.querySelector("dd")!]));

describe("AuditDrawer: an entry", () => {
  it("is a dialog called Audit entry, with what happened, when, who, the action and the entry number in that order", () => {
    const { dialog } = show(drawer());
    const rows = [...dialog().querySelectorAll(".kv dt")].map((dt) => dt.textContent);
    expect(rows).toEqual(["What happened", "When", "Who", "Action", "Entry"]);
  });

  it("says what happened in the friendly sentence, with its link to the thing", () => {
    const { dialog } = show(drawer());
    const what = facts(dialog())["What happened"];
    expect(what.querySelector(".what")).toHaveTextContent(SENTENCE);
    expect(within(what as HTMLElement).getByRole("link", { name: "Open Tariffs" })).toHaveAttribute("href", "/tariffs");
  });

  it("says when in the site's zone, with the zone and how long ago", () => {
    const { dialog } = show(drawer());
    const when = facts(dialog()).When;
    expect(when).toHaveTextContent("2026-10-07 13:00:00"); // 10:00Z in Asia/Qatar (UTC+3)
    expect(when).toHaveTextContent("Asia/Qatar");
    expect(when).toHaveTextContent("2 h ago");
  });

  it("leaves out how long ago for an old entry", () => {
    const { dialog } = show(drawer({ entry: stored({ ts: "2026-08-01T10:00:00Z" }) }));
    expect(facts(dialog()).When).toHaveTextContent("2026-08-01 13:00:00 Asia/Qatar");
    expect(facts(dialog()).When).not.toHaveTextContent("ago");
  });

  it("names who did it with an initial disc, and a dash when nobody did", () => {
    const { dialog, rerender, toasts } = show(drawer());
    expect(facts(dialog()).Who).toHaveTextContent("admin");
    expect(facts(dialog()).Who.querySelector(".user-disc")).toHaveTextContent("A");
    rerender(<MemoryRouter>{toasts.wrap(drawer({ entry: stored({ user_id: null, actor_id: null, username: null }) }))}</MemoryRouter>);
    expect(facts(dialog()).Who).toHaveTextContent("—");
    expect(facts(dialog()).Who.querySelector(".user-disc")).toBeNull();
  });

  it("shows the kind of event as a tile and the action code", () => {
    const { dialog } = show(drawer());
    const action = facts(dialog()).Action;
    expect(action.querySelector(".ev-tile")).toHaveAttribute("data-kind", "create");
    expect(action.querySelector("code")).toHaveTextContent("tariff.created");
  });

  it("shows the entry's own number, the one id the friendly text may show", () => {
    const { dialog } = show(drawer());
    expect(facts(dialog()).Entry).toHaveTextContent("#51");
    expect(facts(dialog())["What happened"].textContent).not.toMatch(/#\d/);
  });

  it("keeps the stored JSON behind a button under Details, closed to begin with and not built while it is closed", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const { dialog } = show(drawer());
    expect(within(dialog()).getByRole("heading", { name: "Details" })).toBeInTheDocument();
    const toggle = within(dialog()).getByRole("button", { name: "Show the stored JSON" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(dialog().querySelector("pre")).toBeNull();
    expect(stringify.mock.calls.some(([value]) => value === tariff)).toBe(false);
  });

  it("shows the stored JSON as it is, ids and all, once opened, and hides it again", async () => {
    const { dialog } = show(drawer());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Show the stored JSON" }));
    const json = dialog().querySelector("pre")!;
    expect(json.textContent).toBe(JSON.stringify(tariff, null, 2));
    expect(json).toHaveTextContent('"asset_id": 7');
    const toggle = within(dialog()).getByRole("button", { name: "Hide the stored JSON" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", json.id);
    await userEvent.click(toggle);
    expect(dialog().querySelector("pre")).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it("closes the JSON again when the drawer steps to another entry (a long detail must not open by itself)", async () => {
    const { dialog, rerender, toasts } = show(drawer());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Show the stored JSON" }));
    expect(dialog().querySelector("pre")).not.toBeNull();
    rerender(<MemoryRouter>{toasts.wrap(drawer({ entry: stored({ id: 50, action: "scan.started", detail: { scan_id: 50 }, refs: {} }) }))}</MemoryRouter>);
    expect(dialog().querySelector("pre")).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Show the stored JSON" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows no table for an entry that changed nothing", () => {
    const { dialog } = show(drawer());
    expect(within(dialog()).queryByRole("heading", { name: "What changed" })).not.toBeInTheDocument();
    expect(dialog().querySelector("table")).toBeNull();
  });

  it("shows what changed in a Before and After table with the unchanged values counted", () => {
    const detail = { tariff_id: 3, asset_id: 7, before: { rate_per_kwh: 0.1, effective_from: "2026-01-01" }, after: { rate_per_kwh: 0.12, effective_from: "2026-01-01" } };
    const { dialog } = show(drawer({ entry: stored({ action: "tariff.updated", detail }) }));
    expect(within(dialog()).getByRole("heading", { name: "What changed" })).toBeInTheDocument();
    const table = within(dialog()).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Field", "Before", "After"]);
    const [row] = within(table).getAllByRole("row").slice(1);
    expect([...row.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["Rate per kwh", "0.1", "0.12"]);
    expect(within(dialog()).getByText("1 unchanged value not shown")).toBeInTheDocument();
    expect(facts(dialog())["What happened"].querySelector(".what")).toHaveTextContent("Changed the tariff for asset Panel A: rate per kwh");
  });

  it("has a polite live line that is empty when the entry first shows (the sentence is on the page already, and would be read twice)", () => {
    const { dialog } = show(drawer());
    const line = dialog().querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(line).toBeEmptyDOMElement();
    expect(line).toHaveClass("sr-only");
    expect(line).toHaveAttribute("aria-atomic", "true");
    expect(dialog().textContent!.split(SENTENCE)).toHaveLength(2); // the sentence is in the dialog once
  });

  it("says the sentence with the entry's number once the entry changes (Previous, Next), in that same line, and also when it comes back to the first", () => {
    const { dialog, rerender, toasts } = show(drawer());
    const live = () => dialog().querySelector<HTMLElement>('[aria-live="polite"]')!;
    const [panel, line] = [dialog(), live()];
    const other = stored({ id: 50, action: "scan.started", detail: { scan_id: 50 }, refs: {} });
    rerender(<MemoryRouter>{toasts.wrap(drawer({ entry: other }))}</MemoryRouter>);
    // the same nodes, not a new drawer: a live region announces a CHANGE of its text, and a freshly inserted one often says nothing
    expect(dialog()).toBe(panel);
    expect(live()).toBe(line);
    expect(line).toHaveTextContent("Entry #50: Started scan #50");
    rerender(<MemoryRouter>{toasts.wrap(drawer())}</MemoryRouter>);
    expect(live()).toBe(line);
    expect(line).toHaveTextContent(`Entry #51: ${SENTENCE}`);
  });

  it("stays empty while the same entry is shown again (a re-render with a fresh copy of it is not a step)", () => {
    const { dialog, rerender, toasts } = show(drawer());
    rerender(<MemoryRouter>{toasts.wrap(drawer({ entry: stored() }))}</MemoryRouter>);
    expect(dialog().querySelector('[aria-live="polite"]')).toBeEmptyDOMElement();
  });
});

describe("AuditDrawer: while it waits and when it cannot show the entry", () => {
  it("shows a skeleton region while the entry loads, with no facts and no JSON", () => {
    const { dialog } = show(drawer({ entry: undefined, status: "loading" }));
    const region = within(dialog()).getByText("Loading the entry").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll("dl.kv > div")).toHaveLength(5);
    expect(dialog().querySelector("pre")).toBeNull();
    expect(within(dialog()).queryByText("What happened")).not.toBeInTheDocument();
  });

  it("says why it cannot show the entry, as an alert, and keeps the Close button", () => {
    const { dialog } = show(drawer({ entry: undefined, status: "error", message: "Audit entry not found." }));
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Audit entry not found.");
    expect(within(dialog()).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(dialog().querySelector(".sk-region")).toBeNull();
  });

  it("has a line of its own when the error came without one", () => {
    const { dialog } = show(drawer({ entry: undefined, status: "error" }));
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Could not load the entry.");
  });
});

describe("AuditDrawer: the slots it passes on", () => {
  it("puts the footer under the body, pinned in the drawer's footer", () => {
    const { dialog } = show(drawer({ footer: <button type="button">Next</button> }));
    expect(dialog().querySelector(".drawer-foot")).toContainElement(within(dialog()).getByRole("button", { name: "Next" }));
  });

  it("has no footer when none is given", () => {
    const { dialog } = show(drawer());
    expect(dialog().querySelector(".drawer-foot")).toBeNull();
  });

  it("calls onClose for Escape and the Close button", async () => {
    const onClose = vi.fn();
    const { dialog } = show(drawer({ onClose }));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("gives focus to the element returnFocus finds when it closes", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    const view = show(drawer({ returnFocus: () => target }));
    view.unmount();
    expect(target).toHaveFocus();
    target.remove();
  });
});

describe("AuditDrawer: Copy entry number", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
    delete (document as unknown as Record<string, unknown>).execCommand;
  });
  const clipboard = (writeText: (text: string) => Promise<void>) =>
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const noClipboard = () => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  const copyButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Copy entry number" });

  it("puts #51 on the clipboard and raises one toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const { dialog, toasts } = show(drawer());
    await userEvent.click(copyButton(dialog()));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("#51");
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "info", text: "Entry number copied" }]));
  });

  it("says so, with an error toast and no success one, when nothing could copy", async () => {
    noClipboard();
    document.execCommand = vi.fn(() => false);
    const { dialog, toasts } = show(drawer());
    await userEvent.click(copyButton(dialog()));
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "error", text: "Could not copy the entry number" }]));
  });

  describe("over plain http, where the browser has no clipboard API", () => {
    it("copies from a hidden read-only field inside the panel, which is no Tab stop and not read out", () => {
      const { dialog } = show(drawer());
      const area = dialog().querySelector("textarea")!;
      expect(area).toHaveAttribute("readonly");
      expect(area).toHaveAttribute("tabindex", "-1");
      expect(area).toHaveAttribute("aria-hidden", "true");
      expect(area).toHaveValue("#51");
      expect(area.closest(".drawer")).toBe(dialog());
    });

    it("selects that field and copies its selection, then puts focus back on the Copy button", async () => {
      noClipboard();
      let selected = "";
      document.execCommand = vi.fn(() => {
        const area = document.activeElement as HTMLTextAreaElement;
        selected = area.value.slice(area.selectionStart, area.selectionEnd);
        return true;
      });
      const { dialog, toasts } = show(drawer());
      await userEvent.click(copyButton(dialog()));
      expect(document.execCommand).toHaveBeenCalledExactlyOnceWith("copy");
      expect(selected).toBe("#51");
      await waitFor(() => expect(toasts.calls).toEqual([{ kind: "info", text: "Entry number copied" }]));
      expect(copyButton(dialog())).toHaveFocus();
    });

    it("also falls back when the clipboard API refuses", async () => {
      clipboard(vi.fn().mockRejectedValue(new Error("denied")));
      document.execCommand = vi.fn(() => true);
      const { dialog, toasts } = show(drawer());
      await userEvent.click(copyButton(dialog()));
      expect(document.execCommand).toHaveBeenCalledWith("copy");
      await waitFor(() => expect(toasts.calls).toEqual([{ kind: "info", text: "Entry number copied" }]));
    });
  });
});

describe("AuditDrawer: Undo this tag list", () => {
  const TAGS_AT = "2026-10-07T10:00:00Z"; // 2 hours before NOW
  const mapped = (extra: Partial<AuditEntry> = {}) =>
    stored({ id: 80, action: "tags.mapped", detail: { source_id: 5, points: [1, 2], assets: [[9, null, "Hall 1"]], mappings: [[1, 1, 9, "energy_kwh", 1, 60, null]] }, refs: {}, ts: TAGS_AT, ...extra });
  const SENTENCE_BACK = "Removed 1 mapping, 1 asset and 2 points.";

  /** The drawer over an account holding `permissions`, once the account is known (the button is absent until /api/me has answered). */
  async function showAs(permissions: PermissionId[], entry: AuditEntry, routes: Routes = {}) {
    const toasts = spyToasts();
    mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("custom", { permissions }) }, ...routes });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refreshed = vi.spyOn(client, "invalidateQueries");
    const view = render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter>{toasts.wrap(<><SignedIn />{drawer({ entry })}</>)}</MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await accountKnown();
    const dialog = screen.getByRole("dialog", { name: "Audit entry" });
    return { ...view, dialog, toasts, refreshed, undo: () => within(dialog).queryByRole("button", { name: "Undo this tag list" }) };
  }

  it("is offered to an account with discovery.accept, for a tag list of the last 24 hours", async () => {
    const { undo, dialog } = await showAs(["discovery.accept", "audit.view"], mapped());
    expect(undo()).toBeInTheDocument();
    expect(undo()).toHaveAttribute("type", "button");
    expect(dialog).toHaveTextContent("Possible for 24 hours.");
  });

  it("is not offered to an account that can see the audit log but not accept discovery results", async () => {
    const { undo } = await showAs(["audit.view", "assets.edit", "readings.import"], mapped());
    expect(undo()).toBeNull();
  });

  it("is offered for a tag list 23 hours old and not for one 25 hours old (NOW is 2026-10-07 12:00 UTC)", async () => {
    expect((await showAs(["discovery.accept"], mapped({ ts: "2026-10-06T13:00:00Z" }))).undo()).toBeInTheDocument();
    cleanup();
    expect((await showAs(["discovery.accept"], mapped({ ts: "2026-10-06T11:00:00Z" }))).undo()).toBeNull();
  });

  it("is offered only for a tags.mapped entry, not for its Undo or any other action", async () => {
    const { undo } = await showAs(["discovery.accept"], stored({ id: 81, action: "tags.unmapped", detail: { audit_id: 80, mappings: 1, assets: 1, points_removed: 2, points_kept: [] }, refs: {}, ts: TAGS_AT }));
    expect(undo()).toBeNull();
    cleanup();
    expect((await showAs(["discovery.accept"], stored())).undo()).toBeNull();
  });

  it("posts the Undo of this entry, tells the server's sentence in place and in a toast, keeps the button (waiting) and the focus on it, and reads the lists again", async () => {
    const { undo, dialog, toasts, refreshed } = await showAs(["discovery.accept"], mapped(), {
      "POST /api/tag-lists/80/undo": { body: { mappings: 1, assets: 1, points_removed: 2, points_kept: 0, text: SENTENCE_BACK } },
    });
    await userEvent.click(undo()!);
    await waitFor(() => expect(dialog.querySelector(".audit-undo-slot")).toHaveTextContent(SENTENCE_BACK));
    expect(toasts.calls).toEqual([{ kind: "success", text: SENTENCE_BACK }]);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === "/api/tag-lists/80/undo" && (init as RequestInit).method === "POST")).toHaveLength(1);
    expect(undo()).toHaveAttribute("aria-disabled", "true");
    expect(undo()).toHaveFocus();
    await waitFor(() => expect(refreshed.mock.calls.map(([f]) => (f as { queryKey: readonly unknown[] }).queryKey[0])).toEqual(expect.arrayContaining(["audit", "sources", "assets", "graph", "billing"])));
    // a second press does nothing
    await userEvent.click(undo()!);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/tag-lists/80/undo")).toHaveLength(1);
  });

  it("shows the server's refusal in place, as an alert, with no toast, and lets the person try again", async () => {
    const { undo, dialog, toasts, refreshed } = await showAs(["discovery.accept"], mapped(), {
      "POST /api/tag-lists/80/undo": { status: 409, body: { detail: "this tag list was already undone" } },
    });
    await userEvent.click(undo()!);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This tag list was already undone");
    expect(toasts.calls).toEqual([]);
    expect(undo()).not.toHaveAttribute("aria-disabled");
    await waitFor(() => expect(refreshed).toHaveBeenCalled()); // the lists are out of date after a refusal too
  });

  it("holds a slot for the message that stays when there is none, and says the refusal of the changed-since case in full", async () => {
    const changed = 'the asset "Hall 1" was renamed or moved after the list created it; the list cannot be undone as a whole';
    const { undo, dialog } = await showAs(["discovery.accept"], mapped(), { "POST /api/tag-lists/80/undo": { status: 409, body: { detail: changed } } });
    expect(dialog.querySelector(".audit-undo-slot")).toBeEmptyDOMElement();
    await userEvent.click(undo()!);
    // The server writes it in lower case; the drawer starts the sentence with a capital, like the other pages' API messages.
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(`The asset "Hall 1" was renamed or moved after the list created it; the list cannot be undone as a whole`);
  });

  it("forgets a refusal when the drawer steps to another entry", async () => {
    const { undo, dialog, rerender, toasts } = await showAs(["discovery.accept"], mapped(), { "POST /api/tag-lists/80/undo": { status: 409, body: { detail: "already undone" } } });
    await userEvent.click(undo()!);
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <MemoryRouter>{toasts.wrap(<><SignedIn />{drawer({ entry: mapped({ id: 79 }) })}</>)}</MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(dialog.querySelectorAll(".audit-undo")).toHaveLength(1); // the old block is unmounted, not left beside the new one
  });

  it("keeps the raw JSON of a tag list closed, so a 1,000-line detail is never built until it is asked for", async () => {
    const big = { source_id: 5, mappings: Array.from({ length: 1000 }, (_, i) => [i, i, i, "energy_kwh", 1, 60, null]) };
    const stringify = vi.spyOn(JSON, "stringify");
    const { dialog } = await showAs(["discovery.accept"], mapped({ detail: big }));
    expect(dialog.querySelector("pre")).toBeNull();
    expect(stringify.mock.calls.some(([value]) => value === big)).toBe(false);
  });
});

describe("AuditDrawer: the Outcome of a started check or test (w32)", () => {
  const PASSED: AuditOutcome = { state: "passed", text: "The connection check passed (7 steps).", event_id: 77, counts: null };
  const RUNNING: AuditOutcome = { state: "running", text: "Still running.", event_id: null, counts: null };
  const FAILED: AuditOutcome = { state: "failed", text: 'The connection check failed at "secure channel".', event_id: 78, counts: null };
  const GONE: AuditOutcome = { state: "gone", text: "The outcome is no longer kept (system events are kept 90 days).", event_id: null, counts: null };
  const checked = (outcome: AuditOutcome | null | undefined, extra: Partial<AuditEntry> = {}) =>
    stored({ id: 60, action: "source.checked", detail: { source_id: 2, name: "PM-1", job_id: 9 }, refs: {}, outcome, ...extra });
  const BASE_ROWS = ["What happened", "When", "Who", "Action", "Entry"];
  const rowsOf = (dialog: HTMLElement) => [...dialog.querySelectorAll(".kv dt")].map((dt) => dt.textContent);

  /** The drawer over an account holding `permissions`, once the account is known (the link is absent until /api/me has answered). */
  async function showWith(permissions: PermissionId[], entry: AuditEntry, routes: Routes = {}) {
    const toasts = spyToasts();
    const calls = mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("custom", { permissions }) }, ...routes });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refreshed = vi.spyOn(client, "invalidateQueries");
    const view = render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter>{toasts.wrap(<><SignedIn />{drawer({ entry })}</>)}</MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await accountKnown();
    const dialog = screen.getByRole("dialog", { name: "Audit entry" });
    const outcomeRow = () => facts(dialog).Outcome as HTMLElement | undefined;
    const asked = () => calls.filter((c) => c.method === "GET" && c.path === "/api/audit/60").length;
    return { ...view, dialog, outcomeRow, asked, calls, refreshed };
  }

  it("adds an Outcome row LAST for a started check, with the sentence and a link to the event for someone who may read system events", async () => {
    const { dialog, outcomeRow } = await showWith(["audit.view", "diagnostics.view"], checked(PASSED));
    expect(rowsOf(dialog)).toEqual([...BASE_ROWS, "Outcome"]);
    expect(outcomeRow()).toHaveTextContent("The connection check passed (7 steps).");
    const link = within(outcomeRow()!).getByRole("link", { name: "Open in System events" });
    expect(link).toHaveAttribute("href", "/events/77");
  });

  it("shows a failed check's sentence and its own event, and a link per entry (not a shared one)", async () => {
    const { outcomeRow } = await showWith(["diagnostics.view"], checked(FAILED));
    expect(outcomeRow()).toHaveTextContent('The connection check failed at "secure channel".');
    expect(within(outcomeRow()!).getByRole("link", { name: "Open in System events" })).toHaveAttribute("href", "/events/78");
  });

  it("gives no link to an account without diagnostics.view (the row and the sentence stay)", async () => {
    const { dialog, outcomeRow } = await showWith(["audit.view"], checked(PASSED));
    expect(rowsOf(dialog)).toEqual([...BASE_ROWS, "Outcome"]);
    expect(outcomeRow()).toHaveTextContent("The connection check passed (7 steps).");
    expect(within(outcomeRow()!).queryByRole("link")).toBeNull();
  });

  it("gives no link when the outcome has no event (no longer kept, or still running), also with diagnostics.view", async () => {
    const gone = await showWith(["diagnostics.view"], checked(GONE));
    expect(gone.outcomeRow()).toHaveTextContent("The outcome is no longer kept (system events are kept 90 days).");
    expect(within(gone.outcomeRow()!).queryByRole("link")).toBeNull();
    cleanup();
    const running = await showWith(["diagnostics.view"], checked(RUNNING, { id: 61 }), { "GET /api/audit/61": { body: checked(RUNNING, { id: 61 }) } });
    expect(running.outcomeRow()).toHaveTextContent("Still running.");
    expect(within(running.outcomeRow()!).queryByRole("link")).toBeNull();
  });

  it("says the test of several sources in the server's words, for source.tested and source.test_all as well", async () => {
    const several: AuditOutcome = { state: "failed", text: "3 passed, 1 failed", event_id: null, counts: { passed: 3, failed: 1, running: 0, gone: 0 } };
    const { dialog, outcomeRow } = await showWith(["diagnostics.view"], checked(several, { action: "source.test_all", detail: { sources: 4, job_ids: [1, 2, 3, 4] } }));
    expect(rowsOf(dialog)).toEqual([...BASE_ROWS, "Outcome"]);
    expect(outcomeRow()).toHaveTextContent("3 passed, 1 failed");
    cleanup();
    const tested = await showWith(["diagnostics.view"], checked(PASSED, { action: "source.tested" }));
    expect(rowsOf(tested.dialog)).toEqual([...BASE_ROWS, "Outcome"]);
  });

  it("keeps five rows, exactly as before, for any other action, a missing outcome field and a null outcome (no account or query client needed)", () => {
    for (const entry of [
      stored(), // tariff.created, no outcome field at all
      stored({ outcome: PASSED }), // an outcome on an action that never has one is not shown
      checked(undefined),
      checked(null),
    ]) {
      const { dialog, unmount } = show(drawer({ entry }));
      expect(rowsOf(dialog())).toEqual(BASE_ROWS);
      expect(dialog()).not.toHaveTextContent("Outcome");
      unmount();
    }
  });

  it("adds no live region of its own: no status or alert, and the one polite line stays the only aria-live", async () => {
    for (const outcome of [PASSED, FAILED, GONE]) {
      const { dialog } = await showWith(["diagnostics.view"], checked(outcome));
      expect(dialog.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
      expect(dialog.querySelectorAll("[aria-live]")).toHaveLength(1);
      cleanup();
    }
  });

  describe("while the check is still running", () => {
    const asEntry = (outcome: AuditOutcome) => checked(outcome);
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); }); // before the render, so the query's interval is the fake one
    afterEach(() => { vi.useRealTimers(); });

    it("asks for the entry again every 5 seconds, shows the new outcome when it ends, and then stops asking", async () => {
      let answers = 0;
      const { asked, outcomeRow, refreshed } = await showWith(["diagnostics.view"], asEntry(RUNNING), {
        "GET /api/audit/60": () => ({ body: asEntry(answers++ === 0 ? RUNNING : PASSED) }),
      });
      await waitFor(() => expect(asked()).toBe(1)); // once on opening: the list may be a few seconds old
      expect(outcomeRow()).toHaveTextContent("Still running.");
      expect(refreshed).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(4_000); });
      expect(asked()).toBe(1); // not before 5 seconds
      act(() => { vi.advanceTimersByTime(1_000); });
      await waitFor(() => expect(outcomeRow()).toHaveTextContent("The connection check passed (7 steps)."));
      expect(asked()).toBe(2);
      expect(within(outcomeRow()!).getByRole("link", { name: "Open in System events" })).toHaveAttribute("href", "/events/77");
      act(() => { vi.advanceTimersByTime(60_000); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(asked()).toBe(2); // it has ended: nothing more is asked
      // the lists are read once, so the tag in the row says what the drawer says; the entry itself is not read again by that
      expect(refreshed).toHaveBeenCalledTimes(1);
      const { queryKey, predicate } = refreshed.mock.calls[0][0] as { queryKey: readonly unknown[]; predicate: (query: { queryKey: readonly unknown[] }) => boolean };
      expect(queryKey).toEqual(["audit"]);
      expect(predicate({ queryKey: ["audit", { q: "" }, 50, 0] })).toBe(true);
      expect(predicate({ queryKey: ["audit", "entry", 60] })).toBe(false);
    });

    it("keeps asking while the answer is still running", async () => {
      const { asked } = await showWith(["diagnostics.view"], asEntry(RUNNING), { "GET /api/audit/60": () => ({ body: asEntry(RUNNING) }) });
      await waitFor(() => expect(asked()).toBe(1));
      for (const n of [2, 3, 4]) {
        act(() => { vi.advanceTimersByTime(5_000); });
        await waitFor(() => expect(asked()).toBe(n));
      }
    });

    it("keeps the sentence it has when a request fails, shows no alert for it, and tries again at the next beat", async () => {
      let answers = 0;
      const { asked, outcomeRow, dialog } = await showWith(["diagnostics.view"], asEntry(RUNNING), {
        "GET /api/audit/60": () => (answers++ === 0 ? { status: 500, body: { detail: "boom" } } : { body: asEntry(FAILED) }),
      });
      await waitFor(() => expect(asked()).toBe(1));
      expect(outcomeRow()).toHaveTextContent("Still running.");
      expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(0);
      act(() => { vi.advanceTimersByTime(5_000); });
      await waitFor(() => expect(outcomeRow()).toHaveTextContent('The connection check failed at "secure channel".'));
    });

    it("does not move the focus when the outcome changes under it", async () => {
      let answers = 0;
      const { asked, outcomeRow, dialog } = await showWith(["diagnostics.view"], asEntry(RUNNING), {
        "GET /api/audit/60": () => ({ body: asEntry(answers++ === 0 ? RUNNING : PASSED) }),
      });
      await waitFor(() => expect(asked()).toBe(1));
      const copy = within(dialog).getByRole("button", { name: "Copy entry number" });
      copy.focus();
      act(() => { vi.advanceTimersByTime(5_000); });
      await waitFor(() => expect(outcomeRow()).toHaveTextContent("passed"));
      expect(copy).toHaveFocus();
    });

    it("stops asking when the drawer is closed", async () => {
      const { asked, unmount } = await showWith(["diagnostics.view"], asEntry(RUNNING), { "GET /api/audit/60": () => ({ body: asEntry(RUNNING) }) });
      await waitFor(() => expect(asked()).toBe(1));
      unmount();
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(asked()).toBe(1);
    });
  });

  it("never asks for the entry when the outcome has ended, passed or not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      for (const outcome of [PASSED, FAILED, GONE]) {
        const { asked } = await showWith(["diagnostics.view"], checked(outcome));
        act(() => { vi.advanceTimersByTime(30_000); });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(asked()).toBe(0);
        cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws six skeleton rows while a started check or test loads, and five for any other action or an entry it does not know yet", () => {
    const rows = (props: Partial<Parameters<typeof AuditDrawer>[0]>) => {
      const { dialog, unmount } = show(drawer({ status: "loading", ...props }));
      const count = within(dialog()).getByText("Loading the entry").parentElement!.querySelectorAll("dl.kv > div").length;
      unmount();
      return count;
    };
    for (const action of ["source.tested", "source.checked", "source.test_all"]) expect(rows({ entry: checked(undefined, { action }) }), action).toBe(6);
    expect(rows({ entry: stored() })).toBe(5);
    expect(rows({ entry: checked(undefined, { action: "source.updated" }) })).toBe(5);
    expect(rows({ entry: undefined })).toBe(5);
  });
});
