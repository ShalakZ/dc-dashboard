import time
from datetime import datetime
from typing import Any

import httpx
from pydantic import AnyHttpUrl, BaseModel

from dcdash.connectors.base import (
    BAD, GOOD, ConnectionCheck, Connector, ConnectorError, PointDescriptor, PointValue, register,
)


class SimulatorConfig(BaseModel):
    url: AnyHttpUrl = AnyHttpUrl("http://simulator:9000")
    timeout_seconds: float = 5.0


@register
class SimulatorConnector(Connector):
    type = "simulator"
    config_schema = SimulatorConfig

    def __init__(
        self,
        config: SimulatorConfig,
        secret: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(config, secret)
        self._client = httpx.AsyncClient(
            base_url=str(config.url),
            timeout=config.timeout_seconds,
            headers={"X-API-Key": secret or ""},
            transport=transport,
        )

    async def _get(self, path: str, **params: str) -> dict[str, Any]:
        try:
            response = await self._client.get(path, params=params)
        except httpx.TimeoutException as exc:
            raise ConnectorError("timeout", str(exc) or "request timed out") from exc
        except httpx.HTTPError as exc:
            raise ConnectorError("unreachable", str(exc) or type(exc).__name__) from exc
        if response.status_code in (401, 403):
            raise ConnectorError("auth_failed", "credentials rejected")
        if response.status_code != 200:
            raise ConnectorError("protocol_error", f"HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise ConnectorError("protocol_error", "response is not JSON") from exc

    async def test(self) -> ConnectionCheck:
        started = time.perf_counter()
        try:
            await self._get("/points")
        except ConnectorError as exc:
            return ConnectionCheck(False, exc.status, None, exc.message)
        return ConnectionCheck(True, "ok", round((time.perf_counter() - started) * 1000, 1))

    async def browse(self) -> list[PointDescriptor]:
        data = await self._get("/points")
        return [
            PointDescriptor(p["address"], p["name"], "float", p.get("unit") or None)
            for p in data["points"]
        ]

    async def read(self, addresses: list[str]) -> list[PointValue]:
        data = await self._get("/read", addresses=",".join(addresses))
        values = []
        for item in data["values"]:
            raw = item["value"]
            good = isinstance(raw, (int, float)) and not isinstance(raw, bool)
            values.append(
                PointValue(
                    item["address"],
                    datetime.fromisoformat(item["ts"]),
                    float(raw) if good else None,
                    GOOD if good else BAD,
                )
            )
        return values

    async def close(self) -> None:
        await self._client.aclose()
