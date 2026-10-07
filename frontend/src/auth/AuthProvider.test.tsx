import { screen, waitFor } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { RequireAuth } from "./RequireAuth";
import { useAuth } from "./AuthProvider";
import { useAssets } from "../api/queries";

function AssetCount() {
  const { data, error } = useAssets();
  if (error) return <p role="alert">{error.message}</p>;
  return <p>{data ? `${data.length} assets` : "loading assets"}</p>;
}

function WhoAmI() {
  const { user, hasRole } = useAuth();
  return <p>{user?.username} admin:{String(hasRole("admin"))} operator:{String(hasRole("operator"))}</p>;
}

describe("AuthProvider", () => {
  it("redirects to /setup when no user exists yet", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: true } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("setup page")).toBeInTheDocument();
  });

  it("test_login_redirects_back_after_401: unauthenticated users go to login with the return path", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>, { route: "/assets/4" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(sessionStorage.getItem("dcdash.returnTo")).toBe("/assets/4");
  });

  it("returns to the login page when a request answers 401 mid-session", async () => {
    mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "root", role: "admin" } },
      // session expired between /api/me and the page's own request
      "GET /api/assets": { status: 401, body: { detail: "not authenticated" } },
    });
    renderWithProviders(<RequireAuth><AssetCount /></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(sessionStorage.getItem("dcdash.returnTo")).toBe("/assets");
  });

  it("exposes the user and role checks", async () => {
    mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "op", role: "operator" } },
    });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>);
    await waitFor(() => expect(screen.getByText(/op admin:false operator:true/)).toBeInTheDocument());
  });
});
