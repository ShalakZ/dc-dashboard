/**
 * Two animation frames: what React and React Flow were given a moment ago is rendered, in their store and drawn (the first frame runs before
 * the paint it belongs to, the second after it). Wait for this before reading the page's state after a refetch (where the focus is, whether a
 * node is there).
 */
export const afterPaint = () => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });
