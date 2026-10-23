"""Shape decisions as tag-list lines (w36). Pure: no database, no FastAPI, no I/O.

A person decides about a SHAPE ("map every `...PENRG` as a kWh counter, named by part 1 of the tag"); this module turns that decision
into the CSV the tag-list route (api/tag_lists.py) already reads, so the dry run, the commit and the Undo are the existing ones and
no second path writes a mapping. It also runs the checks a person trusts before the dry run: two tags on one asset and metric, one
tag spelled twice, mixed units, too many lines, a name the asset rules refuse. Everything that follows from the database (an asset
that already holds the metric, an unknown address, a name clash) is the PLANNER's job: the route runs the real parser and planner on
the CSV and turns every refusal into a `planner` check (`planner_checks` below); nothing here duplicates a planner rule except the
ones the contract lists.

Names are compared only through `key_of`, which the route fills from PostgreSQL (the `_PART_KEYS` statement of api/tag_lists.py:
the database's own normalisation of an asset name). Python's `casefold` never decides whether two names are one asset.

A shape's unit hint reaches the scale of its lines (a counter in Wh billed as kWh is a bill 1,000 times too high): where every tag
of the shape names one unit the metric knows, that unit gives the scale and a different scale in the decision blocks; where the
tags disagree about the unit, or some name none, the shape blocks. A unit another metric knows (kW for energy) is never made right by
a stated scale, and a unit in the decision counts as one more hint of the shape. A tag spelled twice is found by its stable address
over the whole decision. An address a tag list cannot name exactly (the parser trims
every cell) is never written.

A collision sentence advises only what works: "parts 1 and 2" when the names it derives really differ for the colliding tags (and the
list is not over its limit anyway), custom when the reading is not a billing one and the tags name one unit, and always the Points page.

Every sentence is plain words with the numbers it is about and an example taken from the data. Nothing here knows a product or a
site: the equipment part of a tag is whatever its first token is.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

from dcdash.connectors.opcua_ids import stable_address
from dcdash.core.discovery import _tokens
from dcdash.core.metrics import Metric
from dcdash.ingest.normalise import UNITS, NormaliseError, _spelling, scale_for
from dcdash.ingest.tag_list import MAX_NEW_ASSETS, MAX_ROWS, MAX_SEGMENT, MAX_TAG, ParsedList, Problem
from dcdash.shapes.core import Member, Shape, ShapeSet, member_text

NAME_FROM = ("part1", "parts12", "part1_part2")
HEADER = "tag,asset,metric,unit,scale,interval_seconds"  # unquoted: the tag list takes the first delimiter under which the names appear
SAMPLES_PER_SHAPE = 5
TAGS_NAMED = 3  # tags named in a collision sentence; the rest are counted
PLANNER_SHOWN = 5  # planner refusals that become a check each; the rest are counted
SHOWN = 60  # characters of a tag or a name in a sentence
BLOCKING, WARNING = "blocking", "warning"
TOO_MANY = f"at most {MAX_ROWS:,} tags at a time (the limit of a tag list): choose fewer shapes"

_FEW = {"parts12": "parts 1 and 2", "part1_part2": "part 1 / part 2"}
_NAMES_ADVICE = "decide these tags on the Points page"
_POINTS_PAGE = "decide those tags on the Points page"
_BILLING = frozenset({Metric.ENERGY_KWH, Metric.ACTIVE_POWER_KW})


@dataclass(frozen=True)
class LineDecision:
    """One decision about one shape. `shape` is the shape KEY (never the label); `unit` matters for a custom metric only."""

    shape: str
    metric: Metric
    name_from: str = "part1"
    unit: str | None = None
    scale: float | None = None
    interval_seconds: int | None = None


@dataclass(frozen=True)
class Check:
    kind: str  # gone, too_many, collision, renumbered, mixed_units, units, address, name, custom_unit, nothing, outlier, planner
    severity: str  # "blocking" or "warning"
    shape: str | None  # the key of the shape it is about, None for the whole list
    text: str

    def as_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "severity": self.severity, "shape": self.shape, "text": self.text}


@dataclass(frozen=True)
class Line:
    """One data line of the CSV, with what the route needs to explain a planner refusal."""

    shape: str
    member: Member
    text: str  # what the member is grouped by (core.member_text)
    asset: str  # the whole asset cell: the parent's path, then the derived names, joined with "/"
    metric: Metric
    unit: str
    scale: float
    interval_seconds: int | None


@dataclass
class LinesResult:
    csv: str
    lines: int
    blocking: bool
    by_shape: list[dict[str, Any]]
    checks: list[Check]
    samples: list[dict[str, Any]]
    rows: list[Line] = field(default_factory=list)  # every data line in file order; not part of the answer
    parent_path: list[str] = field(default_factory=list)  # the names the new assets were put under ([] = the top level)
    plan_assets: int | None = None  # the assets the route's own planner run would create; None until (unless) the planner ran

    def as_json(self) -> dict[str, Any]:
        return {
            "csv": self.csv, "lines": self.lines, "blocking": self.blocking, "by_shape": self.by_shape,
            "checks": [check.as_json() for check in self.checks], "samples": self.samples,
            "plan_assets": self.plan_assets, "parent_path": self.parent_path,
        }


# ---- small helpers ------------------------------------------------------------------------------------------------------


def _shown(text: str, limit: int = SHOWN) -> str:
    clean = "".join(char if char.isprintable() else "?" for char in text)
    return clean if len(clean) <= limit else clean[: limit - 3] + "..."


def _n(count: int, one: str, many: str) -> str:
    return f"{count:,} {one if count == 1 else many}"


def _listed(items: Sequence[str], more: int = 0) -> str:
    """`a`, `a and b`, `a, b and c`, `a, b, c and 2 more`: the items shortened, then the number left out."""
    shown = [_shown(item) for item in items]
    if more:
        shown.append(f"{more:,} more")
    return shown[0] if len(shown) == 1 else ", ".join(shown[:-1]) + " and " + shown[-1]


def _cell(value: str) -> str:
    """A data cell as `_cells` in ingest/tag_list.py reads it: always quoted, a quote doubled (addresses hold `;` and `=`)."""
    return '"' + value.replace('"', '""') + '"'


def hints_of(shape: Shape) -> list[str]:
    """The distinct unit hints of the shape's members, compared without case, the most common first (ties in natural order); the
    first spelling seen is the one shown."""
    counts: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    for member in shape.members:
        hint = (member.unit_hint or "").strip()
        if hint:
            folded = hint.casefold()
            counts[folded] += 1
            spelled.setdefault(folded, hint)
    return [spelled[folded] for folded, _ in counts.most_common()]


def readable(address: str) -> bool:
    """True when a tag list names this address exactly: the parser trims every cell, and the planner refuses a tag with an
    unprintable character (a line break, a tab, NUL, an invisible character) or one over MAX_TAG characters. A trimmed address would
    map another point, or none."""
    return address == address.strip() and address.isprintable() and len(address) <= MAX_TAG


def _unit_counts(shape: Shape) -> tuple[list[tuple[str, int]], int]:
    """The distinct unit hints of ALL the shape's members, compared without case and without spaces (as `scale_for` reads them), the
    most common first (ties in the order first seen) with how many members name each, the first spelling seen being the one shown;
    and how many members name none."""
    counts: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    for member in shape.members:
        hint = (member.unit_hint or "").strip()
        if hint:
            folded = "".join(hint.lower().split())
            counts[folded] += 1
            spelled.setdefault(folded, hint)
    return [(spelled[folded], n) for folded, n in counts.most_common()], len(shape.members) - sum(counts.values())


def _says(count: int, what: str) -> str:
    return f"{count:,} {'names' if count == 1 else 'name'} {what}"


def _way_out(metric: Metric, custom_works: bool) -> str:
    """What a person can do about a unit: the Points page, which takes any scale. Custom is offered only for a reading that is not a
    billing one (the energy and power figures read those two metrics, so a billing row mapped as custom is lost to them) and only where
    it can work from this page: it needs one unit, and the page sends none, so it takes the one unit the tags name."""
    if metric in _BILLING or not custom_works:
        return _POINTS_PAGE
    return f"{_POINTS_PAGE}, or map the shape as custom"


def _mixed_units_text(hints: list[tuple[str, int]], none: int, metric: Metric) -> str:
    """Several units, or a unit on some tags and none on the others: one scale cannot fit all of them."""
    shown, rest = hints[:TAGS_NAMED], sum(n for _, n in hints[TAGS_NAMED:])
    parts = [_says(n, _shown(hint)) for hint, n in shown]
    if rest:
        parts.append(_says(rest, "another unit" if rest == 1 else "other units"))
    advice = _way_out(metric, custom_works=len(hints) == 1)
    if not none:
        units = _listed([hint for hint, _ in shown], len(hints) - len(shown))
        return f"This shape has the units {units} ({_joined(parts)}); {advice}"
    parts.append(_says(none, "none"))
    first = hints[0][1]
    lead = f"{first:,} {'tag' if first == 1 else 'tags'} of this shape {'names' if first == 1 else 'name'} the unit {_shown(hints[0][0])}"
    return f"{_joined([lead, *parts[1:]])}; {advice}"


def _joined(parts: Sequence[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def _figure(value: float) -> str:
    return format(value, ",.10g")


def _known_elsewhere(unit: str) -> bool:
    """True when the table of some metric knows this spelling (kW is the power reading's, Wh the energy reading's): a unit that is
    somebody's, so a scale can never make it right for another reading."""
    spelled = _spelling(unit)
    return any(spelled in table for table in UNITS.values())


def _non_custom_scale(shape: Shape, decision: LineDecision, metric: Metric) -> tuple[float, Check | None]:
    """The scale of every line of a decision with a metric that knows its unit, and the check that blocks it, if any. The CSV's unit
    column stays empty, so the planner never sees the shape's unit nor the decision's: both are read here, with the planner's own
    `scale_for`.
    - several units, or a unit on some tags and none on others: blocking `mixed_units`;
    - a unit in the decision is one more hint of the shape: `scale_for` must accept it for the metric, the decision's scale must be the
      same number, and the unit of the tags (if they name one) must be the same unit; any other case blocks (`units`);
    - one unit on every tag: that unit's scale. A decision scale that is not the same number blocks (`units`). A unit the metric does
      not know (`scale_for` refuses it) blocks, unless NO metric knows it and the decision states the scale: then the person's number
      is used. A unit that another metric knows (kW for energy) always blocks, whatever scale is stated;
    - no tag names a unit: the decision's unit gives the scale, else the decision's scale, else the shape's suggested scale when the
      metric is the suggested one, else 1."""
    hints, none = _unit_counts(shape)
    given = None if decision.scale is None else float(decision.scale)
    fallback = given if given is not None else float(shape.suggestion.scale) if metric == shape.suggestion.metric else 1.0
    if len(hints) > 1 or (hints and none):
        return fallback, Check("mixed_units", BLOCKING, shape.key, _mixed_units_text(hints, none, metric))
    stated = (decision.unit or "").strip()
    own: float | None = None  # the scale of the unit the decision names
    if stated:
        try:
            own = scale_for(stated, metric.value)
        except NormaliseError:
            return fallback, Check(
                "units", BLOCKING, shape.key,
                f'The unit "{_shown(stated)}" chosen is not one that {metric.value} knows; {_way_out(metric, custom_works=False)}',
            )
        if given is not None and not math.isclose(given, own, rel_tol=1e-9):
            return own, Check(
                "units", BLOCKING, shape.key,
                f'The unit "{_shown(stated)}" chosen means a scale of {_figure(own)}, but the scale chosen is {_figure(given)}; '
                "leave the scale out, or decide these tags on the Points page",
            )
    if not hints:
        return (fallback if own is None else own), None
    hint = hints[0][0]
    subject = f'The unit "{_shown(hint)}" of the {len(shape.members):,} tags of this shape'
    try:
        from_unit: float | None = scale_for(hint, metric.value)
    except NormaliseError:
        from_unit = None
    if own is not None and (from_unit is None or not math.isclose(from_unit, own, rel_tol=1e-9)):
        return own, Check(
            "units", BLOCKING, shape.key,
            f'The unit "{_shown(stated)}" chosen is not the unit "{_shown(hint)}" of the {len(shape.members):,} tags of this shape; '
            "leave the unit out, or decide these tags on the Points page",
        )
    if from_unit is None:
        if given is not None and not _known_elsewhere(hint):
            return given, None
        return 1.0, Check(
            "units", BLOCKING, shape.key, f"{subject} is not one that {metric.value} knows; {_way_out(metric, custom_works=True)}",
        )
    if given is not None and not math.isclose(given, from_unit, rel_tol=1e-9):
        return from_unit, Check(
            "units", BLOCKING, shape.key,
            f"{subject} means a scale of {_figure(from_unit)}, but the scale chosen is {_figure(given)}; "
            "leave the scale out, or decide these tags on the Points page",
        )
    return from_unit, None


def derive(text: str, name_from: str) -> tuple[tuple[str, ...], str | None]:
    """The names of the asset path below the parent for a tag text, or why there are none: `empty` (no part at all), `few` (a choice
    that needs two parts and the text has one), `slash`, `long` (over the asset rules' 100 characters) or `invisible`.
    part1 = the first token; parts12 = the first two joined by one space; part1_part2 = the first as an asset, the second as a child."""
    if name_from not in NAME_FROM:
        raise ValueError(f"name_from must be one of {', '.join(NAME_FROM)}")
    tokens = _tokens(text)
    if not tokens:
        return (), "empty"
    if name_from == "part1":
        names: tuple[str, ...] = (tokens[0],)
    elif len(tokens) < 2:
        return (), "few"
    else:
        names = (" ".join(tokens[:2]),) if name_from == "parts12" else (tokens[0], tokens[1])
    for name in names:
        if "/" in name:
            return (), "slash"
        if len(name) > MAX_SEGMENT:
            return (), "long"
        if not name.isprintable():
            return (), "invisible"
    return names, None


def _resolve(shape_set: ShapeSet, decisions: Iterable[LineDecision]) -> list[tuple[LineDecision, Shape | None, bool]]:
    """Each decision with its shape (None: the shape is not in the source any more) and whether an earlier decision already named it."""
    by_key = {shape.key: shape for shape in shape_set.shapes}
    seen: set[str] = set()
    resolved = []
    for decision in decisions:
        resolved.append((decision, by_key.get(decision.shape), decision.shape in seen))
        seen.add(decision.shape)
    return resolved


def parts_needed(shape_set: ShapeSet, decisions: Iterable[LineDecision]) -> list[str]:
    """Every distinct name `build_lines` will compare through `key_of`: the route asks the database for all their keys in ONE statement
    before it calls `build_lines`. Derived by the same function over the same members, so the two cannot drift apart."""
    found: dict[str, None] = {}
    for decision, shape, duplicate in _resolve(shape_set, decisions):
        if shape is None or duplicate:
            continue
        for member in shape.members:
            if member.mapped or member.twin or not readable(member.address):
                continue
            names, problem = derive(member_text(member.address, member.name), decision.name_from)
            if problem is None:
                found.update(dict.fromkeys(names))
    return list(found)


# ---- the sentences ------------------------------------------------------------------------------------------------------


def _unnamed_text(problem: str, texts: list[str], name_from: str) -> str:
    n, example = len(texts), _shown(texts[0])
    if problem == "empty":
        return f"{_n(n, 'tag of this shape has', 'tags of this shape have')} no name to take an asset name from (for example {example})"
    if problem == "few":
        return (
            f"{_n(n, 'tag of this shape has', 'tags of this shape have')} fewer than two parts in the name (for example {example}), so "
            f'"{_FEW[name_from]}" cannot name their asset; choose "part 1" or decide these tags on the Points page'
        )
    if problem == "long":
        return f"{_n(n, 'asset name', 'asset names')} would be longer than {MAX_SEGMENT} characters (for example from {example}); {_NAMES_ADVICE}"
    if problem == "slash":
        return f'{_n(n, "asset name", "asset names")} would contain a "/" (for example from {example}), which a tag list cannot write; {_NAMES_ADVICE}'
    return f"{_n(n, 'asset name', 'asset names')} would hold control or invisible characters (for example from {example}); {_NAMES_ADVICE}"


def _same_name(name: str) -> str:
    """A name as coarsely as can be: the whitespace collapsed and the case folded. Coarser than the database's key (whatever the
    database reads as one name this reads as one), so two names this tells apart the database tells apart too. It only decides whether
    a piece of advice is offered, never whether two names are one asset: that is `key_of`'s."""
    return " ".join(name.split()).casefold()


def _parts12_separates(collisions: Iterable[Sequence[str]]) -> bool:
    """True when choosing "parts 1 and 2" would give the tags that collide under part 1 asset names that differ. `collisions` is, for
    each asset the tags land on, the texts of those tags (different tags); computed from the tags' own tokens. Tags of one text (two
    clusters' tags of one name) get one name, and a tag with a single part has none: both make this false."""
    for texts in collisions:
        names: list[str] = []
        for text in texts:
            derived, problem = derive(text, "parts12")
            if problem is not None:
                return False
            names.append(_same_name(derived[0]))
        if len(set(names)) != len(names):
            return False
    return True


def _collision_advice(split: bool, custom: bool) -> str:
    """What to do about tags that land on one asset: only what works. `split`: "parts 1 and 2" would name their assets apart.
    `custom`: the reading is not a billing one and one unit makes a custom metric possible from the page. The Points page always works."""
    if split:
        return 'choose "parts 1 and 2" or ' + ("map them as custom" if custom else "decide those tags on the Points page")
    return "map them as custom or decide them on the Points page" if custom else _POINTS_PAGE


def _collision_text(groups: dict[tuple[str, ...], list[str]], names: dict[tuple[str, ...], tuple[str, ...]], advice: str) -> str:
    sizes = [len(texts) for texts in groups.values()]
    first_keys = next(iter(groups))
    first_texts = groups[first_keys]
    asset = "/".join(names[first_keys])
    gets = f"{asset} gets {_listed(first_texts[:TAGS_NAMED], max(0, len(first_texts) - TAGS_NAMED))}"
    if min(sizes) == max(sizes):
        each = "each asset" if len(groups) == 1 else f"each of {len(groups):,} assets"
        lead = f"{sizes[0]:,} tags of this shape would land on {each}"
    else:
        lead = f"From {min(sizes):,} to {max(sizes):,} tags of this shape would land on one asset, on {len(groups):,} assets in all"
    return f"{lead} ({gets}); {advice}"


def _unreadable_text(count: int) -> str:
    return (
        f"{_n(count, 'tag of this shape has', 'tags of this shape have')} an address a tag list cannot name exactly (a space at the start "
        f"or end, an unprintable character or more than {MAX_TAG} characters); decide them on the Points page"
    )


def _renumbered_text(texts: list[str]) -> str:
    n = len(texts)
    lead = (
        f"{n:,} tags of this shape appear twice (the SCADA renumbered them)" if n != 1
        else "1 tag of this shape appears twice (the SCADA renumbered it)"
    )
    return (
        f'{lead}; switch on "Stable tag addresses" for this source and browse again, or decide them on the Points page '
        f"(for example {_shown(texts[0])})"
    )


def _outlier_text(shape: Shape) -> str | None:
    equipment = shape.equipment
    if equipment is None or equipment.missing_total == 0:
        return None
    like = _tokens(member_text(shape.members[0].address, shape.members[0].name))[0]
    named = _listed(equipment.missing, equipment.missing_total - len(equipment.missing))
    verb = "does" if equipment.missing_total == 1 else "do"
    return f"{equipment.with_shape:,} of {equipment.population:,} like {_shown(like)} have this tag; {named} {verb} not"


# ---- the lines ----------------------------------------------------------------------------------------------------------


def build_lines(
    shape_set: ShapeSet,
    decisions: Sequence[LineDecision],
    parent_path: Sequence[str] | None,
    key_of: Callable[[str], str],
) -> LinesResult:
    """Turn decisions into CSV lines and checks.

    `parent_path`: the names from the root down to the asset the new assets go under (empty: the top level); None means that asset
    does not exist (any more), which is a blocking `name` check. `key_of(name)`: the database's key for an asset name; it is called
    only with the names `parts_needed` lists. The lines of one decision are in the natural order of the members' texts, the decisions
    in the order given. Mapped members and the twins of mapped members are left out and counted, never written; so is a member whose
    address a tag list cannot name exactly (`readable`), which blocks with an `address` check. The CSV is "" when any check blocks and
    when there is no line.

    `by_shape[].assets` counts the NEW path elements below the parent that the lines of the decision would create; for `part1_part2`
    the parents and the children together (200 PDUs with one meter each: 400). It is an upper bound: an asset that already exists is
    counted as new (the planner knows which do)."""
    checks: list[Check] = []
    if parent_path is None:
        checks.append(Check("name", BLOCKING, None, "The asset the new assets should go under no longer exists; choose another one, or none"))
        parent: list[str] = []
    else:
        parent = list(parent_path)
        slashed = next((name for name in parent if "/" in name), None)
        if slashed is not None:
            checks.append(Check(
                "name", BLOCKING, None,
                f'The asset "{_shown(slashed)}" that the new assets go under has a "/" in its name, which a tag list cannot write; rename it first',
            ))
    rows: list[Line] = []
    by_shape: list[dict[str, Any]] = []
    samples: list[dict[str, Any]] = []
    claims: dict[tuple[tuple[str, ...], str], tuple[str, str]] = {}  # (key path, metric) -> (label, text) of the first line that took it
    elements: set[tuple[str, ...]] = set()  # every asset of the path below the parent, as if none existed yet
    # the collision checks of the shapes, for the advice that depends on the whole list: (index in `checks`, the groups, the names, whether
    # "parts 1 and 2" separates the tags, whether custom can work)
    collisions: list[tuple[int, dict[tuple[str, ...], list[str]], dict[tuple[str, ...], tuple[str, ...]], bool, bool]] = []

    for decision, shape, duplicate in _resolve(shape_set, decisions):
        if shape is None:
            checks.append(Check(
                "gone", BLOCKING, decision.shape,
                "This shape is no longer in the source (its tags changed since the page was loaded); open the page again and choose again",
            ))
            continue
        if duplicate:
            checks.append(Check(
                "collision", BLOCKING, shape.key, f"The shape {shape.label} is in two decisions, and a tag can be mapped only once; keep one of them"
            ))
            continue
        metric = Metric(decision.metric)
        custom = metric is Metric.CUSTOM
        skipped_mapped = skipped_twins = unreadable = 0
        mapped_forms: dict[str, set[str]] = {}  # text of a mapped member -> the stable forms of the addresses mapped under it
        emitted: list[tuple[Member, str, tuple[str, ...], tuple[str, ...]]] = []  # member, text, names, the keys of the names
        unnamed: dict[str, list[str]] = {}
        for member in shape.members:
            text = member_text(member.address, member.name)
            if member.mapped:
                skipped_mapped += 1
                mapped_forms.setdefault(text, set()).add(stable_address(member.address))
                continue
            if member.twin:
                skipped_twins += 1
                continue
            if not readable(member.address):
                unreadable += 1
                continue
            names, problem = derive(text, decision.name_from)
            if problem is not None:
                unnamed.setdefault(problem, []).append(text)
                continue
            emitted.append((member, text, names, tuple(key_of(name) for name in names)))
        for problem, texts in unnamed.items():
            checks.append(Check("name", BLOCKING, shape.key, _unnamed_text(problem, texts, decision.name_from)))
        if unreadable:
            checks.append(Check("address", BLOCKING, shape.key, _unreadable_text(unreadable)))

        # the unit and the scale columns
        unit = ""
        if custom:
            unit = (decision.unit or "").strip()
            if not unit:
                hints = hints_of(shape)
                if len(hints) == 1:
                    unit = hints[0]
                elif hints:
                    checks.append(Check(
                        "custom_unit", BLOCKING, shape.key,
                        f"The tags of this shape have more than one unit ({_listed(hints[:TAGS_NAMED], max(0, len(hints) - TAGS_NAMED))}); "
                        "type the unit this custom metric should use",
                    ))
                else:
                    checks.append(Check(
                        "custom_unit", BLOCKING, shape.key,
                        "A custom metric needs a unit and the tags of this shape name none; type the unit this custom metric should use",
                    ))
        if decision.scale is not None:
            scale = float(decision.scale)
        else:
            scale = float(shape.suggestion.scale) if metric == shape.suggestion.metric else 1.0
        if not custom and emitted:  # the unit of the tags decides the scale (see `_non_custom_scale`); nothing to write, nothing to check
            scale, unit_check = _non_custom_scale(shape, decision, metric)
            if unit_check is not None:
                checks.append(unit_check)
        interval = None if decision.interval_seconds is None else int(decision.interval_seconds)

        # the lines, the elements below the parent and who lands where
        groups: dict[tuple[str, ...], list[tuple[str, str]]] = {}  # key path -> (text, address) of the lines on it
        names_of: dict[tuple[str, ...], tuple[str, ...]] = {}
        mine: set[tuple[str, ...]] = set()
        first_line = len(rows)
        for member, text, names, keys in emitted:
            rows.append(Line(shape.key, member, text, "/".join([*parent, *names]), metric, unit, scale, interval))
            mine.add(keys[:1])
            mine.add(keys)
            groups.setdefault(keys, []).append((text, member.address))
            names_of.setdefault(keys, names)
        elements |= mine
        lines_here = len(emitted)
        by_shape.append({
            "shape": shape.key, "label": shape.label, "lines": lines_here, "assets": len(mine),
            "skipped_mapped": skipped_mapped, "skipped_twins": skipped_twins,
        })
        for line in rows[first_line:first_line + SAMPLES_PER_SHAPE]:
            samples.append({
                "shape": shape.key, "tag": line.text, "address": line.member.address, "asset": line.asset,
                "unit_hint": line.member.unit_hint, "metric": metric.value, "scale": scale,
            })

        # One TAG spelled twice (two numbered addresses with the same stable form: the SCADA renumbered it) is wrong under every metric, a
        # custom one too: it would be mapped twice onto one asset, whatever else lands on that asset. It is found per decision by its
        # stable form, not per asset. Two DIFFERENT tags on one asset and metric (`apart`) are a collision only for a metric that cannot
        # hold two (a custom one holds as many as it is given), and a repeated tag counts there once.
        forms = Counter(stable_address(member.address) for member, _, _, _ in emitted)
        # a tag that is already mapped under its other spelling counts too (a source whose "Stable tag addresses" is off has no twins to
        # leave out); the same name under another stable address is another tag, and the planner judges whether its asset can take it
        repeated: dict[str, str] = {}  # stable form -> the text of each tag that two lines spell, or that is mapped already
        for member, text, _, _ in emitted:
            form = stable_address(member.address)
            if forms[form] > 1 or form in mapped_forms.get(text, ()):
                repeated.setdefault(form, text)
        apart: dict[tuple[str, ...], list[str]] = {}  # key path -> what the lines on it are called, where they are different tags
        apart_texts: dict[tuple[str, ...], list[str]] = {}  # key path -> the texts of those different tags (what "parts 1 and 2" reads)
        if not custom:
            for keys, found in groups.items():
                tags: dict[str, tuple[str, str]] = {}  # stable form -> (text, address) of the first line that spells it
                for text, address in found:
                    tags.setdefault(stable_address(address), (text, address))
                if len(tags) > 1:  # equal texts with different stable addresses are two clusters' tags of one name: told apart by address
                    texts = [text for text, _ in tags.values()]
                    apart[keys] = [address for _, address in tags.values()] if len(set(texts)) == 1 else texts
                    apart_texts[keys] = texts
        renumbered = list(repeated.values())
        if apart:
            # Only what works is advised: "parts 1 and 2" when it names these tags' assets apart (and the list is not over its limit
            # anyway: settled below, once every decision is in), custom when the reading is not a billing one and one unit makes it
            # possible from the page, and the Points page.
            split = decision.name_from == "part1" and _parts12_separates(apart_texts.values())
            can_custom = metric not in _BILLING and len(hints_of(shape)) == 1
            collisions.append((len(checks), apart, names_of, split, can_custom))
            checks.append(Check("collision", BLOCKING, shape.key, _collision_text(apart, names_of, _collision_advice(split, can_custom))))
        if renumbered:
            checks.append(Check("renumbered", BLOCKING, shape.key, _renumbered_text(renumbered)))
        if not custom:
            across = {keys: claims[(keys, metric.value)] for keys in groups if (keys, metric.value) in claims}
            if across:
                keys = next(iter(across))
                label, theirs = across[keys]
                more = "" if len(across) == 1 else f", and {len(across) - 1:,} more assets are the same"
                checks.append(Check(
                    "collision", BLOCKING, shape.key,
                    f"Tags of this shape and of {label} would both land on the same asset as {metric.value} "
                    f"({'/'.join(names_of[keys])} would get {_shown(groups[keys][0][0])} and {_shown(theirs)}){more}; "
                    "change one of the two decisions",
                ))
            for keys, found in groups.items():
                claims.setdefault((keys, metric.value), (shape.label, found[0][0]))
        if lines_here == 0 and not unnamed and not unreadable:
            checks.append(Check(  # a shape has at least two members, so "all" is always plural
                "nothing", WARNING, shape.key,
                f"All {shape.count:,} tags of this shape are already mapped or are the twin of a mapped tag; nothing is left to map",
            ))
        elif lines_here:
            outlier = _outlier_text(shape)
            if outlier is not None:
                checks.append(Check("outlier", WARNING, shape.key, outlier))

    if len(rows) > MAX_ROWS or len(elements) > MAX_NEW_ASSETS:  # a list over its limit is not made right by naming the assets apart
        for index, found_apart, found_names, split, can_custom in collisions:
            if split:
                checks[index] = replace(checks[index], text=_collision_text(found_apart, found_names, _collision_advice(False, can_custom)))
    if len(rows) > MAX_ROWS:
        checks.append(Check("too_many", BLOCKING, None, f"{len(rows):,} tags are chosen; {TOO_MANY}"))
    elif len(elements) > MAX_NEW_ASSETS:  # one sentence is enough: fewer lines fix both
        checks.append(Check(
            "too_many", BLOCKING, None,
            f"These tags would create up to {len(elements):,} new assets, and a tag list creates at most {MAX_NEW_ASSETS:,}; {TOO_MANY}",
        ))
    blocking = any(check.severity == BLOCKING for check in checks)
    csv = ""
    if rows and not blocking:
        csv = HEADER + "\n" + "".join(
            ",".join(_cell(value) for value in (
                line.member.address, line.asset, line.metric.value, line.unit,
                "" if line.scale == 1 else repr(line.scale), "" if line.interval_seconds is None else str(line.interval_seconds),
            )) + "\n"
            for line in rows
        )
    return LinesResult(csv, len(rows), blocking, by_shape, checks, samples, rows, parent)


def planner_checks(result: LinesResult, parsed: ParsedList, problems: Sequence[Problem]) -> list[Check]:
    """The planner's refusals of `result.csv` as blocking `planner` checks: the first PLANNER_SHOWN each with the tag, the derived asset
    and the planner's own reason, then one check that counts the rest. `parsed` is the parse of that same CSV."""
    aligned = len(parsed.rows) == len(result.rows) and all(
        row.values.get("tag") == line.member.address.strip() for row, line in zip(parsed.rows, result.rows, strict=True)
    )  # the parser trims every cell; a tag with a line break in it splits a line and shifts every later number: then no shape is named
    place = {row.line: index for index, row in enumerate(parsed.rows)}
    checks: list[Check] = []
    for problem in problems[:PLANNER_SHOWN]:
        index = place.get(problem.line)
        asset = parsed.rows[index].values.get("asset", "") if index is not None else ""
        shape = result.rows[index].shape if aligned and index is not None else None
        if problem.tag and asset:
            text = f'{problem.tag} would go on "{asset}", but {problem.reason}'
        else:
            text = f"Line {problem.line} of the list: {problem.reason}"
        checks.append(Check("planner", BLOCKING, shape, text))
    if len(problems) > PLANNER_SHOWN:
        checks.append(Check(
            "planner", BLOCKING, None,
            f"{len(problems) - PLANNER_SHOWN:,} more lines are refused as well; fix the ones above and check again",
        ))
    return checks
