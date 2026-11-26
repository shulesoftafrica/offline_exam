import { registerSW } from 'virtual:pwa-register';
import { log } from '../core/util/logger';

/**
 * Service-worker registration.
 *
 * Deliberately **prompt** mode: a new deployment must never reload a machine that has a
 * student mid-exam. `pendingUpdate()` exposes the waiting worker so the UI can offer the
 * update only when nothing is in progress (see `ui/hooks/useAppUpdate.ts`).
 */

type UpdateListener = (available: boolean) => void;

let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;
let updateAvailable = false;
const listeners = new Set<UpdateListener>();

function emit(): void {
  for (const listener of listeners) listener(updateAvailable);
}

export function onUpdateAvailable(listener: UpdateListener): () => void {
  listeners.add(listener);
  listener(updateAvailable);
  return () => listeners.delete(listener);
}

export function hasPendingUpdate(): boolean {
  return updateAvailable;
}

/** Applies the waiting worker and reloads. Only ever called from an explicit UI action. */
export async function applyPendingUpdate(): Promise<void> {
  if (!applyUpdate) return;
  await applyUpdate(true);
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  try {
    applyUpdate = registerSW({
      immediate: true,
      onNeedRefresh() {
        updateAvailable = true;
        log.info('A new version of the exam app is waiting.');
        emit();
      },
      onOfflineReady() {
        log.info('The exam app is installed and will work with the internet off.');
      },
      onRegisterError(error) {
        log.warn('Service worker registration failed', error);
      },
    });
  } catch (error) {
    // A missing/blocked SW is survivable: the app still runs, it just will not boot with
    // the network off until registration succeeds once.
    log.warn('Service worker unavailable', error);
  }
}
