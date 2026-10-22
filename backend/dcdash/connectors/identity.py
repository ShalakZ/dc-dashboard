"""Who a server says it is: pure helpers, no I/O, standard library only.

An OPC UA server names itself in its GetEndpoints answer (application URI, product URI, application name, certificate); the HTTP
simulator names itself with its instance id. A source remembers this so that, when the same server turns up at another address,
the platform can offer to move the old source there. Nothing here talks to a server or to the database, and nothing stores or
returns a certificate: only its thumbprint (the SHA-1 of its DER form, the number OPC UA tools show).
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from typing import Any

# The application URIs that stacks ship with when nobody sets one: many different servers say the same thing, so it identifies none.
# Lower case; a server's text is lowered and stripped before it is compared.
DEFAULT_URIS = frozenset({
    "urn:freeopcua:python:server",
    "urn:open62541.server.application",
    "urn:unconfigured:application",
})
MAX_TEXT = 256  # characters kept of any text a server reports: it is stored, and a server is not trusted to be short

_MAX_LENGTH_BYTES = 4  # a certificate longer than 4 GiB is junk; this also keeps a hostile length field from asking for more


def clip(value: object) -> str | None:
    """A text a server reported, ready to store: stripped, without NUL (a JSON column cannot hold it), at most `MAX_TEXT`
    characters; None for anything that is not text or is empty."""
    if not isinstance(value, str):
        return None
    text = value.replace("\x00", "").strip()[:MAX_TEXT].rstrip()
    return text or None


def first_certificate_der(blob: object) -> bytes | None:
    """The first certificate of `blob`, exactly. A DER chain is certificates one after the other, each an ASN.1 SEQUENCE (tag 0x30)
    with a short or long form length; read the header of the first and cut there. None for empty, truncated or anything else."""
    if not isinstance(blob, (bytes, bytearray, memoryview)):
        return None
    data = bytes(blob)
    if len(data) < 2 or data[0] != 0x30:
        return None
    first = data[1]
    if first < 0x80:
        header, length = 2, first
    else:
        count = first & 0x7F
        if count == 0 or count > _MAX_LENGTH_BYTES or len(data) < 2 + count:  # the indefinite form (0x80) is not DER
            return None
        header, length = 2 + count, int.from_bytes(data[2:2 + count], "big")
    end = header + length
    if length == 0 or end > len(data):
        return None
    return data[:end]


def thumbprint_of(blob: object) -> str | None:
    """SHA-1 of the first certificate in `blob` as upper-case hex pairs joined by colons (`AB:CD:...`), or None."""
    der = first_certificate_der(blob)
    if der is None:
        return None
    digest = hashlib.sha1(der).hexdigest().upper()  # noqa: S324 - OPC UA's certificate thumbprint is a SHA-1; it names, it does not protect
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


def _text(value: object) -> object:
    """The text of an OPC UA LocalizedText (its `.Text`); a plain string is itself."""
    return value if isinstance(value, str) else getattr(value, "Text", None)


def from_endpoints(endpoints: Iterable[Any] | None) -> dict[str, str]:
    """What a GetEndpoints answer says about the server, as `application_uri`, `application_name`, `product_uri`, `thumbprint`.

    Per field the first non-empty value among the endpoints wins, and a field nobody filled is left out. Tolerant of None and of
    missing attributes: this reads whatever a server sent and never raises.
    """
    found: dict[str, str] = {}
    try:
        items = list(endpoints) if endpoints is not None else []
    except TypeError:
        return found
    for endpoint in items:
        server = getattr(endpoint, "Server", None)
        reported = (
            ("application_uri", getattr(server, "ApplicationUri", None)),
            ("application_name", _text(getattr(server, "ApplicationName", None))),
            ("product_uri", getattr(server, "ProductUri", None)),
            ("thumbprint", thumbprint_of(getattr(endpoint, "ServerCertificate", None))),
        )
        for key, value in reported:
            if key not in found and (text := clip(value)) is not None:
                found[key] = text
    return found


def is_default_uri(uri: object) -> bool:
    """True for an application URI that a stack ships with (compared lower-cased and stripped); False for anything else, empty too."""
    return isinstance(uri, str) and uri.strip().lower() in DEFAULT_URIS


def usable_key(connector_type: str | None, identity: object) -> tuple[str, str] | None:
    """What two sources are compared on, or None when this identity cannot tell servers apart.

    OPC UA: `("uri", application_uri)` unless it is empty or a default. The HTTP simulator: `("instance", id)`. Every other type
    (Modbus, files) has none, so it is never offered a move.
    """
    if not isinstance(identity, dict):
        return None
    if connector_type == "opcua":
        uri = identity.get("application_uri")
        if isinstance(uri, str) and uri.strip() and not is_default_uri(uri):
            return "uri", uri.strip()
    elif connector_type == "simulator":
        instance = identity.get("instance")
        if isinstance(instance, str) and instance.strip():
            return "instance", instance.strip()
    return None


def thumbprints_conflict(a: object, b: object) -> bool:
    """True when both thumbprints are present and differ (case does not matter); a missing one never conflicts."""
    if not isinstance(a, str) or not isinstance(b, str) or not a.strip() or not b.strip():
        return False
    return a.strip().upper() != b.strip().upper()
