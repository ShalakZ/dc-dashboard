import { useEffect } from "react";
import { progress, type Progress } from "../lib/progress";

/** Renders nothing; while mounted (in a Suspense fallback) the loading bar counts one more load. */
export function Pending({ store = progress }: { store?: Progress }) {
  useEffect(() => store.add("pending"), [store]); // add() returns its own idempotent remove: StrictMode's mount, unmount, mount balances
  return null;
}
