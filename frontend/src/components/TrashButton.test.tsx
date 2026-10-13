import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrashButton } from "./TrashButton";

describe("TrashButton", () => {
  it("is a button named by its label, with a decorative bin whose lid is a group of its own", () => {
    render(<TrashButton label="Delete Boiler" onClick={() => {}} />);
    const button = screen.getByRole("button", { name: "Delete Boiler" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("icon-btn", "trash-btn");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(button.querySelectorAll("svg g.lid")).toHaveLength(1);
  });

  it("calls onClick once per click", async () => {
    const onClick = vi.fn();
    render(<TrashButton label="Delete Boiler" onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Boiler" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("when disabled, cannot be clicked and is not offered to the keyboard", async () => {
    const onClick = vi.fn();
    render(<TrashButton label="Delete me" onClick={onClick} disabled />);
    const button = screen.getByRole("button", { name: "Delete me" });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    await userEvent.tab();
    expect(onClick).not.toHaveBeenCalled();
    expect(button).not.toHaveFocus();
  });

  it("carries a title and a description when it is given them, and neither otherwise", () => {
    const { rerender } = render(<TrashButton label="Delete Executive" onClick={() => {}} disabled title="In use by 1 account." describedBy="why" />);
    const button = screen.getByRole("button", { name: "Delete Executive" });
    expect(button).toHaveAttribute("title", "In use by 1 account.");
    expect(button).toHaveAttribute("aria-describedby", "why");
    rerender(<TrashButton label="Delete Executive" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Delete Executive" })).not.toHaveAttribute("title");
    expect(screen.getByRole("button", { name: "Delete Executive" })).not.toHaveAttribute("aria-describedby");
  });
});
