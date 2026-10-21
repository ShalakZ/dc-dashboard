"""A tag list (w31): which tag goes to which asset as which metric, read from a CSV and turned into a PLAN. Pure: no database,
no FastAPI. The route (api/tag_lists.py) reads the rows this module asks for, calls `plan` and writes what the plan says; the
dry run and the real run call the same functions, so what a person was shown is what the real run would create.

The file: a header line naming at least `tag`, `asset` and `metric` (case does not matter; `unit`, `scale`, `interval_seconds`,
`kind` and `reading` are optional; any other column is ignored), then one line per tag. `asset` is a path written
`Hall 1 / Row A / Rack 01`; each part is a name among its siblings. `kind` is the kind of the asset the line points at, and only
for an asset the run creates (an asset that exists is left as it is; the parts above a created asset are `generic`).
`interval_seconds` is the mapping's polling interval, and the metric's default when it is left out, except on a `file` source (never
polled): there it is the spacing of the export, and an `active_power_kw` line must give it.

Everything a person can get wrong becomes a PROBLEM with its line number, in file order, and a list with any problem creates
nothing (the route enforces that; this module only reports). One line gives at most one problem: the first thing wrong with it.
Hostile input is data: a tag or an asset name is text and nothing else (a name that starts with `=` is stored as text, and the
existing asset rules allow it), no value of the file is ever a path, a format string or a query."""
import csv
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass, replace

from dcdash.core.metrics import MAX_SCALE, Metric, default_interval, unit_for
from dcdash.ingest.normalise import NormaliseError, refuse_interval_as_energy, scale_for

MAX_BYTES = 1024 * 1024  # a larger body is refused before it is read to the end (413)
MAX_ROWS = 1000  # data lines; the audit row of a run keeps one entry per mapping, so this bounds it
MAX_LINE_BYTES = 1024
MAX_COLUMNS = 12
MAX_TAG = 500
MAX_SEGMENT = 100  # the length the asset rules allow (api/asset_names.py AssetName)
MAX_DEPTH = 8
MAX_NEW_ASSETS = 1000
MAX_KIND = 60  # core/asset_kinds.py MAX_NAME
MAX_UNIT = 20  # api/discovery.py MAX_UNIT_LENGTH
MAX_INTERVAL = 31 * 86_400  # a mapping's interval is a 32-bit integer in the database; a month is far beyond any real poll
ECHO = 80  # characters of a cell a report repeats

REQUIRED = ("tag", "asset", "metric")
KNOWN = (*REQUIRED, "unit", "scale", "interval_seconds", "kind", "reading")
DELIMITERS = (",", ";", "\t")
READINGS = ("counter", "power", "interval")
GENERIC = "generic"

# ASCII digits only: float() and int() also read the digits of other scripts.
_NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_WHOLE = re.compile(r"[0-9]+")
_SAVE_AS_UTF8 = "save the file as CSV UTF-8 and try again"


class TagListRefused(Exception):
    """The file as a whole is refused (not one line): `status` is the HTTP status, the message a plain sentence."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


class _Bad(Exception):
    """One line's problem (the sentence goes with the line number into the report)."""


@dataclass(frozen=True)
class Row:
    line: int  # the physical line of the file (1 = the first line, the header usually)
    values: Mapping[str, str]  # the known columns, stripped; a column the file lacks or a missing cell is ""
    error: str | None = None  # the line itself is malformed (unbalanced quotes, too many cells)


@dataclass(frozen=True)
class ParsedList:
    rows: tuple[Row, ...]
    sha256: str
    delimiter: str


def echo(text: str) -> str:
    """A cell as a report repeats it: at most ECHO characters, anything unprintable shown as `?`."""
    return "".join(char if char.isprintable() else "?" for char in text)[:ECHO]


def _cells(line: str, delimiter: str) -> list[str] | None:
    """The cells of one line (a record never spans lines), or None when its quotes do not balance."""
    if '"' not in line:
        return line.split(delimiter)
    try:
        return next(csv.reader([line], delimiter=delimiter, strict=True))
    except (csv.Error, StopIteration):
        return None


def parse_tag_list(raw: bytes) -> ParsedList:
    """The rows of a tag list. Raises TagListRefused (with a sentence) for a file that cannot be read at all."""
    if len(raw) > MAX_BYTES:
        raise TagListRefused(f"the list is larger than {MAX_BYTES // (1024 * 1024)} MB; split it into smaller lists", 413)
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise TagListRefused(f"the file is UTF-16; {_SAVE_AS_UTF8}")
    if b"\x00" in raw:
        raise TagListRefused(f"the file contains NUL bytes (is it UTF-16 or not a text file?); {_SAVE_AS_UTF8}")
    body = raw[3:] if raw.startswith(b"\xef\xbb\xbf") else raw
    lines: list[tuple[int, str]] = []
    for number, chunk in enumerate(body.split(b"\n"), start=1):  # split on the byte, so line numbers are the editor's
        chunk = chunk[:-1] if chunk.endswith(b"\r") else chunk
        if len(chunk) > MAX_LINE_BYTES:
            raise TagListRefused(f"line {number} is longer than {MAX_LINE_BYTES:,} bytes; a tag list has one short line per tag")
        try:
            text = chunk.decode("utf-8")
        except UnicodeDecodeError:
            raise TagListRefused(f"line {number} is not valid UTF-8; {_SAVE_AS_UTF8}") from None
        if text.strip():
            lines.append((number, text))
    if not lines:
        raise TagListRefused("the list is empty: the first line must name the columns tag, asset and metric")
    delimiter, columns, width = _header(lines[0][1])
    data = lines[1:]
    if not data:
        raise TagListRefused("the list has a header but no tags")
    if len(data) > MAX_ROWS:
        raise TagListRefused(f"the list has {len(data):,} lines; a list holds at most {MAX_ROWS:,}: split it into smaller lists")
    rows = tuple(_row(number, text, delimiter, columns, width) for number, text in data)
    return ParsedList(rows, hashlib.sha256(raw).hexdigest(), delimiter)


def _header(line: str) -> tuple[str, dict[str, int], int]:
    """(the delimiter, known column name -> its index, how many columns the header has). The delimiter is the first of , ; tab
    under which the header names the required columns."""
    best: tuple[int, list[str]] | None = None
    for delimiter in DELIMITERS:
        cells = _cells(line, delimiter)
        if cells is None:
            continue
        names = [cell.strip().casefold() for cell in cells]
        if all(name in names for name in REQUIRED):
            return delimiter, _columns(names), len(names)
        score = sum(name in KNOWN for name in names)
        if best is None or score > best[0]:
            best = (score, names)
    if best is None or best[0] == 0:
        raise TagListRefused("the first line must name the columns tag, asset and metric (separated by commas, semicolons or tabs)")
    missing = ", ".join(name for name in REQUIRED if name not in best[1])
    raise TagListRefused(f"the first line has no column called {missing}; it must name tag, asset and metric")


def _columns(names: list[str]) -> dict[str, int]:
    if len(names) > MAX_COLUMNS:
        raise TagListRefused(f"the header has {len(names)} columns; a tag list has at most {MAX_COLUMNS}")
    seen: set[str] = set()
    for name in names:
        if name and name in seen:
            raise TagListRefused(f'the column "{echo(name)}" appears twice in the header')
        seen.add(name)
    return {name: index for index, name in enumerate(names) if name in KNOWN}


def _row(line: int, text: str, delimiter: str, columns: dict[str, int], width: int) -> Row:
    cells = _cells(text, delimiter)
    if cells is None:
        return Row(line, {}, "the quotes in this line do not balance")
    if any(cell.strip() for cell in cells[width:]):  # a trailing delimiter leaves an empty surplus cell; anything else is a mistake
        return Row(line, {}, f"this line has more cells than the header has columns ({width})")
    return Row(line, {name: cells[index].strip() if index < len(cells) else "" for name, index in columns.items()})


@dataclass(frozen=True)
class AssetIndex:
    """The assets that exist, by (parent id or None, name key). The key is the database's own (api/asset_names.py `_KEY`)."""

    by_parent_and_key: Mapping[tuple[int | None, str], tuple[int, ...]]

    @classmethod
    def build(cls, rows: Iterable[tuple[int, int | None, str]]) -> "AssetIndex":
        found: dict[tuple[int | None, str], list[int]] = defaultdict(list)
        for asset_id, parent_id, key in rows:
            found[(parent_id, key)].append(asset_id)
        return cls({place: tuple(ids) for place, ids in found.items()})

    def children(self, parent_id: int | None, key: str) -> tuple[int, ...]:
        return self.by_parent_and_key.get((parent_id, key), ())


def _segments(path: str) -> list[str]:
    """The parts of an asset path, trimmed. Raises _Bad for a path the asset rules cannot take."""
    if not path:
        raise _Bad("no asset")
    parts = [part.strip() for part in path.split("/")]
    if any(not part for part in parts):
        raise _Bad("the asset path has an empty part (a leading, trailing or doubled /)")
    if len(parts) > MAX_DEPTH:
        raise _Bad(f"the asset path is {len(parts)} levels deep; at most {MAX_DEPTH}")
    if any(len(part) > MAX_SEGMENT for part in parts):
        raise _Bad(f"a part of the asset path is longer than {MAX_SEGMENT} characters")
    if not all(part.isprintable() for part in parts):
        raise _Bad("the asset path contains control or invisible characters")
    return parts


def segments_of(parsed: ParsedList) -> list[str]:
    """Every distinct part of every well-formed asset path, in file order: what the route asks the database to normalise."""
    found: dict[str, None] = {}
    for row in parsed.rows:
        if row.error is not None:
            continue
        try:
            for part in _segments(row.values.get("asset", "")):
                found[part] = None
        except _Bad:
            continue
    return list(found)


def _walk(keys: tuple[str, ...], index: AssetIndex) -> tuple[int | None, int, bool]:
    """(the deepest existing asset on the path, how many parts of the path exist, whether two assets answer to one part)."""
    parent: int | None = None
    for depth, key in enumerate(keys):
        found = index.children(parent, key)
        if not found:
            return parent, depth, False
        if len(found) > 1:
            return parent, depth, True
        parent = found[0]
    return parent, len(keys), False


def touched(
    parsed: ParsedList, index: AssetIndex, seg_keys: Mapping[str, str], points: Mapping[str, int]
) -> tuple[set[int], set[int]]:
    """(the existing points, the existing assets) this list may write to or under: what the route locks and whose mappings it
    reads. A malformed line contributes nothing."""
    point_ids: set[int] = set()
    asset_ids: set[int] = set()
    for row in parsed.rows:
        if row.error is not None:
            continue
        point = points.get(row.values.get("tag", ""))
        if point is not None:
            point_ids.add(point)
        try:
            parts = _segments(row.values.get("asset", ""))
        except _Bad:
            continue
        deepest, _depth, _ambiguous = _walk(tuple(seg_keys[part] for part in parts), index)
        if deepest is not None:
            asset_ids.add(deepest)
    return point_ids, asset_ids


@dataclass(frozen=True)
class PlannedPoint:
    address: str
    unit_hint: str | None


@dataclass(frozen=True)
class PlannedAsset:
    path: tuple[str, ...]  # the keys of every part, from the top: the identity of the asset among the ones this run creates
    name: str  # as the first line that named it wrote it
    kind: str
    parent_id: int | None  # the existing parent (None = top level) when `parent_path` is None
    parent_path: tuple[str, ...] | None  # the planned parent, when that is another asset this run creates
    label: str  # the whole path as the first line that named it wrote it, `Hall 1 / Row A`: what a report lists

    @property
    def depth(self) -> int:
        return len(self.path)


@dataclass(frozen=True)
class PlannedMapping:
    line: int
    tag: str
    point_id: int | None  # None: the point is one this run creates
    asset_id: int | None  # None: the asset is one this run creates
    asset_path: tuple[str, ...]
    metric: str
    scale: float
    interval_seconds: int
    custom_unit: str | None
    unit: str  # as the units table shows it: the unit written, else the metric's base unit


@dataclass(frozen=True)
class Problem:
    line: int
    tag: str
    reason: str


@dataclass(frozen=True)
class Plan:
    points: tuple[PlannedPoint, ...]
    assets: tuple[PlannedAsset, ...]  # parents before children
    mappings: tuple[PlannedMapping, ...]
    problems: tuple[Problem, ...]
    digest: str
    units: tuple[dict[str, object], ...]

    @property
    def ok(self) -> bool:
        return not self.problems


def _number(text: str, what: str) -> float:
    if not _NUMBER.fullmatch(text):
        raise _Bad(f'the {what} "{echo(text)}" is not a number')
    value = float(text)
    if not math.isfinite(value) or not 0 < value <= MAX_SCALE:
        raise _Bad(f"the {what} must be greater than zero and at most {MAX_SCALE:g}")
    return value


def _same_kind(a: str, b: str) -> bool:
    # The registry's own comparison is core/asset_kinds.kind_key; that module needs FastAPI, which this one does not.
    return " ".join(a.split()).casefold() == " ".join(b.split()).casefold()


class _Planner:
    """The state of one `plan` call: what the lines accepted so far have asked for."""

    def __init__(
        self, connector_type: str, create_assets: bool, index: AssetIndex, points: Mapping[str, int],
        seg_keys: Mapping[str, str], mapped_points: Collection[int], asset_metrics: Collection[tuple[int, str]],
    ):
        self.connector_type, self.create_assets, self.index, self.points = connector_type, create_assets, index, points
        self.seg_keys, self.mapped_points, self.asset_metrics = seg_keys, mapped_points, asset_metrics
        self.new_points: list[PlannedPoint] = []
        self.new_assets: dict[tuple[str, ...], PlannedAsset] = {}
        self.kinds: dict[tuple[str, ...], tuple[str, int]] = {}  # new asset -> (the kind a line wrote, that line)
        self.mappings: list[PlannedMapping] = []
        self.tag_lines: dict[str, int] = {}
        self.pair_lines: dict[tuple[tuple[str, ...], str], int] = {}

    def add(self, row: Row) -> None:
        """Check one line against the file so far and the database as read; accept it into the plan or raise _Bad."""
        if row.error is not None:
            raise _Bad(row.error)
        values = row.values
        tag = self._tag(row)
        metric = self._metric(values["metric"])
        reading = values.get("reading", "").casefold()
        if reading and reading not in READINGS:
            raise _Bad(f'the reading "{echo(reading)}" is not known; use counter, power or interval')
        try:
            refuse_interval_as_energy(reading or "counter", metric.value)
        except NormaliseError as refused:
            raise _Bad(str(refused)) from None
        if reading == "interval" and metric is not Metric.CUSTOM:  # the importer refuses every row of such a point (importer.point_info)
            raise _Bad(
                f"an interval tag (energy per period) cannot be mapped as {metric.value}: its figures would read each period's energy "
                "as a reading of that metric; map it as custom, or give the reading counter or power"
            )
        scale, custom_unit, shown, unit = self._scale(metric, values.get("unit", ""), values.get("scale", ""))
        interval = self._interval(metric, values.get("interval_seconds", ""))
        parts = _segments(values["asset"])
        keys = tuple(self.seg_keys[part] for part in parts)
        deepest, matched, ambiguous = _walk(keys, self.index)
        if ambiguous:
            raise _Bad(f'two assets named "{echo(parts[matched])}" already sit at this place; rename one of them first')
        chain: list[PlannedAsset] = []
        leaf_new = matched < len(keys)
        if leaf_new:
            if not self.create_assets:
                raise _Bad(f'the asset "{echo(" / ".join(parts))}" does not exist; tick "Create missing assets" or create it first')
            for depth in range(matched, len(keys)):
                if keys[: depth + 1] in self.new_assets:  # an earlier line made it
                    continue
                first = depth == matched
                chain.append(
                    PlannedAsset(
                        keys[: depth + 1], parts[depth], GENERIC, deepest if first else None, None if first else keys[:depth],
                        " / ".join(parts[: depth + 1]),
                    )
                )
            if len(self.new_assets) + len(chain) > MAX_NEW_ASSETS:
                raise _Bad(f"a list creates at most {MAX_NEW_ASSETS:,} assets; split it into smaller lists")
        kind = self._kind(values.get("kind", ""), keys, leaf_new)
        point_id = self.points.get(tag)
        point: PlannedPoint | None = None
        if point_id is None:
            if self.connector_type != "file":
                raise _Bad("no point with this address on this source: run Browse first")
            point = PlannedPoint(tag, unit or None)
        elif point_id in self.mapped_points:
            raise _Bad("this point is already mapped")
        asset_id = None if leaf_new else deepest
        if metric is not Metric.CUSTOM:
            if asset_id is not None and (asset_id, metric.value) in self.asset_metrics:
                raise _Bad(f'the asset "{echo(parts[-1])}" already has a mapping for {metric.value}')
            earlier = self.pair_lines.get((keys, metric.value))
            if earlier is not None:
                raise _Bad(f"line {earlier} already maps {metric.value} to this asset")
        # Accepted: from here on nothing can fail, so the plan never holds the leftovers of a refused line.
        if point is not None:
            self.new_points.append(point)
        for planned in chain:
            self.new_assets[planned.path] = planned
        if kind and leaf_new:
            self.kinds.setdefault(keys, (kind, row.line))
        if metric is not Metric.CUSTOM:
            self.pair_lines[(keys, metric.value)] = row.line
        self.mappings.append(
            PlannedMapping(row.line, tag, point_id, asset_id, keys, metric.value, scale, interval, custom_unit, shown)
        )

    def _tag(self, row: Row) -> str:
        tag = row.values["tag"]
        if not tag:
            raise _Bad("no tag")
        if len(tag) > MAX_TAG:
            raise _Bad(f"the tag is longer than {MAX_TAG} characters")
        if not tag.isprintable():
            raise _Bad("the tag contains control or invisible characters")
        first = self.tag_lines.setdefault(tag, row.line)  # every line counts, also one that is refused below
        if first != row.line:
            raise _Bad(f"this tag is already on line {first}")
        return tag

    @staticmethod
    def _metric(text: str) -> Metric:
        if not text:
            raise _Bad("no metric")
        try:
            return Metric(text.casefold())
        except ValueError:
            raise _Bad(f'the metric "{echo(text)}" is not known; use one of {", ".join(m.value for m in Metric)}') from None

    @staticmethod
    def _scale(metric: Metric, unit: str, scale_text: str) -> tuple[float, str | None, str, str]:
        """(the scale, the custom unit, what the units table shows, the unit as written)."""
        if unit and (len(unit) > MAX_UNIT or not unit.isprintable()):
            raise _Bad(f"the unit must be printable text of at most {MAX_UNIT} characters")
        given = _number(scale_text, "scale") if scale_text else None
        if metric is Metric.CUSTOM:
            if not unit:
                raise _Bad("a custom metric needs a unit")
            return (1.0 if given is None else given), unit, unit, unit
        from_unit = None
        if unit:
            try:
                from_unit = scale_for(unit, metric.value)
            except NormaliseError as refused:
                raise _Bad(str(refused)) from None
        if given is not None and from_unit is not None and not math.isclose(given, from_unit, rel_tol=1e-9):
            raise _Bad(f'the unit "{unit}" means a scale of {from_unit:g}, but the scale column says {given:g}')
        scale = given if given is not None else from_unit if from_unit is not None else 1.0
        return scale, None, unit or unit_for(metric, None), unit

    def _interval(self, metric: Metric, text: str) -> int:
        if not text:
            # A file source is never polled, so the metric's default (its poll interval) means nothing there, and for power it is
            # wrong: the figure engine turns a power reading into energy by the spacing of its samples (core/energy.py power_hours),
            # so an hourly export mapped at 5 seconds would give 1/60 of its energy, silently. The file's own spacing is needed.
            if self.connector_type == "file" and metric is Metric.ACTIVE_POWER_KW:
                raise _Bad(
                    "give interval_seconds: the spacing of the export in seconds (3600 for an hourly file), because a power "
                    "reading is turned into energy by its spacing"
                )
            return default_interval(metric)
        if not _WHOLE.fullmatch(text) or not 1 <= int(text) <= MAX_INTERVAL:
            raise _Bad(f'interval_seconds "{echo(text)}" is not a whole number of seconds from 1 to {MAX_INTERVAL}')
        return int(text)

    def _kind(self, kind: str, keys: tuple[str, ...], leaf_new: bool) -> str:
        if not kind:
            return ""
        if len(kind) > MAX_KIND or not kind.isprintable():
            raise _Bad(f"the kind must be printable text of at most {MAX_KIND} characters")
        if leaf_new:
            earlier = self.kinds.get(keys)
            if earlier is not None and not _same_kind(earlier[0], kind):
                raise _Bad(f'this asset is given the kind "{echo(earlier[0])}" on line {earlier[1]} and "{echo(kind)}" here')
        return kind


def plan(
    parsed: ParsedList,
    *,
    connector_type: str,
    create_assets: bool,
    index: AssetIndex,
    points: Mapping[str, int],
    seg_keys: Mapping[str, str],
    mapped_points: Collection[int],
    asset_metrics: Collection[tuple[int, str]],
) -> Plan:
    """What the list would create, and what is wrong with it. The same inputs give the same plan, and the digest does not depend
    on the order of the lines, except where two lines spell one new asset differently (the first line's spelling is the one written,
    so the order then decides what is written, and the digest follows).

    `points`: address -> id of the points of THE chosen source. `seg_keys`: part text -> the database's key for it.
    `mapped_points`: ids of points that already have a mapping. `asset_metrics`: (asset id, metric) pairs that exist."""
    planner = _Planner(connector_type, create_assets, index, points, seg_keys, mapped_points, asset_metrics)
    problems: list[Problem] = []
    for row in parsed.rows:
        try:
            planner.add(row)
        except _Bad as bad:
            problems.append(Problem(row.line, echo(row.values.get("tag", "")), str(bad)))
    assets = tuple(  # insertion order: a line registers a parent before its child
        replace(a, kind=planner.kinds[a.path][0]) if a.path in planner.kinds else a for a in planner.new_assets.values()
    )
    return Plan(
        tuple(planner.new_points), assets, tuple(planner.mappings), tuple(problems),
        _digest(planner.new_points, assets, planner.mappings), _units(planner.mappings),
    )


def _digest(points: Iterable[PlannedPoint], assets: Iterable[PlannedAsset], mappings: Iterable[PlannedMapping]) -> str:
    """A SHA-256 of what would be written, in an order that does not depend on the order of the lines. The ids of the existing
    points and assets are part of it: a list that now lands on other rows is another plan, even when the names read the same. So is
    the spelling of a new asset's name (`path` holds only its comparison key, and `HALL 1` and `Hall 1` are one key): the person is
    shown the names that will be written, so another spelling is another plan."""
    body = {
        "points": sorted((p.address, p.unit_hint or "") for p in points),
        "assets": sorted([list(a.path), a.kind, a.name] for a in assets),
        "mappings": sorted(
            [m.tag, list(m.asset_path), m.point_id, m.asset_id, m.metric, m.scale, m.interval_seconds, m.custom_unit]
            for m in mappings
        ),
    }
    return hashlib.sha256(json.dumps(body, separators=(",", ":"), sort_keys=True).encode()).hexdigest()


def _units(mappings: Iterable[PlannedMapping]) -> tuple[dict[str, object], ...]:
    counts = Counter((m.metric, m.scale, m.unit) for m in mappings)
    return tuple({"unit": unit, "metric": metric, "scale": scale, "count": n} for (metric, scale, unit), n in sorted(counts.items()))


def describe(plan_: Plan, *, done: bool) -> str:
    """One sentence for the report: what would be (or was) created, or why nothing will be."""
    if plan_.problems:
        n = len(plan_.problems)
        return f"{n} line{'s' if n != 1 else ''} to fix; nothing is created until the list has no problems"
    parts = [
        f"{len(plan_.mappings):,} mapping{'s' if len(plan_.mappings) != 1 else ''}",
        f"{len(plan_.assets):,} asset{'s' if len(plan_.assets) != 1 else ''}",
        f"{len(plan_.points):,} point{'s' if len(plan_.points) != 1 else ''}",
    ]
    return f"{'Created' if done else 'Would create'} {parts[0]}, {parts[1]} and {parts[2]}"
