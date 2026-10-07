"""Modbus register codec: 16-bit words <-> typed values.

Bytes inside a register are always big-endian (Modbus); `word_order` only
controls the order of the two 16-bit words inside a 32-bit value.
"""
from __future__ import annotations

import struct
from typing import Literal

DataType = Literal["int16", "uint16", "int32", "uint32", "float32"]
WordOrder = Literal["big", "little"]
_FORMATS: dict[str, str] = {"int16": ">h", "uint16": ">H", "int32": ">i", "uint32": ">I", "float32": ">f"}


def register_count(data_type: DataType) -> int:
    return struct.calcsize(_FORMATS[data_type]) // 2


def decode(regs: list[int], data_type: DataType, word_order: WordOrder) -> int | float:
    n = register_count(data_type)
    if len(regs) != n:
        raise ValueError(f"{data_type} needs {n} registers, got {len(regs)}")
    words = list(regs) if word_order == "big" else list(reversed(regs))
    raw = b"".join(struct.pack(">H", w & 0xFFFF) for w in words)
    return struct.unpack(_FORMATS[data_type], raw)[0]


def encode(value: int | float, data_type: DataType, word_order: WordOrder) -> list[int]:
    raw = struct.pack(_FORMATS[data_type], value)
    words = [struct.unpack(">H", raw[i:i + 2])[0] for i in range(0, len(raw), 2)]
    return words if word_order == "big" else list(reversed(words))
