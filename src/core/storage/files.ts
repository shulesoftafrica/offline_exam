import type { AttemptKey, FileRole, StoredFileMeta } from '../../types';
import { sha256OfBlob, sha256OfString } from '../util/checksum';
import { uuid } from '../util/ids';
import { log } from '../util/logger';
import type { ExamDatabase, FileRow } from './db';

/**
 * Student uploads and question media.
 *
 * Two backends behind one API:
 *
 *  1. **OPFS** (`navigator.storage.getDirectory()`): bytes live in the Origin Private File
 *     System, outside IndexedDB, so a 9 MB photo never becomes part of a JSON answer row.
 *     Files are written with `createWritable()`, which is what Chromium labs have.
 *  2. **IndexedDB bytes**: identical API, bytes in the `files.bytes` column as an
 *     `ArrayBuffer` (universally structured-cloneable, unlike a `Blob`). Used wherever OPFS
 *     or writable streams are missing. Everything else in the app is indifferent.
 *
 * Both paths compute a SHA-256 at save time. That digest is the attachment's idempotency
 * key on sync, so a retried upload can never create a duplicate server-side.
 */

export type StorageBackend = 'opfs' | 'idb';

export interface SaveFileInput {
  attemptKey: AttemptKey;
  questionId: number;
  role: FileRole;
  name: string;
  blob: Blob;
  /** Override the detected mime type (e.g. a camera capture with an empty type). */
  mimeType?: string;
}

export interface FileValidationRules {
  maxFileBytes: number;
  allowedMime: string[];
}

export type FileValidation = { ok: true } | { ok: false; reason: string };

/** Local gate, run before a byte is written — the student finds out now, not at sync time. */
export function validateFile(
  file: { name: string; size: number; type: string },
  rules: FileValidationRules,
): FileValidation {
  if (file.size <= 0) {
    return { ok: false, reason: 'That file is empty.' };
  }
  if (file.size > rules.maxFileBytes) {
    const mb = (rules.maxFileBytes / (1024 * 1024)).toFixed(0);
    return { ok: false, reason: `That file is larger than the ${mb} MB limit for this exam.` };
  }
  if (rules.allowedMime.length > 0) {
    const type = (file.type || guessMime(file.name)).toLowerCase();
    const allowed = rules.allowedMime.some((m) => {
      const pattern = m.toLowerCase().trim();
      return pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern;
    });
    if (!allowed) {
      return {
        ok: false,
        reason: `This exam accepts ${rules.allowedMime.join(', ')} only.`,
      };
    }
  }
  return { ok: true };
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    gif: 'image/gif',
    pdf: 'application/pdf',
    txt: 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

function extensionOf(name: string, mimeType: string): string {
  const fromName = name.includes('.') ? name.split('.').pop() : null;
  if (fromName && /^[a-z0-9]{1,5}$/i.test(fromName)) return `.${fromName.toLowerCase()}`;
  const fromMime = mimeType.split('/')[1];
  return fromMime ? `.${fromMime.split(';')[0]}` : '';
}

/**
 * Minimal structural types for the File System Access API. Declared locally rather than
 * leaning on the DOM lib, whose OPFS definitions differ between TypeScript releases.
 */
interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  getFile(): Promise<File>;
  createWritable?: () => Promise<WritableLike>;
}

interface DirHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface OpfsHandles {
  root: DirHandleLike;
}

export class FileStore {
  private backend: StorageBackend | null = null;
  private opfs: OpfsHandles | null = null;

  constructor(private readonly db: ExamDatabase) {}

  /** Resolved once per page session; the result is also shown on the proctor screen. */
  async detectBackend(): Promise<StorageBackend> {
    if (this.backend) return this.backend;
    try {
      const storage = navigator.storage as
        | (StorageManager & { getDirectory?: () => Promise<DirHandleLike> })
        | undefined;
      if (storage?.getDirectory) {
        const root = await storage.getDirectory();
        // Writable streams are the part that is actually missing on some platforms.
        const probe = await root.getFileHandle('.probe', { create: true });
        if (typeof probe.createWritable === 'function') {
          const w = await probe.createWritable();
          await w.write(new Blob([new Uint8Array([1])]));
          await w.close();
          await root.removeEntry('.probe').catch(() => undefined);
          this.opfs = { root };
          this.backend = 'opfs';
          log.info('File store: using OPFS');
          return this.backend;
        }
      }
    } catch (error) {
      log.warn('File store: OPFS unavailable, falling back to IndexedDB blobs', error);
    }
    this.backend = 'idb';
    log.info('File store: using IndexedDB blobs');
    return this.backend;
  }

  private async directoryFor(attemptKey: AttemptKey): Promise<DirHandleLike> {
    if (!this.opfs) throw new Error('OPFS not initialised');
    const attempts = await this.opfs.root.getDirectoryHandle('attempts', { create: true });
    // Hashed so a schema name with odd characters can never produce an invalid path.
    const folder = (await sha256OfString(attemptKey)).slice(0, 32);
    return attempts.getDirectoryHandle(folder, { create: true });
  }

  async save(input: SaveFileInput): Promise<StoredFileMeta> {
    const backend = await this.detectBackend();
    const mimeType = input.mimeType || input.blob.type || guessMime(input.name);
    const fileId = uuid();
    const sha256 = await sha256OfBlob(input.blob);
    const fileName = `${fileId}${extensionOf(input.name, mimeType)}`;

    const meta: StoredFileMeta = {
      fileId,
      attemptKey: input.attemptKey,
      questionId: input.questionId,
      role: input.role,
      name: input.name,
      mimeType,
      size: input.blob.size,
      sha256,
      storage: backend,
      path: null,
      createdAt: Date.now(),
      uploadState: 'local',
      serverPath: null,
    };

    if (backend === 'opfs') {
      const dir = await this.directoryFor(input.attemptKey);
      const handle = await dir.getFileHandle(fileName, { create: true });
      if (!handle.createWritable) throw new Error('OPFS writable streams unavailable');
      const writable = await handle.createWritable();
      try {
        await writable.write(input.blob);
      } finally {
        await writable.close();
      }
      meta.path = fileName;
      await this.db.files.put({ ...meta });
    } else {
      const row: FileRow = { ...meta, bytes: await input.blob.arrayBuffer() };
      await this.db.files.put(row);
    }

    return meta;
  }

  async meta(fileId: string): Promise<StoredFileMeta | null> {
    const row = await this.db.files.get(fileId);
    if (!row) return null;
    const { bytes: _bytes, ...meta } = row;
    return meta;
  }

  async read(fileId: string): Promise<Blob | null> {
    const row = await this.db.files.get(fileId);
    if (!row) return null;
    if (row.storage === 'idb') {
      return row.bytes ? new Blob([row.bytes], { type: row.mimeType }) : null;
    }
    try {
      const dir = await this.directoryFor(row.attemptKey);
      const handle = await dir.getFileHandle(row.path ?? '', { create: false });
      return await handle.getFile();
    } catch (error) {
      log.error('File store: could not read OPFS file', { fileId, error });
      return null;
    }
  }

  async listForQuestion(attemptKey: AttemptKey, questionId: number): Promise<StoredFileMeta[]> {
    const rows = await this.db.files
      .where('[attemptKey+questionId]')
      .equals([attemptKey, questionId])
      .toArray();
    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ bytes: _bytes, ...meta }) => meta);
  }

  async listForAttempt(attemptKey: AttemptKey, role?: FileRole): Promise<StoredFileMeta[]> {
    const rows = role
      ? await this.db.files.where('[attemptKey+role]').equals([attemptKey, role]).toArray()
      : await this.db.files.where('attemptKey').equals(attemptKey).toArray();
    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ bytes: _bytes, ...meta }) => meta);
  }

  async setUploadState(
    fileId: string,
    uploadState: StoredFileMeta['uploadState'],
    serverPath?: string | null,
  ): Promise<void> {
    const patch: Partial<FileRow> = { uploadState };
    if (serverPath !== undefined) patch.serverPath = serverPath;
    await this.db.files.update(fileId, patch);
  }

  async remove(fileId: string): Promise<void> {
    const row = await this.db.files.get(fileId);
    if (!row) return;
    if (row.storage === 'opfs' && row.path) {
      try {
        const dir = await this.directoryFor(row.attemptKey);
        await dir.removeEntry(row.path);
      } catch (error) {
        log.warn('File store: could not delete OPFS file', { fileId, error });
      }
    }
    await this.db.files.delete(fileId);
  }

  /**
   * Called only after an attempt is fully synced (or by the proctor's explicit cleanup), so
   * that a machine can be reclaimed at the end of a term without losing pending work.
   */
  async removeForAttempt(attemptKey: AttemptKey): Promise<number> {
    const rows = await this.db.files.where('attemptKey').equals(attemptKey).toArray();
    for (const row of rows) await this.remove(row.fileId);
    return rows.length;
  }

  async totalBytes(): Promise<number> {
    let total = 0;
    await this.db.files.each((row) => {
      total += row.size;
    });
    return total;
  }
}
