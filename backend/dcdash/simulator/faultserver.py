"""The asyncua server the OPC UA simulator runs: one subclass per OpcUaSim instance, so a fault lives and dies with its server.

asyncua gives no hook between the socket and its message processing, so `_FaultServer.start()` repeats the few lines of
`asyncua.Server.start()` (asyncua 1.1.8, pinned by a test that fails on any other version) and builds a `_FaultBinaryServer`, whose
protocol factory returns a `_FaultProtocol` that carries this instance's `Faults`. Nothing is patched on an asyncua class, so
servers with different faults can run in one process (the tests do) and nothing outlives `stop()`.

The extension points the behavioural faults hook into are the empty `_before_message`, `_connection_opened`, `_connection_closed`
of `_FaultProtocol` and `_after_start`, `_before_stop` of `_FaultServer`.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from asyncua import Server, ua
from asyncua.crypto import uacrypto
from asyncua.server.binary_server_asyncio import BinaryServer, OPCUAProtocol
from asyncua.ua.ua_binary import struct_from_binary, uatcp_to_binary
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from dcdash.simulator.faults import UNTRUSTED_AT_CHANNEL, Faults

_logger = logging.getLogger(__name__)
NONE_POLICY_SUFFIX = "#None"


class _FaultProtocol(OPCUAProtocol):
    """asyncua's per-connection protocol plus this server's faults (passed in by the factory, never a class attribute)."""

    def __init__(self, *args, faults: Faults, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.faults = faults

    def connection_made(self, transport) -> None:
        super().connection_made(transport)
        self._connection_opened()

    def connection_lost(self, ex) -> None:
        self._connection_closed()
        super().connection_lost(ex)

    async def _process_one_msg(self, header, buf) -> None:
        await self._before_message(header, buf)
        if self.faults.untrusted_cert and self.faults.untrusted_cert_at == UNTRUSTED_AT_CHANNEL and self._is_secure_channel_request(header, buf):
            self._refuse_channel()
            return
        await super()._process_one_msg(header, buf)

    # -- extension points of the behavioural faults (empty here) --------------------------------------------------------------
    async def _before_message(self, header, buf) -> None:
        """Runs before every incoming message is processed."""

    def _connection_opened(self) -> None:
        """Runs when a client connection is accepted."""

    def _connection_closed(self) -> None:
        """Runs when a client connection is gone (whoever closed it), before asyncua cleans up."""

    # -- UNTRUSTED_CERT=1 -------------------------------------------------------------------------------------------------------
    @staticmethod
    def _is_secure_channel_request(header, buf) -> bool:
        """An OpenSecureChannel that asks for a security policy; the None policy (discovery, GetEndpoints) is not one."""
        if header.MessageType != ua.MessageType.SecureOpen:
            return False
        try:
            policy_uri = struct_from_binary(ua.AsymmetricAlgorithmHeader, buf.copy(header.body_size)).SecurityPolicyURI
        except Exception:  # not parseable: let asyncua deal with it the way it always has
            return False
        return not str(policy_uri or "").endswith(NONE_POLICY_SUFFIX)

    def _refuse_channel(self) -> None:
        """What a real stack does with a certificate it does not trust: a TCP ERR message, then it closes the socket."""
        reason = "The client certificate is not trusted"
        error = ua.ErrorMessage(ua.StatusCode(ua.StatusCodes.BadSecurityChecksFailed), reason)
        self.transport.write(uatcp_to_binary(ua.MessageType.Error, error))
        self.transport.close()


class _FaultBinaryServer(BinaryServer):
    def __init__(self, *args, faults: Faults, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.faults = faults

    def _make_protocol(self) -> _FaultProtocol:
        return _FaultProtocol(
            iserver=self.iserver, policies=self._policies, clients=self.clients, closing_tasks=self.closing_tasks,
            limits=self.limits, faults=self.faults,
        )


class _FaultServer(Server):
    def __init__(self, faults: Faults, **kwargs) -> None:
        super().__init__(**kwargs)
        self.faults = faults

    async def start(self) -> None:
        """asyncua 1.1.8's Server.start(), with the binary server swapped for the fault one."""
        if self.iserver.certificate is not None:
            uacrypto.check_certificate(self.iserver.certificate, self._application_uri, socket.gethostname())
        await self._setup_server_nodes()
        await self.iserver.start()
        try:
            host, port = self._get_bind_socket_info()
            self.bserver = _FaultBinaryServer(self.iserver, host, port, self.limits, faults=self.faults)
            self.bserver.set_policies(self._policies)
            await self.bserver.start()
        except Exception:
            _logger.exception("%s error starting server", self)
            await self.iserver.stop()
            raise
        await self._after_start()

    async def stop(self) -> None:
        await self._before_stop()
        await super().stop()

    # -- extension points of the behavioural faults (empty here) --------------------------------------------------------------
    async def _after_start(self) -> None:
        """Runs once the server listens."""

    async def _before_stop(self) -> None:
        """Runs first in stop(); whatever _after_start began ends here."""


@dataclass(frozen=True)
class ServerCertificate:
    der: bytes
    key_der: bytes

    @property
    def thumbprint(self) -> str:
        return x509.load_der_x509_certificate(self.der).fingerprint(hashes.SHA1()).hex().upper()  # SHA-1 is OPC UA's certificate thumbprint


def make_server_certificate(application_uri: str, hosts: tuple[str, ...] = ()) -> ServerCertificate:
    """A self-signed server certificate like a gateway ships: SAN with the application URI and the names the simulator answers to."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "dcdash-simulator")])
    names = list(dict.fromkeys(["simulator", "localhost", *([socket.gethostname()] if socket.gethostname() else []), *hosts]))
    alternative: list[x509.GeneralName] = [x509.UniformResourceIdentifier(application_uri)]
    alternative += [x509.DNSName(host) for host in names]
    alternative.append(x509.IPAddress(ipaddress.ip_address("127.0.0.1")))
    start = datetime.now(timezone.utc) - timedelta(days=1)
    certificate = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(start + timedelta(days=5 * 365))
        .add_extension(x509.SubjectAlternativeName(alternative), critical=False)
        .add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=True, key_encipherment=True, data_encipherment=True, key_agreement=False,
            key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False,
        ), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return ServerCertificate(
        der=certificate.public_bytes(serialization.Encoding.DER),
        key_der=key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
    )
