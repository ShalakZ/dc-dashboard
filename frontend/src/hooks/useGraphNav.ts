import type { Node } from "@xyflow/react";
import { useCallback, useMemo, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { navFirst, navIndex, navTarget, type NavMove } from "../lib/graphNav";

const moveOf = (key: string): NavMove | null => {
  switch (key) {
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    default: return null;
  }
};

/** Whether Enter opens or closes this node: a source, a group, or an asset that has sub-assets. A point, an unidentified service and the "show more" node do not. */
function canToggle(node: Node): boolean {
  if (node.type === "source" || node.type === "cluster") return true;
  const children = (node.data as { children?: unknown } | undefined)?.children;
  return node.type === "asset" && typeof children === "number" && children > 0;
}

/**
 * W12b: the arrow keys of the Discovery canvas, as ONE onKeyDownCapture for its wrapper. Arrows walk the drawn tree (`navTarget`), Enter opens or
 * closes the focused source, group or asset (`onToggle`). The "show more" node is not handled here: its button is a native button, and `onMore`
 * is the page's click handler for it, so it is accepted for the wiring and never called by a key.
 *
 * It runs in the CAPTURE phase and stops the key it handled, so React Flow's own handler on the node never sees it (it would select the node on
 * Enter and nudge it on an arrow). It acts only when the target is the canvas wrapper itself or a `.react-flow__node` wrapper: a button inside a node, the
 * Find card and the menus keep their own keys (React also delivers the keys of a portal, so the menu is named too), and nothing happens behind a modal
 * dialog or with Ctrl/Cmd/Alt/Shift held. A SELECTED node keeps its plain arrows for React Flow, which nudges it 5 px: nothing the person could do
 * before is lost. An arrow with nowhere to go is swallowed all the same, so the page does not scroll under a key that was ours.
 *
 * Two more keys are ours. Escape on a SELECTED node clears the selection and leaves the focus on the node: React Flow would clear it too, but it blurs the
 * node as it does, which sends the focus to the page body (`clearSelection` is the page's, the one Escape on the empty canvas uses). And the arrows work on the
 * BUTTON of a "show more" node, which is that node's one focus stop (its wrapper is not focusable): Enter and Space there are the native button's.
 *
 * `goToNode(id)` is the page's: it pans to the node and focuses it.
 */
export function useGraphNav({ canvas, nodes, onToggle, goToNode, clearSelection }: {
  canvas: RefObject<HTMLElement | null>;
  nodes: readonly Node[];
  onToggle: (id: string) => void;
  onMore?: (clusterId: string) => void;
  goToNode: (id: string) => void;
  clearSelection: () => void;
}): { onKeyDownCapture: (event: ReactKeyboardEvent) => void } {
  const index = useMemo(() => navIndex(nodes), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node] as const)), [nodes]);

  const onKeyDownCapture = useCallback((event: ReactKeyboardEvent) => {
    const target = event.target;
    const root = canvas.current;
    if (!(target instanceof Element) || !root?.contains(target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const key = event.key ?? ""; // autofill sends keydown events without a key
    const move = moveOf(key);
    if (move === null && key !== "Enter" && key !== "Escape") return;
    if (target.closest(".graph-find, .graph-menu")) return;
    if (document.querySelector('[aria-modal="true"]')) return;

    const swallow = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (target === root) {
      if (move !== "down" && move !== "right") return;
      const first = navFirst(index);
      if (first === null) return;
      swallow();
      goToNode(first);
      return;
    }
    if (move !== null && target.matches("button")) {
      // The button of a "show more" node: the arrows walk on from it like from any node.
      const moreId = target.closest<HTMLElement>(".react-flow__node")?.dataset.id;
      if (moreId?.startsWith("more:") && byId.has(moreId)) {
        const to = navTarget(index, moreId, move);
        swallow();
        if (to !== null) goToNode(to);
        return;
      }
    }
    if (!target.matches(".react-flow__node")) return;
    const id = target.getAttribute("data-id");
    const node = id === null ? undefined : byId.get(id);
    if (id === null || !node) return;

    if (key === "Escape") {
      if (!target.classList.contains("selected")) return;
      swallow(); // React Flow never sees it, so it never blurs the node
      clearSelection();
    } else if (move !== null) {
      if (target.classList.contains("selected")) return;
      const to = navTarget(index, id, move);
      swallow();
      if (to !== null) goToNode(to);
    } else if (canToggle(node)) {
      swallow();
      onToggle(id);
    }
  }, [canvas, index, byId, onToggle, goToNode, clearSelection]);
  return { onKeyDownCapture };
}
