/**
 * True on the display screen's own address, `/display` or `/display/` (main.tsx tests it before it mounts anything).
 * `/displays` is the administrators' Displays page, and `/display/x` is nothing the screen owns: both stay with the app.
 */
export function isDisplayPath(pathname: string): boolean {
  return /^\/display\/?$/.test(pathname);
}
