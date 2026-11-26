import type { ScopeKey, SessionRecord, StudentProfile } from '../../types';
import { META_KEYS, metaGet, metaSet, type ExamDatabase } from './db';
import { scopeKey, uuid } from '../util/ids';

/**
 * Session cache for a shared lab machine.
 *
 * Signing out only clears the *active scope pointer*. The session row, the bundles, the
 * answers, the files and the outbox stay, because the next shift must not be able to
 * destroy the previous shift's unsynced work — and because a student who refreshes with the
 * lab offline has to be able to get back into their exam without a server round trip.
 */
export class SessionStore {
  constructor(private readonly db: ExamDatabase) {}

  async save(profile: StudentProfile, token: string, clockSkewMs: number): Promise<SessionRecord> {
    const key = scopeKey(profile.schemaName, profile.studentId);
    const existing = await this.db.sessions.get(key);
    const now = Date.now();
    const record: SessionRecord = {
      scopeKey: key,
      student: profile,
      token,
      loggedInAt: existing?.loggedInAt ?? now,
      lastSeenAt: now,
      clockSkewMs,
    };
    await this.db.sessions.put(record);
    await metaSet(this.db, META_KEYS.activeScope, key);
    return record;
  }

  async get(key: ScopeKey): Promise<SessionRecord | null> {
    return (await this.db.sessions.get(key)) ?? null;
  }

  async activeScopeKey(): Promise<ScopeKey | null> {
    return metaGet<ScopeKey>(this.db, META_KEYS.activeScope);
  }

  async active(): Promise<SessionRecord | null> {
    const key = await this.activeScopeKey();
    return key ? this.get(key) : null;
  }

  async touch(key: ScopeKey): Promise<void> {
    await this.db.sessions.update(key, { lastSeenAt: Date.now() });
  }

  /** Signs out of the UI without touching any exam data. */
  async clearActive(): Promise<void> {
    await metaSet(this.db, META_KEYS.activeScope, null);
  }

  async setActive(key: ScopeKey): Promise<void> {
    await metaSet(this.db, META_KEYS.activeScope, key);
  }

  /** The token is replaced in place when `/me` or a login refresh hands back a new one. */
  async updateToken(key: ScopeKey, token: string): Promise<void> {
    await this.db.sessions.update(key, { token, lastSeenAt: Date.now() });
  }

  async all(): Promise<SessionRecord[]> {
    return this.db.sessions.orderBy('lastSeenAt').reverse().toArray();
  }

  /**
   * Only ever called from the proctor screen, and only when nothing is left to sync for
   * that student (the caller checks).
   */
  async forget(key: ScopeKey): Promise<void> {
    await this.db.sessions.delete(key);
    if ((await this.activeScopeKey()) === key) await this.clearActive();
  }

  /** Stable per browser profile; identifies the lab machine in every submission. */
  async deviceId(): Promise<string> {
    const existing = await metaGet<string>(this.db, META_KEYS.deviceId);
    if (existing) return existing;
    const id = uuid();
    await metaSet(this.db, META_KEYS.deviceId, id);
    return id;
  }
}
