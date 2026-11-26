import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { addLogSink } from './core/util/logger';
import { examService } from './core/examService';
import { registerServiceWorker } from './pwa/register';
import './ui/styles.css';

/**
 * Entry point. Three things happen here and nowhere else: the log sink is wired to the
 * audit trail, the service is booted, and the service worker is registered.
 */

const service = examService();

// Warnings and errors are kept in the `events` store so the proctor's diagnostics export
// explains a bad machine without anyone needing a console.
addLogSink((level, message, detail) => {
  if (level === 'warn' || level === 'error') {
    void service.events.record(`log_${level}`, { message, detail: String(detail ?? '') });
  }
});

void service.start();
registerServiceWorker();

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <React.StrictMode>
    <App service={service} />
  </React.StrictMode>,
);
