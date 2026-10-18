import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState, type ReactNode } from "react";
import { Drawer } from "./Drawer";
import { Modal } from "./Modal";

/**
 * The app around a drawer, as Layout and Toasts build it: a skip link and a `.shell` (with `main#main`) inside the React root, and the
 * toast stack as a sibling of the shell, outside it. The opener sits inside the shell, so it is what the drawer makes inert.
 */
function Host({ children, footer, returnFocus, onClose, startOpen = false }: {
  children?: ReactNode;
  footer?: ReactNode;
  returnFocus?: () => HTMLElement | null;
  onClose?: () => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="shell">
        <button>before</button>
        <button onClick={() => setOpen(true)}>Open</button>
        <main id="main" tabIndex={-1}><p>the page</p></main>
      </div>
      <div className="toast-stack"><button>Dismiss toast</button></div>
      {open && (
        <Drawer title="Audit entry" footer={footer} returnFocus={returnFocus} onClose={() => { onClose?.(); setOpen(false); }}>
          {children ?? <p>the entry</p>}
        </Drawer>
      )}
    </>
  );
}

const openIt = () => userEvent.click(screen.getByRole("button", { name: "Open" }));
const panel = () => screen.getByRole("dialog", { name: "Audit entry" });
const backdrop = () => document.querySelector<HTMLElement>(".drawer-backdrop")!;
const shell = () => document.querySelector(".shell")!;
const html = document.documentElement;

describe("Drawer", () => {
  describe("what it is", () => {
    it("is a modal dialog named by its title, on document.body and not inside the page", () => {
      const { container } = render(<Host startOpen />);
      expect(panel()).toHaveAttribute("aria-modal", "true");
      expect(screen.getByRole("heading", { level: 2, name: "Audit entry" })).toBeInTheDocument();
      expect(backdrop().parentElement).toBe(document.body);
      expect(container.contains(panel())).toBe(false);
      expect(panel()).toHaveTextContent("the entry");
    });

    it("has a Close button, named Close, that calls onClose", async () => {
      const onClose = vi.fn();
      render(<Host startOpen onClose={onClose} />);
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("shows the footer only when it is given one, below the body", () => {
      const { unmount } = render(<Host startOpen />);
      expect(document.querySelector(".drawer-foot")).toBeNull();
      unmount();
      render(<Host startOpen footer={<button>Previous</button>} />);
      const foot = document.querySelector(".drawer-foot")!;
      expect(foot).toContainElement(screen.getByRole("button", { name: "Previous" }));
      expect(panel().querySelector(".drawer-body")!.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("is the plain panel by default, and `wide` adds the class drawer-wide and changes nothing else", () => {
      const { unmount } = render(<Drawer title="Plain" onClose={() => {}}>body</Drawer>);
      const plain = screen.getByRole("dialog", { name: "Plain" });
      expect(plain.className).toBe("drawer");
      const [plainRole, plainModal, plainTab] = [plain.getAttribute("role"), plain.getAttribute("aria-modal"), plain.getAttribute("tabindex")];
      unmount();
      render(<Drawer title="Wide" wide onClose={() => {}}>body</Drawer>);
      const wide = screen.getByRole("dialog", { name: "Wide" });
      expect(wide.className).toBe("drawer drawer-wide");
      expect([wide.getAttribute("role"), wide.getAttribute("aria-modal"), wide.getAttribute("tabindex")]).toEqual([plainRole, plainModal, plainTab]);
    });
  });

  describe("focus", () => {
    it("moves onto the panel itself on open (not onto a control), also under StrictMode", async () => {
      render(<StrictMode><Host footer={<button>Next</button>} /></StrictMode>);
      await openIt();
      expect(panel()).toHaveFocus();
    });

    it("Tab and Shift+Tab wrap round the panel's controls, links included, and skip a disabled button", async () => {
      render(<Host footer={<><button>Previous</button><button disabled>Next</button></>}><a href="#x">Open asset X</a></Host>);
      await openIt();
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      await userEvent.tab();
      expect(screen.getByRole("link", { name: "Open asset X" })).toHaveFocus();
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Previous" })).toHaveFocus();
      await userEvent.tab(); // would be the disabled Next, then the page
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Previous" })).toHaveFocus();
    });

    it("a link as the last control wraps too: Tab from it goes to Close, Shift+Tab from Close goes to it", async () => {
      render(<Host><a href="#x">Open asset X</a></Host>);
      await openIt();
      const link = screen.getByRole("link", { name: "Open asset X" });
      link.focus();
      expect(fireEvent.keyDown(link, { key: "Tab" })).toBe(false);
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      expect(fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true })).toBe(false);
      expect(link).toHaveFocus();
    });

    it("Shift+Tab from the panel itself lands on the last control, and the browser's own move is cancelled", async () => {
      render(<Host footer={<button>Previous</button>} />);
      await openIt();
      expect(fireEvent.keyDown(panel(), { key: "Tab", shiftKey: true })).toBe(false);
      expect(screen.getByRole("button", { name: "Previous" })).toHaveFocus();
    });

    it("a control marked tabindex -1 (the hidden copy field) is not a Tab stop, even where it would be the last control", async () => {
      render(<Host><textarea readOnly tabIndex={-1} aria-label="copy field" /></Host>);
      await openIt();
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      await userEvent.tab(); // Close is the only stop: Tab wraps onto itself
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });

    it("Tab with focus on the page body (a focused button went away) goes into the drawer", async () => {
      render(<Host footer={<button>Previous</button>} />);
      await openIt();
      (document.activeElement as HTMLElement).blur();
      expect(document.body).toHaveFocus();
      expect(fireEvent.keyDown(document.body, { key: "Tab" })).toBe(false);
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
      expect(screen.getByRole("button", { name: "Previous" })).toHaveFocus();
    });

    it("pulls focus that lands on the page behind back onto the panel", async () => {
      render(<Host />);
      await openIt();
      screen.getByRole("button", { name: "before" }).focus();
      expect(panel()).toHaveFocus();
    });

    it("lets focus stay in the toast stack (a toast's own close button), which sits outside the shell", async () => {
      render(<Host />);
      await openIt();
      screen.getByRole("button", { name: "Dismiss toast" }).focus();
      expect(screen.getByRole("button", { name: "Dismiss toast" })).toHaveFocus();
    });

    it("lets focus stay in another modal dialog above it (that dialog traps for itself)", async () => {
      render(<Host><p>entry</p></Host>);
      await openIt();
      const other = document.createElement("div");
      other.setAttribute("role", "dialog");
      other.setAttribute("aria-modal", "true");
      other.innerHTML = '<button id="other-btn">Confirm</button>';
      document.body.appendChild(other);
      document.getElementById("other-btn")!.focus();
      expect(document.getElementById("other-btn")).toHaveFocus();
      other.remove();
    });
  });

  describe("closing", () => {
    it("Escape calls onClose, also with focus in the toast stack", async () => {
      const onClose = vi.fn();
      render(<Host onClose={onClose} />);
      await openIt();
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      await openIt();
      screen.getByRole("button", { name: "Dismiss toast" }).focus();
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("Escape typed in a modal dialog above the drawer is that dialog's, not the drawer's", async () => {
      const onClose = vi.fn();
      render(<Host onClose={onClose} />);
      await openIt();
      const other = document.createElement("div");
      other.setAttribute("role", "dialog");
      other.setAttribute("aria-modal", "true");
      other.innerHTML = '<button id="other-btn">Confirm</button>';
      document.body.appendChild(other);
      document.getElementById("other-btn")!.focus();
      await userEvent.keyboard("{Escape}");
      expect(onClose).not.toHaveBeenCalled();
      other.remove();
    });

    it("a Modal rendered inside the drawer's content (a delete confirmation) takes its own Escape and its own Tab", async () => {
      function Content() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>Delete</button>
            {open && <Modal title="Delete it?" onClose={() => setOpen(false)}><button>Cancel</button><button>Confirm</button></Modal>}
          </>
        );
      }
      const onClose = vi.fn();
      render(<Host onClose={onClose} startOpen><Content /></Host>);
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      const drawerClose = vi.fn(); // the Modal's own focus backstop would hide a drawer wrap that went to Close and was pulled back, so watch Close itself
      screen.getByRole("button", { name: "Close" }).addEventListener("focus", drawerClose);
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
      await userEvent.tab(); // the Modal's last control: its own wrap, not the drawer's
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
      expect(drawerClose).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Delete it?" })).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(panel()).toBeInTheDocument();
      await userEvent.keyboard("{Escape}"); // the Modal is gone: now it is the drawer's
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape after a re-render calls the new onClose, not the first one", async () => {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = render(<Drawer title="t" onClose={first}>body</Drawer>);
      rerender(<Drawer title="t" onClose={second}>body</Drawer>);
      await userEvent.keyboard("{Escape}");
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("a click on the backdrop closes it, a click inside the panel does not", async () => {
      const onClose = vi.fn();
      render(<Host onClose={onClose} startOpen><button>inside</button></Host>);
      await userEvent.click(screen.getByRole("button", { name: "inside" }));
      await userEvent.click(panel());
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.click(backdrop());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("a press that began in the panel and was released on the backdrop (a text-selection drag) does not close it", () => {
      const onClose = vi.fn();
      render(<Host onClose={onClose} startOpen><p>select me</p></Host>);
      fireEvent.mouseDown(screen.getByText("select me"));
      fireEvent.mouseUp(backdrop());
      fireEvent.click(backdrop()); // a drag from one element to another clicks their common ancestor
      expect(onClose).not.toHaveBeenCalled();
    });

    it("a press that began on the backdrop and was released inside the panel does not close it either", () => {
      const onClose = vi.fn();
      render(<Host onClose={onClose} startOpen><p>select me</p></Host>);
      fireEvent.mouseDown(backdrop());
      fireEvent.mouseUp(screen.getByText("select me"));
      fireEvent.click(backdrop());
      expect(onClose).not.toHaveBeenCalled();
    });

    it("a stale press does not leak into the next click (press and release on the backdrop, one click, one close)", async () => {
      const onClose = vi.fn();
      render(<Host onClose={onClose} startOpen />);
      fireEvent.mouseDown(screen.getByText("the entry"));
      fireEvent.mouseUp(backdrop());
      fireEvent.click(backdrop());
      await userEvent.click(backdrop());
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("the page behind it", () => {
    it("makes .shell and .skip-link inert while open and nothing else: not the root, the toast stack or the drawer", async () => {
      const { container } = render(<Host />);
      expect(shell()).not.toHaveAttribute("inert");
      await openIt();
      expect(shell()).toHaveAttribute("inert");
      expect(document.querySelector(".skip-link")).toHaveAttribute("inert");
      expect(container).not.toHaveAttribute("inert");
      expect(document.body).not.toHaveAttribute("inert");
      expect(document.querySelector(".toast-stack")).not.toHaveAttribute("inert");
      expect(backdrop()).not.toHaveAttribute("inert");
      await userEvent.keyboard("{Escape}");
      expect(shell()).not.toHaveAttribute("inert");
      expect(document.querySelector(".skip-link")).not.toHaveAttribute("inert");
    });

    it("under StrictMode (mounted twice) it is inert while open and not after close", async () => {
      render(<StrictMode><Host /></StrictMode>);
      await openIt();
      expect(shell()).toHaveAttribute("inert");
      expect(document.querySelector(".skip-link")).toHaveAttribute("inert");
      await userEvent.keyboard("{Escape}");
      expect(shell()).not.toHaveAttribute("inert");
      expect(document.querySelector(".skip-link")).not.toHaveAttribute("inert");
    });

    it("leaves an inert it did not set alone", async () => {
      render(<Host />);
      document.querySelector(".skip-link")!.setAttribute("inert", "");
      await openIt();
      await userEvent.keyboard("{Escape}");
      expect(document.querySelector(".skip-link")).toHaveAttribute("inert");
      expect(shell()).not.toHaveAttribute("inert");
    });

    it("counts nested opens: the page stays inert and locked until the last drawer is gone", () => {
      function Two({ a, b }: { a: boolean; b: boolean }) {
        return (
          <>
            <div className="shell" />
            {a && <Drawer title="A" onClose={() => {}}>a</Drawer>}
            {b && <Drawer title="B" onClose={() => {}}>b</Drawer>}
          </>
        );
      }
      const { rerender } = render(<Two a b />);
      expect(shell()).toHaveAttribute("inert");
      expect(html.style.overflow).toBe("hidden");
      rerender(<Two a b={false} />);
      expect(shell()).toHaveAttribute("inert");
      expect(html.style.overflow).toBe("hidden");
      rerender(<Two a={false} b={false} />);
      expect(shell()).not.toHaveAttribute("inert");
      expect(html.style.overflow).toBe("");
    });

    it("unmounting the drawer from above (the route changed) lifts everything too", () => {
      const view = render(<Host startOpen />);
      expect(shell()).toHaveAttribute("inert");
      view.unmount();
      expect(html.getAttribute("style") ?? "").toBe("");
    });
  });

  describe("scroll lock (the document scrolls: lock <html>)", () => {
    afterEach(() => {
      html.removeAttribute("style");
      delete (html as unknown as { clientWidth?: number }).clientWidth;
    });
    /** A browser's classic scrollbar: it takes `px` of the viewport width until overflow is hidden. */
    const scrollbar = (px: number) =>
      Object.defineProperty(html, "clientWidth", { configurable: true, get: () => window.innerWidth - (html.style.overflow === "hidden" ? 0 : px) });

    it("hides the overflow of <html>, adds scrollbar-gutter: stable only when a scrollbar was there, and restores both", async () => {
      scrollbar(15);
      render(<Host />);
      await openIt();
      expect(html.style.overflow).toBe("hidden");
      expect(html.style.getPropertyValue("scrollbar-gutter")).toBe("stable"); // measured before the overflow was hidden, so not 0
      await userEvent.keyboard("{Escape}");
      expect(html.getAttribute("style") ?? "").toBe("");
    });

    it("sets no scrollbar-gutter when the page had no scrollbar (overlay scrollbars, or a short page)", async () => {
      scrollbar(0);
      render(<Host />);
      await openIt();
      expect(html.style.overflow).toBe("hidden");
      expect(html.style.getPropertyValue("scrollbar-gutter")).toBe("");
    });

    it("never touches <body>", async () => {
      scrollbar(15);
      render(<Host />);
      await openIt();
      expect(document.body.getAttribute("style") ?? "").toBe("");
    });

    it("puts back the exact inline values that were there before", async () => {
      scrollbar(15);
      html.style.overflow = "scroll";
      html.style.setProperty("scrollbar-gutter", "stable both-edges");
      render(<Host />);
      await openIt();
      expect(html.style.overflow).toBe("hidden");
      await userEvent.keyboard("{Escape}");
      expect(html.style.overflow).toBe("scroll");
      expect(html.style.getPropertyValue("scrollbar-gutter")).toBe("stable both-edges");
    });

    it("is restored exactly under StrictMode, which locks twice", async () => {
      scrollbar(15);
      html.style.overflow = "auto";
      render(<StrictMode><Host /></StrictMode>);
      await openIt();
      expect(html.style.overflow).toBe("hidden");
      await userEvent.keyboard("{Escape}");
      expect(html.style.overflow).toBe("auto");
      expect(html.style.getPropertyValue("scrollbar-gutter")).toBe("");
    });
  });

  describe("keys that scroll the body while the panel itself has focus", () => {
    // jsdom has no layout: the body's size is set by hand, and scrollTop is a plain number there. Real scrolling (a browser painting the
    // result, smooth scrolling off) was not measured; the keys and the arithmetic are.
    function body(over = 1000, shown = 400) {
      const el = panel().querySelector<HTMLElement>(".drawer-body")!;
      Object.defineProperty(el, "scrollHeight", { value: over, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: shown, configurable: true });
      el.scrollTop = 0;
      return el;
    }
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      panel().dispatchEvent(event);
      return event;
    };

    it("PageDown and PageUp move by a page (the body's height less a little), never past either end", () => {
      render(<Host startOpen />);
      const el = body();
      expect(press("PageDown").defaultPrevented).toBe(true);
      expect(el.scrollTop).toBe(360);
      press("PageDown");
      expect(el.scrollTop).toBe(600); // the end: 1000 - 400
      expect(press("PageDown").defaultPrevented, "nothing left to scroll: the key is left alone").toBe(false);
      press("PageUp");
      expect(el.scrollTop).toBe(240);
      press("PageUp");
      expect(el.scrollTop).toBe(0);
      expect(press("PageUp").defaultPrevented).toBe(false);
    });

    it("the arrows move 40px, Home and End go to the ends", () => {
      render(<Host startOpen />);
      const el = body();
      press("ArrowDown");
      expect(el.scrollTop).toBe(40);
      press("ArrowDown");
      expect(el.scrollTop).toBe(80);
      press("ArrowUp");
      expect(el.scrollTop).toBe(40);
      expect(press("End").defaultPrevented).toBe(true);
      expect(el.scrollTop).toBe(600);
      expect(press("Home").defaultPrevented).toBe(true);
      expect(el.scrollTop).toBe(0);
    });

    it("leaves the keys alone when the body does not overflow", () => {
      render(<Host startOpen />);
      const el = body(300, 400);
      for (const key of ["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"]) expect(press(key).defaultPrevented, key).toBe(false);
      expect(el.scrollTop).toBe(0);
    });

    it("keeps focus on the panel (it names the dialog) and leaves other keys and modifier chords alone", () => {
      render(<Host startOpen />);
      const el = body();
      expect(panel()).toHaveFocus();
      press("PageDown");
      expect(panel()).toHaveFocus();
      expect(press("a").defaultPrevented).toBe(false);
      expect(press(" ").defaultPrevented).toBe(false);
      for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) expect(press("End", init).defaultPrevented, JSON.stringify(init)).toBe(false);
      expect(el.scrollTop).toBe(360); // only the PageDown above moved it
    });

    it("does nothing when the key comes from a control inside the panel (a textarea, a select and the page's own keys keep theirs)", () => {
      render(<Host startOpen footer={<button>Next</button>}><textarea aria-label="note" /></Host>);
      const el = body();
      const note = screen.getByRole("textbox", { name: "note" });
      const event = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
      note.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(el.scrollTop).toBe(0);
    });

    it("has no extra Tab stop: the body is not focusable", () => {
      render(<Host startOpen />);
      expect(panel().querySelector(".drawer-body")).not.toHaveAttribute("tabindex");
    });
  });

  describe("where focus goes when it closes", () => {
    it("back to the element that had it (a keyboard user's button)", async () => {
      render(<Host />);
      const opener = screen.getByRole("button", { name: "Open" });
      opener.focus();
      await userEvent.keyboard("{Enter}");
      expect(panel()).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(opener).toHaveFocus();
    });

    it("still goes back to the opener under StrictMode", async () => {
      render(<StrictMode><Host /></StrictMode>);
      const opener = screen.getByRole("button", { name: "Open" });
      await userEvent.click(opener);
      expect(panel()).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(opener).toHaveFocus();
    });

    it("returnFocus decides when it is given: its element gets focus, not the opener", async () => {
      const target = () => screen.getByRole("button", { name: "before" });
      render(<Host returnFocus={target} />);
      await openIt();
      await userEvent.keyboard("{Escape}");
      expect(target()).toHaveFocus();
    });

    it("returnFocus is asked at close time, not at open time, and the latest one is the one asked", async () => {
      const first = vi.fn(() => null);
      const second = vi.fn(() => screen.getByRole("button", { name: "before" }));
      const { rerender } = render(<Host returnFocus={first} />);
      await openIt();
      expect(first).not.toHaveBeenCalled();
      rerender(<Host returnFocus={second} />);
      await userEvent.keyboard("{Escape}");
      expect(second).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "before" })).toHaveFocus();
    });

    it("when returnFocus finds nothing (null) focus goes to #main, not back to the opener", async () => {
      render(<Host returnFocus={() => null} />);
      await openIt();
      await userEvent.keyboard("{Escape}");
      expect(document.getElementById("main")).toHaveFocus();
    });

    it("when returnFocus names an element that is no longer in the page, focus goes to #main", async () => {
      const gone = document.createElement("button");
      render(<Host returnFocus={() => gone} />);
      await openIt();
      await userEvent.keyboard("{Escape}");
      expect(document.getElementById("main")).toHaveFocus();
    });

    it("when the drawer opened with nothing focused (a deep link: the saved element is the body), focus goes to #main", async () => {
      render(<Host startOpen />);
      expect(panel()).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(document.getElementById("main")).toHaveFocus();
    });

    it("when the element that had focus is gone by the time it closes, focus goes to #main", async () => {
      function Vanishing() {
        const [open, setOpen] = useState(false);
        const [gone, setGone] = useState(false);
        return (
          <>
            <main id="main" tabIndex={-1}>page</main>
            {!gone && <button onClick={() => { setOpen(true); }}>Open</button>}
            {open && <Drawer title="Audit entry" onClose={() => setOpen(false)}><button onClick={() => setGone(true)}>Remove the opener</button></Drawer>}
          </>
        );
      }
      render(<Vanishing />);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      await userEvent.click(screen.getByRole("button", { name: "Remove the opener" }));
      expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(document.getElementById("main")).toHaveFocus();
    });

    it("lifts the inert first: an inert element cannot take focus, so the page must be live again when focus goes back", async () => {
      const real = HTMLElement.prototype.focus;
      const calls: Array<{ el: Element; shellInert: boolean }> = [];
      vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        calls.push({ el: this, shellInert: shell().hasAttribute("inert") });
        return real.call(this, options);
      });
      render(<Host />);
      const opener = screen.getByRole("button", { name: "Open" });
      await userEvent.click(opener);
      expect(shell()).toHaveAttribute("inert");
      calls.length = 0;
      await userEvent.keyboard("{Escape}");
      const back = calls.filter((c) => c.el === opener);
      expect(back).toHaveLength(1);
      expect(back[0].shellInert).toBe(false);
    });

    it("saves the opener before it makes the page inert (a browser blurs a focused element when its ancestor turns inert)", async () => {
      const calls: string[] = [];
      render(<Host />);
      const opener = screen.getByRole("button", { name: "Open" });
      opener.focus();
      // The moment the shell turns inert, a real browser moves focus to the body: model that, and the opener must still be remembered.
      const set = Element.prototype.setAttribute;
      vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name: string, value: string) {
        if (name === "inert" && this.classList.contains("shell")) { (document.activeElement as HTMLElement | null)?.blur(); calls.push("blurred"); }
        return set.call(this, name, value);
      });
      await userEvent.keyboard("{Enter}");
      expect(calls).toContain("blurred");
      await userEvent.keyboard("{Escape}");
      expect(opener).toHaveFocus();
    });
  });
});
