import type { AttemptKey, AuditEvent, ScopeKey } from '../../types';
import type { ExamDatabase } from './db';
import { describeError } from '../util/logger';

/**
 * Append-only audit trail. This is what lets an ICT officer answer "what happened on
 * machine 12 at 09:40?" after the fact, with no network and no console open.
 *
 * Kept deliberately small: a bounded ring (oldest rows trimmed) so a machine left running
 * for a term cannot fill its quota with log lines instead of exam answers.
 */
const MAX_EVENTS = 2_000;
const TRIM_TO = 1_500;

export class EventLog {
  constructor(private readonly db: ExamDatabase) {}

  async record(
    type: string,
    detail?: unknown,
    keys?: { attemptKey?: AttemptKey | null; scopeKey?: ScopeKey | null },
  ): Promise<void> {
    const event: AuditEvent = {
      attemptKey: keys?.attemptKey ?? null,
      scopeKey: keys?.scopeKey ?? null,
      at: Date.now(),
      type,
      detail: detail === undefined ? null : stringify(detail),
    };
    try {
      await this.db.events.add(event);
      await this.trim();
    } catch {
      /* the audit trail is never allowed to break the exam */
    }
  }

  private async trim(): Promise<void> {
    const count = await this.db.events.count();
    if (count <= MAX_EVENTS) return;
    const excess = count - TRIM_TO;
    const oldest = await this.db.events.orderBy('at').limit(excess).primaryKeys();
    await this.db.events.bulkDelete(oldest);
  }

  async recent(limit = 200): Promise<AuditEvent[]> {
    return this.db.events.orderBy('at').reverse().limit(limit).toArray();
  }

  async forAttempt(attemptKey: AttemptKey, limit = 100): Promise<AuditEvent[]> {
    return this.db.events
      .where('attemptKey')
      .equals(attemptKey)
      .reverse()
      .limit(limit)
      .toArray();
  }
}

function stringify(detail: unknown): string {
  if (typeof detail === 'string') return detail.slice(0, 2_000);
  if (detail instanceof Error) return describeError(detail);
  try {
    return JSON.stringify(detail).slice(0, 2_000);
  } catch {
    return String(detail);
  }
}
