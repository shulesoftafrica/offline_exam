import React, { useEffect, useState } from 'react';
import type { SessionRecord } from '../../types';
import { ApiError } from '../../core/api/types';
import { config } from '../../core/config';
import { describeError } from '../../core/util/logger';
import { useConnectivity } from '../hooks/useConnectivity';
import { useService } from '../hooks/useService';
import { Banner, NetPill, Spinner } from '../components/common';

/**
 * Login with the student's existing ShuleSoft username and password.
 *
 * Two paths:
 *  - **Online** (the normal one, before the lab switch goes off): credentials go to the
 *    Laravel API and the session is cached for the shift.
 *  - **Offline resume**: if the lab is already off and this machine has the student's
 *    session cached, they can get back in without the server. No new session can be
 *    created offline — only one that was established online on this machine.
 */
export function LoginScreen({
  onSignedIn,
}: {
  onSignedIn: (session: SessionRecord) => void;
}): JSX.Element {
  const service = useService();
  const net = useConnectivity();
  const [school, setSchool] = useState(config.defaultSchool ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState<SessionRecord[]>([]);

  useEffect(() => {
    void service.sessions.all().then(setCached);
  }, [service]);

  const offline = net.reachability === 'offline';

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await service.login(username.trim(), password, school.trim() || null);
      onSignedIn(session);
    } catch (err) {
      if (err instanceof ApiError && err.isOffline) {
        // Fall back to a cached session for exactly this username, if there is one.
        const resumed = await service.resumeOffline(username.trim());
        if (resumed) {
          onSignedIn(resumed);
          return;
        }
        setError(
          'There is no internet, and this computer has no saved login for that username. Ask the invigilator to switch the internet on for you to sign in.',
        );
      } else {
        setError(err instanceof ApiError ? (err.serverMessage ?? err.message) : describeError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function resume(session: SessionRecord): Promise<void> {
    setBusy(true);
    const resumed = await service.resumeOffline(session.student.username);
    setBusy(false);
    if (resumed) onSignedIn(resumed);
  }

  return (
    <div className="stack loose">
      <div className="card stack">
        <div className="row between">
          <h1>Sign in to your exam</h1>
          <NetPill state={net} />
        </div>
        <p className="muted">
          Use the same username and password you use for ShuleSoft.
        </p>

        {offline ? (
          <Banner tone="warn" title="No internet.">
            You can only sign in again on a computer where you signed in earlier today.
          </Banner>
        ) : null}

        <form className="stack" onSubmit={(event) => void submit(event)}>
          {config.defaultSchool ? null : (
            <div className="field">
              <label htmlFor="school">School code</label>
              <input
                id="school"
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={school}
                onChange={(event) => setSchool(event.target.value)}
                placeholder="e.g. mtakuja"
                required
              />
              <span className="help">The invigilator will write this on the board.</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          {error ? <Banner tone="danger">{error}</Banner> : null}

          <button type="submit" className="btn big block" disabled={busy}>
            {busy ? <Spinner label="Signing in…" /> : 'Sign in'}
          </button>
        </form>
      </div>

      {cached.length > 0 ? (
        <div className="card quiet stack tight">
          <h2>Signed in earlier on this computer</h2>
          <p className="muted">
            Tap your name to continue an exam that is still on this computer. You will still
            need your password the next time the internet is on.
          </p>
          {cached.map((session) => (
            <div className="row between" key={session.scopeKey}>
              <span>
                <strong>{session.student.name}</strong>
                <br />
                <span className="muted" style={{ fontSize: '0.9rem' }}>
                  {session.student.username} · {session.student.schoolName || session.student.schemaName}
                </span>
              </span>
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => void resume(session)}
              >
                Continue
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {config.apiDriver === 'mock' ? (
        <Banner tone="info" title="Demo mode.">
          No backend is connected. Sign in with <code>student</code> / <code>student</code> (or{' '}
          <code>student2</code> / <code>student</code> to try a second student on the same machine).
        </Banner>
      ) : null}
    </div>
  );
}
