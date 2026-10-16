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

  it("the key that TYPES z undoes on any layout, and the physical Z position of a layout that types another ASCII character does not", () => {
    expect(key({ key: "z", code: "KeyY" }), "QWERTZ: the key that types z sits where QWERTY has Y").toBe(true);
    expect(key({ key: "y", code: "KeyZ" }), "QWERTZ: the physical Z position types y").toBe(false);
    expect(key({ key: "w", code: "KeyZ" }), "AZERTY: the Z position types w").toBe(false);
    expect(key({ key: ";", code: "KeyZ" }), "Dvorak: the Z position types a semicolon").toBe(false);
    expect(key({ key: ";", code: "KeyZ", ctrlKey: false, metaKey: true }), "Dvorak, Cmd").toBe(false);
    expect(key({ key: "z", code: "Slash" }), "Dvorak: the key that types z is on the Slash position").toBe(true);
    expect(key({ key: "Dead", code: "KeyZ" }), "a dead key on that position").toBe(false);
    expect(key({ key: "Unidentified", code: "KeyZ" })).toBe(false);
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
