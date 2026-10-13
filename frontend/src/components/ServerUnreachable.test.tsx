import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { ServerUnreachable } from "./ServerUnreachable";

describe("ServerUnreachable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a card in the sign-in style with one h1, a plain explanation and a Retry now button", async () => {
    const calls = mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role: "admin" } } });
    const { container } = renderWithProviders(<ServerUnreachable />);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Can't reach the server");
    expect(screen.getByText("The server is not answering. It may be starting or restarting. This page tries again every few seconds.")).toBeInTheDocument();
    expect(container.querySelector("main.auth > .auth-card > .auth-brand")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry now" })).toHaveClass("primary");
  });

  it("Retry now asks the sign-in check again", async () => {
    const calls = mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role: "admin" } } });
    renderWithProviders(<ServerUnreachable />);
    const setupCalls = () => calls.filter((c) => c.path === "/api/setup").length;
    await waitFor(() => expect(setupCalls()).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(setupCalls()).toBe(2));
  });
});
