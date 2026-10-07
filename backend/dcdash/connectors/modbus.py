"""Modbus TCP connector: read-only (FC 3, 4 and 43/14), register layout from a YAML profile."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from pydantic import BaseModel, Field
from pymodbus.client import AsyncModbusTcpClient
from pymodbus.exceptions import ModbusException
from pymodbus.pdu.mei_message import ReadDeviceInformationRequest

from dcdash.connectors.base import (
    BAD,
    GOOD,
    ConnectionCheck,
    Connector,
    ConnectorError,
    PointDescriptor,
    PointValue,
    register,
)
from dcdash.core.registers import decode, register_count
from dcdash.profiles import Profile, RegisterBlock, list_profiles, load_profile, match_profile


class ModbusConfig(BaseModel):
    host: str
    port: int = Field(502, ge=1, le=65535)
    unit_id: int = Field(1, ge=0, le=247)
    profile: str = Field("auto", json_schema_extra={"title": "Device profile", "enum": ["auto", *list_profiles()]})
    timeout_seconds: float = Field(3.0, ge=0.5, le=30)


@register
class ModbusConnector(Connector):
    type = "modbus"
    config_schema = ModbusConfig

    def __init__(self, config: ModbusConfig, secret: str | None = None) -> None:
        super().__init__(config, secret)
        self.config: ModbusConfig = config

    async def _connect(self) -> AsyncModbusTcpClient:
        client = AsyncModbusTcpClient(self.config.host, port=self.config.port, timeout=self.config.timeout_seconds)
        try:
            ok = await asyncio.wait_for(client.connect(), self.config.timeout_seconds + 1)
        except asyncio.TimeoutError:
            raise ConnectorError("timeout", "connect timed out") from None
        except OSError as exc:
            raise ConnectorError("unreachable", str(exc)) from exc
        if not ok:
            client.close()
            raise ConnectorError("unreachable", f"connection to {self.config.host}:{self.config.port} refused")
        return client

    async def _identify(self, client: AsyncModbusTcpClient) -> tuple[str | None, str | None]:
        try:
            rr = await client.execute(False, ReadDeviceInformationRequest(read_code=1, dev_id=self.config.unit_id))
        except (ModbusException, asyncio.TimeoutError):
            return None, None
        if rr.isError():
            return None, None
        info = getattr(rr, "information", {})
        vendor = _text(info.get(0)) or None
        product = _text(info.get(1)) or None
        return vendor, product

    async def resolve_profile(self, client: AsyncModbusTcpClient) -> Profile:
        if self.config.profile != "auto":
            try:
                return load_profile(self.config.profile)
            except KeyError:
                raise ConnectorError("needs_profile", f"profile {self.config.profile!r} is not installed") from None
        vendor, product = await self._identify(client)
        matched = match_profile(vendor, product)
        if matched is None:
            raise ConnectorError("needs_profile", f"no profile matches {vendor or '?'}/{product or '?'}; pick one")
        return matched

    async def test(self) -> ConnectionCheck:
        started = time.perf_counter()
        try:
            client = await self._connect()
            try:
                profile = await self.resolve_profile(client)
                await self._read_block(client, profile.blocks[0])
            finally:
                client.close()
        except ConnectorError as exc:
            return ConnectionCheck(ok=False, status=exc.status, message=exc.message)
        return ConnectionCheck(
            ok=True,
            status="ok",
            latency_ms=(time.perf_counter() - started) * 1000,
            message=f"profile {profile.name}",
        )

    async def browse(self) -> list[PointDescriptor]:
        client = await self._connect()
        try:
            profile = await self.resolve_profile(client)
        finally:
            client.close()
        return [
            PointDescriptor(
                address=f"{b.function}:{b.start + p.offset}", name=p.name, data_type=p.data_type, unit_hint=p.unit
            )
            for b in profile.blocks
            for p in b.points
        ]

    async def _read_block(self, client: AsyncModbusTcpClient, block: RegisterBlock) -> list[int]:
        fn = client.read_holding_registers if block.function == 3 else client.read_input_registers
        try:
            rr = await fn(block.start, count=block.count, slave=self.config.unit_id)
        except asyncio.TimeoutError:
            raise ConnectorError("timeout", f"block {block.function}:{block.start} timed out") from None
        except (ModbusException, OSError) as exc:
            raise ConnectorError("unreachable", str(exc)) from exc
        if rr.isError():
            raise ConnectorError("protocol_error", f"exception response for block {block.function}:{block.start}: {rr}")
        return list(rr.registers)

    async def read(self, addresses: list[str]) -> list[PointValue]:
        ts = datetime.now(timezone.utc)
        client = await self._connect()
        try:
            profile = await self.resolve_profile(client)
            wanted = set(addresses)
            results: dict[str, float] = {}
            for block in profile.blocks:
                points = [(p, f"{block.function}:{block.start + p.offset}") for p in block.points]
                if not any(a in wanted for _, a in points):
                    continue
                regs = await self._read_block(client, block)
                for p, address in points:
                    if address in wanted:
                        n = register_count(p.data_type)
                        results[address] = float(decode(regs[p.offset:p.offset + n], p.data_type, block.word_order))
        finally:
            client.close()
        return [
            PointValue(address=a, ts=ts, value=results[a], quality=GOOD)
            if a in results
            else PointValue(address=a, ts=ts, value=None, quality=BAD)
            for a in addresses
        ]


def _text(value: bytes | list | None) -> str:
    """Device identification objects arrive as bytes (or a list of bytes when an object repeats)."""
    if isinstance(value, list):
        value = value[0] if value else b""
    return (value or b"").decode(errors="replace")
