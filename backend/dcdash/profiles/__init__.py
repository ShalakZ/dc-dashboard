"""YAML device profiles describing a Modbus device's register layout."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, model_validator

from dcdash.core.registers import DataType, WordOrder, register_count


class ProfilePoint(BaseModel):
    name: str
    offset: int = Field(ge=0)
    data_type: DataType = "uint16"
    scale: float = 1.0
    unit: str | None = None


class RegisterBlock(BaseModel):
    function: int = Field(ge=3, le=4)
    start: int = Field(ge=0, le=65535)
    count: int = Field(ge=1, le=125)
    word_order: WordOrder = "big"
    points: list[ProfilePoint]

    @model_validator(mode="after")
    def _points_fit(self) -> "RegisterBlock":
        for p in self.points:
            if p.offset + register_count(p.data_type) > self.count:
                raise ValueError(f"point {p.name!r} does not fit in block {self.function}:{self.start}+{self.count}")
        return self


class Profile(BaseModel):
    name: str
    vendor: str | None = None
    product_code: str | None = None
    blocks: list[RegisterBlock]

    @model_validator(mode="after")
    def _unique_addresses(self) -> "Profile":
        seen: set[str] = set()
        for b in self.blocks:
            for p in b.points:
                address = f"{b.function}:{b.start + p.offset}"
                if address in seen:
                    raise ValueError(f"duplicate address {address}")
                seen.add(address)
        return self


def profiles_dir() -> Path:
    return Path(__file__).resolve().parent


def list_profiles() -> list[str]:
    return sorted(p.stem for p in profiles_dir().glob("*.yaml"))


@lru_cache(maxsize=None)
def load_profile(name: str) -> Profile:
    path = profiles_dir() / f"{name}.yaml"
    if "/" in name or name.startswith(".") or not path.is_file():
        raise KeyError(name)
    with path.open("rb") as fh:
        return Profile.model_validate(yaml.safe_load(fh))


def match_profile(vendor: str | None, product_code: str | None) -> Profile | None:
    if not vendor or not product_code:
        return None
    for name in list_profiles():
        p = load_profile(name)
        if (p.vendor or "").lower() == vendor.lower() and (p.product_code or "").lower() == product_code.lower():
            return p
    return None
