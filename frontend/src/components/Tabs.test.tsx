import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Tabs, type TabDef } from "./Tabs";

const TWO: TabDef[] = [{ id: "users", label: "Users" }, { id: "roles", label: "Roles" }];
const THREE: TabDef[] = [...TWO, { id: "keys", label: "Keys" }];

/** The parent owns the selected tab (in the app it is the address), so the tests do the same. */
function Harness({ tabs = TWO, start = "users", onSelect }: { tabs?: TabDef[]; start?: string; onSelect?: (id: string) => void }) {
  const [active, setActive] = useState(start);
  return (
    <Tabs label="Users and roles" tabs={tabs} active={active} onSelect={(id) => { onSelect?.(id); setActive(id); }}>
      <p>{`the ${active} panel`}</p>
    </Tabs>
  );
}
const tab = (name: string) => screen.getByRole("tab", { name });

describe("Tabs", () => {
  it("draws a tablist with one tab per entry, the active one selected and the only one in the Tab order", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Users and roles" });
    expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual(["Users", "Roles"]);
    expect(list).toContainElement(tab("Users"));
    expect(tab("Users")).toHaveAttribute("aria-selected", "true");
    expect(tab("Users")).toHaveAttribute("tabindex", "0");
    expect(tab("Roles")).toHaveAttribute("aria-selected", "false");
    expect(tab("Roles")).toHaveAttribute("tabindex", "-1");
    expect(tab("Users")).toHaveAttribute("type", "button");
  });

  it("ties each tab to the panel: ids, aria-controls and aria-labelledby agree, and the panel can take the focus", () => {
    render(<Harness />);
    const panel = screen.getByRole("tabpanel");
    expect(tab("Users")).toHaveAttribute("id", "tab-users");
    expect(tab("Users")).toHaveAttribute("aria-controls", "panel-users");
    expect(panel).toHaveAttribute("id", "panel-users");
    expect(panel).toHaveAttribute("aria-labelledby", "tab-users");
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(panel).toHaveTextContent("the users panel");
    expect(screen.getByRole("tabpanel", { name: "Users" })).toBe(panel);
  });

  it("a click selects the tab and the panel follows", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.click(tab("Roles"));
    expect(onSelect).toHaveBeenCalledWith("roles");
    expect(tab("Roles")).toHaveAttribute("aria-selected", "true");
    expect(tab("Roles")).toHaveAttribute("tabindex", "0");
    expect(tab("Users")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "panel-roles");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("the roles panel");
  });

  it("ArrowRight and ArrowLeft move to the next and the previous tab, select it and take the focus there, and both wrap", async () => {
    const onSelect = vi.fn();
    render(<Harness tabs={THREE} onSelect={onSelect} />);
    tab("Users").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(tab("Roles")).toHaveFocus();
    expect(tab("Roles")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(tab("Keys")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(tab("Users")).toHaveFocus(); // wraps from the last to the first
    await userEvent.keyboard("{ArrowLeft}");
    expect(tab("Keys")).toHaveFocus(); // and back from the first to the last
    await userEvent.keyboard("{ArrowLeft}");
    expect(tab("Roles")).toHaveFocus();
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual(["roles", "keys", "users", "keys", "roles"]);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("the roles panel");
  });

  it("selecting the tab that is already selected (a click, Home on the first tab, End on the last) calls nothing", async () => {
    const onSelect = vi.fn();
    render(<Harness tabs={THREE} onSelect={onSelect} />);
    await userEvent.click(tab("Users"));
    tab("Users").focus();
    await userEvent.keyboard("{Home}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(tab("Users")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("keys");
    await userEvent.keyboard("{End}"); // already on the last
    await userEvent.click(tab("Keys"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(tab("Keys")).toHaveFocus();
  });

  it("Home and End jump to the first and the last tab", async () => {
    render(<Harness tabs={THREE} start="roles" />);
    tab("Roles").focus();
    await userEvent.keyboard("{End}");
    expect(tab("Keys")).toHaveFocus();
    expect(tab("Keys")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Home}");
    expect(tab("Users")).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("the users panel");
  });

  it("other keys do nothing, and Tab leaves the strip for the panel", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    tab("Users").focus();
    await userEvent.keyboard("a{ArrowDown}{ArrowUp}");
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(screen.getByRole("tabpanel")).toHaveFocus(); // the unselected tab is skipped (tabindex -1)
  });

  it("with one tab no strip is drawn and the children are returned bare", () => {
    const { container } = render(<Harness tabs={[{ id: "users", label: "Users" }]} />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(container.innerHTML).toBe("<p>the users panel</p>");
  });
});
