import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, Suspense } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "../test/routerRequestShim";
import { RouteError } from "./RouteError";

// A lazy page whose chunk the new build no longer has: the import() rejects, as it does for a tab opened before an update.
const GonePage = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://dash.example/assets/DashboardsPage-OLD1234.js")));

function renderRoute(element = <Suspense fallback={<p>loading</p>}><GonePage /></Suspense>) {
  const router = createMemoryRouter([{ path: "*", element, errorElement: <RouteError /> }]);
  return render(<RouterProvider router={router} />);
}

describe("RouteError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React Router logs the error it caught
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces the developer error page when a lazy page's chunk is gone", async () => {
    renderRoute();
    const panel = await screen.findByRole("alert");
    expect(panel).toHaveTextContent("This page could not be loaded. It may have been updated; reload to continue.");
    expect(panel).toHaveClass("banner", "banner-warn", "warning");
    expect(screen.queryByText(/Unexpected Application Error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dynamically imported module|DashboardsPage-OLD1234|Hey developer/i)).not.toBeInTheDocument(); // no stack, no developer text
    expect(screen.queryByText("loading")).not.toBeInTheDocument();
  });

  it("also covers any other error a page throws while it renders", async () => {
    const Broken = () => { throw new Error("boom: internal detail"); };
    renderRoute(<Broken />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This page could not be loaded.");
    expect(screen.queryByText(/internal detail/)).not.toBeInTheDocument();
  });

  it("offers a plain link to the Assets Tree, so a missing chunk never leaves a user without a way into the app", async () => {
    renderRoute();
    await screen.findByRole("alert");
    const link = screen.getByRole("link", { name: "Assets Tree" });
    expect(link).toHaveAttribute("href", "/assets"); // a real <a>, not a router link: the router is the thing that failed, a full page load starts clean
    expect(link.closest("[role=alert]")).not.toBeNull(); // in the notice, beside its Reload button
  });

  it("reloads the page from its Reload button", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderRoute();
    await screen.findByRole("alert");
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
