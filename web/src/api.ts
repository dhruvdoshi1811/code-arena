const BASE = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:4000';

/** Which gateway this tab talks to. Two tabs pointed at different instances is the
 *  Phase B demo — the Redis bridge is what makes them behave as one. */
export const gatewayHttpUrl = BASE;
export const gatewayWsUrl = BASE.replace(/^http/, 'ws');

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export type Language = 'python' | 'javascript';

export interface Session {
  id: string;
  hostId: string;
  guestId: string | null;
  language: Language;
  status: 'ACTIVE' | 'ENDED';
  createdAt: string;
  endedAt: string | null;
}

export type SubmissionStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';

export interface Submission {
  id: string;
  sessionId: string;
  userId: string;
  language: Language;
  code: string;
  status: SubmissionStatus;
  output: string | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Mirrors the gateway's `{ error: { code, message } }` envelope, so the UI can branch
 *  on a stable code instead of matching on prose. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('NETWORK', `Cannot reach the gateway at ${BASE}`);
  }

  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(error?.code ?? 'UNKNOWN', error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

interface AuthResponse {
  token: string;
  user: PublicUser;
}

export const api = {
  register: (email: string, displayName: string, password: string) =>
    request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, displayName, password }),
    }),

  login: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  me: (token: string) => request<{ user: PublicUser }>('/api/auth/me', {}, token),

  createSession: (token: string, language: Language) =>
    request<{ session: Session }>(
      '/api/sessions',
      { method: 'POST', body: JSON.stringify({ language }) },
      token,
    ),

  joinSession: (token: string, sessionId: string) =>
    request<{ session: Session }>(`/api/sessions/${sessionId}/join`, { method: 'POST' }, token),

  getSession: (token: string, sessionId: string) =>
    request<{ session: Session }>(`/api/sessions/${sessionId}`, {}, token),

  /** Returns 202: the submission is durably queued, not executed. Nothing here waits
   *  for a result — status transitions and output arrive over the socket in Phase E. */
  createSubmission: (token: string, sessionId: string) =>
    request<{ submission: Submission }>(
      `/api/sessions/${sessionId}/submissions`,
      { method: 'POST' },
      token,
    ),

  listSubmissions: (token: string, sessionId: string) =>
    request<{ submissions: Submission[] }>(`/api/sessions/${sessionId}/submissions`, {}, token),
};
