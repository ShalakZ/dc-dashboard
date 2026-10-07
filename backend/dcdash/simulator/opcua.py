from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from asyncua import Node, Server, ua
from asyncua.server.user_managers import User, UserRole

from dcdash.simulator.model import PANELS, SIGNALS, Simulator

OPCUA_NAMESPACE = "urn:dcdash:simulator"


class _Users:
    """Duck-typed asyncua user manager: honours the simulator's reject_auth fault."""

    def __init__(self, sim: Simulator, username: str, password: str | None) -> None:
        self.sim, self.username, self.password = sim, username, password

    def get_user(self, iserver, username=None, password=None, certificate=None):
        if self.password is None:
            return User(role=UserRole.User)
        if self.sim.reject_auth or username != self.username or password != self.password:
            return None
        return User(role=UserRole.User)


class OpcUaSim:
    def __init__(self, sim: Simulator, port: int, username: str = "sim", password: str | None = None) -> None:
        self.sim = sim
        self.endpoint = f"opc.tcp://0.0.0.0:{port}/dcdash/"
        self._users = _Users(sim, username, password)
        self._server: Server | None = None
        self._vars: dict[str, Node] = {}

    async def start(self) -> None:
        server = Server(user_manager=self._users)
        await server.init()
        server.set_endpoint(self.endpoint)
        server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        idx = await server.register_namespace(OPCUA_NAMESPACE)
        panels = await server.nodes.objects.add_object(idx, "Panels")
        self._vars = {}
        for panel in PANELS:
            obj = await panels.add_object(idx, panel)
            for signal, unit in SIGNALS.items():
                var = await obj.add_variable(idx, signal, 0.0, ua.VariantType.Double)
                await var.write_attribute(
                    ua.AttributeIds.DisplayName,
                    ua.DataValue(ua.Variant(ua.LocalizedText(f"{panel} {signal}"), ua.VariantType.LocalizedText)),
                )
                if unit:
                    eu = ua.EUInformation(DisplayName=ua.LocalizedText(unit), Description=ua.LocalizedText(unit))
                    await var.add_property(idx, "EngineeringUnits", eu)
                self._vars[f"{panel}_{signal}"] = var
        await server.start()
        self._server = server

    async def stop(self) -> None:
        if self._server is not None:
            await self._server.stop()
            self._server = None

    async def refresh(self) -> None:
        now = datetime.now(timezone.utc)
        self.sim.advance(now)
        for address, var in self._vars.items():
            value = self.sim.read(address, now)
            if value is not None:
                await var.write_value(float(value))

    async def run(self, period: float = 1.0) -> None:
        while True:
            if self.sim.offline and self._server is not None:
                await self.stop()
            elif not self.sim.offline and self._server is None:
                await self.start()
            if self._server is not None:
                await self.refresh()
            await asyncio.sleep(period)
