"""Who a server says it is (w33): the pure helpers of `connectors/identity.py` - the deny-list of default application URIs, the
certificate thumbprint, reading an OPC UA GetEndpoints answer, and the key two sources are compared on. No I/O."""

import hashlib

import pytest
from asyncua import ua

from dcdash.connectors import identity as ident
from dcdash.simulator.faultserver import make_server_certificate


def endpoint(uri="urn:acme:plc:7", name="Acme PLC", product="urn:acme:product", certificate=None):
    """A real asyncua EndpointDescription, as GetEndpoints returns it."""
    server = ua.ApplicationDescription()
    server.ApplicationUri, server.ProductUri = uri, product
    server.ApplicationName = ua.LocalizedText(name) if name is not None else ua.LocalizedText()
    found = ua.EndpointDescription()
    found.EndpointUrl, found.Server = "opc.tcp://10.0.0.5:4840/", server
    if certificate is not None:
        found.ServerCertificate = certificate
    return found


def sha1_pairs(der: bytes) -> str:
    digest = hashlib.sha1(der).hexdigest().upper()
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


# ---- the deny-list ----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("uri", [
    "urn:freeopcua:python:server", "urn:open62541.server.application", "urn:unconfigured:application",
    "URN:FreeOpcUa:Python:Server", "  urn:unconfigured:application  ", "\turn:open62541.server.application\n",
])
def test_a_default_application_uri_is_recognised_whatever_its_case_or_padding(uri):
    assert ident.is_default_uri(uri) is True
    assert ident.usable_key("opcua", {"application_uri": uri}) is None


@pytest.mark.parametrize("uri", ["urn:acme:plc:7", "urn:freeopcua:python:server:2", "http://plant.example/ua", "", "   ", None, 5])
def test_anything_else_is_not_a_default_uri(uri):
    assert ident.is_default_uri(uri) is False


def test_the_default_uris_are_lower_case_so_the_comparison_can_lower_the_server_s_text():
    assert ident.DEFAULT_URIS == {
        "urn:freeopcua:python:server", "urn:open62541.server.application", "urn:unconfigured:application",
    }
    assert all(uri == uri.lower() for uri in ident.DEFAULT_URIS)


# ---- clip -------------------------------------------------------------------------------------------------------------------


def test_clip_strips_cuts_at_256_and_turns_empty_into_none():
    assert ident.MAX_TEXT == 256
    assert ident.clip("  urn:acme:plc:7 \n") == "urn:acme:plc:7"
    assert ident.clip("a" * 300) == "a" * 256 and len(ident.clip("é" * 300)) == 256
    assert ident.clip("") is None and ident.clip("   \n\t") is None
    assert ident.clip(None) is None and ident.clip(5) is None and ident.clip(b"bytes") is None


def test_clip_drops_a_nul_character_which_a_json_column_cannot_store():
    assert ident.clip("urn:a\x00cme") == "urn:acme" and ident.clip("\x00") is None


# ---- the certificate and its thumbprint -------------------------------------------------------------------------------------


def test_the_thumbprint_is_the_sha1_of_the_der_in_upper_case_pairs_joined_by_colons():
    der = make_server_certificate("urn:acme:plc:7").der
    thumbprint = ident.thumbprint_of(der)
    assert thumbprint == sha1_pairs(der)
    assert len(thumbprint) == 20 * 3 - 1 and thumbprint == thumbprint.upper() and thumbprint.count(":") == 19


def test_a_chain_gives_the_thumbprint_of_the_first_certificate_only():
    first, second = make_server_certificate("urn:first").der, make_server_certificate("urn:second").der
    assert first != second
    assert ident.first_certificate_der(first + second) == first
    assert ident.thumbprint_of(first + second) == sha1_pairs(first) != sha1_pairs(first + second)
    assert ident.thumbprint_of(first) == ident.thumbprint_of(first + second)  # the chain's tail changes nothing


def test_a_short_form_length_is_read_too():
    sequence = bytes([0x30, 0x03, 1, 2, 3])
    assert ident.first_certificate_der(sequence + b"tail") == sequence
    assert ident.first_certificate_der(sequence) == sequence
    long_form = bytes([0x30, 0x81, 0x80]) + bytes(range(128))  # one length byte: 128 content bytes
    assert ident.first_certificate_der(long_form + sequence) == long_form


@pytest.mark.parametrize("blob", [
    None, b"", b"\x30", b"junk", b"\x00" * 40, bytes([0x31, 0x01, 0x00]),  # empty, a lone tag, not a SEQUENCE
    bytes([0x30, 0x05, 1, 2]),  # shorter than its own length
    bytes([0x30, 0x82, 0xFF]),  # a long form cut inside its length bytes
    bytes([0x30, 0x80, 1, 2, 0, 0]),  # the indefinite length, which DER never uses
    bytes([0x30, 0x00]),  # an empty SEQUENCE is no certificate
    bytes([0x30, 0x89]) + b"\x01" * 9,  # a length of nine bytes
    "not bytes", 12,
])
def test_junk_has_no_first_certificate_and_no_thumbprint(blob):
    assert ident.first_certificate_der(blob) is None
    assert ident.thumbprint_of(blob) is None


# ---- reading GetEndpoints ---------------------------------------------------------------------------------------------------


def test_from_endpoints_reads_the_uri_name_product_and_certificate_thumbprint():
    der = make_server_certificate("urn:acme:plc:7").der
    found = ident.from_endpoints([endpoint(certificate=der)])
    assert found == {
        "application_uri": "urn:acme:plc:7", "application_name": "Acme PLC", "product_uri": "urn:acme:product",
        "thumbprint": sha1_pairs(der),
    }


def test_from_endpoints_takes_the_first_non_empty_value_of_each_field():
    der = make_server_certificate("urn:acme:plc:7").der
    other = make_server_certificate("urn:acme:other").der
    found = ident.from_endpoints([
        endpoint(uri="", name=None, product=" ", certificate=None),  # says nothing
        endpoint(uri="urn:first", name="First", product="urn:first:product", certificate=der),
        endpoint(uri="urn:second", name="Second", product="urn:second:product", certificate=other),
    ])
    assert found == {
        "application_uri": "urn:first", "application_name": "First", "product_uri": "urn:first:product", "thumbprint": sha1_pairs(der),
    }


def test_from_endpoints_leaves_out_what_the_server_does_not_say():
    assert ident.from_endpoints([endpoint(uri="urn:only", name=None, product="")]) == {"application_uri": "urn:only"}
    assert ident.from_endpoints([]) == {} and ident.from_endpoints(None) == {}


def test_from_endpoints_cuts_every_text_at_256_characters():
    der = make_server_certificate("urn:acme:plc:7").der
    found = ident.from_endpoints([endpoint(uri="urn:" + "u" * 400, name="n" * 400, product="p" * 400, certificate=der)])
    assert len(found["application_uri"]) == len(found["application_name"]) == len(found["product_uri"]) == 256
    assert len(found["thumbprint"]) == 59


def test_from_endpoints_is_tolerant_of_missing_attributes_and_junk():
    class Bare:  # no Server, no certificate
        pass

    class Half:
        Server = None
        ServerCertificate = b"not a certificate"

    class Odd:
        class Server:  # noqa: D106
            ApplicationUri = 7
            ProductUri = None
            ApplicationName = "plain text"  # a str where a LocalizedText is expected

    assert ident.from_endpoints([Bare(), Half(), None, Odd()]) == {"application_name": "plain text"}
    assert ident.from_endpoints(7) == {}


# ---- the key two sources are compared on ------------------------------------------------------------------------------------


def test_the_opcua_key_is_the_application_uri_unless_it_is_a_default_or_empty():
    assert ident.usable_key("opcua", {"application_uri": "urn:acme:plc:7"}) == ("uri", "urn:acme:plc:7")
    assert ident.usable_key("opcua", {"application_uri": "  urn:acme:plc:7 "}) == ("uri", "urn:acme:plc:7")
    assert ident.usable_key("opcua", {"application_uri": "urn:freeopcua:python:server"}) is None
    assert ident.usable_key("opcua", {"application_uri": "   "}) is None
    assert ident.usable_key("opcua", {"application_name": "Acme", "thumbprint": "AA"}) is None  # a name or a thumbprint is no key
    assert ident.usable_key("opcua", {"application_uri": 7}) is None


def test_the_simulator_key_is_its_instance_id():
    assert ident.usable_key("simulator", {"instance": "dev"}) == ("instance", "dev")
    assert ident.usable_key("simulator", {"instance": " lab-2 "}) == ("instance", "lab-2")
    assert ident.usable_key("simulator", {"instance": ""}) is None and ident.usable_key("simulator", {}) is None
    assert ident.usable_key("simulator", {"application_uri": "urn:acme:plc:7"}) is None  # the wrong kind of identity


@pytest.mark.parametrize("connector_type", ["modbus", "file", "", "unknown", None])
def test_no_other_kind_of_source_has_a_key(connector_type):
    assert ident.usable_key(connector_type, {"application_uri": "urn:acme:plc:7", "instance": "dev"}) is None


@pytest.mark.parametrize("identity", [None, [], "urn:acme:plc:7", 5])
def test_something_that_is_not_an_identity_has_no_key(identity):
    assert ident.usable_key("opcua", identity) is None and ident.usable_key("simulator", identity) is None


def test_thumbprints_conflict_only_when_both_are_present_and_different():
    a, b = sha1_pairs(b"one"), sha1_pairs(b"two")
    assert ident.thumbprints_conflict(a, b) is True
    assert ident.thumbprints_conflict(a, a) is False
    assert ident.thumbprints_conflict(a, a.lower()) is False  # the same bytes in another case
    assert ident.thumbprints_conflict(a, a.replace(":", "")) is False and ident.thumbprints_conflict(a, a.replace(":", " ")) is False
    assert ident.thumbprints_conflict(a, None) is False and ident.thumbprints_conflict(None, b) is False
    assert ident.thumbprints_conflict(None, None) is False and ident.thumbprints_conflict("", b) is False
