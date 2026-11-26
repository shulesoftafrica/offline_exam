/**
 * Runtime configuration. Read once at module load so the rest of the app never touches
 * `import.meta.env` (which makes every module testable without a Vite environment).
 */

export type ApiDriver = 'laravel' | 'mock';

export interface AppConfig {
  apiBaseUrl: string;
  apiDriver: ApiDriver;
  defaultSchool: string | null;
  timerCheckpointMs: number;
  autosaveDebounceMs: number;
  /** How long a health probe may take before the lab counts as offline. */
  healthTimeoutMs: number;
  /** Request timeout for ordinary API calls. */
  requestTimeoutMs: number;
  /** Sync retry policy. */
  retry: {
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
    jitter: number;
  };
  /** Hard ceilings the UI enforces before the server ever sees a file. */
  limits: {
    maxFileBytes: number;
    maxFilesPerQuestion: number;
    allowedMime: string[];
  };
}

type EnvBag = Record<string, string | boolean | undefined>;

function env(): EnvBag {
  // `import.meta.env` is absent under plain `tsc`/node; guard so core stays portable.
  try {
    return (import.meta as unknown as { env?: EnvBag }).env ?? {};
  } catch {
    return {};
  }
}

function str(key: string, fallback: string): string {
  const v = env()[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

function num(key: string, fallback: number): number {
  const v = Number(str(key, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export const config: AppConfig = {
  apiBaseUrl: trimTrailingSlash(str('VITE_API_BASE_URL', '/api')),
  apiDriver: str('VITE_API_DRIVER', 'mock') === 'laravel' ? 'laravel' : 'mock',
  defaultSchool: str('VITE_DEFAULT_SCHOOL', '') || null,
  timerCheckpointMs: num('VITE_TIMER_CHECKPOINT_MS', 5_000),
  autosaveDebounceMs: num('VITE_AUTOSAVE_DEBOUNCE_MS', 400),
  healthTimeoutMs: num('VITE_HEALTH_TIMEOUT_MS', 4_000),
  requestTimeoutMs: num('VITE_REQUEST_TIMEOUT_MS', 30_000),
  retry: {
    baseDelayMs: num('VITE_RETRY_BASE_MS', 2_000),
    maxDelayMs: num('VITE_RETRY_MAX_MS', 300_000),
    maxAttempts: num('VITE_RETRY_MAX_ATTEMPTS', 10),
    jitter: 0.2,
  },
  limits: {
    maxFileBytes: num('VITE_MAX_FILE_BYTES', 10 * 1024 * 1024),
    maxFilesPerQuestion: num('VITE_MAX_FILES_PER_QUESTION', 3),
    allowedMime: str(
      'VITE_ALLOWED_MIME',
      'image/jpeg,image/png,image/webp,image/heic,application/pdf',
    )
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },
};
