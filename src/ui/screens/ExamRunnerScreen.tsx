import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  AnswerRecord,
  AttemptRecord,
  ExamBundle,
  Question,
  QuestionGroup,
  SessionRecord,
  StoredFileMeta,
} from '../../types';
import { flattenQuestions, groupQuestions, isQuestionGroup } from '../../core/exam/bundle';
import { formatDuration } from '../../core/util/clock';
import { useConnectivity } from '../hooks/useConnectivity';
import { useExamTimer } from '../hooks/useExamTimer';
import { useService } from '../hooks/useService';
import { QuestionView } from '../components/QuestionView';
import { Banner, Dialog, NetPill, Spinner, Timer } from '../components/common';

/**
 * The offline exam runner.
 *
 * Invariants it holds:
 *  - every answer is in IndexedDB before the UI says "Saved";
 *  - the countdown survives refreshes, crashes and clock changes (see `core/timer`);
 *  - when time runs out, input locks and the attempt submits itself exactly once;
 *  - submitting works with the network physically off, and says so plainly.
 */
export function ExamRunnerScreen({ session }: { session: SessionRecord }): JSX.Element {
  const service = useService();
  const navigate = useNavigate();
  const net = useConnectivity();
  const params = useParams<{ examId: string }>();
  const examId = Number(params.examId);
  const attemptKey = service.attemptKeyFor(session.student, examId);

  const [bundle, setBundle] = useState<ExamBundle | null>(null);
  const [attempt, setAttempt] = useState<AttemptRecord | null>(null);
  const [answers, setAnswers] = useState<Map<number, AnswerRecord>>(new Map());
  const [files, setFiles] = useState<StoredFileMeta[]>([]);
  const [index, setIndex] = useState(0);
  const [flagged, setFlagged] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const autoSubmitted = useRef(false);

  // ── Load / resume ───────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    const loaded = await service.loadRunner(attemptKey);
    if (!loaded) {
      setLoadError('This exam is not downloaded on this computer.');
      return;
    }
    setBundle(loaded.bundle);
    setAttempt(loaded.attempt);
    setAnswers(new Map(loaded.answers.map((a) => [a.questionId, a])));
    setFiles(loaded.files);
  }, [attemptKey, service]);

  useEffect(() => {
    void (async () => {
      // `beginAttempt` re-anchors the clock for this page session, accounting for any time
      // the machine spent switched off.
      await service.beginAttempt(attemptKey).catch(() => undefined);
      await reload();
    })();
  }, [attemptKey, reload, service]);

  const items = useMemo<(Question | QuestionGroup)[]>(
    () => (bundle ? groupQuestions(bundle.questions) : []),
    [bundle],
  );
  const flatQuestions = useMemo(() => flattenQuestions(items), [items]);

  const locked = attempt !== null && attempt.status !== 'in_progress';

  // ── Submission ──────────────────────────────────────────────────────────
  const doSubmit = useCallback(
    async (auto: boolean) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await service.submit(attemptKey, { auto });
        navigate(`/exam/${examId}/done`, { replace: true });
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : 'The exam could not be submitted on this computer.',
        );
      } finally {
        setSubmitting(false);
        setConfirming(false);
      }
    },
    [attemptKey, examId, navigate, service, submitting],
  );

  const onExpire = useCallback(() => {
    if (autoSubmitted.current) return;
    autoSubmitted.current = true;
    void doSubmit(true);
  }, [doSubmit]);

  const { timer, secondsLeft, expired } = useExamTimer(
    locked ? null : attemptKey,
    attempt?.timer ?? null,
    onExpire,
  );

  if (loadError) {
    return (
      <div className="stack">
        <Banner tone="danger" title={loadError}>
          Tell the invigilator. If the internet is on, go back and download the exam again.
        </Banner>
        <button type="button" className="btn" onClick={() => navigate('/exams')}>
          Back to my exams
        </button>
      </div>
    );
  }

  if (!bundle || !attempt) {
    return (
      <div className="center-screen">
        <Spinner label="Opening your exam…" />
      </div>
    );
  }

  const current = items[index];
  const answeredIds = new Set(answers.keys());
  const answeredCount = flatQuestions.filter((q) => answeredIds.has(q.questionId)).length;
  const unanswered = flatQuestions.length - answeredCount;

  function toggleFlag(questionId: number): void {
    setFlagged((previous) => {
      const next = new Set(previous);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }

  return (
    <div className="stack">
      <div className="card flat row between" style={{ position: 'sticky', top: 60, zIndex: 10 }}>
        <div className="row" style={{ gap: '0.75rem' }}>
          <strong>{bundle.exam.title}</strong>
          <span className="muted">
            {answeredCount} of {flatQuestions.length} answered
          </span>
        </div>
        <div className="row" style={{ gap: '0.5rem' }}>
          <NetPill state={net} examInProgress={!locked} />
          <Timer secondsLeft={secondsLeft} totalSeconds={timer?.durationSeconds ?? 0} />
        </div>
      </div>

      {secondsLeft <= 300 && secondsLeft > 0 && !locked ? (
        <Banner tone={secondsLeft <= 60 ? 'danger' : 'warn'} title={`${formatDuration(secondsLeft)} left.`}>
          Finish up and press <strong>Submit exam</strong>. If the time runs out, the exam submits
          itself with whatever you have answered.
        </Banner>
      ) : null}

      {expired || locked ? (
        <Banner tone="warn" title="This exam is closed.">
          You can no longer change your answers.
        </Banner>
      ) : null}

      <div className="runner">
        <nav className="navigator card" aria-label="Questions">
          <strong>Questions</strong>
          <div className="grid">
            {items.map((item, itemIndex) => {
              const first = isQuestionGroup(item) ? item.parts[0] : item;
              const ids = isQuestionGroup(item) ? item.parts.map((p) => p.questionId) : [item.questionId];
              const done = ids.every((id) => answeredIds.has(id));
              const isFlagged = ids.some((id) => flagged.has(id));
              return (
                <button
                  type="button"
                  key={first?.questionId ?? itemIndex}
                  className={`qbtn ${done ? 'answered' : ''} ${isFlagged ? 'flagged' : ''}`}
                  aria-current={itemIndex === index}
                  aria-label={`Question ${first?.number ?? itemIndex + 1}${done ? ', answered' : ', not answered'}`}
                  onClick={() => setIndex(itemIndex)}
                >
                  {isQuestionGroup(item)
                    ? (first?.number.replace(/[a-z]$/i, '') ?? itemIndex + 1)
                    : (first?.number ?? itemIndex + 1)}
                </button>
              );
            })}
          </div>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            Green = answered. Amber = you marked it to come back to.
          </span>
        </nav>

        <div className="card">
          {current ? (
            <QuestionView
              attemptKey={attemptKey}
              item={current}
              answers={answers}
              files={files}
              mediaFileIds={bundle.mediaFileIds}
              rules={bundle.attachmentRules}
              locked={locked || expired}
              onAnswerChanged={() => void reload()}
            />
          ) : (
            <p>This exam has no questions.</p>
          )}
        </div>
      </div>

      <div className="runner-footer">
        <button
          type="button"
          className="btn secondary"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          ← Previous
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={index >= items.length - 1}
          onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
        >
          Next →
        </button>
        {current && !locked ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              const first = isQuestionGroup(current) ? current.parts[0] : current;
              if (first) toggleFlag(first.questionId);
            }}
          >
            Mark to come back
          </button>
        ) : null}
        <span className="spacer" style={{ flex: '1 1 auto' }} />
        {!locked ? (
          <button type="button" className="btn big" disabled={submitting} onClick={() => setConfirming(true)}>
            Submit exam
          </button>
        ) : (
          <button type="button" className="btn big" onClick={() => navigate(`/exam/${examId}/done`)}>
            See my confirmation
          </button>
        )}
      </div>

      {confirming ? (
        <Dialog title="Submit this exam?" onClose={() => setConfirming(false)} closable={!submitting}>
          <p>
            You have answered <strong>{answeredCount}</strong> of {flatQuestions.length} questions.
            {unanswered > 0 ? ` ${unanswered} question(s) are still empty.` : ''}
          </p>
          <p>
            Your answers are stored on this computer. They are sent to the school automatically
            when the internet is switched back on — you do not need to wait for that.
          </p>
          <p className="muted">After you submit you cannot change your answers.</p>
          <div className="row end">
            <button
              type="button"
              className="btn secondary"
              disabled={submitting}
              onClick={() => setConfirming(false)}
            >
              Keep working
            </button>
            <button type="button" className="btn" disabled={submitting} onClick={() => void doSubmit(false)}>
              {submitting ? <Spinner label="Saving…" /> : 'Yes, submit my exam'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
