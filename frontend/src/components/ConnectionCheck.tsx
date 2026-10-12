import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { useSite, useSources, useStartCheck } from "../api/queries";
import type { CheckStep } from "../api/types";
import { useJob } from "../hooks/useJob";
import { asCheckResult, CHECK_MAX_WAIT_MS, checkVerdict, describeStepError, formatMs, stepLabel, stepState, type StepState } from "../lib/diagnostics";
import { formatSiteDateTime } from "../lib/siteTime";

const MARK: Record<StepState, string> = { ok: "st-ok", failed: "st-bad", skipped: "st-off" };
// The shape beside the name is the sign (a dot, a diamond, a dash); the word is for a screen reader.
const WORD: Record<StepState, string> = { ok: "passed", failed: "failed", skipped: "skipped" };

function Step({ step }: { step: CheckStep }) {
  const state = stepState(step);
  const ms = formatMs(step.ms);
  return (
    <li className="check-step" data-state={state}>
      <p className="check-head">
        <span className={`st ${MARK[state]}`}>{stepLabel(step)}<span className="sr-only"> ({WORD[state]})</span></span>
        {ms && <span className="check-ms">{ms}</span>}
      </p>
      {step.summary && <p className={state === "skipped" ? "check-summary muted" : "check-summary"}>{step.summary}</p>}
      {state === "failed" && step.error && <p className="check-error error">{describeStepError(step.error)}</p>}
      {step.hint && <p className={state === "failed" ? "check-hint" : "check-hint muted"}>{step.hint}</p>}
    </li>
  );
}

/** The job id a 409 carries: the check that is already queued or running for the source. */
function activeJobOf(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const id = (error.body as { job_id?: unknown } | null | undefined)?.job_id;
  return typeof id === "number" ? id : null;
}

/**
 * Runs the step-by-step connection check of a source and shows the steps as the collector finishes them (the job's result is rewritten
 * after every step). `sourceId` fixes the source (the Sources row's dialog); without it a select offers the sources. `autoStart` queues a
 * check on mount. A second request while one is queued or running (409) follows that check instead; one right after a finish (429) is a sentence.
 */
export function ConnectionCheck({ sourceId, autoStart = false }: { sourceId?: number; autoStart?: boolean }) {
  const sources = useSources();
  const site = useSite();
  const [picked, setPicked] = useState<number | null>(null);
  const id = sourceId ?? picked ?? sources.data?.[0]?.id ?? null;
  const [jobId, setJobId] = useState<number | null>(null);
  const [followed, setFollowed] = useState(false); // the job shown is one that was already running when the button was pressed
  // With autoStart the button is disabled from the first render: the dialog around it focuses its first working control when it opens,
  // and a Run button that the start disables a moment later would take the focus with it.
  const [starting, setStarting] = useState(autoStart);
  const start = useStartCheck(id);
  const { job, timedOut, error: pollError } = useJob(jobId, CHECK_MAX_WAIT_MS);

  const run = () => {
    if (id === null) return;
    setFollowed(false);
    start.mutate(undefined, {
      onSuccess: ({ job_id }) => setJobId(job_id),
      onError: (error) => {
        const active = activeJobOf(error);
        if (active !== null) {
          setJobId(active);
          setFollowed(true);
        }
      },
    });
  };
  const queued = useRef(false); // one automatic start, also under StrictMode's second effect run
  useEffect(() => {
    if (autoStart && id !== null && !queued.current) {
      queued.current = true;
      run();
      setStarting(false); // in the same render as the pending request
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, id]);

  const choose = (next: number) => {
    setPicked(next);
    setJobId(null);
    setFollowed(false);
    start.reset();
  };

  // The job's `status` decides first: a failed job's result is `{ "error": ... }`, a pending one's is null.
  const status = job?.status ?? null;
  const active = jobId !== null && !timedOut && !pollError && (status === null || status === "pending" || status === "running");
  const result = job ? asCheckResult(job.result) : null;
  const failure = status === "failed" ? String((job?.result as { error?: unknown } | null)?.error ?? "unknown error") : null;
  const refused = start.error instanceof ApiError && (start.error.status === 409 || start.error.status === 429);
  const sentence = start.error instanceof ApiError && start.error.status === 429 ? start.error.message : null;
  const stamp = job?.finished_at ?? result?.started_at ?? null;
  const when = stamp && site.data ? formatSiteDateTime(stamp, site.data.timezone) : null;

  let line: string | null = null;
  if (start.isPending) line = "Starting the check…";
  else if (followed && (status === "pending" || status === "running")) {
    line = `A connection check for this source is already ${status === "pending" ? "queued" : "running"}. It is shown here.`;
  } else if (status === "pending") line = "Queued: waiting for the collector to start the check.";
  else if (status === "running") line = "Running…";
  else if (jobId !== null && status === null && !pollError) line = "Starting the check…";
  else if (status === "done" && result) line = checkVerdict(result);
  else if (status === "done") line = "The check finished without a result.";

  return (
    <div className="check-panel">
      <div className="check-controls">
        {sourceId === undefined && (
          <label>
            Source
            <select value={id ?? ""} onChange={(e) => choose(Number(e.target.value))} disabled={!sources.data?.length}>
              {!sources.data?.length && <option value="">{sources.isPending ? "loading…" : "No sources yet"}</option>}
              {sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="primary" onClick={run} disabled={id === null || start.isPending || active || starting}>Run connection check</button>
      </div>
      {start.isError && !refused && <p className="error" role="alert">{start.error.message}</p>}
      {sentence && <p className="muted" role="status">{sentence.charAt(0).toUpperCase() + sentence.slice(1).replace(/\.$/, "")}.</p>}
      {pollError && <p className="error" role="alert">{pollError}</p>}
      {failure !== null && <p className="error" role="alert">The check failed: {failure}</p>}
      {line && <p className="check-line" role="status">{line}</p>}
      {timedOut && <p className="warning" role="status">Still not finished after 2 minutes. The collector may be busy or stopped; the steps below are what it reported so far.</p>}
      {/* Always mounted: a screen reader announces what is added to a live region, not a region that appears with its content. */}
      <div className="check-live" aria-live="polite" aria-relevant="additions">
        {result && result.steps.length > 0 && (
          <ol className="check-steps" aria-label="Check steps">
            {result.steps.map((step) => <Step key={step.id} step={step} />)}
          </ol>
        )}
      </div>
      {status === "done" && when && <p className="check-at muted">Checked at {when}</p>}
    </div>
  );
}
