"""Tag shapes (w36): the points of a source grouped by the SHAPE of their tag text. Pure: no I/O, no FastAPI, no database.

A shape is the tag text with every run of digits collapsed (`PDUA01_PM0_PENRG` and `PDUA02_PM0_PENRG` are `pdua#_pm#_penrg`), so a
source of 15,000 tags becomes a few dozen rows a person can decide about. Letters are never generalised: `P`, `S` and `Q` (active,
apparent and reactive power) are three shapes, `PDUA` and `PDUB` are two. Every rule below is a GUESS from the text alone; the
page says so. Nothing here knows a product, a vendor or a site name.

Digit runs are ASCII only (`[0-9]+`, on purpose): `\\d` and `str.isdecimal` also take Arabic-Indic and other scripts' digits, which
would join `PDU١` with `PDU1`. Such a digit is an ordinary character here.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, replace
from operator import itemgetter
from typing import Any

from dcdash.connectors.opcua_ids import has_number_prefix, tag_name
from dcdash.core.discovery import MappingGuess, PointInfo, _natural, _tokens, guess_mapping
from dcdash.core.metrics import Metric, default_interval

_DIGITS = re.compile(r"([0-9]+)")  # ASCII digits only; the capture group makes re.split keep the runs (odd positions)
# `[ns=N;]s=<cluster>.<tag>`: the stable form of an OPC UA string id; its tag (after the first dot) is the text of a member, whatever the name says.
_STABLE_FORM = re.compile(r"(?:ns=[0-9]+;)?s=[^.\s]*\.(\S+)")
MIN_SIMILAR_LENGTH = 3  # the first tokens of two similar shapes are at least this many characters long (the `#` of a digit run counts)
MISSING_NAMED = 5  # how many equipment values without a shape are named; the rest are counted
UNIT_HINTS_SHOWN = 3
EXAMPLES_SHOWN = 3
_BILLING_RANK = {"counter": 0, "power": 1, None: 2}


@dataclass(frozen=True)
class Member:
    """One stored point of a source, as the shapes need it. `twin`: an unmapped point whose stable address equals a mapped point's."""

    id: int
    address: str
    name: str
    unit_hint: str | None = None
    mapped: bool = False
    twin: bool = False


@dataclass(frozen=True)
class Equipment:
    """The outlier figures of a shape: of the `population` of equipment values like this shape's, `with_shape` have it."""

    population: int
    with_shape: int
    missing: tuple[str, ...]  # the first MISSING_NAMED equipment values (natural order) that have none of the shape
    missing_total: int  # how many have none of it, named or not


@dataclass(frozen=True)
class Suggestion:
    """What guess_mapping says for the most common member of the shape. Always a guess."""

    metric: Metric
    scale: float
    interval_seconds: int
    custom_unit: str | None
    mixed: bool  # the members do not all guess the same


@dataclass(frozen=True)
class Shape:
    key: str  # what decisions and saved rules name: digit runs collapsed, case folded
    label: str  # for display: the first member's spelling, digits kept where every member has the same digits
    count: int  # members, mapped and twins included
    mapped: int
    twins: int
    duplicates: int  # members whose text equals another member's text exactly (a pair counts 2)
    examples: tuple[Member, ...]
    unit_hints: tuple[str, ...]
    mixed_units: bool
    suggestion: Suggestion
    billing: str | None  # "counter" (a guessed energy counter), "power" (a guessed active power) or None
    per_equipment: int  # the largest number of members on one equipment value
    equipment: Equipment | None  # None when the text has a single token
    similar: tuple[str, ...]  # keys of the shapes that differ only in one letter of the first token
    members: tuple[Member, ...]  # all of them, in natural order
    rule: dict[str, Any] | None = None  # saved rules arrive in T7


@dataclass(frozen=True)
class ShapeSet:
    shapes: list[Shape]  # rows: counters first, then power, then the rest; each by size, then label
    other: list[Member]  # members whose shape has no second member, in the order they were given
    # first-token shape key -> every equipment value of the source with that key (over ALL members), exact spelling
    equipment_population: dict[str, frozenset[str]]


def member_text(address: str, name: str) -> str:
    """The text a member is grouped by, taken from the ADDRESS when it is a string id with a cluster: the tag of a numbered id; else the
    part of a stable id after the FIRST dot (the cluster is the first dot segment only, dots inside the tag stay), whatever the name
    says; else the name. The numbered test comes first: `ns=3;s=1:Site.` and `ns=3;s=20403:.` differ between the two forms."""
    if has_number_prefix(address):
        return tag_name(address)
    found = _STABLE_FORM.fullmatch(address)
    return found[1] if found is not None else name


def shape_key(text: str) -> str:
    """The text with every ASCII digit run replaced by `#`, case folded."""
    return "#".join(_DIGITS.split(text)[::2]).casefold()


def natural_key(text: str) -> Any:
    """`core.discovery._natural`, except that a digit run too long for Python to convert (a tag name is untrusted text) falls back to
    the case-folded text instead of raising."""
    try:
        return _natural(text)
    except ValueError:
        return [(1, text.casefold())]


# One member while grouping: (member, text, split parts [text, digits, text, ...], equipment value or None, what guess_mapping reads).
# The last is (stripped unit hint, "") or ("", last token of the text folded): the only two things guess_mapping looks at.
_Item = tuple[Member, str, list[str], "str | None", tuple[str, str]]
_TEXT, _EQUIPMENT, _GUESS = itemgetter(1), itemgetter(3), itemgetter(4)


def _order(item: _Item) -> tuple[Any, str]:
    """Natural order inside one shape. Members of a shape have the same letters, so only the numbers decide: compared as numbers
    (length without leading zeros, then digits) without int(), which refuses a run of more than 4,300 digits."""
    runs = [(len(stripped := digits.lstrip("0")), stripped) for digits in item[2][1::2]]
    return runs, item[1].casefold()


def _label(items: list[_Item]) -> str:
    first = items[0][2]
    count = len(first)
    keep = [True] * (count // 2)
    for item in items:
        parts = item[2]
        if len(parts) != count:  # `A#_x` and `A1_x` share a key but not a number of runs: no digit is "the same in every member"
            keep = [False] * len(keep)
            break
        for i in range(1, count, 2):
            if keep[i // 2] and parts[i] != first[i]:
                keep[i // 2] = False
        if not any(keep):
            break
    pieces = [first[0]]
    for j, constant in enumerate(keep):
        pieces.append(first[2 * j + 1] if constant else "#")
        pieces.append(first[2 * j + 2])
    return "".join(pieces)


def build_shapes(members: Iterable[Member]) -> ShapeSet:
    """Group members into shapes. One pass over the members (30,000 take well under a second), no I/O. The result does not depend on
    the order of the members, except `other`, which keeps it."""
    keyed: list[tuple[str, _Item]] = []
    groups: dict[str, list[_Item]] = {}
    samples: dict[tuple[str, str], _Item] = {}  # one member for each thing guess_mapping reads
    for member in members:
        text = member_text(member.address, member.name)
        parts = _DIGITS.split(text)
        tokens = _tokens(text)
        hint = (member.unit_hint or "").strip()
        if hint:
            guess_key = (hint, "")
        else:
            last = tokens[-1].casefold() if tokens else ""
            # a unit is never spelled with digits, so `A1` and `A2` guess alike: one cache entry, not one per member
            guess_key = ("", last if last.isalpha() else _DIGITS.sub("#", last))
        item: _Item = (member, text, parts, tokens[0] if len(tokens) > 1 else None, guess_key)
        samples.setdefault(guess_key, item)
        key = "#".join(parts[::2]).casefold()
        keyed.append((key, item))
        groups.setdefault(key, []).append(item)
    other = [item[0] for key, item in keyed if len(groups[key]) == 1]

    # The population of equipment values: over ALL members (mapped, twins and one-member shapes too), by the shape of the first token.
    population: dict[str, set[str]] = {}
    first_keys: dict[str, str] = {}

    def first_key(value: str) -> str:
        found = first_keys.get(value)
        if found is None:
            found = first_keys[value] = shape_key(value)
        return found

    for items in groups.values():
        for value in {item[3] for item in items if item[3] is not None}:
            population.setdefault(first_key(value), set()).add(value)
    ordered_population: dict[str, list[str]] = {}

    guesses: dict[tuple[str, str], MappingGuess] = {}  # keyed by what guess_mapping reads (see _Item)
    shapes: list[Shape] = []
    traits: dict[str, tuple[Metric, frozenset[str]]] = {}  # key -> (suggested metric, every unit hint folded): for `similar`
    for key, items in groups.items():
        if len(items) < 2:
            continue
        items.sort(key=_order)
        mapped = sum(1 for item in items if item[0].mapped)
        twins = sum(1 for item in items if item[0].twin)
        texts = Counter(map(_TEXT, items))
        on_equipment = Counter(map(_EQUIPMENT, items))
        on_equipment.pop(None, None)
        guess_counts = Counter(map(_GUESS, items))
        hint_counts: Counter[str] = Counter()  # unit hints compared without case, in the order they were first seen
        spelled: dict[str, str] = {}
        for guess_key, n in guess_counts.items():
            if hint := guess_key[0]:
                folded = hint.casefold()
                hint_counts[folded] += n
                spelled.setdefault(folded, hint)
            if guess_key not in guesses:
                sample = samples[guess_key]
                guesses[guess_key] = guess_mapping(PointInfo(sample[0].id, sample[0].address, sample[1], sample[0].unit_hint))
        triples: Counter[tuple[Metric, float, str | None]] = Counter()
        for guess_key, n in guess_counts.items():
            guess = guesses[guess_key]
            triples[(guess.metric, guess.scale, guess.custom_unit)] += n
        metric, scale, custom_unit = min(triples, key=lambda t: (-triples[t], t[0].value, t[1], t[2] or ""))
        suggestion = Suggestion(metric, scale, default_interval(metric), custom_unit, len(triples) > 1)
        hints_by_count = sorted(hint_counts, key=lambda folded: -hint_counts[folded])  # stable: ties keep the natural order of first sight
        equipment = None
        if items[0][3] is not None:
            value = items[0][3]
            ordinary = population[first_key(value)]
            have = ordinary & on_equipment.keys()
            ordered = ordered_population.get(first_key(value))
            if ordered is None:
                ordered = ordered_population[first_key(value)] = sorted(ordinary, key=natural_key)
            missing = []
            if len(have) < len(ordinary):
                for candidate in ordered:
                    if candidate not in have:
                        missing.append(candidate)
                        if len(missing) == MISSING_NAMED:
                            break
            equipment = Equipment(len(ordinary), len(have), tuple(missing), len(ordinary) - len(have))
        members_in_order = tuple(item[0] for item in items)
        shapes.append(
            Shape(
                key=key, label=_label(items), count=len(items), mapped=mapped, twins=twins,
                duplicates=sum(n for n in texts.values() if n > 1), examples=members_in_order[:EXAMPLES_SHOWN],
                unit_hints=tuple(spelled[folded] for folded in hints_by_count[:UNIT_HINTS_SHOWN]), mixed_units=len(hint_counts) > 1,
                suggestion=suggestion,
                billing={Metric.ENERGY_KWH: "counter", Metric.ACTIVE_POWER_KW: "power"}.get(metric),
                per_equipment=max(on_equipment.values(), default=1), equipment=equipment, similar=(),
                members=members_in_order,
            )
        )
        traits[key] = (metric, frozenset(hint_counts))

    similar = _similar(traits)
    shapes = [replace(shape, similar=similar[shape.key]) if shape.key in similar else shape for shape in shapes]
    shapes.sort(key=lambda s: (_BILLING_RANK[s.billing], -s.count, natural_key(s.label)))
    return ShapeSet(shapes, other, {first: frozenset(values) for first, values in population.items()})


def _similar(traits: dict[str, tuple[Metric, frozenset[str]]]) -> dict[str, tuple[str, ...]]:
    """Shapes whose keys differ in exactly one letter of the first token: the same rest of the key, the same guessed metric and the
    same unit hints, first tokens of equal length (at least MIN_SIMILAR_LENGTH) that differ at one position where both have a letter.
    Bucketed (rest, metric, hints, length), then by the first token with one letter masked out, so thousands of shapes never meet
    in pairs."""
    outer: dict[tuple[str, Metric, frozenset[str], int], list[tuple[str, str]]] = {}
    for key, (metric, hints) in traits.items():
        tokens = _tokens(key)
        if len(tokens) < 2 or len(tokens[0]) < MIN_SIMILAR_LENGTH:
            continue
        first = tokens[0]
        rest = key[key.find(first) + len(first):]
        outer.setdefault((rest, metric, hints, len(first)), []).append((first, key))
    found: dict[str, set[str]] = {}
    for bucket in outer.values():
        if len(bucket) < 2:
            continue
        masked: dict[tuple[int, str], list[str]] = {}
        for first, key in bucket:
            for i, character in enumerate(first):
                if character.isalpha():
                    masked.setdefault((i, first[:i] + "\0" + first[i + 1:]), []).append(key)
        for keys in masked.values():
            for key in keys:
                found.setdefault(key, set()).update(other for other in keys if other != key)
    return {key: tuple(sorted(keys, key=natural_key)) for key, keys in found.items()}


def shape_json(shape: Shape) -> dict[str, Any]:
    """The Shape of the GET /api/sources/{id}/shapes answer (the contract of the w36 plan). `rule` is None until T7."""
    equipment = shape.equipment
    suggestion = shape.suggestion
    return {
        "key": shape.key,
        "label": shape.label,
        "count": shape.count,
        "mapped": shape.mapped,
        "twins": shape.twins,
        "duplicates": shape.duplicates,
        "examples": [{"name": m.name, "address": m.address} for m in shape.examples],
        "unit_hints": list(shape.unit_hints),
        "mixed_units": shape.mixed_units,
        "suggestion": {
            "metric": suggestion.metric.value,
            "scale": suggestion.scale,
            "interval_seconds": suggestion.interval_seconds,
            "custom_unit": suggestion.custom_unit,
            "guess": True,
            "mixed": suggestion.mixed,
        },
        "billing": shape.billing,
        "per_equipment": shape.per_equipment,
        "equipment": None if equipment is None else {
            "population": equipment.population,
            "with_shape": equipment.with_shape,
            "missing": list(equipment.missing),
            "missing_total": equipment.missing_total,
        },
        "similar": list(shape.similar),
        "rule": shape.rule,
    }
