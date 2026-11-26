import { useEffect, useState } from 'react';
import { applyPendingUpdate, onUpdateAvailable } from '../../pwa/register';

/**
 * A waiting service-worker update is only ever *offered*, and only when no exam is in
 * progress on this machine. Reloading a lab machine mid-exam is not an acceptable way to
 * ship a bug fix.
 */
export function useAppUpdate(safeToUpdate: boolean): {
  available: boolean;
  apply: () => Promise<void>;
} {
  const [available, setAvailable] = useState(false);

  useEffect(() => onUpdateAvailable(setAvailable), []);

  return { available: available && safeToUpdate, apply: applyPendingUpdate };
}
