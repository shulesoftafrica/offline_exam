import { createContext, useContext } from 'react';
import type { ExamService } from '../../core/examService';

/**
 * The service is injected rather than imported, so screens can be mounted against a test
 * instance (its own database and a mock API) with no module mocking.
 */
export const ServiceContext = createContext<ExamService | null>(null);

export function useService(): ExamService {
  const service = useContext(ServiceContext);
  if (!service) throw new Error('ServiceContext is missing above this component.');
  return service;
}
