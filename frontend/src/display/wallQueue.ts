import type { WidgetData } from "../api/types";
import type { WidgetReply } from "./displayApi";
import type { Timers } from "./displayLoop";
import { JITTER_MAX, MAX_IN_FLIGHT, busyWait, failureWait } from "./wallRules";

// The wall's widget requests: at most two on the wire at once (w28's caps leave ten screens about one slot each), urgent jobs first, and a queue-wide
// cool-down after a 429 or a failure so a server that is busy or restarting is not asked again at once. No React, no clock of its own: the
// timers and the time are injected.

/** What became of one job. A job reports once per answer: a failing job reports `failed` again at each new attempt. */
export type QueueResult =
  | { kind: "ok"; data: WidgetData; serverDate: number | null }
  /** A 404: the playlist moved on (an edited or deleted dashboard). Not a failure; the job is done. */
  | { kind: "moved"; serverDate: number | null }
  /** A 401: the cookie no longer opens the display routes. Reported, then retried like a failure (the playlist loop owns the revoked logic). */
  | { kind: "unauthorized"; serverDate: number | null }
  /** A 409 or 422: the server will not draw this widget. Reported once and NOT asked again by the queue: the controller decides when to enqueue it again. */
  | { kind: "rejected"; status: number; serverDate: number | null }
  /** A network error, a timeout, a 5xx, a 200 without figures: retried by the queue after a backoff while the job is not cancelled. */
  | { kind: "failed"; status: number | null; serverDate: number | null };

export interface QueueDeps {
  timers: Timers;
  /** Local ms. */
  now: () => number;
  random: () => number;
  fetchWidget: (item: number, widget: number) => Promise<WidgetReply>;
  onResult: (key: string, result: QueueResult) => void;
}

export interface WidgetQueue {
  /** The same key twice is one job (an urgent one overtakes a waiting one). A key whose job is done or cancelled can be enqueued again. */
  enqueue(job: { key: string; item: number; widget: number; urgent: boolean }): void;
  /** Drops a waiting job and ignores the answer of a running one (its request stays on the wire and holds its slot until it answers). */
  cancel(key: string): void;
  /** Cancels every job. The cool-down stays: it is about the server, not about the jobs. */
  clear(): void;
  /** While paused nothing starts; a running request is not aborted and is still reported. */
  pause(): void;
  resume(): void;
  /** Requests on the wire, cancelled ones included. */
  inFlight(): number;
  waiting(): number;
}

interface Job {
  key: string;
  item: number;
  widget: number;
  urgent: boolean;
  seq: number;
  running: boolean;
  cancelled: boolean;
}

/** The longest cool-down there can be (a 120 s Retry-After with full jitter): a "remaining" beyond it means the machine's clock moved back, and the cool-down is over. */
const MAX_COOL_MS = Math.ceil(120_000 * (1 + JITTER_MAX));

export function createWidgetQueue(deps: QueueDeps): WidgetQueue {
  const { timers, now, random, fetchWidget, onResult } = deps;
  const jobs = new Map<string, Job>(); // the live jobs, waiting or running, in the order they came
  let seq = 0;
  let running = 0; // requests on the wire, cancelled ones included
  let paused = false;
  let failures = 0; // failures in a row; any figure answer, 404 or refusal ends the run
  let coolUntil = 0; // local ms; no request starts before it
  let coolTimer: unknown = null;

  const waitingJobs = () => [...jobs.values()].filter((job) => !job.running);

  function best(): Job | null {
    let pick: Job | null = null;
    for (const job of waitingJobs()) {
      if (pick === null || (job.urgent && !pick.urgent) || (job.urgent === pick.urgent && job.seq < pick.seq)) pick = job;
    }
    return pick;
  }

  function arm(delay: number) {
    if (coolTimer !== null) return; // one timer: if it fires early (the cool-down grew) pump arms it again
    coolTimer = timers.set(() => {
      coolTimer = null;
      pump();
    }, Math.max(delay, 0));
  }

  function pump() {
    if (paused) return;
    const t = now();
    if (coolUntil - t > MAX_COOL_MS) coolUntil = 0; // the clock moved back by more than any wait: do not sit out a cool-down that cannot be real
    if (t < coolUntil) {
      if (jobs.size > running) arm(coolUntil - t); // only worth a timer when something waits
      return;
    }
    while (running < MAX_IN_FLIGHT) {
      const job = best();
      if (job === null) return;
      start(job);
    }
  }

  function coolDown(ms: number) {
    coolUntil = Math.max(coolUntil, now() + ms);
  }

  function start(job: Job) {
    job.running = true;
    running += 1;
    let request: Promise<WidgetReply>;
    try {
      request = fetchWidget(job.item, job.widget);
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (answer) => finish(job, answer),
      () => finish(job, null),
    );
  }

  function finish(job: Job, answer: WidgetReply | null) {
    running -= 1;
    const serverDate = answer?.serverDate ?? null;
    let result: QueueResult | null = null; // what to report; null for a busy answer
    let again = false; // the job stays queued and is asked for again after the cool-down
    if (answer === null) {
      result = { kind: "failed", status: null, serverDate };
      again = true;
    } else if (answer.status === 200) {
      if (answer.data !== null) result = { kind: "ok", data: answer.data, serverDate };
      else { result = { kind: "failed", status: 200, serverDate }; again = true; }
    } else if (answer.status === 404) {
      result = { kind: "moved", serverDate };
    } else if (answer.status === 401) {
      result = { kind: "unauthorized", serverDate };
      again = true;
    } else if (answer.status === 409 || answer.status === 422) {
      result = { kind: "rejected", status: answer.status, serverDate };
    } else if (answer.status === 429) {
      again = true;
    } else {
      result = { kind: "failed", status: answer.status, serverDate };
      again = true;
    }

    // What the answer says about the server counts even when nobody wants the answer any more (a cancelled job).
    if (result === null) {
      coolDown(busyWait(answer?.retryAfter ?? null, random));
    } else if (result.kind === "failed" || result.kind === "unauthorized") {
      coolDown(failureWait(failures, random));
      failures += 1;
    } else {
      failures = 0; // the server answered: figures, a moved playlist or a refusal
    }

    const live = !job.cancelled;
    if (live) {
      if (again) job.running = false;
      else jobs.delete(job.key);
    }
    try {
      if (live && result !== null) onResult(job.key, result);
    } finally {
      pump();
    }
  }

  return {
    enqueue({ key, item, widget, urgent }) {
      const known = jobs.get(key);
      if (known) {
        if (urgent) known.urgent = true;
      } else {
        seq += 1;
        jobs.set(key, { key, item, widget, urgent, seq, running: false, cancelled: false });
      }
      pump();
    },
    cancel(key) {
      const job = jobs.get(key);
      if (!job) return;
      job.cancelled = true;
      jobs.delete(key);
    },
    clear() {
      for (const job of jobs.values()) job.cancelled = true;
      jobs.clear();
      if (coolTimer !== null) {
        timers.clear(coolTimer);
        coolTimer = null;
      }
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      pump();
    },
    inFlight: () => running,
    waiting: () => waitingJobs().length,
  };
}
