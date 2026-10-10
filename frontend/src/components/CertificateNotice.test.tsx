import { act, screen, waitFor } from "@testing-library/react";
import type { TlsStatus } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { CertificateNotice } from "./CertificateNotice";

const NOT_AFTER = "2026-11-09T11:03:11+00:00"; // 14:03:11 on the site clock below (Asia/Qatar, UTC+3)

const status = (over: Partial<TlsStatus>): TlsStatus => ({
  enabled: true, state: "ok", not_after: NOT_AFTER, days_left: 80, subject: "CN=dcdash.example",
  checked_at: "2026-10-10T12:00:00+00:00", error: null, ...over,
});

const routes = (tls: TlsStatus, role = "admin") => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } },
  "GET /api/tls/status": { body: tls },
});

/** Renders the notice and returns once /api/tls/status has been asked for and answered, so "nothing shown" means nothing, not "not yet". */
async function open(tls: TlsStatus, role = "admin") {
  const calls = mockFetch(routes(tls, role));
  renderWithProviders(<CertificateNotice />, { route: "/assets", path: "/assets" });
  await waitFor(() => expect(calls.some((c) => c.path === "/api/tls/status")).toBe(true));
  await waitFor(() => expect(calls.some((c) => c.path === "/api/site")).toBe(true));
  return calls;
}

describe("CertificateNotice", () => {
  it("shows a status line for an expiring certificate: the date on the site clock and the days left", async () => {
    await open(status({ state: "expiring", days_left: 29 }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("expires on 2026-11-09 14:03:11");
    expect(notice).toHaveTextContent("29 days left");
    expect(notice).not.toHaveClass("error");
  });

  it("says one day, and less than a day, in words", async () => {
    await open(status({ state: "expiring", days_left: 1 }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 day left");
    expect(screen.getByRole("status")).not.toHaveTextContent("1 days");
  });

  it("says less than a day when the whole days left are zero", async () => {
    await open(status({ state: "expiring", days_left: 0 }));
    expect(await screen.findByRole("status")).toHaveTextContent("less than a day left");
  });

  it("shows an alert-styled line for an expired certificate and says the browsers already warn", async () => {
    await open(status({ state: "expired", days_left: 0 }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveClass("error");
    expect(notice).toHaveTextContent("expired on 2026-11-09 14:03:11");
    expect(notice).toHaveTextContent("Browsers already warn");
  });

  it("shows the error for an unreadable certificate file", async () => {
    await open(status({ state: "unreadable", not_after: null, days_left: null, subject: null, error: "no such file: /certs/fullchain.pem" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("cannot be read");
    expect(notice).toHaveTextContent("no such file: /certs/fullchain.pem");
  });

  it("falls back to UTC for the date while the site time zone is unknown, rather than hiding the warning", async () => {
    mockFetch({ ...routes(status({ state: "expiring", days_left: 5 })), "GET /api/site": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<CertificateNotice />, { route: "/assets", path: "/assets" });
    expect(await screen.findByRole("status")).toHaveTextContent("expires on 2026-11-09 11:03:11");
  });

  it("holds the notice back while the site time zone is still pending, then shows it on the site clock", async () => {
    const calls = mockFetch(routes(status({ state: "expiring", days_left: 29 })));
    const answering = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/api/site") ? gate.then(() => answering(input, init)) : answering(input, init);
    }));
    renderWithProviders(<CertificateNotice />, { route: "/assets", path: "/assets" });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/tls/status")).toBe(true));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50))); // the status has been answered; the site has not
    expect(calls.some((c) => c.path === "/api/site")).toBe(false);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole("status")).toHaveTextContent("expires on 2026-11-09 14:03:11");
  });

  it.each([
    ["ok", status({ state: "ok" })],
    ["unknown", status({ state: "unknown", days_left: null, not_after: null })],
    ["not enabled", { enabled: false, state: null, not_after: null, days_left: null, subject: null, checked_at: null, error: null } as TlsStatus],
  ])("shows nothing when the state is %s", async (_name, tls) => {
    await open(tls);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows nothing when the status cannot be fetched", async () => {
    const calls = mockFetch({ ...routes(status({ state: "expired" })), "GET /api/tls/status": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<CertificateNotice />, { route: "/assets", path: "/assets" });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/tls/status")).toBe(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
