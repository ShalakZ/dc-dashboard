import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuditPager } from "./AuditPager";

function pager(props: { total?: number; offset?: number; size?: number } = {}) {
  const onOffset = vi.fn();
  const onSize = vi.fn();
  const view = render(<AuditPager total={120} offset={0} size={50} {...props} onOffset={onOffset} onSize={onSize} />);
  return { onOffset, onSize, ...view };
}
const button = (name: string) => screen.getByRole("button", { name });

describe("AuditPager", () => {
  it("on the first page disables First and Previous, and Next and Last go forward", async () => {
    const { onOffset } = pager();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–50 of 120")).toBeInTheDocument();
    expect(button("First")).toBeDisabled();
    expect(button("Previous")).toBeDisabled();
    await userEvent.click(button("Next"));
    expect(onOffset).toHaveBeenLastCalledWith(50);
    await userEvent.click(button("Last"));
    expect(onOffset).toHaveBeenLastCalledWith(100);
  });

  it("on the last page disables Next and Last, and First and Previous go back", async () => {
    const { onOffset } = pager({ offset: 100 });
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Showing 101–120 of 120")).toBeInTheDocument();
    expect(button("Next")).toBeDisabled();
    expect(button("Last")).toBeDisabled();
    await userEvent.click(button("Previous"));
    expect(onOffset).toHaveBeenLastCalledWith(50);
    await userEvent.click(button("First"));
    expect(onOffset).toHaveBeenLastCalledWith(0);
  });

  it("pages from an offset that is not a multiple of the page size (after Go to date)", async () => {
    const { onOffset, rerender } = pager({ offset: 73 });
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("Showing 74–120 of 120")).toBeInTheDocument();
    expect(button("Next")).toBeDisabled(); // 73 + 50 is past the end
    expect(button("Last")).toBeDisabled(); // the window already reaches the last entry
    await userEvent.click(button("Previous"));
    expect(onOffset).toHaveBeenLastCalledWith(23);
    rerender(<AuditPager total={120} offset={23} size={50} onOffset={onOffset} onSize={vi.fn()} />);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    await userEvent.click(button("Next"));
    expect(onOffset).toHaveBeenLastCalledWith(73);
    await userEvent.click(button("Last"));
    expect(onOffset).toHaveBeenLastCalledWith(100);
  });

  it("Previous never goes below the start", async () => {
    const { onOffset } = pager({ offset: 10 });
    await userEvent.click(button("Previous"));
    expect(onOffset).toHaveBeenLastCalledWith(0);
  });

  it("goes to the typed page on Enter and clamps it into range", async () => {
    const { onOffset } = pager();
    const input = screen.getByRole("spinbutton", { name: "Page" });
    expect(input).toHaveValue(1);
    await userEvent.clear(input);
    await userEvent.type(input, "99{Enter}");
    expect(onOffset).toHaveBeenLastCalledWith(100);
    await userEvent.clear(input);
    await userEvent.type(input, "0{Enter}");
    expect(onOffset).toHaveBeenLastCalledWith(0);
    await userEvent.clear(input);
    await userEvent.type(input, "2");
    await userEvent.tab(); // leaving the box applies it too
    expect(onOffset).toHaveBeenLastCalledWith(50);
  });

  it("does nothing for an empty page box", async () => {
    const { onOffset } = pager({ offset: 50 });
    const input = screen.getByRole("spinbutton", { name: "Page" });
    await userEvent.clear(input);
    await userEvent.tab();
    expect(onOffset).not.toHaveBeenCalled();
    expect(input).toHaveValue(2); // back to the real page
  });

  it("changes the page size from the Rows per page select", async () => {
    const { onSize } = pager();
    const select = screen.getByRole("combobox", { name: "Rows per page" });
    expect(select).toHaveValue("50");
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["25", "50", "100", "200"]);
    await userEvent.selectOptions(select, "100");
    expect(onSize).toHaveBeenCalledWith(100);
  });

  it("renders nothing when there are no entries", () => {
    const { container } = pager({ total: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it("past the end of the log it keeps the controls, does not claim a range, and offers the way back", async () => {
    const { onOffset } = pager({ offset: 200 });
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    expect(button("Next")).toBeDisabled();
    await userEvent.click(button("First"));
    expect(onOffset).toHaveBeenLastCalledWith(0);
    await userEvent.click(button("Last")); // the only way forward is back to the real last page
    expect(onOffset).toHaveBeenLastCalledWith(100);
  });
});
