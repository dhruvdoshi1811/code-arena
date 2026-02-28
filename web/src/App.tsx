import { useCallback, useEffect, useState } from 'react';
import type { PublicUser } from './api';
import { authStore } from './auth';
import { LoginPage } from './components/LoginPage';
import { LobbyPage } from './components/LobbyPage';
import { SessionPage } from './components/SessionPage';

/** Hash routing rather than a router dependency: the whole app is two screens. */
function readSessionIdFromHash(): string | null {
  const match = /^#\/s\/([0-9a-fA-F-]{36})$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

export function App() {
  const [auth, setAuth] = useState(() => authStore.read());
  const [sessionId, setSessionId] = useState<string | null>(readSessionIdFromHash);

  useEffect(() => {
    const onHashChange = () => setSessionId(readSessionIdFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const openSession = useCallback((id: string) => {
    window.location.hash = `#/s/${id}`;
    setSessionId(id);
  }, []);

  const leaveSession = useCallback(() => {
    window.location.hash = '';
    setSessionId(null);
  }, []);

  const signOut = useCallback(() => {
    authStore.clear();
    setAuth(null);
    window.location.hash = '';
    setSessionId(null);
  }, []);

  if (!auth) {
    return (
      <LoginPage
        onAuthed={(token: string, user: PublicUser) => {
          authStore.write(token, user);
          setAuth({ token, user });
        }}
      />
    );
  }

  if (sessionId) {
    return (
      <SessionPage
        sessionId={sessionId}
        token={auth.token}
        user={auth.user}
        onLeave={leaveSession}
      />
    );
  }

  return (
    <LobbyPage
      token={auth.token}
      user={auth.user}
      onOpenSession={openSession}
      onSignOut={signOut}
    />
  );
}
