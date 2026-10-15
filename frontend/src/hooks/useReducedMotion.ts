import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(QUERY);
  } catch {
    return null;
  }
}

/** True when the reader asked the device for less motion. False where the browser cannot say (jsdom has no matchMedia). */
export function reducedMotion(): boolean {
  return query()?.matches ?? false;
}

/** `reducedMotion()` as state: it follows the preference while the page is open. One source for the camera, the animated edges and the flash. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const onChange = () => setReduced(media.matches);
    onChange(); // the preference may have changed between the first render and this effect
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
