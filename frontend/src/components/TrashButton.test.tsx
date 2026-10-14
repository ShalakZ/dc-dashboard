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

  describe("labelled (the page header's Delete)", () => {
    it("shows the word Delete beside the bin, is named for what it deletes, and is a normal outlined button, not an icon button", () => {
      render(<TrashButton label="Delete Boiler" onClick={() => {}} labelled />);
      const button = screen.getByRole("button", { name: "Delete Boiler" }); // the aria-label starts with the visible word: label in name
      expect(button).toHaveTextContent(/^Delete$/);
      expect(button).toHaveClass("trash-btn", "trash-btn-labelled");
      expect(button).not.toHaveClass("icon-btn"); // .icon-btn is a 28px borderless square; this one is as tall as Add asset and Edit
      expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(button.querySelectorAll("svg g.lid")).toHaveLength(1); // the lid still lifts
    });

    it("calls onClick once per click, and when disabled cannot be clicked and carries its title and description", async () => {
      const onClick = vi.fn();
      const { rerender } = render(<TrashButton label="Delete Boiler" onClick={onClick} labelled />);
      await userEvent.click(screen.getByRole("button", { name: "Delete Boiler" }));
      expect(onClick).toHaveBeenCalledTimes(1);
      rerender(<TrashButton label="Delete Boiler" onClick={onClick} labelled disabled title="Busy." describedBy="why" />);
      const button = screen.getByRole("button", { name: "Delete Boiler" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Busy.");
      expect(button).toHaveAttribute("aria-describedby", "why");
      await userEvent.click(button);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("the icon-only button stays as it was: no visible text", () => {
      render(<TrashButton label="Delete Boiler" onClick={() => {}} />);
      const button = screen.getByRole("button", { name: "Delete Boiler" });
      expect(button).toHaveTextContent("");
      expect(button).not.toHaveClass("trash-btn-labelled");
    });
  });
});
