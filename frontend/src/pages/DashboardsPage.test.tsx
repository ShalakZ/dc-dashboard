import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { formatSiteDateTime } from "../lib/siteTime";
import { authed, dashboard } from "../test/dashboardFixtures";
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

  it("gives an operator one control per row: the trash button named for the dashboard, with no menu", async () => {
    open("operator");
    await screen.findByRole("link", { name: "Hall A" });
    const row = screen.getByRole("link", { name: "Hall A" }).closest("tr")!;
    const trash = within(row).getByRole("button", { name: "Delete Hall A" });
    expect(trash).toHaveClass("trash-btn");
    expect(within(row).getAllByRole("button")).toEqual([trash]);
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument(); // no empty three-dot menu
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
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
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

    it("keeps the menu from an operator, who may only delete", async () => {
      open("operator", withDefault);
      await screen.findByRole("link", { name: "Hall A" });
      expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
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

  describe("the empty page offers a start (w25)", () => {
    const empty = { "GET /api/dashboards": { body: [] } };
    const POWER_BODY = { "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Power", range: "this_month" }) } };

    it("gives an editor Start blank and Start from Power under the sentence, and a viewer today's text only", async () => {
      open("viewer", empty);
      expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("an editor's page has the two buttons beside the header's New dashboard, which stays", async () => {
      open("operator", empty);
      const empties = (await screen.findByText("No dashboards yet. Create one to get started.")).closest(".empty") as HTMLElement;
      expect(within(empties).getAllByRole("button").map((b) => b.textContent)).toEqual(["Start blank", "Start from Power"]);
      expect(within(empties).getAllByRole("button").map((b) => b.getAttribute("type"))).toEqual(["button", "button"]);
      expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["New dashboard", "Start blank", "Start from Power"]);
    });

    it("dashboards.edit alone sees the buttons, dashboards.default alone does not", async () => {
      open("custom", { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view", "dashboards.default"] }) }, ...empty });
      expect(await screen.findByText("No dashboards yet.")).toBeInTheDocument();
      await accountKnown();
      expect(screen.queryByRole("button", { name: "Start blank" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start from Power" })).not.toBeInTheDocument();
    });

    it("Start from Power opens the dialog with Power and This month chosen, and Create sends the recipe", async () => {
      const calls = open("operator", { ...empty, ...POWER_BODY });
      await userEvent.click(await screen.findByRole("button", { name: "Start from Power" }));
      const dialog = screen.getByRole("dialog", { name: "New dashboard" });
      expect(within(dialog).getByRole("radio", { name: "Power" })).toBeChecked();
      expect(within(dialog).getByLabelText("Range")).toHaveValue("this_month");
      expect(within(dialog).getByLabelText("Name")).toHaveFocus();
      await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboards/9|null"));
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Power", range: "this_month", recipe: "power" });
    });

    it("Start blank and the header's New dashboard open the dialog on Blank, and Escape puts the focus back on the button", async () => {
      open("operator", empty);
      await userEvent.click(await screen.findByRole("button", { name: "Start blank" }));
      expect(within(screen.getByRole("dialog", { name: "New dashboard" })).getByRole("radio", { name: "Blank" })).toBeChecked();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Start blank" })).toHaveFocus();
      await userEvent.click(screen.getByRole("button", { name: "New dashboard" }));
      expect(within(screen.getByRole("dialog", { name: "New dashboard" })).getByRole("radio", { name: "Blank" })).toBeChecked();
      expect(within(screen.getByRole("dialog")).getByLabelText("Range")).toHaveValue("24h");
    });

    it("a page that lists dashboards gets no start buttons", async () => {
      open("operator");
      await screen.findByRole("link", { name: "Hall A" });
      expect(screen.queryByRole("button", { name: "Start blank" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start from Power" })).not.toBeInTheDocument();
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

  it("dashboards.edit: New dashboard and the trash, but no Make default menu", async () => {
    await show(["dashboards.edit"], withDefault);
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Hall A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
  });

  it("dashboards.default alone: the Make default menu per row, and nothing that creates or deletes", async () => {
    const calls = await show(["dashboards.default"], { ...withDefault, "PUT /api/dashboards/default": { body: { dashboard_id: 4 } } });
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Hall A" }));
    expect(await screen.findByRole("menuitem", { name: "Clear default" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for Hall B" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Make default" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ dashboard_id: 4 }]));
  });

  it("both: the menu and the trash on a row, and New dashboard (an administrator's page)", async () => {
    await show(["dashboards.edit", "dashboards.default"]);
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for Hall A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Hall A" })).toBeInTheDocument();
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
