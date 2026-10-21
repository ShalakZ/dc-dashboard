"""The history backfill (w30 D5 to D8, D12 to D16): its settings, its engine against the stand-in Historian, its limits and its lease.

Database tests; the engine is driven with a factory that hands out `SimulatorConnector`s talking to `create_historian_app` (or to the
plain simulator app, which keeps no history) through `httpx.ASGITransport`, with one fake clock shared by the stand-in and the engine
and a fake `sleep` that only records, so no test waits."""
import pytest

from dcdash.ingest import settings as history_settings
from dcdash.ingest.settings import HistorySettings


# ---- the settings ----------------------------------------------------------------------------------------------------------


def test_the_defaults_are_the_documented_ones_and_empty_means_default():
    assert HistorySettings.from_env({}) == HistorySettings(600.0, 20_000, 30, 7, 3)
    assert HistorySettings.from_env({name: "" for name in history_settings.NAMES}) == HistorySettings()
    assert HistorySettings.from_env({name: "  " for name in history_settings.NAMES}) == HistorySettings()
    assert HistorySettings().enabled


def test_every_value_can_be_set():
    environ = {
        "DCDASH_HISTORY_EVERY": "0.5", "DCDASH_HISTORY_MAX_ROWS": "100", "DCDASH_HISTORY_RATE": "1",
        "DCDASH_HISTORY_LOOKBACK_DAYS": "2", "DCDASH_HISTORY_REREAD_HOURS": "0",
    }
    assert HistorySettings.from_env(environ) == HistorySettings(0.5, 100, 1, 2, 0)


@pytest.mark.parametrize("value", ["0", "-1", "-600"])
def test_an_every_of_zero_or_less_switches_the_loop_off(value):
    assert not HistorySettings.from_env({"DCDASH_HISTORY_EVERY": value}).enabled


@pytest.mark.parametrize(
    "name, value",
    [
        ("DCDASH_HISTORY_EVERY", "often"), ("DCDASH_HISTORY_EVERY", "nan"), ("DCDASH_HISTORY_EVERY", "inf"),
        ("DCDASH_HISTORY_MAX_ROWS", "99"), ("DCDASH_HISTORY_MAX_ROWS", "lots"), ("DCDASH_HISTORY_MAX_ROWS", "1000.5"),
        ("DCDASH_HISTORY_RATE", "0"), ("DCDASH_HISTORY_RATE", "-3"), ("DCDASH_HISTORY_RATE", "fast"),
        ("DCDASH_HISTORY_LOOKBACK_DAYS", "0"), ("DCDASH_HISTORY_LOOKBACK_DAYS", "a week"),
        ("DCDASH_HISTORY_REREAD_HOURS", "-1"), ("DCDASH_HISTORY_REREAD_HOURS", "1.5"),
    ],
)
def test_a_value_that_is_not_a_number_or_out_of_range_is_refused_with_a_sentence_naming_the_variable(name, value):
    with pytest.raises(ValueError) as raised:
        HistorySettings.from_env({name: value})
    assert str(raised.value).startswith(f"{name} must be ") and f"'{value}'" in str(raised.value)
    assert str(raised.value).endswith(".")
