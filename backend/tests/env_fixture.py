"""Reader of the shared .env fixture (tests/fixtures/env_cases.tsv): ONE list of .env texts that the awk and PowerShell readers of the
diagnostics scripts must treat alike. See the fixture's header for the file format and the rules."""

from dataclasses import dataclass
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "env_cases.tsv"
_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\"}
CONTROL = "keep"   # the word next to each secret in a probe line: it must come out unchanged


@dataclass(frozen=True)
class EnvCase:
    name: str
    env_text: str
    secrets: tuple[str, ...]

    def probe(self) -> tuple[str, list[str]]:
        """The text to scrub (one line per secret) and the lines the scrubber must print for it."""
        text = "".join(f"{CONTROL} {secret} {CONTROL}\n" for secret in self.secrets)
        return text, [f"{CONTROL} [hidden] {CONTROL}"] * len(self.secrets)


def _unescape(field: str) -> str:
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


def load_env_cases(path: Path = FIXTURE) -> list[EnvCase]:
    cases: list[EnvCase] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
        if not line or line.startswith("#"):
            continue
        columns = line.split("\t")
        if len(columns) != 3:
            raise ValueError(f"{path.name} line {number}: expected 3 tab-separated columns, got {len(columns)}")
        name, env_text, secrets = columns
        cases.append(EnvCase(name, _unescape(env_text), tuple(secrets.split("|"))))
    names = [case.name for case in cases]
    if len(set(names)) != len(names):
        raise ValueError("duplicate case names in the .env fixture")
    return cases
