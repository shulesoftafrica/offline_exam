import React, { useCallback, useEffect, useState } from 'react';
import {
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import type { SessionRecord } from '../types';
import type { ExamService } from '../core/examService';
import { ServiceContext } from './hooks/useService';
import { useAppUpdate } from './hooks/useAppUpdate';
import { useConnectivity, useSyncProgress } from './hooks/useConnectivity';
import { Banner, NetPill, Spinner, SyncBadge } from './components/common';
import { LoginScreen } from './screens/LoginScreen';
import { ExamListScreen } from './screens/ExamListScreen';
import { ExamIntroScreen } from './screens/ExamIntroScreen';
import { ExamRunnerScreen } from './screens/ExamRunnerScreen';
import { SubmittedScreen } from './screens/SubmittedScreen';
import { SyncCenterScreen } from './screens/SyncCenterScreen';

/**
 * App shell: session gate, routing and the one header every screen shares.
 *
 * The service is passed in rather than imported so the whole app can be mounted against a
 * test instance (its own IndexedDB and a mock API).
 */
export function App({ service }: { service: ExamService }): JSX.Element {
  return (
    <ServiceContext.Provider value={service}>
      <Router>
        <Shell />
      </Router>
    </ServiceContext.Provider>
  );
}

function Shell(): JSX.Element {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [booting, setBooting] = useState(true);
  const [examInProgress, setExamInProgress] = useState(false);
  const location = useLocation();

  const service = React.useContext(ServiceContext);
  if (!service) throw new Error('ServiceContext is missing.');

  // Restore the active session (a refresh during the offline window must not log out).
  useEffect(() => {
    void (async () => {
      setSession(await service.activeSession());
      setBooting(false);
    })();
  }, [service]);

  // Is any attempt on this machine mid-exam? Gates the service-worker update offer.
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const attempts = await service.exams.allAttempts();
      if (!cancelled) setExamInProgress(attempts.some((a) => a.status === 'in_progress'));
    };
    void check();
    const poll = window.setInterval(() => void check(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [service, location.pathname]);

  const signOut = useCallback(async () => {
    await service.logout();
    setSession(null);
  }, [service]);

  if (booting) {
    return (
      <div className="center-screen">
        <Spinner label="Starting the exam app…" />
      </div>
    );
  }

  return (
    <div className="app">
      <Header session={session} examInProgress={examInProgress} onSignOut={signOut} />
      <main className={`app-main ${session ? '' : 'narrow'}`}>
        {session ? (
          <Routes>
            <Route path="/exams" element={<ExamListScreen session={session} />} />
            <Route path="/exam/:examId" element={<ExamIntroScreen session={session} />} />
            <Route path="/exam/:examId/run" element={<ExamRunnerScreen session={session} />} />
            <Route path="/exam/:examId/done" element={<SubmittedScreen session={session} />} />
            <Route path="/sync" element={<SyncCenterScreen />} />
            <Route path="*" element={<Navigate to="/exams" replace />} />
          </Routes>
        ) : (
          <Routes>
            {/* The sync screen stays reachable with nobody signed in: the last shift's work
                must be pushable by an invigilator without a student's password. */}
            <Route path="/sync" element={<SyncCenterScreen />} />
            <Route path="*" element={<LoginScreen onSignedIn={setSession} />} />
          </Routes>
        )}
      </main>
      <UpdateNotice safe={!examInProgress} />
    </div>
  );
}

function Header({
  session,
  examInProgress,
  onSignOut,
}: {
  session: SessionRecord | null;
  examInProgress: boolean;
  onSignOut: () => Promise<void>;
}): JSX.Element {
  const net = useConnectivity();
  const progress = useSyncProgress();
  const navigate = useNavigate();

  return (
    <header className="app-header">
      <span className="brand">
        <img src="/favicon.svg" alt="" width={26} height={26} />
        ShuleSoft Exams
      </span>
      <span className="spacer" />
      <NetPill state={net} examInProgress={examInProgress} />
      {progress.summary.total > 0 ? <SyncBadge summary={progress.summary} /> : null}
      {session ? (
        <>
          {!examInProgress ? (
            <button type="button" className="btn ghost small" onClick={() => navigate('/sync')}>
              Sync
            </button>
          ) : null}
          <span className="muted" style={{ fontSize: '0.9rem' }}>
            {session.student.name}
          </span>
          {!examInProgress ? (
            <button type="button" className="btn secondary small" onClick={() => void onSignOut()}>
              Sign out
            </button>
          ) : null}
        </>
      ) : null}
    </header>
  );
}

/** Offered only between exams; never while an attempt is running. */
function UpdateNotice({ safe }: { safe: boolean }): JSX.Element | null {
  const { available, apply } = useAppUpdate(safe);
  if (!available) return null;
  return (
    <div style={{ padding: '0 1rem 1rem' }}>
      <Banner
        tone="info"
        title="A new version of the exam app is ready."
        action={
          <button type="button" className="btn small" onClick={() => void apply()}>
            Update now
          </button>
        }
      >
        Updating takes a few seconds and is safe while no exam is in progress.
      </Banner>
    </div>
  );
}
