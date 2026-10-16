import { afterPaint } from "./afterPaint";

describe("afterPaint", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("resolves after two animation frames, not one", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    let done = false;
    void afterPaint().then(() => { done = true; });
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    await Promise.resolve();
    expect(done, "one frame is not enough").toBe(false);
    expect(frames).toHaveLength(1);
    frames.shift()!(16);
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("resolves on the real frames too", async () => {
    await expect(afterPaint()).resolves.toBeUndefined();
  });
});
