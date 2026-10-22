"""Where a source points, and how to show that without a secret (w33 P8, F10). Pure: no database, no network.

`address_key` is the place the matcher compares (host lower-cased, port, path). `display_endpoint` is what a person may read about
it: built ONLY from the scheme, the host, the port and the path of the stored URL, never from its user info, query or fragment, so
no answer, audit row or journal text that quotes it can carry a credential. Both are tolerant of junk: a config nobody can read
gives None / a cut, scrubbed text, never an error.
"""
from collections.abc import Mapping
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


def _junk(value: str, config: Mapping[str, Any]) -> str:
    """A stored value that is not a URL we can read, safe to show: scrubbed first (so half a password cannot survive the cut),
    with nothing kept before its last "@", without a query or fragment, and cut."""
    text = scrub_url_credentials(value, hidden_values(config))
    if "@" in text.replace("://[hidden]@", ""):  # user info that the scrub's position rule did not find (no "://")
        text = "[hidden]" + text[text.rindex("@"):]
    for mark in ("?", "#"):
        text = text.partition(mark)[0]
    return text[:MAX_JUNK]
