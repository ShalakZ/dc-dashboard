from datetime import datetime, timedelta, timezone

import pytest

from dcdash.core.energy import Energy, consumption, from_counter, from_power

T0 = datetime(2026, 10, 6, tzinfo=timezone.utc)


def at(minutes: float, value: float):
    return (T0 + timedelta(minutes=minutes), value)


def test_counter_consumption_is_last_minus_first():
    assert from_counter([at(0, 100.0), at(10, 104.5), at(20, 110.0)]) == pytest.approx(10.0)


def test_counter_reset_adds_nothing_and_is_never_negative():
    # 100 -> 110 (+10), reset to 5 (ignored), 5 -> 8 (+3)
    assert from_counter([at(0, 100.0), at(10, 110.0), at(20, 5.0), at(30, 8.0)]) == pytest.approx(13.0)


def test_counter_with_fewer_than_two_samples_is_zero():
    assert from_counter([]) == 0.0
    assert from_counter([at(0, 100.0)]) == 0.0


def test_power_integral_of_constant_load():
    samples = [at(m, 10.0) for m in range(0, 61)]
    assert from_power(samples, max_gap_seconds=120) == pytest.approx(10.0)


def test_power_integral_is_trapezoidal():
    # ramps 0 -> 60 kW over one hour: average 30 kW for 1 h
    assert from_power([at(0, 0.0), at(60, 60.0)], max_gap_seconds=3600) == pytest.approx(30.0)


def test_power_integral_skips_gaps():
    # 10 kW for 10 min, a 40 min outage, 10 kW for 10 min
    samples = [at(0, 10.0), at(10, 10.0), at(50, 10.0), at(60, 10.0)]
    assert from_power(samples, max_gap_seconds=900) == pytest.approx(10.0 * 20 / 60)


def test_consumption_prefers_the_counter():
    result = consumption([at(0, 1.0), at(10, 3.0)], [at(0, 99.0), at(10, 99.0)])
    assert result == Energy(kwh=pytest.approx(2.0), estimated=False)


def test_consumption_from_power_is_marked_estimated():
    result = consumption(None, [at(0, 6.0), at(10, 6.0)], max_gap_seconds=900)
    assert result == Energy(kwh=pytest.approx(1.0), estimated=True)


def test_consumption_without_any_source_is_none():
    assert consumption(None, None) is None
