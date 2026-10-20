"""The lossless codec of the figure ledger (w26b): a figure value goes into the database as bytes and comes back bit for bit.

The ledger (`figure_ledger`) holds the very values w26's cache holds (`figures.MonthDays`, `figures.WindowValues`) and the Check
month report. An answer served from a stored row must equal, digit for digit, the answer the live path gives on the same data, so
the codec keeps everything an equality test or a JSON response could see:

- a float stays a float and an int stays an int (`1` is not `1.0`), `bool` is not `int`; `-0.0`, `nan` and `inf` come back as they
  went (Python's `json` writes `repr(float)`, which round-trips exactly);
- a tuple comes back a tuple (`WindowValues.values`, `MonthDays.days`) and a list a list;
- a dict keeps its key order (the day entries read `kwh, cost, estimated, partial, no_data`; a different order is a different
  value) and a dict with int keys (`entries`, `own_from`, `values`) is stored as a list of `[key, value]` pairs, in order;
- a datetime is stored as its UTC instant to the microsecond plus the kind of its tzinfo (`timezone.utc`, or a `ZoneInfo` and its
  key) and its `fold`; ANY other tzinfo, a naive datetime, or one that cannot be rebuilt exactly (a wall-clock time that does not
  exist in its zone) is refused with `ValueError`, never stored as something slightly different.

Two things are put in a CANONICAL ORDER on purpose, because their live order is not stable and nothing reads it: the nodes of an
`AssetTree` are stored sorted by id (`AssetTree.load` has no ORDER BY, so its dict order is the table's heap order, which any
UPDATE changes), and a `frozenset` is stored as a sorted list. So `canonical(value)` is the same for two equal values however
they were built, and `canonical(decode(row)) == canonical(live)` is the test that a stored row equals a live value (it tests the
decoder too).

The bytes are canonical JSON (`canonical`): compact separators, ASCII only, no key sorting (key order is part of the value), NaN
and infinities allowed. A value is an object whose first member is a type tag (`"t"`) and whose second is the format number
(`"f"`, `LEDGER_FORMAT`): a `MonthDays` can never be read as a `WindowValues`, and a row written by another format is refused,
not misread. The members of a dataclass are listed in the field order; a decoder refuses any other member list. `encode` is the
zlib stream (level 6) of `canonical`, and the only thing stored. No `pickle`: a row is data, never code.

`figures.py` imports this module (the ledger hook), so `MonthDays` and `WindowValues` are imported lazily, inside the functions
that need them.
"""
import json
import zlib
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from dcdash.core.cost import TariffRow
from dcdash.core.tree import AssetNode, AssetTree

if TYPE_CHECKING:  # the real import is lazy: `figures` imports this module
    from dcdash.core.figures import MonthDays, WindowValues

LEDGER_FORMAT = 1  # bump it with ANY change of the bytes `canonical` writes: an old row is then refused, never misread

_ZLIB_LEVEL = 6
_MONTH_DAYS = "MonthDays"
_WINDOW_VALUES = "WindowValues"
_JSON = "json"
# The members of each object after the tag and the format number, in the order they are written and expected.
_MONTH_DAYS_FIELDS = (
    "config_fp", "tz_name", "start", "end", "tree", "tariffs", "days", "entries", "own", "own_from", "start_utc",
)
_WINDOW_VALUES_FIELDS = ("config_fp", "tz_name", "tree", "tariffs", "values")
_JSON_FIELDS = ("v",)
_SCALARS = (bool, int, float, str)  # exact types: a subclass (numpy.float64, an IntEnum) is not stored as a plain value
_UTC = "u"  # the tzinfo tag of `timezone.utc`; a ZoneInfo is "z:" + its key


# ---- exact scalars ---------------------------------------------------------------------------------------------------------------


def _str(value: Any) -> str:
    if type(value) is not str:
        raise ValueError(f"expected a str, found {type(value).__name__}")
    return value


def _int(value: Any) -> int:
    if type(value) is not int:  # not bool, not an int subclass
        raise ValueError(f"expected an int, found {type(value).__name__}")
    return value


def _opt_int(value: Any) -> int | None:
    return None if value is None else _int(value)


def _scalar(value: Any) -> Any:
    """None, bool, int, float or str, of exactly that type; anything else would not come back as it went."""
    if value is None or type(value) in _SCALARS:
        return value
    raise ValueError(f"cannot store a {type(value).__name__}")


def _list(value: Any) -> list:
    if type(value) is not list:
        raise ValueError(f"expected a list, found {type(value).__name__}")
    return value


def _plain(value: Any) -> Any:
    """A plain JSON-able value (the Check month report): None, bool, int, float, str, list and dict with str keys, nothing else.
    A tuple, a dict with a non-str key or any other type is refused: JSON would turn it into something else."""
    kind = type(value)
    if value is None or kind in _SCALARS:
        return value
    if kind is list:
        return [_plain(item) for item in value]
    if kind is dict:
        return {_str(key): _plain(item) for key, item in value.items()}
    raise ValueError(f"cannot store a {kind.__name__}")


# ---- dates, datetimes ------------------------------------------------------------------------------------------------------------


def _tz_tag(tz: Any) -> str:
    if tz is timezone.utc:
        return _UTC
    if type(tz) is ZoneInfo and tz.key is not None:
        return "z:" + tz.key
    raise ValueError(f"cannot store a datetime with tzinfo {tz!r}: only timezone.utc and a ZoneInfo with a key")


def _enc_dt(value: Any) -> list:
    """[the UTC instant in ISO form, the tzinfo tag, fold]; refuses what it cannot rebuild to the very same datetime."""
    if type(value) is not datetime:  # a date, a pandas Timestamp ... is not one
        raise ValueError(f"expected a datetime, found {type(value).__name__}")
    tag = _tz_tag(value.tzinfo)  # a naive datetime has tzinfo None: refused here
    try:
        instant = value.astimezone(timezone.utc)
    except OverflowError as exc:
        raise ValueError("a datetime too close to the end of time to convert to UTC") from exc
    encoded = [instant.isoformat(), tag, value.fold]
    back = _dec_dt(encoded)
    if (back.replace(tzinfo=None, fold=0), back.fold) != (value.replace(tzinfo=None, fold=0), value.fold):
        raise ValueError(f"the wall-clock time {value!r} cannot be rebuilt from its instant (it does not exist in its zone)")
    return encoded


def _dec_dt(raw: Any) -> datetime:
    if len(_list(raw)) != 3:
        raise ValueError("a datetime is [instant, tzinfo tag, fold]")
    text, tag, fold = raw
    if type(text) is not str or type(tag) is not str or type(fold) is not int or fold not in (0, 1):
        raise ValueError("a datetime is [str, str, 0|1]")
    instant = datetime.fromisoformat(text)
    if instant.utcoffset() != timedelta(0) or instant.isoformat() != text:  # only the form `isoformat` of a UTC instant writes
        raise ValueError(f"not the canonical form of a UTC instant: {text!r}")
    instant = instant.replace(tzinfo=timezone.utc)
    if tag == _UTC:
        return instant.replace(fold=fold)
    if not tag.startswith("z:"):
        raise ValueError(f"unknown tzinfo tag {tag!r}")
    local = instant.astimezone(ZoneInfo(tag[2:]))
    if local.fold != fold:
        raise ValueError(f"the fold {fold} does not belong to the instant {text!r} in {tag[2:]}")
    return local


def _enc_date(value: Any) -> str:
    if type(value) is not date:  # a datetime is a date subclass: not accepted here
        raise ValueError(f"expected a date, found {type(value).__name__}")
    return value.isoformat()


def _dec_date(raw: Any) -> date:
    text = _str(raw)
    value = date.fromisoformat(text)
    if value.isoformat() != text:
        raise ValueError(f"not the canonical form of a date: {text!r}")
    return value


# ---- the parts of a value ----------------------------------------------------------------------------------------------------------


def _enc_tree(tree: Any) -> list:
    """[id, parent id, name, sort order] per node, SORTED BY ID: the live dict order is the table's heap order (see the module
    docstring); nothing iterates `tree.nodes` for output, and the tree rebuilds its children and roots in a total order."""
    if type(tree) is not AssetTree:
        raise ValueError(f"expected an AssetTree, found {type(tree).__name__}")
    ids = [_int(node_id) for node_id in tree.nodes]
    rows = []
    for node_id in sorted(ids):
        node = tree.nodes[node_id]
        if type(node) is not AssetNode or _int(node.id) != node_id:
            raise ValueError(f"asset {node_id}: not a node of its own id")
        rows.append([node_id, _opt_int(node.parent_id), _str(node.name), _int(node.sort_order)])
    return rows


def _dec_tree(raw: Any) -> AssetTree:
    nodes = []
    for row in _list(raw):
        if len(_list(row)) != 4:
            raise ValueError("a tree node is [id, parent id, name, sort order]")
        nodes.append(AssetNode(_int(row[0]), _opt_int(row[1]), _str(row[2]), _int(row[3])))
    tree = AssetTree(nodes)
    if len(tree.nodes) != len(nodes):
        raise ValueError("a tree with an asset id twice")
    return tree


def _enc_tariffs(tariffs: Any) -> list:
    rows = []
    for row in _list(tariffs):
        if type(row) is not TariffRow:
            raise ValueError(f"expected a TariffRow, found {type(row).__name__}")
        rows.append([_opt_int(row.asset_id), _scalar(row.rate_per_kwh), _enc_date(row.effective_from)])  # the list order is kept
    return rows


def _dec_tariffs(raw: Any) -> list[TariffRow]:
    rows = []
    for row in _list(raw):
        if len(_list(row)) != 3:
            raise ValueError("a tariff is [asset id, rate, effective from]")
        rows.append(TariffRow(_opt_int(row[0]), _scalar(row[1]), _dec_date(row[2])))
    return rows


def _enc_pairs(mapping: Any, enc: Callable[[Any], Any]) -> list:
    """A dict with int keys as [[key, value], ...] in its insertion order (JSON keys are strings)."""
    if type(mapping) is not dict:
        raise ValueError(f"expected a dict, found {type(mapping).__name__}")
    return [[_int(key), enc(value)] for key, value in mapping.items()]


def _dec_pairs(raw: Any, dec: Callable[[Any], Any]) -> dict:
    out: dict = {}
    for pair in _list(raw):
        if len(_list(pair)) != 2:
            raise ValueError("a pair is [key, value]")
        key = _int(pair[0])
        if key in out:
            raise ValueError(f"the key {key} twice")
        out[key] = dec(pair[1])
    return out


def _entry(value: Any) -> dict | None:
    """One day entry: None, or a dict of scalars whose key order is kept (it is the order the JSON of Billing is written in)."""
    if value is None:
        return None
    if type(value) is not dict:
        raise ValueError(f"expected a day entry, found {type(value).__name__}")
    return {_str(key): _scalar(item) for key, item in value.items()}


def _entries(value: Any) -> list[dict | None]:
    return [_entry(item) for item in _list(value)]


def _enc_ints(value: Any) -> list[int]:
    """A frozenset of ints as a sorted list (its iteration order depends on how it was built)."""
    if type(value) is not frozenset:
        raise ValueError(f"expected a frozenset, found {type(value).__name__}")
    return sorted(_int(item) for item in value)


def _dec_ints(raw: Any) -> frozenset[int]:
    items = [_int(item) for item in _list(raw)]
    out = frozenset(items)
    if len(out) != len(items):
        raise ValueError("a set with a member twice")
    return out


def _enc_days(days: Any) -> list:
    rows = []
    for day in _list(days):
        if type(day) is not tuple or len(day) != 3:
            raise ValueError("a local day is a tuple (date, from, to)")
        rows.append([_enc_date(day[0]), _enc_dt(day[1]), _enc_dt(day[2])])
    return rows


def _dec_days(raw: Any) -> list[tuple[date, datetime, datetime]]:
    days = []
    for row in _list(raw):
        if len(_list(row)) != 3:
            raise ValueError("a local day is [date, from, to]")
        days.append((_dec_date(row[0]), _dec_dt(row[1]), _dec_dt(row[2])))
    return days


def _enc_figure(value: Any) -> list | None:
    """The (value, estimated, partial, no_data) tuple of one asset, or None: the engine has no figure for it."""
    if value is None:
        return None
    if type(value) is not tuple or len(value) != 4:
        raise ValueError("a figure is a tuple of four, or None")
    return [_scalar(item) for item in value]


def _dec_figure(raw: Any) -> tuple | None:
    if raw is None:
        return None
    if len(_list(raw)) != 4:
        raise ValueError("a figure is four members, or null")
    return tuple(_scalar(item) for item in raw)


# ---- the values --------------------------------------------------------------------------------------------------------------------


def _month_days_object(md: "MonthDays") -> dict:
    return {
        "t": _MONTH_DAYS, "f": LEDGER_FORMAT,
        "config_fp": _str(md.config_fp), "tz_name": _str(md.tz_name),
        "start": _enc_dt(md.start), "end": _enc_dt(md.end),
        "tree": _enc_tree(md.tree), "tariffs": _enc_tariffs(md.tariffs), "days": _enc_days(md.days),
        "entries": _enc_pairs(md.entries, _entries),
        "own": _enc_ints(md.own), "own_from": _enc_pairs(md.own_from, _enc_dt),
        "start_utc": _enc_dt(md.start_utc),
    }


def _window_values_object(wv: "WindowValues") -> dict:
    return {
        "t": _WINDOW_VALUES, "f": LEDGER_FORMAT,
        "config_fp": _str(wv.config_fp), "tz_name": _str(wv.tz_name),
        "tree": _enc_tree(wv.tree), "tariffs": _enc_tariffs(wv.tariffs),
        "values": _enc_pairs(wv.values, _enc_figure),
    }


def canonical(value: "MonthDays | WindowValues | dict") -> bytes:
    """The uncompressed canonical JSON of `value`: the bytes two equal values share and a stored row is compared by. Raises
    ValueError for anything it cannot keep exactly (see the module docstring)."""
    from dcdash.core import figures

    kind = type(value)
    if kind is figures.MonthDays:
        obj = _month_days_object(value)
    elif kind is figures.WindowValues:
        obj = _window_values_object(value)
    elif kind is dict:
        obj = {"t": _JSON, "f": LEDGER_FORMAT, "v": _plain(value)}
    else:
        raise ValueError(f"the ledger cannot hold a {kind.__name__}")
    # No sort_keys: the key order of a day entry and of the report is part of the value.
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=True, allow_nan=True).encode("ascii")


def encode(value: "MonthDays | WindowValues | dict") -> bytes:
    """What the ledger stores: the zlib stream (level 6) of `canonical(value)`."""
    return zlib.compress(canonical(value), _ZLIB_LEVEL)


def _load(raw: bytes, tag: str, fields: tuple[str, ...]) -> dict:
    """Inflate and parse `raw`, and check it is a complete zlib stream holding the object of this tag, this format number and
    exactly these members. ValueError, or zlib.error for bytes that are not zlib at all."""
    inflater = zlib.decompressobj()
    text = inflater.decompress(raw)  # zlib.error on garbage
    if not inflater.eof or inflater.unused_data:
        raise ValueError("not exactly one complete zlib stream")
    try:
        obj = json.loads(text.decode("ascii"))  # JSONDecodeError and UnicodeDecodeError are ValueErrors
    except RecursionError as exc:
        raise ValueError("nested too deep") from exc
    if type(obj) is not dict or list(obj)[:2] != ["t", "f"]:
        raise ValueError("not a ledger value")
    if obj["t"] != tag:
        raise ValueError(f"a {obj['t']!r} where a {tag!r} was expected")
    if type(obj["f"]) is not int or obj["f"] != LEDGER_FORMAT:
        raise ValueError(f"ledger format {obj['f']!r}, this build reads {LEDGER_FORMAT}")
    if list(obj)[2:] != list(fields):
        raise ValueError("the members of the value are not the ones of this format")
    return obj


def _build(make: Callable[[dict], Any], obj: dict) -> Any:
    """`make(obj)`, with every way a malformed member can fail raised as ValueError (the caller catches ValueError, zlib.error)."""
    try:
        return make(obj)
    except (KeyError, TypeError, IndexError, AttributeError, OverflowError, OSError) as exc:
        raise ValueError(f"unusable ledger value: {exc!r}") from exc


def decode_month_days(raw: bytes) -> "MonthDays":
    """The `MonthDays` that `encode` made `raw` from. ValueError or zlib.error for anything else."""
    from dcdash.core import figures

    return _build(
        lambda obj: figures.MonthDays(
            config_fp=_str(obj["config_fp"]), tz_name=_str(obj["tz_name"]),
            start=_dec_dt(obj["start"]), end=_dec_dt(obj["end"]),
            tree=_dec_tree(obj["tree"]), tariffs=_dec_tariffs(obj["tariffs"]), days=_dec_days(obj["days"]),
            entries=_dec_pairs(obj["entries"], _entries),
            own=_dec_ints(obj["own"]), own_from=_dec_pairs(obj["own_from"], _dec_dt),
            start_utc=_dec_dt(obj["start_utc"]),
        ),
        _load(raw, _MONTH_DAYS, _MONTH_DAYS_FIELDS),
    )


def decode_window_values(raw: bytes) -> "WindowValues":
    """The `WindowValues` that `encode` made `raw` from. ValueError or zlib.error for anything else."""
    from dcdash.core import figures

    return _build(
        lambda obj: figures.WindowValues(
            config_fp=_str(obj["config_fp"]), tz_name=_str(obj["tz_name"]),
            tree=_dec_tree(obj["tree"]), tariffs=_dec_tariffs(obj["tariffs"]),
            values=_dec_pairs(obj["values"], _dec_figure),
        ),
        _load(raw, _WINDOW_VALUES, _WINDOW_VALUES_FIELDS),
    )


def decode_json(raw: bytes) -> dict:
    """The plain dict (the Check month report) that `encode` made `raw` from. ValueError or zlib.error for anything else."""

    def make(obj: dict) -> dict:
        if type(obj["v"]) is not dict:
            raise ValueError("not a dict")
        return obj["v"]

    return _build(make, _load(raw, _JSON, _JSON_FIELDS))
