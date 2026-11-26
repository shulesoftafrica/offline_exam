import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AttemptRecord, ExamBundle, SessionRecord } from '../../types';
import { ApiError } from '../../core/api/types';
import { BundleIncompleteError, type BundleProgress } from '../../core/exam/bundle';
import { describeError } from '../../core/util/logger';
import { useConnectivity } from '../hooks/useConnectivity';
import { useService } from '../hooks/useService';
import { Banner, NetPill, ProgressBar, Spinner } from '../components/common';

/**
 * The gate between "online" and "offline".
 *
 * This is the only screen that needs the internet, and it says so. It downloads the whole
 * exam bundle, verifies it (checksum, question count, every picture on disk) and only then
 * offers **Start exam** — after which the invigilator can switch the lab off.
 */
export function ExamIntroScreen({ session }: { session: SessionRecord }): JSX.Element {
  const service = useService();
  const navigate = useNavigate();
  const net = useConnectivity();
  const params = useParams<{ examId: string }>();
  const examId = Number(params.examId);

  const [bundle, setBundle] = useState<ExamBundle | null>(null);
  const [attempt, setAttempt] = useState<AttemptRecord | null>(null);
  const [progress, setProgress] = useState<BundleProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const attemptKey = service.attemptKeyFor(session.student, examId);

  // What is already on this machine?
  useEffect(() => {
    void (async () => {
      setBundle(await service.exams.getBundle(attemptKey));
      setAttempt(await service.exams.getAttempt(attemptKey));
    })();
  }, [attemptKey, service]);

  const download = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const result = await service.prepareExam(session, examId, setProgress);
      setBundle(result.bundle);
      setAttempt(result.attempt);
    } catch (err) {
      if (err instanceof BundleIncompleteError) {
        setProblems(err.problems);
        setError('The exam did not download completely.');
      } else if (err instanceof ApiError) {
        setError(
          err.isOffline
            ? 'The internet is off, so the exam cannot be downloaded. Ask the invigilator to switch it on before you start.'
            : (err.serverMessage ?? err.message),
        );
      } else {
        setError(describeError(err));
      }
      setBundle(await service.exams.getBundle(attemptKey));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [attemptKey, examId, service, session]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      await service.beginAttempt(attemptKey);
      navigate(`/exam/${examId}/run`, { replace: true });
    } finally {
      setBusy(false);
    }
  }, [attemptKey, examId, navigate, service]);

  const ready = bundle !== null && bundle.verifiedAt !== null;
  const inProgress = attempt?.status === 'in_progress';
  const alreadyDone =
    attempt !== null &&
    ['submitted_offline', 'syncing', 'synced', 'needs_attention'].includes(attempt.status);

  if (alreadyDone) {
    return (
      <div className="stack">
        <Banner tone="ok" title="You have already submitted this exam.">
          Your answers are stored on this computer and will reach the school when the internet is
          back.
        </Banner>
        <div className="row">
          <button type="button" className="btn" onClick={() => navigate('/exams')}>
            Back to my exams
          </button>
          <button type="button" className="btn secondary" onClick={() => navigate('/sync')}>
            Sync status
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack loose">
      <div className="card stack">
        <div className="row between">
          <h1 style={{ marginBottom: 0 }}>{bundle?.exam.title ?? 'Exam'}</h1>
          <NetPill state={net} />
        </div>

        {bundle ? (
          <>
            <dl className="kv">
              <dt>Subject</dt>
              <dd>{bundle.exam.subject || '—'}</dd>
              <dt>Questions</dt>
              <dd>{bundle.questions.length}</dd>
              <dt>Total marks</dt>
              <dd>{bundle.exam.totalWeight || '—'}</dd>
              <dt>Time allowed</dt>
              <dd>{Math.round(bundle.durationSeconds / 60)} minutes</dd>
              <dt>Attachments</dt>
              <dd>
                {bundle.attachmentRules.enabled
                  ? `Allowed (up to ${bundle.attachmentRules.maxFilesPerQuestion} per question)`
                  : 'Not used in this exam'}
              </dd>
            </dl>

            {bundle.exam.instructions ? (
              <div className="card quiet">
                <h2>Instructions</h2>
                {bundle.exam.instructions.split('\n').map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">
            Download the exam to this computer before the internet is switched off.
          </p>
        )}

        {progress ? (
          <div className="stack tight">
            <ProgressBar ratio={progress.ratio} label="Downloading the exam" />
            <span className="muted">{progress.message}</span>
          </div>
        ) : null}

        {error ? (
          <Banner tone="danger" title={error}>
            {problems.length > 0 ? (
              <ul style={{ margin: '0.25rem 0 0 1rem' }}>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}

        {ready ? (
          <Banner tone="ok" title="This exam is fully downloaded.">
            Everything is on this computer: {bundle?.questions.length} questions
            {Object.keys(bundle?.mediaFileIds ?? {}).length > 0
              ? ` and ${Object.keys(bundle?.mediaFileIds ?? {}).length} picture(s)`
              : ''}
            . The internet can now be switched off.
          </Banner>
        ) : null}

        <div className="row">
          {!ready || !inProgress ? (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void download()}>
              {busy && progress ? <Spinner label="Downloading…" /> : ready ? 'Download again' : 'Download exam'}
            </button>
          ) : null}

          <button type="button" className="btn big" disabled={!ready || busy} onClick={() => void start()}>
            {inProgress ? 'Continue exam' : 'Start exam'}
          </button>

          <button type="button" className="btn ghost" onClick={() => navigate('/exams')}>
            Back
          </button>
        </div>

        {!inProgress && ready ? (
          <p className="muted" style={{ margin: 0 }}>
            The countdown starts when you press <strong>Start exam</strong>, not when you download.
          </p>
        ) : null}
      </div>
    </div>
  );
}
