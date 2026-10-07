from asyncua import Client, ua

from dcdash.simulator.model import PANELS, SIGNALS, Simulator
from tests.helpers import opcua_server


async def test_exposes_sixty_double_variables():
    async with opcua_server() as srv:
        async with Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1")) as client:
            panels = await client.nodes.objects.get_child(["2:Panels"])
            count = 0
            for panel in await panels.get_children():
                for var in await panel.get_children():
                    if await var.read_node_class() == ua.NodeClass.Variable:
                        assert await var.read_data_type_as_variant_type() == ua.VariantType.Double
                        count += 1
            assert count == len(PANELS) * len(SIGNALS)


async def test_values_track_the_model():
    sim = Simulator()
    async with opcua_server(sim) as srv:
        await srv.refresh()
        async with Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1")) as client:
            node = await client.nodes.objects.get_child(["2:Panels", "2:LVP01", "2:V"])
            assert await node.read_value() == 400.0


async def test_reject_auth_refuses_password_login():
    sim = Simulator()
    async with opcua_server(sim, password="pw") as srv:
        sim.reject_auth = True
        client = Client(srv.endpoint.replace("0.0.0.0", "127.0.0.1"))
        client.set_user("sim")
        client.set_password("pw")
        try:
            await client.connect()
        except ua.UaStatusCodeError as exc:
            assert exc.code in (ua.StatusCodes.BadUserAccessDenied, ua.StatusCodes.BadIdentityTokenRejected)
        else:
            await client.disconnect()
            raise AssertionError("login should have been rejected")
