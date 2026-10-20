import { isDisplayPath } from "./isDisplayPath";

describe("isDisplayPath", () => {
  it("is true for /display and /display/ only", () => {
    expect(isDisplayPath("/display")).toBe(true);
    expect(isDisplayPath("/display/")).toBe(true);
  });

  it("is false for every other path, the admin Displays page included", () => {
    for (const path of ["/displays", "/display/x", "/display//", "/", "", "/login", "/assets/display", "/x/display"]) {
      expect(isDisplayPath(path), path).toBe(false);
    }
  });
});
