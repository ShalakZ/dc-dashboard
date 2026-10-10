"""Is the DCDASH_SECRET_KEY in .env the key this database's stored secrets were encrypted with?

.env is the one thing a backup does not contain. A wrong or new key breaks nothing at start: sources without a secret keep
working, and every source with a secret goes offline with "stored secret cannot be decrypted" (the collector says so per
source). This module makes the cause visible at the API start and on the Sources page. The warning condition is the
decryption itself; the fingerprint stored in `settings` only decides the wording ("a different key from the one the database
was set up with") and travels inside dumps.
"""
import hashlib
import hmac
import logging

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcdash.core.config import get_settings
from dcdash.core.crypto import decrypt
from dcdash.core.models import Source
from dcdash.core.settings_store import get_setting, set_setting

log = logging.getLogger(__name__)

KEY_CHECK_KEY = "secret_key_check"


def key_fingerprint() -> str:
    """A short value that identifies the key without revealing it: an HMAC of a fixed label, keyed with the key itself."""
    return hmac.new(get_settings().secret_key.encode(), b"dcdash secret key check v1", hashlib.sha256).hexdigest()[:16]


class UnreadableSource(BaseModel):
    id: int
    name: str


class SecretKeyStatus(BaseModel):
    ok: bool  # every stored source secret decrypts with the key in .env
    key_changed: bool  # the stored fingerprint is not this key's
    unreadable: list[UnreadableSource]


async def _stored_fingerprint(db: AsyncSession) -> str | None:
    return (await get_setting(db, KEY_CHECK_KEY, {})).get("fingerprint")


async def secret_key_status(db: AsyncSession) -> SecretKeyStatus:
    """Test-decrypt every stored source secret. Read-only."""
    unreadable = []
    rows = await db.execute(select(Source.id, Source.name, Source.secret).where(Source.secret.is_not(None)).order_by(Source.id))
    for source_id, name, secret in rows:
        try:
            decrypt(secret)
        except Exception:  # a wrong key, a malformed key and a damaged token all mean the same: the secret cannot be read
            unreadable.append(UnreadableSource(id=source_id, name=name))
    stored = await _stored_fingerprint(db)
    return SecretKeyStatus(ok=not unreadable, key_changed=stored is not None and stored != key_fingerprint(), unreadable=unreadable)


async def check_secret_key_at_start(db: AsyncSession) -> SecretKeyStatus:
    """Run once when the API starts. Stores the fingerprint the first time, refreshes it when a different key is safe (no stored
    secret depends on the old one), and logs a warning when stored secrets cannot be read. Commits."""
    status = await secret_key_status(db)
    stored, mine = await _stored_fingerprint(db), key_fingerprint()
    if stored != mine and status.ok:
        if stored is not None:
            log.info("DCDASH_SECRET_KEY differs from the one this database was set up with, and no stored secret needs the old one: fingerprint updated")
        await set_setting(db, KEY_CHECK_KEY, {"fingerprint": mine})
        await db.commit()
    if not status.ok:
        names = ", ".join(source.name for source in status.unreadable)
        why = "is a different key from the one this database was set up with" if status.key_changed else "does not open them"
        log.warning(
            "DCDASH_SECRET_KEY %s: the stored secrets of %d source(s) cannot be decrypted (%s). Those sources stay offline. "
            "Put the original .env back, or type each source's secret in again.",
            why, len(status.unreadable), names,
        )
    return status
