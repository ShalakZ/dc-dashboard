import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Node 25 ships a `localStorage` global of its own that hides jsdom's and has no methods unless a --localstorage-file is given
// (reading it even prints a warning). Always use jsdom's, which is what the tests mean and what Node 22 (the Docker build) gives.
const dom = (globalThis as { jsdom?: { window: { localStorage: Storage } } }).jsdom;
if (dom) Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true, writable: true });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (typeof document !== "undefined") { // the look the appearance provider put on <html>
    document.documentElement.removeAttribute("data-mode");
    document.documentElement.removeAttribute("data-theme");
  }
  dom?.window.localStorage.clear(); // jsdom keeps it for a whole test file: a saved sidebar state must not leak into the next test (the node-environment SSR files have no dom)
});

// React Flow measures with these; jsdom has neither.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor(_transform?: string) {} });
