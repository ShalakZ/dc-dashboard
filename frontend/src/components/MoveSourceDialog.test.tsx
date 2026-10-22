import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { api } from "../api/client";
import { keys } from "../api/queries";
import type { SourceMoveDone, SourceMovePreview } from "../api/types";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { INSTANCE_MATCH, moveBody, movePreview, moveDone, NEW_NAME, OLD_NAME, POSSIBLY_MATCH, URI_MATCH } from "../test/moveFixtures";
import { MoveSourceDialog } from "./MoveSourceDialog";

type Reply = { status?: number; body?: unknown };
interface Sent { url: string; body: unknown }

/** The server's two answers to POST /api/sources/2/move: `mockFetch` ignores the query string, so one route serves both and tells them apart by `dry_run`. */
function serve(dry: (n: number) => Reply, real: () => Reply = () => ({ body: moveDone() })) {
  const dryRuns: Sent[] = [];
  const realRuns: Sent[] = [];
  mockFetch({
    "POST /api/sources/2/move": ({ url, body }) => {
      if (url.includes("dry_run=1")) {
        dryRuns.push({ url, body });
        return dry(dryRuns.length);
      }
      realRuns.push({ url, body });
      return real();
    },
  });
  return { dryRuns, realRuns };
}

const show = (preview: SourceMovePreview): Reply => ({ body: preview });

/** The dialog needs the query client (it reads the lists again) and nothing else: no account, no router. */
function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const bare = (ui: ReactElement) => render(ui, { wrapper: Providers });

function renderDialog(props: Partial<ComponentProps<typeof MoveSourceDialog>> = {}) {
  const onClose = vi.fn();
  const onDone = vi.fn<(result: SourceMoveDone) => void>();
  const view = bare(<MoveSourceDialog oldId={2} oldName={OLD_NAME} newId={7} onClose={onClose} onDone={onDone} recheckMs={30} {...props} />);
  return { ...view, onClose, onDone };
}

const dialog = () => screen.getByRole("dialog", { name: `Move to new address: ${OLD_NAME}` });
const moveButton = () => within(dialog()).getByRole("button", { name: /^Move\b/ });
const cancelButton = () => within(dialog()).getByRole("button", { name: "Cancel" });
/** The message slot: the one live region of the dialog. */
const slot = () => dialog().querySelector<HTMLElement>("[aria-live]")!;
/** The preview has arrived (the from/to line is on the screen). */
const arrived = () => screen.findByText(/^From opc\.tcp:\/\//);

describe("MoveSourceDialog", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("the preview", () => {
    it("asks the dry run when it opens, with the new source and the address as found", async () => {
      const { dryRuns } = serve(() => show(movePreview()));
      renderDialog();
      await arrived();
      expect(dryRuns).toEqual([{ url: "/api/sources/2/move?dry_run=1", body: { to: 7, address: "as_found" } }]);
    });

    it("a server found by its application URI and certificate: where from and to, why, what else happens, and no tick", async () => {
      serve(() => show(movePreview({ match: URI_MATCH })));
      renderDialog();
      expect(await arrived()).toHaveTextContent("From opc.tcp://172.20.0.3:4840/dcdash/ to opc.tcp://172.20.0.5:4840/dcdash/");
      expect(screen.getByText("Both answer with the application URI urn:dcdash:simulator:dev.")).toBeInTheDocument();
      expect(screen.getByText("Its 12 mappings on 3 assets keep their points and readings.")).toBeInTheDocument();
      expect(screen.getByText("The new source found by the scan (40 points) is removed; its points were never mapped.")).toBeInTheDocument();
      expect(screen.getByText(`The name changes from "${OLD_NAME}" to "${NEW_NAME}".`)).toBeInTheDocument();
      expect(screen.getByText("Readings taken after the move stay after an Undo.")).toBeInTheDocument();
      expect(within(dialog()).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(moveButton()).toHaveTextContent("Move 12 mappings");
      expect(moveButton()).not.toHaveAttribute("aria-disabled");
      expect(screen.queryByText(/identified by its/)).not.toBeInTheDocument();
    });

    it("says when the name stays", async () => {
      serve(() => show(movePreview({ rename: null })));
      renderDialog();
      await arrived();
      expect(screen.getByText(`The name stays "${OLD_NAME}".`)).toBeInTheDocument();
    });

    it("a server known by its URI only: says so, asks for the tick, and keeps Move inactive until it is ticked", async () => {
      serve(() => show(movePreview({ match: URI_MATCH, needs_tick: true })));
      renderDialog();
      await arrived();
      expect(screen.getByText("It is identified by its application URI only.")).toBeInTheDocument();
      const box = within(dialog()).getByRole("checkbox", { name: "I checked that this is the same server" });
      expect(box).not.toBeChecked();
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(box);
      expect(moveButton()).not.toHaveAttribute("aria-disabled");
    });

    it("a simulator instance: says which instance both are", async () => {
      serve(() => show(movePreview({ match: INSTANCE_MATCH })));
      renderDialog();
      await arrived();
      expect(screen.getByText('Both are DCDash simulator instance "dev".')).toBeInTheDocument();
    });

    it("a possible match: the addresses, and the tick for the same device", async () => {
      serve(() => show(movePreview({ match: POSSIBLY_MATCH, needs_tick: true })));
      renderDialog();
      await arrived();
      expect(screen.getByText("All 12 mapped addresses and their names exist on the new server.")).toBeInTheDocument();
      expect(within(dialog()).getByRole("checkbox", { name: "I checked that this is the same device" })).toBeInTheDocument();
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
    });

    it("warns, in numbers, about mapped addresses the new server lacks", async () => {
      serve(() => show(movePreview({ match: { ...URI_MATCH, addresses: 9, missing_addresses: 3 } })));
      renderDialog();
      await arrived();
      expect(screen.getByText("3 of 12 mapped addresses were not found on the new server; their values will read as bad until they exist.")).toBeInTheDocument();
    });

    it("says so when the new address could not be browsed without credentials", async () => {
      serve(() => show(movePreview({ match: { ...URI_MATCH, addresses: 0, missing_addresses: null }, target: { id: 7, name: NEW_NAME, points: 0 } })));
      renderDialog();
      await arrived();
      expect(screen.getByText("The new address could not be browsed without credentials; this source's credentials will be used.")).toBeInTheDocument();
      expect(screen.getByText("The new source found by the scan is removed; it has no points.")).toBeInTheDocument();
    });

    it("an old source that uses a host name: says the move replaces that name", async () => {
      const from = { host: "simulator-old", port: 4840, endpoint: "opc.tcp://simulator-old:4840/dcdash/" };
      serve(() => show(movePreview({ from })));
      renderDialog();
      await arrived();
      expect(screen.getByText("This source uses the name simulator-old; the move replaces it with the address 172.20.0.5.")).toBeInTheDocument();
    });

    it("says nothing about a name for an old source at an address", async () => {
      serve(() => show(movePreview()));
      renderDialog();
      await arrived();
      expect(screen.queryByText(/This source uses the name/)).not.toBeInTheDocument();
    });

    it("keeps the singular for one mapping", async () => {
      serve(() => show(movePreview({ mappings: 1, assets: 1 })));
      renderDialog();
      await arrived();
      expect(moveButton()).toHaveTextContent("Move 1 mapping");
      expect(moveButton()).not.toHaveTextContent("mappings");
    });
  });

  describe("the address choice", () => {
    const named = (address: "as_found" | "name") => movePreview({
      name_hint: "simulator", address,
      ...(address === "name" ? { to: { host: "simulator", port: 4840, endpoint: "opc.tcp://simulator:4840/dcdash/" }, rename: null } : {}),
    });

    it("asks again with the name when the answer carries one, shows only that preview, and the name is the default", async () => {
      const { dryRuns } = serve((n) => show(n === 1 ? named("as_found") : named("name")));
      renderDialog();
      expect(await screen.findByText("From opc.tcp://172.20.0.3:4840/dcdash/ to opc.tcp://simulator:4840/dcdash/")).toBeInTheDocument();
      expect(dryRuns.map((d) => d.body)).toEqual([{ to: 7, address: "as_found" }, { to: 7, address: "name" }]);
      const name = within(dialog()).getByRole("radio", { name: "Use the name simulator (a name keeps working if the device gets a new address)" });
      const found = within(dialog()).getByRole("radio", { name: "Use the address 172.20.0.5" });
      expect(name).toBeChecked();
      expect(found).not.toBeChecked();
      expect(within(dialog()).getByRole("radiogroup", { name: "Address to use" })).toBeInTheDocument();
    });

    it("never draws the preview of the address first when the name is the default", async () => {
      serve((n) => show(n === 1 ? named("as_found") : named("name")));
      renderDialog();
      const seen: string[] = [];
      const watch = new MutationObserver(() => {
        if ((document.body.textContent ?? "").includes("to opc.tcp://172.20.0.5:4840/dcdash/")) seen.push("address");
      });
      watch.observe(document.body, { childList: true, subtree: true, characterData: true });
      await screen.findByText(/to opc\.tcp:\/\/simulator:4840/);
      watch.disconnect();
      expect(seen).toEqual([]);
    });

    it("runs the dry run again for the address when it is chosen, and the real run follows the preview on screen", async () => {
      const { dryRuns, realRuns } = serve((n) => show(n === 2 ? named("name") : named("as_found")));
      renderDialog();
      await screen.findByText(/to opc\.tcp:\/\/simulator:4840/);
      await userEvent.click(within(dialog()).getByRole("radio", { name: "Use the address 172.20.0.5" }));
      expect(await screen.findByText("From opc.tcp://172.20.0.3:4840/dcdash/ to opc.tcp://172.20.0.5:4840/dcdash/")).toBeInTheDocument();
      expect(dryRuns[2].body).toEqual({ to: 7, address: "as_found" });
      expect(within(dialog()).getByRole("radio", { name: "Use the address 172.20.0.5" })).toBeChecked();
      await userEvent.click(moveButton());
      await waitFor(() => expect(realRuns).toHaveLength(1));
      expect(realRuns[0].body).toEqual(moveBody());
    });

    it("the real run for the name sends the name and the host:port the preview showed", async () => {
      const { realRuns } = serve((n) => show(n === 1 ? named("as_found") : named("name")));
      renderDialog();
      await screen.findByText(/to opc\.tcp:\/\/simulator:4840/);
      await userEvent.click(moveButton());
      await waitFor(() => expect(realRuns).toHaveLength(1));
      expect(realRuns[0].body).toEqual(moveBody({ address: "name", expect: { address_after: "simulator:4840", name_after: null } }));
    });

    it("keeps Move inactive while the new preview is on its way, with the old one still on screen", async () => {
      const { realRuns } = serve((n) => show(n === 1 ? named("as_found") : named("name")));
      renderDialog();
      await screen.findByText(/to opc\.tcp:\/\/simulator:4840/);
      const gate = holdFetch((method, path) => method === "POST" && path === "/api/sources/2/move");
      await userEvent.click(within(dialog()).getByRole("radio", { name: "Use the address 172.20.0.5" }));
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
      expect(slot()).toHaveTextContent("Checking what the move would do...");
      expect(screen.getByText(/to opc\.tcp:\/\/simulator:4840/)).toBeInTheDocument();
      await userEvent.click(moveButton());
      expect(realRuns).toEqual([]);
      await act(async () => { gate.release(); });
    });

    it("falls back to the address when the name cannot be used after all", async () => {
      const { dryRuns } = serve((n) => (n === 2 ? { status: 422, body: { detail: "no name is known for that address" } } : show(n === 1 ? named("as_found") : movePreview())));
      renderDialog();
      expect(await screen.findByText("From opc.tcp://172.20.0.3:4840/dcdash/ to opc.tcp://172.20.0.5:4840/dcdash/")).toBeInTheDocument();
      expect(dryRuns.map((d) => d.body)).toEqual([{ to: 7, address: "as_found" }, { to: 7, address: "name" }, { to: 7, address: "as_found" }]);
      expect(slot()).toBeEmptyDOMElement();
    });
  });

  describe("a scan is running", () => {
    it("says so, keeps Move inactive with a click guard, and asks again until the scan has finished", async () => {
      const { realRuns, dryRuns } = serve((n) => show(movePreview({ scan_running: n < 3 })));
      renderDialog({ recheckMs: 150 });
      await arrived();
      expect(slot()).toHaveTextContent("A scan is running; you can move when it has finished.");
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
      expect(moveButton()).not.toBeDisabled();
      await userEvent.click(moveButton());
      expect(realRuns).toEqual([]);
      await waitFor(() => expect(moveButton()).not.toHaveAttribute("aria-disabled"));
      expect(slot()).toBeEmptyDOMElement();
      expect(dryRuns).toHaveLength(3);
    });

    it("does not ask again once no scan is running", async () => {
      const { dryRuns } = serve(() => show(movePreview()));
      renderDialog({ recheckMs: 20 });
      await arrived();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      expect(dryRuns).toHaveLength(1);
    });
  });

  describe("the real run", () => {
    it("is refused by the click guard until the box is ticked, then sends the numbers the preview showed", async () => {
      const { realRuns } = serve(() => show(movePreview({ match: POSSIBLY_MATCH, needs_tick: true })));
      const { onDone } = renderDialog();
      await arrived();
      await userEvent.click(moveButton());
      expect(realRuns).toEqual([]);
      expect(slot()).toHaveTextContent("Tick the box to confirm before you move.");
      await userEvent.click(within(dialog()).getByRole("checkbox", { name: "I checked that this is the same device" }));
      expect(slot()).toBeEmptyDOMElement();
      await userEvent.click(moveButton());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(realRuns).toEqual([{
        url: "/api/sources/2/move?dry_run=0",
        body: moveBody({ expect: { match_kind: "possibly", needs_tick: true }, ticked: true }),
      }]);
      // the preview that was moved on goes with the answer: the real run does not carry the number of mappings, and the toast says it
      expect(onDone).toHaveBeenCalledWith(moveDone(), expect.objectContaining({ mappings: 12, mapped_points: 12 }));
    });

    it("sends name_after null when the name stays", async () => {
      const { realRuns } = serve(() => show(movePreview({ rename: null })));
      renderDialog();
      await arrived();
      await userEvent.click(moveButton());
      await waitFor(() => expect(realRuns).toHaveLength(1));
      expect((realRuns[0].body as { expect: { name_after: unknown } }).expect.name_after).toBeNull();
    });

    it("shows that it is moving, ignores a second press, and can neither be cancelled nor escaped meanwhile", async () => {
      const { realRuns } = serve(() => show(movePreview()));
      const { onClose, onDone } = renderDialog();
      await arrived();
      const gate = holdFetch((method, path) => method === "POST" && path === "/api/sources/2/move");
      await userEvent.click(moveButton());
      expect(slot()).toHaveTextContent("Moving the source...");
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
      expect(cancelButton()).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(moveButton());
      await userEvent.click(cancelButton());
      await userEvent.keyboard("{Escape}");
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => { gate.release(); });
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(realRuns).toHaveLength(1);
    });

    it("reads the lists again after a move that worked, before it tells the parent", async () => {
      const order: string[] = [];
      serve(() => show(movePreview()));
      const probe = mockProbes((name) => order.push(`fetch ${name}`));
      const onDone = vi.fn(() => { order.push("done"); });
      render(<MoveSourceDialog oldId={2} oldName={OLD_NAME} newId={7} onClose={() => {}} onDone={onDone} />, { wrapper: probe.Wrapper });
      await arrived();
      await settleProbes(probe, 1);
      order.length = 0;
      await userEvent.click(moveButton());
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(probe.fetches()).toEqual({ sources: 2, points: 2, graph: 2, scans: 2, audit: 2, events: 2, assets: 1 });
      expect(order.at(-1)).toBe("done");
    });

    it("reads the lists again after a refusal too", async () => {
      serve(() => show(movePreview()), () => ({ status: 409, body: { detail: "a scan has just started" } }));
      const probe = mockProbes(() => {});
      render(<MoveSourceDialog oldId={2} oldName={OLD_NAME} newId={7} onClose={() => {}} onDone={() => {}} recheckMs={60_000} />, { wrapper: probe.Wrapper });
      await arrived();
      await settleProbes(probe, 1);
      await userEvent.click(moveButton());
      await waitFor(() => expect(probe.fetches()).toEqual({ sources: 2, points: 2, graph: 2, scans: 2, audit: 2, events: 2, assets: 1 }));
    });
  });

  describe("refusals", () => {
    it("shows a refusal in the message slot, keeps the dialog open and Move usable", async () => {
      serve(() => show(movePreview()), () => ({ status: 422, body: { detail: "this kind of source cannot be moved" } }));
      const { onClose, onDone } = renderDialog();
      await arrived();
      await userEvent.click(moveButton());
      await waitFor(() => expect(slot()).toHaveTextContent("This kind of source cannot be moved."));
      expect(slot()).toHaveAttribute("data-tone", "error");
      expect(dialog()).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
      expect(moveButton()).not.toHaveAttribute("aria-disabled");
    });

    it("shows a 404 in words", async () => {
      serve(() => show(movePreview()), () => ({ status: 404, body: { detail: "that source is gone" } }));
      renderDialog();
      await arrived();
      await userEvent.click(moveButton());
      await waitFor(() => expect(slot()).toHaveTextContent("That source is gone."));
    });

    it("a refused dry run shows its sentence and leaves nothing to press but Cancel", async () => {
      const { realRuns } = serve(() => ({ status: 409, body: { detail: "the new source got a mapping, so it cannot be removed" } }));
      renderDialog();
      await waitFor(() => expect(slot()).toHaveTextContent("The new source got a mapping, so it cannot be removed."));
      expect(slot()).toHaveAttribute("data-tone", "error");
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
      expect(moveButton()).toHaveTextContent(/^Move$/);
      await userEvent.click(moveButton());
      expect(realRuns).toEqual([]);
    });

    it("a 'changed since the preview' refusal asks the dry run again, shows the new numbers and takes the tick away", async () => {
      let mappings = 12;
      const { dryRuns, realRuns } = serve(
        () => show(movePreview({ match: POSSIBLY_MATCH, needs_tick: true, mappings })),
        () => { mappings = 11; return { status: 409, body: { detail: "changed since the preview: it was 12 mappings, now 11" } }; },
      );
      renderDialog();
      await arrived();
      await userEvent.click(within(dialog()).getByRole("checkbox", { name: "I checked that this is the same device" }));
      await userEvent.click(moveButton());
      await waitFor(() => expect(moveButton()).toHaveTextContent("Move 11 mappings"));
      expect(dryRuns).toHaveLength(2);
      expect(slot()).toHaveTextContent("Changed since the preview: it was 12 mappings, now 11. The preview is updated: check it and press Move again.");
      expect(within(dialog()).getByRole("checkbox", { name: "I checked that this is the same device" })).not.toBeChecked();
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(within(dialog()).getByRole("checkbox", { name: "I checked that this is the same device" }));
      await userEvent.click(moveButton());
      await waitFor(() => expect(realRuns).toHaveLength(2));
      expect((realRuns[1].body as { expect: { mappings: number } }).expect.mappings).toBe(11);
    });

    it("another 409 (a scan started) shows its sentence and asks the dry run again, which then says the scan is running", async () => {
      let running = false;
      const { dryRuns } = serve(
        () => show(movePreview({ scan_running: running })),
        () => { running = true; return { status: 409, body: { detail: "a scan is queued or running; try again when it has finished" } }; },
      );
      renderDialog({ recheckMs: 60_000 });
      await arrived();
      await userEvent.click(moveButton());
      await waitFor(() => expect(dryRuns).toHaveLength(2));
      await waitFor(() => expect(slot()).toHaveTextContent("A scan is queued or running; try again when it has finished."));
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
    });

    it("a refusal that the match needs confirming shows its sentence, asks the dry run again, and offers the box that was not there", async () => {
      let needsTick = false;
      const { dryRuns, realRuns } = serve(
        () => show(needsTick ? movePreview({ match: POSSIBLY_MATCH, needs_tick: true }) : movePreview()),
        () => {
          needsTick = true;
          return { status: 409, body: { detail: "The match needs your confirmation: tick that you checked it is the same device" } };
        },
      );
      renderDialog();
      await arrived();
      await userEvent.click(moveButton());
      await waitFor(() => expect(dryRuns).toHaveLength(2));
      const box = await within(dialog()).findByRole("checkbox", { name: "I checked that this is the same device" });
      expect(box).not.toBeChecked();
      expect(slot()).toHaveTextContent("The match needs your confirmation: tick that you checked it is the same device.");
      expect(moveButton()).toHaveAttribute("aria-disabled", "true");
      expect(realRuns).toHaveLength(1);
      expect((realRuns[0].body as { ticked: boolean }).ticked).toBe(false);
      await userEvent.click(box);
      await userEvent.click(moveButton());
      await waitFor(() => expect(realRuns).toHaveLength(2));
      expect(realRuns[1].body).toEqual(moveBody({ expect: { match_kind: "possibly", needs_tick: true }, ticked: true }));
    });

    it("says in words that the server cannot be reached", async () => {
      serve(() => show(movePreview()));
      renderDialog();
      await arrived();
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      await userEvent.click(moveButton());
      await waitFor(() => expect(slot()).toHaveTextContent("Can't reach the server. Check the network and try again."));
    });
  });

  describe("the frame", () => {
    it("puts the focus on Cancel and draws one live region", async () => {
      serve(() => show(movePreview()));
      renderDialog();
      expect(cancelButton()).toHaveFocus();
      await arrived();
      expect(cancelButton()).toHaveFocus();
      expect(dialog().querySelectorAll("[aria-live]")).toHaveLength(1);
      expect(dialog().querySelectorAll("[role=status], [role=alert]")).toHaveLength(0);
    });

    it("makes every button type=button, and none natively disabled", async () => {
      serve(() => show(movePreview({ match: POSSIBLY_MATCH, needs_tick: true })));
      renderDialog();
      await arrived();
      const buttons = within(dialog()).getAllByRole("button");
      expect(buttons).toHaveLength(2);
      for (const button of buttons) {
        expect(button).toHaveAttribute("type", "button");
        expect(button).not.toBeDisabled();
      }
    });

    it("is closed by Cancel and by Escape", async () => {
      serve(() => show(movePreview()));
      const { onClose } = renderDialog();
      await arrived();
      await userEvent.click(cancelButton());
      expect(onClose).toHaveBeenCalledTimes(1);
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("Escape closes only this dialog when it sits over another one", async () => {
      serve(() => show(movePreview()));
      const outerClose = vi.fn();
      const innerClose = vi.fn();
      function Outer() {
        const [inner, setInner] = useState(false);
        const ref = useRef<HTMLDivElement>(null);
        useDialogFocus(ref, outerClose);
        return (
          <div ref={ref} role="dialog" aria-label="Outer" aria-modal="true">
            <button type="button" onClick={() => setInner(true)}>Open inner</button>
            {inner && <MoveSourceDialog oldId={2} oldName={OLD_NAME} newId={7} onClose={innerClose} onDone={() => {}} />}
          </div>
        );
      }
      bare(<Outer />);
      await userEvent.click(screen.getByRole("button", { name: "Open inner" }));
      await arrived();
      await userEvent.keyboard("{Escape}");
      expect(innerClose).toHaveBeenCalledTimes(1);
      expect(outerClose).not.toHaveBeenCalled();
    });

    it("wraps Tab from the last control to the first, and Shift+Tab from the first to the last", async () => {
      serve(() => show(movePreview()));
      renderDialog();
      await arrived();
      moveButton().focus();
      await userEvent.tab();
      expect(cancelButton()).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(moveButton()).toHaveFocus();
    });

    it("pulls the focus back in when it lands outside", async () => {
      serve(() => show(movePreview()));
      renderDialog();
      await arrived();
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      expect(cancelButton()).toHaveFocus();
    });

    it("gives the focus back to what opened it when it goes away", async () => {
      serve(() => show(movePreview()));
      function Page() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>Open it</button>
            {open && <MoveSourceDialog oldId={2} oldName={OLD_NAME} newId={7} onClose={() => setOpen(false)} onDone={() => setOpen(false)} />}
          </>
        );
      }
      bare(<Page />);
      const opener = screen.getByRole("button", { name: "Open it" });
      await userEvent.click(opener);
      await arrived();
      expect(opener).not.toHaveFocus();
      await userEvent.click(cancelButton());
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
    });

    it("gives it back even though the page behind was inert while the dialog went away (a browser refuses the focus of an inert element)", async () => {
      serve(() => show(movePreview()));
      const realFocus = HTMLElement.prototype.focus;
      vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        if (this.closest("[inert]")) return; // what a browser does
        realFocus.call(this, options);
      });
      function Page() {
        const [open, setOpen] = useState(false);
        return (
          <div className="shell">
            <button type="button" onClick={() => setOpen(true)}>Open it</button>
            {open && <MoveSourceDialog oldId={2} oldName={OLD_NAME} newId={7} onClose={() => setOpen(false)} onDone={() => setOpen(false)} />}
          </div>
        );
      }
      bare(<Page />);
      const opener = screen.getByRole("button", { name: "Open it" });
      await userEvent.click(opener);
      await arrived();
      expect(document.querySelector(".shell")).toHaveAttribute("inert");
      await userEvent.click(cancelButton());
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(document.querySelector(".shell")).not.toHaveAttribute("inert");
      expect(opener).toHaveFocus();
    });

    it("sends the focus to returnFocusTo when the parent gives one", async () => {
      serve(() => show(movePreview()));
      function Page() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>Open it</button>
            <button type="button">Elsewhere</button>
            {open && (
              <MoveSourceDialog
                oldId={2} oldName={OLD_NAME} newId={7} onClose={() => setOpen(false)} onDone={() => setOpen(false)}
                returnFocusTo={() => screen.getByRole("button", { name: "Elsewhere" })}
              />
            )}
          </>
        );
      }
      bare(<Page />);
      await userEvent.click(screen.getByRole("button", { name: "Open it" }));
      await arrived();
      await userEvent.click(cancelButton());
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    });

    it("makes the page behind inert while open, and gives it back after", async () => {
      serve(() => show(movePreview()));
      document.body.innerHTML = '<div class="shell" id="shell"><button type="button">page</button></div><a class="skip-link" href="#main">skip</a><div class="shell" id="locked" inert></div>';
      const { unmount } = renderDialog();
      await arrived();
      expect(document.getElementById("shell")).toHaveAttribute("inert");
      expect(document.querySelector(".skip-link")).toHaveAttribute("inert");
      unmount();
      expect(document.getElementById("shell")).not.toHaveAttribute("inert");
      expect(document.querySelector(".skip-link")).not.toHaveAttribute("inert");
      expect(document.getElementById("locked")).toHaveAttribute("inert"); // inert for another reason: left as it was
    });

    it("renders nothing while open is false, and asks nothing until it opens", async () => {
      const { dryRuns } = serve(() => show(movePreview()));
      const { rerender, onClose, onDone } = renderDialog({ open: false });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(dryRuns).toHaveLength(0);
      rerender(<MoveSourceDialog open oldId={2} oldName={OLD_NAME} newId={7} onClose={onClose} onDone={onDone} />);
      await arrived();
      expect(dryRuns).toHaveLength(1);
    });

    it("lets an answer that arrives after the dialog has gone fall on the floor", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      serve(() => show(movePreview()));
      const gate = holdFetch((method, path) => method === "POST" && path === "/api/sources/2/move");
      const { unmount, onDone } = renderDialog();
      unmount();
      await act(async () => { gate.release(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(errors).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    });

    it("logs no console error in a whole move", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      serve(() => show(movePreview({ match: POSSIBLY_MATCH, needs_tick: true })));
      const { onDone } = renderDialog();
      await arrived();
      await userEvent.click(within(dialog()).getByRole("checkbox", { name: "I checked that this is the same device" }));
      await userEvent.click(moveButton());
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The query keys a move must read again: one probe query per key, each fetched again only when something invalidates its key.

const PROBE_NAMES = ["sources", "points", "graph", "scans", "audit", "events", "assets"] as const;

function Probes() {
  useQuery({ queryKey: keys.sources, queryFn: () => api.get("/api/probe/sources"), staleTime: Infinity });
  useQuery({ queryKey: keys.points(2), queryFn: () => api.get("/api/probe/points"), staleTime: Infinity });
  useQuery({ queryKey: keys.graph, queryFn: () => api.get("/api/probe/graph"), staleTime: Infinity });
  useQuery({ queryKey: keys.scans, queryFn: () => api.get("/api/probe/scans"), staleTime: Infinity });
  useQuery({ queryKey: keys.auditAll, queryFn: () => api.get("/api/probe/audit"), staleTime: Infinity });
  useQuery({ queryKey: keys.eventsAll, queryFn: () => api.get("/api/probe/events"), staleTime: Infinity });
  useQuery({ queryKey: keys.assets, queryFn: () => api.get("/api/probe/assets"), staleTime: Infinity });
  return null;
}

/** Puts a counting layer in front of the fetch that `serve` installed, and a wrapper that mounts the probes next to the dialog. `seen` hears every probe fetch. */
function mockProbes(seen: (name: string) => void) {
  const counts: Record<string, number> = Object.fromEntries(PROBE_NAMES.map((name) => [name, 0]));
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/api/probe/")) {
      const name = url.replace("/api/probe/", "");
      counts[name] += 1;
      seen(name);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }));
  return {
    fetches: () => ({ ...counts }),
    Wrapper: ({ children }: { children: ReactNode }) => <Providers><Probes />{children}</Providers>,
  };
}

/** Waits until every probe has been fetched `times` time(s). */
async function settleProbes(probe: { fetches: () => Record<string, number> }, times: number) {
  await waitFor(() => expect(Object.values(probe.fetches()).every((n) => n === times)).toBe(true));
}
