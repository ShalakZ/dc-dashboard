"""Redaction, masking and splitting for the diagnostics report: pure functions, no database.

The report is pasted into a chat by a person, so a leak is a leak for good. Three layers, in the order the report builder
applies them:

1. `scrub(text, known)` hides credentials in free text (an exception, a journal message, a job result). `build_known` collects
   the values it must hide: every source's credentials and decrypted secret, the secret key and the database password.
2. `Masker` (only for `mask=1`) replaces network addresses and host names with stable aliases (`HOST-1`, `URN-1`). Free
   text is masked BEFORE it is clipped, and the assembled body is masked once more as a second net with the same Masker.
3. `finalize` splits the masked body into parts and frames each one: a header line, a footer with the size, and after the
   last part `END OF REPORT <checksum>`. `verify_paste` checks a pasted report against that framing.

Known limits, on purpose: a password that is not in `known` and is not inside a `://user:password@host` URL cannot be found;
a known password that a line break splits in two is not found either; a user name is half a credential but is not scrubbed
(a short one would mangle ordinary words). `Masker` finds addresses by shape and host names only from the list it is given.
"""
import hashlib
import ipaddress
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlsplit

from cryptography.fernet import Fernet

from dcdash.core.audit import credentials_in, scrub_url_credentials
from dcdash.core.journal import known_for

MIN_KNOWN = 4  # same floor as scrub_url_credentials: a shorter value would mangle the words around it
CUT = "…"  # the marker clip_error and clip leave where text was cut
FORMAT = "DCDASH-REPORT v1"
PART_LIMIT = 12_000  # characters per part, header and footer included
MAX_BUILD_ID = 64


# --- scrub ---------------------------------------------------------------------------------------------------------------


def scrub(text: str, known: Iterable[str] = ()) -> str:
    """`text` without URL credentials and without any value in `known` (see `scrub_url_credentials`, which does the work).

    The URL rule works on runs of non-space text, so a URL inside JSON, quotes, a traceback or after `urn:` is covered too.
    """
    return scrub_url_credentials(text, known)


def _field(source: Any, name: str) -> Any:
    return source.get(name) if isinstance(source, Mapping) else getattr(source, name, None)


def _database_passwords(database_url: str) -> list[str]:
    """The password of a database URL as it is written in the URL (percent-encoded) and as the server sees it (decoded)."""
    raw = credentials_in(database_url).partition(":")[2]
    return [raw, unquote(raw)] if raw else []


def build_known(
    sources: Iterable[Any], secret_key: str, database_url: str, extra: Iterable[str] = ()
) -> list[str]:
    """The values `scrub` must hide in a report, each of at least MIN_KNOWN characters, without duplicates.

    `sources` are rows or mappings with `config` and `secret` (the stored, Fernet-encrypted secret). A secret that does not
    decrypt with `secret_key` is skipped: it cannot appear in a text if nobody ever had it. The key is passed in, not read
    from the settings, so the function stays pure. `extra` is for anything else the caller knows to be secret.
    """
    try:
        fernet: Fernet | None = Fernet(secret_key.encode())
    except Exception:
        fernet = None
    values: list[str] = []
    for source in sources:
        config, token = _field(source, "config"), _field(source, "secret")
        plain: str | None = None
        if fernet is not None and token:
            try:
                plain = fernet.decrypt(str(token).encode()).decode()
            except Exception:
                plain = None
        values.extend(known_for(config if isinstance(config, Mapping) else {}, plain))
    values.append(secret_key)
    values.extend(_database_passwords(database_url))
    values.extend(extra)
    unique: dict[str, None] = {}
    for value in values:
        if isinstance(value, str) and len(value) >= MIN_KNOWN:
            unique.setdefault(value)
    return list(unique)


# --- cutting text --------------------------------------------------------------------------------------------------------


def drop_cut_token(text: str) -> str:
    """`text` without its last token when it ends with the cut marker and that token has a ".", ":" or "/" in it.

    A cut can leave half an address ("10.1.2" of 10.1.2.3) that no address pattern recognises, so the token goes.
    """
    if not text.endswith(CUT):
        return text
    head = text[: -len(CUT)]
    start = len(head)
    while start > 0 and not head[start - 1].isspace():
        start -= 1
    token = head[start:]
    return head[:start] + CUT if any(c in token for c in ".:/") else text


def clip(text: str, limit: int) -> str:
    """`text` cut to at most `limit` characters, the cut marked with "…"; a token the cut leaves half of is dropped."""
    if len(text) <= limit:
        return text
    return drop_cut_token(text[: max(limit, 2) - 1] + CUT)


# --- masking -------------------------------------------------------------------------------------------------------------

HOST, URN = "HOST", "URN"
_ALIAS = re.compile(r"(?:HOST|URN)-(\d+)")  # an alias is reserved: it is never masked again
_MIN_NAME = 3  # a listed name shorter than this would mangle ordinary words; an address of any length is found by its shape

_NAME_CHARS = r"[\w.~%-]"
_URL = re.compile(
    rf"(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*://)((?:[^\s/@?#]*@)?)(\[[^\]\s]*\]|{_NAME_CHARS}+)"
)
_V6_BRACKET = re.compile(r"\[([0-9A-Fa-f:.]{2,64}(?:%[A-Za-z0-9_.-]{1,20})?)\]")
# a bare IPv6 address: a maximal run of hex digits, colons and dots, not glued to a word or to a ":", "." or ";" before it
_V6_RUN = re.compile(r"(?<![\w:.;%/\[-])[0-9A-Fa-f:.]{3,64}(?:%[A-Za-z0-9_.-]{1,20})?(?![\w:])")
# the "s=" of an OPC UA node id such as ns=6;s=::AsGlobalPV:Temp: what follows is an identifier, not a host
_NODE_ID_KEY = re.compile(r"(?:^|[\s\"'(,{;])(?:ns|[isgb])=$")
_IPV4 = re.compile(r"(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)")
_URN = re.compile(rf"(?<![\w.-])(urn:)({_NAME_CHARS}+)", re.IGNORECASE)
_PORT = re.compile(r"(.+):\d{1,5}")
# Names that mean the same on every installation and say nothing about this one: the standard OPC UA namespaces
# (http://opcfoundation.org/UA/...). Hiding them would make namespace 0 unrecognisable.
_PUBLIC = re.compile(r"(?:[a-z][a-z0-9+.-]*://|urn:)?(?:[\w-]+\.)*opcfoundation\.org(?:[/:].*)?", re.IGNORECASE)
_SUFFIX = r"(?:\.[A-Za-z0-9-]+)*"  # a listed short host name also covers the labels of the FQDN it starts
_BRACKET_PORT = re.compile(r"\[([^\]]+)\](?::\d{1,5})?")


def _ipv4(parts: Sequence[str]) -> str | None:
    numbers = [int(p) for p in parts]
    return ".".join(map(str, numbers)) if all(n <= 255 for n in numbers) else None


def _ipv6(candidate: str, *, bracketed: bool = False) -> str | None:
    """The compressed form of an IPv6 address, or None when `candidate` is not one worth masking.

    Outside brackets only the forms with "::" or eight groups count, with at least two groups: a time like 08:38:21 or a
    colon-separated thumbprint is not an address.
    """
    address = candidate.partition("%")[0]
    if ":" not in address:
        return None
    try:
        parsed = ipaddress.IPv6Address(address)
    except ValueError:
        return None
    if not bracketed:
        eight = address.count(":") == 7 or (address.count(":") == 6 and "." in address)
        if "::" not in address and not eight:
            return None
        if len([g for g in address.split(":") if g]) < 2:
            return None
    return parsed.compressed


def _key(value: str) -> str:
    """What makes two spellings one host: IPv4 without leading zeros, IPv6 compressed, a name lower-cased without its final dot."""
    value = value.strip()
    match = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})", value)
    if match and (normal := _ipv4(match.groups())):
        return normal
    if (normal := _ipv6(value.strip("[]"), bracketed=True)) is not None:
        return normal
    return value.casefold().rstrip(".")


def _public(name: str) -> bool:
    return _PUBLIC.fullmatch(name.strip()) is not None


def _is_address(name: str) -> bool:
    key = _key(name)
    return bool(re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", key)) or _ipv6(key, bracketed=True) is not None


def _listed_names(value: str) -> list[str]:
    """The names to hide for one entry of the host list: an endpoint URL or host:port gives its host, a wildcard its domain."""
    value = value.strip()
    if "://" in value:
        try:
            host = urlsplit(value).hostname or ""
        except ValueError:
            host = re.sub(r"^[^/]*//(?:[^/@]*@)?\[?([^\]/:?#]*).*$", r"\1", value)
        value = host
    elif bracketed := _BRACKET_PORT.fullmatch(value):
        value = bracketed.group(1)
    elif (port := _PORT.fullmatch(value)) and ":" not in port.group(1):
        value = port.group(1)
    return [value, value[2:]] if value.startswith("*.") else [value]


class Masker:
    """Replaces host names and network addresses with stable aliases, and remembers which alias stands for what.

    Aliases are `HOST-n` (addresses, hosts, the authority of a `urn:`) and `URN-n` (a whole application URI given in
    `uris`), numbered in the order they are first given or seen, so the same input always gives the same output. One
    Masker is used for a whole report, so the same value has the same alias everywhere.

    Two kinds of match. Names given in `hosts` and `uris` are replaced wherever they stand as a word, whatever the case.
    What the shapes find on their own is replaced in place only: IPv4 and IPv6 addresses, the host of any `scheme://` URL
    and the first segment of any `urn:`. So `http://api:8000` hides the host "api" there, not the word API in a heading. An
    alias is never masked again, which makes `mask(mask(x)) == mask(x)`.

    A text that ends with the cut marker loses its last token when that has a ".", ":" or "/" (`drop_cut_token`).
    """

    def __init__(self, hosts: Iterable[str] = (), uris: Iterable[str] = ()) -> None:
        self._by_key: dict[str, str] = {}
        self._original: dict[str, str] = {}
        self._used: set[str] = set()
        self._count = {HOST: 0, URN: 0}
        self._listed: dict[str, str] = {}  # lower-cased listed name -> alias
        self._pattern: re.Pattern[str] | None = None
        self.add(hosts, uris)

    def add(self, hosts: Iterable[str] = (), uris: Iterable[str] = ()) -> None:
        """List more names to hide everywhere they stand as a word."""
        for kind, values in ((HOST, hosts), (URN, uris)):
            for value in values:
                for name in _listed_names(value) if kind == HOST else [value.strip()]:
                    if len(name) < _MIN_NAME or _ALIAS.fullmatch(name) or _public(name):
                        continue
                    self._listed[name.casefold()] = self._alias(_key(name), name, kind)
        names = sorted(self._listed, key=len, reverse=True)
        # a host name (not an address, not a URI) also covers the labels after it: SCADA01.site.local is one host
        alternatives = "|".join(
            re.escape(name) + ("" if _is_address(name) or ":" in name else _SUFFIX) for name in names
        )
        self._pattern = re.compile(rf"(?<![\w.-])(?:{alternatives})(?![\w-]|\.\d)", re.IGNORECASE) if names else None

    def _alias(self, key: str, original: str, kind: str) -> str:
        alias = self._by_key.get(key)
        if alias is None:
            self._count[kind] += 1
            alias = self._by_key[key] = f"{kind}-{self._count[kind]}"
            self._original[alias] = original
        return alias

    def _use(self, value: str, kind: str = HOST) -> str:
        alias = self._alias(_key(value), value, kind)
        self._used.add(alias)
        return alias

    def legend(self) -> list[dict[str, str]]:
        """The aliases that appear in the masked text, with what each stands for. Show it to the person, never put it in the text."""
        def order(alias: str) -> tuple[str, int]:
            kind, _, number = alias.partition("-")
            return kind, int(number)

        return [{"alias": alias, "original": self._original[alias]} for alias in sorted(self._used, key=order)]

    def mask(self, text: str) -> str:
        if CUT in text:
            text = "\n".join(drop_cut_token(line) for line in text.split("\n"))
        if self._pattern is not None:
            text = self._pattern.sub(self._listed_name, text)
        text = _URL.sub(self._url, text)
        text = _V6_BRACKET.sub(self._bracketed, text)
        text = _V6_RUN.sub(self._bare_v6, text)
        text = _IPV4.sub(self._v4, text)
        return _URN.sub(self._urn, text)

    # each sub callback returns the alias for what it matched, or the match itself when it is not worth masking

    def _listed_name(self, match: re.Match[str]) -> str:
        found = match.group()
        alias = self._listed.get(found.casefold())
        if alias is None:  # a listed name and the labels after it: the whole FQDN gets an alias of its own
            return self._use(found)
        self._used.add(alias)
        return alias

    def _url(self, match: re.Match[str]) -> str:
        scheme, userinfo, host = match.groups()
        # a second net for scrub: nothing before the "@" of a URL survives, whatever happens to the host
        prefix = scheme + ("[hidden]@" if userinfo else "")
        if host.startswith("["):
            if _ipv6(host[1:-1], bracketed=True) is None:
                return prefix + host
            return prefix + self._use(host[1:-1])
        name = host.rstrip(".")
        if not name or _ALIAS.fullmatch(name) or _public(name):  # an alias already, a listed name masked by the first pass, or public
            return prefix + host
        return prefix + self._use(name) + host[len(name) :]

    def _bracketed(self, match: re.Match[str]) -> str:
        return self._use(match.group(1)) if _ipv6(match.group(1), bracketed=True) is not None else match.group()

    def _bare_v6(self, match: re.Match[str]) -> str:
        run, start, text = match.group(), match.start(), match.string
        if start and text[start - 1] == "=" and _NODE_ID_KEY.search(text[max(0, start - 12) : start]):
            return run
        trimmed = run.rstrip(".")  # a sentence may end right after an address
        for candidate in dict.fromkeys([run] if "%" in run else [run, trimmed, trimmed.rstrip(":")]):
            if candidate and _ipv6(candidate) is not None:
                return self._use(candidate) + run[len(candidate) :]
        return run

    def _v4(self, match: re.Match[str]) -> str:
        normal = _ipv4(match.groups())
        return self._use(match.group()) if normal is not None else match.group()

    def _urn(self, match: re.Match[str]) -> str:
        prefix, authority = match.groups()
        name = authority.rstrip(".")
        if not name or _ALIAS.fullmatch(name) or _public(name):
            return match.group()
        return prefix + self._use(name) + authority[len(name):]


def mask_report(body: str, hosts: Iterable[str], uris: Iterable[str] = ()) -> tuple[str, list[dict[str, str]]]:
    """`body` masked by a fresh `Masker`, and its legend. The report builder keeps its own Masker; this is for one-off use."""
    masker = Masker(hosts, uris)
    masked = masker.mask(body)
    return masked, masker.legend()


# --- splitting and framing -----------------------------------------------------------------------------------------------

_HEADER_RE = re.compile(rf"{re.escape(FORMAT)} \| PART (\d+) OF (\d+) \| build (.*) \| (\S+)")
_FOOTER_RE = re.compile(r"--- PART (\d+) OF (\d+) \| chars=(\d+) lines=(\d+) ---")
_END_RE = re.compile(r"END OF REPORT ([0-9a-f]{12})")
_MAX_PARTS = 999


def normalise_newlines(text: str) -> str:
    """CRLF and lone CR become LF: a paste through Windows changes the line breaks, never the report."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def checksum_of(bodies: Sequence[str]) -> str:
    """The first 12 hex digits of the SHA-256 of the part bodies (no header, no footer) joined by LF, as UTF-8."""
    return hashlib.sha256("\n".join(bodies).encode("utf-8")).hexdigest()[:12]


def split_parts(body: str, limit: int = PART_LIMIT) -> list[str]:
    """`body` cut into pieces of at most `limit` characters, on line boundaries, rejoinable with "\\n" into the body.

    When the next line does not fit, the cut goes before the last section start (a line beginning with "== ") that is in the
    piece, so a section is kept whole when it can be; if there is none the cut goes there. A single line longer than `limit`
    is cut every `limit` characters (the only case where rejoining adds line breaks). An empty body gives one empty piece.
    """
    lines: list[str] = []
    for line in normalise_newlines(body).split("\n"):
        lines.extend([line[i : i + limit] for i in range(0, len(line), limit)] or [""])
    pieces: list[list[str]] = []
    current: list[str] = []
    size = 0  # characters of "\n".join(current)

    def joined(items: list[str]) -> int:
        return sum(map(len, items)) + max(len(items) - 1, 0)

    for line in lines:
        while current and size + 1 + len(line) > limit:
            sections = [j for j in range(1, len(current)) if current[j].startswith("== ")]
            cut = sections[-1] if sections else len(current)
            pieces.append(current[:cut])
            current = current[cut:]
            size = joined(current)
        current.append(line)
        size = joined(current) if len(current) == 1 else size + 1 + len(line)
    pieces.append(current)
    return ["\n".join(piece) for piece in pieces]


@dataclass(frozen=True)
class Part:
    """One framed part. `chars` is the length of the body without line breaks and `lines` its line count: the numbers
    in the part's footer, over the same text the checksum covers (everything between the header and the footer)."""

    index: int
    of: int
    text: str
    chars: int
    lines: int


@dataclass(frozen=True)
class Parts:
    parts: tuple[Part, ...]
    checksum: str
    build_id: str

    def text(self) -> str:
        """All parts, one blank line between them."""
        return "\n\n".join(part.text for part in self.parts)


def _size(body: str) -> tuple[int, int]:
    return len(body.replace("\n", "")), (body.count("\n") + 1 if body else 0)


def _one_line(text: str, limit: int) -> str:
    return re.sub(r"[\r\n|]+|\s+", "_", text.strip())[:limit]


def finalize(body: str | Sequence[str], build_id: str, generated_utc: str | datetime, *, limit: int = PART_LIMIT) -> Parts:
    """Splits the (already masked) `body` and frames every part; the sizes and the checksum are computed here, after masking.

    `body` is the whole text; a list of pieces (what `split_parts` returns) is joined with "\\n" first and split again, because
    the pieces of `split_parts(body)` leave no room for the header and footer.

    A part is `DCDASH-REPORT v1 | PART i OF n | build <id> | <generated UTC>`, its body, and
    `--- PART i OF n | chars=N lines=N ---`; the last part ends with `END OF REPORT <checksum>`. A whole part, header and
    footer included, is at most `limit` characters. The build id is cut to 64 characters and loses any "|".
    """
    if not isinstance(body, str):
        body = "\n".join(body)
    stamp = (
        generated_utc.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if isinstance(generated_utc, datetime)
        else _one_line(generated_utc, 40)
    )
    build_id = _one_line(build_id, MAX_BUILD_ID)
    digits = len(str(limit))
    reserve = (
        len(f"{FORMAT} | PART {_MAX_PARTS} OF {_MAX_PARTS} | build {build_id} | {stamp}")
        + len(f"--- PART {_MAX_PARTS} OF {_MAX_PARTS} | chars={'9' * digits} lines={'9' * digits} ---")
        + len("END OF REPORT ") + 12
        + 3  # the line breaks around the body, the footer and the end line
    )
    if limit - reserve < 200:
        raise ValueError(f"a part limit of {limit} leaves no room for the header and footer")
    bodies = split_parts(body, limit - reserve)
    if len(bodies) > _MAX_PARTS:
        raise ValueError(f"the report needs {len(bodies)} parts")
    checksum = checksum_of(bodies)
    parts = []
    for number, part_body in enumerate(bodies, start=1):
        chars, lines = _size(part_body)
        pieces = [f"{FORMAT} | PART {number} OF {len(bodies)} | build {build_id} | {stamp}"]
        if part_body:
            pieces.append(part_body)
        pieces.append(f"--- PART {number} OF {len(bodies)} | chars={chars} lines={lines} ---")
        if number == len(bodies):
            pieces.append(f"END OF REPORT {checksum}")
        text = "\n".join(pieces)
        assert len(text) <= limit
        parts.append(Part(number, len(bodies), text, chars, lines))
    return Parts(tuple(parts), checksum, build_id)


@dataclass(frozen=True)
class Verification:
    ok: bool
    problems: tuple[str, ...]
    parts: int
    checksum: str | None


def verify_paste(text: str) -> Verification:
    """Checks a pasted report against its own framing: every part has its header and footer, the sizes in the footers are
    right, the parts are numbered 1..n and the final checksum matches the bodies. Line breaks are normalised first, so a
    paste that went through Windows (CRLF) verifies like the original."""
    problems: list[str] = []
    bodies: list[list[str]] = []
    numbers: list[tuple[int, int]] = []
    current: tuple[int, int, list[str]] | None = None
    claimed: str | None = None
    for line in normalise_newlines(text).split("\n"):
        if current is None:
            if header := _HEADER_RE.fullmatch(line):
                current = (int(header[1]), int(header[2]), [])
            elif end := _END_RE.fullmatch(line):
                claimed = end[1]
            elif line.strip():
                problems.append(f"text outside any part: {line[:40]!r}")
            continue
        index, of, body = current
        if (footer := _FOOTER_RE.fullmatch(line)) and (int(footer[1]), int(footer[2])) == (index, of):
            chars, lines = _size("\n".join(body))
            if (int(footer[3]), int(footer[4])) != (chars, lines):
                problems.append(f"part {index}: the footer says chars={footer[3]} lines={footer[4]}, the text has chars={chars} lines={lines}")
            bodies.append(body)
            numbers.append((index, of))
            current = None
        else:
            body.append(line)
    if current is not None:
        problems.append(f"part {current[0]} has no footer: the paste is cut off")
    if not bodies:
        problems.append("no part found")
    elif [n for n, _ in numbers] != list(range(1, len(bodies) + 1)) or {of for _, of in numbers} != {len(bodies)}:
        problems.append(f"the parts are numbered {numbers}, expected 1..{len(bodies)} of {len(bodies)}")
    joined = ["\n".join(body) for body in bodies]
    checksum = checksum_of(joined) if joined else None
    if claimed is None:
        problems.append("no END OF REPORT line: the paste is cut off")
    elif checksum is not None and claimed != checksum:
        problems.append(f"the checksum is {claimed}, the text gives {checksum}")
    return Verification(not problems, tuple(problems), len(bodies), checksum)
