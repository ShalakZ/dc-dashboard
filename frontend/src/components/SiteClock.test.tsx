import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { keys } from "../api/queries";
import type { Site } from "../api/types";
import { holdFetch } from "../test/holdFetch";
import { mockFetch } from "../test/fetchMock";
import { SiteClock } from "./SiteClock";

afterEach(() => vi.useRealTimers());

/** The site is put straight into the cache, so no request or query timer is involved and only the clock's own interval is fake. */
function mount(site: Site | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (site) client.setQueryData(keys.site, site);
  return render(<QueryClientProvider client={client}><SiteClock /></QueryClientProvider>);
}

describe("SiteClock", () => {
  it("shows the time and the name of the site zone, with a hidden Site time prefix", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-11T16:42:55Z"));
    const { container } = mount({ timezone: "Asia/Qatar", currency: null });
    const time = container.querySelector("time");
    expect(time).toHaveTextContent("19:42");
    expect(time).toHaveAttribute("datetime", "19:42");
    expect(container.querySelector(".zone")).toHaveTextContent("Asia/Qatar");
    expect(container.querySelector(".site-time")).toHaveTextContent(/^Site time\s*19:42\s*Asia\/Qatar$/);
    expect(screen.getByText("Site time")).toHaveClass("sr-only");
  });

  it("moves on every 10 seconds, and stops when it goes away", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-11T16:42:55Z")); // five seconds before 19:43 in Qatar
    const { container, unmount } = mount({ timezone: "Asia/Qatar", currency: null });
    expect(container.querySelector("time")).toHaveTextContent("19:42");
    act(() => { vi.advanceTimersByTime(9_999); });
    expect(container.querySelector("time")).toHaveTextContent("19:42");
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector("time")).toHaveTextContent("19:43");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows nothing until the zone is known, then the clock", async () => {
    mockFetch({ "GET /api/site": { body: { timezone: "Asia/Qatar", currency: null } } });
    const gate = holdFetch((_method, path) => path === "/api/site");
    const { container } = mount(null);
    expect(container).toBeEmptyDOMElement();
    gate.release();
    await waitFor(() => expect(container.querySelector("time")).toBeInTheDocument());
    expect(container.querySelector(".zone")).toHaveTextContent("Asia/Qatar");
  });

  it("shows nothing for a zone the browser does not know", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { container } = mount({ timezone: "Mars/Olympus", currency: null });
    expect(container).toBeEmptyDOMElement();
  });
});
