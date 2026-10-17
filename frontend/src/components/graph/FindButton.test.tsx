import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { FindButton } from "./FindButton";

function mount(props: Partial<React.ComponentProps<typeof FindButton>> = {}) {
  const onToggle = vi.fn();
  const buttonRef = createRef<HTMLButtonElement>();
  const view = render(<FindButton open={false} cardId="card-1" onToggle={onToggle} buttonRef={buttonRef} {...props} />);
  return { onToggle, buttonRef, ...view };
}
const find = () => screen.getByRole("button", { name: "Find" });

describe("FindButton", () => {
  it("is a button named Find with the search icon, closed: aria-expanded false and no aria-controls", () => {
    mount();
    expect(find()).toHaveAttribute("type", "button");
    expect(find()).toHaveAttribute("aria-expanded", "false");
    expect(find()).not.toHaveAttribute("aria-controls");
    expect(find().querySelector("svg.i")).not.toBeNull();
  });

  it("while its card is open it says so and names the card", () => {
    mount({ open: true, cardId: "the-card" });
    expect(find()).toHaveAttribute("aria-expanded", "true");
    expect(find()).toHaveAttribute("aria-controls", "the-card");
  });

  it("names its shortcut for assistive technology without putting it in the name, and says it in the tooltip", () => {
    mount();
    expect(find()).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
    expect(find()).toHaveAttribute("title", "Find on the canvas (Ctrl+K)");
    expect(find()).toHaveAccessibleName("Find");
  });

  it("its word sits in a span the bar's CSS can hide visually (never display: none), so the name survives an icon-only bar", () => {
    mount();
    const word = find().querySelector(".gbar-lbl");
    expect(word).toHaveTextContent("Find");
  });

  it("a click asks for a toggle, and the ref reaches the button (the card returns the focus to it)", async () => {
    const { onToggle, buttonRef } = mount();
    expect(buttonRef.current).toBe(find());
    await userEvent.click(find());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
