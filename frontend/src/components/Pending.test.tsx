import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { createProgress } from "../lib/progress";
import { manualTimers } from "../test/manualTimers";
import { Pending } from "./Pending";

describe("Pending", () => {
  it("renders nothing", () => {
    const store = createProgress(manualTimers().timers);
    const { container } = render(<Pending store={store} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts one load while mounted and takes it back on unmount, also under StrictMode", () => {
    const clock = manualTimers();
    const store = createProgress(clock.timers);
    store.attach();
    const { unmount } = render(<StrictMode><Pending store={store} /></StrictMode>);
    expect(store.getCount("pending")).toBe(1); // mount, unmount, mount balances out
    unmount();
    expect(store.getCount("pending")).toBe(0);
    clock.advance(10_000);
    store.detach();
    expect(clock.count).toBe(0);
    expect(store.getPhase()).toBe("idle");
  });

  it("two of them count two", () => {
    const store = createProgress(manualTimers().timers);
    const { unmount } = render(<><Pending store={store} /><Pending store={store} /></>);
    expect(store.getCount("pending")).toBe(2);
    unmount();
    expect(store.getCount("pending")).toBe(0);
  });
});
