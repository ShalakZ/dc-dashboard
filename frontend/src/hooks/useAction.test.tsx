import { act, renderHook } from "@testing-library/react";
import { ApiError } from "../api/client";
import { useAction } from "./useAction";

describe("useAction", () => {
  it("captures the error message, tracks busy, and clears the error on the next successful run", async () => {
    const { result } = renderHook(() => useAction());
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);

    await act(() => result.current.run(async () => { throw new ApiError(403, "admin role required"); }));
    expect(result.current.error).toBe("admin role required");

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let done: Promise<void>;
    act(() => { done = result.current.run(() => pending); });
    expect(result.current.busy).toBe(true);
    await act(async () => { release(); await done; });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
