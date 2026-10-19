"""The breakdown of a bar widget by asset kind (w24): one bar per asset of a kind. Pure maths.

No database, no clock and no web framework: the caller loads the asset tree and the `id -> kind text` map, asks `candidates` for
the assets to draw, gets their figures from the very calculation every other bar widget uses (`core.widgets._fill_billing`),
builds a `Bar` for each, puts them in `order`, and cuts them with `top_and_more`.

Kinds are free text, so two texts are one kind when `kind_key` says so ("Rack", " rack " and "RACK"). A kind text is always
trimmed with `trim_kind` (the blank set of `kind_key`, which is JavaScript's), never with `str.strip()`.
"""
import math
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from dcdash.core.asset_kinds import _BLANKS, kind_key
from dcdash.core.tree import AssetTree

_ENDS = re.compile(rf"\A(?:{_BLANKS.pattern})|(?:{_BLANKS.pattern})\Z")


def trim_kind(text: str) -> str:
    """The kind text without the white space at either end (the blank set of `kind_key`); the case and the inside stay."""
    return _ENDS.sub("", text)


def common_spelling(texts: Iterable[str]) -> str:
    """The most frequent of the spellings in `texts`; ties go to the alphabetically first. ValueError when there are none."""
    counts = Counter(texts)
    if not counts:
        raise ValueError("no spelling to choose from")
    return min(counts, key=lambda spelling: (-counts[spelling], spelling))


def _below(tree: AssetTree, root: int | None) -> list[int]:
    """The assets under `root` at any depth, in tree preorder; the root itself is not one of them. `root` None is every asset
    of the tree. A root that is not in the tree has nothing below it (the caller decides what that means)."""
    if root is None:
        return tree.preorder()
    if root not in tree.nodes:
        return []
    found: list[int] = []
    seen = {root}  # also stops a parent cycle
    stack = list(reversed(tree.children(root)))
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        found.append(current)
        stack.extend(reversed(tree.children(current)))
    return found


def candidates(tree: AssetTree, kinds: Mapping[int, str], root: int | None, kind: str) -> tuple[list[int], int]:
    """The assets to draw as bars: below `root` (the root itself never; `root` None is the whole tree) and of the kind `kind`
    (compared with `kind_key`). An asset with another candidate among its ancestors is dropped, so the OUTER one stays and its
    figure is never added twice. Returns the outer candidates in tree preorder and how many were dropped.

    An asset missing from `kinds` is not a candidate. A blank `kind` matches nothing."""
    wanted = kind_key(kind)
    if not wanted:
        return [], 0
    matching = [i for i in _below(tree, root) if i in kinds and kind_key(kinds[i]) == wanted]
    chosen = set(matching)
    outer = [i for i in matching if not any(above in chosen for above in tree.ancestors_or_self(i)[1:])]
    return outer, len(matching) - len(outer)


def kinds_present(tree: AssetTree, kinds: Mapping[int, str], root: int | None) -> list[tuple[str, int]]:
    """The kinds of the assets below `root` (same scope as `candidates`, counted BEFORE the nested rule): one entry per
    `kind_key`, shown with its most frequent spelling, with how many assets have it. Most frequent first, ties by name. A blank
    kind text is left out."""
    spellings: dict[str, list[str]] = {}
    for asset_id in _below(tree, root):
        if asset_id not in kinds:
            continue
        key = kind_key(kinds[asset_id])
        if key:
            spellings.setdefault(key, []).append(kinds[asset_id])
    ordered = sorted(spellings.items(), key=lambda item: (-len(item[1]), item[0]))
    return [(common_spelling(texts), len(texts)) for _key, texts in ordered]


@dataclass(frozen=True)
class Bar:
    """One bar of a breakdown: an asset and its figure. `value` is None when the asset has no figure at all; `no_data` says the
    asset has no readings (its value is then not a number to sort by, whatever it holds)."""

    asset_id: int
    path: str
    value: float | None
    no_data: bool = False
    estimated: bool = False
    partial: bool = False

    @property
    def number(self) -> float | None:
        """The figure when it is a number to sort and add: not no-data, not unrated (None), not NaN; else None."""
        if self.no_data or self.value is None or not math.isfinite(self.value):
            return None
        return self.value


def order(items: Iterable[Bar]) -> list[Bar]:
    """The bars' order: those with a number first, the highest first; then those with none (no data, or consumption with no
    rate), by path. Ties by path, then by id. A missing figure is never sorted as a zero."""

    def key(bar: Bar) -> tuple[int, float, str, int]:
        number = bar.number
        if number is None:
            return (1, 0.0, bar.path, bar.asset_id)
        return (0, -number, bar.path, bar.asset_id)

    return sorted(items, key=key)


@dataclass(frozen=True)
class More:
    """What the bars after the first `top` add up to: how many there are, how many of them have a number, the sum of those
    numbers (None when none has one) and whether any of them is estimated or a partial cost."""

    count: int
    with_value: int
    value: float | None
    estimated: bool
    partial: bool


def top_and_more(bars: Sequence[Bar], top: int) -> tuple[list[Bar], More]:
    """The first `top` of the ordered `bars`, and the `More` for the rest."""
    shown = list(bars[: max(top, 0)])
    rest = bars[max(top, 0):]
    numeric = [(bar, number) for bar in rest if (number := bar.number) is not None]
    return shown, More(
        count=len(rest),
        with_value=len(numeric),
        value=math.fsum(number for _bar, number in numeric) if numeric else None,
        estimated=any(bar.estimated for bar, _number in numeric),
        partial=any(bar.partial for bar, _number in numeric),
    )
