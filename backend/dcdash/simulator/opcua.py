from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from asyncua import Node, ua
from asyncua.crypto.truststore import TrustStore
from asyncua.crypto.validator import CertificateValidator, CertificateValidatorOptions
from asyncua.server.user_managers import User, UserRole

from dcdash.simulator.faultserver import ServerCertificate, _FaultServer, make_server_certificate
from dcdash.simulator.faults import UNTRUSTED_AT_SESSION, FaultConfigError, Faults
from dcdash.simulator.model import PANELS, SIGNALS, Simulator

OPCUA_NAMESPACE = "urn:dcdash:simulator"
POLICY_TYPES = {
    "none": ua.SecurityPolicyType.NoSecurity,
    "basic256sha256": ua.SecurityPolicyType.Basic256Sha256_SignAndEncrypt,
}


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
    def __init__(self, sim: Simulator, port: int, username: str = "sim", password: str | None = None, *,
                 faults: Faults | None = None) -> None:
        self.faults = faults or Faults()
        if self.faults.auth_required and not password:
            raise FaultConfigError("SIM_FAULT_AUTH=required needs SIM_OPCUA_PASSWORD (the password of the user 'sim').")
        self.sim = sim
        self.endpoint = f"opc.tcp://0.0.0.0:{port}/dcdash/"
        self._users = _Users(sim, username, password)
        self._server: _FaultServer | None = None
        self._vars: dict[str, Node] = {}
        self._bad = {address: ua.StatusCode(getattr(ua.StatusCodes, status)) for address, status in self.faults.bad_nodes}
        self.server_certificate: ServerCertificate | None = None  # made on first use and kept, so the thumbprint survives restarts

    async def start(self) -> None:
        server = _FaultServer(self.faults, user_manager=self._users)
        await server.init()
        server.set_endpoint(self.endpoint)
        await self._apply_security_faults(server)
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

    async def _apply_security_faults(self, server: _FaultServer) -> None:
        faults = self.faults
        server.set_security_policy([POLICY_TYPES[policy] for policy in faults.offered_policies])
        if faults.needs_server_certificate:
            if self.server_certificate is None:
                self.server_certificate = make_server_certificate(server.get_application_uri(), faults.cert_hosts)
            await server.load_certificate(self.server_certificate.der)
            await server.load_private_key(self.server_certificate.key_der)
        if faults.auth_required:
            server.set_identity_tokens([ua.UserNameIdentityToken])  # no anonymous login; _Users then checks the password
        if faults.untrusted_cert and faults.untrusted_cert_at == UNTRUSTED_AT_SESSION:
            # asyncua's own check, which refuses at CreateSession (a real stack refuses earlier: see _FaultProtocol); no trusted
            # certificate at all, so every client certificate fails
            options = CertificateValidatorOptions.TRUSTED | CertificateValidatorOptions.PEER_CLIENT
            server.set_certificate_validator(CertificateValidator(options, TrustStore([], [])))

    async def stop(self) -> None:
        if self._server is not None:
            await self._server.stop()
            self._server = None

    async def refresh(self) -> None:
        now = datetime.now(timezone.utc)
        self.sim.advance(now)
        stamp = now + timedelta(seconds=self.faults.skew_seconds)  # SKEW: the server stamps its points with its own, wrong, clock
        stamped = self._server is not None and bool(self._bad or self.faults.skew_seconds)
        for address, var in self._vars.items():
            value = self.sim.read(address, now)
            if value is None:
                continue
            if not stamped:
                await var.write_value(float(value))
                continue
            # BAD: asyncua nulls the value of a Bad DataValue, as the specification says a server must
            data_value = ua.DataValue(
                ua.Variant(float(value), ua.VariantType.Double), self._bad.get(address, ua.StatusCode()),
                SourceTimestamp=stamp, ServerTimestamp=stamp,
            )
            await self._server.write_attribute_value(var.nodeid, data_value)

    async def run(self, period: float = 1.0) -> None:
        while True:
            if self.sim.offline and self._server is not None:
                await self.stop()
            elif not self.sim.offline and self._server is None:
                await self.start()
            if self._server is not None:
                await self.refresh()
            await asyncio.sleep(period)
