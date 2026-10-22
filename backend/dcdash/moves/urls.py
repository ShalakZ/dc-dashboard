"""Where a source points, and how to show that without a secret (w33 P8, F10). Pure: no database, no network.

`address_key` is the place the matcher compares (host lower-cased, port, path). `display_endpoint` is what a person may read about
it: built ONLY from the scheme, the host, the port and the path of the stored URL, never from its user info, query or fragment, so
no answer, audit row or journal text that quotes it can carry a credential. Both are tolerant of junk: a config nobody can read
gives None / a cut, scrubbed text, never an error. `swap_host_port` (built on `put_authority`) is the one writer: it changes the host
and port of a stored URL and nothing else; `authority_of` reads the host[:port] text exactly as stored, so an Undo can write it back
byte for byte; `label_for`, `is_default_name` and `unique_name` are the naming rule of a move (R6).
"""
import re
from collections.abc import Collection, Mapping
from typing import Any
from urllib.parse import urlsplit

from dcdash.connectors.base import connector_types
from dcdash.core.audit import hidden_values, scrub_url_credentials

# The only connector types whose address is one URL, and the config key that holds it. Everything else has no place to move to.
URL_KEYS = {"opcua": "endpoint", "simulator": "url"}
MAX_JUNK = 80  # characters shown of a value nobody can parse


def address_key(connector_type: str | None, config: Any) -> tuple[str, int, str] | None:
    """(host lower-cased, port, path) the source points at, or None when it has no readable address or cannot move.

    OPC UA: the host and port of `endpoint` (the default port 4840 when it has none) and its path, `/` when it has none (an empty
    path and `/` are the same place). The simulator: the host and port of `url` (80 or 443 by scheme when it has none), path "".
    Modbus and every other type: None.
    """
    if URL_KEYS.get(connector_type or "") is None or not isinstance(config, dict):
        return None
    cls = connector_types().get(connector_type or "")
    found = cls.endpoint_key(config) if cls is not None else None
    if found is None:
        return None
    path = ""
    if connector_type == "opcua":
        try:
            path = urlsplit(config["endpoint"]).path or "/"
        except (KeyError, TypeError, ValueError):
            return None
    return found[0].lower(), found[1], path


def display_endpoint(connector_type: str | None, config: Any) -> str:
    """`scheme://host:port/path` of the source's URL, from those four parts only (an IPv6 host in brackets, the effective port
    always shown, the simulator without a path). A URL that cannot be read, or whose "@" is not all in the part where user info
    lives (an unencoded "/" in a password ends that part early), is shown cut at `MAX_JUNK` characters and scrubbed. "" when
    the config holds no text at all."""
    key = URL_KEYS.get(connector_type or "")
    value = config.get(key) if key is not None and isinstance(config, Mapping) else None
    if not isinstance(value, str):
        return ""
    where = address_key(connector_type, config)
    if where is not None:
        try:
            parts = urlsplit(value)
        except ValueError:  # cannot happen when `address_key` found a host; a hostile value is junk, not a crash
            parts = None
        if parts is not None and parts.scheme and value.count("@") == parts.netloc.count("@"):
            host = f"[{where[0]}]" if ":" in where[0] else where[0]
            path = parts.path if connector_type == "opcua" else ""
            return f"{parts.scheme.lower()}://{host}:{where[1]}{path}"
    return _junk(value, config if isinstance(config, Mapping) else {})


class CannotRewrite(ValueError):
    """The stored address cannot be rewritten safely. The text is for a person and never quotes the address (it may hold a password)."""


def swap_host_port(url: str, host: str, port: int) -> str:
    """`url` with ONLY the host and port of its authority replaced (w33 P8, F-M4).

    The user info (everything before the LAST "@" of the authority) is kept verbatim, and so are the scheme, the path, the query and
    the fragment: the text outside the authority is not parsed and written again, so an empty "?" survives. An IPv6 host is put in
    brackets when the NEW host is IPv6 (it has a ":" in it), whatever the old one was. Raises `CannotRewrite` for a URL without a
    host, for one whose "@" is not all inside the authority (an unencoded "/" in a password ends the authority early: the host cannot
    be told from the password), and for a port or host that cannot be written."""
    host = host.strip().strip("[]")
    if not host or any(char in host for char in "/?#@ \t\r\n") or not 1 <= port <= 65535:
        raise CannotRewrite("the new address cannot be written into this source")
    shown = f"[{host}]" if ":" in host else host
    return put_authority(url, f"{shown}:{port}")


def _authority_start(url: str) -> tuple[int, str]:
    """(where the authority starts in `url`, the authority as written) of a URL whose authority can be told from its path. Raises
    `CannotRewrite` for a URL without a host and for one whose "@" is not all inside the authority."""
    try:
        parts = urlsplit(url)
    except ValueError:
        raise CannotRewrite("the address of this source cannot be read; edit it by hand") from None
    start = url.find("://") + 3
    if start < 3 or not parts.netloc or not parts.hostname or url[start:start + len(parts.netloc)] != parts.netloc:
        raise CannotRewrite("the address of this source cannot be read; edit it by hand")
    if url.count("@") != parts.netloc.count("@"):
        raise CannotRewrite("the address of this source has a login part that cannot be told from its host; edit it by hand")
    return start, parts.netloc


def _writable(authority: str) -> bool:
    return bool(authority) and not any(char in authority for char in "/?#@ \t\r\n")


def authority_of(url: Any) -> str | None:
    """The host[:port] of a stored URL exactly as it is written (everything after the LAST "@" of the authority): its letter case,
    its brackets, a port that is not there. It never holds user info. None for anything `put_authority` could not write back."""
    if not isinstance(url, str):
        return None
    try:
        _start, netloc = _authority_start(url)
    except CannotRewrite:
        return None
    found = netloc.rpartition("@")[2]
    return found if _writable(found) else None


def put_authority(url: str, authority: str) -> str:
    """`url` with ONLY the host[:port] after the last "@" of its authority replaced by `authority`, written as given (the Undo's way of
    restoring an address byte for byte). The user info, the scheme, the path, the query and the fragment are kept verbatim. Raises
    `CannotRewrite` as `swap_host_port` does (which is built on this)."""
    if not _writable(authority):
        raise CannotRewrite("the new address cannot be written into this source")
    start, netloc = _authority_start(url)
    userinfo, at, _old = netloc.rpartition("@")
    return f"{url[:start]}{userinfo}{at}{authority}{url[start + len(netloc):]}"


# The name a scan gives a source it creates (`Connector.probe`'s label), by connector type. A name equal to one of these is a default
# name; any other was typed by a person and is never changed by a move.
LABELS = {"opcua": "OPC UA server at {host}:{port}", "simulator": "DCDash simulator at {host}:{port}"}


def label_for(connector_type: str | None, host: str, port: int) -> str | None:
    """The default name of a source of this type at this address, None for a type that has none. `host` as written (no brackets)."""
    template = LABELS.get(connector_type or "")
    return None if template is None else template.format(host=host, port=port)


def is_default_name(name: str, connector_type: str | None, host: str, port: int) -> bool:
    """True when `name` is exactly `label_for(...)` for this address, with or without the " (n)" a clash adds (`collector/scan.py
    _insert_source`). Host letters are compared without regard to case (the stored host is lower-cased, a scan's may not be)."""
    label = label_for(connector_type, host, port)
    if label is None:
        return False
    return re.fullmatch(re.escape(label) + r"(?: \(\d+\))?", name, flags=re.IGNORECASE) is not None


def unique_name(base: str, taken: Collection[str]) -> str:
    """`base`, or `base (2)`, `base (3)` ... the first that is not in `taken`: the rule `_insert_source` uses for a scan's names."""
    if base not in taken:
        return base
    attempt = 2
    while f"{base} ({attempt})" in taken:
        attempt += 1
    return f"{base} ({attempt})"


def _junk(value: str, config: Mapping[str, Any]) -> str:
    """A stored value that is not a URL we can read, safe to show: scrubbed first (so half a password cannot survive the cut),
    with nothing kept before its last "@", without a query or fragment, and cut."""
    text = scrub_url_credentials(value, hidden_values(config))
    if "@" in text.replace("://[hidden]@", ""):  # user info that the scrub's position rule did not find (no "://")
        text = "[hidden]" + text[text.rindex("@"):]
    for mark in ("?", "#"):
        text = text.partition(mark)[0]
    return text[:MAX_JUNK]
