import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// React Flow measures with these; jsdom has neither.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; constructor(_transform?: string) {} });
