import { useState, type FormEvent } from 'react';
import { ApiError, api, type PublicUser } from '../api';

export function LoginPage({ onAuthed }: { onAuthed: (token: string, user: PublicUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(email, displayName, password);
      onAuthed(result.token, result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>CodeArena</h1>
        <p className="muted">{mode === 'login' ? 'Sign in to continue' : 'Create an account'}</p>

        <label>
          Email
          <input
            type="email"
            value={email}
            required
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        {mode === 'register' && (
          <label>
            Display name
            <input
              value={displayName}
              required
              maxLength={64}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        )}

        <label>
          Password
          <input
            type="password"
            value={password}
            required
            minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register'}
        </button>

        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Need an account?' : 'Already have an account?'}
        </button>
      </form>
    </div>
  );
}
