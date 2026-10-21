from pydantic import BaseModel, ConfigDict

from dcdash.connectors.base import (
    ConnectionCheck, Connector, ConnectorError, PointDescriptor, PointValue, register,
)


class FileConfig(BaseModel):
    """A file source has nothing to connect to, so nothing to configure: the readings come from files a person imports."""

    model_config = ConfigDict(extra="forbid")


@register
class FileConnector(Connector):
    """A source that is filled by importing CSV exports (w31). The points come from a tag list, the readings from an import.

    It never reaches anything: the collector does not poll it (`polls = False`) and keeps no history for it, so every method that
    would talk to a device answers without doing so.
    """

    type = "file"
    config_schema = FileConfig
    supports_history = False
    polls = False
    description = "Filled by importing CSV files. Nothing is connected: add its points with a tag list and load readings from an export."

    async def test(self) -> ConnectionCheck:
        return ConnectionCheck(True, "ok", None, "this source is filled by importing files")

    async def browse(self) -> list[PointDescriptor]:
        return []  # a browse only upserts the descriptors it gets, so this removes nothing

    async def read(self, addresses: list[str]) -> list[PointValue]:
        raise ConnectorError("not_supported", "this source is filled by importing files and is never read")
