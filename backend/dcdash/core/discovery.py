"""Pure discovery logic: scan-target expansion, suggested groups and mapping guesses.

Nothing here opens a connection; `local_addresses` only asks the OS for this machine's own addresses.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

from dcdash.core.metrics import Metric, default_interval

MAX_PORTS = 20
_HOSTNAME = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")
_URL_DEFAULT_PORTS = {"http": 80, "https": 443, "opc.tcp": 4840}
_SEPARATORS = re.compile(r"[_\s./:\-]+")


class TargetError(ValueError):
    """A scan scope is malformed or larger than allowed."""


@dataclass(frozen=True)
class Expansion:
    hosts: tuple[str, ...]
    ports: tuple[int, ...]
    extra: tuple[tuple[str, int], ...] = ()

    @property
    def pairs(self) -> list[tuple[str, int]]:
        pairs = [(host, port) for host in self.hosts for port in self.ports]
        seen = set(pairs)
        for pair in self.extra:
            if pair not in seen:
                seen.add(pair)
                pairs.append(pair)
        return pairs


def scan_digest(targets: list[str], ports: list[int]) -> str:
    """A hash of what a scope scans; the scan start request must repeat the one its preview returned."""
    scope = {"targets": [target.strip() for target in targets], "ports": ports}
    return hashlib.sha256(json.dumps(scope, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _validated_ports(ports: list[int]) -> tuple[int, ...]:
    if not ports:
        raise TargetError("add at least one port")
    if len(ports) > MAX_PORTS:
        raise TargetError(f"too many ports (at most {MAX_PORTS})")
    for port in ports:
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise TargetError(f"invalid port: {port}")
    return tuple(dict.fromkeys(ports))


def _single_host(target: str) -> str:
    try:
        address = ipaddress.ip_address(target)
    except ValueError:
        if re.fullmatch(r"[\d.]+", target):
            raise TargetError(f"not a valid address: {target}") from None
        if len(target) > 253 or not _HOSTNAME.match(target):
            raise TargetError(f"not a valid host name: {target}")
        return target.lower()
    if address.version != 4:
        raise TargetError(f"IPv6 is not supported: {target}")
    if address.is_unspecified or address.is_multicast:
        raise TargetError(f"not a scannable address: {target}")
    return str(address)


def _cidr_hosts(target: str, max_hosts: int) -> list[str]:
    try:
        network = ipaddress.ip_network(target, strict=False)
    except ValueError:
        raise TargetError(f"not a valid network: {target}") from None
    if network.version != 4:
        raise TargetError(f"IPv6 is not supported: {target}")
    if network.num_addresses > max_hosts + 2:  # compare before enumerating: a /8 must never be listed
        raise TargetError(f"{target} covers {network.num_addresses} addresses; the limit is {max_hosts} hosts")
    return [str(host) for host in network.hosts()]


def _url_host_port(target: str) -> tuple[str, int]:
    # Checked before anything else so no message below can echo a password back or store it in a scope.
    try:
        parsed = urlparse(target)
    except ValueError:
        raise TargetError("not a valid URL") from None
    if "@" in parsed.netloc:
        raise TargetError("URL targets must not contain credentials")
    scheme = parsed.scheme.lower()
    if scheme not in (*_URL_DEFAULT_PORTS, "tcp"):
        raise TargetError(f"unsupported URL scheme: {target}")
    if not parsed.hostname:
        raise TargetError(f"URL has no host: {target}")
    try:
        port = parsed.port or _URL_DEFAULT_PORTS.get(scheme)
    except ValueError:
        raise TargetError(f"invalid port in URL: {target}") from None
    if port is None:
        raise TargetError(f"tcp:// URLs need an explicit port: {target}")
    return _single_host(parsed.hostname), port


def expand_targets(targets: list[str], ports: list[int], max_hosts: int) -> Expansion:
    """Turn a scope into hosts and (host, port) pairs, rejecting anything malformed or over `max_hosts`."""
    if not targets:
        raise TargetError("add at least one target")
    clean_ports = _validated_ports(ports)
    hosts: dict[str, None] = {}
    extra: list[tuple[str, int]] = []

    def add(host: str) -> None:
        hosts[host] = None
        if len(hosts) > max_hosts:
            raise TargetError(f"the scope covers more than {max_hosts} hosts; the limit is {max_hosts}")

    for raw in targets:
        target = raw.strip()
        if not target:
            raise TargetError("empty target")
        if "://" in target:
            host, port = _url_host_port(target)
            add(host)
            extra.append((host, port))
        elif "/" in target:
            for host in _cidr_hosts(target, max_hosts):
                add(host)
        else:
            add(_single_host(target))
    if len(set(clean_ports) | {port for _, port in extra}) > MAX_PORTS:  # URL ports count too
        raise TargetError(f"too many ports (at most {MAX_PORTS})")
    return Expansion(tuple(hosts), clean_ports, tuple(extra))


@dataclass(frozen=True)
class PointInfo:
    id: int
    address: str
    name: str
    unit_hint: str | None = None


@dataclass(frozen=True)
class Group:
    key: str
    point_ids: tuple[int, ...]


def _tokens(name: str) -> list[str]:
    return [token for token in _SEPARATORS.split(name.strip()) if token]


def _natural(key: str) -> list[tuple[int, int | str]]:
    return [(0, int(part)) if part.isdecimal() else (1, part.casefold()) for part in re.split(r"(\d+)", key) if part]


def suggest_groups(points: list[PointInfo]) -> tuple[list[Group], list[int]]:
    """Group points by every name token except the last; a group needs at least two points."""
    buckets: dict[str, tuple[str, list[int]]] = {}
    for point in points:
        tokens = _tokens(point.name)
        if len(tokens) < 2:
            continue
        key = " ".join(tokens[:-1])
        buckets.setdefault(key.casefold(), (key, []))[1].append(point.id)
    groups = [Group(key, tuple(ids)) for key, ids in buckets.values() if len(ids) >= 2]
    grouped = {pid for group in groups for pid in group.point_ids}
    ungrouped = [point.id for point in points if point.id not in grouped]
    return sorted(groups, key=lambda g: _natural(g.key)), ungrouped


@dataclass(frozen=True)
class MappingGuess:
    metric: Metric
    scale: float
    interval_seconds: int
    custom_unit: str | None


_UNIT_RULES: dict[str, tuple[Metric, float]] = {
    "kw": (Metric.ACTIVE_POWER_KW, 1.0), "w": (Metric.ACTIVE_POWER_KW, 0.001),
    "kwh": (Metric.ENERGY_KWH, 1.0), "wh": (Metric.ENERGY_KWH, 0.001),
    "v": (Metric.VOLTAGE_V, 1.0), "a": (Metric.CURRENT_A, 1.0), "pf": (Metric.POWER_FACTOR, 1.0),
    "hz": (Metric.FREQUENCY_HZ, 1.0), "kvar": (Metric.REACTIVE_POWER_KVAR, 1.0),
    "kva": (Metric.APPARENT_POWER_KVA, 1.0),
}


def guess_mapping(point: PointInfo) -> MappingGuess:
    """Guess metric and scale from the unit hint, or from the last name token when there is no hint."""
    hint = (point.unit_hint or "").strip()
    if hint:
        token = hint
    else:
        tokens = _tokens(point.name)
        token = tokens[-1] if tokens else ""
    rule = _UNIT_RULES.get(token.casefold())
    if rule is not None:
        metric, scale = rule
        return MappingGuess(metric, scale, default_interval(metric), None)
    return MappingGuess(Metric.CUSTOM, 1.0, default_interval(Metric.CUSTOM), hint or None)


def networks_from_addresses(addresses: list[str]) -> list[str]:
    """The /24 around each usable IPv4 address (loopback, link-local and non-IPv4 are skipped)."""
    networks: dict[str, None] = {}
    for raw in addresses:
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if address.version != 4 or address.is_loopback or address.is_link_local:
            continue
        networks[str(ipaddress.ip_network(f"{address}/24", strict=False))] = None
    return list(networks)


def local_addresses() -> list[str]:
    """This machine's non-loopback IPv4 addresses: the default-route address plus what the host name resolves to."""
    found: dict[str, None] = {}
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))  # no packet is sent; this only selects the outgoing interface
            found[probe.getsockname()[0]] = None
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found[info[4][0]] = None
    except OSError:
        pass
    return [a for a in found if not a.startswith("127.")]
