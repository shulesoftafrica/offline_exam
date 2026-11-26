import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxItem, OutboxItemType } from '../../types';
import { ExamDatabase } from './db';
import { OutboxStore, selectDueItems, summarise } from './outbox';
import { attemptKey, scopeKey } from '../util/ids';

/**
 * The queue's scheduling rules. These are the guarantees the backend relies on: answers
 * before files, finalize last, nothing stepping over a flagged item.
 */

let db: ExamDatabase;
let outbox: OutboxStore;
let counter = 0;

const KEY_A = attemptKey('demo', 4812, 91);
const KEY_B = attemptKey('demo', 4813, 91);

function base(type: OutboxItemType, key = KEY_A) {
  const studentId = key === KEY_A ? 4812 : 4813;
  return {
    attemptKey: key,
    scopeKey: scopeKey('demo', studentId),
    schemaName: 'demo',
    studentId,
    examId: 91,
    attemptId: studentId,
    submissionUuid: `uuid-${studentId}`,
    type,
    idempotencyKey: `${type}:${studentId}:${Math.random()}`,
  };
}

/** A plain item, outside the database, for the pure selection tests. */
function item(partial: Partial<OutboxItem> & { id: number; type: OutboxItemType }): OutboxItem {
  const stage = { submission: 0, attachment: 1, finalize: 2 }[partial.type];
  return {
    attemptKey: KEY_A,
    scopeKey: scopeKey('demo', 4812),
    schemaName: 'demo',
    studentId: 4812,
    examId: 91,
    attemptId: 551,
    submissionUuid: 'uuid',
    stage,
    idempotencyKey: `k-${partial.id}`,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    lastHttpStatus: null,
    createdAt: partial.id,
    updatedAt: partial.id,
    fileId: null,
    questionId: null,
    ...partial,
  };
}

beforeEach(async () => {
  counter += 1;
  db = new ExamDatabase(`test_outbox_${counter}`);
  await db.open();
  outbox = new OutboxStore(db);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('enqueueing', () => {
  it('is idempotent on the idempotency key', async () => {
    const input = { ...base('submission'), idempotencyKey: 'attempt:551:uuid-1' };

    const first = await outbox.enqueue(input);
    const second = await outbox.enqueue(input);

    expect(second.id).toBe(first.id);
    expect(await outbox.forAttempt(KEY_A)).toHaveLength(1);
  });

  it('assigns the right stage per type', async () => {
    await outbox.enqueue(base('finalize'));
    await outbox.enqueue(base('submission'));
    await outbox.enqueue(base('attachment'));

    const items = await outbox.forAttempt(KEY_A);
    expect(items.map((i) => i.type)).toEqual(['submission', 'attachment', 'finalize']);
    expect(items.map((i) => i.stage)).toEqual([0, 1, 2]);
  });

  it('starts queued, due immediately, with no attempts', async () => {
    const queued = await outbox.enqueue(base('submission'));
    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBe(0);
    expect(queued.nextAttemptAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('state transitions', () => {
  it('queued → uploading → synced', async () => {
    const queued = await outbox.enqueue(base('submission'));
    const id = queued.id as number;

    await outbox.markUploading(id);
    expect((await outbox.get(id))?.status).toBe('uploading');

    await outbox.markSynced(id, 200);
    const synced = await outbox.get(id);
    expect(synced?.status).toBe('synced');
    expect(synced?.lastHttpStatus).toBe(200);
    expect(synced?.lastError).toBeNull();
  });

  it('queued → retry keeps the error and the next attempt time', async () => {
    const queued = await outbox.enqueue(base('submission'));
    const id = queued.id as number;
    const when = Date.now() + 8_000;

    await outbox.markRetry(id, 2, when, 'The server is busy.', 503);

    const retried = await outbox.get(id);
    expect(retried?.status).toBe('queued');
    expect(retried?.attempts).toBe(2);
    expect(retried?.nextAttemptAt).toBe(when);
    expect(retried?.lastError).toBe('The server is busy.');
  });

  it('needs_attention is recoverable by the proctor', async () => {
    const queued = await outbox.enqueue(base('submission'));
    const id = queued.id as number;

    await outbox.markNeedsAttention(id, 10, 'Rejected: HTTP 422', 422);
    expect((await outbox.get(id))?.status).toBe('needs_attention');

    const requeued = await outbox.requeueAllNeedingAttention();
    expect(requeued).toBe(1);

    const back = await outbox.get(id);
    expect(back?.status).toBe('queued');
    expect(back?.attempts).toBe(0);
  });

  it('summarises per attempt and machine-wide', async () => {
    const a = await outbox.enqueue(base('submission', KEY_A));
    await outbox.enqueue(base('finalize', KEY_A));
    await outbox.enqueue(base('submission', KEY_B));
    await outbox.markSynced(a.id as number, 200);

    const forA = await outbox.summaryFor(KEY_A);
    expect(forA).toMatchObject({ synced: 1, queued: 1, total: 2, state: 'queued' });

    const all = await outbox.summaryAll();
    expect(all.total).toBe(3);
  });
});

describe('selectDueItems', () => {
  const NOW = 1_000_000;

  it('sends the submission before any attachment or finalize', () => {
    const due = selectDueItems(
      [item({ id: 3, type: 'finalize' }), item({ id: 2, type: 'attachment' }), item({ id: 1, type: 'submission' })],
      NOW,
    );

    expect(due.map((i) => i.type)).toEqual(['submission']);
  });

  it('sends attachments only once the submission is acknowledged', () => {
    const items = [
      item({ id: 1, type: 'submission', status: 'synced' }),
      item({ id: 2, type: 'attachment' }),
      item({ id: 3, type: 'attachment' }),
      item({ id: 4, type: 'finalize' }),
    ];

    const due = selectDueItems(items, NOW);

    expect(due.map((i) => i.id)).toEqual([2, 3]);
  });

  it('finalizes only when every attachment is acknowledged', () => {
    const partly = [
      item({ id: 1, type: 'submission', status: 'synced' }),
      item({ id: 2, type: 'attachment', status: 'synced' }),
      item({ id: 3, type: 'attachment' }),
      item({ id: 4, type: 'finalize' }),
    ];
    expect(selectDueItems(partly, NOW).map((i) => i.id)).toEqual([3]);

    const ready = partly.map((i) => (i.type === 'attachment' ? { ...i, status: 'synced' as const } : i));
    expect(selectDueItems(ready, NOW).map((i) => i.id)).toEqual([4]);
  });

  it('respects the backoff window', () => {
    const items = [item({ id: 1, type: 'submission', nextAttemptAt: NOW + 5_000 })];

    expect(selectDueItems(items, NOW)).toHaveLength(0);
    expect(selectDueItems(items, NOW + 5_000)).toHaveLength(1);
  });

  it('parks an attempt that has a flagged item instead of finalising a partial submission', () => {
    const items = [
      item({ id: 1, type: 'submission', status: 'synced' }),
      item({ id: 2, type: 'attachment', status: 'needs_attention' }),
      item({ id: 3, type: 'attachment' }),
      item({ id: 4, type: 'finalize' }),
    ];

    expect(selectDueItems(items, NOW)).toHaveLength(0);
  });

  it('does not let one stuck attempt block another student on the same machine', () => {
    const other = (id: number, type: OutboxItemType, status: OutboxItem['status'] = 'queued') => ({
      ...item({ id, type, status }),
      attemptKey: KEY_B,
      attemptId: 552,
      studentId: 4813,
    });

    const items = [
      item({ id: 1, type: 'submission', status: 'needs_attention' }),
      other(2, 'submission'),
    ];

    const due = selectDueItems(items, NOW);
    expect(due.map((i) => i.id)).toEqual([2]);
  });

  it('caps the batch size but keeps FIFO order', () => {
    const items = [
      item({ id: 1, type: 'submission', status: 'synced' }),
      ...[2, 3, 4, 5, 6, 7].map((id) => item({ id, type: 'attachment' })),
    ];

    const due = selectDueItems(items, NOW, 3);
    expect(due.map((i) => i.id)).toEqual([2, 3, 4]);
  });

  it('returns nothing when everything is synced', () => {
    const items = [
      item({ id: 1, type: 'submission', status: 'synced' }),
      item({ id: 2, type: 'finalize', status: 'synced' }),
    ];
    expect(selectDueItems(items, NOW)).toHaveLength(0);
    expect(summarise(items).state).toBe('synced');
  });
});
