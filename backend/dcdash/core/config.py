from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DCDASH_")

    database_url: str = "postgresql://dcdash:dcdash@localhost:5432/dcdash"
    secret_key: str
    session_hours: int = 12
    timezone: str = "UTC"

    @property
    def sqlalchemy_url(self) -> str:
        return self.database_url.replace("postgresql://", "postgresql+asyncpg://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()
