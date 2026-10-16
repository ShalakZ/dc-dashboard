import { isUndoKey } from "./undoKey";

const key = (over: Partial<Parameters<typeof isUndoKey>[0]> = {}) =>
  isUndoKey({ key: "z", code: "KeyZ", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...over });

describe("isUndoKey", () => {
  it("is Ctrl+Z or Cmd+Z, in either case (caps lock)", () => {
    expect(key()).toBe(true);
    expect(key({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(key({ key: "Z" })).toBe(true);
  });

  it("follows the physical key on a layout whose typed key is not a Latin letter", () => {
    expect(key({ key: "я", code: "KeyZ" }), "Cyrillic").toBe(true);
    expect(key({ key: "ئ", code: "KeyZ" }), "Arabic").toBe(true);
    expect(key({ key: "я", code: "KeyZ", ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("does not take another physical key of such a layout, or another Latin letter on the Z position", () => {
    expect(key({ key: "я", code: "KeyY" })).toBe(false);
    expect(key({ key: "y", code: "KeyZ" }), "a layout whose Z position types a Latin y (QWERTZ) is read by what it types").toBe(false);
    expect(key({ key: "Dead", code: "KeyY" })).toBe(false);
  });

  it("is not Redo (Shift), not Alt, and needs Ctrl or Cmd", () => {
    expect(key({ shiftKey: true })).toBe(false);
    expect(key({ altKey: true })).toBe(false);
    expect(key({ ctrlKey: false })).toBe(false);
    expect(key({ ctrlKey: false, key: "я" }), "no modifier on a Cyrillic layout").toBe(false);
    expect(key({ shiftKey: true, key: "я" })).toBe(false);
    expect(key({ altKey: true, key: "я" })).toBe(false);
  });
});
