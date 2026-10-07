from dataclasses import dataclass
from datetime import datetime

Sample = tuple[datetime, float]


@dataclass(frozen=True)
class Energy:
    kwh: float
    estimated: bool


def from_counter(samples: list[Sample]) -> float:
    """Consumption in kWh from a cumulative counter.

    A decrease is a counter reset or rollover. The step across it contributes
    nothing, so consumption is never negative or inflated.
    """
    total = 0.0
    for (_, previous), (_, current) in zip(samples, samples[1:]):
        if current >= previous:
            total += current - previous
    return total


def from_power(samples: list[Sample], max_gap_seconds: float) -> float:
    """Trapezoidal integral of kW over time, in kWh.

    Steps longer than max_gap_seconds are outages and contribute nothing:
    missing data is never filled in.
    """
    total = 0.0
    for (t0, p0), (t1, p1) in zip(samples, samples[1:]):
        seconds = (t1 - t0).total_seconds()
        if 0 < seconds <= max_gap_seconds:
            total += (p0 + p1) / 2 * seconds / 3600
    return total


def consumption(
    counter: list[Sample] | None,
    power: list[Sample] | None,
    max_gap_seconds: float = 300,
) -> Energy | None:
    """Use the meter's counter when there is one, else estimate from power."""
    if counter is not None:
        return Energy(from_counter(counter), estimated=False)
    if power is not None:
        return Energy(from_power(power, max_gap_seconds), estimated=True)
    return None
