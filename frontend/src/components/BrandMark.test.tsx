import { existsSync } from "node:fs";
import { render } from "@testing-library/react";
import { BRAND_MARK_SRC, BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("is the owner's mark file, which exists in public/", () => {
    expect(BRAND_MARK_SRC).toBe("/logo-mark.svg");
    expect(existsSync(`public${BRAND_MARK_SRC}`)).toBe(true); // vitest runs from the frontend directory
  });

  it("draws the mark 29 by 28 at size 28 and 58 by 56 at size 56 (the square is 155 by 150 units)", () => {
    const small = render(<BrandMark size={28} />);
    const img = small.container.querySelector("img")!;
    expect(img).toHaveAttribute("src", BRAND_MARK_SRC);
    expect(img).toHaveAttribute("width", "29");
    expect(img).toHaveAttribute("height", "28");
    small.unmount();
    const large = render(<BrandMark size={56} />);
    expect(large.container.querySelector("img")).toHaveAttribute("width", "58");
    expect(large.container.querySelector("img")).toHaveAttribute("height", "56");
  });

  it("is decorative: an empty alt, hidden from a screen reader, and it takes no label", () => {
    const { container } = render(<BrandMark size={28} />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("has the class brand-mark by default and takes another", () => {
    const first = render(<BrandMark size={28} />);
    expect(first.container.querySelector("img")).toHaveClass("brand-mark");
    first.unmount();
    const second = render(<BrandMark size={56} className="auth-mark" />);
    const img = second.container.querySelector("img")!;
    expect(img).toHaveClass("auth-mark");
    expect(img).not.toHaveClass("brand-mark");
  });
});
