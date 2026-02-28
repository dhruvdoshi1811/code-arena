import { useEffect, useMemo, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  ApiError,
  api,
  gatewayHttpUrl,
  type PublicUser,
  type Session,
  type Submission,
  type SubmissionStatus,
} from '../api';
import { colorForUser } from '../auth';
import { createCollab, type Collab } from '../collab';
import { CodeEditor } from './CodeEditor';
import { OutputPanel, reconcile, type ActiveRun } from './OutputPanel';

interface Participant {
  userId: string;
  displayName: string;
  connections: number;
}

type DocStatus = 'connecting' | 'connected' | 'disconnected';

export function SessionPage({
  sessionId,
  token,
  user,
  onLeave,
}: {
  sessionId: string;
  token: string;
  user: PublicUser;
  onLeave: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [docStatus, setDocStatus] = useState<DocStatus>('connecting');
  const [copied, setCopied] = useState(false);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSession(token, sessionId)
      .then(({ session: loaded }) => {
        if (!cancelled) setSession(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load session');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, token]);

  // One CRDT document per session.
  const collab = useMemo<Collab | null>(
    () => (session ? createCollab(sessionId, token, user) : null),
    [session, sessionId, token, user],
  );

  useEffect(() => () => collab?.destroy(), [collab]);

  useEffect(() => {
    if (!collab) return;
    const onStatus = ({ status }: { status: string }) =>
      setDocStatus(status === 'connected' ? 'connected' : 'disconnected');
    collab.provider.on('status', onStatus);
    return () => collab.provider.off('status', onStatus);
  }, [collab]);

  // The app-events channel, separate from the document transport: presence now.
  useEffect(() => {
    if (!session) return;

    const socket: Socket = io(gatewayHttpUrl, {
      transports: ['websocket'],
      auth: { token },
    });

    socket.on('connect', () => {
      socket.emit('session:join', { sessionId });
    });
    socket.on('presence:update', (payload: { participants: Participant[] }) => {
      setParticipants(payload.participants);
    });

    // Both participants see every transition, including runs the other one started.
    socket.on(
      'submission:status',
      (payload: { submissionId: string; status: SubmissionStatus; exitCode: number | null }) => {
        setActiveRun((current) =>
          current?.submissionId === payload.submissionId
            ? { ...current, status: payload.status, exitCode: payload.exitCode }
            : { submissionId: payload.submissionId, status: payload.status, exitCode: payload.exitCode, lines: [] },
        );
        setSubmissions((current) =>
          current.map((submission) =>
            submission.id === payload.submissionId
              ? { ...submission, status: payload.status, exitCode: payload.exitCode }
              : submission,
          ),
        );

        // Terminal: fetch the persisted row so a tab that joined mid-run ends up with the complete output.
        if (['COMPLETED', 'FAILED', 'TIMEOUT'].includes(payload.status)) {
          api
            .listSubmissions(token, sessionId)
            .then(({ submissions: fresh }) => {
              setSubmissions(fresh);
              const persisted = fresh.find((s) => s.id === payload.submissionId);
              if (persisted) setActiveRun((current) => (current ? reconcile(current, persisted) : current));
            })
            .catch(() => undefined);
        }
      },
    );

    socket.on('submission:output', (payload: { submissionId: string; lines: string[] }) => {
      setActiveRun((current) =>
        current?.submissionId === payload.submissionId
          ? { ...current, lines: [...current.lines, ...payload.lines] }
          : current,
      );
    });
    socket.on('connect_error', (err: Error & { data?: { message?: string } }) => {
      setError(err.data?.message ?? err.message);
    });

    return () => {
      socket.disconnect();
    };
  }, [session, sessionId, token]);

  // Loaded once on entry.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api
      .listSubmissions(token, sessionId)
      .then(({ submissions: loaded }) => {
        if (!cancelled) setSubmissions(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, sessionId, token]);

  async function run() {
    setRunning(true);
    setRunError(null);
    try {
      const { submission } = await api.createSubmission(token, sessionId);
      setSubmissions((current) => [submission, ...current].slice(0, 20));
      setActiveRun({
        submissionId: submission.id,
        status: submission.status,
        exitCode: submission.exitCode,
        lines: [],
      });
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : 'Could not queue the submission');
    } finally {
      setRunning(false);
    }
  }

  if (error) {
    return (
      <div className="centered">
        <div className="card">
          <h1>Cannot open session</h1>
          <p className="error">{error}</p>
          <button type="button" onClick={onLeave}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (!session || !collab) {
    return (
      <div className="centered">
        <p className="muted">Loading session…</p>
      </div>
    );
  }

  return (
    <div className="session">
      <header className="toolbar">
        <button type="button" className="link" onClick={onLeave}>
          ← Sessions
        </button>
        <span className="badge">{session.language}</span>
        <button
          type="button"
          className="link"
          onClick={() => {
            void navigator.clipboard.writeText(sessionId);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy session id'}
        </button>
        <span className="spacer" />
        <button type="button" onClick={() => void run()} disabled={running || docStatus !== 'connected'}>
          {running ? 'Queueing…' : 'Run'}
        </button>
        <span className={`status status-${docStatus}`}>document: {docStatus}</span>
        <code className="muted small">{gatewayHttpUrl}</code>
      </header>

      <div className="session-body">
        <div className="workspace">
          <CodeEditor collab={collab} language={session.language} />
          <OutputPanel run={activeRun} />
        </div>

        <aside className="sidebar">
          <h2>In this session</h2>
          {participants.length === 0 && <p className="muted small">Nobody connected yet</p>}
          <ul className="participants">
            {participants.map((participant) => (
              <li key={participant.userId}>
                <span className="dot" style={{ background: colorForUser(participant.userId) }} />
                <span>{participant.displayName}</span>
                {participant.connections > 1 && (
                  <span className="muted small">×{participant.connections}</span>
                )}
                {participant.userId === user.id && <span className="muted small">you</span>}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Cursors come from Yjs awareness on the document socket; this list comes from
            Socket.io. Both cross gateway instances via Redis.
          </p>

          <h2>Submissions</h2>
          {runError && <p className="error small">{runError}</p>}
          {submissions.length === 0 && <p className="muted small">Nothing queued yet</p>}
          <ul className="submissions">
            {submissions.map((submission) => (
              <li key={submission.id}>
                <span className={`chip chip-${submission.status.toLowerCase()}`}>
                  {submission.status}
                </span>
                <code className="small">{submission.id.slice(0, 8)}</code>
                <span className="muted small">
                  {new Date(submission.createdAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Run publishes to Kafka and returns 202 — queued, not executed. The Go
            orchestrator consumes and logs it. Execution arrives in Phase D.
          </p>
        </aside>
      </div>
    </div>
  );
}
