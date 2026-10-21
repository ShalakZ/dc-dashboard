"""Shared pieces of the importer tests (w31): a profile, a parse of a few lines without a database, and a world of points to import into."""
from datetime import UTC, datetime

from dcdash.ingest import importer
from dcdash.ingest.import_profile import ImportProfile
from helpers import make_asset, make_mapping, make_point, make_source

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)
HEADER = "tag,timestamp,value,unit,quality"


def make_profile(**over) -> ImportProfile:
    fields = {"name": "hourly", "tag": "tag", "time": "timestamp", "value": "value", "unit": "unit", "quality": "quality", **over}
    return ImportProfile.model_validate(fields)


def scan_of(*lines: str, header: str = HEADER) -> importer.PreScan:
    return importer.pre_scan("\n".join([header, *lines]).encode() + b"\n")


# Points a parse test names: a power point, an energy counter, a counter in Wh, a point nothing is mapped to, a custom metric, and a
# counter with a CT-ratio scale that no unit spelling gives.
POINTS = {
    "P.kW": importer.point_info(1, "active_power_kw", 1.0, "counter"),
    "P.kWh": importer.point_info(2, "energy_kwh", 1.0, "counter"),
    "P.Wh": importer.point_info(3, "energy_kwh", 0.001, "counter"),
    "P.raw": importer.point_info(4, None, None, "counter"),
    "P.custom": importer.point_info(5, "custom", 1.0, "counter"),
    "P.ct": importer.point_info(6, "energy_kwh", 60.0, "counter"),
}


def points_for(reading: str) -> dict:
    """POINTS as the run builds them for a profile of this `reading` (an interval profile marks the cumulative-energy ones)."""
    return {tag: importer.point_info(info.point_id, info.metric, info.scale, reading) for tag, info in POINTS.items()}


def parse(lines, *, points=None, profile=None, now=NOW, retention=30, closed=frozenset(), site_zone=None, last=None, header=HEADER):
    """`parse_chunk` over `lines` (the text of the data lines) with a profile and a map of points, no database."""
    profile = profile or make_profile()
    scan = scan_of(*lines, header=header)
    layout = importer.resolve_layout(scan, profile)
    ctx = importer.ParseContext(layout, profile, POINTS if points is None else points, now, retention, closed, site_zone)
    return importer.parse_chunk(scan.header + 2, scan.lines[scan.header + 1:], ctx, last or {})


def reasons(result) -> dict[str, int]:
    return dict(result.rejected)


# The sample export of the scaffold (6 meters, 24 hours, deliberate problems): the tags it names and how each is mapped.
SAMPLE_TAGS = {}
for _m in range(1, 7):
    _scale = 0.001 if _m == 6 else 1.0  # meter 6 is read in Wh and W
    SAMPLE_TAGS[f"M{_m:02d}.kWh"] = ("energy_kwh", _scale)
    SAMPLE_TAGS[f"M{_m:02d}.kW"] = ("active_power_kw", _scale)


async def make_world(db, tags=None, *, name="files", connector_type="file") -> tuple[int, dict[str, int]]:
    """A source of `connector_type` with a point for each tag of `tags` ({tag: (metric, scale)}; a metric of None leaves the point
    unmapped) and a mapping to a asset of its own. Returns the source id and {tag: point id}."""
    source = await make_source(db, name, connector_type=connector_type)
    ids: dict[str, int] = {}
    for tag, (metric, scale) in (SAMPLE_TAGS if tags is None else tags).items():
        point = ids[tag] = await make_point(db, source, tag)
        if metric is not None:
            asset = await make_asset(db, f"{name} {tag}")
            await make_mapping(db, point, asset, metric=metric, interval=3600, scale=scale)
    return source, ids


async def save_profile(db, name: str = "hourly", **over) -> None:
    """Save an import profile the way the profile route does (one `settings` row), for the command and the import route to find."""
    profile = make_profile(**over).model_dump(mode="json")
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ('import_profiles', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        {"profiles": {name: {**profile, "name": name}}},
    )
