"""SIM_INSTANCE_ID (w33): who a simulator is. It is read once in `simulator/main.py` and announced over HTTP (`GET /`) and as the OPC
UA application URI `urn:dcdash:simulator:<id>`, so the platform can tell one simulator from another when an address changes."""
import hashlib

import httpx
import pytest
from asyncua import Client

from dcdash.simulator import main as simulator_main
from dcdash.simulator.app import create_sim_app
from dcdash.simulator.faults import Faults
from dcdash.simulator.model import Simulator
from dcdash.simulator.opcua import OPCUA_NAMESPACE, OpcUaSim
from tests.helpers import free_port, opcua_server

V_PATH = ["2:Panels", "2:LVP01", "2:V"]


def url(srv: OpcUaSim) -> str:
    return srv.endpoint.replace("0.0.0.0", "127.0.0.1")


async def endpoints_of(srv: OpcUaSim):
    return await Client(url(srv)).connect_and_get_server_endpoints()


# ---- reading the environment ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["dev", "other", "lab-2", "a.b_c-D9", "x", "A" * 40])
def test_a_well_formed_id_is_taken_as_it_is(value):
    assert simulator_main.instance_id({"SIM_INSTANCE_ID": value}) == value


@pytest.mark.parametrize("value", [
    "", " ", "two words", "has space ", "dev\n", "\ndev", "urn:evil", "a/b", "A" * 41, "é", "dev;rm", "a\x00b", "<x>",
])
def test_a_bad_id_falls_back_to_dev(value):
    assert simulator_main.instance_id({"SIM_INSTANCE_ID": value}) == "dev"


def test_without_the_variable_the_id_is_dev():
    assert simulator_main.instance_id({}) == "dev" == simulator_main.DEFAULT_INSTANCE


def test_the_environment_reaches_serve(monkeypatch):
    seen: dict = {}

    def serve(**kwargs):  # main() hands this to asyncio.run, which is replaced too: nothing runs and no loop is touched
        seen.update(kwargs)

    monkeypatch.setattr(simulator_main, "serve", serve)
    monkeypatch.setattr(simulator_main.asyncio, "run", lambda coroutine: None)
    simulator_main.main({"SIM_INSTANCE_ID": "lab-2"})
    assert seen["instance"] == "lab-2"
    simulator_main.main({"SIM_INSTANCE_ID": "not valid"})
    assert seen["instance"] == "dev"


# ---- HTTP -------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("kwargs, instance", [({}, "dev"), ({"instance": "lab-2"}, "lab-2")])
async def test_the_http_root_announces_the_instance_without_a_key(kwargs, instance):
    app = create_sim_app(Simulator(), api_key="k", **kwargs)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://sim") as c:
        response = await c.get("/")
    assert response.status_code == 200 and response.json() == {"service": "dcdash-simulator", "instance": instance}


# ---- OPC UA -----------------------------------------------------------------------------------------------------------------


async def test_the_opcua_server_announces_urn_dcdash_simulator_dev_by_default():
    async with opcua_server() as srv:
        found = await endpoints_of(srv)
    assert found and {endpoint.Server.ApplicationUri for endpoint in found} == {"urn:dcdash:simulator:dev"}


async def test_the_opcua_server_announces_the_instance_it_was_given():
    srv = OpcUaSim(Simulator(), free_port(), instance="other")
    await srv.start()
    try:
        found = await endpoints_of(srv)
    finally:
        await srv.stop()
    assert {endpoint.Server.ApplicationUri for endpoint in found} == {"urn:dcdash:simulator:other"}


async def test_the_application_uri_does_not_move_the_simulators_own_namespace():
    """asyncua's set_application_uri rewrites namespace index 1; the simulator's namespace is registered after it, so every
    `ns=2;...` node id (the collector's mappings, the docs, the tests) keeps its value."""
    async with opcua_server() as srv:
        async with Client(url(srv)) as client:
            namespaces = await client.get_namespace_array()
            assert namespaces[1] == "urn:dcdash:simulator:dev" and namespaces[2] == OPCUA_NAMESPACE
            assert await client.get_namespace_index(OPCUA_NAMESPACE) == 2
            node = await client.nodes.objects.get_child(V_PATH)
            assert node.nodeid.NamespaceIndex == 2
            assert await node.read_value() == 400.0


async def test_a_secure_server_s_certificate_carries_the_instance_uri_and_the_thumbprint_survives_a_restart():
    faults = Faults.from_env({"SIM_FAULT_POLICIES": "basic256sha256"})
    srv = OpcUaSim(Simulator(), free_port(), faults=faults, instance="lab-2")
    await srv.start()
    try:
        endpoint = (await endpoints_of(srv))[0]
        assert endpoint.Server.ApplicationUri == "urn:dcdash:simulator:lab-2"
        from cryptography import x509

        names = x509.load_der_x509_certificate(endpoint.ServerCertificate).extensions.get_extension_for_class(
            x509.SubjectAlternativeName).value
        assert names.get_values_for_type(x509.UniformResourceIdentifier) == ["urn:dcdash:simulator:lab-2"]
        before = hashlib.sha1(endpoint.ServerCertificate).hexdigest().upper()
        await srv.stop()
        await srv.start()  # the offline toggle rebuilds the server; the same certificate (and URI) comes back
        again = (await endpoints_of(srv))[0]
        assert hashlib.sha1(again.ServerCertificate).hexdigest().upper() == before
        assert again.Server.ApplicationUri == "urn:dcdash:simulator:lab-2"
    finally:
        await srv.stop()


async def test_the_uri_is_still_the_one_the_server_reports_after_the_offline_toggle():
    async with opcua_server() as srv:
        await srv.stop()
        await srv.start()
        assert {e.Server.ApplicationUri for e in await endpoints_of(srv)} == {"urn:dcdash:simulator:dev"}
