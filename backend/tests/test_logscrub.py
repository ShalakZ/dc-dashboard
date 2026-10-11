import asyncio
import io
import logging
import sys
import time

import pytest
from uvicorn.logging import AccessFormatter, ColourizedFormatter

import dcdash.api.main as api_main
from dcdash.collector.logs import configure_logging
from dcdash.core.logscrub import CredentialScrubFilter, install_log_scrub

URL = "http://svc:Zq9-pw@host:9000/x"
HIDDEN = "http://[hidden]@host:9000/x"
SCRUBBED_LOGGERS = ("", "uvicorn", "uvicorn.error", "uvicorn.access")


def make_record(msg, args=(), exc_info=None, name="dcdash.test"):
    return logging.LogRecord(name, logging.WARNING, __file__, 1, msg, args, exc_info)


def scrub(record):
    assert CredentialScrubFilter().filter(record) is True  # a record is never dropped
    return record


# --- the filter on one record -------------------------------------------------------------------------------------------


def test_a_message_without_args_loses_the_credentials():
    record = scrub(make_record(f"job 3 (test) failed: {URL}"))
    assert record.getMessage() == f"job 3 (test) failed: {HIDDEN}"


def test_a_percent_s_argument_is_scrubbed_after_formatting():
    exc = ConnectionError(f"cannot reach {URL}")
    record = scrub(make_record("source %s went offline: %s", (1, exc)))
    assert record.getMessage() == f"source 1 went offline: cannot reach {HIDDEN}"
    assert record.args == ()


def test_a_url_split_over_two_arguments_is_still_found():
    record = scrub(make_record("failed: http://%s:%s@host/x", ("svc", "Zq9-pw")))
    assert "Zq9" not in record.getMessage()


def test_a_message_that_is_an_exception_object_is_scrubbed():
    record = scrub(make_record(ValueError(f"bad {URL}")))
    assert record.getMessage() == f"bad {HIDDEN}"


def test_dict_args_are_scrubbed():
    record = scrub(make_record("failed %(url)s", ({"url": URL},)))
    assert record.getMessage() == f"failed {HIDDEN}"


def test_a_traceback_that_quotes_the_url_is_scrubbed():
    try:
        raise RuntimeError(f"connect to {URL} failed")
    except RuntimeError:
        record = scrub(make_record("boom", exc_info=sys.exc_info()))
    assert "Zq9" not in record.exc_text and "[hidden]" in record.exc_text
    assert "Zq9" not in logging.Formatter().format(record)


def test_a_cached_exc_text_is_scrubbed_too():
    record = make_record("boom")
    record.exc_text = f"Traceback (most recent call last):\nRuntimeError: {URL}"
    record = scrub(record)
    assert "Zq9" not in record.exc_text and "[hidden]" in record.exc_text


def test_150_kb_of_scheme_separators_finish_quickly():
    hostile = "://" * 50_000 + "@x"
    started = time.monotonic()
    record = scrub(make_record(hostile))
    assert time.monotonic() - started < 0.5
    assert record.getMessage().endswith("://[hidden]@x")


def test_a_record_that_cannot_be_formatted_passes_through_without_its_arguments():
    record = scrub(make_record("bad %d", (URL,)))  # %d with a str raises in getMessage
    assert record.args == ()
    assert "Zq9" not in str(record.msg)


def test_an_exc_info_that_cannot_be_formatted_passes_through_without_a_traceback():
    record = scrub(make_record(f"failed: {URL}", exc_info=("x", "y", "z")))
    assert record.getMessage() == f"failed: {HIDDEN}"
    assert record.exc_info is None and "Zq9" not in (record.exc_text or "")


# --- install_log_scrub ---------------------------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def restore_logging_state():
    """Put back the handlers, filters, levels and propagation that `install_log_scrub` and these tests touch."""
    loggers = {name: logging.getLogger(name) for name in SCRUBBED_LOGGERS}
    saved = {
        name: (list(lg.handlers), lg.propagate, lg.level, [(h, list(h.filters)) for h in lg.handlers])
        for name, lg in loggers.items()
    }
    last_resort = (logging.lastResort, list(logging.lastResort.filters))
    yield
    for name, (handlers, propagate, level, filters) in saved.items():
        lg = loggers[name]
        lg.handlers[:] = handlers
        lg.propagate, lg.level = propagate, level
        for handler, handler_filters in filters:
            handler.filters[:] = handler_filters
    last_resort[0].filters[:] = last_resort[1]


def stream_handler(logger_name: str, formatter: logging.Formatter | None = None) -> tuple[logging.Handler, io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(formatter or logging.Formatter("%(levelname)s %(message)s"))
    logging.getLogger(logger_name).addHandler(handler)
    return handler, stream


def scrub_filters(handler: logging.Handler) -> list[logging.Filter]:
    return [f for f in handler.filters if isinstance(f, CredentialScrubFilter)]


def test_the_root_handler_writes_no_credentials_for_a_warning_or_an_exception():
    _, stream = stream_handler("")
    install_log_scrub()
    log = logging.getLogger("dcdash.test.integration")
    log.warning("source %s failed: %s", 7, ConnectionError(f"cannot reach {URL}"))
    try:
        raise RuntimeError(f"connect to {URL} failed")
    except RuntimeError:
        log.exception("could not read")
    out = stream.getvalue()
    assert "[hidden]" in out and "Zq9" not in out
    assert "could not read" in out and "RuntimeError" in out  # the traceback is still there


def test_installing_twice_adds_one_filter_per_handler():
    handler, _ = stream_handler("")
    install_log_scrub()
    install_log_scrub()
    assert len(scrub_filters(handler)) == 1


def test_every_uvicorn_handler_is_covered():
    handlers = {name: stream_handler(name) for name in SCRUBBED_LOGGERS[1:]}
    install_log_scrub()
    for name, (handler, _) in handlers.items():
        assert len(scrub_filters(handler)) == 1, name
    error_logger = logging.getLogger("uvicorn.error")
    error_logger.setLevel(logging.INFO)
    error_logger.warning("Exception in ASGI application: %s", ConnectionError(f"cannot reach {URL}"))
    _, error_out = handlers["uvicorn.error"]
    assert "[hidden]" in error_out.getvalue() and "Zq9" not in error_out.getvalue()


def test_the_uvicorn_access_line_is_scrubbed_and_still_formats():
    """uvicorn's AccessFormatter unpacks record.args into five values: emptying them would break every access line."""
    access = logging.getLogger("uvicorn.access")
    access.setLevel(logging.INFO)
    access.propagate = False
    fmt = '%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s'
    handler, stream = stream_handler("uvicorn.access", AccessFormatter(fmt=fmt, use_colors=False))
    install_log_scrub()
    access.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5", "GET", f"/x?u={URL}", "1.1", 200)
    out = stream.getvalue()
    assert out.strip(), "the access line was not written at all"
    assert 'GET /x?u=http://[hidden]@host:9000/x HTTP/1.1" 200 OK' in out and "Zq9" not in out
    assert len(scrub_filters(handler)) == 1


def test_a_coloured_uvicorn_startup_line_keeps_its_text():
    """With colours on, ColourizedFormatter prints record.color_message, a template that still holds %s/%d placeholders."""
    error_logger = logging.getLogger("uvicorn.error")
    error_logger.setLevel(logging.INFO)
    error_logger.propagate = False
    fmt = "%(levelprefix)s %(message)s"
    _, stream = stream_handler("uvicorn.error", ColourizedFormatter(fmt=fmt, use_colors=True))
    install_log_scrub()
    # The way uvicorn/server.py logs "Uvicorn running on ...".
    error_logger.info(
        "Uvicorn running on %s://%s:%d (Press CTRL+C to quit)",
        "http",
        "0.0.0.0",
        8000,
        extra={"color_message": "Uvicorn running on \x1b[1m%s://%s:%d\x1b[0m (Press CTRL+C to quit)"},
    )
    out = stream.getvalue()
    assert "\x1b[32mINFO" in out  # the colours are still on
    assert "http://0.0.0.0:8000" in out.replace("\x1b[1m", "").replace("\x1b[0m", "")
    assert "%s" not in out and "%d" not in out


def test_a_logger_with_no_handler_of_its_own_is_covered_by_the_last_resort_handler(capsys):
    """Under uvicorn the root logger has no handler, so dcdash.* records go to logging.lastResort (stderr)."""
    install_log_scrub()
    assert len(scrub_filters(logging.lastResort)) == 1
    orphan = logging.getLogger("dcdash.test.orphan")
    orphan.propagate = False
    orphan.handlers.clear()
    orphan.warning("could not write the row: %s", ConnectionError(f"cannot reach {URL}"))
    err = capsys.readouterr().err
    assert "[hidden]" in err and "Zq9" not in err


def test_a_handler_added_after_the_call_is_not_covered():
    install_log_scrub()
    late = logging.getLogger("dcdash.test.late")
    late.propagate = False
    handler = logging.StreamHandler(io.StringIO())
    late.addHandler(handler)
    assert scrub_filters(handler) == []


# --- who calls it --------------------------------------------------------------------------------------------------------


def test_the_collectors_configure_logging_scrubs_what_it_logs():
    _, stream = stream_handler("")
    configure_logging()
    logging.getLogger("dcdash.collector.scheduler").warning("source %s went offline: %s", 1, ConnectionError(f"cannot reach {URL}"))
    out = stream.getvalue()
    assert "[hidden]" in out and "Zq9" not in out


class _QuietPool:
    async def close(self):
        pass

    def terminate(self):
        pass


async def test_the_api_lifespan_installs_the_scrub_before_anything_else(monkeypatch):
    calls: list[str] = []

    async def fake_create_pool(*args, **kwargs):
        calls.append("pool")
        return _QuietPool()

    async def idle(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(api_main, "install_log_scrub", lambda: calls.append("scrub"))
    monkeypatch.setattr(api_main, "create_pool", fake_create_pool)
    monkeypatch.setattr(api_main, "listen_forever", idle)
    async with api_main.lifespan(api_main.create_app()):
        pass
    assert calls == ["scrub", "pool"]
