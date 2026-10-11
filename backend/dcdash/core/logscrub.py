import logging

from dcdash.core.audit import scrub_url_credentials

# uvicorn's AccessFormatter unpacks record.args into five values itself, so that logger's args keep their shape.
ACCESS_LOGGER = "uvicorn.access"
LOGGERS_WITH_HANDLERS = ("", "uvicorn", "uvicorn.error", ACCESS_LOGGER)


def _scrub_message(record: logging.LogRecord) -> None:
    if record.name == ACCESS_LOGGER and isinstance(record.args, tuple):
        record.args = tuple(scrub_url_credentials(a) if isinstance(a, str) else a for a in record.args)
        return
    # Scrub the formatted text, not the parts: a URL can be split over several %s arguments.
    record.msg = scrub_url_credentials(record.getMessage())
    record.args = ()
    # uvicorn's ColourizedFormatter prints this %-template instead of msg; with the args emptied it would show raw %s/%d.
    record.__dict__.pop("color_message", None)


def _drop_arguments(record: logging.LogRecord) -> None:
    """The message could not be formatted (a broken log call): keep what can be scrubbed, never the arguments."""
    try:
        record.msg = scrub_url_credentials(str(record.msg))
    except Exception:
        record.msg = "[log message could not be scrubbed]"
    record.args = ()


def _scrub_traceback(record: logging.LogRecord) -> None:
    # The standard Formatter reuses a cached exc_text, so it is set (scrubbed) here and the traceback is not formatted again.
    if record.exc_info and not record.exc_text:
        record.exc_text = scrub_url_credentials(logging.Formatter().formatException(record.exc_info))
    elif record.exc_text:
        record.exc_text = scrub_url_credentials(record.exc_text)


class CredentialScrubFilter(logging.Filter):
    """Hides "user:password@" in every URL a record's message or traceback quotes. Never drops a record, never raises."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            _scrub_message(record)
        except Exception:
            _drop_arguments(record)
        try:
            _scrub_traceback(record)
        except Exception:
            record.exc_info = None
            record.exc_text = "[traceback not shown: it could not be scrubbed]"
        return True


def install_log_scrub() -> None:
    """Scrub every record the root and uvicorn handlers emit (handlers added later are not covered).

    A filter on a logger does not see the records of its child loggers, so the filter goes on the handlers. Under uvicorn
    the root logger has no handler and the dcdash.* loggers end at logging.lastResort (stderr), so that is covered too.
    """
    handlers = [h for name in LOGGERS_WITH_HANDLERS for h in logging.getLogger(name).handlers]
    if logging.lastResort is not None:
        handlers.append(logging.lastResort)
    for handler in handlers:
        if not any(isinstance(f, CredentialScrubFilter) for f in handler.filters):
            handler.addFilter(CredentialScrubFilter())
