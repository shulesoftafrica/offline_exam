import { config } from '../config';
import { createLaravelApi } from './laravel';
import { createMockApi } from './mock';
import type { ExamApi } from './types';

export * from './types';
export { LaravelExamApi } from './laravel';
export { MockExamApi, createMockApi } from './mock';

let instance: ExamApi | null = null;

/** The driver chosen by `VITE_API_DRIVER`. Tests construct their own instead. */
export function examApi(): ExamApi {
  if (!instance) {
    instance = config.apiDriver === 'laravel' ? createLaravelApi() : createMockApi();
  }
  return instance;
}

/** Used by tests and by the dev-only driver switch on the sync screen. */
export function setExamApi(api: ExamApi | null): void {
  instance = api;
}
