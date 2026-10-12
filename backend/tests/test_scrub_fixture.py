"""The Python scrubber against the shared fixture (the PowerShell and awk copies are tested in the script tests)."""

import pytest

from dcdash.core.audit import scrub_url_credentials
from tests.scrub_fixture import load_cases

CASES = load_cases()


def test_the_fixture_is_big_enough_and_has_unique_names():
    assert len(CASES) >= 30


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_python_scrubber_matches_the_fixture(case):
    assert scrub_url_credentials(case.text, case.known) == case.expected


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_scrubbing_scrubbed_text_changes_nothing(case):
    assert scrub_url_credentials(case.expected, case.known) == case.expected
