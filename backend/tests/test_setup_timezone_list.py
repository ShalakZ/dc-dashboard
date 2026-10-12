"""scripts/timezones.txt is the allowlist setup.ps1 and setup.sh check -Timezone / --timezone against, before the first start.

A zone the api refuses would crash-loop the api AND the collector (Settings validates DCDASH_TIMEZONE at import), so the setup
scripts refuse anything not on this list. The list must hold exactly the zones Settings accepts: every IANA name of the pinned
tzdata package whose UTC offset is a whole number of hours in January and July. The package's own index is used, not
zoneinfo.available_timezones(): that one also reads the machine's /usr/share/zoneinfo and adds machine-dependent names such as
`localtime`.

Regenerate: cd backend && uv run python tests/test_setup_timezone_list.py > ../scripts/timezones.txt
"""
import sys
from importlib import resources
from pathlib import Path

from dcdash.core.timeutil import validate_whole_hour_zone

LIST = Path(__file__).resolve().parents[2] / "scripts" / "timezones.txt"
REGENERATE = "cd backend && uv run python tests/test_setup_timezone_list.py > ../scripts/timezones.txt"


def _accepted(zone: str) -> bool:
    try:
        validate_whole_hour_zone(zone)
    except ValueError:
        return False
    return True


def expected_zones() -> list[str]:
    with resources.files("tzdata").joinpath("zones").open("r", encoding="utf-8") as index:
        names = {line.strip() for line in index if line.strip()}
    return sorted(zone for zone in names if _accepted(zone))


def test_the_list_holds_exactly_the_zones_settings_accepts():
    listed = LIST.read_text(encoding="utf-8").splitlines()
    missing, extra = sorted(set(expected_zones()) - set(listed)), sorted(set(listed) - set(expected_zones()))
    assert not missing and not extra, f"scripts/timezones.txt is out of date. Missing: {missing}. Extra: {extra}. Regenerate: {REGENERATE}"


def test_the_list_is_sorted_without_duplicates_blank_lines_or_comments():
    raw = LIST.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r" not in raw and raw.endswith(b"\n") and not raw.endswith(b"\n\n")
    lines = raw.decode("ascii").split("\n")[:-1]
    assert lines == sorted(set(lines)), "sorted, no duplicates"
    assert all(line and line == line.strip() and not line.startswith("#") and " " not in line for line in lines)


def test_the_list_has_the_zones_the_owner_uses_and_none_with_a_fractional_offset():
    listed = set(LIST.read_text(encoding="utf-8").splitlines())
    assert {"UTC", "Africa/Cairo", "Asia/Qatar", "Europe/London"} <= listed
    assert not listed & {"Asia/Kolkata", "Asia/Kathmandu", "Indian/Cocos", "Australia/Adelaide"}
    assert 500 < len(listed) < 700


if __name__ == "__main__":
    sys.stdout.buffer.write("".join(f"{zone}\n" for zone in expected_zones()).encode("ascii"))
