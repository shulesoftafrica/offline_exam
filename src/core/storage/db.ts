import Dexie, { type Table } from 'dexie';
import type {
  AnswerRecord,
  AttemptRecord,
  AuditEvent,
  ExamBundle,
  OutboxItem,
  SessionRecord,
  StoredFileMeta,
} from '../../types';

/**
 * The durable store. Everything a student does offline lands here before the UI says it did.
 *
 * Schema notes
 *  - Compound indexes are declared for every query the app actually runs; a lab machine may
 *    hold several shifts of students, so no query ever scans a whole table.
 *  - `files.bytes` is only populated on the IndexedDB fallback path (see `files.ts`); with
 *    OPFS the bytes live outside IndexedDB and only the metadata row is here. Bytes are
 *    stored as an `ArrayBuffer` rather than a `Blob`: every engine can structured-clone one,
 *    while Blob-in-IndexedDB support has historically been patchy.
 *  - Bumping the version: add a new `.version(n).stores({...}).upgrade(...)` block. Never
 *    rename a store in place — an unsynced attempt from last week must still be readable.
 */

export interface FileRow extends StoredFileMeta {
  /** Only on the `idb` storage backend. */
  bytes?: ArrayBuffer;
}

export interface MetaRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class ExamDatabase extends Dexie {
  sessions!: Table<SessionRecord, string>;
  bundles!: Table<ExamBundle, string>;
  attempts!: Table<AttemptRecord, string>;
  answers!: Table<AnswerRecord, string>;
  files!: Table<FileRow, string>;
  outbox!: Table<OutboxItem, number>;
  events!: Table<AuditEvent, number>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'shulesoft_offline_exams') {
    super(name);

    this.version(1).stores({
      sessions: 'scopeKey, student.studentId, schemaName, lastSeenAt',
      bundles: 'attemptKey, scopeKey, examId, [scopeKey+examId], downloadedAt',
      attempts: 'attemptKey, scopeKey, examId, status, [scopeKey+examId], [scopeKey+status], updatedAt',
      answers: 'id, attemptKey, [attemptKey+questionId], updatedAt',
      files:
        'fileId, attemptKey, [attemptKey+questionId], [attemptKey+role], sha256, uploadState, role',
      outbox:
        '++id, attemptKey, status, stage, nextAttemptAt, idempotencyKey, [status+nextAttemptAt], [attemptKey+status], [attemptKey+stage], scopeKey',
      events: '++id, attemptKey, scopeKey, at, type',
      meta: 'key',
    });
  }
}

/**
 * The app-wide instance. Tests build their own `new ExamDatabase('test-...')`, so nothing
 * here opens a connection at import time beyond Dexie's own lazy handling.
 */
export const db = new ExamDatabase();

export const META_KEYS = {
  activeScope: 'active_scope',
  deviceId: 'device_id',
  lastSyncRunAt: 'last_sync_run_at',
  storageBackend: 'storage_backend',
} as const;

export async function metaGet<T>(database: ExamDatabase, key: string): Promise<T | null> {
  const row = await database.meta.get(key);
  return row ? (row.value as T) : null;
}

export async function metaSet(
  database: ExamDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  await database.meta.put({ key, value, updatedAt: Date.now() });
}

export async function metaDelete(database: ExamDatabase, key: string): Promise<void> {
  await database.meta.delete(key);
}

/**
 * Ask the browser to keep this origin's data even under storage pressure. A lab machine
 * that evicts an unsynced exam is the worst failure this app can have, so this is requested
 * on first boot and its result is reported on the sync screen.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
  persisted: boolean;
}

export async function storageEstimate(): Promise<StorageEstimate> {
  let usageBytes = 0;
  let quotaBytes = 0;
  let persisted = false;
  try {
    const est = await navigator.storage?.estimate?.();
    usageBytes = est?.usage ?? 0;
    quotaBytes = est?.quota ?? 0;
    persisted = (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    /* unsupported: reported as zeros */
  }
  return { usageBytes, quotaBytes, persisted };
}
