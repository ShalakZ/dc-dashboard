import pytest
from cryptography.fernet import Fernet, InvalidToken

from dcdash.core.config import get_settings
from dcdash.core.crypto import decrypt, encrypt


def test_round_trip():
    token = encrypt("s3cret")
    assert token != "s3cret"
    assert decrypt(token) == "s3cret"


def test_decrypt_with_a_different_key_fails(monkeypatch):
    token = encrypt("s3cret")
    monkeypatch.setenv("DCDASH_SECRET_KEY", Fernet.generate_key().decode())
    get_settings.cache_clear()
    try:
        with pytest.raises(InvalidToken):
            decrypt(token)
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
