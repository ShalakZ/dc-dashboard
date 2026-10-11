import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import type { Asset } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { QuickFind } from "./QuickFind";

const asset = (id: number, name: string, parent_id: number | null): Asset => ({ id, parent_id, name, kind: "panel", sort_order: 0 });
const ASSETS: Asset[] = [
  asset(1, "Site", null),
  asset(2, "MV2", 1),
  asset(5, "LV Panel 1", 2),
  asset(6, "LV Panel 2", 2),
  asset(7, "MV2-Room-1", 2),
];
// "mv2" finds, in this order: MV2 (name starts, shorter path), MV2-Room-1 (name starts), LV Panel 1 and LV Panel 2 (path only).
const MV2_HITS = ["MV2", "MV2-Room-1", "LV Panel 1", "LV Panel 2"];

/** Shows where the router is and who is signed in, so a test can wait for the role and read the page it landed on. */
function Probe() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  return (
    <>
      <p data-testid="where">{pathname}</p>
      <p data-testid="who">{user?.role ?? "nobody"}</p>
    </>
  );
}

interface MountOptions { role?: string; assets?: Routes[string]; extra?: ReactNode }
async function mount({ role = "admin", assets = { body: ASSETS }, extra = null }: MountOptions = {}) {
  const calls = mockFetch({
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": { body: { id: 1, username: "u", role } },
    "GET /api/assets": assets,
  });
  const user = userEvent.setup();
  renderWithProviders(
    <>
      <button type="button">before</button>
      <QuickFind />
      <button type="button">after</button>
      <main id="main" tabIndex={-1}>main</main>
      {extra}
      <Probe />
    </>,
    { route: "/start" },
  );
  await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent(role)); // hasRole needs the user
  const input = screen.getByRole("combobox", { name: "Quick find" }) as HTMLInputElement;
  return { user, calls, input };
}
const where = () => screen.getByTestId("where").textContent;
const optionLabels = () => screen.queryAllByRole("option").map((o) => o.querySelector(".qf-label")?.textContent);

describe("QuickFind structure", () => {
  it("is a search landmark with one combobox named Quick find, a placeholder and a shortcut hint", async () => {
    const { input } = await mount();
    const search = screen.getByRole("search");
    expect(search).toContainElement(input);
    expect(input).toHaveAttribute("type", "search");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("placeholder", "Find an asset or page");
    expect(input).toHaveAccessibleName("Quick find");
    const label = search.querySelector("label");
    expect(label).toHaveClass("sr-only");
    expect(label).toHaveTextContent(/^Quick find$/);
    expect(label).toHaveAttribute("for", input.id);
    const hint = search.querySelector("kbd");
    expect(hint).toHaveTextContent("Ctrl K");
    expect(hint).toHaveAttribute("aria-hidden", "true");
  });

  it("shows nothing while closed: no listbox in the DOM, no aria-controls, nothing active, nothing announced", async () => {
    const { user, input } = await mount();
    await user.click(input); // focused, but nothing typed: no popup
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(document.getElementById("quick-find-list")).toBeNull();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens a listbox of option rows in two named groups when something matches", async () => {
    const { user, input } = await mount();
    await user.type(input, "s"); // Site, MV2 ... by path, and the pages Assets, Dashboards, Settings, ...
    await screen.findByRole("group", { name: "Tree matches" }); // the pages answer at once, the assets when their request has
    const list = screen.getByRole("listbox");
    expect(list.tagName).toBe("UL");
    expect(list).toHaveAttribute("id", "quick-find-list");
    expect(list).toHaveAccessibleName("Suggestions");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", "quick-find-list");
    const tree = within(list).getByRole("group", { name: "Tree matches" });
    const pages = within(list).getByRole("group", { name: "Page matches" });
    expect(tree.tagName).toBe("LI");
    expect(pages.tagName).toBe("LI");
    expect(within(tree).getAllByRole("option").length).toBeGreaterThan(0);
    expect(within(pages).getAllByRole("option").length).toBeGreaterThan(0);
    for (const option of within(list).getAllByRole("option")) {
      expect(option.tagName).toBe("LI");
      expect(option.id).not.toBe("");
      expect(option).toHaveAttribute("aria-selected", "false");
      expect(option.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    // the visible captions are decoration: the groups carry the names, and no heading is added to the page
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    const captions = Array.from(list.querySelectorAll(".qf-cap"));
    expect(captions.map((c) => c.textContent)).toEqual(["Assets", "Pages"]);
    for (const caption of captions) expect(caption).toHaveAttribute("aria-hidden", "true");
  });

  it("names the option by its label and then the path above it", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    expect(await screen.findByRole("option", { name: "MV2-Room-1 Site / MV2" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "MV2 Site" })).toBeInTheDocument();
  });

  it("only lists a group that has a hit", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    expect(screen.getByRole("group", { name: "Tree matches" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Page matches" })).not.toBeInTheDocument();
  });

  it("puts none of the words the specs look labels up by into a label of its own", async () => {
    const { user, input } = await mount();
    await user.type(input, "s");
    await screen.findByRole("group", { name: "Tree matches" });
    const search = screen.getByRole("search");
    const names = [
      ...Array.from(search.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label")),
      ...Array.from(search.querySelectorAll("label")).map((el) => el.textContent),
    ];
    expect(names).toEqual(expect.arrayContaining(["Quick find", "Tree matches", "Page matches"]));
    for (const name of names) expect(name, `"${name}"`).not.toMatch(/asset|dashboard|source|metric|trend/i);
    expect(search.querySelector("[aria-labelledby]")).toBeNull();
  });
});

describe("QuickFind matches", () => {
  it.each(["users", "settings", "sources"])("lists %s to an admin", async (query) => {
    const { user, input } = await mount({ role: "admin" });
    await user.type(input, query);
    expect(await screen.findByRole("option", { name: new RegExp(`^${query}$`, "i") })).toBeInTheDocument();
  });

  it.each(["users", "settings", "sources", "scans", "discovery", "tariffs", "storage", "audit"])("never lists the %s page to a viewer", async (query) => {
    const { user, input } = await mount({ role: "viewer" });
    await user.type(input, query);
    expect(await screen.findByRole("status")).toHaveTextContent("No match");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("gives a viewer the pages of the Monitor group", async () => {
    const { user, input } = await mount({ role: "viewer" });
    await user.type(input, "d"); // Dashboards (starts), Billing (no d), Discovery and Audit are gated away
    expect(await screen.findByRole("option", { name: "Dashboards" })).toBeInTheDocument();
    expect(optionLabels()).not.toContain("Discovery");
    expect(optionLabels()).not.toContain("Audit");
  });

  it("gives an operator the Operate pages but not the Administer ones", async () => {
    const { user, input } = await mount({ role: "operator" });
    await user.type(input, "sources");
    expect(await screen.findByRole("option", { name: "Sources" })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "users");
    expect(await screen.findByRole("status")).toHaveTextContent("No match");
  });

  it("still lists pages when the site has no assets", async () => {
    const { user, input } = await mount({ assets: { body: [] } });
    await user.type(input, "bill");
    expect(await screen.findByRole("option", { name: "Billing" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Tree matches" })).not.toBeInTheDocument();
  });

  it("says No match, in a status line outside the listbox, for gibberish", async () => {
    const { user, input } = await mount();
    await user.type(input, "qzqzqz");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/^No match$/);
    expect(screen.getByRole("search")).toContainElement(status);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // no listbox, so nothing to control or to expand
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(where()).toBe("/start");
  });

  it("shows a 46-character name whole (the stylesheet shortens it with an ellipsis)", async () => {
    const name = "Main-Switchboard-Room-A-Incomer-Feeder-No-1-QA";
    expect(name).toHaveLength(46);
    const { user, input } = await mount({ assets: { body: [asset(1, "Site", null), asset(9, name, 1)] } });
    await user.type(input, "main-sw");
    await screen.findByRole("listbox");
    expect(optionLabels()).toEqual([name]);
  });

  it("does not raise an alert when the asset request fails, and still lists the pages", async () => {
    const { user, input, calls } = await mount({ assets: { status: 500, body: { detail: "boom" } } });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/assets")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50)); // the rejection reaches the query
    await user.type(input, "bill");
    expect(await screen.findByRole("option", { name: "Billing" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("QuickFind keyboard", () => {
  it("moves the active option with the arrows, wrapping at both ends, and keeps the focus in the field", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(4);
    expect(input).not.toHaveAttribute("aria-activedescendant"); // nothing is active until an arrow is pressed
    const expectActive = (index: number) => {
      expect(input).toHaveAttribute("aria-activedescendant", options[index].id);
      options.forEach((option, i) => expect(option).toHaveAttribute("aria-selected", i === index ? "true" : "false"));
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(options[index]);
      expect(input).toHaveFocus();
    };
    await user.keyboard("{ArrowDown}");
    expectActive(0);
    await user.keyboard("{ArrowDown}");
    expectActive(1);
    await user.keyboard("{ArrowUp}");
    expectActive(0);
    await user.keyboard("{ArrowUp}"); // wraps to the last
    expectActive(3);
    await user.keyboard("{ArrowDown}"); // and round to the first
    expectActive(0);
  });

  it("starts from the last option when the first arrow pressed is ArrowUp", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    const options = await screen.findAllByRole("option");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", options[3].id);
  });

  it("drops the active option when the text changes", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant");
    await user.keyboard("-");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(optionLabels()).toEqual(["MV2-Room-1"]);
  });

  it("opens the second hit on Enter after two ArrowDowns, then clears the box, closes, and moves the focus to main", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    expect(optionLabels()).toEqual(MV2_HITS);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(where()).toBe("/assets/7"); // MV2-Room-1
    expect(input).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("main")).toHaveFocus();
  });

  it("opens a page on Enter too", async () => {
    const { user, input } = await mount();
    await user.type(input, "bill");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(where()).toBe("/billing");
    expect(input).toHaveValue("");
  });

  it("does nothing on Enter while no option is active", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    await user.keyboard("{Enter}");
    expect(where()).toBe("/start");
    expect(input).toHaveValue("mv2");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("closes on the first Escape and keeps the text, then clears it on the second", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveValue("mv2");
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}"); // nothing left to do
    expect(input).toHaveValue("");
  });

  it("consumes Escape, so the browser does not clear a search field on the first press as well", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false); // false: preventDefault was called
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("mv2");
  });

  it("closes the No match line on Escape too", async () => {
    const { user, input } = await mount();
    await user.type(input, "qzqzqz");
    await screen.findByRole("status");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(input).toHaveValue("qzqzqz");
  });

  it("opens again on an arrow after Escape, with the first (or last) option active, and on typing", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}{ArrowDown}");
    const options = await screen.findAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    await user.keyboard("{Escape}{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", (await screen.findAllByRole("option"))[3].id);
    await user.keyboard("{Escape}-");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("closes when the text is deleted", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    await user.clear(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("QuickFind Ctrl+K", () => {
  it.each([
    ["Ctrl+K", "{Control>}k{/Control}"],
    ["Cmd+K", "{Meta>}k{/Meta}"],
    ["Ctrl+K with caps lock", "{Control>}K{/Control}"],
  ])("%s focuses the field from anywhere", async (_name, keys) => {
    const { user, input } = await mount();
    await user.click(screen.getByRole("button", { name: "before" }));
    expect(input).not.toHaveFocus();
    await user.keyboard(keys);
    expect(input).toHaveFocus();
  });

  it("selects what is in the field, and opens the popup for it", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "after" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("reopens a popup that Escape closed while the field kept the focus", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("consumes the shortcut, so the browser does not take it", async () => {
    await mount();
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(document.body, { key: "k", metaKey: true })).toBe(false);
  });

  it("leaves other chords alone", async () => {
    const { input } = await mount();
    expect(fireEvent.keyDown(document.body, { key: "k" })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true, shiftKey: true })).toBe(true); // the console in Firefox
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true, altKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "j", ctrlKey: true })).toBe(true);
    expect(input).not.toHaveFocus();
  });

  it("does nothing while a modal dialog is open, so the form behind it keeps the focus", async () => {
    const dialog = (
      <div role="dialog" aria-modal="true" aria-label="Edit thing">
        <input type="text" aria-label="Thing field" />
      </div>
    );
    const { user, input } = await mount({ extra: dialog });
    const field = screen.getByRole("textbox", { name: "Thing field" });
    await user.click(field);
    await user.keyboard("{Control>}k{/Control}");
    expect(field).toHaveFocus();
    expect(input).not.toHaveFocus();
    expect(fireEvent.keyDown(field, { key: "k", ctrlKey: true })).toBe(true); // not consumed either
  });
});

describe("QuickFind pointer and focus", () => {
  it("opens the hit that is clicked, clears the box and closes", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await user.click(await screen.findByRole("option", { name: "LV Panel 2 Site / MV2" }));
    expect(where()).toBe("/assets/6");
    expect(input).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.getElementById("main")).toHaveFocus();
  });

  it("opens a clicked page", async () => {
    const { user, input } = await mount();
    await user.type(input, "dash");
    await user.click(await screen.findByRole("option", { name: "Dashboards" }));
    expect(where()).toBe("/dashboards");
  });

  it("keeps the focus in the field on a mouse press on an option, so the click is not lost to the blur", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    const option = (await screen.findAllByRole("option"))[0];
    expect(fireEvent.mouseDown(option)).toBe(false); // false: preventDefault was called
    expect(input).toHaveFocus();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("closes when the focus leaves with Tab, and comes back with the text when it returns", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    await user.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(document.getElementById("quick-find-list")).toBeNull();
    expect(input).toHaveValue("mv2");
    await user.tab({ shift: true });
    expect(input).toHaveFocus();
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("closes on a press outside, even while the field still has the focus", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    await screen.findByRole("listbox");
    fireEvent.pointerDown(screen.getByRole("button", { name: "after" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("mv2");
  });

  it("stays open on a press inside it", async () => {
    const { user, input } = await mount();
    await user.type(input, "mv2");
    const list = await screen.findByRole("listbox");
    fireEvent.pointerDown(input);
    fireEvent.pointerDown(list);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});
