import { GUIDE_KEY_PREFIX } from "../lib/guideMemory";

/**
 * Marks the dashboard guide as already seen, for every account: `localStorage.getItem` answers "1" for any key of the guide (the same trick as
 * `markGuideSeen` in the e2e helpers), so a test that renders a dashboard with a following, comparing or breakdown widget does not get the panel in
 * its way. Call it first thing in the test or its `beforeEach`; the global `afterEach` (`vi.restoreAllMocks`) puts the real `getItem` back.
 */
export function markGuideSeen(): void {
  const real = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
    return key.startsWith(GUIDE_KEY_PREFIX) ? "1" : real.call(this, key);
  });
}
