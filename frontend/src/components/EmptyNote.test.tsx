import { render, screen } from "@testing-library/react";
import { EmptyNote } from "./EmptyNote";

describe("EmptyNote", () => {
  it("is one row: an aria-hidden icon tile, then the sentence as the direct text of a paragraph", () => {
    const { container } = render(<EmptyNote icon="rate">No site default rate yet.</EmptyNote>);
    const note = container.firstElementChild as HTMLElement;
    expect(note).toHaveClass("empty-note");
    const tile = note.querySelector(".empty-note-icon")!;
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile.querySelector("svg.i")).not.toBeNull();
    const sentence = screen.getByText("No site default rate yet.");
    expect(sentence.tagName).toBe("P");
    expect(sentence.parentElement).toBe(note);
    expect([...sentence.childNodes].every((node) => node.nodeType === Node.TEXT_NODE)).toBe(true);
    expect(note.textContent).toBe("No site default rate yet.");
  });

  it("draws the icon it is given", () => {
    const { container } = render(<EmptyNote icon="override">x</EmptyNote>);
    const path = container.querySelector(".empty-note-icon svg.i path")!;
    expect(path.getAttribute("d")).toBe("M5 21V4h9v17"); // the first stroke of the override icon
  });

  it("puts an action node after the sentence, and has none without one", () => {
    const { container, rerender } = render(<EmptyNote icon="audit">No entries.</EmptyNote>);
    expect(container.querySelector("button")).toBeNull();
    expect(container.firstElementChild!.children).toHaveLength(2);
    rerender(<EmptyNote icon="audit" action={<button type="button">Clear filters</button>}>No entries.</EmptyNote>);
    const children = [...container.firstElementChild!.children];
    expect(children).toHaveLength(3);
    expect(children[2]).toBe(screen.getByRole("button", { name: "Clear filters" }));
    expect(children[2]).not.toBe(screen.getByText("No entries."));
  });

  it("holds no heading and no role of its own (it is a note inside a card, not a region)", () => {
    const { container } = render(<EmptyNote icon="audit">Nothing here.</EmptyNote>);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("[role]")).toBeNull();
  });
});
