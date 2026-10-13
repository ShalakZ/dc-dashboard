import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import type { AuditEntry } from "../api/types";
import { spyToasts } from "../test/toasts";
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

  it("shows the stored JSON as it is, ids and all, under Details", () => {
    const { dialog } = show(drawer());
    expect(within(dialog()).getByRole("heading", { name: "Details" })).toBeInTheDocument();
    const json = dialog().querySelector("pre")!;
    expect(json.textContent).toBe(JSON.stringify(tariff, null, 2));
    expect(json).toHaveTextContent('"asset_id": 7');
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

  it("says the sentence in a polite live line with the entry's number, and changes that same line in place when the entry changes (Previous, Next)", () => {
    const { dialog, rerender, toasts } = show(drawer());
    const live = () => dialog().querySelector<HTMLElement>('[aria-live="polite"]')!;
    const [panel, line] = [dialog(), live()];
    expect(line).toHaveTextContent(`Entry #51: ${SENTENCE}`);
    expect(line).toHaveClass("sr-only");
    rerender(<MemoryRouter>{toasts.wrap(drawer({ entry: stored({ id: 50, action: "scan.started", detail: { scan_id: 50 }, refs: {} }) }))}</MemoryRouter>);
    // the same nodes, not a new drawer: a live region announces a CHANGE of its text, and a freshly inserted one often says nothing
    expect(dialog()).toBe(panel);
    expect(live()).toBe(line);
    expect(line).toHaveTextContent("Entry #50: Started scan #50");
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
