import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AttemptRecord, ExamBundle, SessionRecord, SyncSummary } from '../../types';
import { formatDateTime, formatDuration } from '../../core/util/clock';
import { useConnectivity } from '../hooks/useConnectivity';
import { useService } from '../hooks/useService';
import { Banner, NetPill, Spinner, SyncBadge } from '../components/common';

/**
 * The confirmation a student sees before they leave the room.
 *
 * This screen has one job: remove all doubt that the work is safe. It states where the
 * answers are, how many there are, the submission time, the checksum, and what will happen
 * when the internet comes back — and it never asks the student to wait for the network.
 */
export function SubmittedScreen({ session }: { session: SessionRecord }): JSX.Element {
  const service = useService();
  const navigate = useNavigate();
  const net = useConnectivity();
  const params = useParams<{ examId: string }>();
  const examId = Number(params.examId);
  const attemptKey = service.attemptKeyFor(session.student, examId);

  const [attempt, setAttempt] = useState<AttemptRecord | null>(null);
  const [bundle, setBundle] = useState<ExamBundle | null>(null);
  const [sync, setSync] = useState<SyncSummary | null>(null);
  const [attachments, setAttachments] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [a, b, s, files] = await Promise.all([
        service.exams.getAttempt(attemptKey),
        service.exams.getBundle(attemptKey),
        service.outbox.summaryFor(attemptKey),
        service.files.listForAttempt(attemptKey, 'answer'),
      ]);
      if (cancelled) return;
      setAttempt(a);
      setBundle(b);
      setSync(s);
      setAttachments(files.length);
    };
    void load();
    // Refresh while the page is open so the badge flips to "Sent to school" by itself.
    const poll = window.setInterval(() => void load(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [attemptKey, service]);

  if (!attempt) {
    return (
      <div className="center-screen">
        <Spinner label="Checking your submission…" />
      </div>
    );
  }

  const synced = attempt.status === 'synced';
  const flagged = attempt.status === 'needs_attention';

  return (
    <div className="stack loose">
      <div className="card stack">
        <div className="row between">
          <h1 style={{ marginBottom: 0 }}>
            {synced ? 'Your exam has reached the school' : 'Your exam is submitted and saved'}
          </h1>
          <NetPill state={net} />
        </div>

        {flagged ? (
          <Banner tone="danger" title="Your answers are safe, but they could not be sent.">
            Show this screen to the invigilator. Nothing is lost — the exam is stored on this
            computer and can be sent again.
          </Banner>
        ) : synced ? (
          <Banner tone="ok" title="Done.">
            The school has your answers. Your results will be published by your teacher.
          </Banner>
        ) : (
          <Banner tone="ok" title="You can leave the room.">
            Your answers are stored on this computer. They will be sent to the school
            automatically when the internet is switched back on. You do not need to stay and
            wait.
          </Banner>
        )}

        <dl className="kv">
          <dt>Exam</dt>
          <dd>{bundle?.exam.title ?? `#${examId}`}</dd>
          <dt>Submitted at</dt>
          <dd>{attempt.submittedAt ? formatDateTime(attempt.submittedAt) : '—'}</dd>
          <dt>Time used</dt>
          <dd>
            {formatDuration(attempt.timer.elapsedSeconds)} of{' '}
            {formatDuration(attempt.timer.durationSeconds)}
            {attempt.autoSubmitted ? ' (time ran out)' : ''}
          </dd>
          <dt>Questions answered</dt>
          <dd>
            {attempt.answeredCount} of {attempt.questionCount}
          </dd>
          <dt>Files attached</dt>
          <dd>{attachments}</dd>
          <dt>Receipt</dt>
          <dd className="mono">{attempt.submissionChecksum ?? '—'}</dd>
          <dt>This computer</dt>
          <dd className="mono">{attempt.deviceId.slice(0, 8)}</dd>
          <dt>Sending</dt>
          <dd>
            <SyncBadge summary={sync} />
          </dd>
        </dl>
      </div>

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
