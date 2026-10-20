import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { templateCards, templatesBody } from "../../test/dashboardFixtures";
import { NOTHING_METERED, TemplateGallery, TEMPLATES_FAILED, type TemplateChoice } from "./TemplateGallery";

function show(over: Partial<Parameters<typeof TemplateGallery>[0]> = {}) {
  const picked: TemplateChoice[] = [];
  const view = render(<TemplateGallery data={templatesBody()} error={null} onPick={(c) => picked.push(c)} {...over} />);
  return { picked, ...view };
}
const names = (list: HTMLElement) => within(list).getAllByRole("button").map((b) => b.getAttribute("data-template"));
const section = (name: string) => screen.getByRole("region", { name });

describe("TemplateGallery", () => {
  it("shows Recommended for this site, then More templates, with Blank last and no card twice", () => {
    show();
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Recommended for this site", "More templates"]);
    expect(names(section("Recommended for this site"))).toEqual(["power", "cost", "areas"]);
    expect(names(section("More templates"))).toEqual(["day", "blank"]);
    const all = screen.getAllByRole("button").map((b) => b.getAttribute("data-template"));
    expect(new Set(all).size).toBe(all.length);
  });

  it("names each card by its title alone and describes it by its line: the Recommended tag is not part of the name", () => {
    show();
    const power = screen.getByRole("button", { name: "Power" });
    expect(power).toHaveAccessibleDescription(templateCards()[0].description);
    expect(within(power).getByText("Recommended")).toHaveClass("tpl-tag");
    expect(screen.getAllByRole("button", { name: "Power" })).toHaveLength(1); // one exact match, with the tag on it
    expect(screen.getByRole("button", { name: "Blank" })).toHaveAccessibleDescription("An empty dashboard. Add the widgets yourself.");
    expect(screen.getAllByText("Recommended")).toHaveLength(3); // the tag of each recommended card only
    const label = power.getAttribute("aria-labelledby")!;
    expect(document.getElementById(label)).toHaveTextContent(/^Power$/);
  });

  it("every card is a real button with a hidden picture and no raster", () => {
    const { container } = show();
    for (const card of screen.getAllByRole("button")) {
      expect(card).toHaveAttribute("type", "button");
      expect(card.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    expect(container.querySelector("img, canvas")).toBeNull();
  });

  it("puts what a template needs on its card, in its description, with no tag", () => {
    show({ data: templatesBody({ templates: templateCards().map((t) => (t.id === "areas" ? { ...t, recommended: false, needs: "Needs at least two areas with a meter." } : t)) }) });
    const areas = screen.getByRole("button", { name: "Energy by area" });
    expect(areas).toHaveTextContent("Needs at least two areas with a meter.");
    expect(areas).toHaveAccessibleDescription(expect.stringContaining("Needs at least two areas with a meter."));
    expect(within(areas).queryByText("Recommended")).toBeNull();
    expect(names(section("Recommended for this site"))).toEqual(["power", "cost"]);
    expect(names(section("More templates"))).toEqual(["areas", "day", "blank"]);
  });

  it("says nothing is metered, with no tag at all, and still lists every template", () => {
    show({ data: templatesBody({ nothing_metered: true, templates: templateCards().map((t) => ({ ...t, recommended: false })) }) });
    expect(screen.getByText(NOTHING_METERED)).toBeInTheDocument();
    expect(screen.queryByText("Recommended")).toBeNull();
    expect(screen.queryByRole("region", { name: "Recommended for this site" })).toBeNull();
    expect(names(section("More templates"))).toEqual(["power", "cost", "areas", "day", "blank"]);
  });

  it("offers Blank alone, with one plain sentence, while the list loads", async () => {
    const { picked } = show({ data: undefined });
    expect(screen.getByText("Loading templates…")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("data-template"))).toEqual(["blank"]);
    await userEvent.click(screen.getByRole("button", { name: "Blank" }));
    expect(picked).toEqual(["blank"]);
  });

  it("offers Blank alone, with the failure as a sentence (the server's text in its title), when the list failed", async () => {
    const { picked } = show({ data: undefined, error: new Error("boom") });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(TEMPLATES_FAILED);
    expect(alert).toHaveAttribute("title", "boom");
    expect(alert.textContent).not.toMatch(/start from/i);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("data-template"))).toEqual(["blank"]);
    await userEvent.click(screen.getByRole("button", { name: "Blank" }));
    expect(picked).toEqual(["blank"]);
  });

  it("Tab goes through the cards in the order they are drawn; Enter and Space each pick the focused one", async () => {
    const { picked } = show();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Power" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Cost" })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Last 24 hours" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Blank" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(picked).toEqual(["blank"]);
    await userEvent.tab({ shift: true });
    await userEvent.keyboard(" ");
    expect(picked).toEqual(["blank", "day"]);
  });

  it("a click picks the card's id", async () => {
    const { picked } = show();
    await userEvent.click(screen.getByRole("button", { name: "Cost" }));
    await userEvent.click(screen.getByRole("button", { name: "Energy by area" }));
    expect(picked).toEqual(["cost", "areas"]);
  });

  it("focuses the card it is told to when it appears (Back to templates), the first card when that one is gone, and nothing otherwise", () => {
    const first = show({ focusChoice: "cost" });
    expect(screen.getByRole("button", { name: "Cost" })).toHaveFocus();
    first.unmount();
    const second = show({ focusChoice: "day", data: templatesBody({ templates: templateCards().filter((t) => t.id !== "day") }) });
    expect(screen.getByRole("button", { name: "Power" })).toHaveFocus();
    second.unmount();
    show();
    expect(document.body).toHaveFocus();
  });

  it("uses the heading level it is given (2 on the page, 4 under the dialog's step title)", () => {
    const view = show();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
    view.unmount();
    show({ level: 4 });
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(2);
  });
});
