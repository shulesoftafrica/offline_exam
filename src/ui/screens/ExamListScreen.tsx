import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExamListState, MergedExamItem, SessionRecord } from '../../types';
import { canStart, stateLabel } from '../../core/examMerge';
import { formatDuration } from '../../core/util/clock';
import { useConnectivity } from '../hooks/useConnectivity';
import { useService } from '../hooks/useService';
import { Banner, EmptyState, StateBadge, Spinner, SyncBadge } from '../components/common';

/**
 * The exam list.
 *
 * Its job is to make three things unmistakable:
 *  1. which exam can be started right now;
 *  2. which exams are already finished (so nobody tries to sit one twice);
 *  3. which answers on this machine have not reached the school yet — including other
 *     students', because a lab machine must not be wiped while work is pending.
 */

const SECTIONS: { heading: string; states: ExamListState[]; note?: string }[] = [
  { heading: 'Continue', states: ['in_progress'], note: 'You started this exam. The clock is still running.' },
  { heading: 'Needs the teacher', states: ['needs_attention'] },
  { heading: 'Start now', states: ['available'], note: 'Download the exam while the internet is still on.' },
  {
    heading: 'Finished — waiting for internet',
    states: ['submitted_offline', 'syncing'],
    note: 'Your answers are safe on this computer. They are sent automatically when the internet is back.',
  },
  { heading: 'Upcoming', states: ['upcoming'] },
  { heading: 'Already taken', states: ['synced', 'completed_past'] },
  { heading: 'Not ready yet', states: ['not_ready'] },
];

export function ExamListScreen({ session }: { session: SessionRecord }): JSX.Element {
  const service = useService();
  const navigate = useNavigate();
  const net = useConnectivity();
  const [items, setItems] = useState<MergedExamItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [othersPending, setOthersPending] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const result = await service.examList(session);
    setItems(result.items);
    setNotice(result.error);
    setOthersPending(await service.pendingForOtherStudents(session.scopeKey));
    setRefreshing(false);
  }, [service, session]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload when the lab comes back online: states and sync badges both change.
  useEffect(() => {
    if (net.reachability === 'online') void load();
  }, [net.reachability, load]);

  if (!items) {
    return (
      <div className="center-screen">
        <Spinner label="Loading your exams…" />
      </div>
    );
  }

  const myPending = items.filter(
    (item) => item.state === 'submitted_offline' || item.state === 'syncing',
  ).length;

  return (
    <div className="stack loose">
      <div className="row between">
        <div>
          <h1 style={{ marginBottom: 0 }}>Your exams</h1>
          <span className="muted">
            {session.student.name}
            {session.student.className ? ` · ${session.student.className}` : ''}
            {session.student.section ? ` ${session.student.section}` : ''}
          </span>
        </div>
        <button type="button" className="btn secondary" disabled={refreshing} onClick={() => void load()}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice ? <Banner tone="warn">{notice}</Banner> : null}

      {myPending > 0 ? (
        <Banner
          tone="info"
          title={`${myPending} finished exam${myPending === 1 ? '' : 's'} on this computer.`}
          action={
            <button type="button" className="btn small" onClick={() => navigate('/sync')}>
              Sync status
            </button>
          }
        >
          They will be sent to the school automatically once the internet is switched back on.
        </Banner>
      ) : null}

      {othersPending > 0 ? (
        <Banner tone="warn" title="Do not switch off this computer.">
          {othersPending} exam{othersPending === 1 ? '' : 's'} from other students on this machine
          still need to be sent to the school.
        </Banner>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title="No exams for you yet">
          When your teacher publishes an online exam for your subjects, it appears here.
        </EmptyState>
      ) : null}

      {SECTIONS.map((section) => {
        const rows = items.filter((item) => section.states.includes(item.state));
        if (rows.length === 0) return null;
        return (
          <section className="exam-group" key={section.heading}>
            <h2>{section.heading}</h2>
            {section.note ? <p className="muted" style={{ margin: 0 }}>{section.note}</p> : null}
            {rows.map((item) => (
              <ExamCard key={`${item.examId}`} item={item} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function ExamCard({ item }: { item: MergedExamItem }): JSX.Element {
  const navigate = useNavigate();
  const { hint } = stateLabel(item.state);
  const startable = canStart(item);
  const questionCount = item.questions || item.local?.questionCount || 0;

  return (
    <article className="card exam-card">
      <div className="title-row">
        <h3>{item.title}</h3>
        <StateBadge state={item.state} />
        {/* The sync badge only adds something while the queue is still working; once it is
            sent, the state badge already says so. */}
        {item.syncSummary && item.syncSummary.state !== 'synced' ? (
          <SyncBadge summary={item.syncSummary} />
        ) : null}
      </div>

      <div className="facts">
        {item.subject ? <span>{item.subject}</span> : null}
        <span>
          {questionCount} {questionCount === 1 ? 'question' : 'questions'}
        </span>
        <span>{item.minutes} minutes</span>
        {item.date ? <span>{item.date}</span> : null}
        {item.state === 'in_progress' && item.secondsLeft !== null ? (
          <span>
            <strong>{formatDuration(item.secondsLeft)} left</strong>
          </span>
        ) : null}
        {item.score !== null && item.total !== null ? (
          <span>
            <strong>
              {item.score} / {item.total}
            </strong>
          </span>
        ) : null}
      </div>

      <p className="hint">{hint}</p>

      {item.local?.lastSyncError && item.state === 'needs_attention' ? (
        <Banner tone="danger" title="Could not send:">
          {item.local.lastSyncError}
        </Banner>
      ) : null}

      <div className="actions">
        {startable ? (
          <button
            type="button"
            className="btn"
            onClick={() => navigate(`/exam/${item.examId}`)}
          >
            {item.state === 'in_progress' ? 'Continue exam' : 'Start exam'}
          </button>
        ) : null}

        {item.state === 'submitted_offline' || item.state === 'syncing' || item.state === 'needs_attention' ? (
          <button type="button" className="btn secondary" onClick={() => navigate('/sync')}>
            View sync status
          </button>
        ) : null}

        {item.state === 'completed_past' || item.state === 'synced' ? (
          <span className="muted">Nothing to do.</span>
        ) : null}
      </div>
    </article>
  );
}
