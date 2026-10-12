import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { ProfileMenu } from "./ProfileMenu";

const SESSION: Routes = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "admin", role: "admin", preferences: { mode: "light", theme: "navy-gold" } } },
  "POST /api/logout": { status: 204 },
  "PUT /api/me/preferences": { body: { mode: "light", theme: "navy-gold" } },
};

/** The menu in a banner, with a focusable button after it (the place Tab goes when it leaves the widget). */
async function mount(routes: Routes = {}) {
  const calls = mockFetch({ ...SESSION, ...routes });
  const view = renderWithProviders(
    <>
      <header><ProfileMenu /></header>
      <button type="button">after</button>
    </>,
    { route: "/assets" },
  );
  const trigger = await screen.findByRole("button", { name: /admin/ });
  const panel = () => document.getElementById("profile-panel") as HTMLElement;
  return { calls, trigger, panel, view };
}
const logouts = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/logout");
/** Logout requests sent so far, counted at the fetch itself, so one that `holdFetch` still holds back is counted too. */
const logoutsSent = () => vi.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => String(url) === "/api/logout" && init?.method === "POST");

describe("ProfileMenu trigger", () => {
  it("is named by its text alone: the user, then the role, and no aria-label", async () => {
    const { trigger } = await mount();
    expect(trigger).toHaveAccessibleName("admin Administrator");
    expect(trigger).not.toHaveAttribute("aria-label");
    expect(trigger).not.toHaveAttribute("aria-labelledby");
    expect(trigger).not.toHaveAccessibleName(/name|user|asset/i); // Playwright matches label names by substring
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", "profile-panel");
    expect(trigger).not.toHaveAttribute("aria-haspopup"); // the panel is a disclosure, not a menu
  });

  it("is the only element with the class who, and the panel is not a menu", async () => {
    const { trigger, panel } = await mount();
    expect(document.querySelectorAll(".who")).toHaveLength(1);
    expect(document.querySelector(".who")).toBe(trigger);
    await userEvent.click(trigger);
    expect(panel().querySelector(".who")).toBeNull();
    expect(panel().querySelector(".prof-head")).not.toBeNull();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("writes the role out in words", async () => {
    mockFetch({ ...SESSION, "GET /api/me": { body: { id: 2, username: "pat", role: "viewer", preferences: { mode: "light", theme: "navy-gold" } } } });
    renderWithProviders(<ProfileMenu />, { route: "/assets" });
    expect(await screen.findByRole("button", { name: "pat Viewer" })).toBeInTheDocument();
  });
});

describe("ProfileMenu panel", () => {
  it("is in the page but hidden while closed, and opens and closes with the trigger", async () => {
    const { trigger, panel } = await mount();
    expect(panel()).toHaveAttribute("hidden");
    expect(screen.queryByRole("link", { name: "Password" })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel()).not.toHaveAttribute("hidden");
    expect(trigger).toHaveFocus(); // a click opens it without taking the focus away
    expect(panel().querySelector(".prof-head")).toHaveTextContent("adminAdministrator");
    expect(screen.getByRole("link", { name: "Password" })).toHaveAttribute("href", "/password");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toHaveAttribute("hidden");
  });

  it("Escape closes it and puts the focus on the trigger, from the trigger or from an item", async () => {
    const { trigger, panel } = await mount();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(panel()).toHaveAttribute("hidden");
    expect(trigger).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("link", { name: "Password" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(panel()).toHaveAttribute("hidden");
    expect(trigger).toHaveFocus();
  });

  it("closes on a pointer press outside it, without moving the focus, but not on one inside it", async () => {
    const { trigger, panel } = await mount();
    await userEvent.click(trigger);
    fireEvent.pointerDown(trigger); // the trigger is part of the widget
    fireEvent.pointerDown(panel().querySelector(".prof-head") as HTMLElement);
    expect(panel()).not.toHaveAttribute("hidden");
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toHaveAttribute("hidden");
    expect(trigger).toHaveFocus();
  });

  it("closes when the focus leaves the widget, and stays open while it moves inside it", async () => {
    const { trigger, panel } = await mount();
    await userEvent.click(trigger);
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Light" })).toHaveFocus(); // one stop per group: the checked radio
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Navy and gold" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Password" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Sign out" })).toHaveFocus();
    expect(panel()).not.toHaveAttribute("hidden");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
    expect(panel()).toHaveAttribute("hidden");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when a click lands on another control", async () => {
    const { trigger, panel } = await mount();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "after" }));
    expect(panel()).toHaveAttribute("hidden");
  });

  it("ArrowDown on the trigger opens it on the first item; ArrowDown and ArrowUp wrap around the two items", async () => {
    const { trigger, panel } = await mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(panel()).not.toHaveAttribute("hidden");
    expect(panel()).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const password = screen.getByRole("link", { name: "Password" });
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(password).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(signOut).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(password).toHaveFocus(); // wraps to the top
    await userEvent.keyboard("{ArrowUp}");
    expect(signOut).toHaveFocus(); // and to the bottom
    await userEvent.keyboard("{ArrowUp}");
    expect(password).toHaveFocus();
  });

  it("choosing Password closes it, and the focus goes to the trigger", async () => {
    const { trigger, panel } = await mount();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("link", { name: "Password" }));
    expect(panel()).toHaveAttribute("hidden");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });
});

describe("ProfileMenu appearance", () => {
  const radios = (group: string) => within(screen.getByRole("group", { name: group })).getAllByRole("radio");
  const names = (list: HTMLElement[]) => list.map((radio) => radio.closest("label")?.textContent);
  /** A server that keeps what it was sent and answers the whole, as PUT /api/me/preferences does. */
  const savingServer = (): Routes => {
    const stored: Record<string, unknown> = { mode: "light", theme: "navy-gold" };
    return { "PUT /api/me/preferences": ({ body }) => ({ body: Object.assign(stored, body) }) };
  };
  const puts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "PUT" && c.path === "/api/me/preferences").map((c) => c.body);

  it("holds a Mode group and a Theme colour group between the name block and Password, under exactly those two legends", async () => {
    const { trigger, panel } = await mount();
    await userEvent.click(trigger);
    const groups = Array.from(panel().querySelectorAll("fieldset.prof-group"));
    expect(groups.map((group) => group.querySelector("legend")?.textContent)).toEqual(["Mode", "Theme colour"]);
    const order = Array.from(panel().children);
    expect(order.indexOf(panel().querySelector(".prof-head") as Element)).toBeLessThan(order.indexOf(groups[0]));
    expect(order.indexOf(groups[1])).toBeLessThan(order.indexOf(panel().querySelector("a[href='/password']") as Element));
    expect(panel()).not.toHaveTextContent(/appearance/i); // the two legends are the only words
    expect(screen.getByRole("group", { name: "Mode" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Theme colour" })).toBeInTheDocument();
  });

  it("names the radios exactly, in order, and checks the account's choice", async () => {
    const { trigger } = await mount();
    await userEvent.click(trigger);
    expect(names(radios("Mode"))).toEqual(["Light", "Dark", "Match my device"]);
    expect(names(radios("Theme colour"))).toEqual(["Navy and gold", "Maroon and gold", "Graphite", "Desert gold"]);
    for (const label of ["Light", "Dark", "Match my device", "Navy and gold", "Maroon and gold", "Graphite", "Desert gold"]) {
      expect(screen.getByRole("radio", { name: label })).toHaveAccessibleName(label);
    }
    expect(radios("Mode").map((radio) => (radio as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(radios("Theme colour").map((radio) => (radio as HTMLInputElement).checked)).toEqual([true, false, false, false]);
  });

  it("builds each row as a label with the check class: the radio first, then (themes only) a decorative swatch, then the text", async () => {
    const { trigger } = await mount();
    await userEvent.click(trigger);
    const modeNames = new Set(radios("Mode").map((radio) => (radio as HTMLInputElement).name));
    const themeNames = new Set(radios("Theme colour").map((radio) => (radio as HTMLInputElement).name));
    expect(modeNames.size).toBe(1); // one name per group, so the arrow keys walk the group
    expect(themeNames.size).toBe(1);
    expect([...modeNames][0]).not.toBe([...themeNames][0]);
    for (const radio of [...radios("Mode"), ...radios("Theme colour")]) {
      const label = radio.closest("label") as HTMLElement;
      expect(label).toHaveClass("prof-opt", "check");
      expect(label.firstElementChild).toBe(radio);
    }
    for (const radio of radios("Mode")) expect(radio.closest("label")?.querySelector(".swatch")).toBeNull();
    const maroon = screen.getByRole("radio", { name: "Maroon and gold" }).closest("label") as HTMLElement;
    const swatch = maroon.querySelector(".swatch") as HTMLElement;
    expect(swatch).toHaveAttribute("aria-hidden", "true");
    expect(swatch.previousElementSibling).toBe(screen.getByRole("radio", { name: "Maroon and gold" }));
    expect(swatch.style.getPropertyValue("--sw-bg")).toBe("#7d0849");
    expect(swatch.style.getPropertyValue("--sw-dot")).toBe("#deb406");
    expect(swatch).toHaveTextContent("");
  });

  it("choosing a radio applies it, saves only that key, and never closes the panel", async () => {
    const { calls, trigger, panel } = await mount(savingServer());
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    expect(panel()).not.toHaveAttribute("hidden");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(puts(calls)).toEqual([{ mode: "dark" }]));
    await userEvent.click(screen.getByRole("radio", { name: "Graphite" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("graphite");
    expect(panel()).not.toHaveAttribute("hidden");
    await waitFor(() => expect(puts(calls)).toEqual([{ mode: "dark" }, { theme: "graphite" }]));
  });

  it("the arrow keys change the selection inside a group, keep the focus there, and are not taken by the panel's own walk", async () => {
    const { calls, trigger, panel } = await mount(savingServer());
    await userEvent.click(trigger);
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Light" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Match my device" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Light" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(panel()).not.toHaveAttribute("hidden");
    await waitFor(() => expect(puts(calls).length).toBeGreaterThan(0));
    expect(puts(calls)[0]).toEqual({ mode: "dark" });
  });

  it("Escape from a radio closes the panel and puts the focus on the trigger; ArrowDown on the trigger still lands on Password", async () => {
    const { trigger, panel } = await mount();
    await userEvent.click(trigger);
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Light" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(panel()).toHaveAttribute("hidden");
    expect(trigger).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("link", { name: "Password" })).toHaveFocus();
  });

  it("shows no error line until a save fails, then one alert under the Theme colour group; the next good save clears it", async () => {
    let fail = true;
    const { trigger } = await mount({
      "PUT /api/me/preferences": () => (fail ? { status: 500, body: { detail: "boom" } } : { body: { mode: "light", theme: "graphite" } }),
    });
    await userEvent.click(trigger);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Graphite" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not saved. Check the connection and try again.");
    expect(alert.tagName).toBe("P");
    expect(alert).toHaveClass("error");
    expect(screen.getByRole("group", { name: "Theme colour" })).toContainElement(alert);
    expect(screen.getByRole("radio", { name: "Navy and gold" })).toBeChecked(); // put back
    fail = false;
    await userEvent.click(screen.getByRole("radio", { name: "Graphite" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Graphite" })).toBeChecked();
  });
});

describe("Sign out confirmation", () => {
  const openDialog = async (trigger: HTMLElement) => {
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    return screen.findByRole("dialog", { name: "Sign out of DC Dashboard?" });
  };

  it("asks first: the panel closes, a modal dialog opens outside the banner, and no request is sent", async () => {
    const { calls, trigger, panel, view } = await mount();
    const dialog = await openDialog(trigger);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("You will need to sign in again.");
    expect(panel()).toHaveAttribute("hidden");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(view.container.contains(dialog)).toBe(false); // portalled to the body, out of the header and out of the bar's stacking context
    expect(dialog.closest("header")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    const confirm = within(dialog).getByRole("button", { name: "Sign out" });
    expect(confirm).toHaveClass("primary");
    expect(confirm).not.toHaveClass("danger"); // signing out is not destructive
    expect(logouts(calls)).toHaveLength(0);
  });

  it("can be reached and answered from the keyboard", async () => {
    const { calls, trigger } = await mount();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Sign out of DC Dashboard?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "Sign out" })).toHaveFocus();
    screen.getByRole("button", { name: "after" }).focus(); // trapped: a focus that lands outside goes back to the first control
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(logouts(calls)).toHaveLength(0);
  });

  it("keeps Tab inside: from the last button it wraps to the first, Shift+Tab from the first wraps to the last, and focus never reaches the body", async () => {
    const { calls, trigger } = await mount();
    const dialog = await openDialog(trigger);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const signOut = within(dialog).getByRole("button", { name: "Sign out" });
    expect(cancel).toHaveFocus();
    const stays = () => {
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    };
    await userEvent.tab();
    expect(signOut).toHaveFocus();
    await userEvent.tab(); // past the last control
    stays();
    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true }); // back past the first control
    stays();
    expect(signOut).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(cancel).toHaveFocus();
    expect(logouts(calls)).toHaveLength(0);
  });

  it("wraps Tab itself rather than leaving it to the browser (the dialog is the last thing in the body, so the browser would take the focus away)", async () => {
    const { trigger } = await mount();
    const dialog = await openDialog(trigger);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const signOut = within(dialog).getByRole("button", { name: "Sign out" });
    signOut.focus();
    expect(fireEvent.keyDown(signOut, { key: "Tab" })).toBe(false); // default prevented: the dialog moved the focus
    expect(cancel).toHaveFocus();
    expect(fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true })).toBe(false);
    expect(signOut).toHaveFocus();
    cancel.focus();
    expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(true); // not at an edge: the browser moves on by itself
  });

  it("Cancel keeps the session and gives the focus back to the trigger", async () => {
    const { calls, trigger } = await mount();
    const dialog = await openDialog(trigger);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("login page")).not.toBeInTheDocument();
    expect(logouts(calls)).toHaveLength(0);
  });

  it("Escape keeps the session and gives the focus back to the trigger", async () => {
    const { calls, trigger } = await mount();
    await openDialog(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.queryByText("login page")).not.toBeInTheDocument();
    expect(logouts(calls)).toHaveLength(0);
  });

  it("confirming sends one POST /api/logout, even on a double click, and lands on the sign-in page", async () => {
    const { calls, trigger } = await mount();
    const gate = holdFetch((method, path) => method === "POST" && path === "/api/logout");
    const dialog = await openDialog(trigger);
    const confirm = within(dialog).getByRole("button", { name: "Sign out" });
    await userEvent.dblClick(confirm);
    expect(logoutsSent()).toHaveLength(1);
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}"); // not while the request is in flight
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    gate.release();
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(logoutsSent()).toHaveLength(1);
    expect(logouts(calls)).toHaveLength(1);
  });

  it("shows why the request failed, keeps the dialog and the session, and can be tried again", async () => {
    const { calls, trigger } = await mount({ "POST /api/logout": { status: 500, body: { detail: "server is busy" } } });
    const dialog = await openDialog(trigger);
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("server is busy");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.queryByText("login page")).not.toBeInTheDocument();
    expect(trigger).toBeInTheDocument(); // still signed in
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(logouts(calls)).toHaveLength(2));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
