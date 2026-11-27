# ShuleSoft Offline Exams

An offline-first PWA for sitting ShuleSoft online exams in a school computer lab **with the
internet physically switched off**, and syncing every answer and attachment to the existing
Laravel + PostgreSQL backend once it comes back.

React 18 · TypeScript (strict) · Vite · Workbox · Dexie (IndexedDB) · OPFS
Deployed at `exam.shulesoft.africa`; developed here at `C:\xampp\htdocs\offline_exams`.

---

## The lab day

```
ONLINE          login → exam list → Start Exam → bundle downloaded + verified
INTERNET OFF    answers, files, timer — all local, nothing needs the network
                Submit Exam → attempt locked, receipt shown, queued in the outbox
INTERNET BACK   health probe → outbox drains in stages → per-item 2xx → "Sent to school"
```

After the bundle verifies, the app tells the invigilator in as many words: *"This exam is
fully downloaded. The internet can now be switched off."*

## Quick start

```powershell
npm install
```

```powershell
npm run dev
```

Open http://localhost:5180 and sign in with `student` / `student` (school code `demo`).
That is **demo mode** — an in-memory stand-in for the Laravel API, seeded with four exams
(multiple choice, written, a structured question with parts (a)–(c), and one that wants a
photograph). No backend needed.

To exercise the service worker and the real offline path, build and preview instead — a dev
server cannot be switched off and still serve the app:

```powershell
npm run build; if ($?) { npm run preview }
```

Then open http://localhost:4173, load it once, and turn your machine's Wi-Fi off: the app
still boots, the exam still runs, and Submit still works.

### The real backend

**Already applied** to `C:\xampp\htdocs\shulesoft_newversion`, and this checkout is already
pointed at it by a git-ignored `.env.local`:

```
VITE_API_DRIVER=laravel
VITE_API_BASE_URL=http://localhost/shulesoft_newversion/api
VITE_DEFAULT_SCHOOL=            # set for a single-school deployment to hide the field
```

So signing in now wants a **real ShuleSoft student's school code, username and password**.
Set `VITE_API_DRIVER=mock` in `.env.local` (or delete the file) to go back to the
self-contained demo described above.

**Live is two hosts**, and the committed `.env.production` already says so:

| | |
|---|---|
| the app | `https://exam.shulesoft.africa` — static `dist/` from this repository |
| the API | `https://ai.shulesoft.africa/api` — the Laravel app, the same host the parent experience apps already call (`/api/accountant/*`, `/api/jitsi/*`) |

`npm run build` picks `.env.production` up on its own, so a deployment build needs no
flags. On this machine a git-ignored `.env.production.local` overrides it back to
`http://localhost/shulesoft_newversion/api`, which is what makes `npm run preview` on
:4173 a real test of the offline path; move that file aside to build for deployment from
here.

[`backend-proposal/`](backend-proposal/README.md) is the reference copy of the Laravel side
and lists every file that was touched there, the four migrations that were run, and what was
verified against the real database. The wire format is written out in
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).

## Commands

| | |
|---|---|
| `npm run dev` | dev server on :5180 (no service worker) |
| `npm run build` | typecheck + production build + service worker |
| `npm run preview` | serve the build on :4173 — use this to test offline |
| `npm test` | the suite (92 tests) |
| `npm run test:watch` | watch mode |
| `npm run typecheck` | `tsc` only |
| `node scripts/make-icons.mjs` | regenerate the PWA icons |

## How it is put together

```
src/
├── types/          domain types shared by everything
├── core/           framework-agnostic; no React import anywhere below this line
│   ├── config.ts   env-driven runtime config
│   ├── util/       ids & idempotency keys, SHA-256 + canonical JSON, clock, backoff, logging
│   ├── api/        ExamApi interface · laravel.ts (real) · mock.ts (demo + tests)
│   ├── storage/    Dexie schema, scoped repositories, OPFS file store, outbox queue
│   ├── timer/      pure monotonic exam clock
│   ├── exam/       bundle download & verification, submission packaging
│   ├── sync/       connectivity probe, staged idempotent sync engine
│   ├── examMerge.ts    server state + local state → what the student sees
│   └── examService.ts  the one object the UI talks to
└── ui/             React: screens, components, hooks
```

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the local data model, the timer rules, the
OPFS/IndexedDB split, the outbox staging and the multi-shift lab story.

### Four decisions worth knowing

**The timer cannot be rolled back.** Elapsed seconds are the maximum of the stored value, the
wall-clock delta since the last checkpoint, and a monotonic delta within the page session —
so a refresh, a power cut or a student changing the BIOS clock never returns time. Time
while the machine was off still counts. At zero the runner locks and submits once.

**Nothing is "saved" until it is in IndexedDB.** Choices write immediately, typing on a
400 ms debounce plus on blur, tab-hide and page teardown; files are hashed and written to
OPFS (IndexedDB blobs where OPFS is unavailable) before they appear in the answer.

**Sync is staged and idempotent.** Per attempt: answers → each file → finalize. An item is
`synced` only on an explicit 2xx; the server is refused permission to finalize an attempt
whose declared files have not all arrived. Idempotency keys come from server ids and content
digests, never from randomness at send time, so a retry after a browser restart carries the
same key. A transport failure (no response at all — the usual case in an offline lab) does
not consume the retry budget; only real server errors do.

**One machine, many students.** Everything is keyed by `schema::student::exam`. Signing out
clears only who the screen is for: the previous shift's answers, files and queue stay and
keep syncing. The exam list warns when another student's work on this machine is still
unsent, and the Sync screen drains every scope, not just the signed-in one.

## Tests

```powershell
npm test
```

92 tests, no mocking of the core: Dexie runs against `fake-indexeddb`, and the integration
tests drive the real `ExamService` against the mock backend.

* `core/timer/examTimer.test.ts` — counting, crash/power-cut recovery, clock tampering, expiry, integrity reporting
* `core/storage/examStore.test.ts` — autosave, locking after submission, per-student isolation, file hashing
* `core/storage/outbox.test.ts` — queue state machine and the whole scheduling policy
* `core/sync/syncEngine.test.ts` — 2xx-only success, backoff, fatal vs retryable, expired sign-in, partial attachments, multi-student drain, audit trail
* `core/exam/submission.test.ts` — payload determinism, checksums, attachment manifest, structured grouping
* `core/examMerge.test.ts` — which state a student sees, and what they may start
* `core/util/backoff.test.ts` — retry policy, SHA-256 vectors, canonical JSON, key derivation
* `core/api/laravel.test.ts` — the real driver against the real wire format: the bundle
  checksum is reproduced from the response as sent (pinned to the PHP implementation by a
  shared digest), a tampered question is refused, `input_hint` is mapped, the idempotency
  key is sent
* `test/labFlow.test.ts` — the lab day end to end, including a power cut mid-exam

## Deploying to `exam.shulesoft.africa`

1. `npm run build` → `dist/`.
2. Serve `dist/` over **HTTPS** (service workers and OPFS need a secure context; `localhost`
   is exempt for development). Any static host or an Apache/Nginx vhost will do.
3. SPA fallback: every unknown path serves `index.html`.

   ```apache
   <Directory "/var/www/exam.shulesoft.africa">
       FallbackResource /index.html
   </Directory>
   ```
4. Never cache `index.html` or `sw.js` (`Cache-Control: no-cache`); the hashed assets under
   `/assets/` can be cached for a year.
5. The API is `https://ai.shulesoft.africa` (already in `.env.production`), so this app's
   origin has to be in that host's CORS allow-list with `Idempotency-Key` in
   `allowed_headers`. `config/cors.php` there lists `https://exam.shulesoft.africa`
   already; a different hostname goes in `CORS_ALLOWED_ORIGINS` in the API's `.env` as a
   comma-separated list. See [`backend-proposal/README.md`](backend-proposal/README.md).
6. On each lab machine: open the app once while online, sign in, and let it install. Use the
   same browser profile for every shift — the exam data lives in that profile.

Updates use **prompt** mode on purpose: a new deployment never reloads a machine that has an
exam in progress. The app offers the update only when nothing is running.

[`docs/LAB_RUNBOOK.md`](docs/LAB_RUNBOOK.md) is the page to hand the invigilator.

## Limits worth stating plainly

* **A student must be online once, on that machine, to download an exam.** There is no way
  to hand out an exam with no network at all, and there is no offline account creation: a
  cached session only resumes a login that already happened on that machine.
* **The countdown is enforced in the browser during the offline window.** With the lab
  switched off there is nothing to ask the server. §4 of the architecture note explains what
  that costs and how it is made hard to game; the server re-validates on sync and the
  backend logs anything implausible rather than discarding a student's work.
* **This app never marks anything.** The answer key stays on the server, exactly as the
  parent app does today; `ExamResults::finalizeAttempt()` does the marking on sync.
* **Demo mode's fake server lives in the browser.** Clearing site data resets it.
