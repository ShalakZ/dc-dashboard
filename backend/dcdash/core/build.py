"""Which build is running: the commit the image was built from and that commit's time.

The values arrive as the build arguments DCDASH_BUILD_ID and DCDASH_BUILD_TIME (compose.yaml, passed on by scripts/setup.sh,
setup.ps1 and e2e.sh) and are baked into the image as environment variables. Without them the build is "dev" / "unknown".
"""
import os
import time
from dataclasses import dataclass

STARTED_AT: float = time.monotonic()  # this process, on the monotonic clock: only differences mean anything


@dataclass(frozen=True)
class BuildInfo:
    build_id: str
    build_time: str


def build_info() -> BuildInfo:
    return BuildInfo(
        build_id=os.environ.get("DCDASH_BUILD_ID", "").strip() or "dev",
        build_time=os.environ.get("DCDASH_BUILD_TIME", "").strip() or "unknown",
    )


def uptime_seconds() -> float:
    return time.monotonic() - STARTED_AT
