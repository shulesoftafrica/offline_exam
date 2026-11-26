import { useEffect, useState } from 'react';
import type { ConnectivityState } from '../../core/sync/connectivity';
import type { SyncProgress } from '../../core/sync/syncEngine';
import { useService } from './useService';

/** Live reachability — the probe's answer, not `navigator.onLine`. */
export function useConnectivity(): ConnectivityState {
  const service = useService();
  const [state, setState] = useState<ConnectivityState>(() => service.connectivityState());

  useEffect(() => service.onConnectivity(setState), [service]);

  return state;
}

/** Live outbox progress for the header pill and the sync screen. */
export function useSyncProgress(): SyncProgress {
  const service = useService();
  const [progress, setProgress] = useState<SyncProgress>(() => ({
    running: false,
    currentType: null,
    currentAttemptKey: null,
    uploadedBytes: 0,
    totalBytes: 0,
    lastRunAt: null,
    lastError: null,
    summary: { queued: 0, uploading: 0, synced: 0, needsAttention: 0, total: 0, state: 'empty' },
  }));

  useEffect(() => service.onSync(setProgress), [service]);

  return progress;
}
