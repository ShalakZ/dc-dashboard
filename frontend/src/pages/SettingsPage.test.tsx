import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SettingsPage } from "./SettingsPage";

const policy = (max_failures = 5, block_minutes = 5) => ({
  max_failures, block_minutes,
  limits: { max_failures: [3, 20], block_minutes: [1, 60] },
  defaults: { max_failures: 5, block_minutes: 5 },
});

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
  "GET /api/settings/sign-in": { body: policy() },
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

describe("SettingsPage sign-in protection", () => {
  const section = () => screen.getByRole("form", { name: "Sign-in protection" });

  it("shows the stored numbers with the bounds the API gave, and the sentence that says what they do", async () => {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "UTC" } }, "GET /api/settings/sign-in": { body: policy(7, 12) } });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const failures = await screen.findByLabelText("Failed sign-ins before a block");
    const minutes = screen.getByLabelText("Block time in minutes");
    await waitFor(() => expect(failures).toHaveValue(7));
    expect(minutes).toHaveValue(12);
    expect(failures).toHaveAttribute("min", "3");
    expect(failures).toHaveAttribute("max", "20");
    expect(minutes).toHaveAttribute("min", "1");
    expect(minutes).toHaveAttribute("max", "60");
    expect(screen.getByRole("heading", { name: "Sign-in protection" })).toBeInTheDocument();
    expect(section()).toHaveTextContent(
      "After this many wrong passwords for one account from one computer, that account is blocked from that computer for this long. "
      + "Restarting the api service clears every block; Unblock on the Users page lets one account in sooner.",
    );
  });

  it("saves both numbers, shows saved, and leaves the timezone alone", async () => {
    let stored = policy();
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "GET /api/settings/sign-in": () => ({ body: stored }),
      "PUT /api/settings/sign-in": ({ body }) => {
        const b = body as { max_failures: number; block_minutes: number };
        stored = policy(b.max_failures, b.block_minutes);
        return { body: stored };
      },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const failures = await screen.findByLabelText("Failed sign-ins before a block");
    await waitFor(() => expect(failures).toHaveValue(5));
    await userEvent.clear(failures);
    await userEvent.type(failures, "8");
    const minutes = screen.getByLabelText("Block time in minutes");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "15");
    await userEvent.click(within(section()).getByRole("button", { name: "Save sign-in protection" }));
    expect(await within(section()).findByText("saved")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT").map((c) => [c.path, c.body])).toEqual([
      ["/api/settings/sign-in", { max_failures: 8, block_minutes: 15 }],
    ]);
    await waitFor(() => expect(screen.getByLabelText("Failed sign-ins before a block")).toHaveValue(8));
    expect(screen.getByLabelText("Timezone")).toHaveValue("UTC");
  });

  it("keeps the timezone form separate: its Save does not send the sign-in numbers", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "PUT /api/settings/general": { body: { timezone: "Asia/Qatar" } },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    await userEvent.clear(input);
    await userEvent.type(input, "Asia/Qatar");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.path)).toEqual(["/api/settings/general"]);
  });

  it("shows the API's text when the save is refused", async () => {
    mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "PUT /api/settings/sign-in": { status: 422, body: { detail: "block_minutes must be between 1 and 60" } },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const failures = await screen.findByLabelText("Failed sign-ins before a block");
    await waitFor(() => expect(failures).toHaveValue(5));
    await userEvent.click(within(section()).getByRole("button", { name: "Save sign-in protection" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent("block_minutes must be between 1 and 60");
    expect(within(section()).queryByText("saved")).not.toBeInTheDocument();
  });

  it("says so, in its own section, when the policy cannot be read; the timezone form still works", async () => {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "UTC" } }, "GET /api/settings/sign-in": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    expect(await screen.findByLabelText("Timezone")).toHaveValue("UTC");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByLabelText("Failed sign-ins before a block")).not.toBeInTheDocument();
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

describe("SettingsPage version line", () => {
  async function open(version: { status?: number; body: unknown }, timezone = "UTC") {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone } }, "GET /api/version": version });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    await screen.findByLabelText("Timezone");
  }

  it("shows the build id and the commit time on the site clock, as plain text", async () => {
    await open({ body: { build_id: "227bd6a", build_time: "2026-10-12T14:03:11+02:00", uptime_seconds: 5.2 } }, "Asia/Qatar");
    const line = await screen.findByText(/^Version /);
    expect(line).toHaveTextContent("Version 227bd6a, built 2026-10-12 15:03:11");
    expect(line.querySelector("input, button")).toBeNull();
  });

  it("says dev and unknown for an image built without a build id", async () => {
    await open({ body: { build_id: "dev", build_time: "unknown", uptime_seconds: 1 } });
    expect(await screen.findByText(/^Version /)).toHaveTextContent("Version dev, built unknown");
  });

  it("shows no version line when the version cannot be read, and the rest of the page works", async () => {
    await open({ status: 500, body: { detail: "boom" } });
    expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Timezone")).toHaveValue("UTC");
  });
});
