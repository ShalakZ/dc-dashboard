"""The report's redaction, masking and framing (W8 task 4): pure functions, no database.

Three corpora carry the safety claim: the leak tables (every shape a secret or an address can take must vanish), the survive
tables (times, versions, node ids must come through unchanged) and the pathological inputs (linear time).
"""
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from dcdash.diagnostics.redact import (
    CUT, FORMAT, MAX_BUILD_ID, PART_LIMIT, Masker, build_known, checksum_of, clip, drop_cut_token, finalize,
    mask_report, scrub, split_parts, verify_paste,
)

PASSWORD = "Zq9-unique-pw"
SECRET_KEY = Fernet.generate_key().decode()
DB_PASSWORD_RAW, DB_PASSWORD = "p%40ss%2Fword", "p@ss/word"
DATABASE_URL = f"postgresql://dcdash:{DB_PASSWORD_RAW}@db:5432/dcdash"
STORED_SECRET = "stored-secret-value"
USER_PASSWORD = "svc:" + PASSWORD  # what hidden_parts gives for opc.tcp://svc:Zq9-unique-pw@...


def encrypted(value, key=SECRET_KEY):
    return Fernet(key.encode()).encrypt(value.encode()).decode()


SOURCES = [
    {"config": {"endpoint": f"opc.tcp://svc:{PASSWORD}@10.1.2.3:4840/x"}, "secret": encrypted(STORED_SECRET)},
    SimpleNamespace(config={"endpoint": "opc.tcp://10.1.2.4:4840"}, secret=None),
    {"config": {"endpoint": "opc.tcp://10.1.2.5:4840"}, "secret": "not-a-fernet-token"},
    {"config": {"endpoint": "opc.tcp://10.1.2.6:4840"}, "secret": encrypted("other-key-secret", Fernet.generate_key().decode())},
]
KNOWN = build_known(SOURCES, SECRET_KEY, DATABASE_URL)


# --- build_known --------------------------------------------------------------------------------------------------------


def test_build_known_collects_credentials_secrets_the_key_and_the_database_password():
    assert USER_PASSWORD in KNOWN  # the credentials of a URL, as hidden_parts gives them
    assert STORED_SECRET in KNOWN  # decrypted from the stored secret
    assert SECRET_KEY in KNOWN
    assert DB_PASSWORD_RAW in KNOWN and DB_PASSWORD in KNOWN  # as written in the URL, and as the server sees it
    assert "dcdash" not in KNOWN  # the database user name is not a secret and would mangle every "dcdash"


def test_build_known_skips_what_does_not_decrypt_and_never_raises():
    assert "not-a-fernet-token" not in KNOWN and "other-key-secret" not in KNOWN
    assert build_known(SOURCES, "not a fernet key", "not a url") == [USER_PASSWORD, "not a fernet key"]
    assert build_known([{"config": None, "secret": None}, SimpleNamespace()], SECRET_KEY, "") == [SECRET_KEY]


def test_build_known_drops_short_values_and_duplicates_and_takes_extras():
    known = build_known([{"config": {}, "secret": encrypted("abc")}], SECRET_KEY, "postgresql://u:pw@db/x", extra=["tok", SECRET_KEY, "session-token-1"])
    assert known == [SECRET_KEY, "session-token-1"]


def test_scrub_with_the_built_known_values_hides_every_one_of_them():
    for value in (USER_PASSWORD, PASSWORD, STORED_SECRET, SECRET_KEY, DB_PASSWORD_RAW, DB_PASSWORD):
        out = scrub(f"failure near {value} in the middle", KNOWN)
        assert value not in out and "[hidden]" in out


# --- scrub: the leak table ----------------------------------------------------------------------------------------------

LEAKS = {
    "url credentials": (f"connect failed: opc.tcp://svc:{PASSWORD}@10.1.2.3:4840/x", ()),
    "url credentials with known": (f"opc.tcp://svc:{PASSWORD}@10.1.2.3:4840/x", (USER_PASSWORD,)),
    "password with a space": ("login failed for svc: 'my pass phrase' was rejected", ("svc:my pass phrase",)),
    "password with a space inside a url": ("opc.tcp://svc:my pass phrase@10.1.2.3:4840/x", ("svc:my pass phrase",)),
    "password alone in prose": (f"the server refused {PASSWORD} twice", (USER_PASSWORD,)),
    "json looking": (json.dumps({"endpoint": f"opc.tcp://svc:{PASSWORD}@h:4840", "note": f"password {PASSWORD} rejected"}), (USER_PASSWORD,)),
    "json without spaces": (f'{{"a":"b","url":"opc.tcp://svc:{PASSWORD}@h:4840"}}', ()),
    "url split at the at sign": (f"reconnect opc.tcp://svc:{PASSWORD}@\n10.1.2.3:4840", ()),
    "url split before the at sign": (f"reconnect opc.tcp://svc:{PASSWORD}\n@10.1.2.3:4840", (USER_PASSWORD,)),
    "inside a urn": (f"application uri urn:{USER_PASSWORD}:host:app", (USER_PASSWORD,)),
    "urn with the password alone": (f"urn:host:{PASSWORD}:app", (USER_PASSWORD,)),
    "inside a traceback": (f'Traceback\n  File "x.py", line 3\nConnectionError: opc.tcp://svc:{PASSWORD}@10.1.2.3:4840 refused', ()),
    "stored secret": (f"BadUserAccessDenied: wrong password {STORED_SECRET} for svc", (STORED_SECRET,)),
    "secret key": (f"Fernet key {SECRET_KEY} was invalid", (SECRET_KEY,)),
    "database password": (f"password authentication failed for dcdash:{DB_PASSWORD_RAW}@db", (DB_PASSWORD_RAW,)),
    "database password decoded": (f"connect db password={DB_PASSWORD}", (DB_PASSWORD,)),
    "several in one text": (f"{PASSWORD} {STORED_SECRET} opc.tcp://a:{SECRET_KEY}@h {SECRET_KEY}", (USER_PASSWORD, STORED_SECRET, SECRET_KEY)),
}
SECRETS_IN_LEAKS = (PASSWORD, "my pass phrase", STORED_SECRET, SECRET_KEY, DB_PASSWORD_RAW, DB_PASSWORD)


@pytest.mark.parametrize("name", LEAKS)
def test_scrub_removes_every_leak_shape(name):
    text, known = LEAKS[name]
    out = scrub(text, known)
    for secret in SECRETS_IN_LEAKS:
        assert secret not in out, f"{name}: {secret!r} survived in {out!r}"
    assert scrub(out, known) == out  # scrubbing scrubbed text changes nothing


SURVIVE_SCRUB = [
    "2026-10-12T08:38:21+03:00",
    "generated 2026-10-12T08:38:21Z, started 08:38:21",
    "2026-10-12 08:38:21.123456+00:00",
    "docker 2.30.2, python 3.12.3, asyncua 1.1.5, postgres 16.4, timescaledb 2.17.0, TimescaleDB 3.7.4",
    "ns=6;s=::AsGlobalPV:Temp",
    "ns=2;i=2258 and i=85 and ns=3;s=Plant1::Ab:Cd",
    "opc.tcp://host:4840/path",
    "opc.tcp://10.1.2.3:4840 and http://api:8000/api/health",
    "urn:scada-pc-01:UnifiedAutomation:UaServer",
    "urn:ietf:params:xml:ns:foo",
    "thumbprint 1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D",
    "BadSecurityChecksFailed (0x80130000) after 1204 ms",
]


@pytest.mark.parametrize("text", SURVIVE_SCRUB)
def test_scrub_leaves_ordinary_report_text_alone(text):
    assert scrub(text, KNOWN) == text


def test_scrub_ignores_known_values_that_are_too_short():
    assert scrub("the password abc was typed", ["abc", "x:y"]) == "the password abc was typed"


# --- Masker: the leak table ---------------------------------------------------------------------------------------------

HOSTS = ["scada-pc-01", "plc.corp.local", "10.9.9.9"]
URIS = ["urn:scada-pc-01:UnifiedAutomation:UaServer"]

# text -> the originals that must not survive
MASK_LEAKS = {
    "ipv4": ("could not reach 10.1.2.3 at all", ["10.1.2.3"]),
    "ipv4 with port": ("connect to 10.1.2.3:4840 failed", ["10.1.2.3"]),
    "ipv4 tuple": ("[Errno 111] connect call failed ('10.1.2.3', 4840)", ["10.1.2.3"]),
    "ipv4 sentence end": ("the server is at 10.1.2.3.", ["10.1.2.3"]),
    "ipv4 in parentheses": ("(10.1.2.3) and [10.1.2.4]", ["10.1.2.3", "10.1.2.4"]),
    "ipv4 leading zeros": ("tool printed 192.168.001.010 for the PLC", ["192.168.001.010", "192.168.1.10"]),
    "ipv4 cidr": ("scanning 10.1.2.0/24 and 172.16.0.0/12", ["10.1.2.0", "172.16.0.0"]),
    "ipv4 key value": ("host=10.1.2.3,peer=10.1.2.4;gw=10.1.2.1", ["10.1.2.3", "10.1.2.4", "10.1.2.1"]),
    "ipv4 loopback": ("listening on 127.0.0.1:8000", ["127.0.0.1"]),
    "ipv4 spanning lines": ("a 10.1.2.3\n10.1.2.4 b", ["10.1.2.3", "10.1.2.4"]),
    "url with ip": ("endpoint opc.tcp://10.1.2.3:4840/UA/Server", ["10.1.2.3"]),
    "url with listed host": ("endpoint opc.tcp://scada-pc-01:4840/UA", ["scada-pc-01"]),
    "url with unlisted host": ("endpoint opc.tcp://other-box.example.net:4840", ["other-box"]),
    "url upper case": ("HTTPS://Gateway.Example/a", ["Gateway"]),
    "url with bracketed ipv6": ("http://[fe80::1]:8080/x and opc.tcp://[2001:db8::5]:4840", ["fe80::1", "2001:db8::5"]),
    "url with credentials left": ("opc.tcp://svc:leftover@10.1.2.3:4840/x", ["10.1.2.3", "svc", "leftover"]),
    "url sentence end": ("see http://gateway.example.", ["gateway"]),
    "ipv6 compressed": ("peer fe80::1 and 2001:db8::5", ["fe80::1", "2001:db8::5"]),
    "ipv6 full": ("2001:0db8:0000:0000:0000:ff00:0042:8329 is up", ["2001:0db8:0000:0000:0000:ff00:0042:8329"]),
    "ipv6 eight groups": ("1:2:3:4:5:6:7:8", ["1:2:3:4:5:6:7:8"]),
    "ipv6 bracketed": ("[2001:db8::5]:4840 and [fe80::1%eth0]", ["2001:db8::5", "fe80::1"]),
    "ipv6 mapped ipv4": ("::ffff:10.1.2.3 connected", ["10.1.2.3"]),
    "ipv6 zone": ("fe80::1%eth0 up", ["fe80::1"]),
    "ipv6 key value": ("addr=2001:db8::5 gw=fe80::1", ["2001:db8::5", "fe80::1"]),
    "ipv6 sentence end": ("reach 2001:db8::5.", ["2001:db8::5"]),
    "ipv6 followed by colon": ("reach 2001:db8::5: refused", ["2001:db8::5"]),
    "listed host": ("lookup of scada-pc-01 failed", ["scada-pc-01"]),
    "listed host upper case": ("lookup of SCADA-PC-01 failed", ["SCADA-PC-01"]),
    "listed host with a domain": ("getaddrinfo(scada-pc-01.corp.local)", ["scada-pc-01"]),
    "listed fqdn": ("cert CN=plc.corp.local, SAN DNS:PLC.CORP.LOCAL", ["plc.corp.local", "PLC.CORP.LOCAL"]),
    "listed ip": ("peer 10.9.9.9:502 closed", ["10.9.9.9"]),
    "urn authority": ("ApplicationUri urn:Unlisted-Box:Vendor:Product", ["Unlisted-Box"]),
    "urn authority upper": ("URN:SomeBox:Vendor", ["SomeBox"]),
    "whole listed uri": ("server urn:scada-pc-01:UnifiedAutomation:UaServer ok", ["scada-pc-01", "UnifiedAutomation"]),
    "everything at once": (
        "opc.tcp://scada-pc-01:4840 -> 10.1.2.3, [fe80::1], urn:Box:App, plc.corp.local",
        ["scada-pc-01", "10.1.2.3", "fe80::1", "Box", "plc.corp.local"],
    ),
}


@pytest.mark.parametrize("name", MASK_LEAKS)
def test_masker_removes_every_address_shape(name):
    text, originals = MASK_LEAKS[name]
    masker = Masker(HOSTS, URIS)
    out = masker.mask(text)
    assert out != text
    for original in originals:
        assert original.lower() not in out.lower(), f"{name}: {original!r} survived in {out!r}"
    assert masker.mask(out) == out  # the final pass over an already masked body changes nothing
    legend = " ".join(entry["original"] for entry in masker.legend())
    assert legend  # whatever was masked is in the legend, for the UI


def test_masker_keeps_the_structure_of_urls_and_urns_and_changes_only_the_host():
    assert Masker().mask("opc.tcp://host:4840/path") == "opc.tcp://HOST-1:4840/path"
    assert Masker().mask("urn:scada-pc-01:Vendor:Product") == "urn:HOST-1:Vendor:Product"
    assert Masker().mask("opc.tcp://[hidden]@10.1.2.3:4840/x") == "opc.tcp://[hidden]@HOST-1:4840/x"
    assert Masker().mask("opc.tcp://svc:oops@10.1.2.3:4840/x") == "opc.tcp://[hidden]@HOST-1:4840/x"  # a second net for scrub
    assert Masker().mask("from 10.1.2.3, 10.1.2.4 and 10.1.2.3") == "from HOST-1, HOST-2 and HOST-1"


@pytest.mark.parametrize(
    "url, expected",
    [
        ("opc.tcp://svc:oops@scada-pc-01:4840/x", "opc.tcp://[hidden]@HOST-1:4840/x"),
        ("opc.tcp://svc:oops@10.9.9.9:4840/x", "opc.tcp://[hidden]@HOST-2:4840/x"),
        ("opc.tcp://svc:oops@SCADA-PC-01.:4840/x", "opc.tcp://[hidden]@HOST-1.:4840/x"),
        ("opc.tcp://svc:oops@[fe80::1]:4840/x", "opc.tcp://[hidden]@HOST-3:4840/x"),
        ("opc.tcp://svc:oops@[not-an-address]:4840/x", "opc.tcp://[hidden]@[not-an-address]:4840/x"),
        ("opc.tcp://svc:oops@HOST-7:4840/x", "opc.tcp://[hidden]@HOST-7:4840/x"),
        ("opc.tcp://[hidden]@scada-pc-01:4840/x", "opc.tcp://[hidden]@HOST-1:4840/x"),
    ],
)
def test_masker_hides_leftover_credentials_in_front_of_listed_hosts_too(url, expected):
    masker = Masker(["scada-pc-01", "10.9.9.9"])
    out = masker.mask(url)
    assert out == expected and "oops" not in out and "svc" not in out


def test_masker_gives_the_same_alias_to_every_spelling_of_one_host():
    masker = Masker(["scada-pc-01"])
    out = masker.mask("scada-pc-01 SCADA-PC-01 Scada-Pc-01 opc.tcp://SCADA-PC-01:4840")
    assert out == "HOST-1 HOST-1 HOST-1 opc.tcp://HOST-1:4840"
    assert Masker().mask("192.168.001.010 192.168.1.10 192.168.01.10") == "HOST-1 HOST-1 HOST-1"
    assert Masker().mask("fe80::1 FE80:0:0:0:0:0:0:1 [fe80::0:1]") == "HOST-1 HOST-1 HOST-1"
    # a listed address is the same host as the same address found by its shape
    assert Masker(["10.1.2.3"]).mask("10.1.2.3 opc.tcp://010.001.002.003:1") == "HOST-1 opc.tcp://HOST-1:1"


def test_masker_listed_names_may_be_endpoints_or_host_and_port_or_wildcards():
    masker = Masker(["opc.tcp://user:pw@scada-pc-01:4840/UA", "10.1.2.3:502", "[fe80::9]:4840", "*.corp.local"])
    out = masker.mask("scada-pc-01 10.1.2.3 fe80::9 corp.local CN=*.corp.local")
    assert out == "HOST-1 HOST-2 HOST-3 HOST-5 CN=HOST-4"
    assert {e["original"] for e in masker.legend()} == {"scada-pc-01", "10.1.2.3", "fe80::9", "corp.local", "*.corp.local"}


def test_masker_numbers_aliases_in_the_order_names_were_given_and_is_deterministic():
    text = "b-host-x a-host-x opc.tcp://c-host-x:1 10.1.2.3"
    first, second = Masker(["b-host-x", "a-host-x"]), Masker(["b-host-x", "a-host-x"])
    assert first.mask(text) == second.mask(text) == "HOST-1 HOST-2 opc.tcp://HOST-3:1 HOST-4"
    assert first.legend() == second.legend() == [
        {"alias": "HOST-1", "original": "b-host-x"}, {"alias": "HOST-2", "original": "a-host-x"},
        {"alias": "HOST-3", "original": "c-host-x"}, {"alias": "HOST-4", "original": "10.1.2.3"},
    ]
    assert Masker(["a-host-x", "b-host-x"]).mask(text) != first.mask(text)  # the order given is what decides


def test_masker_legend_lists_only_what_appeared_and_url_aliases_sort_after_host_aliases():
    masker = Masker(["never-seen"], ["urn:app:one"])
    assert masker.legend() == []
    masker.mask("urn:app:one then 10.1.2.3")
    assert masker.legend() == [{"alias": "HOST-2", "original": "10.1.2.3"}, {"alias": "URN-1", "original": "urn:app:one"}]


def test_mask_report_is_a_one_shot_masker():
    masked, legend = mask_report("see opc.tcp://10.1.2.3:4840 and scada-pc-01", ["scada-pc-01"], ["urn:x:y"])
    assert masked == "see opc.tcp://HOST-2:4840 and HOST-1"
    assert legend == [{"alias": "HOST-1", "original": "scada-pc-01"}, {"alias": "HOST-2", "original": "10.1.2.3"}]


# --- Masker: what must survive ------------------------------------------------------------------------------------------

SURVIVE_MASK = [
    "2026-10-12T08:38:21+03:00",
    "generated 2026-10-12T08:38:21Z, started 08:38:21, took 12:05:00.123",
    "2026-10-12 08:38:21.123456+00:00 and 2026-10-12T08:38:21.5-05:30",
    "docker 2.30.2, python 3.12.3, asyncua 1.1.5, postgres 16.4, TimescaleDB 3.7.4, sha 20.1.2.3.4",
    "ns=6;s=::AsGlobalPV:Temp",
    "ns=3;s=Plant1::Ab:Cd and ns=2;s=::dead:beef and s=::face:cafe and ns=4;s=2001:db8::5",
    "ns=2;i=2258 g=09087e75-8e5e-499b-954f-f2a9603db28a b=AbCd",
    "thumbprint 1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D",
    "sha256 " + ":".join(f"{n:02X}" for n in range(32)),
    "mac 00:1A:2B:3C:4D:5E",
    "opc.tcp://[hidden]@",
    "[hidden]@ and [12] and [3, 4] and [dead] and [12:30] and [1:2:3] and {\"a\": [1, 2, 3]}",
    "== API ERRORS ==  == POINTS ==  == SOURCE HEALTH ==",
    "DCDASH-REPORT v1 | PART 1 OF 2 | build 3b2c1f0-dirty | 2026-10-12T08:38:21Z",
    "BadSecurityChecksFailed (0x80130000) after 1204 ms, 17 reads/min, 3.2% bad, 5 of 12",
    "chars=11990 lines=210 and ratio 0.75 and 1,234.5 and 3.14.15",
    "",
]


@pytest.mark.parametrize("text", SURVIVE_MASK)
def test_masker_leaves_times_versions_node_ids_and_markers_alone(text):
    masker = Masker(HOSTS, URIS)
    assert masker.mask(text) == text
    assert masker.legend() == []


def test_masker_does_not_turn_headings_or_words_into_aliases_because_a_url_names_the_same_word():
    masker = Masker()
    out = masker.mask("GET http://api:8000/api/health\n== API ERRORS ==\nDB ok, api ok, db: up, Database")
    assert out == "GET http://HOST-1:8000/api/health\n== API ERRORS ==\nDB ok, api ok, db: up, Database"


def test_masker_pins_the_accepted_over_mask_of_a_dotted_quad_in_a_version_string():
    assert Masker().mask("kernel 6.6.87.2-microsoft") == "kernel HOST-1-microsoft"


def test_masker_treats_five_part_numbers_and_out_of_range_octets_as_not_addresses():
    for text in ("OID 1.3.6.1.4.1.311", "version 1.2.3.4.5", "999.1.1.1 and 1.1.1.256 and 1234.1.1.1"):
        assert Masker().mask(text) == text


def test_masker_masks_a_dotted_quad_in_every_context_a_report_prints_one():
    out = Masker().mask("a 1.2.3.4. b 1.2.3.4, c (1.2.3.4) d 1.2.3.4: e\t1.2.3.4\n1.2.3.4")
    assert "1.2.3.4" not in out and out.count("HOST-1") == 6


def test_masker_skips_names_that_are_too_short_or_look_like_an_alias():
    masker = Masker(["db", "a", "HOST-1", "urn-2", "URN-3"])
    text = "db a HOST-1 URN-3 http://HOST-9:1 urn:HOST-2:x"
    assert masker.mask(text) == text
    assert masker.legend() == []
    # a short name inside a URL is still found there, by position
    assert Masker(["db"]).mask("http://db:5432 and db") == "http://HOST-1:5432 and db"


def test_masker_does_not_mask_a_listed_word_inside_a_longer_word_or_inside_an_alias():
    masker = Masker(["host", "plc"])
    out = masker.mask("host plc ghost hostname plc1 sub.plc plc-2 the-plc HOST-1 x.host.y")
    assert out == "HOST-1 HOST-2 ghost hostname plc1 sub.plc plc-2 the-plc HOST-1 x.host.y"


# --- Masker: idempotence, even with a listed host called "host" ---------------------------------------------------------


@pytest.mark.parametrize("hosts", [[], ["host"], ["host", "scada-pc-01", "10.1.2.3"]])
def test_masking_twice_with_the_same_masker_changes_nothing(hosts):
    text = "\n".join(
        [
            "opc.tcp://host:4840/path",
            "== SOURCES ==",
            "urn:host:Vendor:Product urn:scada-pc-01:V:P",
            "peer 10.1.2.3 and fe80::1 and [2001:db8::5]:4840 via host",
            "opc.tcp://[hidden]@10.1.2.3:4840/x",
        ]
    )
    masker = Masker(hosts)
    once = masker.mask(text)
    legend = masker.legend()
    assert masker.mask(once) == once
    assert masker.legend() == legend
    # a body masked per value and again as a whole, the way the report does it, equals masking once
    assert masker.mask("\n".join(masker.mask(line) for line in text.split("\n"))) == once


# --- Masker: text that was cut ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, expected",
    [
        ("connect to 10.1.2…", "connect to …"),
        ("failed: opc.tcp://10.1.2.3:48…", "failed: …"),
        ("reach scada-pc-01.corp.lo…", "reach …"),
        ("path /a/b/c…", "path …"),
        ("connection refus…", "connection refus…"),  # no ".", ":" or "/" in the half token
        ("no marker at the end 10.1.2.3 x", "no marker at the end 10.1.2.3 x"),
        ("ends with a space …", "ends with a space …"),
        ("…", "…"),
        ("", ""),
    ],
)
def test_drop_cut_token(text, expected):
    assert drop_cut_token(text) == expected


def test_clip_cuts_with_the_marker_and_never_leaves_half_a_token():
    assert clip("short", 10) == "short"
    assert clip("exactly ten", 11) == "exactly ten"
    assert clip("a long line of text here", 12) == "a long line…"
    assert clip("connect to 10.1.2.3 now", 17) == "connect to …"  # cut after "10.1.2"
    assert clip("x" * 50, 20) == "x" * 19 + CUT


def test_a_value_that_was_cut_at_the_source_loses_the_half_address_when_masked():
    original = "connect to 10.1.2.3 failed after retries"
    for end in range(len(original)):
        cut = original[:end] + CUT
        out = Masker().mask(cut)
        assert "10.1" not in out, (end, out)  # two octets of a masked host never show


def test_masking_before_clipping_never_leaves_a_fragment_of_an_address():
    text = "x " * 3 + "opc.tcp://10.1.2.3:4840/some/long/path failed against 10.1.2.4 again"
    masked = Masker().mask(text)
    for limit in range(2, len(masked) + 1):
        out = clip(masked, limit)
        assert "10.1" not in out and "10.2" not in out


# --- Masker: time -------------------------------------------------------------------------------------------------------

PATHOLOGICAL = {
    "colons": "a:" * 50_000,
    "double colons": "aaaa::" * 20_000,
    "dots": "1." * 50_000,
    "one long word": "a" * 100_000,
    "quads": "1.1.1.1 " * 12_000,
    "schemes": "http://" * 20_000,
    "scheme without slashes": "a://" + "b:" * 50_000,
    "brackets": "[" * 100_000,
    "bracketed colons": "[::" * 30_000,
    "urns": "urn:" * 25_000,
    "at signs": "x://" + "@" * 100_000,
    "cut marks": ("a" * 1000 + CUT + "\n") * 100,
    "hex runs": "dead:beef:" * 10_000,
    "mixed": "opc.tcp://[fe80::1]:1/ urn:a 1.2.3.4 ::1 " * 3_000,
}


@pytest.mark.parametrize("name", PATHOLOGICAL)
def test_masking_a_hostile_text_takes_linear_time(name):
    masker = Masker(["scada-pc-01", "plc.corp.local", "10.9.9.9"], ["urn:x:y"])
    text = PATHOLOGICAL[name]
    started = time.perf_counter()
    masker.mask(text)
    assert time.perf_counter() - started < 1.0


def test_scrubbing_a_hostile_text_takes_linear_time():
    started = time.perf_counter()
    scrub("://" * 30_000 + "@" + "a" * 100_000, KNOWN)
    assert time.perf_counter() - started < 1.0


# --- split_parts ---------------------------------------------------------------------------------------------------------


def section(name, lines, width=60):
    return "\n".join([f"== {name} =="] + [f"{name.lower()} line {n:03d} " + "x" * width for n in range(lines)])


def test_split_parts_keeps_a_short_body_whole():
    assert split_parts("a\nb\nc", 100) == ["a\nb\nc"]
    assert split_parts("", 100) == [""]
    assert split_parts("\n", 100) == ["\n"]


def test_split_parts_cuts_on_line_boundaries_and_rejoins_to_the_body():
    body = "\n".join(f"line {n:04d} " + "y" * (n % 37) for n in range(900))
    parts = split_parts(body, 2_000)
    assert len(parts) > 3 and all(len(part) <= 2_000 for part in parts)
    assert "\n".join(parts) == body
    assert all(line.startswith("line ") for part in parts for line in part.split("\n"))


def test_split_parts_prefers_to_start_a_part_at_a_section():
    body = "\n\n".join([section("ALPHA", 8), section("BETA", 8), section("GAMMA", 8), section("DELTA", 8)])
    limit = len(section("ALPHA", 8)) * 2 + 10  # two sections fit, three do not
    parts = split_parts(body, limit)
    assert len(parts) == 2 and all(len(part) <= limit for part in parts)
    assert parts[1].startswith("== GAMMA ==") and "== BETA ==" in parts[0]
    assert "\n".join(parts) == body


def test_split_parts_cuts_inside_a_section_that_is_longer_than_a_part():
    body = section("HUGE", 100) + "\n\n" + section("SMALL", 2)
    parts = split_parts(body, 1_000)
    assert all(len(part) <= 1_000 for part in parts) and "\n".join(parts) == body
    assert parts[-1].endswith("small line 001 " + "x" * 60)


def test_split_parts_cuts_a_line_longer_than_the_limit_and_ends():
    body = "head\n" + "z" * 20_000 + "\ntail"
    parts = split_parts(body, 12_000)
    assert all(len(part) <= 12_000 for part in parts)
    assert "".join(parts).replace("\n", "") == body.replace("\n", "")
    assert split_parts("q" * 100_000, 500)  # terminates


def test_split_parts_normalises_line_breaks():
    assert split_parts("a\r\nb\rc\nd", 100) == ["a\nb\nc\nd"]


# --- finalize ------------------------------------------------------------------------------------------------------------

STAMP = "2026-10-12T08:38:21Z"


def big_body(sections=11, lines=60):
    return "\n\n".join(section(f"SECTION{n}", lines, width=70) for n in range(sections))


def test_finalize_frames_one_part_and_counts_without_line_breaks():
    parts = finalize("ab\ncd", "3b2c1f0", STAMP)
    assert len(parts.parts) == 1
    assert parts.text() == (
        f"{FORMAT} | PART 1 OF 1 | build 3b2c1f0 | {STAMP}\nab\ncd\n"
        f"--- PART 1 OF 1 | chars=4 lines=2 ---\nEND OF REPORT {parts.checksum}"
    )
    assert (parts.parts[0].chars, parts.parts[0].lines, parts.parts[0].index, parts.parts[0].of) == (4, 2, 1, 1)
    assert parts.checksum == hashlib.sha256(b"ab\ncd").hexdigest()[:12]


def test_finalize_takes_a_list_of_pieces_as_well_and_splits_it_again_with_room_for_the_frame():
    body = "\n".join(["a" * 499] * 30)
    pieces = split_parts(body)  # these leave no room for a header and footer
    assert len(pieces[0]) == 11_999
    parts = finalize(pieces, "abc", STAMP)
    assert parts == finalize(body, "abc", STAMP)
    assert all(len(part.text) <= PART_LIMIT for part in parts.parts)


def test_finalize_an_empty_report_still_has_its_frame():
    parts = finalize("", "x", STAMP)
    assert parts.text().splitlines()[1:] == ["--- PART 1 OF 1 | chars=0 lines=0 ---", f"END OF REPORT {parts.checksum}"]
    assert verify_paste(parts.text()).ok


def test_finalize_never_lets_a_part_pass_the_limit_whatever_the_build_id():
    for build_id in ("abc", "v1.2.3-45-g" + "f" * 40 + "-dirty", "b" * 500, "with | pipes\nand lines"):
        parts = finalize(big_body(), build_id, STAMP)
        assert len(parts.parts) >= 5
        assert all(len(part.text) <= PART_LIMIT for part in parts.parts)
        assert len(parts.build_id) <= MAX_BUILD_ID and "|" not in parts.build_id and "\n" not in parts.build_id
        assert [part.index for part in parts.parts] == list(range(1, len(parts.parts) + 1))
        assert {part.of for part in parts.parts} == {len(parts.parts)}


def test_finalize_parts_that_barely_fit_are_still_within_the_limit():
    for extra in range(0, 400, 7):  # slide the body size across the point where a part is full
        body = "\n".join(["l" * 250] * 47 + ["m" * extra])
        parts = finalize(body, "x" * 64, STAMP)
        assert all(len(part.text) <= PART_LIMIT for part in parts.parts)
        assert verify_paste(parts.text()).ok


def test_finalize_header_footer_and_end_line_placement():
    parts = finalize(big_body(), "abc123", datetime(2026, 10, 12, 11, 38, 21, tzinfo=timezone(timedelta(hours=3))))
    n = len(parts.parts)
    for part in parts.parts:
        lines = part.text.split("\n")
        assert lines[0] == f"{FORMAT} | PART {part.index} OF {n} | build abc123 | 2026-10-12T08:38:21Z"
        footer = f"--- PART {part.index} OF {n} | chars={part.chars} lines={part.lines} ---"
        last = part.index == n
        assert lines[-2 if last else -1] == footer
        assert (lines[-1] == f"END OF REPORT {parts.checksum}") == last
        assert sum("END OF REPORT" in line for line in lines) == (1 if last else 0)
        body = "\n".join(lines[1:-2 if last else -1])
        assert (part.chars, part.lines) == (len(body.replace("\n", "")), body.count("\n") + 1)


def test_finalize_checksum_covers_the_bodies_and_changes_with_one_character():
    body = big_body(4, 10)
    parts = finalize(body, "abc", STAMP, limit=1_500)
    assert len(parts.parts) > 2
    bodies = ["\n".join(part.text.split("\n")[1:-1]) for part in parts.parts[:-1]]
    bodies.append("\n".join(parts.parts[-1].text.split("\n")[1:-2]))
    assert "\n".join(bodies) == body  # the parts rejoin into the masked body
    assert parts.checksum == hashlib.sha256(body.encode()).hexdigest()[:12] == checksum_of(bodies)
    changed = finalize(body.replace("line 003", "line 004", 1), "abc", STAMP, limit=1_500)
    assert changed.checksum != parts.checksum
    assert finalize(body, "abc", STAMP, limit=1_500) == parts  # deterministic


def test_finalize_counts_characters_not_bytes_and_hashes_utf8():
    body = "näive café – 温度 …"
    parts = finalize(body, "b", STAMP)
    assert parts.parts[0].chars == len(body) and parts.checksum == hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
    assert verify_paste(parts.text()).ok


def test_finalize_normalises_line_breaks_before_counting():
    assert finalize("a\r\nb\r\nc", "b", STAMP) == finalize("a\nb\nc", "b", STAMP)


def test_finalize_refuses_a_limit_with_no_room():
    with pytest.raises(ValueError):
        finalize("x", "b", STAMP, limit=100)


def test_parts_text_puts_one_blank_line_between_parts():
    parts = finalize(big_body(), "abc", STAMP)
    text = parts.text()
    for part in parts.parts[:-1]:
        assert (part.text + "\n\nDCDASH-REPORT v1") in text


# --- verify_paste --------------------------------------------------------------------------------------------------------


def test_verify_paste_accepts_what_finalize_made_also_after_crlf_or_cr():
    parts = finalize(big_body(), "abc", STAMP)
    text = parts.text()
    for pasted in (text, text.replace("\n", "\r\n"), text.replace("\n", "\r"), "\n\n" + text + "\n", text.replace("\n", "\r\n") + "\r\n"):
        result = verify_paste(pasted)
        assert result.ok, result.problems
        assert (result.parts, result.checksum, result.problems) == (len(parts.parts), parts.checksum, ())


def test_verify_paste_finds_every_kind_of_damage():
    text = finalize(big_body(), "abc", STAMP).text()
    lines = text.split("\n")
    damaged = {
        "a changed character": text.replace("section3 line 004", "section3 line 005", 1),
        "a dropped line": "\n".join(lines[:100] + lines[101:]),
        "a duplicated line": "\n".join(lines[:100] + [lines[100]] + lines[100:]),
        "cut off in the middle of a part": "\n".join(lines[:150]),
        "cut off before the end line": "\n".join(lines[:-1]),
        "the first part missing": text[text.index("\n\nDCDASH-REPORT") :],
        "a part missing": text.replace(text[text.index("PART 2 OF") - 40 : text.index("PART 3 OF") - 40], ""),
        "extra text before": "hello\n" + text,
        "nothing": "",
        "no report": "just some words",
    }
    for name, pasted in damaged.items():
        result = verify_paste(pasted)
        assert not result.ok and result.problems, name


# --- the pieces together, the way the report route uses them --------------------------------------------------------------

FREE_TEXT = [
    f"source 1 offline: cannot reach opc.tcp://svc:{PASSWORD}@10.1.2.3:4840/UA (timeout)",
    f"BadUserAccessDenied for scada-pc-01 with {STORED_SECRET}",
    f"json {{\"error\": \"opc.tcp://svc:{PASSWORD}@scada-pc-01:4840\", \"peer\": \"10.1.2.4\", \"secret\": \"{SECRET_KEY}\"}}",
    f"db error: password authentication failed ({DB_PASSWORD}) at 2001:db8::5 [fe80::1]:5432",
    "application uri urn:scada-pc-01:UnifiedAutomation:UaServer certificate CN=scada-pc-01.corp.local",
    "Traceback (most recent call last):\n  File \"x.py\", line 3, in poll\nConnectionRefusedError: [Errno 111] connect call failed ('10.1.2.3', 4840)",
    "long " + "word " * 40 + "opc.tcp://10.1.2.3:4840/some/path/that/goes/on and on" + CUT,
]
SECRET_VALUES = (PASSWORD, STORED_SECRET, SECRET_KEY, DB_PASSWORD, DB_PASSWORD_RAW)
ADDRESSES = ("10.1.2.3", "10.1.2.4", "scada-pc-01", "2001:db8::5", "fe80::1", "UnifiedAutomation")


def build_report_text(mask):
    masker = Masker(["10.1.2.3", "10.1.2.4", "scada-pc-01"], ["urn:scada-pc-01:UnifiedAutomation:UaServer"])

    def transform(value):  # scrub with the known values, then mask when asked, before anything is clipped
        value = scrub(value, KNOWN)
        return masker.mask(value) if mask else value

    lines = ["== SOURCES =="] + [clip(transform(text), 300) for text in FREE_TEXT]
    body = "\n".join(lines)
    if mask:
        body = masker.mask(body)  # the second net over the assembled body
    parts = finalize(body, "3b2c1f0", STAMP)
    return parts, masker


@pytest.mark.parametrize("mask", [False, True])
def test_a_report_assembled_from_scrubbed_text_holds_no_secret(mask):
    parts, _ = build_report_text(mask)
    text = parts.text()
    for secret in SECRET_VALUES:
        assert secret not in text
    assert "svc:" not in text
    assert verify_paste(text).ok


def test_a_masked_report_holds_no_address_and_the_unmasked_one_still_does():
    masked, masker = build_report_text(True)
    for address in ADDRESSES:
        assert address.lower() not in masked.text().lower(), address
    assert "10.1" not in masked.text()
    assert {e["original"] for e in masker.legend()} >= {"10.1.2.3", "10.1.2.4", "scada-pc-01", "urn:scada-pc-01:UnifiedAutomation:UaServer"}
    plain, _ = build_report_text(False)
    assert "10.1.2.3" in plain.text() and "scada-pc-01" in plain.text()


def test_the_masked_report_is_stable_when_masked_again():
    parts, masker = build_report_text(True)
    body = "\n".join(line for part in parts.parts for line in part.text.split("\n")[1:-1])
    assert masker.mask(body) == body


def test_masker_add_lists_more_names_later_without_renumbering():
    masker = Masker(["first-box"])
    assert masker.mask("first-box second-box") == "HOST-1 second-box"
    masker.add(["second-box"])
    assert masker.mask("first-box second-box") == "HOST-1 HOST-2"


def test_a_listed_short_host_name_hides_the_whole_fqdn_it_starts():
    masker = Masker(["opc.tcp://scada01:4840"])
    out = masker.mask("connect to SCADA01.site.local:4840, then scada01 and scada01. Done; ask scada01.plant-2.example.")
    assert "site.local" not in out and "plant-2" not in out and "SCADA01" not in out.upper().replace("HOST", "")
    assert out.startswith("connect to HOST-2:4840, then HOST-1 and HOST-1. Done; ask HOST-3.")
    assert masker.mask(out) == out
    assert {entry["original"] for entry in masker.legend()} == {"scada01", "SCADA01.site.local", "scada01.plant-2.example"}


def test_a_listed_ip_address_does_not_swallow_a_following_label():
    assert Masker(["10.1.2.5"]).mask("at 10.1.2.5.backup") == "at HOST-1.backup"


def test_the_public_opc_foundation_names_are_never_aliased_so_namespace_zero_stays_recognisable():
    masker = Masker(["opcfoundation.org"], ["http://opcfoundation.org/UA/", "http://opcfoundation.org/UA/DI/", "urn:scada:srv:app"])
    text = "ns 0 http://opcfoundation.org/UA/ and http://opcfoundation.org/UA/DI/ on opcfoundation.org"
    assert masker.mask(text) == text
    # a `urn:opcfoundation.org:<server>` application URI names a server, and a look-alike authority is not the foundation's
    hidden = Masker([], ["urn:opcfoundation.org:HIDDENBOX:app", "http://opcfoundation.org.evil.example/UA/", "http://evilopcfoundation.org/UA/"])
    out = hidden.mask("a urn:opcfoundation.org:HIDDENBOX:app b http://opcfoundation.org.evil.example/UA/ c http://evilopcfoundation.org/UA/")
    assert "HIDDENBOX" not in out and "evil" not in out, out
    assert masker.mask("app urn:scada:srv:app on http://plc.plant:4840") == "app URN-1 on http://HOST-1:4840"
