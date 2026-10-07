from dcdash.core.config import Settings


def test_sqlalchemy_url_uses_asyncpg_driver():
    settings = Settings(database_url="postgresql://u:p@h:5432/d", secret_key="k")
    assert settings.sqlalchemy_url == "postgresql+asyncpg://u:p@h:5432/d"


def test_settings_read_from_environment(monkeypatch):
    monkeypatch.setenv("DCDASH_SECRET_KEY", "abc")
    monkeypatch.setenv("DCDASH_TIMEZONE", "Asia/Qatar")
    settings = Settings()
    assert settings.secret_key == "abc"
    assert settings.timezone == "Asia/Qatar"
    assert settings.session_hours == 12
