import pytest

from dcdash.connectors.base import BAD, GOOD, ConnectorError, create_connector
from dcdash.simulator.model import Simulator
from tests.helpers import opcua_server


def _cfg(srv, **extra):
    return {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2, **extra}


async def test_registered():
    from dcdash.connectors.base import connector_types
    assert "opcua" in connector_types()


async def test_test_ok_and_latency():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        check = await c.test()
        assert check.ok and check.status == "ok" and check.latency_ms is not None


async def test_browse_lists_variables_with_units():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        points = await c.browse()
        assert len(points) == 60
        kw = next(p for p in points if p.name == "LVP01 kW")
        assert kw.unit_hint == "kW" and kw.address.startswith("ns=2;")
        pf = next(p for p in points if p.name == "LVP01 PF")
        assert pf.unit_hint is None


async def test_read_batch_and_unknown_node():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        points = {p.name: p.address for p in await c.browse()}
        values = await c.read([points["LVP01 V"], "ns=2;i=999999"])
        assert values[0].value == 400.0 and values[0].quality == GOOD
        assert values[1].value is None and values[1].quality == BAD


async def test_auth_failed_status():
    sim = Simulator()
    async with opcua_server(sim, password="pw") as srv:
        sim.reject_auth = True
        c = create_connector("opcua", _cfg(srv, username="sim"), secret="pw")
        assert (await c.test()).status == "auth_failed"


async def test_unreachable_status():
    c = create_connector("opcua", {"endpoint": "opc.tcp://127.0.0.1:1/", "timeout_seconds": 1})
    assert (await c.test()).status == "unreachable"


async def test_read_after_server_stop_raises_unreachable():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        addr = (await c.browse())[0].address
        assert (await c.read([addr]))[0].quality == GOOD
        await srv.stop()
        with pytest.raises(ConnectorError) as exc:
            await c.read([addr])
        assert exc.value.status == "unreachable"
        await srv.start()
        assert (await c.read([addr]))[0].quality == GOOD


async def test_basic256sha256_without_client_cert_is_a_clear_error(tmp_path):
    missing = str(tmp_path / "opcua-client.pem")
    cfg = {
        "endpoint": "opc.tcp://127.0.0.1:1", "security_policy": "basic256sha256",
        "client_cert": missing, "client_key": str(tmp_path / "opcua-client-key.pem"),
    }
    c = create_connector("opcua", cfg)
    check = await c.test()
    assert not check.ok and check.status == "protocol_error"
    assert check.message == f"client certificate not found: {missing}"
    with pytest.raises(ConnectorError) as exc:
        await c.read(["i=2258"])
    assert exc.value.status == "protocol_error" and "client certificate not found" in exc.value.message
    with pytest.raises(ConnectorError):
        await c.browse()


def test_opcua_defaults_point_at_mounted_certs():
    from dcdash.connectors.opcua import OpcUaConfig
    cfg = OpcUaConfig(endpoint="opc.tcp://h:4840")
    assert cfg.client_cert == "/certs/opcua-client.pem" and cfg.client_key == "/certs/opcua-client-key.pem"


async def test_a_bad_reading_says_why_in_its_status_and_a_good_one_has_none():
    async with opcua_server() as srv:
        c = create_connector("opcua", _cfg(srv))
        points = {p.name: p.address for p in await c.browse()}
        values = await c.read([points["LVP01 V"], "ns=2;i=999999"])
        assert values[0].status is None
        assert values[1].quality == BAD and values[1].status == "BadNodeIdUnknown (0x80340000)"


def _data_value(value=None, code=None, variant_type=None):
    from asyncua import ua

    variant = None if variant_type is None else ua.Variant(value, variant_type)
    return ua.DataValue(Value=variant, StatusCode_=None if code is None else ua.StatusCode(code))


def test_point_value_turns_a_data_value_into_a_reading_with_the_reason_when_it_is_bad():
    from datetime import datetime, timezone

    from asyncua import ua

    from dcdash.connectors.opcua import _point_value

    ts = datetime(2026, 10, 12, tzinfo=timezone.utc)

    def read(**kwargs):
        value = _point_value("ns=2;i=1", ts, _data_value(**kwargs))
        return value.value, value.quality, value.status

    assert read(value=7, variant_type=ua.VariantType.Int32) == (7.0, GOOD, None)
    assert read(value=2.5, variant_type=ua.VariantType.Double, code=ua.StatusCodes.Good) == (2.5, GOOD, None)
    assert read(value=2.5, variant_type=ua.VariantType.Double, code=ua.StatusCodes.GoodLocalOverride) == (2.5, GOOD, None)
    assert read(code=ua.StatusCodes.BadNodeIdUnknown) == (None, BAD, "BadNodeIdUnknown (0x80340000)")
    assert read(value=1.0, variant_type=ua.VariantType.Double, code=ua.StatusCodes.BadSensorFailure) == (
        None, BAD, "BadSensorFailure (0x808C0000)")
    assert read(value=1.0, variant_type=ua.VariantType.Double, code=ua.StatusCodes.UncertainInitialValue) == (
        None, BAD, "UncertainInitialValue (0x40920000)")
    assert read(value=True, variant_type=ua.VariantType.Boolean) == (None, BAD, "Good, non-numeric (Boolean)")
    assert read(value="on", variant_type=ua.VariantType.String) == (None, BAD, "Good, non-numeric (String)")
    assert read() == (None, BAD, "Good, non-numeric (Null)")
    unknown = _point_value("a", ts, ua.DataValue(StatusCode_=ua.StatusCode(0x80ABCDEF)))
    assert unknown.status == "Bad (0x80ABCDEF)"  # asyncua names an unknown code only "Bad": the hex tells which
