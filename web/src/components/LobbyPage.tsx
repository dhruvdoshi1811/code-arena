import { useState } from 'react';
import { ApiError, api, gatewayHttpUrl, type Language, type PublicUser } from '../api';

export function LobbyPage({
  token,
  user,
  onOpenSession,
  onSignOut,
}: {
  token: string;
  user: PublicUser;
  onOpenSession: (sessionId: string) => void;
  onSignOut: () => void;
}) {
  const [language, setLanguage] = useState<Language>('python');
  const [joinId, setJoinId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      onOpenSession(await action());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="card">
        <header className="card-header">
          <h1>CodeArena</h1>
          <button type="button" className="link" onClick={onSignOut}>
            Sign out
          </button>
        </header>
        <p className="muted">
          Signed in as <strong>{user.displayName}</strong> · gateway <code>{gatewayHttpUrl}</code>
        </p>

        <label>
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
          </select>
        </label>

        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => (await api.createSession(token, language)).session.id)
          }
        >
          Start a session
        </button>

        <hr />

        <label>
          Join with a session id
          <input
            value={joinId}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => setJoinId(e.target.value.trim())}
          />
        </label>

        <button
          type="button"
          disabled={busy || joinId.length === 0}
          onClick={() => void run(async () => (await api.joinSession(token, joinId)).session.id)}
        >
          Join
        </button>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
