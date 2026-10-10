from collections.abc import Collection

from dcdash.core.tree import AssetTree


def power_sources(tree: AssetTree, metered: Collection[int], asset_id: int) -> list[int]:
    """The assets whose own `active_power_kw` meter makes up `asset_id`'s live power, depth first in tree order.

    An asset with a meter of its own has none (its own reading is shown). A metered child is a source and is not
    looked into again; an unmetered child is walked into. `[]` when no descendant is metered.
    """
    if asset_id in metered:
        return []
    found: list[int] = []
    seen = {asset_id}  # also stops a parent cycle
    stack = list(reversed(tree.children(asset_id)))
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        if current in metered:
            found.append(current)
        else:
            stack.extend(reversed(tree.children(current)))
    return found
