import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import type { Role } from "../api/types";
import { formatSiteDateTime } from "../lib/siteTime";
import { authed, dashboard } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { DashboardsPage } from "./DashboardsPage";

const items = [
  { id: 3, name: "Hall A", range: "24h", widget_count: 2, updated_at: "2026-10-08T06:00:00+00:00" },
  { id: 4, name: "Hall B", range: "7d", widget_count: 0, updated_at: "2026-10-07T10:30:00+00:00" },
];

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}|${JSON.stringify(location.state)}`}</output>;
}
function open(role: Role, over: Routes = {}) {
  const calls = mockFetch({ ...authed(role), "GET /api/dashboards": { body: items }, "GET /api/dashboards/default": { body: { dashboard_id: null } }, ...over });
  renderWithProviders(<><DashboardsPage /><Probe /></>, { route: "/dashboards", path: "*" });
  return calls;
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

  it("deletes from the keyboard: Enter on the trash button asks first", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    open("operator");
    await screen.findByRole("link", { name: "Hall A" });
    screen.getByRole("button", { name: "Delete Hall A" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(confirm).toHaveBeenCalledWith('Delete dashboard "Hall A" and its widgets?');
  });

  it("lets an operator create a dashboard and opens it in edit mode", async () => {
    const calls = open("operator", { "POST /api/dashboards": { status: 201, body: dashboard({ id: 9, name: "Hall C", range: "7d" }) } });
    await userEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
    const dialog = screen.getByRole("dialog", { name: "New dashboard" });
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), "Hall C");
    await userEvent.selectOptions(screen.getByLabelText("Range"), "7d");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent('/dashboards/9|{"edit":true}'));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Hall C", range: "7d" });
  });

  it("keeps the dialog open with the server's message when the name is taken, and Escape closes it", async () => {
    open("operator", { "POST /api/dashboards": { status: 409, body: { detail: "a dashboard with this name already exists" } } });
    await userEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
    await userEvent.type(screen.getByLabelText("Name"), "Hall A");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByRole("dialog", { name: "New dashboard" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deletes after confirmation and refreshes the list; declining deletes nothing", async () => {
    let deleted = false;
    const calls = open("operator", {
      "GET /api/dashboards": () => ({ body: deleted ? [items[1]] : items }),
      "DELETE /api/dashboards/3": () => { deleted = true; return { status: 204 }; },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Hall A" }));
    expect(confirm).toHaveBeenCalledWith('Delete dashboard "Hall A" and its widgets?');
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete Hall A" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Hall A" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Hall B" })).toBeInTheDocument();
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
      const calls = open("admin", {
        "GET /api/dashboards/default": () => ({ body: { dashboard_id: current } }),
        "PUT /api/dashboards/default": ({ body }) => {
          current = (body as { dashboard_id: number | null }).dashboard_id;
          return { body: { dashboard_id: current } };
        },
      });
      await userEvent.click(await screen.findByRole("button", { name: "Actions for Hall B" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
      expect(await within(screen.getByRole("link", { name: "Hall B" }).closest("tr")!).findByText("Default")).toBeInTheDocument();
      expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ dashboard_id: 4 }]);
      await userEvent.click(screen.getByRole("button", { name: "Actions for Hall B" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Clear default" }));
      await waitFor(() => expect(screen.queryByText("Default")).not.toBeInTheDocument());
      expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ dashboard_id: 4 }, { dashboard_id: null }]);
    });

    it("shows the server's message when setting the default fails", async () => {
      open("admin", { "PUT /api/dashboards/default": { status: 404, body: { detail: "dashboard not found" } } });
      await userEvent.click(await screen.findByRole("button", { name: "Actions for Hall A" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("dashboard not found");
    });

    it("keeps the menu from an operator, who may only delete", async () => {
      open("operator", withDefault);
      await screen.findByRole("link", { name: "Hall A" });
      expect(screen.queryByRole("button", { name: /^Actions for / })).not.toBeInTheDocument();
    });

    it("warns when the dashboard to delete is the default", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      open("admin", withDefault);
      await userEvent.click(await screen.findByRole("button", { name: "Delete Hall A" }));
      expect(confirm).toHaveBeenCalledWith('Delete dashboard "Hall A" and its widgets? It is the default dashboard: nobody will land on it any more.');
      await userEvent.click(screen.getByRole("button", { name: "Delete Hall B" }));
      expect(confirm).toHaveBeenLastCalledWith('Delete dashboard "Hall B" and its widgets?');
    });
  });

  it("keeps the Dashboards heading while loading and when the list cannot be loaded", async () => {
    open("viewer", { "GET /api/dashboards": { status: 500, body: { detail: "list failed" } } });
    expect(screen.getByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("list failed");
    expect(screen.getByRole("heading", { name: "Dashboards" })).toBeInTheDocument();
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
});
