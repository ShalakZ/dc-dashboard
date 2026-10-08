from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.models import Asset


@dataclass(frozen=True)
class AssetNode:
    id: int
    parent_id: int | None
    name: str
    sort_order: int


def _order(node: AssetNode) -> tuple[int, str, int]:
    return (node.sort_order, node.name, node.id)


class AssetTree:
    """The asset hierarchy, loaded once per request so that every lookup afterwards is in memory."""

    def __init__(self, nodes: Iterable[AssetNode] | dict[int, AssetNode]) -> None:
        items = nodes.values() if isinstance(nodes, dict) else nodes
        self.nodes: dict[int, AssetNode] = {node.id: node for node in items}
        by_parent: dict[int, list[AssetNode]] = {}
        for node in self.nodes.values():
            if node.parent_id in self.nodes:
                by_parent.setdefault(node.parent_id, []).append(node)
        self._children = {
            parent: [node.id for node in sorted(kids, key=_order)] for parent, kids in by_parent.items()
        }
        # A node whose parent is missing is treated as a root rather than dropped.
        self._roots = [
            node.id for node in sorted(self.nodes.values(), key=_order) if node.parent_id not in self.nodes
        ]

    @classmethod
    async def load(cls, db: AsyncSession) -> "AssetTree":
        assets = await db.scalars(select(Asset))
        return cls(AssetNode(a.id, a.parent_id, a.name, a.sort_order) for a in assets)

    def children(self, asset_id: int) -> list[int]:
        """Direct children ordered by sort_order, name, id; empty for a leaf or an unknown id."""
        return list(self._children.get(asset_id, ()))

    def ancestors_or_self(self, asset_id: int) -> list[int]:
        """The asset first, then its parent, grandparent and so on up to the root. KeyError if unknown."""
        node = self.nodes[asset_id]
        chain = [node.id]
        while node.parent_id in self.nodes and node.parent_id not in chain:  # `not in chain` stops a cycle
            node = self.nodes[node.parent_id]
            chain.append(node.id)
        return chain

    def path(self, asset_id: int) -> str:
        """Names from the root down, e.g. "Site / MV2 / LV Panel 1". KeyError if unknown."""
        return " / ".join(self.nodes[i].name for i in reversed(self.ancestors_or_self(asset_id)))

    def preorder(self) -> list[int]:
        """Every asset once, parents before their children, siblings in children() order."""
        order: list[int] = []
        seen: set[int] = set()
        stack = list(reversed(self._roots))
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            order.append(current)
            stack.extend(reversed(self._children.get(current, ())))
        # Only a parent cycle (the API refuses to create one) leaves anything unvisited; keep it addressable.
        order.extend(i for i in sorted(self.nodes) if i not in seen)
        return order
