"""The compute thread: the engine's pure Python runs on ONE worker thread, so the event loop stays free.

There is a single uvicorn worker and every handler is `async def`; before this module a Power dashboard's three seconds of
assembly and pricing ran inside the loop, and every other request (`GET /api/me`, the Storage page) waited behind it.
`await run(fn, *args)` hands `fn` to one dedicated thread and gives the loop back until it is done. One thread, not a pool:
the work is CPU-bound Python (the GIL would serialize more threads anyway) and a single thread keeps two computations from
ever running at once, as they never did in the loop.

What may be given to `run`: PURE functions only. No `AsyncSession` (a session belongs to the loop), no request object, no
`await`, no database access, and no mutation of anything shared: the arguments are only READ (the asset tree, the tariffs, the
rows), and the result is a new object the caller owns. That is the whole contract; the maths of a function is the same on any
thread, so no figure depends on where it ran.

`sys.setswitchinterval(0.001)` is set when this module is imported (an ASGI test client runs no lifespan, so the app's start-up
is not the place): a thread that holds the GIL gives it to the loop every millisecond instead of every five. The loop takes
the GIL again after every socket wait, so with five milliseconds a request that waits a few times could take 15 to 30 ms
behind a running computation.
"""
import asyncio
import sys
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

T = TypeVar("T")

sys.setswitchinterval(0.001)

# Created on first use, so it can be created again after `shutdown()` (the app's shutdown, and the tests, stop it).
_executor: ThreadPoolExecutor | None = None
_lock = threading.Lock()


def _get_executor() -> ThreadPoolExecutor:
    global _executor
    with _lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dcdash-compute")
        return _executor


async def run(fn: Callable[..., T], *args: Any) -> T:
    """`fn(*args)` on the compute thread; the loop is free meanwhile. An exception `fn` raises is raised here. `fn` must be
    pure (see the module docstring)."""
    return await asyncio.get_running_loop().run_in_executor(_get_executor(), fn, *args)


def shutdown() -> None:
    """Stop the thread without waiting for a running computation (its caller is gone); work not yet started is dropped. A later
    `run` starts a new thread."""
    global _executor
    with _lock:
        executor, _executor = _executor, None
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
