"""Moving assets within the hierarchy: the whole decision, with no database, no clock and no HTTP (W7p).

`plan` takes the tree as it is, a list of groups (`ids` go under `parent_id`, before the child `before_id` or last) and the
normalised name keys, and answers either with refusals or with everything the route has to do: the rows to write, the roots
that moved, what to say to the person, the groups that put it all back. The route (api/asset_move.py) only fetches the inputs,
takes the locks and writes the answer, so the rules live in one place and a later per-kind rule (RULES) needs no route change.

Groups are applied in order to an in-memory copy of the tree and a later group sees the earlier ones. Every check runs before
anything is written: one refusal means nothing moves.

Sibling order is `(sort_order, name, id)` (core/tree.py). Most siblings have sort_order 0 and sort by name, so "before X" cannot
be expressed by changing one number: the target's children are renumbered 0..n-1 in the new order (only the rows whose number
really changes are written). The old parent's remaining children keep their numbers.
"""
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date

from dcdash.core.cost import TariffRow, rate_at
from dcdash.core.tree import AssetTree

MAX_GROUPS = 500
MAX_IDS = 500  # an undo of 500 separate roots needs 500 groups, so the two caps are equal

STALE = "stale"  # an asset, the target or the sibling to go before is gone: the route answers 409, everything else here 422
CYCLE = "cycle"
BAD_BEFORE = "bad_before"
NAME_CLASH = "name_clash"
INVALID = "invalid"


@dataclass(frozen=True)
class Refusal:
    asset_id: int | None
    code: str
    reason: str  # a full sentence in names, never ids


@dataclass(frozen=True)
class Group:
    ids: tuple[int, ...]
    parent_id: int | None = None  # None = the top level
    before_id: int | None = None  # None = last


@dataclass(frozen=True)
class MoveContext:
    """What a rule is shown for one group, after the built-in checks passed."""

    tree: AssetTree  # as it is when this group is applied: earlier groups of the request are in it
    roots: tuple[int, ...]  # the ids that travel (an id under another listed id is not one), in tree order
    parent_id: int | None
    before_id: int | None  # resolved: the first sibling at or after the position that does not itself move; None = last
    final: tuple[int, ...]  # the target's children after the move
    keys: Mapping[int, str]
    undo: bool


# Per-kind rules (a later wave) append here: a callable gets a MoveContext and yields Refusals. It runs after the built-in
# checks, only for a group that really moves something, and never when a built-in check already refused.
RULES: list[Callable[[MoveContext], Iterable[Refusal]]] = []


@dataclass(frozen=True)
class Write:
    id: int
    parent_id: int | None
    sort_order: int


@dataclass(frozen=True)
class MovedRoot:
    id: int
    name: str
    from_parent_id: int | None
    to_parent_id: int | None
    from_sort_order: int
    to_sort_order: int
    change: str  # "parent" (a new place) or "order" (the same parent, another position)
    subtree_assets: int  # the root and everything below it


@dataclass(frozen=True)
class Plan:
    refusals: list[Refusal]  # empty = allowed
    writes: list[Write]  # every row whose parent or number really changes, by id
    roots: list[MovedRoot]  # the roots that move, in tree order (groups in request order)
    unchanged: list[int]  # roots already exactly where they were asked to go: skipped
    undo: list[Group]  # the groups that put it back, to be sent as one request
    assets: int  # how many assets move in all (roots and what is below them, each counted once)
    parents: dict[int, int | None]  # each root's parent before the move: the moved roots and the ones already in place (`unchanged`)
    lock_ids: list[int]  # every row the route must lock before it writes, by id
    tree: AssetTree  # the tree as it will be (the input tree when refused)


def shape_problem(groups: Sequence[Group]) -> str | None:
    """Why a request is malformed (too many groups or ids, an empty group, an id named twice), else None."""
    if not groups:
        return "Name at least one asset to move."
    if len(groups) > MAX_GROUPS:
        return f"At most {MAX_GROUPS} moves can be sent at once."
    seen: set[int] = set()
    for group in groups:
        if not group.ids:
            return "Each move must name at least one asset."
        for asset_id in group.ids:
            if asset_id in seen:
                return "An asset can be named only once in a request."
            seen.add(asset_id)
    if len(seen) > MAX_IDS:
        return f"At most {MAX_IDS} assets can be moved at once."
    return None


def to_roots(tree: AssetTree, ids: Iterable[int]) -> list[int]:
    """`ids` reduced to the ones with no other listed id above them (the rest travel inside those), in the tree's pre-order.

    That is the order the person sees the rows in BEFORE the move, whatever order the ids were sent in. Every id must be in the tree."""
    wanted = set(ids)
    position = {asset_id: n for n, asset_id in enumerate(tree.preorder())}
    return sorted(
        (i for i in wanted if wanted.isdisjoint(tree.ancestors_or_self(i)[1:])), key=position.__getitem__
    )


def subtree_ids(tree: AssetTree, root: int) -> list[int]:
    """The asset and everything below it, parents before their children."""
    found, stack = [], [root]
    while stack:
        current = stack.pop()
        found.append(current)
        stack.extend(reversed(tree.children(current)))
    return found


def _q(tree: AssetTree, asset_id: int) -> str:
    return f'"{tree.nodes[asset_id].name}"'


def _into(tree: AssetTree, parent_id: int | None) -> str:
    return "to the top level" if parent_id is None else f"into {_q(tree, parent_id)}"


def _siblings(tree: AssetTree, parent_id: int | None) -> list[int]:
    return tree.roots() if parent_id is None else tree.children(parent_id)


@dataclass(frozen=True)
class _Step:
    refusals: tuple[Refusal, ...] = ()
    roots: tuple[int, ...] = ()
    before: int | None = None
    final: tuple[int, ...] = ()
    unchanged: bool = False


def _clashes(tree: AssetTree, roots: Sequence[int], parent_id: int | None, rest: Sequence[int], keys: Mapping[int, str]) -> list[Refusal]:
    """Name clashes at the target, by the same key the database uses (asset_names._KEY): a root that CHANGES parent must not share
    a key with a child that stays or a root already there, nor with another root that changes parent. A root that does not change
    parent is not checked itself (old twins stay reorderable)."""
    arriving = [r for r in roots if tree.nodes[r].parent_id != parent_id]
    staying = list(rest) + [r for r in roots if tree.nodes[r].parent_id == parent_id]
    found: list[Refusal] = []
    paired: set[frozenset[int]] = set()
    for root in arriving:
        key = keys[root]
        sibling = next((s for s in staying if keys[s] == key), None)
        if sibling is not None:
            found.append(Refusal(
                root, NAME_CLASH,
                f"Cannot move {_q(tree, root)} {_into(tree, parent_id)}: an asset named {_q(tree, sibling)} is already there.",
            ))
            continue
        partner = next((o for o in arriving if o != root and keys[o] == key), None)
        if partner is not None and frozenset((root, partner)) not in paired:
            paired.add(frozenset((root, partner)))
            found.append(Refusal(
                root, NAME_CLASH,
                f"Cannot move {_q(tree, root)} and {_q(tree, partner)} together {_into(tree, parent_id)}: "
                "they would have the same name there.",
            ))
    return found


def _examine(
    tree: AssetTree, group: Group, keys: Mapping[int, str], rules: Sequence[Callable[[MoveContext], Iterable[Refusal]]] | None,
    undo: bool,
) -> _Step:
    """Everything the built-in checks and the rules say about ONE group against the tree as it is now."""
    stale = [Refusal(i, STALE, "An asset you are moving no longer exists.") for i in group.ids if i not in tree.nodes]
    if group.parent_id is not None and group.parent_id not in tree.nodes:
        stale.append(Refusal(group.parent_id, STALE, "The place you are moving to no longer exists."))
    if group.before_id is not None and group.before_id not in tree.nodes and not undo:
        # A sibling deleted between the person looking and dropping is the same race as an asset deleted: the screen is out of date,
        # so it is told to look again, not that its request was wrong. (An undo never refuses on it: it falls back to last, below.)
        stale.append(Refusal(group.before_id, STALE, "The asset you wanted to place these before no longer exists. The tree changed; try again."))
    if stale:
        return _Step(refusals=tuple(stale))

    parent = group.parent_id
    roots = to_roots(tree, group.ids)

    cycles = []
    if parent is not None:
        above = set(tree.ancestors_or_self(parent))  # the target and everything it sits in
        for root in roots:
            if root == parent:
                cycles.append(Refusal(root, CYCLE, f"Cannot move {_q(tree, root)} into itself."))
            elif root in above:
                cycles.append(Refusal(
                    root, CYCLE, f"Cannot move {_q(tree, root)} into {_q(tree, parent)}, which is inside it."
                ))
    if cycles:
        return _Step(refusals=tuple(cycles))

    siblings = _siblings(tree, parent)
    before = group.before_id
    if before is not None and before not in siblings:  # not a child of the target (a before_id that is gone was answered above)
        if not undo:
            inside = "at the top level" if parent is None else f"inside {_q(tree, parent)}"
            reason = f"Cannot place {_q(tree, roots[0])} before {_q(tree, before)}: {_q(tree, before)} is not {inside}."
            return _Step(refusals=(Refusal(roots[0], BAD_BEFORE, reason),))
        before = None  # an undo puts them last when the sibling it remembered has gone or sits elsewhere now; expect.parents guards the real conflict
    moving = set(roots)
    rest = [s for s in siblings if s not in moving]
    if before in moving:  # "before something that moves too": the first sibling after it that stays
        after = siblings[siblings.index(before) + 1:]
        before = next((s for s in after if s not in moving), None)
    index = rest.index(before) if before is not None else len(rest)
    final = tuple(rest[:index] + roots + rest[index:])

    refusals = _clashes(tree, roots, parent, rest, keys)
    if refusals:
        return _Step(refusals=tuple(refusals))
    if all(tree.nodes[r].parent_id == parent for r in roots) and list(final) == siblings:
        return _Step(roots=tuple(roots), before=before, final=final, unchanged=True)

    context = MoveContext(tree, tuple(roots), parent, before, final, keys, undo)
    for rule in RULES if rules is None else rules:
        refusals.extend(rule(context))
    if refusals:
        return _Step(refusals=tuple(refusals))
    return _Step(roots=tuple(roots), before=before, final=final)


def decide(
    tree: AssetTree, group: Group, keys: Mapping[int, str], *,
    rules: Sequence[Callable[[MoveContext], Iterable[Refusal]]] | None = None, undo: bool = False,
) -> list[Refusal]:
    """The refusals for one group against `tree` as it stands (nothing is applied). `keys` maps asset id to the normalised name
    key for every id of the group and every child of its target. `undo=True` lets a `before_id` that is no longer a child of the
    target fall back to last instead of refusing."""
    return list(_examine(tree, group, keys, rules, undo).refusals)


def _undo_groups(tree: AssetTree, roots: Sequence[int]) -> list[Group]:
    """The groups that put `roots` back as the tree is NOW: one per maximal run of neighbours in the old sibling order (A X B C
    with A, B, C moved is two runs, so X stays between them again); each run goes before the sibling that followed it, which
    did not move by the definition of a maximal run, or last."""
    moving = set(roots)
    groups: list[Group] = []
    done: set[int | None] = set()
    for root in roots:
        parent = tree.nodes[root].parent_id
        if parent in done:
            continue
        done.add(parent)
        siblings = _siblings(tree, parent)
        run: list[int] = []
        for position, sibling in enumerate(siblings):
            if sibling not in moving:
                continue
            run.append(sibling)
            following = siblings[position + 1] if position + 1 < len(siblings) else None
            if following not in moving:  # also when there is none
                groups.append(Group(tuple(run), parent, following))
                run = []
    return groups


def _refused(tree: AssetTree, refusals: list[Refusal]) -> Plan:
    return Plan(refusals, [], [], [], [], 0, {}, [], tree)


def plan(
    tree: AssetTree, groups: Sequence[Group], keys: Mapping[int, str], *,
    rules: Sequence[Callable[[MoveContext], Iterable[Refusal]]] | None = None, undo: bool = False,
) -> Plan:
    """Apply `groups` in order to `tree` (it is not changed) and say what has to be written, or why not.

    A later group sees the earlier ones: it may move something into a place that only exists after group 1, and the roots of
    each group are worked out against the tree as it is then. The first group that is refused ends the work: its refusals are the
    answer, nothing is planned."""
    if (problem := shape_problem(groups)) is not None:
        return _refused(tree, [Refusal(None, INVALID, problem)])
    current = tree
    moved: list[tuple[int, int | None, int]] = []  # (root, its parent just before its group, assets below it)
    unchanged: list[int] = []
    undo_groups: list[list[Group]] = []
    touched: set[int] = set()
    moving_assets: set[int] = set()
    for group in groups:
        step = _examine(current, group, keys, rules, undo)
        if step.refusals:
            return _refused(tree, list(step.refusals))
        # The target and the sibling the roots land before (resolved: the one that was asked for may itself move, or, for an undo,
        # may be gone). Both must exist and stay until the write; the asked-for one is either this one or a root, which is locked anyway.
        touched.update(i for i in (group.parent_id, step.before) if i is not None)
        if step.unchanged:
            unchanged.extend(step.roots)
            continue
        undo_groups.append(_undo_groups(current, step.roots))
        for root in step.roots:
            below = subtree_ids(current, root)
            moving_assets.update(below)
            moved.append((root, current.nodes[root].parent_id, len(below)))
        nodes = dict(current.nodes)
        for position, asset_id in enumerate(step.final):
            node = nodes[asset_id]
            if node.parent_id != group.parent_id or node.sort_order != position:
                nodes[asset_id] = replace(node, parent_id=group.parent_id, sort_order=position)
        current = AssetTree(nodes)

    writes = [
        Write(i, node.parent_id, node.sort_order)
        for i, node in sorted(current.nodes.items())
        if (node.parent_id, node.sort_order) != (tree.nodes[i].parent_id, tree.nodes[i].sort_order)
    ]
    roots = [
        MovedRoot(
            id=root, name=tree.nodes[root].name, from_parent_id=was, to_parent_id=current.nodes[root].parent_id,
            from_sort_order=tree.nodes[root].sort_order, to_sort_order=current.nodes[root].sort_order,
            change="parent" if was != current.nodes[root].parent_id else "order", subtree_assets=size,
        )
        for root, was, size in moved
    ]
    lock_ids = sorted(touched | {w.id for w in writes} | {r.id for r in roots})
    # Every root of the request, moved or not: an undo of two picks that were not neighbours ends with one group that finds its root
    # already in place, and the expectation the person (or the undo) carries names both. An id is named once in a request, so no root
    # is in both lists; an unchanged root sits where it sat when the request came in, which is its parent.
    parents = {r.id: r.from_parent_id for r in roots}
    parents.update({root: tree.nodes[root].parent_id for root in unchanged})
    return Plan(
        refusals=[], writes=writes, roots=roots, unchanged=unchanged,
        undo=[g for per_group in reversed(undo_groups) for g in per_group], assets=len(moving_assets),
        parents=parents, lock_ids=lock_ids, tree=current,
    )


@dataclass(frozen=True)
class RateChange:
    id: int
    rate_before: float | None  # the rate the root is billed at today; None = no tariff applies
    rate_after: float | None
    today: bool  # the rate differs today
    other_days: bool  # it differs on some other day (past or future)


def rate_changes(
    tariffs: Sequence[TariffRow], before: AssetTree, after: AssetTree, roots: Iterable[MovedRoot], today: date
) -> list[RateChange]:
    """For each moved root, whether the move changes the rate it is billed at (core.cost.rate_at on both trees).

    A rate only changes at a tariff row's effective date, so today and every effective date, past and future, cover every day.
    A descendant either has an owner inside the moved subtree (its rate cannot change) or inherits the root's rate, so the root
    is enough. A reorder inside one parent never changes a rate."""
    days = sorted({row.effective_from for row in tariffs} - {today})
    found = []
    for root in roots:
        rate_before, rate_after = rate_at(tariffs, before, root.id, today), rate_at(tariffs, after, root.id, today)
        if root.change == "order":
            found.append(RateChange(root.id, rate_before, rate_after, False, False))
            continue
        found.append(RateChange(
            root.id, rate_before, rate_after, rate_before != rate_after,
            any(rate_at(tariffs, before, root.id, day) != rate_at(tariffs, after, root.id, day) for day in days),
        ))
    return found

