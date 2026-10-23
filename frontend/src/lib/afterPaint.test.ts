import { afterPaint, framesUntil } from "./afterPaint";

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

describe("framesUntil", () => {
  // a frame that is only a resolved promise, and a clock that moves 16 ms per frame
  const fakes = () => {
    const counts = { frames: 0, time: 0 };
    return {
      counts,
      frame: () => { counts.frames += 1; counts.time += 16; return Promise.resolve(); },
      now: () => counts.time,
    };
  };

  it("answers true after exactly one frame when the check already holds", async () => {
    const { counts, frame, now } = fakes();
    const check = vi.fn(() => true);
    await expect(framesUntil(check, { frame, now })).resolves.toBe(true);
    expect(counts.frames).toBe(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("answers true as soon as the check turns true, and not before", async () => {
    const { counts, frame, now } = fakes();
    const check = vi.fn(() => check.mock.calls.length >= 5);
    await expect(framesUntil(check, { frame, now })).resolves.toBe(true);
    expect(counts.frames).toBe(5);
    expect(check).toHaveBeenCalledTimes(5);
  });

  it("gives up with false once maxMs have gone, not forever", async () => {
    const { counts, frame, now } = fakes();
    const check = vi.fn(() => false);
    await expect(framesUntil(check, { frame, now, maxMs: 160 })).resolves.toBe(false);
    expect(counts.frames).toBe(10); // 160 / 16
    expect(check).toHaveBeenCalledTimes(10);
  });

  it("waits about two seconds by default", async () => {
    const { counts, frame, now } = fakes();
    await expect(framesUntil(() => false, { frame, now })).resolves.toBe(false);
    expect(counts.frames).toBe(Math.ceil(2000 / 16));
  });

  it("ends with false when stop says so, and never asks the check after that", async () => {
    const { counts, frame, now } = fakes();
    const check = vi.fn(() => false);
    const stop = () => counts.frames >= 2;
    await expect(framesUntil(check, { frame, now, stop })).resolves.toBe(false);
    expect(counts.frames).toBe(2);
    expect(check).toHaveBeenCalledTimes(1); // after the first frame only
  });

  it("does not call the check when stop and a true check meet", async () => {
    const { frame, now } = fakes();
    const check = vi.fn(() => true);
    await expect(framesUntil(check, { frame, now, stop: () => true })).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("uses the real frames and clock when none are given", async () => {
    await expect(framesUntil(() => true)).resolves.toBe(true);
  });
});
