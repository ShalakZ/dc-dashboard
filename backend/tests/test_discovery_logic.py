import pytest

from dcdash.core.discovery import (
    MAX_PORTS, PointInfo, TargetError, expand_targets, guess_mapping, networks_from_addresses, suggest_groups,
)
from dcdash.core.metrics import Metric


def hosts(targets, ports=(502,), cap=1024):
    return list(expand_targets(targets, list(ports), cap).hosts)


def test_cidr_expands_to_usable_hosts():
    assert hosts(["10.0.0.0/30"]) == ["10.0.0.1", "10.0.0.2"]


def test_single_address_name_and_duplicates():
    assert hosts(["10.0.0.5", "SCADA.example.com", "10.0.0.5"]) == ["10.0.0.5", "scada.example.com"]


def test_host_bits_in_a_cidr_are_tolerated():
    assert hosts(["10.0.0.5/30"]) == ["10.0.0.5", "10.0.0.6"]  # 10.0.0.5/30 is the network 10.0.0.4/30


def test_url_adds_its_host_and_its_own_port():
    exp = expand_targets(["http://plc.local:8080/x"], [502], 10)
    assert exp.hosts == ("plc.local",) and exp.pairs == [("plc.local", 502), ("plc.local", 8080)]


def test_url_default_ports_and_unlisted_scheme():
    assert expand_targets(["https://a.example"], [502], 10).pairs[-1] == ("a.example", 443)
    assert expand_targets(["opc.tcp://a.example"], [502], 10).pairs[-1] == ("a.example", 4840)
    with pytest.raises(TargetError):
        expand_targets(["ftp://a.example"], [502], 10)
    with pytest.raises(TargetError):
        expand_targets(["tcp://a.example"], [502], 10)  # tcp:// needs an explicit port


def test_pairs_are_hosts_times_ports_without_duplicates():
    exp = expand_targets(["10.0.0.0/30", "http://10.0.0.1:502"], [502, 4840], 10)
    assert exp.pairs == [("10.0.0.1", 502), ("10.0.0.1", 4840), ("10.0.0.2", 502), ("10.0.0.2", 4840)]


@pytest.mark.parametrize(
    "target",
    ["10.0.0.0/8", "0.0.0.0/0", "10.0.0.0/21", "::1", "fe80::/64", "999.1.1.1", "1.2.3", "not a host!",
     "", "   ", "0.0.0.0", "224.0.0.1", "-bad.example", "a" * 64 + ".example", "10.0.0.0/33"],
)
def test_bad_or_oversized_targets_are_rejected(target):
    with pytest.raises(TargetError):
        expand_targets([target], [502], 1024)


def test_cap_counts_hosts_across_all_targets():
    with pytest.raises(TargetError, match="limit"):
        expand_targets(["10.0.0.0/25", "10.1.0.0/25"], [502], 200)


def test_huge_network_is_rejected_without_being_enumerated():
    # Must return immediately; enumerating a /8 would take seconds and gigabytes.
    with pytest.raises(TargetError):
        expand_targets(["10.0.0.0/8"], [502], 1024)


def test_empty_target_list_and_bad_ports():
    for bad_ports in ([], [0], [65536], [-1], list(range(1, MAX_PORTS + 2))):
        with pytest.raises(TargetError):
            expand_targets(["10.0.0.1"], bad_ports, 10)
    with pytest.raises(TargetError):
        expand_targets([], [502], 10)


def p(i, name, unit=None):
    return PointInfo(i, f"addr{i}", name, unit)


def test_groups_by_all_tokens_but_the_last():
    points = [p(1, "LVP01 kW", "kW"), p(2, "LVP01 kWh", "kWh"), p(3, "LVP02 kW", "kW"), p(4, "LVP02 kWh", "kWh")]
    groups, ungrouped = suggest_groups(points)
    assert [(g.key, g.point_ids) for g in groups] == [("LVP01", (1, 2)), ("LVP02", (3, 4))]
    assert ungrouped == []


@pytest.mark.parametrize("name", ["LVP01_kW", "LVP01.kW", "LVP01/kW", "LVP01:kW", "LVP01-kW", "LVP01  kW"])
def test_all_separators_split_tokens(name):
    groups, _ = suggest_groups([p(1, name), p(2, name.replace("kW", "kWh"))])
    assert [g.key for g in groups] == ["LVP01"]


def test_single_point_groups_are_not_groups():
    groups, ungrouped = suggest_groups([p(1, "LVP01 kW"), p(2, "LVP02 kW")])
    assert groups == [] and ungrouped == [1, 2]


def test_names_without_separators_or_empty_are_ungrouped_and_never_crash():
    groups, ungrouped = suggest_groups([p(1, "Total"), p(2, ""), p(3, "  "), p(4, "___"), p(5, "Total")])
    assert groups == [] and ungrouped == [1, 2, 3, 4, 5]


def test_group_keys_are_case_insensitive_and_keep_first_spelling():
    groups, _ = suggest_groups([p(1, "lvp01 kW"), p(2, "LVP01 kWh")])
    assert [(g.key, g.point_ids) for g in groups] == [("lvp01", (1, 2))]


def test_groups_sort_naturally_and_duplicate_names_are_kept():
    names = ["LVP10 kW", "LVP10 V", "LVP2 kW", "LVP2 V", "LVP2 V"]
    groups, _ = suggest_groups([p(i, n) for i, n in enumerate(names, 1)])
    assert [g.key for g in groups] == ["LVP2", "LVP10"]
    assert groups[0].point_ids == (3, 4, 5)


def test_multi_token_keys():
    groups, _ = suggest_groups([p(1, "Hall A LVP01 kW"), p(2, "Hall A LVP01 V")])
    assert groups[0].key == "Hall A LVP01"


@pytest.mark.parametrize(
    "unit,name,metric,scale",
    [
        ("kW", "x", Metric.ACTIVE_POWER_KW, 1.0), ("W", "x", Metric.ACTIVE_POWER_KW, 0.001),
        ("kWh", "x", Metric.ENERGY_KWH, 1.0), ("Wh", "x", Metric.ENERGY_KWH, 0.001),
        ("V", "x", Metric.VOLTAGE_V, 1.0), ("A", "x", Metric.CURRENT_A, 1.0),
        ("Hz", "x", Metric.FREQUENCY_HZ, 1.0), ("kvar", "x", Metric.REACTIVE_POWER_KVAR, 1.0),
        ("kVA", "x", Metric.APPARENT_POWER_KVA, 1.0), ("KW", "x", Metric.ACTIVE_POWER_KW, 1.0),
        (None, "LVP01 PF", Metric.POWER_FACTOR, 1.0), (None, "LVP01_kWh", Metric.ENERGY_KWH, 1.0),
    ],
)
def test_metric_and_scale_come_from_the_unit_then_the_name_suffix(unit, name, metric, scale):
    guess = guess_mapping(p(1, name, unit))
    assert (guess.metric, guess.scale) == (metric, scale)


def test_unknown_units_become_custom_with_their_unit():
    guess = guess_mapping(p(1, "Room temp", "degC"))
    assert guess.metric is Metric.CUSTOM and guess.custom_unit == "degC" and guess.scale == 1.0


def test_name_suffix_is_only_used_without_a_hint():
    assert guess_mapping(p(1, "Zone A")).metric is Metric.CURRENT_A  # documented limitation: suffix "A"
    assert guess_mapping(p(1, "Zone A", "degC")).metric is Metric.CUSTOM
    assert guess_mapping(p(1, "Status")).custom_unit is None


def test_interval_is_the_metric_default():
    assert guess_mapping(p(1, "x", "kWh")).interval_seconds == 60
    assert guess_mapping(p(1, "x", "kW")).interval_seconds == 5


def test_networks_are_the_24_around_each_address():
    assert networks_from_addresses(["172.18.0.7", "172.18.0.9", "192.168.1.20"]) == ["172.18.0.0/24", "192.168.1.0/24"]
    assert networks_from_addresses(["127.0.0.1", "169.254.1.1", "::1", "garbage"]) == []
