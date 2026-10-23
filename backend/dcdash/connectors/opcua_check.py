"""The step-by-step connection check of an OPC UA source (`OpcUaConnector.check`).

Nine steps in order: dns, tcp, endpoints, certificates, session, server_time, namespaces, read_points, timing. Strictly read-only:
the only services used are the socket connect, GetEndpoints, creating and closing one session and Read. The steps from `session`
to `timing` share ONE session, which is closed in `finally` (also when the check is cancelled or runs out of time).

Each step is bounded by the source's `timeout_seconds` (`timing` and `read_points` get more, they make several requests); the
whole check by `DEADLINE_SECONDS`. The client's private key is never read by this module: the certificates step looks at the
public certificate only (the session step hands the key to asyncua, as every connection does).
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import math
import socket
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from asyncua import Client, ua
from asyncua.crypto import uacrypto
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.x509.oid import NameOID

from dcdash.connectors.base import GOOD, url_host_port
from dcdash.connectors.opcua import OpcUaConnector, ReportingClient, _point_value, _status_text, close_quietly
from dcdash.connectors.opcua_ids import read_plan, slice_size, stable_address
from dcdash.core.audit import hidden_values
from dcdash.diagnostics.check import Checker, CheckResult, Publish, StepFailed, StepOutcome
from dcdash.diagnostics.hints import CLOCK_SKEW, hint_for

DEADLINE_SECONDS = 60.0
MAX_CHUNK = 100  # nodes per Read request, whatever the server allows
TIMING_READS = 5
TIMING_PAUSE = 0.2  # seconds between the timing reads
TIMING_NODES = 10
MAX_POINT_LINES = 20  # points listed in the detail of read_points, bad ones first
MAX_BAD_KINDS = 3  # distinct bad statuses read_points names in its summary and gives a hint line each
SKEW_WARN_SECONDS = 60.0
SKEW_FAIL_SECONDS = 300.0
CERT_WARN_DAYS = 30
SUMMARY_CHARS = 280

_SERVER_TIME = ua.NodeId(ua.ObjectIds.Server_ServerStatus_CurrentTime)
_NAMESPACES = ua.NodeId(ua.ObjectIds.Server_NamespaceArray)
_MAX_NODES_PER_READ = ua.NodeId(ua.ObjectIds.Server_ServerCapabilities_OperationLimits_MaxNodesPerRead)
_STANDARD_NAMESPACE = "http://opcfoundation.org/UA/"

_CERT_FILE_HINT = (
    "The client certificate does not exist at that path inside the collector. Create the certificate and key as docs/sources-and-discovery.md "
    "describes, put them in ./certs and recreate the collector, or set the security policy to none."
)


def _local_now() -> datetime:
    return datetime.now(timezone.utc)


def _clip(text: str, limit: int = SUMMARY_CHARS) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _hostport(host: str, port: int) -> str:
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


def _enum_name(kind: type, value: Any) -> str:
    try:
        return kind(value).name.rstrip("_")
    except ValueError:
        return str(value)


def _status_name(status: str) -> str:
    """"BadNodeIdUnknown" out of "BadNodeIdUnknown (0x80340000)"."""
    return status.split(" (", 1)[0]


def _url_host(url: object) -> str:
    """The host of a URL the server reported, or "" (a null or malformed URL is the server's problem, not the check's)."""
    found = url_host_port(url)
    return found[0] if found else ""


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


# -- certificates -----------------------------------------------------------------------------------------------------------


async def load_certificate(source: str | bytes) -> x509.Certificate:
    """The first certificate of a PEM or DER file (a path) or of DER bytes. Raises ValueError when there is none."""
    content = await uacrypto.get_content(source)
    if b"-----BEGIN" in content[:2000]:
        return x509.load_pem_x509_certificate(content)
    cert = uacrypto.x509_from_der(content)
    if cert is None:
        raise ValueError("the certificate is empty")
    return cert


def certificate_facts(cert: x509.Certificate, now: datetime | None = None) -> dict[str, Any]:
    """What matters about a certificate when an OPC UA connection fails: who it is, its SHA-1 thumbprint (what a server's trust
    list shows), when it expires and which names it carries."""
    now = now or datetime.now(timezone.utc)
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        dns_names, ips, uris = [], [], []
    else:
        dns_names = san.get_values_for_type(x509.DNSName)
        ips = [str(address) for address in san.get_values_for_type(x509.IPAddress)]
        uris = san.get_values_for_type(x509.UniformResourceIdentifier)
    common_names = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    not_before, not_after = cert.not_valid_before_utc, cert.not_valid_after_utc
    return {
        "subject": cert.subject.rfc4514_string(),
        "common_name": str(common_names[0].value) if common_names else None,
        "self_signed": cert.subject == cert.issuer,
        "thumbprint_sha1": cert.fingerprint(hashes.SHA1()).hex().upper(),
        "not_before": not_before.isoformat(),
        "not_after": not_after.isoformat(),
        "days_left": math.floor((not_after - now).total_seconds() / 86400),
        "expired": not_after < now,
        "not_yet_valid": not_before > now,
        "application_uri": uris[0] if uris else None,
        "dns_names": dns_names,
        "ip_addresses": ips,
        "uris": uris,
    }


def host_matches(facts: dict[str, Any], host: str) -> bool | None:
    """Whether the certificate names `host` (an IP address in its alternative names, a DNS name, a `*.` wildcard, or the common
    name when it has no alternative names). None when it names no host at all."""
    names = [*facts["dns_names"], *facts["ip_addresses"]]
    if not names and facts["common_name"]:
        names = [facts["common_name"]]
    if not names:
        return None
    if _is_ip(host):
        target = ipaddress.ip_address(host)
        return any(_is_ip(name) and ipaddress.ip_address(name) == target for name in names)
    wanted = host.lower()
    for name in (item.lower() for item in names):
        if name == wanted or (name.startswith("*.") and "." in wanted and wanted.split(".", 1)[1] == name[2:]):
            return True
    return False


def _validity_words(facts: dict[str, Any]) -> str:
    if facts["expired"]:
        return f"EXPIRED on {facts['not_after'][:10]}"
    if facts["not_yet_valid"]:
        return f"NOT VALID YET (from {facts['not_before'][:10]})"
    return f"valid until {facts['not_after'][:10]} ({facts['days_left']} days)"


def _read_hints(kinds: list[tuple[str, str]]) -> str | None:
    """One line per hint text, newline apart ("BadSensorFailure, BadDeviceFailure: Ask ..."): the report prints each as a line of
    its own, since two hints joined into one would be cut at the line limit. Statuses with the same hint share a line."""
    lines: dict[str, list[str]] = {}
    for name, _address in kinds:
        if hint := hint_for(name, None, "read_points"):
            lines.setdefault(hint, []).append(name)
    return "\n".join(f"{', '.join(names)}: {hint}" for hint, names in lines.items()) or None


# -- the check --------------------------------------------------------------------------------------------------------------


class OpcUaCheck:
    """One run of the check. The state the steps share (endpoints, the open session, the plan for reading the points) lives here."""

    def __init__(self, connector: OpcUaConnector, points: list[str], publish: Publish | None) -> None:
        self.connector = connector
        self.config = connector.config
        self.points = list(points)
        known = [*hidden_values(self.config.model_dump()), *([connector.secret] if connector.secret else [])]
        # step_timeout is None: each step is given its own bound, and a step may need more than `timeout_seconds` in all
        self.checker = Checker("opcua", publish, known=known, step_timeout=None, deadline_seconds=DEADLINE_SECONDS)
        self.endpoints: list[Any] | None = None
        self.client: Client | None = None
        self.namespaces: list[str] | None = None
        self._plan_cache: tuple[int | None, int, list[tuple[str, ua.NodeId]], list[dict[str, Any]]] | None = None

    async def run(self) -> CheckResult:
        t = self.config.timeout_seconds
        step = self.checker.step
        try:
            await step("dns", "DNS resolution", self.dns, timeout=t)
            await step("tcp", "TCP connection", self.tcp, needs=("dns",), timeout=t)
            await step("endpoints", "Server endpoints", self.get_endpoints, needs=("tcp",), timeout=t)
            await step("certificates", "Certificates", self.certificates, needs=("tcp",), timeout=t)
            await step("session", "Secure channel and session", self.open_session, needs=("tcp",), timeout=t)
            await step("server_time", "Server time", self.server_time, needs=("session",), timeout=t)
            await step("namespaces", "Namespaces", self.read_namespaces, needs=("session",), timeout=t)
            # no bound of its own: the step knows its budget only once the server has said how many nodes it reads per request,
            # so `read_points` sets it (the overall deadline still bounds it from outside)
            await step("read_points", "Read the mapped points", self.read_points, needs=("session",))
            timing_limit = (t + TIMING_PAUSE) * TIMING_READS
            await step("timing", "Read timing", self.timing, needs=("session",), timeout=timing_limit)
        finally:
            await self._close()
        return await self.checker.finish()

    # -- helpers ------------------------------------------------------------------------------------------------------------

    def _target(self) -> tuple[str, int]:
        found = url_host_port(self.config.endpoint)
        if found is None:
            raise StepFailed(
                "the endpoint URL has no usable host name or port", summary="bad endpoint URL", error_class="ConfigError",
                hint="Write the endpoint like opc.tcp://host:4840/path, exactly as the SCADA team gives it.",
            )
        host, port, _scheme = found
        return host, 4840 if port is None else port

    def _wanted(self) -> tuple[str, str]:
        """(policy, mode) the source is configured for, as named in the endpoint list."""
        return ("None", "None") if self.config.security_policy == "none" else ("Basic256Sha256", "SignAndEncrypt")

    @staticmethod
    def _policy(endpoint: Any) -> str:
        return str(endpoint.SecurityPolicyUri or "").rpartition("#")[2] or "None"

    def _matching(self) -> list[Any]:
        policy, mode = self._wanted()
        return [
            e for e in self.endpoints or []
            if self._policy(e) == policy and _enum_name(ua.MessageSecurityMode, e.SecurityMode) == mode
        ]

    def _session_client(self) -> Client:
        if self.client is None:
            raise StepFailed("no session is open", error_class="CheckFailed")
        return self.client

    async def _read(self, nodeids: list[ua.NodeId], attr: ua.AttributeIds = ua.AttributeIds.Value) -> list[ua.DataValue]:
        client = self._session_client()
        return await client.read_attributes([client.get_node(nodeid) for nodeid in nodeids], attr)

    async def _read_value(self, nodeid: ua.NodeId) -> Any:
        """The value of one node; raises the status as an error when the server says it is not good."""
        data_value = (await self._read([nodeid]))[0]
        if data_value.StatusCode_ is not None:
            data_value.StatusCode_.check()
        return data_value.Value.Value if data_value.Value is not None else None

    async def _close(self) -> None:
        client, self.client = self.client, None
        if client is None:
            return
        await close_quietly(client, self.config.timeout_seconds)  # the session may be half open, or already gone

    # -- steps --------------------------------------------------------------------------------------------------------------

    async def dns(self) -> StepOutcome:
        host, port = self._target()
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(str(info[4][0]) for info in infos))
        self.checker.add_names(hosts=[host])
        summary = f"{host} resolves to {', '.join(addresses[:4])}"
        if _is_ip(host):
            summary = f"{host} is an IP address, no name lookup needed"
        return StepOutcome(summary, {"host": host, "port": port, "addresses": addresses[:10]})

    async def tcp(self) -> StepOutcome:
        host, port = self._target()
        _reader, writer = await asyncio.open_connection(host, port)
        try:
            peer = writer.get_extra_info("peername")
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
        return StepOutcome(f"connected to {_hostport(host, port)}", {"remote_address": str(peer[0]) if peer else None})

    async def get_endpoints(self) -> StepOutcome:
        client = ReportingClient(self.config.endpoint, timeout=self.config.timeout_seconds)
        endpoints = await client.connect_and_get_server_endpoints()
        self.endpoints = list(endpoints)
        rows = []
        for endpoint in self.endpoints:
            tokens = [_enum_name(ua.UserTokenType, token.TokenType) for token in endpoint.UserIdentityTokens or []]
            rows.append({
                "url": endpoint.EndpointUrl, "policy": self._policy(endpoint),
                "mode": _enum_name(ua.MessageSecurityMode, endpoint.SecurityMode),
                "user_tokens": tokens, "security_level": endpoint.SecurityLevel,
            })
            self.checker.add_names(hosts=[_url_host(endpoint.EndpointUrl)])
            application = getattr(endpoint, "Server", None)
            self.checker.add_names(uris=[getattr(application, "ApplicationUri", None) or ""])
        offered = "; ".join(f"{row['policy']}/{row['mode']} [{', '.join(row['user_tokens']) or 'no user tokens'}]" for row in rows)
        policy, mode = self._wanted()
        auth = "UserName" if self.config.username else "Anonymous"
        auth_words = "user name and password" if self.config.username else "anonymous"
        detail = {"endpoints": rows[:20], "configured": {"policy": policy, "mode": mode, "authentication": auth_words}}
        matching = self._matching()
        if not matching:
            raise StepFailed(
                f"the server does not offer {policy}/{mode} (configured): it offers {offered or 'nothing'}",
                summary=_clip(f"configured {policy}/{mode} is not offered; offered: {offered or 'nothing'}"),
                hint_key="BadSecurityPolicyRejected", error_class="ConfigMismatch", detail=detail,
            )
        if not any(auth in [_enum_name(ua.UserTokenType, t.TokenType) for t in e.UserIdentityTokens or []] for e in matching):
            raise StepFailed(
                f"the {policy}/{mode} endpoint does not accept {auth_words} (configured)",
                summary=_clip(f"{auth_words} not accepted on {policy}/{mode}; offered: {offered}"),
                hint_key="BadIdentityTokenInvalid" if self.config.username else None,
                hint=None if self.config.username else (
                    "The endpoint wants a user name and password and the source has none. Ask the SCADA team for a read-only "
                    "account and enter it on the source."
                ),
                error_class="ConfigMismatch", detail=detail,
            )
        summary = f"{len(rows)} endpoint(s); configured {policy}/{mode} with {auth_words} is offered. Offered: {offered}"
        return StepOutcome(_clip(summary), detail)

    async def certificates(self) -> StepOutcome:
        """Our client certificate (public part only, never the key) and the one the server presents."""
        now = datetime.now(timezone.utc)
        detail: dict[str, Any] = {}
        parts: list[str] = []
        problem: StepFailed | None = None

        if self.config.security_policy == "none":
            parts.append("our certificate: not used (security policy none)")
            detail["client"] = {"used": False}
        else:
            path = self.config.client_cert
            detail["client"] = {"used": True, "key_file_present": Path(self.config.client_key).is_file()}
            try:
                if not Path(path).is_file():
                    raise FileNotFoundError(path)
                facts = certificate_facts(await load_certificate(path), now)
            except FileNotFoundError:
                parts.append("our certificate: file not found")
                problem = StepFailed(f"client certificate not found: {path}", error_class="FileNotFoundError", hint=_CERT_FILE_HINT)
            except Exception as exc:  # noqa: BLE001 - whatever is wrong with the file is the finding
                parts.append(f"our certificate: cannot be read ({type(exc).__name__})")
                problem = StepFailed(f"client certificate cannot be read: {type(exc).__name__}", error_class=type(exc).__name__)
            else:
                detail["client"].update(facts)
                uri = f"URI {facts['application_uri']}" if facts["application_uri"] else "no URI"  # the server compares it with ours
                parts.append(
                    f"our certificate {facts['common_name'] or facts['subject']}, SHA-1 thumbprint {facts['thumbprint_sha1']}, "
                    f"{uri}, {_validity_words(facts)}"
                )
                self._add_certificate_names(facts)
                if facts["expired"] or facts["not_yet_valid"]:
                    problem = StepFailed(
                        f"the client certificate is {'expired' if facts['expired'] else 'not valid yet'} "
                        f"({facts['not_before'][:10]} to {facts['not_after'][:10]})",
                        status_name=None, hint_key="BadCertificateTimeInvalid", error_class="CertificateTimeInvalid",
                    )
                elif facts["days_left"] < CERT_WARN_DAYS:
                    parts[-1] += " - renew it soon"

        parts.append(await self._server_certificate(detail))
        summary = _clip("; ".join(parts), 600)
        if problem is not None:
            problem.summary, problem.detail = summary, detail
            raise problem
        return StepOutcome(summary, detail)

    def _add_certificate_names(self, facts: dict[str, Any]) -> None:
        self.checker.add_names(hosts=[facts["common_name"] or "", *facts["dns_names"], *facts["ip_addresses"]], uris=facts["uris"])

    async def _server_certificate(self, detail: dict[str, Any]) -> str:
        if self.endpoints is None:
            detail["server"] = {"checked": False}
            return "server certificate: not checked (no endpoint list)"
        candidates = [e for e in [*self._matching(), *self.endpoints] if getattr(e, "ServerCertificate", None)]
        if not candidates:
            detail["server"] = {"offered": False}
            return "server certificate: none offered"
        try:
            facts = certificate_facts(uacrypto.x509_from_der(candidates[0].ServerCertificate))
        except Exception as exc:  # noqa: BLE001
            detail["server"] = {"offered": True, "readable": False}
            return f"server certificate: cannot be read ({type(exc).__name__})"
        host, _port = self._target()
        match = host_matches(facts, host)
        facts["host_matches_url"] = match
        facts["trust"] = (
            "not checked: this client keeps no trust list; whether the server trusts OUR certificate shows at the session step"
        )
        detail["server"] = {"offered": True, **facts}
        self._add_certificate_names(facts)
        host_words = {True: f"names {host}", False: f"does NOT name {host}", None: "names no host"}[match]
        return f"server certificate {facts['common_name'] or facts['subject']}, {_validity_words(facts)}, {host_words}"

    async def open_session(self) -> StepOutcome:
        try:
            self.client = await self.connector._new_client()
            await self.client.connect()
        except ua.UaError as exc:
            self.client = None  # asyncua has already closed what it opened
            if str(exc).startswith("No matching endpoints"):  # asyncua's own refusal, before any request: no status code, no hint
                raise StepFailed(str(exc), error_class=type(exc).__name__, hint_key="BadSecurityPolicyRejected") from exc
            raise
        except Exception:
            self.client = None
            raise
        auth = "user name and password" if self.config.username else "anonymous"
        policy, mode = self._wanted()
        return StepOutcome(f"session opened ({policy}/{mode}, {auth})", {"policy": policy, "mode": mode, "authentication": auth})

    async def server_time(self) -> StepOutcome:
        before = _local_now()
        data_value = (await self._read([_SERVER_TIME]))[0]
        after = _local_now()
        if data_value.StatusCode_ is not None:
            data_value.StatusCode_.check()
        server = data_value.Value.Value if data_value.Value is not None else None
        if not isinstance(server, datetime):
            raise StepFailed("the server did not return its time", error_class="CheckFailed")
        skew = self.checker.clock(server, before + (after - before) / 2)
        detail = {"server_time": self.checker.result.server_time, "local_time": self.checker.result.local_time, "skew_seconds": skew}
        words = f"{abs(skew):.0f} s {'ahead of' if skew > 0 else 'behind'} ours"
        if abs(skew) > SKEW_FAIL_SECONDS:
            raise StepFailed(
                f"the server's clock is {words}", summary=f"clock difference {skew:+.0f} s", hint_key=CLOCK_SKEW,
                error_class="ClockSkew", detail=detail,
            )
        if abs(skew) > SKEW_WARN_SECONDS:
            return StepOutcome(f"the server's clock is {words}: more than {SKEW_WARN_SECONDS:.0f} s, check both clocks", detail)
        return StepOutcome(f"the server's clock is {abs(skew):.1f} s {'ahead of' if skew > 0 else 'behind'} ours", detail)

    async def read_namespaces(self) -> StepOutcome:
        value = await self._read_value(_NAMESPACES)
        if not isinstance(value, list):
            raise StepFailed("the server did not return a namespace array", error_class="CheckFailed")
        self.namespaces = [str(item) for item in value]
        self.checker.add_names(uris=[uri for uri in self.namespaces if uri != _STANDARD_NAMESPACE])
        listing = ", ".join(f"{index}={uri}" for index, uri in enumerate(self.namespaces))
        detail = {"namespaces": [{"index": index, "uri": uri} for index, uri in enumerate(self.namespaces[:50])]}
        return StepOutcome(_clip(f"{len(self.namespaces)} namespace(s): {listing}"), detail)

    async def _plan(self) -> tuple[int | None, int, list[tuple[str, ua.NodeId]], list[dict[str, Any]]]:
        """(the server's MaxNodesPerRead or None, the chunk size to use, the (address, node id) pairs that parse, rows for the
        addresses that do not). The limit is asked once."""
        if self._plan_cache is not None:
            return self._plan_cache
        limit: int | None
        try:
            value = await self._read_value(_MAX_NODES_PER_READ)
            limit = value if isinstance(value, int) and not isinstance(value, bool) else None
        except Exception:  # noqa: BLE001 - an unreadable limit means the default
            limit = None
        chunk = slice_size(limit, MAX_CHUNK)  # the rule the poll uses too (its cap is larger); 0 means "no limit"
        valid: list[tuple[str, ua.NodeId]] = []
        invalid: list[dict[str, Any]] = []
        # The check reads what the poll reads. With the option on that is the stable form of each address (a pair of stored
        # strings that are one tag is not read: a BAD row, as in the poll); the row keeps the STORED string. Option off: as stored.
        if self.config.stable_addresses:
            plan = read_plan(self.points, stable_address)
            wanted = list(plan.sent)
            invalid.extend({"address": stored, "good": False, "status": status} for stored, status in plan.refused.items())
        else:
            wanted = [(address, address) for address in self.points]
        for address, to_parse in wanted:
            try:
                valid.append((address, ua.NodeId.from_string(to_parse)))
            except Exception as exc:  # noqa: BLE001
                invalid.append({"address": address, "good": False, "status": f"invalid node id ({type(exc).__name__})"})
        self._plan_cache = (limit, chunk, valid, invalid)
        return self._plan_cache

    @staticmethod
    def _read_budget(timeout: float, valid: int, chunk: int) -> float:
        """What the read_points step may take: `timeout` for each request it can send (the values, the data types and the access
        levels of every chunk, plus two spare)."""
        return timeout * (2 + 3 * math.ceil(valid / chunk))

    async def read_points(self) -> StepOutcome:
        if not self.points:
            return StepOutcome("no points are mapped to this source: nothing to read")
        limit, chunk, valid, rows = await self._plan()
        budget = self._read_budget(self.config.timeout_seconds, len(valid), chunk)
        requests = 0
        try:
            async with asyncio.timeout(budget):
                for start in range(0, len(valid), chunk):
                    batch = valid[start : start + chunk]
                    nodeids = [nodeid for _address, nodeid in batch]
                    values = await self._read(nodeids, ua.AttributeIds.Value)
                    requests += 1
                    types = await self._read_optional(nodeids, ua.AttributeIds.DataType)
                    levels = await self._read_optional(nodeids, ua.AttributeIds.AccessLevel)
                    requests += 2
                    now = _local_now()
                    for (address, nodeid), data_value, data_type, level in zip(batch, values, types, levels, strict=True):
                        rows.append(self._point_row(address, nodeid, now, data_value, data_type, level))
        except TimeoutError:
            raise StepFailed(f"no answer within {budget:g} s", error_class="TimeoutError") from None
        bad = [row for row in rows if not row["good"]]
        good = [row for row in rows if row["good"]]
        listed = [*bad, *good][:MAX_POINT_LINES]
        detail = {
            "points": listed, "more": max(0, len(rows) - len(listed)), "good": len(good), "bad": len(bad),
            "chunk_size": chunk, "server_max_nodes_per_read": limit, "requests": requests,
        }
        summary = f"read {len(rows)} point(s) in {requests} request(s) of up to {chunk} node(s): {len(good)} good, {len(bad)} bad"
        first: dict[str, str] = {}  # each distinct bad status with the first point that answered it
        for row in bad:
            first.setdefault(_status_name(row["status"]), row["address"])
        kinds = list(first.items())[:MAX_BAD_KINDS]
        if bad:
            summary += "; bad: " + "; ".join(f"{name} {_clip(address, 40)}" for name, address in kinds)
            summary += f" (+{len(first) - len(kinds)} more kinds)" if len(first) > len(kinds) else ""
        detail["bad_status"] = sum(1 for row in bad if _status_name(row["status"]).startswith("Bad"))  # a Bad code, not "non-numeric"
        return StepOutcome(_clip(summary), detail, _read_hints(kinds))

    async def _read_optional(self, nodeids: list[ua.NodeId], attr: ua.AttributeIds) -> list[ua.DataValue | None]:
        """An attribute for each node, or Nones when the server cannot say: it is extra information, not the point of the step."""
        try:
            return list(await self._read(nodeids, attr))
        except ua.UaError:
            return [None] * len(nodeids)

    def _point_row(
        self, address: str, nodeid: ua.NodeId, now: datetime, data_value: ua.DataValue,
        data_type: ua.DataValue | None, level: ua.DataValue | None,
    ) -> dict[str, Any]:
        reading = _point_value(address, now, data_value)
        good = reading.quality == GOOD
        code = data_value.StatusCode_
        status = reading.status or (_status_text(code) if code is not None else "Good")
        value = data_value.Value.Value if data_value.Value is not None else None
        row: dict[str, Any] = {
            "address": address, "good": good, "status": status, "value": None if value is None else _clip(str(value), 40),
            "source_time": _iso(data_value.SourceTimestamp), "server_time": _iso(data_value.ServerTimestamp),
            "data_type": self._type_name(data_type), "access": self._access_text(level),
        }
        index = nodeid.NamespaceIndex
        if not good and self.namespaces is not None and index >= len(self.namespaces):
            row["note"] = f"namespace index {index} does not exist on the server (it has {len(self.namespaces)})"
        return row

    @staticmethod
    def _type_name(data_value: ua.DataValue | None) -> str | None:
        node = data_value.Value.Value if data_value is not None and data_value.Value is not None else None
        if not isinstance(node, ua.NodeId):
            return None
        if node.NamespaceIndex == 0 and isinstance(node.Identifier, int):
            return ua.ObjectIdNames.get(node.Identifier) or node.to_string()
        return node.to_string()

    @staticmethod
    def _access_text(data_value: ua.DataValue | None) -> str | None:
        level = data_value.Value.Value if data_value is not None and data_value.Value is not None else None
        if not isinstance(level, int):
            return None
        read, write = bool(level & 1), bool(level & 2)
        if read:
            return "read/write" if write else "read"
        return "write only" if write else "no access"

    async def timing(self) -> StepOutcome:
        _limit, chunk, valid, _invalid = await self._plan()
        nodeids = [nodeid for _address, nodeid in valid][: min(TIMING_NODES, chunk)] or [_SERVER_TIME]
        durations: list[float] = []
        for index in range(TIMING_READS):
            if index:
                await asyncio.sleep(TIMING_PAUSE)
            started = time.perf_counter()
            await self._read(nodeids, ua.AttributeIds.Value)
            durations.append((time.perf_counter() - started) * 1000)
        low, high, mean = min(durations), max(durations), sum(durations) / len(durations)
        summary = f"{len(durations)} reads of {len(nodeids)} node(s): min {low:.0f} ms, avg {mean:.0f} ms, max {high:.0f} ms"
        return StepOutcome(summary, {"reads_ms": [round(item, 1) for item in durations], "nodes": len(nodeids)})


async def run_check(connector: OpcUaConnector, points: list[str], publish: Publish | None = None) -> CheckResult:
    return await OpcUaCheck(connector, points, publish).run()
