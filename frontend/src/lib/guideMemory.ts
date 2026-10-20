/*
 * Whether this browser has already seen the dashboard guide (w27, R10). It is remembered per browser and per account in localStorage, never on the
 * server: no migration and no preference field for one bit. Every access is in a try/catch (a blocked or full store must never throw into a render),
 * and a write that fails is kept for the rest of the page's life, so "Got it" still works with storage blocked.
 */

/** The start of every key; the e2e helper `markGuideSeen` (frontend/e2e/shell.ts) matches this prefix. */
export const GUIDE_KEY_PREFIX = "dcdash.guide.dashboard.v1:";

/** The keys whose write failed: "seen" for this page's life only. */
const keptInMemory = new Set<string>();

/** The key of one account; `null` (the account is not known yet) has a key of its own, so it never reads another account's mark. */
export const guideKey = (userId: number | null): string => `${GUIDE_KEY_PREFIX}${userId ?? "anon"}`;

/** True when the guide was dismissed in this browser by this account, or (storage blocked) earlier in this page's life. */
export function guideSeen(userId: number | null): boolean {
  const key = guideKey(userId);
  if (keptInMemory.has(key)) return true;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Remember that the guide was dismissed. Never throws. */
export function rememberGuide(userId: number | null): void {
  const key = guideKey(userId);
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    keptInMemory.add(key);
  }
}
