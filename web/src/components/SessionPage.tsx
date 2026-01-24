import { useEffect, useMemo, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { ApiError, api, gatewayHttpUrl, type PublicUser, type Session } from '../api';
import { colorForUser } from '../auth';
import { createCollab, type Collab } from '../collab';
import { CodeEditor } from './CodeEditor';

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

  // One CRDT document per session, torn down on unmount so the gateway can drop the
  // room and retract this tab's cursor.
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

  // The app-events channel, separate from the document transport: presence now,
  // submission status and streamed output from Phase E.
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
    socket.on('connect_error', (err: Error & { data?: { message?: string } }) => {
      setError(err.data?.message ?? err.message);
    });

    return () => {
      socket.disconnect();
    };
  }, [session, sessionId, token]);

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
        <span className={`status status-${docStatus}`}>document: {docStatus}</span>
        <code className="muted small">{gatewayHttpUrl}</code>
      </header>

      <div className="session-body">
        <CodeEditor collab={collab} language={session.language} />

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
        </aside>
      </div>
    </div>
  );
}
