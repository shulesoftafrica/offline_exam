import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AttemptRecord, OutboxItem, SyncSummary } from '../../types';
import type { StorageEstimate } from '../../core/storage/db';
import type { StorageBackend } from '../../core/storage/files';
import { config } from '../../core/config';
import { formatBytes, formatDateTime } from '../../core/util/clock';
import { useConnectivity, useSyncProgress } from '../hooks/useConnectivity';
import { useService } from '../hooks/useService';
import { Banner, NetPill, ProgressBar, Spinner, SyncBadge } from '../components/common';

/**
 * The proctor / ICT screen: everything on this machine, for every student, and the controls
 * to push it to the school.
 *
 * This is what gets looked at after the lab's internet comes back on, and what an ICT
 * officer opens when something is wrong. It therefore shows per-attempt and per-item state,
 * the real reason for any failure, and a diagnostics export.
 */
type Row = AttemptRecord & { sync: SyncSummary; studentName: string | null; examTitle: string | null };

export function SyncCenterScreen(): JSX.Element {
  const service = useService();
  const navigate = useNavigate();
  const net = useConnectivity();
  const progress = useSyncProgress();

  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [backend, setBackend] = useState<StorageBackend | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const status = await service.machineStatus();
    setRows(status.attempts);
    setSummary(status.summary);
    setStorage(status.storage);
    setBackend(status.backend);
    setDeviceId(status.deviceId);
    setOutbox(await service.outbox.all());
  }, [service]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(poll);
  }, [load]);

  const syncNow = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const { reachable, result } = await service.syncNow();
    if (!reachable) {
      setNotice('Still no connection to the school server. Nothing was sent.');
    } else if (result) {
      setNotice(
        `Sent ${result.synced} item(s). ${result.retried} will be retried, ${result.flagged} need attention.`,
      );
    } else {
      setNotice('Nothing is waiting to be sent.');
    }
    await load();
    setBusy(false);
  }, [load, service]);

  const retryFlagged = useCallback(async () => {
    setBusy(true);
    await service.retryFlagged();
    await load();
    setBusy(false);
  }, [load, service]);

  const exportDiagnostics = useCallback(async () => {
    const json = await service.exportDiagnostics();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `exam-diagnostics-${deviceId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [deviceId, service]);

  const pending = rows.filter((row) => row.status !== 'synced' && row.submittedAt !== null);

  return (
    <div className="stack loose">
      <div className="row between">
        <h1 style={{ marginBottom: 0 }}>Sync status for this computer</h1>
        <NetPill state={net} />
      </div>

      {outbox.some(
        (item) =>
          item.status === 'needs_attention' &&
          (item.lastHttpStatus === 401 || item.lastHttpStatus === 403),
      ) ? (
        <Banner
          tone="warn"
          title="A student's sign-in on this computer has expired."
          action={
            <button
              type="button"
              className="btn small"
              onClick={() => {
                // Signing out only clears who the screen is for; every student's exam data
                // and queue on this machine is untouched.
                void service.logout().then(() => navigate('/'));
              }}
            >
              Open sign-in
            </button>
          }
        >
          Their answers are safe. Ask that student to sign in again on this machine and the
          exam will be sent by itself.
        </Banner>
      ) : null}

      {summary && summary.needsAttention > 0 ? (
        <Banner tone="danger" title={`${summary.needsAttention} item(s) could not be sent.`}>
          The answers are still safe on this computer. Press <strong>Retry failed</strong> once the
          internet is working, or export the diagnostics for the ICT officer.
        </Banner>
      ) : null}

      {pending.length === 0 && summary && summary.total > 0 ? (
        <Banner tone="ok" title="Everything on this computer has reached the school.">
          It is safe to shut this machine down.
        </Banner>
      ) : null}

      {pending.length > 0 ? (
        <Banner tone="warn" title={`${pending.length} submitted exam(s) have not reached the school yet.`}>
          Leave this machine on and connected until this list is empty.
        </Banner>
      ) : null}

      <div className="card stack tight">
        <div className="row">
          <button type="button" className="btn" disabled={busy || progress.running} onClick={() => void syncNow()}>
            {busy || progress.running ? <Spinner label="Syncing…" /> : 'Sync now'}
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={busy || !summary || summary.needsAttention === 0}
            onClick={() => void retryFlagged()}
          >
            Retry failed
          </button>
          <button type="button" className="btn secondary" onClick={() => void exportDiagnostics()}>
            Export diagnostics
          </button>
          <button type="button" className="btn ghost" onClick={() => navigate('/exams')}>
            Back to exams
          </button>
        </div>

        {progress.running && progress.totalBytes > 0 ? (
          <div className="stack tight">
            <ProgressBar
              ratio={progress.uploadedBytes / progress.totalBytes}
              label="Uploading an answer file"
            />
            <span className="muted">
              Uploading {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)}
            </span>
          </div>
        ) : null}

        {notice ? <span className="muted">{notice}</span> : null}
        {progress.lastError ? <Banner tone="warn" title="Last error:">{progress.lastError}</Banner> : null}
      </div>

      <section className="stack tight">
        <h2>Exams on this computer</h2>
        {rows.length === 0 ? (
          <p className="muted">Nothing has been downloaded on this machine yet.</p>
        ) : (
          <div className="card table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Exam</th>
                  <th>State</th>
                  <th>Answers</th>
                  <th>Submitted</th>
                  <th>Sending</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.attemptKey}>
                    <td>
                      {row.studentName ?? `#${row.studentId}`}
                      <br />
                      <span className="muted mono" style={{ fontSize: '0.8rem' }}>
                        {row.schemaName}
                      </span>
                    </td>
                    <td>
                      {row.examTitle ?? `#${row.examId}`}
                      <br />
                      <span className="muted" style={{ fontSize: '0.8rem' }}>
                        attempt {row.attemptId}
                      </span>
                    </td>
                    <td>{row.status.replace(/_/g, ' ')}</td>
                    <td>
                      {row.answeredCount} / {row.questionCount}
                    </td>
                    <td>{row.submittedAt ? formatDateTime(row.submittedAt) : '—'}</td>
                    <td>
                      <SyncBadge summary={row.sync} />
                      {row.lastSyncError ? (
                        <>
                          <br />
                          <span className="muted" style={{ fontSize: '0.8rem' }}>
                            {row.lastSyncError}
                          </span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack tight">
        <h2>Queue</h2>
        {outbox.length === 0 ? (
          <p className="muted">The queue is empty.</p>
        ) : (
          <div className="card table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>What</th>
                  <th>Attempt</th>
                  <th>Status</th>
                  <th>Tries</th>
                  <th>Next try</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {outbox.map((item) => (
                  <tr key={item.id ?? item.idempotencyKey}>
                    <td>{item.id}</td>
                    <td>{item.type}</td>
                    <td className="mono" style={{ fontSize: '0.8rem' }}>
                      {item.attemptId}
                    </td>
                    <td>{item.status.replace(/_/g, ' ')}</td>
                    <td>{item.attempts}</td>
                    <td>
                      {item.status === 'queued' && item.nextAttemptAt > Date.now()
                        ? formatDateTime(item.nextAttemptAt)
                        : '—'}
                    </td>
                    <td>
                      {item.lastHttpStatus ? `HTTP ${item.lastHttpStatus} · ` : ''}
                      {item.lastError ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack tight">
        <h2>This machine</h2>
        <dl className="kv">
          <dt>Machine id</dt>
          <dd className="mono">{deviceId}</dd>
          <dt>File storage</dt>
          <dd>{backend === 'opfs' ? 'OPFS (fast, outside the database)' : 'IndexedDB blobs (fallback)'}</dd>
          <dt>Storage used</dt>
          <dd>
            {storage ? `${formatBytes(storage.usageBytes)} of ${formatBytes(storage.quotaBytes)}` : '—'}
            {storage?.persisted ? ' · protected from automatic clearing' : ' · not protected'}
          </dd>
          <dt>Backend</dt>
          <dd className="mono">
            {config.apiDriver} · {config.apiBaseUrl}
          </dd>
          <dt>Last sync run</dt>
          <dd>{progress.lastRunAt ? formatDateTime(progress.lastRunAt) : 'not yet'}</dd>
          <dt>Last connectivity check</dt>
          <dd>{net.lastProbeAt ? formatDateTime(net.lastProbeAt) : 'not yet'}</dd>
        </dl>
        {storage && !storage.persisted ? (
          <Banner tone="warn" title="This browser has not granted persistent storage.">
            Exam data is still saved, but the browser could clear it under heavy disk pressure.
            Open the app once with the internet on and keep the lab machines on the same browser
            profile.
          </Banner>
        ) : null}
      </section>
    </div>
  );
}
