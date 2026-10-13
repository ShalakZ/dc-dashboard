import { afterEach, beforeEach, vi } from "vitest";

/**
 * SaveButton refuses a second click within 400 ms of the last one it accepted (the double-submit guard). A person who fixes a field and
 * presses Save again takes longer than that; a test does not. A test file with such a flow calls `useSaveClock()` once at the top (only
 * Date is faked, every timer stays real, so user-event and waitFor run as usual) and `pastSaveWindow()` between the two clicks.
 */
export function useSaveClock(): void {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
}

export const pastSaveWindow = (): void => { vi.setSystemTime(Date.now() + 500); };
