/**
 * Two animation frames: what React and React Flow were given a moment ago is rendered, in their store and drawn (the first frame runs before
 * the paint it belongs to, the second after it). Wait for this before reading the page's state after a refetch (where the focus is, whether a
 * node is there).
 */
export const afterPaint = () => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });

/**
 * Wait, frame by frame, until `check()` is true: for the state that React commits (and an effect copies into a ref) a variable number of frames after
 * a refetch resolved, which two frames alone do not cover on a busy page. It looks after each frame (never before the first), answers true the moment
 * the check holds, and gives up with false once `maxMs` have gone (2 s by default), so a read that really failed still ends. `stop` (the page was left)
 * is asked before `check` and, when true, ends the wait with false without `check` being called again. `frame` and `now` are there for tests.
 */
export async function framesUntil(
  check: () => boolean,
  options: { maxMs?: number; frame?: () => Promise<void>; now?: () => number; stop?: () => boolean } = {},
): Promise<boolean> {
  const { maxMs = 2000, frame = afterPaint, now = () => performance.now(), stop } = options;
  const start = now();
  for (;;) {
    await frame();
    if (stop?.()) return false;
    if (check()) return true;
    if (now() - start >= maxMs) return false;
  }
}
