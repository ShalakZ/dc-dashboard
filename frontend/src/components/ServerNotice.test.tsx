import { useQuery } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import { noteReach, resetServerReach } from "../lib/serverReach";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { ServerNotice } from "./ServerNotice";

let probe: { status: number };
const routes = () => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role: "admin" } },
  "GET /api/probe": () => ({ status: probe.status, body: probe.status === 200 ? { n: 1 } : { detail: "Bad Gateway" } }),
});

function Probe() {
  const query = useQuery({ queryKey: ["probe"], queryFn: () => api.get<{ n: number }>("/api/probe") });
  return <p>{query.isError ? "probe failed" : query.data ? "probe ok" : "probe loading"}</p>;
}

describe("ServerNotice", () => {
  beforeEach(() => {
    probe = { status: 200 };
    resetServerReach();
  });
  afterEach(() => {
    act(() => resetServerReach());
    vi.unstubAllGlobals();
  });

  it("renders nothing while the server answers, and after one failed request", async () => {
    mockFetch(routes());
    renderWithProviders(<ServerNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => noteReach(false));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says so, in the warning banner style, after two failed requests in a row, and goes when one gets an answer", () => {
    mockFetch(routes());
    renderWithProviders(<ServerNotice />);
    act(() => { noteReach(false); noteReach(false); });
    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("banner", "banner-warn", "warning");
    expect(notice).toHaveTextContent("Can't reach the server. This page keeps trying and updates by itself when it is back.");
    expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
    act(() => noteReach(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Retry now refetches the queries on the page, and the notice goes once the server answers", async () => {
    const calls = mockFetch(routes());
    probe.status = 502;
    renderWithProviders(<><Probe /><ServerNotice /></>);
    expect(await screen.findByText("probe failed")).toBeInTheDocument();
    const probes = () => calls.filter((c) => c.path === "/api/probe").length;
    expect(probes()).toBe(1);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/me")).toBe(true));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20))); // the sign-in check's answers are in, so they cannot reset the count below
    act(() => { noteReach(false); noteReach(false); });
    expect(await screen.findByRole("status")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    await waitFor(() => expect(probes()).toBe(2));
    expect(screen.getByRole("status")).toBeInTheDocument(); // answered 502 again: still down

    probe.status = 200;
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByText("probe ok")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
