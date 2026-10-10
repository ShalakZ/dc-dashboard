import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { RoleChangedNotice } from "./RoleChangedNotice";

let role = "operator";
const routes = () => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": () => ({ body: { id: 1, username: "u", role } }),
});

describe("RoleChangedNotice", () => {
  beforeEach(() => {
    role = "operator";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing while the role has not changed", async () => {
    const calls = mockFetch(routes());
    renderWithProviders(<RoleChangedNotice />);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    act(() => { fireEvent.focus(window); });
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/me")).toHaveLength(2));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  });

  it("says what changed and reloads the page from its Reload button", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const calls = mockFetch(routes());
    renderWithProviders(<RoleChangedNotice />);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    role = "viewer";
    act(() => { fireEvent.focus(window); });
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Your role changed from operator to viewer. Reload the page to continue.");
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
