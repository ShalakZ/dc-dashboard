import pytest

from dcdash.profiles import Profile, list_profiles, load_profile, match_profile


def test_lists_shipped_profiles():
    assert {"simulator", "generic_float32"} <= set(list_profiles())


def test_simulator_profile_covers_all_points():
    p = load_profile("simulator")
    addresses = [pt for b in p.blocks for pt in b.points]
    assert len(addresses) == 60
    kw = next(pt for b in p.blocks for pt in b.points if pt.name == "LVP01 kW")
    assert kw.data_type == "float32" and kw.unit == "kW"


def test_unknown_profile_raises():
    with pytest.raises(KeyError):
        load_profile("does_not_exist")


def test_offset_beyond_block_rejected():
    with pytest.raises(ValueError):
        Profile.model_validate({"name": "x", "blocks": [{"function": 3, "start": 0, "count": 2,
            "points": [{"name": "a", "offset": 1, "data_type": "float32"}]}]})


def test_match_profile_by_identification():
    assert match_profile("DCDash", "SIM-LV-10").name == "simulator"
    assert match_profile("dcdash", "sim-lv-10").name == "simulator"
    assert match_profile("Acme", "X1") is None
