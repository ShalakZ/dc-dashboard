import { screen } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { Layout } from "./Layout";

const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
});

describe("Layout nav", () => {
  it("shows admin links only to admins, Password link to everyone", async () => {
    mockFetch(routes("admin"));
    const { unmount } = renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Users" })).toHaveAttribute("href", "/users");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: "Password" })).toHaveAttribute("href", "/password");
    unmount();
    mockFetch(routes("viewer"));
    renderWithProviders(<Layout />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("link", { name: "Password" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sources" })).not.toBeInTheDocument();
  });
});
