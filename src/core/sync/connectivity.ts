import type { ExamApi } from '../api/types';
import { config } from '../config';
import { log } from '../util/logger';

/**
 * Is the backend actually reachable?
 *
 * `navigator.onLine` is a hint and nothing more: a lab switch or a blocked gateway leaves
 * the NIC up and `onLine === true` with no route to `exam.shulesoft.africa`. The authority
 * here is a `GET /health` probe with a short timeout.
 *
 * The watcher is cheap when it matters: it probes on the `online` event, on tab focus, on
 * demand, and otherwise on a slow poll that backs off while the lab is down.
 */

export type Reachability = 'unknown' | 'online' | 'offline';

export interface ConnectivityState {
  reachability: Reachability;
  navigatorOnline: boolean;
  lastProbeAt: number | null;
  lastOnlineAt: number | null;
  probing: boolean;
}

export type ConnectivityListener = (state: ConnectivityState) => void;

export interface ConnectivityOptions {
  /** Poll interval while reachable. */
  idleIntervalMs?: number;
  /** First interval after a failed probe; doubles up to `maxIntervalMs`. */
  downIntervalMs?: number;
  maxIntervalMs?: number;
}

export class ConnectivityWatcher {
  private state: ConnectivityState = {
    reachability: 'unknown',
    navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    lastProbeAt: null,
    lastOnlineAt: null,
    probing: false,
  };

  private listeners = new Set<ConnectivityListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private downInterval: number;
  private readonly idleIntervalMs: number;
  private readonly downIntervalMs: number;
  private readonly maxIntervalMs: number;
  private disposed = false;
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly api: ExamApi,
    options: ConnectivityOptions = {},
  ) {
    this.idleIntervalMs = options.idleIntervalMs ?? 60_000;
    this.downIntervalMs = options.downIntervalMs ?? 5_000;
    this.maxIntervalMs = options.maxIntervalMs ?? 60_000;
    this.downInterval = this.downIntervalMs;
  }

  current(): ConnectivityState {
    return { ...this.state };
  }

  subscribe(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.current();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn('Connectivity listener threw', error);
      }
    }
  }

  /** Browser events are hints that something changed; the probe decides. */
  start(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onBrowserOnline);
      window.addEventListener('offline', this.onBrowserOffline);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    void this.probe();
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onBrowserOnline);
      window.removeEventListener('offline', this.onBrowserOffline);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.listeners.clear();
  }

  private onBrowserOnline = (): void => {
    this.state.navigatorOnline = true;
    this.emit();
    // Reset the backoff: something really did change.
    this.downInterval = this.downIntervalMs;
    void this.probe();
  };

  private onBrowserOffline = (): void => {
    this.state.navigatorOnline = false;
    this.state.reachability = 'offline';
    this.emit();
    this.schedule();
  };

  private onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void this.probe();
    }
  };

  /** Probe now. Concurrent calls share one request. */
  async probe(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.inFlight) return this.inFlight;

    this.state.probing = true;
    this.emit();

    this.inFlight = (async () => {
      let ok = false;
      try {
        ok = await this.api.health();
      } catch {
        ok = false;
      }
      this.state.probing = false;
      this.state.lastProbeAt = Date.now();
      this.state.navigatorOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
      const was = this.state.reachability;
      this.state.reachability = ok ? 'online' : 'offline';
      if (ok) {
        this.state.lastOnlineAt = Date.now();
        this.downInterval = this.downIntervalMs;
      }
      if (was !== this.state.reachability) {
        log.info(`Connectivity: ${was} → ${this.state.reachability}`);
      }
      this.emit();
      this.schedule();
      return ok;
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const delay =
      this.state.reachability === 'online'
        ? this.idleIntervalMs
        : Math.min(this.maxIntervalMs, this.downInterval);
    if (this.state.reachability !== 'online') {
      this.downInterval = Math.min(this.maxIntervalMs, this.downInterval * 2);
    }
    this.timer = setTimeout(() => void this.probe(), delay);
  }
}

/**
 * A cheap guess for the UI's first paint, before any probe has returned. Never used to
 * decide whether to send anything.
 */
export function navigatorOnlineHint(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

export const defaultConnectivityOptions: ConnectivityOptions = {
  idleIntervalMs: 60_000,
  downIntervalMs: Math.max(2_000, Math.round(config.healthTimeoutMs / 2)),
  maxIntervalMs: 60_000,
};
