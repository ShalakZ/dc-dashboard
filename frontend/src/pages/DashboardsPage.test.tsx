import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { formatSiteDateTime } from "../lib/siteTime";
import { authed, dashboard, templateCards, templatesBody } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import type { ToastApi } from "../components/Toasts";
import type { PermissionId } from "../lib/permissions";
import { DashboardsPage } from "./DashboardsPage";

const items = [
  { id: 3, name: "Hall A", range: "24h", widget_count: 2, updated_at: "2026-10-08T06:00:00+00:00" },
  { id: 4, name: "Hall B", range: "7d", widget_count: 0, updated_at: "2026-10-07T10:30:00+00:00" },
];

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}|${JSON.stringify(location.state)}`}</output>;
}
/** `hold` keeps back the requests it matches until `release()` (installed before the page mounts, so none gets through). */
function open(role: string, over: Routes = {}, hold?: (method: string, path: string) => boolean, toasts?: ToastApi) {
  const calls = mockFetch({ ...authed(role), "GET /api/dashboards": { body: items }, "GET /api/dashboards/default": { body: { dashboard_id: null } }, ...over });
  const held = hold ? holdFetch(hold) : { release: () => {} };
  renderWithProviders(<><DashboardsPage /><Probe /><SignedIn /></>, { route: "/dashboards", path: "*", toasts });
  return Object.assign(calls, { release: held.release });
}

describe("DashboardsPage", () => {
  it("lists dashboards by name with widget count and last update in the site zone", async () => {
    open("viewer");
    const first = (await screen.findByRole("link", { name: "Hall A" })).closest("tr")!;
    expect(screen.getByRole("link", { name: "Hall A" })).toHaveAttribute("href", "/dashboards/3");
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["Hall A", "Hall B"]);
    expect(within(first).getByText("2")).toBeInTheDocument();
    expect(within(first).getByText(formatSiteDateTime(items[0].updated_at, "Asia/Qatar"))).toBeInTheDocument();
    const second = screen.getByRole("link", { name: "Hall B" }).closest("tr")!;
    expect(within(second).getByText(formatSiteDateTime(items[1].updated_at, "Asia/Qatar"))).toBeInTheDocument();
  });

  it("gives a viewer no create or delete controls", async () => {
    open("viewer");
    await screen.findByRole("link", { name: "Hall A" });
    expect(screen.queryByRole("button", { name: "New dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("gives an operator two controls per row: the menu (Make a copy only) and the trash button named for the dashboard", async () => {
    open("operator");
    await screen.findByRole("link", { name: "Hall A" });
    const row = screen.getByRole("link", { name: "Hall A" }).closest("tr")!;
    const trash = within(row).getByRole("button", { name: "Delete Hall A" });
    expect(trash).toHaveClass("trash-btn");
    const menu = within(row).getByRole("button", { name: "Actions for Hall A" });
    expect(within(row).getAllByRole("button")).toEqual([menu, trash]);
    await userEvent.click(menu);
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Make a copy"]); // the default is the Choose-the-default permission's
  });

  it("deletes from the keyboard: Enter on the trash button asks first, in the styled dialog (the browser's own box is never asked)", async () => {
    const browserBox = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = open("operator");
    await screen.findByRole("link", { name: "Hall A" });
    screen.getByRole("button", { name: "Delete Hall A" }).focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: 'Delete dashboard "Hall A"?' });
    expect(dialog).toHaveTextContent("Its widgets go with it.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(browserBox).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Delete Hall A" })).toHaveFocus(); // back where it was
  });

  it("lets an operator create a dashboard and opens it in edit mode", async () => {
    const toasts = spyToasts();
    const calls = open("operator", { "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Hall C", range: "7d" }) } }, undefined, toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
    const dialog = screen.getByRole("dialog", { name: "New dashboard" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Blank" })); // the first step is the gallery
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Create" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(screen.getByLabelText("Name"), "Hall C");
    await userEvent.selectOptions(screen.getByLabelText("Range"), "7d");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent('/dashboards/9|{"edit":true}'));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Hall C", range: "7d" });
    expect(toasts.calls).toEqual([{ kind: "success", text: "Dashboard created" }]); // the page opens in edit mode, but nothing there says it was made
  });

  it("keeps the dialog open with the server's message when the name is taken, and Escape closes it", async () => {
    const toasts = spyToasts();
    open("operator", { "POST /api/dashboards": { status: 409, body: { detail: "a dashboard with this name already exists" } } }, undefined, toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "New dashboard" })).getByRole("button", { name: "Blank" }));
    await userEvent.type(screen.getByLabelText("Name"), "Hall A");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("dialog", { name: "New dashboard" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toasts.calls).toEqual([]);
  });

  it("deletes after confirmation, refreshes the list and raises one toast; Cancel deletes nothing and raises none", async () => {
    let deleted = false;
    const toasts = spyToasts();
    const calls = open("operator", {
      "GET /api/dashboards": () => ({ body: deleted ? [items[1]] : items }),
      "DELETE /api/dashboards/3": () => { deleted = true; return { status: 204 }; },
    }, undefined, toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Hall A" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: 'Delete dashboard "Hall A"?' })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(toasts.calls).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Delete Hall A" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: 'Delete dashboard "Hall A"?' })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Hall A" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Hall B" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toasts.calls).toEqual([{ kind: "success", text: 'Dashboard "Hall A" deleted' }]);
  });

  it("a delete the server refuses is shown above the list and raises no toast", async () => {
    const toasts = spyToasts();
    open("operator", { "DELETE /api/dashboards/3": { status: 404, body: { detail: "dashboard not found" } } }, undefined, toasts.api);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Hall A" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: 'Delete dashboard "Hall A"?' })).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
    expect(toasts.calls).toEqual([]);
  });

  describe("the default dashboard", () => {
    const withDefault = { "GET /api/dashboards/default": { body: { dashboard_id: 3 } } };

    it("marks the default row with a Default badge beside the name link, not inside it", async () => {
      open("viewer", withDefault);
      const link = await screen.findByRole("link", { name: "Hall A" });
      const badge = within(link.closest("tr")!).getByText("Default");
      await waitFor(() => expect(badge).toBeInTheDocument());
      expect(link).not.toContainElement(badge);
      expect(link).toHaveAccessibleName("Hall A");
      expect(within(screen.getByRole("link", { name: "Hall B" }).closest("tr")!).queryByText("Default")).not.toBeInTheDocument();
    });

    it("shows no badge when none is set", async () => {
      open("viewer");
      await screen.findByRole("link", { name: "Hall A" });
      expect(screen.queryByText("Default")).not.toBeInTheDocument();
    });

    it("gives an administrator a menu per row: Make default on others, Clear default on the default", async () => {
      open("admin", withDefault);
      await userEvent.click(await screen.findByRole("button", { name: "Actions for Hall B" }));
      expect(screen.getByRole("menuitem", { name: "Make default" })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "Actions for Hall A" }));
      expect(await screen.findByRole("menuitem", { name: "Clear default" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Make default" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete Hall A" })).toBeInTheDocument(); // the trash stays
    });

    it("sends the id when making a default, and null when clearing it, and shows the badge move", async () => {
      let current: number | null = null;
      const toasts = spyToasts();
      const calls = open("admin", {
        "GET /api/dashboards/default": () => ({ body: { dashboard_id: current } }),
        "PUT /api/dashboards/default": ({ body }) => {
          current = (body as { dashboard_id: number | null }).dashboard_id;
          return { body: { dashboard_id: current } };
        },
      }, undefined, toasts.api);
      await userEvent.click(await screen.findByRole("button", { name: "Actions for Hall B" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
      expect(await within(screen.getByRole("link", { name: "Hall B" }).closest("tr")!).findByText("Default")).toBeInTheDocument();
      expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ dashboard_id: 4 }]);
      await userEvent.click(screen.getByRole("button", { name: "Actions for Hall B" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Clear default" }));
      await waitFor(() => expect(screen.queryByText("Default")).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ dashboard_id: 4 }, { dashboard_id: null }]);
      expect(toasts.calls).toEqual([
        { kind: "success", text: '"Hall B" is now the default dashboard' },
        { kind: "success", text: "Default dashboard cleared" },
      ]);
    });

    it("shows the server's message when setting the default fails", async () => {
      const toasts = spyToasts();
      open("admin", { "PUT /api/dashboards/default": { status: 404, body: { detail: "dashboard not found" } } }, undefined, toasts.api);
      await userEvent.click(await screen.findByRole("button", { name: "Actions for Hall A" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
      expect(toasts.calls).toEqual([]);
    });

    it("keeps the default items from an operator, whose menu has Make a copy only", async () => {
      open("operator", withDefault);
      await screen.findByRole("link", { name: "Hall A" });
      await userEvent.click(screen.getByRole("button", { name: "Actions for Hall A" })); // Hall A is the default: the operator is offered no Clear default
      expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Make a copy"]);
    });

    it("warns when the dashboard to delete is the default, and only then", async () => {
      open("admin", withDefault);
      await waitFor(() => expect(screen.getByText("Default")).toBeInTheDocument()); // the default is known before the dialog is built from it
      await userEvent.click(await screen.findByRole("button", { name: "Delete Hall A" }));
      const first = await screen.findByRole("dialog", { name: 'Delete dashboard "Hall A"?' });
      expect(first).toHaveTextContent("Its widgets go with it. It is the default dashboard: nobody will land on it any more.");
      await userEvent.click(within(first).getByRole("button", { name: "Cancel" }));
      await userEvent.click(screen.getByRole("button", { name: "Delete Hall B" }));
      const second = await screen.findByRole("dialog", { name: 'Delete dashboard "Hall B"?' });
      expect(second).toHaveTextContent("Its widgets go with it.");
      expect(second).not.toHaveTextContent("default dashboard");
    });
  });

  it("keeps the Dashboards heading while loading and when the list cannot be loaded", async () => {
    open("viewer", { "GET /api/dashboards": { status: 500, body: { detail: "list failed" } } });
    expect(screen.getByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("list failed");
    expect(screen.getByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull(); // the error replaces the skeleton
  });

  describe("while the list loads", () => {
    const LABEL = "Loading dashboards";
    const skeletonColumns = () => document.querySelectorAll(".sk-table thead th").length;

    it("shows the heading and a table skeleton with the list held, then the list and no region", async () => {
      const page = open("viewer", {}, (_method, path) => path === "/api/dashboards");
      expect(screen.getByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
      expect(screen.getByText(LABEL).parentElement).toHaveAttribute("role", "status"); // (the page's Probe output is a status too: find the region by its class)
      expect(skeletonColumns()).toBe(3);
      expect(document.querySelectorAll(".sk-table tbody tr")).toHaveLength(4);
      expect(screen.queryByText("loading…")).not.toBeInTheDocument();
      expect(screen.queryByRole("row")).not.toBeInTheDocument(); // the placeholder rows are not in the accessibility tree
      page.release();
      expect(await screen.findByRole("link", { name: "Hall A" })).toBeInTheDocument();
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
      expect(document.querySelector(".sk-region")).toBeNull();
    });

    it("has the Actions column for someone who can edit", async () => {
      const page = open("operator", {}, (_method, path) => path === "/api/dashboards");
      await waitFor(() => expect(skeletonColumns()).toBe(4)); // (the role arrives with /api/me, a moment after the first render)
      expect(screen.getByText(LABEL)).toBeInTheDocument();
      page.release();
      await screen.findByRole("link", { name: "Hall A" });
    });

    it("keeps the skeleton until the site zone is in as well", async () => {
      const calls = open("viewer", {}, (_method, path) => path === "/api/site");
      await waitFor(() => expect(calls.some((c) => c.path === "/api/dashboards")).toBe(true));
      await new Promise((r) => setTimeout(r, 30)); // the list has answered by now
      expect(screen.getByText(LABEL)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Hall A" })).not.toBeInTheDocument();
      calls.release();
      expect(await screen.findByRole("link", { name: "Hall A" })).toBeInTheDocument();
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    });

    it("ends with the empty state when there are no dashboards, no region left", async () => {
      open("viewer", { "GET /api/dashboards": { body: [] } });
      expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
      expect(document.querySelector(".sk-region")).toBeNull();
    });
  });

  it("shows an empty state, with a hint only for those who can create", async () => {
    open("viewer", { "GET /api/dashboards": { body: [] } });
    expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
  });

  it("tells an operator how to start", async () => {
    open("operator", { "GET /api/dashboards": { body: [] } });
    expect(await screen.findByText("No dashboards yet. Create one to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
  });

  describe("the empty page shows the template gallery (w27)", () => {
    const empty = { "GET /api/dashboards": { body: [] } };
    const CREATED = { "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Created", range: "this_month" }) } };
    const asked = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.path === "/api/dashboard-templates");
    /** The inline gallery's own cards (the dialog, when it is open, holds another set). */
    const inline = () => document.querySelector<HTMLElement>(".tpl-inline")!;
    const cardsOf = (scope: HTMLElement) => within(scope).getAllByRole("button").map((b) => b.getAttribute("data-template"));

    it("gives a viewer today's text only: no card, no button and no request for the templates", async () => {
      const calls = open("viewer", empty);
      expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "More templates" })).not.toBeInTheDocument();
      await accountKnown();
      expect(asked(calls)).toEqual([]);
    });

    it("an editor's page shows the cards under the sentence, Recommended first and Blank last, beside the header's New dashboard, which stays", async () => {
      open("operator", empty);
      expect(await screen.findByText("No dashboards yet. Create one to get started.")).toBeInTheDocument();
      await screen.findByRole("button", { name: "Power" });
      expect(cardsOf(inline())).toEqual(["power", "cost", "areas", "day", "blank"]);
      expect(within(within(inline()).getByRole("region", { name: "Recommended for this site" })).getAllByRole("button")).toHaveLength(3);
      expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Recommended for this site", "More templates"]);
      expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
      expect(screen.getAllByRole("button").map((b) => b.getAttribute("data-template") ?? b.textContent)).toEqual(["New dashboard", "power", "cost", "areas", "day", "blank"]);
      expect(screen.queryByRole("button", { name: /^Start/ })).not.toBeInTheDocument();
    });

    it("dashboards.edit alone sees the cards, dashboards.default alone does not and asks for nothing", async () => {
      const calls = open("custom", { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view", "dashboards.default"] }) }, ...empty });
      expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
      await accountKnown();
      expect(screen.queryByRole("button", { name: "Blank" })).not.toBeInTheDocument();
      expect(asked(calls)).toEqual([]);
    });

    it("a card opens step 2 of the dialog with its range, Create sends the recipe, and the page opens in view mode", async () => {
      const calls = open("operator", { ...empty, ...CREATED });
      await userEvent.click(await screen.findByRole("button", { name: "Power" }));
      const dialog = screen.getByRole("dialog", { name: "New dashboard" });
      expect(within(dialog).queryByRole("heading", { name: "Choose a template" })).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("Range")).toHaveValue("this_month");
      expect(within(dialog).getByLabelText("Name")).toHaveFocus();
      expect(within(dialog).getByLabelText("Name")).toHaveAttribute("placeholder", "Power");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboards/9|null"));
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Power", range: "this_month", recipe: "power" });
    });

    it("the Blank card opens step 2 and, with a name, makes a blank dashboard in edit mode", async () => {
      const calls = open("operator", { ...empty, ...CREATED });
      await userEvent.click(await screen.findByRole("button", { name: "Blank" }));
      const dialog = screen.getByRole("dialog", { name: "New dashboard" });
      expect(within(dialog).getByLabelText("Range")).toHaveValue("24h");
      await userEvent.type(within(dialog).getByLabelText("Name"), "Hall D");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent('/dashboards/9|{"edit":true}'));
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Hall D", range: "24h" });
    });

    it("Escape puts the focus back on the card, Back to templates shows the dialog's own gallery, and the header's New dashboard opens on that step", async () => {
      open("operator", empty);
      const power = await screen.findByRole("button", { name: "Power" });
      await userEvent.click(power);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(power).toHaveFocus();
      await userEvent.click(power);
      await userEvent.click(within(screen.getByRole("dialog", { name: "New dashboard" })).getByRole("button", { name: "Back to templates" }));
      const dialog = screen.getByRole("dialog", { name: "New dashboard" });
      expect(within(dialog).getByRole("heading", { name: "Choose a template" })).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Power" })).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "New dashboard" }));
      expect(within(screen.getByRole("dialog", { name: "New dashboard" })).getByRole("heading", { name: "Choose a template" })).toBeInTheDocument();
    });

    it("tells an editor that nothing is metered, with no tag, when the server says so", async () => {
      open("operator", { ...empty, "GET /api/dashboard-templates": { body: templatesBody({ nothing_metered: true, templates: templateCards().map((t) => ({ ...t, recommended: false })) }) } });
      expect(await screen.findByText("Nothing is metered yet, so every template shows no data until a meter is mapped.")).toBeInTheDocument();
      expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
    });

    it("when the templates cannot be read, says so in a sentence and the Blank card still works", async () => {
      open("operator", { ...empty, "GET /api/dashboard-templates": { status: 500, body: { detail: "boom" } } });
      expect(await screen.findByText("The templates could not be loaded. A blank dashboard still works.")).toBeInTheDocument();
      expect(cardsOf(inline())).toEqual(["blank"]);
      await userEvent.click(screen.getByRole("button", { name: "Blank" }));
      expect(within(screen.getByRole("dialog", { name: "New dashboard" })).getByLabelText("Name")).toHaveFocus();
    });

    it("a page that lists dashboards gets no inline cards", async () => {
      open("operator");
      await screen.findByRole("link", { name: "Hall A" });
      expect(document.querySelector(".tpl-inline")).toBeNull();
      expect(screen.queryByRole("button", { name: "Blank" })).not.toBeInTheDocument();
    });
  });
});

describe("DashboardsPage controls follow the permissions of the role (a custom role)", () => {
  const withDefault = { "GET /api/dashboards/default": { body: { dashboard_id: 3 } } };
  /** A role called "custom" that holds dashboards.view and `permissions`; the account is known when this returns. */
  const show = async (permissions: PermissionId[], over: Routes = {}) => {
    const calls = open("custom", { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view", ...permissions] }) }, ...over });
    await screen.findByRole("link", { name: "Hall A" });
    await accountKnown();
    return calls;
  };

  it("dashboards.view alone: no New dashboard, no Actions column, no trash, no menu", async () => {
    await show([], withDefault);
    expect(screen.queryByRole("button", { name: "New dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
  });

  /** The labels of the items in the open menu of a row. */
  const menuItems = async (dashboardName: string) => {
    await userEvent.click(screen.getByRole("button", { name: `Actions for ${dashboardName}` }));
    const labels = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    await userEvent.keyboard("{Escape}");
    return labels;
  };

  it("dashboards.edit alone: New dashboard, the trash and a menu with Make a copy only (no default item)", async () => {
    await show(["dashboards.edit"], withDefault);
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Hall A" })).toBeInTheDocument();
    expect(await menuItems("Hall A")).toEqual(["Make a copy"]); // Hall A is the default, yet nobody here may clear it
    expect(await menuItems("Hall B")).toEqual(["Make a copy"]);
  });

  it("dashboards.default alone: the Make default menu per row, and nothing that creates or deletes", async () => {
    const calls = await show(["dashboards.default"], { ...withDefault, "PUT /api/dashboards/default": { body: { dashboard_id: 4 } } });
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    expect(await menuItems("Hall A")).toEqual(["Clear default"]); // no Make a copy: that is dashboards.edit's
    await userEvent.click(screen.getByRole("button", { name: "Actions for Hall B" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Make default"]);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Make default" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ dashboard_id: 4 }]));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("both: the menu (Make a copy first, then the default item) and the trash on a row, and New dashboard (an administrator's page)", async () => {
    await show(["dashboards.edit", "dashboards.default"], withDefault);
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Hall A" })).toBeInTheDocument();
    expect(await menuItems("Hall A")).toEqual(["Make a copy", "Clear default"]);
    expect(await menuItems("Hall B")).toEqual(["Make a copy", "Make default"]);
  });

  it("neither (dashboards.view plus an unrelated permission): no menu, no trash, no Actions column", async () => {
    await show(["tariffs.view"], withDefault);
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it("the table skeleton has the Actions column for dashboards.edit alone", async () => {
    const page = open("custom", { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view", "dashboards.edit"] }) } }, (_method, path) => path === "/api/dashboards");
    await waitFor(() => expect(document.querySelectorAll(".sk-table thead th").length).toBe(4));
    page.release();
    await screen.findByRole("link", { name: "Hall A" });
  });

  it("the empty-state hint is for dashboards.edit only", async () => {
    open("custom", { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view", "dashboards.default"] }) }, "GET /api/dashboards": { body: [] } });
    expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
    await accountKnown();
    expect(screen.queryByText(/Create one to get started/)).not.toBeInTheDocument();
  });

  it("the table skeleton has the Actions column for dashboards.default alone", async () => {
    const page = open("custom", { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view", "dashboards.default"] }) } }, (_method, path) => path === "/api/dashboards");
    await waitFor(() => expect(document.querySelectorAll(".sk-table thead th").length).toBe(4));
    page.release();
    await screen.findByRole("link", { name: "Hall A" });
  });
});

describe("DashboardsPage: Make a copy in the row menu (w27)", () => {
  const copyOf = dashboard({ id: 9, name: "Hall A (copy)" });
  const copyListItem = { id: 9, name: "Hall A (copy)", range: "24h", widget_count: 2, updated_at: "2026-10-08T07:00:00+00:00" };
  const listCalls = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "GET" && c.path === "/api/dashboards").length;
  /** Opens the row's menu with the mouse and chooses an item. */
  const choose = async (dashboardName: string, item: string) => {
    await userEvent.click(await screen.findByRole("button", { name: `Actions for ${dashboardName}` }));
    await userEvent.click(await screen.findByRole("menuitem", { name: item }));
  };

  it("copies from the menu: one POST with no body, the list is read again and shows the copy, a toast names it, nobody is navigated away, and the focus is back on the menu button", async () => {
    let copied = false;
    const toasts = spyToasts();
    const calls = open("operator", {
      "GET /api/dashboards": () => ({ body: copied ? [...items, copyListItem] : items }),
      "POST /api/dashboards/3/copy": () => { copied = true; return { status: 201, body: copyOf }; },
    }, undefined, toasts.api);
    await choose("Hall A", "Make a copy");
    expect(await screen.findByRole("link", { name: "Hall A (copy)" })).toHaveAttribute("href", "/dashboards/9");
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/dashboards/3/copy", undefined]]);
    expect(listCalls(calls)).toBe(2);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Copied to Hall A (copy)" }]);
    expect(screen.getByTestId("location")).toHaveTextContent("/dashboards|null"); // still on the list, and the copy is not opened in edit mode
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for Hall A" })).toHaveFocus(); // the menu returns focus to its trigger before the action runs
  });

  it("copies by keyboard alone: Enter opens the menu on its first item, Enter chooses it, the focus stays on the menu button", async () => {
    const toasts = spyToasts();
    const calls = open("operator", { "POST /api/dashboards/4/copy": { status: 201, body: dashboard({ id: 9, name: "Hall B (copy)" }) } }, undefined, toasts.api);
    await screen.findByRole("link", { name: "Hall B" });
    screen.getByRole("button", { name: "Actions for Hall B" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Make a copy" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Copied to Hall B (copy)" }]));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/dashboards/4/copy"]);
    expect(screen.getByRole("button", { name: "Actions for Hall B" })).toHaveFocus();
  });

  it.each([
    [409, "a dashboard with this name already exists"],
    [422, "at most 50 dashboards"],
    [404, "dashboard not found"],
  ])("a copy the server refuses (%i) shows its sentence above the list, raises no toast, and the list is read again", async (status, detail) => {
    const toasts = spyToasts();
    const calls = open("operator", { "POST /api/dashboards/3/copy": { status, body: { detail } } }, undefined, toasts.api);
    await choose("Hall A", "Make a copy");
    expect(await screen.findByRole("alert")).toHaveTextContent(detail);
    expect(toasts.calls).toEqual([]);
    await waitFor(() => expect(listCalls(calls)).toBe(2)); // onSettled: the refusal means the list on screen may be out of date
    expect(screen.getByRole("link", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for Hall A" })).toHaveFocus();
  });

  it("a refusal is cleared by the next copy that works", async () => {
    let attempt = 0;
    const toasts = spyToasts();
    open("operator", {
      "POST /api/dashboards/3/copy": () => (++attempt === 1 ? { status: 409, body: { detail: "a dashboard with this name already exists" } } : { status: 201, body: copyOf }),
    }, undefined, toasts.api);
    await choose("Hall A", "Make a copy");
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    await choose("Hall A", "Make a copy");
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Copied to Hall A (copy)" }]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("while a copy is on its way, Make a copy is disabled in every row's menu (no second click makes a second copy)", async () => {
    const toasts = spyToasts();
    const page = open("operator", { "POST /api/dashboards/3/copy": { status: 201, body: copyOf } }, (method) => method === "POST", toasts.api);
    await choose("Hall A", "Make a copy");
    await userEvent.click(screen.getByRole("button", { name: "Actions for Hall B" }));
    expect(await screen.findByRole("menuitem", { name: "Make a copy" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    page.release();
    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Actions for Hall B" }));
    expect(await screen.findByRole("menuitem", { name: "Make a copy" })).toBeEnabled();
  });

  it("an administrator copies and makes the copy the default from the same menu", async () => {
    const toasts = spyToasts();
    const calls = open("admin", {
      "POST /api/dashboards/3/copy": { status: 201, body: copyOf },
      "PUT /api/dashboards/default": { body: { dashboard_id: 4 } },
    }, undefined, toasts.api);
    await choose("Hall A", "Make a copy");
    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    await choose("Hall B", "Make default");
    await waitFor(() => expect(toasts.calls.map((t) => t.text)).toEqual(["Copied to Hall A (copy)", '"Hall B" is now the default dashboard']));
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ dashboard_id: 4 }]);
  });
});
