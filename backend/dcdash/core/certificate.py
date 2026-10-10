"""The HTTPS certificate's expiry: the collector reads the file and writes it to `settings`, the API reads it from there."""
from datetime import datetime, timedelta
from pathlib import Path

from cryptography import x509

TLS_KEY = "tls_certificate"
WARN_DAYS = 30


class CertificateError(Exception):
    """The certificate file is missing, unreadable or not a PEM certificate; the message says which."""


def read_leaf(path: str) -> dict:
    """Expiry (ISO-8601 UTC), subject and serial (hex) of the first certificate in the file; a fullchain has the leaf first."""
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        raise CertificateError(f"cannot read {path}: {exc.strerror or type(exc).__name__}") from exc
    try:
        leaf = x509.load_pem_x509_certificates(data)[0]
    except (ValueError, IndexError) as exc:
        raise CertificateError(f"{path} holds no readable PEM certificate") from exc
    return {
        "not_after": leaf.not_valid_after_utc.isoformat(),
        "subject": leaf.subject.rfc4514_string(),
        "serial": format(leaf.serial_number, "x"),
    }


def state_for(not_after: datetime, now: datetime) -> str:
    """`expired` from the moment of expiry, `expiring` with less than WARN_DAYS days left, else `ok`. Both times are aware."""
    if not_after <= now:
        return "expired"
    if not_after - now < timedelta(days=WARN_DAYS):
        return "expiring"
    return "ok"
