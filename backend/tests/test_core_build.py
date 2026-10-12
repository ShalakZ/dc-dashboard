import time

import pytest

from dcdash.core import build
from dcdash.core.build import BuildInfo, build_info, uptime_seconds


def test_without_the_variables_the_build_is_dev_and_unknown(monkeypatch):
    monkeypatch.delenv("DCDASH_BUILD_ID", raising=False)
    monkeypatch.delenv("DCDASH_BUILD_TIME", raising=False)
    assert build_info() == BuildInfo(build_id="dev", build_time="unknown")


def test_the_variables_are_read_at_each_call(monkeypatch):
    monkeypatch.setenv("DCDASH_BUILD_ID", "a1b2c3d-dirty")
    monkeypatch.setenv("DCDASH_BUILD_TIME", "2026-10-12T14:03:11+02:00")
    assert build_info() == BuildInfo("a1b2c3d-dirty", "2026-10-12T14:03:11+02:00")
    monkeypatch.setenv("DCDASH_BUILD_ID", "e4f5a6b")
    assert build_info().build_id == "e4f5a6b"


@pytest.mark.parametrize("empty", ["", "  "])
def test_an_empty_variable_means_not_set(monkeypatch, empty):
    # compose passes `${DCDASH_BUILD_ID:-dev}`, but a hand-made `docker build --build-arg DCDASH_BUILD_ID=` gives an empty string
    monkeypatch.setenv("DCDASH_BUILD_ID", empty)
    monkeypatch.setenv("DCDASH_BUILD_TIME", empty)
    assert build_info() == BuildInfo("dev", "unknown")


def test_build_info_is_immutable():
    with pytest.raises(AttributeError):
        build_info().build_id = "x"  # type: ignore[misc]


def test_uptime_counts_from_the_import_on_the_monotonic_clock():
    assert build.STARTED_AT <= time.monotonic()
    first = uptime_seconds()
    time.sleep(0.02)
    second = uptime_seconds()
    assert 0 <= first < second
