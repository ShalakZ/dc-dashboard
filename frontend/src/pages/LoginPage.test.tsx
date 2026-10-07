import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { LoginPage } from "./LoginPage";

const base = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "x" } } };

describe("LoginPage", () => {
  it("posts credentials and navigates to the stored return path", async () => {
    sessionStorage.setItem("dcdash.returnTo", "/assets/4");
    const calls = mockFetch({ ...base, "POST /api/login": { body: { id: 1, username: "admin", role: "admin" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "secret-123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ username: "admin", password: "secret-123" });
    expect(sessionStorage.getItem("dcdash.returnTo")).toBeNull();
  });

  it("shows the API's message on a failed login", async () => {
    mockFetch({ ...base, "POST /api/login": { status: 401, body: { detail: "invalid username or password" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("invalid username or password")).toBeInTheDocument();
  });

  it("shows the lockout message on 429", async () => {
    mockFetch({ ...base, "POST /api/login": { status: 429, body: { detail: "too many failed attempts, try again later" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("too many failed attempts, try again later")).toBeInTheDocument();
  });
});
