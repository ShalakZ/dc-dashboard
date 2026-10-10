import logging

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
# Per-read chatter: asyncua logs a session open, activate, read and close (and a 1.4 kB endpoint line) at INFO for every
# OPC UA read, httpx one line per HTTP request. At WARNING the real problems stay and about 760 lines an hour per source go.
# The scan code (collector/scan.py) lowers asyncua and pymodbus to ERROR while a scan runs and puts back the level it found.
QUIET_LOGGERS = ("asyncua", "pymodbus", "httpx")


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
