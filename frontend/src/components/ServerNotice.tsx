import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useServerDown } from "../lib/serverReach";

/**
 * Shown in the app shell while the last two requests in a row got no answer from the server (it is stopped or restarting). The
 * page keeps polling and fills in again by itself; Retry now asks everything that is on screen again at once. When the server is back
 * the pages whose request failed are asked again too: many have no polling and would otherwise keep their error until the next visit.
 */
export function ServerNotice() {
  const down = useServerDown();
  const queryClient = useQueryClient();
  const wasDown = useRef(false);
  useEffect(() => {
    if (wasDown.current && !down) void queryClient.refetchQueries({ type: "active", predicate: (query) => query.state.status === "error" });
    wasDown.current = down;
  }, [down, queryClient]);
  if (!down) return null;
  return (
    <div role="status" className="banner banner-warn warning">
      <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
      <span>Can't reach the server. This page keeps trying and updates by itself when it is back.</span>
      <button type="button" className="b-act" onClick={() => void queryClient.refetchQueries({ type: "active" })}>Retry now</button>
    </div>
  );
}
