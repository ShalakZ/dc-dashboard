"""`moves.urls.address_key` and `display_endpoint` (w33 T4a, P8, F10): where a source points, and how to show that without a secret.

`address_key` is (host lower-cased, port, path) and must agree with the matcher's own reading of an address (`moves.load._endpoint`:
an empty OPC UA path and `/` are the same place). `display_endpoint` is built ONLY from scheme, host, port and path: never user info,
query or fragment, whatever the stored URL holds; a value nobody can parse is shown cut and scrubbed.
"""
import pytest

from dcdash.moves.load import _endpoint
from dcdash.moves.urls import address_key, display_endpoint

# ---- address_key -----------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "connector_type, config, expected",
    [
        ("opcua", {"endpoint": "opc.tcp://172.20.0.5:4840/dcdash/"}, ("172.20.0.5", 4840, "/dcdash/")),
        ("opcua", {"endpoint": "opc.tcp://Meter-1.Lab:4841/Server"}, ("meter-1.lab", 4841, "/Server")),
        ("opcua", {"endpoint": "opc.tcp://host:4840"}, ("host", 4840, "/")),  # no path = "/" (the matcher's rule)
        ("opcua", {"endpoint": "opc.tcp://host/"}, ("host", 4840, "/")),  # the default OPC UA port
        ("opcua", {"endpoint": "opc.tcp://svc:secret@host:4840/x"}, ("host", 4840, "/x")),  # user info is not part of the place
        ("opcua", {"endpoint": "opc.tcp://[::1]:4840/x"}, ("::1", 4840, "/x")),
        ("simulator", {"url": "http://sim:8080"}, ("sim", 8080, "")),
        ("simulator", {"url": "http://Sim:8080/some/path"}, ("sim", 8080, "")),  # the simulator has no path
        ("simulator", {"url": "http://sim"}, ("sim", 80, "")),
        ("simulator", {"url": "https://sim"}, ("sim", 443, "")),
    ],
)
def test_address_key_reads_host_port_and_path(connector_type, config, expected):
    assert address_key(connector_type, config) == expected


@pytest.mark.parametrize(
    "connector_type, config",
    [
        ("opcua", None), ("opcua", {}), ("opcua", {"endpoint": 5}), ("opcua", {"endpoint": ""}), ("opcua", {"endpoint": "not a url"}),
        ("opcua", {"endpoint": "opc.tcp://host:notaport/x"}), ("opcua", {"endpoint": "opc.tcp://[::1/x"}), ("opcua", "opc.tcp://h"),
        ("simulator", {"url": None}), ("simulator", {"endpoint": "opc.tcp://h:1"}),  # the wrong key for the type
        ("modbus", {"host": "10.0.0.1", "port": 502, "unit_id": 1}),  # a Modbus device has no place the platform can move
        ("unknown", {"endpoint": "opc.tcp://h:4840"}), (None, {"endpoint": "opc.tcp://h:4840"}),
    ],
)
def test_address_key_is_none_for_junk_and_for_types_that_cannot_move(connector_type, config):
    assert address_key(connector_type, config) is None


@pytest.mark.parametrize(
    "config",
    [{"endpoint": "opc.tcp://h:4840"}, {"endpoint": "opc.tcp://h:4840/"}, {"endpoint": "opc.tcp://h:4840/a/b/"}, {"endpoint": "opc.tcp://u:p@h/a"}],
)
def test_address_key_agrees_with_the_matchers_reading(config):
    assert address_key("opcua", config) == _endpoint("opcua", config)
    assert address_key("simulator", {"url": "http://s:9"}) == _endpoint("simulator", {"url": "http://s:9"})


# ---- display_endpoint ------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "connector_type, config, expected",
    [
        ("opcua", {"endpoint": "opc.tcp://172.20.0.3:4840/dcdash/"}, "opc.tcp://172.20.0.3:4840/dcdash/"),
        ("opcua", {"endpoint": "opc.tcp://user:pass@172.20.0.3:4840/dcdash/"}, "opc.tcp://172.20.0.3:4840/dcdash/"),
        ("opcua", {"endpoint": "opc.tcp://user:pass@host/dcdash/?token=abc123#frag"}, "opc.tcp://host:4840/dcdash/"),  # port always shown
        ("opcua", {"endpoint": "opc.tcp://host:4840"}, "opc.tcp://host:4840"),  # a path that is not there is not invented
        ("opcua", {"endpoint": "opc.tcp://[::1]:4840/x"}, "opc.tcp://[::1]:4840/x"),  # IPv6 is bracketed again
        ("opcua", {"endpoint": "opc.tcp://u:p@[fe80::1]/x"}, "opc.tcp://[fe80::1]:4840/x"),
        ("simulator", {"url": "http://sim:8080"}, "http://sim:8080"),
        ("simulator", {"url": "https://admin:hunter2@sim?key=1#x"}, "https://sim:443"),
        ("simulator", {"url": "http://sim/ignored/path"}, "http://sim:80"),  # the simulator's place has no path
    ],
)
def test_display_endpoint_is_scheme_host_port_and_path_only(connector_type, config, expected):
    assert display_endpoint(connector_type, config) == expected


@pytest.mark.parametrize("secret", ["hunter2", "user", "pass", "token=abc123", "frag", "key=1"])
def test_display_endpoint_never_carries_user_info_query_or_fragment(secret):
    for connector_type, key in (("opcua", "endpoint"), ("simulator", "url")):
        scheme = "opc.tcp" if connector_type == "opcua" else "http"
        shown = display_endpoint(connector_type, {key: f"{scheme}://user:pass@h:4840/p?token=abc123&key=1#frag?hunter2"})
        assert secret not in shown and "@" not in shown and "?" not in shown and "#" not in shown


@pytest.mark.parametrize("config", [None, {}, {"endpoint": None}, {"endpoint": 12}, {"endpoint": ["a"]}, "text", 7])
def test_display_endpoint_of_nothing_is_empty(config):
    assert display_endpoint("opcua", config) == ""


def test_display_endpoint_of_a_value_nobody_can_parse_is_scrubbed_and_cut():
    shown = display_endpoint("opcua", {"endpoint": "opc.tcp://user:pass@host:notaport/dcdash?x=1"})
    assert "user" not in shown and "pass" not in shown and shown.startswith("opc.tcp://[hidden]@host")
    long = display_endpoint("opcua", {"endpoint": "x" * 500})
    assert long == "x" * 80
    credentialed = display_endpoint("opcua", {"endpoint": "opc.tcp://user:pass@" + "h" * 500 + ":notaport"})
    assert len(credentialed) <= 80 and "user" not in credentialed and "pass" not in credentialed


def test_display_endpoint_scrubs_before_it_cuts():
    """A password that straddles the cut must not survive as half a password."""
    url = "opc.tcp://" + "u" * 60 + ":" + "SECRETSECRETSECRETSECRET" + "@host:notaport"
    shown = display_endpoint("opcua", {"endpoint": url})
    assert "SECRET" not in shown and "uuuuuu" not in shown


@pytest.mark.parametrize("junk", ["user:pass@host:4840", "a@b@c:99", "@@@", "user:pass@", "pass@host?x=pass@y"])
def test_display_endpoint_of_junk_with_an_at_sign_and_no_scheme_keeps_nothing_before_the_last_at(junk):
    shown = display_endpoint("simulator", {"url": junk})
    assert "user" not in shown and "pass" not in shown and "a@b" not in shown
    assert shown.count("@") <= 1


def test_display_endpoint_hides_the_values_the_config_marks_as_secret():
    """A password with a space or an "@" in it is not found by position alone: the config's own credential fields are hidden too."""
    config = {"endpoint": "opc.tcp://svc:pa ss word@host:notaport/x", "username": "svc"}
    shown = display_endpoint("opcua", config)
    assert "pa ss" not in shown and "word" not in shown
