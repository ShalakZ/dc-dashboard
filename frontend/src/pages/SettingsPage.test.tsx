import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SettingsPage } from "./SettingsPage";

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
};

describe("SettingsPage", () => {
  it("loads, saves a timezone and shows the saved marker", async () => {
    let tz = "UTC";
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": () => ({ body: { timezone: tz } }),
      "PUT /api/settings/general": ({ body }) => {
        tz = (body as { timezone: string }).timezone;
        return { body: { timezone: tz } };
      },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    expect(input).toHaveValue("UTC");
    await userEvent.clear(input);
    await userEvent.type(input, "Europe/Amsterdam");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ timezone: "Europe/Amsterdam" });
  });

  it("says what the zone decides: where a day and a month start, and the times shown", async () => {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "UTC" } } });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    await screen.findByLabelText("Timezone");
    const hint = screen.getByText(/Readings are stored in UTC/);
    expect(hint).toHaveTextContent("day");
    expect(hint).toHaveTextContent("month");
    expect(hint).toHaveTextContent("times");
    expect(hint).not.toHaveTextContent('Used for "today"');
  });

  it("shows the API message for an unknown timezone", async () => {
    mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "PUT /api/settings/general": { status: 422, body: { detail: [{ msg: "Value error, unknown timezone: Mars/Olympus" }] } },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    await userEvent.clear(input);
    await userEvent.type(input, "Mars/Olympus");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/unknown timezone: Mars\/Olympus/)).toBeInTheDocument();
  });
});

describe("SettingsPage certificate line", () => {
  const tls = (over: Record<string, unknown>) => ({
    enabled: true, state: "ok", not_after: "2026-11-09T11:03:11+00:00", days_left: 80, subject: "CN=dcdash.example",
    checked_at: "2026-10-10T12:00:00+00:00", error: null, ...over,
  });

  /** Opens the page and returns once the certificate status has been asked for and the page is showing. */
  async function open(reply: { status?: number; body: unknown }) {
    const calls = mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "Asia/Qatar" } }, "GET /api/tls/status": reply });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    await screen.findByLabelText("Timezone");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/tls/status")).toBe(true));
  }

  it("shows a read-only Certificate line with the expiry on the site clock when a certificate is configured", async () => {
    await open({ body: tls({}) });
    const line = await screen.findByText(/Certificate/);
    expect(line).toHaveTextContent("expires 2026-11-09 14:03:11 (80 days left)");
    expect(line).toHaveTextContent("CN=dcdash.example");
    expect(line.querySelector("input, button")).toBeNull();
  });

  it("says when the certificate has expired", async () => {
    await open({ body: tls({ state: "expired", days_left: 0 }) });
    expect(await screen.findByText(/Certificate/)).toHaveTextContent("expired on 2026-11-09 14:03:11");
  });

  it("shows the reason when the certificate file cannot be read", async () => {
    await open({ body: tls({ state: "unreadable", not_after: null, days_left: null, subject: null, error: "permission denied" }) });
    expect(await screen.findByText(/Certificate/)).toHaveTextContent("cannot be read: permission denied");
  });

  it("says the collector has not checked lately when the state is unknown", async () => {
    await open({ body: tls({ state: "unknown", not_after: null, days_left: null, subject: null }) });
    expect(await screen.findByText(/Certificate/)).toHaveTextContent("not checked recently");
  });

  it("shows no Certificate line when HTTPS is not configured", async () => {
    await open({ body: { enabled: false, state: null, not_after: null, days_left: null, subject: null, checked_at: null, error: null } });
    expect(screen.queryByText(/Certificate/)).not.toBeInTheDocument();
  });

  it("shows no Certificate line when the status cannot be fetched", async () => {
    await open({ status: 500, body: { detail: "boom" } });
    expect(screen.queryByText(/Certificate/)).not.toBeInTheDocument();
  });
});

