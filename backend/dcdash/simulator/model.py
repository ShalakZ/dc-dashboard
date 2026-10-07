import math
from dataclasses import dataclass, field
from datetime import datetime

PANELS = [f"LVP{n:02d}" for n in range(1, 11)]
SIGNALS = {"kW": "kW", "kWh": "kWh", "V": "V", "A": "A", "PF": "", "Hz": "Hz"}
VOLTS = 400.0
POWER_FACTOR = 0.95


def power_kw(panel_index: int, t: datetime) -> float:
    """Daily load curve peaking at 15:00, larger for higher-numbered panels."""
    base = 40 + 12 * panel_index
    hours = t.hour + t.minute / 60 + t.second / 3600
    daily = 0.5 + 0.5 * math.sin((hours - 9) / 24 * 2 * math.pi)
    ripple = 1.5 * math.sin(t.timestamp() / 7)
    return round(base * (0.6 + 0.4 * daily) + ripple, 3)


def _initial_counters() -> dict[str, float]:
    return {panel: 1000.0 * (index + 1) for index, panel in enumerate(PANELS)}


@dataclass
class Simulator:
    offline: bool = False
    reject_auth: bool = False
    _kwh: dict[str, float] = field(default_factory=_initial_counters)
    _last: datetime | None = None

    def points(self) -> list[dict]:
        return [
            {"address": f"{panel}_{signal}", "name": f"{panel} {signal}", "unit": unit}
            for panel in PANELS
            for signal, unit in SIGNALS.items()
        ]

    def advance(self, now: datetime) -> None:
        """Accumulate energy for the time since the previous call."""
        if self._last is not None:
            hours = max((now - self._last).total_seconds(), 0.0) / 3600
            for index, panel in enumerate(PANELS):
                self._kwh[panel] += power_kw(index, now) * hours
        self._last = now

    def reset_counter(self, panel: str) -> None:
        self._kwh[panel] = 0.0

    def read(self, address: str, now: datetime) -> float | None:
        panel, _, signal = address.partition("_")
        if panel not in PANELS or signal not in SIGNALS:
            return None
        kw = power_kw(PANELS.index(panel), now)
        if signal == "kW":
            return kw
        if signal == "kWh":
            return round(self._kwh[panel], 4)
        if signal == "V":
            return VOLTS
        if signal == "A":
            return round(kw * 1000 / (math.sqrt(3) * VOLTS * POWER_FACTOR), 2)
        if signal == "PF":
            return POWER_FACTOR
        return 50.0
