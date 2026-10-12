"""The connection-check framework: a list of steps run in order, each timed, each turned into OK / FAIL / skipped.

A connector's `check(points, publish)` builds a `Checker`, runs its steps and returns `checker.finish()`. After every step the
checker calls `publish(result)` so that the collector can store the partial result and the screen shows the steps live; the call
is best effort (3 s limit, errors swallowed and logged once), a check never fails because the progress could not be stored.

This module does not import `dcdash.connectors` (the default `Connector.check` imports it lazily), so it can be used from either.
The JSON shape of `CheckResult.to_json()` is what `diagnostics/report.py` (`parse_check`) and the Diagnostics page read.
"""
import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from dcdash.core.audit import clip_error, plain, scrub_strings, scrub_url_credentials
from dcdash.diagnostics.hints import hint_for

log = logging.getLogger(__name__)

PUBLISH_TIMEOUT_SECONDS = 3.0
MAX_MESSAGE_CHARS = 500
MAX_NAMES = 50
MAX_CAUSE_DEPTH = 6


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(moment: datetime) -> datetime:
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


@dataclass
class StepOutcome:
    """What a step function returns for a step that worked: a one-line summary and optional facts for the full report."""

    summary: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    hint: str | None = None


class StepFailed(Exception):
    """Raised by a step function for a failure that is not an exception of a library (a clock that is off, a configured
    policy the server does not offer).

    `message` becomes `error.message`. `status_name` / `status_hex` fill the error when the failure has an OPC UA status;
    `hint_key` is the key looked up in the hints table when it is not that status name (for example `hints.CLOCK_SKEW`); an
    explicit `hint` wins over the table. `summary` and `detail` stay on the failed step.
    """

    def __init__(
        self,
        message: str,
        *,
        summary: str = "",
        status_name: str | None = None,
        status_hex: str | None = None,
        hint_key: str | None = None,
        hint: str | None = None,
        detail: dict[str, Any] | None = None,
        error_class: str = "CheckFailed",
    ) -> None:
        super().__init__(message)
        self.summary = summary
        self.status_name = status_name
        self.status_hex = status_hex
        self.hint_key = hint_key
        self.hint = hint
        self.detail = detail or {}
        self.error_class = error_class


StepFunction = Callable[[], Awaitable["str | StepOutcome | None"]]


@dataclass
class Step:
    id: str
    name: str
    ok: bool | None = None  # None: skipped
    ms: float | None = None
    summary: str = ""
    error: dict[str, Any] | None = None
    hint: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "ok": self.ok, "ms": self.ms, "summary": self.summary,
            "error": self.error, "hint": self.hint, "detail": self.detail,
        }


@dataclass
class CheckResult:
    connector_type: str
    source_id: int | None = None  # set by whoever stores the result: the connector does not know it
    started_at: str = field(default_factory=lambda: _now().isoformat())
    finished: bool = False
    ok: bool | None = None  # None until finished
    first_failed: str | None = None
    steps: list[Step] = field(default_factory=list)
    server_time: str | None = None
    local_time: str = field(default_factory=lambda: _now().isoformat())
    skew_seconds: float | None = None  # server time minus local time: positive when the server's clock is ahead
    hosts: list[str] = field(default_factory=list)
    uris: list[str] = field(default_factory=list)

    def step(self, step_id: str) -> Step | None:
        return next((step for step in self.steps if step.id == step_id), None)

    def to_json(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "connector_type": self.connector_type,
            "started_at": self.started_at,
            "finished": self.finished,
            "ok": self.ok,
            "first_failed": self.first_failed,
            "steps": [step.to_json() for step in self.steps],
            "clock": {"server_time": self.server_time, "local_time": self.local_time, "skew_seconds": self.skew_seconds},
            "names": {"hosts": list(self.hosts), "uris": list(self.uris)},
        }


Publish = Callable[[CheckResult], Awaitable[None]]


def _jsonable(value: Any) -> Any:
    """`value` as plain JSON data (an unknown object becomes its text); {} for nothing, or for NaN and the like."""
    try:
        return json.loads(json.dumps(plain(value), default=str, allow_nan=False)) if value else {}
    except (ValueError, TypeError):
        return {}


def _status_of(exc: BaseException) -> tuple[str | None, str | None]:
    """(status name, hex) of an OPC UA status error, or (None, None). asyncua is imported only when there is an error to look at."""
    code = getattr(exc, "code", None)
    if not isinstance(code, int) or isinstance(code, bool):
        return None, None
    try:
        from asyncua import ua
    except ImportError:
        return None, None
    if not isinstance(exc, ua.UaStatusCodeError):
        return None, None
    try:
        name = ua.StatusCode(code).name
    except Exception:  # noqa: BLE001 - a code this asyncua cannot name still has its hex
        name = None
    return name, f"0x{code:08X}"


def _inner(exc: BaseException) -> Exception | None:
    """What `exc` was raised from (`from x`), or what it was raised while handling unless that is suppressed (`from None`).
    Only an `Exception`: `asyncio.timeout` raises its TimeoutError from the CancelledError it used to interrupt, which is no cause."""
    inner = exc.__cause__ if exc.__cause__ is not None else (None if exc.__suppress_context__ else exc.__context__)
    return inner if isinstance(inner, Exception) else None


def error_object(exc: BaseException, known: Iterable[str] = (), *, fallback: str = "") -> dict[str, Any]:
    """The `error` object of a failed step: the class of the root cause, the OPC UA status when there is one, a scrubbed message.

    A connector wraps what it caught (`ConnectorError(...) from exc`), so the chain of `__cause__` is followed: the class of
    the innermost exception ("gaierror", "ConnectionRefusedError") is what the hints table knows. The status is taken from
    any exception in the chain. The message is the outermost one with text, since that is what the connector chose to say.
    """
    chain = [exc]
    while (inner := _inner(chain[-1])) is not None and len(chain) < MAX_CAUSE_DEPTH:
        chain.append(inner)
    root = chain[-1]
    status_name = status_hex = None
    for candidate in chain:
        status_name, status_hex = _status_of(candidate)
        if status_hex is not None:
            break
    message = next((text for text in (str(item).strip() for item in chain) if text), "") or fallback or type(root).__name__
    return {
        "class": type(root).__name__,
        "status_name": status_name,
        "status_hex": status_hex,
        "message": clip_error(scrub_url_credentials(message, tuple(known)), MAX_MESSAGE_CHARS),
    }


class Checker:
    """Runs the steps of one check and keeps the `CheckResult`.

    `step_timeout` bounds each step (a step can pass its own `timeout`), `deadline_seconds` bounds the whole check: the step in
    flight when it runs out fails with a TimeoutError, the first step started after it fails too, and later ones are skipped.
    `known` are the values (passwords) that must not appear in any text of the result.
    """

    def __init__(
        self,
        connector_type: str,
        publish: Publish | None = None,
        *,
        known: Iterable[str] = (),
        step_timeout: float | None = None,
        deadline_seconds: float | None = None,
    ) -> None:
        self.result = CheckResult(connector_type)
        self._publish_to = publish
        self._known = tuple(known)
        self._step_timeout = step_timeout
        self._deadline_seconds = deadline_seconds
        self._deadline = None if deadline_seconds is None else time.monotonic() + deadline_seconds
        self._deadline_reported = False
        self._cause: dict[str, str] = {}  # a skipped step's id -> the name of the step that failed and caused the skip
        self._publish_failing = False

    # -- what a connector calls ------------------------------------------------------------------------------------------------

    async def step(
        self,
        step_id: str,
        name: str,
        fn: StepFunction,
        *,
        needs: Iterable[str] = (),
        timeout: float | None = None,
    ) -> Step:
        """Run `fn` as the step `step_id`, record how it went and publish the result.

        `fn` is an async function without arguments (a closure, so steps can share a session). It returns a summary string, a
        `StepOutcome` or None for success; raising ends the step as FAIL: `StepFailed` for a failure the step detected itself,
        any other `Exception` is classified by `error_object` (cancellation passes through). A step whose `needs` did not all
        succeed is not run: it is recorded as skipped (`ok` None). Never raises for a failed step; returns the recorded `Step`.
        """
        step = Step(step_id, name)
        self.result.steps.append(step)
        blocked = self._blocked(step_id, needs)
        if blocked:
            step.summary = f"skipped: {blocked}"
        else:
            await self._run(step, fn, timeout)
        if step.ok is False and self.result.first_failed is None:
            self.result.first_failed = step.id
        await self._publish()
        return step

    def clock(self, server_time: datetime, local_time: datetime | None = None) -> float:
        """Record the server's clock against ours and return the skew in seconds: server minus local, positive when the server
        is ahead. A naive datetime counts as UTC. Pass `local_time` taken around the read, not before the check began."""
        server, local = _utc(server_time), _utc(local_time or _now())
        self.result.server_time, self.result.local_time = server.isoformat(), local.isoformat()
        self.result.skew_seconds = round((server - local).total_seconds(), 3)
        return self.result.skew_seconds

    def add_names(self, hosts: Iterable[str] = (), uris: Iterable[str] = ()) -> None:
        """Remember the host names and URIs the server calls itself (for the report's masking); duplicates and non-text go."""
        for target, names in ((self.result.hosts, hosts), (self.result.uris, uris)):
            for item in names:
                text = scrub_url_credentials(item, self._known).strip() if isinstance(item, str) else ""
                if text and text not in target and len(target) < MAX_NAMES:
                    target.append(text[:300])

    async def finish(self) -> CheckResult:
        """Mark the check finished (`ok` is True when every step ran and succeeded), publish it and return it."""
        result = self.result
        result.finished = True
        result.ok = bool(result.steps) and all(step.ok is True for step in result.steps)
        await self._publish()
        return result

    # -- internals -------------------------------------------------------------------------------------------------------------

    def _blocked(self, step_id: str, needs: Iterable[str]) -> str:
        """Why a step with these `needs` is not run, in the words of the screen (step names, not ids): the first need that did not
        succeed. When that one was itself skipped, the step that actually failed is named."""
        for need in needs:
            found = self.result.step(need)
            if found is None:
                return f"{need} was not run"
            if found.ok is False:
                self._cause[step_id] = found.name
                return f"{found.name} failed"
            if found.ok is None:
                if cause := self._cause.get(need):
                    self._cause[step_id] = cause
                    return f"{cause} failed"
                return f"{found.name} was skipped"
        return ""

    def _limit(self, timeout: float | None) -> float | None:
        limits = [value for value in (timeout, self._step_timeout) if value is not None]
        if self._deadline is not None:
            limits.append(max(0.0, self._deadline - time.monotonic()))
        return min(limits) if limits else None

    async def _run(self, step: Step, fn: StepFunction, timeout: float | None) -> None:
        if self._deadline is not None and time.monotonic() >= self._deadline:
            self._expire(step)
            return
        limit = self._limit(timeout)
        fallback = "" if limit is None else f"no answer within {limit:g} s"
        started = time.perf_counter()
        try:
            async with asyncio.timeout(limit):
                outcome = await fn()
        except StepFailed as exc:
            self._fail_with(step, exc)
        except Exception as exc:  # noqa: BLE001 - whatever a step raises is the finding
            error = error_object(exc, self._known, fallback=fallback if isinstance(exc, TimeoutError) else "")
            step.ok, step.error = False, error
            step.hint = hint_for(error["status_name"], error["class"], step.id)
        else:
            step.ok = True
            if isinstance(outcome, StepOutcome):
                step.summary, step.detail, step.hint = outcome.summary, self._clean(outcome.detail), outcome.hint
            elif outcome is not None:
                step.summary = str(outcome)
            step.summary = scrub_url_credentials(step.summary, self._known)
        step.ms = round((time.perf_counter() - started) * 1000, 1)

    def _fail_with(self, step: Step, exc: StepFailed) -> None:
        step.ok = False
        step.summary = scrub_url_credentials(exc.summary, self._known)
        step.detail = self._clean(exc.detail)
        step.error = {
            "class": exc.error_class,
            "status_name": exc.status_name,
            "status_hex": exc.status_hex,
            "message": clip_error(scrub_url_credentials(str(exc), self._known), MAX_MESSAGE_CHARS),
        }
        step.hint = exc.hint or hint_for(exc.hint_key or exc.status_name, exc.error_class, step.id)

    def _expire(self, step: Step) -> None:
        reason = f"the check's overall time limit of {self._deadline_seconds:g} s was reached"
        if self._deadline_reported:
            step.summary = f"skipped: {reason}"
            return
        self._deadline_reported = True
        step.ok = False
        step.error = {"class": "TimeoutError", "status_name": None, "status_hex": None, "message": f"{reason} before this step"}

    def _clean(self, detail: dict[str, Any]) -> dict[str, Any]:
        return scrub_strings(_jsonable(detail), self._known)

    async def _publish(self) -> None:
        if self._publish_to is None:
            return
        try:
            async with asyncio.timeout(PUBLISH_TIMEOUT_SECONDS):
                await self._publish_to(self.result)
        except Exception as exc:  # noqa: BLE001 - a progress write must never fail the check
            if not self._publish_failing:
                log.warning("could not store the progress of a connection check: %s", (str(exc) or type(exc).__name__)[:200])
            self._publish_failing = True
        else:
            self._publish_failing = False
