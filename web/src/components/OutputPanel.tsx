import { useEffect, useRef } from 'react';
import type { Submission, SubmissionStatus } from '../api';

export interface ActiveRun {
  submissionId: string;
  status: SubmissionStatus;
  exitCode: number | null;
  lines: string[];
}

const HINTS: Record<SubmissionStatus, string> = {
  QUEUED: 'queued — waiting for an executor',
  RUNNING: 'running in an isolated Kubernetes Job',
  COMPLETED: 'finished',
  FAILED: 'the program failed',
  TIMEOUT: 'killed by Kubernetes at its execution deadline',
};

export function OutputPanel({ run }: { run: ActiveRun | null }) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const pinnedToBottom = useRef(true);

  // Follow the tail while the user is at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run?.lines.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  if (!run) {
    return (
      <section className="output">
        <header className="output-header">
          <h2>Output</h2>
          <span className="muted small">press Run to execute the shared document</span>
        </header>
        <pre className="output-body muted" />
      </section>
    );
  }

  const running = run.status === 'QUEUED' || run.status === 'RUNNING';

  return (
    <section className="output">
      <header className="output-header">
        <h2>Output</h2>
        <span className={`chip chip-${run.status.toLowerCase()}`}>{run.status}</span>
        <span className="muted small">{HINTS[run.status]}</span>
        {run.exitCode !== null && <span className="muted small">exit {run.exitCode}</span>}
        <span className="spacer" />
        {running && <span className="pulse" aria-label="running" />}
        <code className="muted small">{run.submissionId.slice(0, 8)}</code>
      </header>
      <pre className="output-body" ref={scrollRef} onScroll={onScroll}>
        {run.lines.length === 0
          ? running
            ? '…'
            : '(no output)'
          : run.lines.join('\n')}
      </pre>
    </section>
  );
}

/** Reconcile a finished run against the persisted submission. */
export function reconcile(run: ActiveRun, submission: Submission): ActiveRun {
  if (submission.id !== run.submissionId || submission.output === null) return run;
  return {
    ...run,
    status: submission.status,
    exitCode: submission.exitCode,
    lines: submission.output.split('\n').filter((line, index, all) =>
      index < all.length - 1 || line.length > 0,
    ),
  };
}
