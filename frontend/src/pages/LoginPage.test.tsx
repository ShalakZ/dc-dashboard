import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { userFor } from "../test/users";
import { LoginPage } from "./LoginPage";

const base = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "x" } } };

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

describe("LoginPage", () => {
  it("posts credentials and navigates to the stored return path", async () => {
    sessionStorage.setItem("dcdash.returnTo", "/assets/4");
    const calls = mockFetch({ ...base, "POST /api/login": { body: userFor("admin", { username: "admin" }) } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "secret-123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ username: "admin", password: "secret-123" });
    expect(sessionStorage.getItem("dcdash.returnTo")).toBeNull();
  });

  // path "*" on a neighbouring address keeps LoginPage mounted while the location changes, so the probe can read where it went.
  async function signIn() {
    mockFetch({ ...base, "POST /api/login": { body: userFor("admin", { username: "admin" }) } });
    renderWithProviders(<><LoginPage /><Where /></>, { route: "/signin", path: "*" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "secret-123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  }

  it("lands on / when no page was remembered, so the home route can pick the default dashboard", async () => {
    await signIn();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/));
  });

  it("lets a remembered page win over /", async () => {
    sessionStorage.setItem("dcdash.returnTo", "/billing");
    await signIn();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/billing$/));
  });

  it("asks the default dashboard endpoint nothing while signed out", async () => {
    const calls = mockFetch(base);
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await screen.findByLabelText("Username");
    expect(calls.some((c) => c.path === "/api/dashboards/default")).toBe(false);
  });

  it("shows the API's message on a failed login", async () => {
    mockFetch({ ...base, "POST /api/login": { status: 401, body: { detail: "invalid username or password" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Invalid username or password")).toBeInTheDocument(); // the API writes it in lower case
  });

  it("shows the lockout message on 429", async () => {
    mockFetch({ ...base, "POST /api/login": { status: 429, body: { detail: "too many failed attempts, try again in about 5 minutes" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Too many failed attempts, try again in about 5 minutes")).toBeInTheDocument();
  });
});
