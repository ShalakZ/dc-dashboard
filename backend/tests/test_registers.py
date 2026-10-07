import pytest

from dcdash.core.registers import decode, encode, register_count


def test_register_count():
    assert register_count("uint16") == 1 and register_count("float32") == 2


def test_int16_sign():
    assert decode([0xFFFE], "int16", "big") == -2
    assert decode([0xFFFE], "uint16", "big") == 65534
    assert encode(-2, "int16", "big") == [0xFFFE]


def test_int32_big_word_order_matches_reference_bytes():
    # 0x12345678 as two big-endian words, high word first
    assert decode([0x1234, 0x5678], "int32", "big") == 0x12345678
    assert decode([0x5678, 0x1234], "int32", "little") == 0x12345678
    assert encode(0x12345678, "uint32", "little") == [0x5678, 0x1234]


def test_float32_little_word_order_roundtrip():
    for order in ("big", "little"):
        for value in (0.0, 1.5, -273.15, 123456.75):
            assert decode(encode(value, "float32", order), "float32", order) == pytest.approx(value, rel=1e-6)
    # IEEE 754 for 1.0 is 0x3F800000: big => [0x3F80, 0x0000], little => [0x0000, 0x3F80]
    assert encode(1.0, "float32", "big") == [0x3F80, 0x0000]
    assert encode(1.0, "float32", "little") == [0x0000, 0x3F80]
    assert decode([0x0000, 0x3F80], "float32", "big") != pytest.approx(1.0)  # wrong order is garbage, not 1.0


def test_wrong_register_count_rejected():
    with pytest.raises(ValueError):
        decode([1], "float32", "big")
