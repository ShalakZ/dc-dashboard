import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageCard } from "./PageCard";

describe("PageCard", () => {
  it("is a section with a head (icon tile, the h2 and a one-line purpose) and the body after it", () => {
    const { container } = render(
      <PageCard icon="currency" title="Currency" purpose="The unit costs are shown in.">
        <p>Body text</p>
      </PageCard>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveClass("page-card");
    const heading = screen.getByRole("heading", { level: 2, name: "Currency" });
    const head = heading.closest(".page-card-head")!;
    expect(head).toHaveClass("sect-head"); // the class names Tariffs' tests and e2e steps read
    expect(head.parentElement).toBe(card);
    expect(card.firstElementChild).toBe(head);
    const tile = head.querySelector(":scope > svg.i")!;
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(heading.querySelector("svg")).toBeNull(); // beside the heading, not in its name
    const purpose = within(head as HTMLElement).getByText("The unit costs are shown in.");
    expect(purpose).toHaveClass("sect-purpose", "muted");
    expect(purpose.tagName).toBe("P");
    expect(card.lastElementChild).toBe(screen.getByText("Body text"));
  });

  it("has no region role and no aria-labelledby: the h2 is the structure (a label on the section would be a second match for getByLabelText)", () => {
    const { container } = render(<PageCard icon="rate" title="Currency"><label>Currency <input /></label></PageCard>);
    expect(container.firstElementChild).not.toHaveAttribute("aria-labelledby");
    expect(container.firstElementChild).not.toHaveAttribute("aria-label");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getAllByLabelText("Currency")).toHaveLength(1);
  });

  it("puts headingId on the h2 and nowhere else", () => {
    const { container } = render(<PageCard icon="password" title="Sign-in protection" headingId="sign-in-protection">x</PageCard>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute("id", "sign-in-protection");
    expect(container.querySelectorAll("[id]")).toHaveLength(1);
    const plain = render(<PageCard icon="password" title="Other">x</PageCard>);
    expect(plain.container.querySelector("[id]")).toBeNull();
  });

  it("draws no purpose line when none is given", () => {
    const { container } = render(<PageCard icon="rate" title="Currency">x</PageCard>);
    expect(container.querySelector(".sect-purpose")).toBeNull();
  });

  it("draws the footer only when given, as the last child of the card", () => {
    const { container, rerender } = render(<PageCard icon="rate" title="Currency">Body</PageCard>);
    expect(container.querySelector(".page-card-foot")).toBeNull();
    rerender(<PageCard icon="rate" title="Currency" footer={<p>Foot note</p>}>Body</PageCard>);
    const foot = container.querySelector(".page-card-foot")!;
    expect(foot).toHaveTextContent("Foot note");
    expect(container.firstElementChild!.lastElementChild).toBe(foot);
  });

  it("renders a tip as an InfoTip button at the end of the head, and no button without one", async () => {
    const { container, rerender } = render(<PageCard icon="rate" title="Currency">x</PageCard>);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<PageCard icon="rate" title="Currency" tip="What the card is for.">x</PageCard>);
    const button = screen.getByRole("button", { name: "What does this mean?" });
    const head = container.querySelector(".page-card-head")!;
    expect(head.lastElementChild).toContainElement(button);
    expect(button.closest(".tip")).not.toBeNull();
    await userEvent.click(button);
    expect(screen.getByRole("note")).toHaveTextContent("What the card is for.");
  });

  it("takes a className next to its own", () => {
    const { container } = render(<PageCard icon="rate" title="Currency" className="rows-day">x</PageCard>);
    expect(container.firstElementChild).toHaveClass("page-card", "rows-day");
  });

  it("keeps a form of its body inside the card as the card's own child, so the Save button stays inside its form", () => {
    const { container } = render(
      <PageCard icon="rate" title="Currency">
        <form aria-label="Site currency"><button type="submit">Save</button></form>
      </PageCard>,
    );
    const form = screen.getByRole("form", { name: "Site currency" });
    expect(form.parentElement).toBe(container.firstElementChild);
    expect(within(form).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
