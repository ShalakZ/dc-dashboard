"""What the w38 tag-text rule must NOT change (written on main's code, before the rule changed). Pure: no database.

(a) For every (address, name) of a literal corpus, `member_text` equals a verbatim copy of main's rule, except for the rows the rule
changes on purpose: an address that is not numbered but fully matches the stable form, with a name that is neither the address nor the tag.
Both halves are held: unchanged outside the exception, and inside it the tag after the first dot of the address (not the name).
(b) One hash of the whole shapes answer for the 15,000-tag numbered SCADA source. Identical texts give identical shapes, so (a) and (b)
together say that nothing else moved.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from dcdash.connectors.opcua_ids import has_number_prefix, tag_name
from dcdash.shapes.core import Member, build_shapes, member_text, shape_json
from dcdash.simulator.scada import ScadaConfig, _build_tags, unit_of

SAMPLES = json.loads((Path(__file__).resolve().parent / "fixtures" / "opcua_id_samples.json").read_text(encoding="ascii"))

# main's `_STABLE_FORM` (shapes/core.py, 65949a7), copied on purpose: this test must not follow a later edit of the original.
_STABLE_FORM_OF_MAIN = re.compile(r"(?:ns=[0-9]+;)?s=[^.\s]*\.(\S+)")


def _member_text_of_main(address: str, name: str) -> str:
    """main's `member_text` (65949a7), verbatim."""
    if has_number_prefix(address):
        return tag_name(address)
    if name != address:
        return name
    found = _STABLE_FORM_OF_MAIN.fullmatch(address)
    return found[1] if found is not None else name


def _after_the_first_dot(address: str) -> str:
    return address.partition(".")[2] if "." in address else address


def _corpus() -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for sample in SAMPLES:
        for address in (sample["in"], sample["out"]):
            for name in (address, _after_the_first_dot(address), "Active power", ""):
                rows.append((address, name))
    rows += [
        ("40001", "Feed A kWh"), ("40002", "Feed A power"), ("40003", "40003"), ("40004", ""), ("40001", "Active power"),
        ("/api/v1/meters/3/power", "Meter 3 power"), ("/api/v1/meters/3/power", "/api/v1/meters/3/power"), ("/status", ""),
        ("https://meters.example/data/pdu-a01/kwh", "pdu-a01 kWh"),
        ("PDU-A01.kWh", "PDU-A01.kWh"), ("PDU-A01.kWh", "kWh"), ("PDU-A01.kWh", "PDU-A01 energy"), ("PDU-A01.kWh", ""),
        ("ns=2;i=9", "ns=2;i=9"), ("ns=2;i=9", "Temperature"), ("ns=2;i=9", ""),
        ("NS=3;S=Site.X", "NS=3;S=Site.X"), ("NS=3;S=Site.X", "X"), ("NS=3;S=Site.X", "Active power"),
        ("nsu=http://x;s=Site.A.B", "nsu=http://x;s=Site.A.B"), ("nsu=http://x;s=Site.A.B", "A.B"), ("nsu=http://x;s=Site.A.B", "Power"),
        ("ns=3;s=NoDotHere", "ns=3;s=NoDotHere"), ("ns=3;s=NoDotHere", "NoDotHere"), ("ns=3;s=NoDotHere", "Power"),
        ("ns=3;s=Site. spaced", "ns=3;s=Site. spaced"), ("ns=3;s=Site. spaced", " spaced"), ("ns=3;s=Site. spaced", "Power"),
        # stable-form ids: the name IS the address (the browse found no DisplayName), the name IS the tag, a cluster-carrying or friendly name
        ("ns=3;s=Site.PDUA01_PM0_P", "ns=3;s=Site.PDUA01_PM0_P"), ("ns=3;s=Site.PDUA01_PM0_P", "PDUA01_PM0_P"),
        ("ns=3;s=Site.PDUA01_PM0_P", "Site.PDUA01_PM0_P"), ("ns=3;s=Site.PDUA01_PM0_P", "PM0_P"), ("ns=3;s=Site.PDUA01_PM0_P", "Active power"),
        ("ns=3;s=Site.PDUA01_PM0_P", ""), ("s=Site.A.B", "A.B"), ("s=Site.A.B", "Site.A.B"),
        ("ns=3;s=20403:Site.PDUA01_PM0_P", "Active power"), ("ns=3;s=20403:Site.PDUA01_PM0_P", "ns=3;s=20403:Site.PDUA01_PM0_P"),
    ]
    return list(dict.fromkeys(rows))


def _is_the_exception(address: str, name: str) -> bool:
    """The rows the new rule changes on purpose: not numbered, fully the stable form, and a name that is neither the address nor the tag."""
    if has_number_prefix(address):
        return False
    found = _STABLE_FORM_OF_MAIN.fullmatch(address)
    return found is not None and name != address and name != found[1]


def test_member_text_equals_mains_rule_for_every_row_outside_the_deliberate_exception():
    corpus = _corpus()
    differing = [(a, n, member_text(a, n), _member_text_of_main(a, n)) for a, n in corpus
                 if not _is_the_exception(a, n) and member_text(a, n) != _member_text_of_main(a, n)]
    assert not differing, "rows whose text moved (address, name, new, main): " + repr(differing)


def test_member_text_is_the_tag_after_the_first_dot_for_every_row_of_the_deliberate_exception():
    exceptions = [(a, n) for a, n in _corpus() if _is_the_exception(a, n)]
    assert exceptions  # an empty list must fail, not pass with no rows
    wrong = [(a, n, member_text(a, n)) for a, n in exceptions if member_text(a, n) != _STABLE_FORM_OF_MAIN.fullmatch(a)[1]]
    assert not wrong, "rows of the exception that do not read the tag of their address (address, name, text): " + repr(wrong)


def test_the_exception_is_a_few_rows_and_cannot_swallow_the_corpus():
    corpus = _corpus()
    exceptions = [row for row in corpus if _is_the_exception(*row)]
    assert len(exceptions) >= 5, exceptions
    assert len(exceptions) < len(corpus) / 4, (len(exceptions), len(corpus))
    # the rows outside the exception hold every other kind of address, so the equality above says something about each of them
    assert sum(has_number_prefix(address) for address, _name in corpus) >= 20
    assert any(address == name for address, name in corpus if _STABLE_FORM_OF_MAIN.fullmatch(address) and not has_number_prefix(address))


# The SHA-256 of the shapes and the one-member tags of the 15,000-tag numbered SCADA source, computed on main's code (w38 T0), before the rule changed.
# The constant may be recomputed whenever the simulator's tag set (`dcdash.simulator.scada._build_tags`) changes, provided the differential test above
# still passes: it is the differential test that proves the rule; the hash only proves that the 15,000-tag numbered answer is unchanged by it.
BIG_SOURCE_HASH = "67f70308556a8bbf34c576b25c912a307e344698f6eac5418c7b3775bb7aed49"


def test_the_15000_tag_numbered_source_gives_the_same_shapes_as_main():
    tags, _ = _build_tags(ScadaConfig(pdus=200, branch_tags=4190))
    members = [Member(i + 1, f"ns=3;s={20000 + i}:Site.{tag}", tag, unit_of(tag)) for i, tag in enumerate(tags)]
    assert len(members) == 15_000
    shape_set = build_shapes(members)
    answer = {"shapes": [shape_json(s) for s in shape_set.shapes], "other": [m.address for m in shape_set.other]}
    digest = hashlib.sha256(json.dumps(answer, sort_keys=True).encode("utf-8")).hexdigest()
    assert digest == BIG_SOURCE_HASH
