"""Reader of the shared scrubber fixture (tests/fixtures/scrub_cases.tsv): ONE list of cases that the Python, PowerShell and awk
scrubbers must all satisfy. See the fixture's header for the file format and the rules."""

from dataclasses import dataclass
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "scrub_cases.tsv"
_ESCAPES = {"t": "\t", "r": "\r", "\\": "\\"}


@dataclass(frozen=True)
class ScrubCase:
    name: str
    known: tuple[str, ...]
    text: str
    expected: str


def _unescape(field: str) -> str:
    """One left-to-right pass: `\\t`, `\\r` and `\\\\`; `(empty)` is the empty string."""
    if field == "(empty)":
        return ""
    out: list[str] = []
    chars = iter(field)
    for char in chars:
        if char != "\\":
            out.append(char)
            continue
        escape = next(chars, "")
        if escape not in _ESCAPES:
            raise ValueError(f"bad escape \\{escape} in {field!r}")
        out.append(_ESCAPES[escape])
    return "".join(out)


def load_cases(path: Path = FIXTURE) -> list[ScrubCase]:
    cases: list[ScrubCase] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
        if not line or line.startswith("#"):
            continue
        columns = line.split("\t")
        if len(columns) != 4:
            raise ValueError(f"{path.name} line {number}: expected 4 tab-separated columns, got {len(columns)}")
        name, known, text, expected = columns
        cases.append(ScrubCase(
            name, () if known == "-" else tuple(known.split("|")), _unescape(text), _unescape(expected),
        ))
    names = [case.name for case in cases]
    if len(set(names)) != len(names):
        raise ValueError("duplicate case names in the scrubber fixture")
    return cases
