import logging

import pytest

from dcdash.collector.logs import QUIET_LOGGERS, configure_logging
from dcdash.collector.scan import _quiet_protocol_loggers

# Loggers that wrote the chatter in the dev collector's log (one set of lines per OPC UA read / HTTP read).
NOISY = (
    "asyncua.client.client", "asyncua.client.ua_client.UaClient", "asyncua.client.ua_client.UASocketProtocol",
    "asyncua.uaprotocol", "httpx",
)


@pytest.fixture(autouse=True)
def restore_logger_levels():
    saved = {name: logging.getLogger(name).level for name in QUIET_LOGGERS}
    yield
    for name, level in saved.items():
        logging.getLogger(name).setLevel(level)


def test_info_lines_of_the_noisy_libraries_are_dropped_but_warnings_stay(caplog):
    caplog.set_level(logging.INFO)  # the root level the collector runs at; under pytest it would otherwise be WARNING
    configure_logging()
    for name in NOISY:
        assert not logging.getLogger(name).isEnabledFor(logging.INFO), name
        assert logging.getLogger(name).isEnabledFor(logging.WARNING), name


def test_the_collectors_own_loggers_are_not_silenced(caplog):
    caplog.set_level(logging.INFO)
    configure_logging()
    assert logging.getLogger("dcdash.collector.scheduler").isEnabledFor(logging.INFO)


def test_a_scan_puts_the_levels_back_to_warning_not_notset(caplog):
    caplog.set_level(logging.INFO)
    configure_logging()
    with _quiet_protocol_loggers():
        assert logging.getLogger("asyncua").level == logging.ERROR
    for name in ("asyncua", "pymodbus"):
        assert logging.getLogger(name).level == logging.WARNING, name
    assert not logging.getLogger("asyncua.client.ua_client.UaClient").isEnabledFor(logging.INFO)


async def test_a_real_opcua_read_logs_nothing_from_asyncua_at_info(caplog):
    from dcdash.connectors.base import GOOD, create_connector
    from tests.helpers import opcua_server

    caplog.set_level(logging.INFO)
    configure_logging()
    async with opcua_server() as srv:
        connector = create_connector(
            "opcua", {"endpoint": srv.endpoint.replace("0.0.0.0", "127.0.0.1"), "timeout_seconds": 2}
        )
        points = {p.name: p.address for p in await connector.browse()}
        values = await connector.read([points["LVP01 V"]])
    assert values[0].quality == GOOD
    # WARNING records stay by design (the in-process test server itself logs two at start); only the INFO chatter must go.
    assert [r.name for r in caplog.records if r.name.startswith("asyncua") and r.levelno < logging.WARNING] == []
