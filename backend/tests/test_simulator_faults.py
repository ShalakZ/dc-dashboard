"""The SIM_FAULT_* switches of the OPC UA simulator: what from_env accepts, what it refuses (loudly), what describe() says."""
import dataclasses

import pytest

from dcdash.simulator.faults import KNOWN, FaultConfigError, Faults


def parse(**env: str) -> Faults:
    return Faults.from_env({f"SIM_FAULT_{name}": value for name, value in env.items()})


def test_no_variables_or_empty_ones_mean_no_faults():
    off = Faults()
    assert Faults.from_env({}) == off
    assert Faults.from_env({name: "" for name in KNOWN}) == off  # what compose passes when nothing is set
    assert Faults.from_env({name: "  " for name in KNOWN}) == off
    assert off.describe() == [] and off.offered_policies == ("none",) and not off.needs_server_certificate
    assert Faults.from_env({"PATH": "/bin", "SIM_OPCUA_PASSWORD": "x", "SIM_API_KEY": "k"}) == off  # other SIM_ names are not ours


def test_faults_are_a_frozen_value():
    with pytest.raises(dataclasses.FrozenInstanceError):
        Faults().slow_seconds = 1.0  # type: ignore[misc]


@pytest.mark.parametrize("text, expected", [
    ("none", ("none",)),
    ("basic256sha256", ("basic256sha256",)),
    ("none,basic256sha256", ("none", "basic256sha256")),
    (" Basic256Sha256 , NONE ", ("none", "basic256sha256")),  # case, spaces and order do not matter
    ("basic256sha256,basic256sha256", ("basic256sha256",)),
])
def test_policies(text, expected):
    assert parse(POLICIES=text).policies == expected


@pytest.mark.parametrize("text", ["basic128", "none,aes128", ",", "none,,basic256sha256"])
def test_unknown_policies_are_refused(text):
    with pytest.raises(FaultConfigError, match="SIM_FAULT_POLICIES"):
        parse(POLICIES=text)


def test_untrusted_cert_modes_and_the_policy_they_force():
    channel, session = parse(UNTRUSTED_CERT="1"), parse(UNTRUSTED_CERT="session")
    assert channel.untrusted_cert and channel.untrusted_cert_at == "channel"
    assert session.untrusted_cert and session.untrusted_cert_at == "session"
    assert channel.offered_policies == ("basic256sha256",) and channel.needs_server_certificate  # whatever policies says
    assert not parse(UNTRUSTED_CERT="0").untrusted_cert
    assert parse(UNTRUSTED_CERT="1", POLICIES="basic256sha256").untrusted_cert  # explicit and consistent
    for bad in ("yes", "true", "2", "Session"):
        with pytest.raises(FaultConfigError, match="SIM_FAULT_UNTRUSTED_CERT"):
            parse(UNTRUSTED_CERT=bad)


@pytest.mark.parametrize("policies", ["none", "none,basic256sha256"])
def test_untrusted_cert_conflicts_with_an_explicit_none_policy(policies):
    with pytest.raises(FaultConfigError, match="must not contain none"):
        parse(UNTRUSTED_CERT="1", POLICIES=policies)


def test_auth():
    assert parse(AUTH="required").auth_required and not parse(AUTH="").auth_required
    with pytest.raises(FaultConfigError, match="SIM_FAULT_AUTH"):
        parse(AUTH="1")  # the missing SIM_OPCUA_PASSWORD is OpcUaSim's and main's to report, not from_env's
    assert parse(AUTH="required").describe() == ["SIM_FAULT_AUTH=required: user name and password only, no anonymous login"]


@pytest.mark.parametrize("text, expected", [("0.3", 0.3), ("1.5", 1.5), ("4", 4.0), ("60", 60.0), ("0.001", 0.001)])
def test_slow_accepts_up_to_a_minute(text, expected):
    assert parse(SLOW=text).slow_seconds == expected


@pytest.mark.parametrize("text", ["0", "-1", "60.5", "abc", "nan", "inf", "1,5"])
def test_slow_refuses_the_rest(text):
    with pytest.raises(FaultConfigError, match="SIM_FAULT_SLOW"):
        parse(SLOW=text)


@pytest.mark.parametrize("text, expected", [("0.2", 0.2), ("0.5", 0.5), ("2", 2.0), ("3600", 3600.0)])
def test_drop_is_seconds_after_accept_and_at_least_a_fifth(text, expected):
    assert parse(DROP=text).drop_seconds == expected


@pytest.mark.parametrize("text", ["0.1", "0", "-2", "3601", "x", "inf"])
def test_drop_refuses_the_rest(text):
    with pytest.raises(FaultConfigError, match="SIM_FAULT_DROP"):
        parse(DROP=text)


@pytest.mark.parametrize("text, expected", [("900", 900), ("-900", -900), ("+120", 120), ("86400", 86400), ("-86400", -86400)])
def test_skew_is_a_signed_whole_number_of_seconds(text, expected):
    assert parse(SKEW=text).skew_seconds == expected


@pytest.mark.parametrize("text", ["86401", "-86401", "1.5", "ten", "1e3"])
def test_skew_refuses_the_rest(text):
    with pytest.raises(FaultConfigError, match="SIM_FAULT_SKEW"):
        parse(SKEW=text)


def test_bad_nodes():
    assert parse(BAD="LVP01_kW:BadSensorFailure").bad_nodes == (("LVP01_kW", "BadSensorFailure"),)
    two = parse(BAD=" LVP01_kW:BadSensorFailure , LVP02_V:BadNodeIdUnknown ")
    assert two.bad_nodes == (("LVP01_kW", "BadSensorFailure"), ("LVP02_V", "BadNodeIdUnknown"))
    assert two.describe() == ["SIM_FAULT_BAD=LVP01_kW:BadSensorFailure,LVP02_V:BadNodeIdUnknown: these variables answer with a Bad status"]


@pytest.mark.parametrize("text, why", [
    ("LVP01_kW", "ADDRESS:Status"),
    ("LVP01_kW:", "ADDRESS:Status"),
    (":BadSensorFailure", "ADDRESS:Status"),
    ("LVP01_kW:BadSensorFailure,", "ADDRESS:Status"),
    ("LVP99_kW:BadSensorFailure", "not a simulator point"),
    ("LVP01_kWh2:BadSensorFailure", "not a simulator point"),
    ("lvp01_kw:BadSensorFailure", "not a simulator point"),
    ("LVP01_kW:Good", "not an OPC UA Bad status"),
    ("LVP01_kW:BadNoSuchThing", "not an OPC UA Bad status"),
    ("LVP01_kW:badsensorfailure", "not an OPC UA Bad status"),
    ("LVP01_kW:BadSensorFailure,LVP01_kW:BadDeviceFailure", "listed twice"),
])
def test_bad_refuses_what_it_cannot_honour(text, why):
    with pytest.raises(FaultConfigError, match=why):
        parse(BAD=text)


def test_cert_hosts():
    assert parse(CERT_HOSTS="scada-gw.plant.local, other_host ,scada-gw.plant.local").cert_hosts == ("scada-gw.plant.local", "other_host")
    assert parse(CERT_HOSTS="").cert_hosts == ()
    for bad in ("host name", "host/x", "https://x"):
        with pytest.raises(FaultConfigError, match="SIM_FAULT_CERT_HOSTS"):
            parse(CERT_HOSTS=bad)
    assert parse(CERT_HOSTS="a.b").describe() == []  # a certificate option, not a fault


def test_an_unknown_fault_name_is_refused_and_the_message_lists_the_real_ones():
    with pytest.raises(FaultConfigError) as caught:
        Faults.from_env({"SIM_FAULT_SLOWW": "1", "SIM_FAULT_DROP": "2"})
    text = str(caught.value)
    assert "SIM_FAULT_SLOWW" in text and "typo" in text
    assert all(name in text for name in KNOWN)
    with pytest.raises(FaultConfigError, match="SIM_FAULT_UNTRUST"):
        Faults.from_env({"SIM_FAULT_UNTRUST": "1"})


def test_fault_config_error_is_a_value_error():
    assert issubclass(FaultConfigError, ValueError)


def test_describe_has_one_line_per_active_fault_starting_with_the_variable():
    everything = parse(POLICIES="none,basic256sha256", AUTH="required", SLOW="1.5", DROP="0.5", BAD="LVP01_kW:BadSensorFailure", SKEW="-900")
    lines = everything.describe()
    assert [line.split("=")[0] for line in lines] == [
        "SIM_FAULT_POLICIES", "SIM_FAULT_AUTH", "SIM_FAULT_SLOW", "SIM_FAULT_DROP", "SIM_FAULT_BAD", "SIM_FAULT_SKEW",
    ]
    assert "SIM_FAULT_SLOW=1.5:" in lines[2] and "SIM_FAULT_SKEW=-900:" in lines[5]
    assert [line.split(":")[0] for line in parse(UNTRUSTED_CERT="1").describe()] == ["SIM_FAULT_UNTRUSTED_CERT=1"]
    assert [line.split(":")[0] for line in parse(UNTRUSTED_CERT="session").describe()] == ["SIM_FAULT_UNTRUSTED_CERT=session"]
    assert parse(POLICIES="none").describe() == []  # the default is not a fault
