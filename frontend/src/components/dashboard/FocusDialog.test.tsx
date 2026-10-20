import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import type { Asset } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { authed } from "../../test/dashboardFixtures";
import { mockFetch, type Routes } from "../../test/fetchMock";
import { holdFetch } from "../../test/holdFetch";
import { renderWithDataRouter } from "../../test/render";
import { FocusProvider } from "./FocusContext";
import { FocusDialog } from "./FocusDialog";

const a = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({ id, parent_id, name, kind: "generic", sort_order });
/** Two top-level assets: Site A over Hall 1 > Row 2 and Hall 3, and Site B. (Two roots, so no focus is ever normalised away.) */
const forest = [a(1, null, "Site A"), a(2, 1, "Hall 1"), a(3, 2, "Row 2"), a(4, 1, "Hall 3", 1), a(9, null, "Site B", 1)];

/** The page the dialog opens from: an opener button, and the dialog while it is open. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open the dialog</button>
      {open && <FocusDialog onClose={() => setOpen(false)} />}
    </>
  );
}
/** Renders its children once the signed-in user is known (a focus is refused before that). */
function Known({ children }: { children: ReactNode }) {
  return useAuth().user ? <>{children}</> : null;
}

function open(entry = "/x", over: Routes = {}) {
  mockFetch({ ...authed("viewer"), "GET /api/assets": { body: forest }, ...over });
  const view = renderWithDataRouter(<Known><FocusProvider><Opener /></FocusProvider></Known>, { route: entry, path: "/x" });
  const keys = new Set<string>([view.router.state.location.key]);
  view.router.subscribe((state) => keys.add(state.location.key));
  return { ...view, where: () => view.router.state.location.pathname + view.router.state.location.search, navigations: () => keys.size - 1 };
}
const opener = () => screen.findByRole("button", { name: "Open the dialog" });
async function openDialog() {
  await userEvent.click(await opener());
  return screen.findByRole("dialog", { name: "Choose a focus" });
}
/** The dialog once the picker has its rows. */
async function openPicker() {
  const dialog = await openDialog();
  await within(dialog).findByRole("radio", { name: "Site B" });
  return dialog;
}
const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });
const checkedNames = (dialog: HTMLElement) => within(dialog).queryAllByRole("radio").filter((r) => (r as HTMLInputElement).checked).map((r) => r.parentElement?.textContent?.replace(/\s*#\d+$/, ""));

describe("FocusDialog: what it shows", () => {
  it("is a modal dialog named Choose a focus with the picker in single mode, Whole site, Cancel and Show", async () => {
    open();
    const dialog = await openPicker();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("heading", { name: "Choose a focus" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "Focus asset" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("radio").length).toBeGreaterThan(0);
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
    for (const name of ["Whole site", "Cancel", "Show"]) expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
  });

  it("drafts the current focus: its radio is checked", async () => {
    open("/x?asset=3");
    const dialog = await openPicker();
    expect(radio(dialog, "Row 2")).toBeChecked();
    expect(checkedNames(dialog)).toEqual(["Row 2"]);
    expect(within(dialog).getByRole("button", { name: "Whole site" })).not.toHaveAttribute("aria-disabled");
  });

  it("with no focus nothing is checked and Whole site is the current choice (aria-disabled, never disabled)", async () => {
    open();
    const dialog = await openPicker();
    expect(checkedNames(dialog)).toEqual([]);
    const whole = within(dialog).getByRole("button", { name: "Whole site" });
    expect(whole).toHaveAttribute("aria-disabled", "true");
    expect(whole).not.toBeDisabled();
  });

  it("puts the focus in the dialog when it opens", async () => {
    open();
    const dialog = await openPicker();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("has type=button on every button, adds no live region of its own, and no form", async () => {
    open("/x?asset=3");
    const dialog = await openPicker();
    for (const button of within(dialog).getAllByRole("button")) expect(button, button.textContent ?? "").toHaveAttribute("type", "button");
    // The picker's one count line is the only live region inside.
    expect(dialog.querySelectorAll("[aria-live], [role=status], [role=alert], [role=log]")).toHaveLength(1);
    expect(dialog.querySelector("form")).toBeNull();
  });
});

describe("FocusDialog: the draft and Show", () => {
  it("picking changes only the draft: no history entry and the address stays", async () => {
    const { where, navigations } = open("/x?asset=3");
    const dialog = await openPicker();
    await userEvent.click(radio(dialog, "Hall 3"));
    expect(radio(dialog, "Hall 3")).toBeChecked();
    expect(radio(dialog, "Row 2")).not.toBeChecked();
    expect(where()).toBe("/x?asset=3");
    expect(navigations()).toBe(0);
  });

  it("arrow keys move the check along the list without one history entry per key", async () => {
    const { where, navigations } = open("/x?asset=3");
    const dialog = await openPicker();
    radio(dialog, "Row 2").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(checkedNames(dialog)).toEqual(["Hall 3"]);
    await userEvent.keyboard("{ArrowDown}");
    expect(checkedNames(dialog)).toEqual(["Site B"]);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(checkedNames(dialog)).toEqual(["Row 2"]);
    expect(where()).toBe("/x?asset=3");
    expect(navigations()).toBe(0);
  });

  it("Show pushes the drafted asset ONCE, closes, and gives the focus back to the button that opened it", async () => {
    const { where, navigations, router } = open("/x?range=7d");
    const dialog = await openPicker();
    await userEvent.click(radio(dialog, "Hall 3"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(where()).toBe("/x?range=7d&asset=4");
    expect(navigations()).toBe(1);
    expect(router.state.historyAction).toBe("PUSH");
    expect(await opener()).toHaveFocus();
  });

  it("Show with the focus unchanged just closes", async () => {
    const { navigations } = open("/x?asset=3");
    const dialog = await openPicker();
    await userEvent.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(navigations()).toBe(0);
  });

  it("Whole site clears the draft (every radio off, the button idle) and Show then removes the parameter", async () => {
    const { where, navigations } = open("/x?asset=3&range=7d");
    const dialog = await openPicker();
    const whole = within(dialog).getByRole("button", { name: "Whole site" });
    await userEvent.click(whole);
    expect(checkedNames(dialog)).toEqual([]);
    expect(whole).toHaveAttribute("aria-disabled", "true");
    expect(whole).toHaveFocus(); // it kept the focus it was given
    expect(where()).toBe("/x?asset=3&range=7d"); // still only a draft
    expect(navigations()).toBe(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(where()).toBe("/x?range=7d");
    expect(navigations()).toBe(1);
  });

  it("a click on Whole site while it is already the choice does nothing", async () => {
    const { navigations } = open();
    const dialog = await openPicker();
    await userEvent.click(within(dialog).getByRole("button", { name: "Whole site" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(navigations()).toBe(0);
  });

  it("picking again after Whole site makes the draft that asset", async () => {
    const { where } = open("/x?asset=3");
    const dialog = await openPicker();
    await userEvent.click(within(dialog).getByRole("button", { name: "Whole site" }));
    await userEvent.click(radio(dialog, "Site B"));
    expect(within(dialog).getByRole("button", { name: "Whole site" })).not.toHaveAttribute("aria-disabled");
    await userEvent.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(where()).toBe("/x?asset=9");
  });
});

describe("FocusDialog: leaving without a change", () => {
  it("Cancel closes, keeps the address and returns the focus; the next opening drafts the real focus again", async () => {
    const { where, navigations } = open("/x?asset=3");
    const dialog = await openPicker();
    await userEvent.click(radio(dialog, "Hall 3"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(where()).toBe("/x?asset=3");
    expect(navigations()).toBe(0);
    expect(await opener()).toHaveFocus();
    const again = await openPicker();
    expect(checkedNames(again)).toEqual(["Row 2"]);
  });

  it("Escape closes the same way", async () => {
    const { where, navigations } = open("/x?asset=3");
    const dialog = await openPicker();
    await userEvent.click(radio(dialog, "Hall 3"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(where()).toBe("/x?asset=3");
    expect(navigations()).toBe(0);
    expect(await opener()).toHaveFocus();
  });

  it("Escape in the search box clears the typed text and leaves the dialog open; the second Escape closes it", async () => {
    const { navigations } = open();
    const dialog = await openPicker();
    const search = within(dialog).getByRole("searchbox", { name: "Search assets" });
    await userEvent.type(search, "hall");
    expect(within(dialog).queryByRole("radio", { name: "Site B" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Choose a focus" })).toBeInTheDocument();
    expect(search).toHaveValue("");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(navigations()).toBe(0);
  });
});

describe("FocusDialog: the tip beside the picker's label (w27)", () => {
  it("is a What does this mean? button in the legend of Focus asset; the group is still named Focus asset, and the Show button has no tip", async () => {
    open();
    const dialog = await openPicker();
    const group = within(dialog).getByRole("group", { name: "Focus asset" });
    const tip = within(group).getByRole("button", { name: "What does this mean?" });
    expect(tip.closest("legend")).not.toBeNull();
    expect(within(dialog).getAllByRole("button", { name: "What does this mean?" })).toHaveLength(1);
    await userEvent.click(tip);
    expect(screen.getByRole("note")).toHaveTextContent("The cards that follow the focus show this asset. Whole site clears it.");
    expect(dialog).toBeInTheDocument();
    await userEvent.keyboard("{Escape}"); // the innermost layer only: the tip
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose a focus" })).toBeInTheDocument();
  });
});

describe("FocusDialog: the keyboard", () => {
  it("Tab from Show wraps to the first control (the picker's tip, w27) and Shift+Tab from the first wraps to Show", async () => {
    open();
    const dialog = await openPicker();
    const search = within(dialog).getByRole("searchbox", { name: "Search assets" });
    const tip = within(dialog).getByRole("button", { name: "What does this mean?" });
    expect(search).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(tip).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Show" })).toHaveFocus();
    await userEvent.tab();
    expect(tip).toHaveFocus();
    await userEvent.tab();
    expect(search).toHaveFocus();
  });

  it("keeps the focus inside while it is open: a click outside it comes back", async () => {
    open();
    const dialog = await openPicker();
    act(() => (document.body.appendChild(document.createElement("button")) as HTMLButtonElement).focus());
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });
});

describe("FocusDialog: the asset list", () => {
  it("while the list loads: a Loading line in the picker's place, no picker, and Whole site, Cancel and Show are there; then the picker", async () => {
    const calls = mockFetch({ ...authed("viewer"), "GET /api/assets": { body: forest } });
    const held = holdFetch((_method, path) => path === "/api/assets");
    renderWithDataRouter(<Known><FocusProvider><Opener /></FocusProvider></Known>, { route: "/x", path: "/x" });
    const dialog = await openDialog();
    expect(within(dialog).getByText("Loading assets…")).toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "Focus asset" })).not.toBeInTheDocument();
    for (const name of ["Whole site", "Cancel", "Show"]) expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    expect(dialog.querySelectorAll("[aria-live], [role=status], [role=alert]")).toHaveLength(0);
    expect(within(dialog).getByText("Loading assets…")).toHaveFocus(); // the dialog has the focus from the start
    held.release();
    expect(await within(dialog).findByRole("group", { name: "Focus asset" })).toBeInTheDocument();
    expect(within(dialog).queryByText("Loading assets…")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("searchbox", { name: "Search assets" })).toHaveFocus(); // and the search box has it once the line is gone
    expect(calls.filter((c) => c.path === "/api/assets")).toHaveLength(1);
  });

  it("leaves the focus where the person put it when the list lands after they moved on", async () => {
    mockFetch({ ...authed("viewer"), "GET /api/assets": { body: forest } });
    const held = holdFetch((_method, path) => path === "/api/assets");
    renderWithDataRouter(<Known><FocusProvider><Opener /></FocusProvider></Known>, { route: "/x", path: "/x" });
    const dialog = await openDialog();
    await userEvent.tab(); // from the Loading line to Whole site
    const whole = within(dialog).getByRole("button", { name: "Whole site" });
    expect(whole).toHaveFocus();
    held.release();
    await within(dialog).findByRole("group", { name: "Focus asset" });
    expect(whole).toHaveFocus();
  });

  it("says why when the list cannot be read, and still lets the dialog be closed", async () => {
    open("/x", { "GET /api/assets": { status: 500, body: { detail: "list unavailable" } } });
    const dialog = await openDialog();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not load the assets: list unavailable");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
