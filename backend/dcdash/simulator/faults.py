"""Dev-only fault switches of the OPC UA simulator, read once from SIM_FAULT_* environment variables.

They exist so the whole field-debugging loop (connection check, report, the owner's copy-paste) can be rehearsed before the real SCADA
exists. Nothing outside `dcdash/simulator/` may import this module or mention these names, and compose passes the variables to the
dev-profile `simulator` service only (tests/test_simulator_faults_isolation.py pins both). Empty or unset means off.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from asyncua import ua

from dcdash.simulator.model import PANELS, SIGNALS

PREFIX = "SIM_FAULT_"
KNOWN = (
    "SIM_FAULT_POLICIES", "SIM_FAULT_UNTRUSTED_CERT", "SIM_FAULT_AUTH", "SIM_FAULT_SLOW", "SIM_FAULT_DROP",
    "SIM_FAULT_BAD", "SIM_FAULT_SKEW", "SIM_FAULT_CERT_HOSTS",
)
POLICY_ORDER = ("none", "basic256sha256")  # the canonical order of Faults.policies
UNTRUSTED_AT_CHANNEL = "channel"  # SIM_FAULT_UNTRUSTED_CERT=1: an ERR message at OpenSecureChannel, as a real stack answers
UNTRUSTED_AT_SESSION = "session"  # SIM_FAULT_UNTRUSTED_CERT=session: asyncua's own validator, which refuses at CreateSession
MAX_SLOW, MIN_DROP, MAX_DROP, MAX_SKEW = 60.0, 0.2, 3600.0, 86400


class FaultConfigError(ValueError):
    """A SIM_FAULT_* setting that cannot be honoured; the message is a plain sentence for whoever started the simulator."""


@dataclass(frozen=True)
class Faults:
    policies: tuple[str, ...] = ("none",)
    untrusted_cert: bool = False
    untrusted_cert_at: str = UNTRUSTED_AT_CHANNEL  # only meaningful with untrusted_cert
    auth_required: bool = False
    slow_seconds: float = 0.0
    drop_seconds: float = 0.0  # each client connection is closed this long after it was accepted
    bad_nodes: tuple[tuple[str, str], ...] = ()  # (model address, ua.StatusCodes name)
    skew_seconds: int = 0
    cert_hosts: tuple[str, ...] = ()  # extra DNS names for the server certificate (not a fault)

    @property
    def offered_policies(self) -> tuple[str, ...]:
        """The security policies the endpoint offers: an untrusted-certificate server offers only the secure one."""
        return ("basic256sha256",) if self.untrusted_cert else self.policies

    @property
    def needs_server_certificate(self) -> bool:
        return "basic256sha256" in self.offered_policies

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> Faults:
        unknown = sorted(name for name in environ if name.startswith(PREFIX) and name not in KNOWN)
        if unknown:
            raise FaultConfigError(
                f"{', '.join(unknown)} is not a fault switch of the simulator (a typo would run a fault-free rehearsal). "
                f"The switches are: {', '.join(KNOWN)}."
            )

        def value(name: str) -> str:
            return environ.get(name, "").strip()

        policies = _policies(value("SIM_FAULT_POLICIES"))
        untrusted, untrusted_at = _untrusted(value("SIM_FAULT_UNTRUSTED_CERT"))
        if untrusted and value("SIM_FAULT_POLICIES") and "none" in policies:
            raise FaultConfigError(
                "SIM_FAULT_UNTRUSTED_CERT offers the secure policy only, so SIM_FAULT_POLICIES must not contain none "
                "(leave SIM_FAULT_POLICIES empty or set basic256sha256)."
            )
        auth = value("SIM_FAULT_AUTH")
        if auth not in ("", "required"):
            raise FaultConfigError(f"SIM_FAULT_AUTH must be empty or 'required', not '{auth}'.")
        return cls(
            policies=policies,
            untrusted_cert=untrusted,
            untrusted_cert_at=untrusted_at,
            auth_required=auth == "required",
            slow_seconds=_slow(value("SIM_FAULT_SLOW")),
            drop_seconds=_drop(value("SIM_FAULT_DROP")),
            bad_nodes=_bad(value("SIM_FAULT_BAD")),
            skew_seconds=_skew(value("SIM_FAULT_SKEW")),
            cert_hosts=_hosts(value("SIM_FAULT_CERT_HOSTS")),
        )

    def describe(self) -> list[str]:
        """One line per active fault, each starting with the variable and its value (the first thing to look for in the log)."""
        lines = []
        if self.policies != ("none",):
            lines.append(f"SIM_FAULT_POLICIES={','.join(self.policies)}: only these security policies are offered")
        if self.untrusted_cert:
            at_channel = self.untrusted_cert_at == UNTRUSTED_AT_CHANNEL
            lines.append(f"SIM_FAULT_UNTRUSTED_CERT={'1' if at_channel else 'session'}: secure policy only, every client certificate "
                         f"is refused {'with an error at OpenSecureChannel' if at_channel else 'at CreateSession'}")
        if self.auth_required:
            lines.append("SIM_FAULT_AUTH=required: user name and password only, no anonymous login")
        if self.slow_seconds:
            lines.append(f"SIM_FAULT_SLOW={self.slow_seconds:g}: every request is answered {self.slow_seconds:g} s late")
        if self.drop_seconds:
            lines.append(f"SIM_FAULT_DROP={self.drop_seconds:g}: each connection is closed {self.drop_seconds:g} s after it was accepted")
        if self.bad_nodes:
            nodes = ",".join(f"{address}:{status}" for address, status in self.bad_nodes)
            lines.append(f"SIM_FAULT_BAD={nodes}: these variables answer with a Bad status")
        if self.skew_seconds:
            lines.append(f"SIM_FAULT_SKEW={self.skew_seconds}: the server clock is {self.skew_seconds} s off")
        return lines


def _policies(text: str) -> tuple[str, ...]:
    if not text:
        return ("none",)
    chosen = {part.strip().lower() for part in text.split(",")}
    unknown = sorted(chosen - set(POLICY_ORDER))
    if unknown:
        raise FaultConfigError(f"SIM_FAULT_POLICIES: '{', '.join(unknown)}' is not a policy; use none, basic256sha256 or none,basic256sha256.")
    return tuple(policy for policy in POLICY_ORDER if policy in chosen)


def _untrusted(text: str) -> tuple[bool, str]:
    if text in ("", "0"):
        return False, UNTRUSTED_AT_CHANNEL
    if text == "1":
        return True, UNTRUSTED_AT_CHANNEL
    if text == "session":
        return True, UNTRUSTED_AT_SESSION
    raise FaultConfigError(f"SIM_FAULT_UNTRUSTED_CERT must be empty, 1 or session, not '{text}'.")


def _number(name: str, text: str) -> float:
    try:
        number = float(text)
    except ValueError:
        raise FaultConfigError(f"{name} must be a number of seconds, not '{text}'.") from None
    if not math.isfinite(number):
        raise FaultConfigError(f"{name} must be a finite number of seconds, not '{text}'.")
    return number


def _slow(text: str) -> float:
    if not text:
        return 0.0
    seconds = _number("SIM_FAULT_SLOW", text)
    if not 0 < seconds <= MAX_SLOW:
        raise FaultConfigError(f"SIM_FAULT_SLOW must be more than 0 and at most {MAX_SLOW:g} seconds, not '{text}'.")
    return seconds


def _drop(text: str) -> float:
    if not text:
        return 0.0
    seconds = _number("SIM_FAULT_DROP", text)
    if not MIN_DROP <= seconds <= MAX_DROP:
        raise FaultConfigError(f"SIM_FAULT_DROP must be between {MIN_DROP:g} and {MAX_DROP:g} seconds, not '{text}'.")
    return seconds


def _skew(text: str) -> int:
    if not text:
        return 0
    try:
        seconds = int(text)
    except ValueError:
        raise FaultConfigError(f"SIM_FAULT_SKEW must be a whole number of seconds (negative: behind), not '{text}'.") from None
    if abs(seconds) > MAX_SKEW:
        raise FaultConfigError(f"SIM_FAULT_SKEW must be between -{MAX_SKEW} and {MAX_SKEW} seconds, not '{text}'.")
    return seconds


def _bad(text: str) -> tuple[tuple[str, str], ...]:
    if not text:
        return ()
    addresses = {f"{panel}_{signal}" for panel in PANELS for signal in SIGNALS}
    nodes: list[tuple[str, str]] = []
    for item in text.split(","):
        address, colon, status = (part.strip() for part in item.partition(":"))
        if not colon or not address or not status:
            raise FaultConfigError(f"SIM_FAULT_BAD entries look like ADDRESS:Status (for example LVP01_kW:BadSensorFailure), not '{item.strip()}'.")
        if address not in addresses:
            raise FaultConfigError(f"SIM_FAULT_BAD: '{address}' is not a simulator point (the addresses look like LVP01_kW).")
        if not status.startswith("Bad") or not isinstance(getattr(ua.StatusCodes, status, None), int):
            raise FaultConfigError(f"SIM_FAULT_BAD: '{status}' is not an OPC UA Bad status code name (for example BadSensorFailure).")
        if any(address == known for known, _ in nodes):
            raise FaultConfigError(f"SIM_FAULT_BAD: '{address}' is listed twice.")
        nodes.append((address, status))
    return tuple(nodes)


def _hosts(text: str) -> tuple[str, ...]:
    hosts = tuple(dict.fromkeys(part.strip() for part in text.split(",") if part.strip()))
    for host in hosts:
        if not all(character.isalnum() or character in "-._" for character in host):
            raise FaultConfigError(f"SIM_FAULT_CERT_HOSTS takes comma-separated DNS names, not '{host}'.")
    return hosts
