import { act, render, screen } from "@testing-library/react";
import { Age } from "./Age";

afterEach(() => vi.useRealTimers());

describe("Age", () => {
  it("says how long ago, and keeps counting while nothing else on the page changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    render(<Age ts="2026-10-08T09:48:00.000000+00:00" />);
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("13 min ago")).toBeInTheDocument();
  });
  it("shows nothing for a time it cannot read", () => {
    const { container } = render(<Age ts="nonsense" />);
    expect(container).toBeEmptyDOMElement();
  });
});
