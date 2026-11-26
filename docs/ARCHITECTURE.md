# ShuleSoft Offline Exams — Architecture

Target host: `exam.shulesoft.africa` · Local dev: `C:\xampp\htdocs\offline_exams`
Backend: existing Laravel + PostgreSQL (`C:\xampp\htdocs\shulesoft_newversion`), **unchanged schema**, additive endpoints only.

---

## 1. The lab lifecycle this app is built around

```
ONLINE          │ login → exam list → Start Exam → bundle download + verify
                │                                          ↓
INTERNET OFF    │           exam runner: answers, files, timer (100% local)
                │                                          ↓
                │           Submit Exam (offline) → attempt locked + queued
                │                                          ↓
INTERNET BACK   │  connectivity probe → outbox drains → per-item 2xx → synced
```

The critical invariant: **after the bundle is verified, nothing the student does needs the
network, and nothing the network does can lose it.** Every mutation is written to IndexedDB
(or OPFS for files) *before* the UI acknowledges it.

## 2. Layers

```
src/
├── types/            Domain types shared by core + UI (no runtime deps)
├── core/             Framework-agnostic. No React import anywhere in here.
│   ├── config.ts     Env-driven runtime config (API base, driver, limits)
│   ├── util/         ids, sha-256 checksums, clock, backoff, logger, Result
│   ├── api/          Transport: `ExamApi` interface + laravel.ts + mock.ts
│   ├── storage/      Dexie schema, scoped repositories, OPFS file store
│   ├── timer/        Pure monotonic timer state machine
│   ├── exam/         Bundle download / verification / submission packaging
│   └── sync/         Connectivity watcher, outbox selection, retry engine
└── ui/               React 18: screens, components, hooks (thin — calls core)
```

`core/` is pure TypeScript and is what the test suite exercises. UI never touches Dexie
tables directly; it goes through repositories and the sync engine.

## 3. Local data model (IndexedDB via Dexie, db `shulesoft_offline_exams` v1)

Every row that belongs to a student is keyed by a **scope key**:

```
scopeKey = `${schemaName}::${studentId}`            // one lab shift / one student
attemptKey = `${schemaName}::${studentId}::${examId}`  // one attempt
```

A shared lab machine therefore holds many students' data side by side; nothing is ever
read or written without its scope key, and logging out does **not** delete unsynced rows.

| Store | Primary key | Purpose |
|---|---|---|
| `sessions` | `scopeKey` | cached profile + API token, `activeScopeKey` in `meta` |
| `bundles` | `attemptKey` | exam metadata, questions, attachment rules, bundle checksum, media manifest |
| `attempts` | `attemptKey` | lifecycle status, timer state, submission uuid + checksum, sync state |
| `answers` | `${attemptKey}::${questionId}` | one row per question, upserted on every change |
| `files` | `fileId` (uuid) | student uploads + cached question media; bytes in OPFS or `blob` fallback |
| `outbox` | auto `id` | durable sync queue (see §6) |
| `events` | auto `id` | append-only audit trail for proctor diagnostics |
| `meta` | `key` | device id, active scope, last sync run, clock-skew sample |

Indexes are declared in `core/storage/db.ts`. All writes go through `db.transaction` where
two stores must move together (e.g. answer + outbox dirty flag).

### Attempt status (local)

```
bundling → ready → in_progress → submitted_offline → syncing → synced
                              ↘ expired (auto-submitted) ↗
                                                        ↘ needs_attention
```

`submitted_offline` is the state the student is shown on their confirmation screen. It is
already durable: the attempt cannot be edited again, and its payload is in the outbox.

## 4. Timer (monotonic, tamper- and crash-resistant)

`core/timer/examTimer.ts` is a **pure function over state** — no timers, no I/O, so it is
fully unit-tested:

```ts
tick(state, { wallNow, monoNow, monoSessionId }) -> state
remainingSeconds(state) -> number
```

* `monoNow` is `performance.now()`, valid only within one page session (`monoSessionId`).
* `elapsedSeconds` is **non-decreasing**: `max(stored, wallDelta, monoDelta)`.
* A wall clock moved backwards contributes `0`, never a rollback.
* After a refresh / power cut, elapsed resumes as `stored + max(0, wallNow - lastCheckpointWall)`,
  so time off-machine still counts (what an invigilator expects) while a tampered clock
  cannot win time back.
* Checkpointed to IndexedDB every `TIMER_CHECKPOINT_MS` (default 5s) and on
  `visibilitychange` / `pagehide`.
* At `elapsed >= duration` the runner locks input and auto-submits exactly once.

When sync happens, the server receives `client_started_at`, `client_submitted_at` and
`client_elapsed_seconds` so the backend can keep its own authoritative record and flag
anything implausible instead of silently discarding the attempt.

## 5. Files (OPFS with IndexedDB fallback)

`core/storage/files.ts` picks a backend once:

1. **OPFS** — `navigator.storage.getDirectory()` + `createWritable()`; bytes live outside
   the JSON payloads, so answer rows stay tiny. Path: `attempts/<attemptKey hash>/<fileId>`.
2. **IndexedDB blob** — same API, `blob` column, used on browsers without OPFS writables.

Every stored file carries `size`, `mimeType`, and a **SHA-256**, computed at save time. The
same digest is the attachment's idempotency key at upload time, so a retried multipart
upload can never create a second copy server-side.

Question media (images on questions) is downloaded during bundling into the same store with
`role: 'media'`, and rendered from `URL.createObjectURL` — so the runner shows images with
the network physically off.

## 6. Sync (durable outbox, idempotent, staged)

One submission is **three** kinds of outbox item, run in stages per attempt:

| stage | type | endpoint | idempotency key |
|---|---|---|---|
| 0 | `submission` | `POST /attempts/{id}/submission` | `attempt:{id}:{submission_uuid}` |
| 1 | `attachment` | `POST /attempts/{id}/attachments` | `attach:{id}:{question_id}:{sha256}` |
| 2 | `finalize` | `POST /attempts/{id}/finalize` | `final:{id}:{submission_uuid}` |

`selectDueItems()` (pure, tested) returns only items of the **lowest incomplete stage** for
each attempt, so answers land before files and the attempt is finalized only once every
file it declared has been acknowledged. The finalize payload repeats the attachment
manifest; the server refuses to finalize if something is missing, which is reported as
`needs_attention` rather than a silent partial pass.

Retry policy (`core/sync/backoff.ts`): `min(maxDelay, base * 2^(attempt-1))` with ±20%
jitter, default 2s → 5min, 10 attempts. Classification:

* `2xx` → `synced` (only here).
* `409 already_synced` → treated as `synced` (a previous retry won).
* `408 / 425 / 429 / 5xx / network error` → retry with backoff.
* other `4xx` → `needs_attention` immediately, with the server message kept for the proctor.

Connectivity (`core/sync/connectivity.ts`): the `online` event is a hint, not proof — a lab
switch can leave `navigator.onLine === true` with no route out. The real signal is a
`GET /health` probe with a short timeout, polled with backoff while down, and the engine
also drains on app start, on tab focus, and on the proctor's **Sync Now**.

## 7. Multi-shift lab safety

* Logging out clears only the *active scope pointer*; bundles, attempts, answers, files and
  outbox rows survive and keep syncing for whoever's turn it is next.
* The exam list shows a lab-wide banner: "N attempts from other students on this machine
  still waiting to sync" so a machine is never wiped while work is pending.
* `Sync Center` drains **all** scopes on the machine, not just the signed-in student, and
  can export a diagnostics JSON for the ICT officer.
* A `deviceId` (uuid in `meta`, stable per browser profile) is sent with every submission so
  the school can trace which machine an attempt came from.

## 8. PWA / offline shell

`vite-plugin-pwa` (Workbox, `injectManifest`-free generateSW) precaches the built shell,
fonts and icons; `navigateFallback: index.html` keeps deep links working with no network.
Updates use **prompt** mode, never auto-reload — an update must not reload a page with an
exam in progress. `core/sync` re-checks the service worker only when no attempt is
`in_progress`.

## 9. Trade-offs taken deliberately

* **Server stays the source of truth for marking.** The PWA never grades: `valid_answers.status`
  never leaves the server, exactly as the parent app does today.
* **No answer-level sync while offline.** Checkpointing to the server mid-exam is pointless
  in this deployment (the internet is physically off), so the outbox carries the whole
  attempt. Answers are still durable locally after every keystroke-debounce.
* **Duration is enforced client-side during the offline window**, with the server
  re-validating on sync. There is no alternative with the network off; §4 explains how the
  client makes that as hard to game as a browser allows.
