import type { Asset } from "../api/types";
import { childrenNote, chooseText, FOCUS_DENIED_NOTICE, FOCUS_GONE_NOTICE, isFollowing, leafText, NO_ASSETS_TEXT, ownAssetsNote, parseFocusParam, topLevel, withFocus } from "./focus";

const a = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({
  id, parent_id, name, kind: "generic", sort_order,
});

describe("parseFocusParam", () => {
  it("reads a missing parameter as none", () => {
    expect(parseFocusParam(null)).toEqual({ kind: "none" });
  });

  it("reads digits without a leading zero as an id", () => {
    expect(parseFocusParam("1")).toEqual({ kind: "id", id: 1 });
    expect(parseFocusParam("42")).toEqual({ kind: "id", id: 42 });
    expect(parseFocusParam("2147483647")).toEqual({ kind: "id", id: 2147483647 });
  });

  it("treats everything else as invalid, an empty string included", () => {
    for (const raw of ["", "0", "007", "-3", "+3", "1.5", "1e3", "abc", "5x", " 5", "5 ", "0x10", "2147483648", "99999999999999999999"]) {
      expect(parseFocusParam(raw), JSON.stringify(raw)).toEqual({ kind: "invalid" });
    }
  });
});

describe("withFocus", () => {
  it("sets the parameter on an empty search", () => {
    expect(withFocus("", 5)).toBe("?asset=5");
  });

  it("keeps every other parameter, with or without the question mark", () => {
    expect(withFocus("?range=7d&x=1", 5)).toBe("?range=7d&x=1&asset=5");
    expect(withFocus("range=7d", 5)).toBe("?range=7d&asset=5");
  });

  it("replaces a parameter that is already there, in its place", () => {
    expect(withFocus("?asset=2&range=7d", 9)).toBe("?asset=9&range=7d");
  });

  it("removes the parameter and gives an empty string when nothing else is left", () => {
    expect(withFocus("?asset=2&range=7d", null)).toBe("?range=7d");
    expect(withFocus("?asset=2", null)).toBe("");
    expect(withFocus("", null)).toBe("");
  });

  it("removes a repeated parameter and an invalid one", () => {
    expect(withFocus("?asset=a&asset=b&k=1", null)).toBe("?k=1");
  });
});

describe("topLevel", () => {
  it("returns the assets with no parent, or whose parent is not in the list, in (sort_order, name, id) order", () => {
    const list = [a(3, 1, "child"), a(2, null, "b-site"), a(1, null, "a-site"), a(5, 99, "orphan", -1), a(4, null, "a-site")];
    expect(topLevel(list).map((x) => x.id)).toEqual([5, 1, 4, 2]);
  });

  it("compares names by code point, not by locale", () => {
    expect(topLevel([a(1, null, "b"), a(2, null, "B"), a(3, null, "a")]).map((x) => x.name)).toEqual(["B", "a", "b"]);
  });

  it("does not change the list it is given", () => {
    const list = [a(2, null, "b"), a(1, null, "a")];
    topLevel(list);
    expect(list.map((x) => x.id)).toEqual([2, 1]);
  });

  it("returns an empty list for no assets", () => {
    expect(topLevel([])).toEqual([]);
  });
});

describe("the two sentences", () => {
  it("are the rulings' words", () => {
    expect(FOCUS_GONE_NOTICE).toBe("The asset in this link no longer exists, so the dashboard shows the whole site.");
    expect(FOCUS_DENIED_NOTICE).toBe("This link opens the dashboard on one asset. Your role cannot open assets, so it shows the whole site.");
  });
});

describe("isFollowing", () => {
  it("is true for the focus and the children of the focus, false for fixed and for a config from before w25", () => {
    expect(isFollowing({ scope: "focus" })).toBe(true);
    expect(isFollowing({ scope: "children" })).toBe(true);
    expect(isFollowing({ scope: "fixed" })).toBe(false);
    expect(isFollowing({})).toBe(false);
  });
});

describe("what a following card says (R5, R6, R11)", () => {
  it("asks for a focus when the site has several top-level assets, in the ruling's words", () => {
    expect(chooseText(3, true)).toBe("This site has 3 top-level assets: choose a focus to see this figure.");
  });

  it("says the role cannot choose when it lacks the Assets Tree", () => {
    expect(chooseText(3, false)).toBe("This site has 3 top-level assets, so this figure needs a focus asset, and your role cannot choose one.");
  });

  it("says the site is empty for no top-level asset, whoever asks", () => {
    expect(chooseText(0, true)).toBe("This site has no assets yet.");
    expect(chooseText(0, false)).toBe("This site has no assets yet.");
    expect(NO_ASSETS_TEXT).toBe("This site has no assets yet.");
  });

  it("does not make up a count the answer did not carry, and does not say '1 top-level assets'", () => {
    expect(chooseText(null, true)).toBe("Choose a focus to see this figure.");
    expect(chooseText(1, true)).toBe("This site has 1 top-level asset: choose a focus to see this figure.");
  });

  it("does not tell a role that cannot choose to choose, even when the answer carried no count (R3)", () => {
    expect(chooseText(null, false)).toBe("This figure needs a focus asset, and your role cannot choose one.");
  });

  it("says a leaf has no children, by its path", () => {
    expect(leafText("Site / Hall 1 / Row 2")).toBe("Site / Hall 1 / Row 2 has no children.");
  });

  it("counts the children shown of the children there are", () => {
    expect(childrenNote(20, 34, "Hall 1")).toBe("20 of 34 children of Hall 1 shown");
    expect(childrenNote(20, 34, null)).toBe("20 of 34 top-level assets shown");
  });

  it("says a fixed card keeps its own assets", () => {
    expect(ownAssetsNote("Hall 1")).toBe("Its own assets, not Hall 1");
  });
});
