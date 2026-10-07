import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { AssetsPage } from "./AssetsPage";

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
];
const authed = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/assets": { body: assets },
});

describe("AssetsPage", () => {
  it("renders the hierarchy as a nested tree", async () => {
    mockFetch(authed("viewer"));
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    const site = await screen.findByRole("link", { name: "Site" });
    expect(within(site.closest("li")!).getByRole("link", { name: "Room A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add asset" })).not.toBeInTheDocument();
  });

  it("lets an admin add a child asset", async () => {
    const calls = mockFetch({
      ...authed("admin"),
      "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Room B");
    await userEvent.selectOptions(screen.getByLabelText("Parent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Room B", parent_id: 1, kind: "generic", sort_order: 0 });
  });

  it("shows the API error when a move is rejected", async () => {
    mockFetch({
      ...authed("admin"),
      "PATCH /api/assets/1": { status: 422, body: { detail: "an asset cannot be moved under itself or its own descendants" } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets?selected=1", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be moved under itself");
  });
});
