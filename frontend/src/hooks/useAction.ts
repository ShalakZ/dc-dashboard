import { useCallback, useState } from "react";

/**
 * Run a one-off action (test, delete, browse…) and surface its outcome:
 * `busy` while it runs, `error` with the ApiError/Error message if it rejects (cleared on the next run).
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error };
}
