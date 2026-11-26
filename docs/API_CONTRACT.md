# Laravel Integration Notes & API Contract

This is the contract the PWA speaks (`src/core/api/laravel.ts`). It is **additive**: no
existing table, column, route or response changes. It is **applied** in
`C:\xampp\htdocs\shulesoft_newversion` as of 26 Nov 2026 — the reference copy of the Laravel
side, the list of every file touched there and what was verified against the real database
are in [`../backend-proposal/`](../backend-proposal/README.md).

Base URL: `VITE_API_BASE_URL`, default `https://exam.shulesoft.africa/api` (dev:
`http://localhost/shulesoft_newversion/api`).

## 0. What already exists and is reused unchanged

| Existing thing | How this app uses it |
|---|---|
| `shulesoft.users` view (`id = student.student_id`, `table = 'student'`, `username`, `password`, `schema_name`) | student login via `Auth::attempt`, exactly like `Signin::loginByUsername` / `ApiController::authUser` |
| `shulesoft.minor_exams` (+ `exam_groups`, `publish_exam`, `total_time`, `total_question`, `note`, `date`) | exam list & bundle metadata |
| `shulesoft.questions` (`minor_exam_id`, `question`, `type`, `weight`, `attach`) | bundled questions |
| `shulesoft.valid_answers` (`question_id`, `answer`, `status`) | options only — **`status` never leaves the server** |
| `shulesoft.student_assessment` (`valid_answer_id`, `student_answer`, `attach`, `attach_file_name`, `score`, `teacher_marked_at`) | where synced answers land |
| `shulesoft.minor_exam_marks` | written by `ExamResults::finalizeAttempt`, untouched here |
| `shulesoft.minor_exam_attempts` | the attempt row; see §1 for the three nullable columns added |
| `App\Services\OnlineExam\ExamGrader` / `ExamResults` | marking is reused verbatim, so an offline attempt scores identically to the parent app |

Question kinds are `ExamGrader::kind()` verbatim: `type = 3` → `upload`; ≥2 options with a
right one → `choice`; otherwise `written`. A `structured` question is a client-side grouping
of real sibling question rows (`group_ref` on the bundle), so each part still syncs to its
own `question_id`.

## 1. The only schema change (additive, nullable)

`shulesoft.minor_exam_attempts` gains:

| column | type | why |
|---|---|---|
| `mode` | `varchar(16) default 'online'` | `'offline'` attempts are not auto-closed by the server sweep while the lab is offline |
| `submission_uuid` | `varchar(64) nullable`, unique with `schema_name` | idempotency: a retry carrying the same uuid is a no-op |
| `client_started_at` | `timestamp nullable` | what the browser recorded |
| `client_submitted_at` | `timestamp nullable` | " |
| `client_elapsed_seconds` | `integer nullable` | " |
| `device_id` | `varchar(64) nullable` | which lab machine |
| `answer_checksum` | `varchar(64) nullable` | SHA-256 of the canonical answer payload |
| `attachment_count` | `smallint default 0` | manifest size, so finalize can refuse a partial attempt |
| `synced_at` | `timestamp nullable` | when the server accepted the offline submission |

`CloseExpiredOnlineExams` / `ExamResults::closeExpired()` must skip `mode = 'offline'`
attempts that have not yet synced — one `where` clause, applied and covered by a test that
closes an online attempt and leaves an unsynced offline one alone.

## 2. Endpoints

All responses keep the house envelope `{ "success": 1|0, "data": …, "message": [...] }`.
All authenticated routes take `Authorization: Bearer <sanctum token>`.

### `POST /api/student/login`
```json
{ "username": "nassoro.k", "password": "••••••", "school": "mtakuja" }
```
→ `200`
```json
{ "success": 1, "data": {
  "token": "12|xxxxx",
  "student": { "student_id": 4812, "name": "Nassoro K.", "username": "nassoro.k",
               "schema_name": "mtakuja", "school_name": "Mtakuja Secondary",
               "class": "Form III", "section": "A", "photo": null },
  "server_time": "2026-11-25T08:31:04Z"
}}
```
`401` → `{ "success": 0, "message": ["Wrong username or password"] }`.
`school` is omitted when the host is a single-tenant exam subdomain (resolved by
`AppServiceProvider` tenant resolution, as the teacher API already does).

### `GET /api/student/me`
Revalidates a cached token on the next online boot. → same `student` object + `server_time`.

### `POST /api/student/logout`
Revokes the current token only.

### `GET /api/health`
Unauthenticated, no DB work, cacheable-never. → `{ "success": 1, "data": { "ok": true, "server_time": "…" } }`
This is the reachability probe; `navigator.onLine` alone is not trusted.

### `GET /api/student/exams`
→ one row per visible exam (published exams of the student's current subjects — the same
rule as `DigitalLearningExams::dleExamQuery`):
```json
{ "success": 1, "data": { "items": [{
  "exam_id": 91, "title": "Mid-Term Physics", "subject": "Physics", "subject_id": 12,
  "date": "2026-11-25", "minutes": 90, "questions": 24, "total_weight": 60,
  "state": "available",            // available | upcoming | in_progress | submitted | not_ready
  "results_released": false, "score": null, "total": null,
  "attempt": null                  // or { "attempt_id": 551, "mode": "offline",
                                   //      "status": "in_progress", "seconds_left": 2310,
                                   //      "submitted_at": null, "synced_at": null }
}]}}
```
The PWA merges this with local state to render `submitted_offline` / `synced` /
`completed_past`; the server's `state` always wins for "this exam is already taken".

### `POST /api/student/exams/{examId}/bundle`
The one call that must happen while online. Creates **or returns** the student's single
attempt (unique key `schema_name + minor_exam_id + student_id` already enforces one) and
returns everything needed to sit the exam with no network.

Request: `{ "mode": "offline", "device_id": "b1f0…", "client_time": "2026-11-25T08:31:04Z" }`
Header: `Idempotency-Key: bundle:{student_id}:{exam_id}` (a second tap returns the same attempt).

→ `200`
```json
{ "success": 1, "data": {
  "attempt": { "attempt_id": 551, "submission_uuid": "9f3c…",  // server-issued, stable
               "mode": "offline", "status": "in_progress",
               "started_at": "2026-11-25T08:31:05Z", "ends_at": "2026-11-25T10:01:05Z",
               "duration_seconds": 5400, "server_time": "2026-11-25T08:31:05Z" },
  "exam": { "exam_id": 91, "title": "Mid-Term Physics", "subject": "Physics",
            "instructions": "Answer all questions…", "total_weight": 60,
            "minutes": 90, "question_count": 24, "date": "2026-11-25" },
  "attachment_rules": { "enabled": true, "max_files_per_question": 3,
                        "max_file_bytes": 10485760,
                        "allowed_mime": ["image/jpeg","image/png","application/pdf"] },
  "questions": [
    { "question_id": 7781, "number": 1, "kind": "choice", "weight": 2,
      "text": "Which of the following…", "image_url": "https://…/attach_17.jpg",
      "group_ref": null, "part_label": null,
      "options": [{ "option_id": 55012, "text": "0.5 m/s" }] },
    { "question_id": 7782, "number": 2, "kind": "written", "weight": 5,
      "text": "Explain…", "max_chars": 4000, "options": [] },
    { "question_id": 7783, "number": 3, "kind": "upload", "weight": 10,
      "text": "Photograph your graph and attach it.", "options": [] },
    { "question_id": 7784, "number": "4a", "kind": "written", "weight": 3,
      "group_ref": "q4", "part_label": "(a)", "text": "State Hooke's law.", "options": [] }
  ],
  "media": [{ "url": "https://…/attach_17.jpg", "question_id": 7781, "bytes": 48213,
              "sha256": null }],
  "bundle_checksum": "sha256:4f1c…",   // over the canonical questions+exam payload
  "issued_at": "2026-11-25T08:31:05Z"
}}
```
`409` when the exam cannot be started (`upcoming`, `not_ready`, `submitted`) with the same
messages the parent app already returns.

> **Completeness:** the client recomputes `bundle_checksum` over the canonical payload and
> refuses to start an exam if it disagrees or if any `media` item failed to download.

### `POST /api/student/attempts/{attemptId}/submission`  (stage 0)
Header: `Idempotency-Key: attempt:{attempt_id}:{submission_uuid}`
```json
{ "submission_uuid": "9f3c…", "device_id": "b1f0…",
  "client_started_at": "2026-11-25T08:31:05Z",
  "client_submitted_at": "2026-11-25T09:58:40Z",
  "client_elapsed_seconds": 5255,
  "answer_checksum": "sha256:aa31…",
  "answers": [
    { "question_id": 7781, "option_id": 55012 },
    { "question_id": 7782, "text": "Because the force…" },
    { "question_id": 7783, "attachments": [
        { "sha256": "c1d2…", "name": "graph.jpg", "mime": "image/jpeg", "bytes": 831221 }] }
  ],
  "attachment_manifest": [{ "question_id": 7783, "sha256": "c1d2…", "bytes": 831221 }] }
```
→ `200` `{ "success": 1, "data": { "accepted": 24, "attempt_status": "syncing",
   "missing_attachments": [{ "question_id": 7783, "sha256": "c1d2…" }],
   "already_synced": false }}`

Server behaviour: upsert `student_assessment` per `question_id` (same shape the web module
writes), record the client timing columns, set `status = 'syncing'`. **Idempotent** — a
replay with the same `submission_uuid` returns `already_synced: true` and changes nothing.
`option_id` is validated against the question's own `valid_answers` (reject `422` otherwise),
as `saveOnlineExamAnswer` already does.

### `POST /api/student/attempts/{attemptId}/attachments`  (stage 1, `multipart/form-data`)
Header: `Idempotency-Key: attach:{attempt_id}:{question_id}:{sha256}`
Fields: `question_id`, `sha256`, `submission_uuid`, `file` (the part), optional
`chunk_index`, `chunk_total`, `upload_id` for chunked transfer of large parts.

→ `200` `{ "success": 1, "data": { "stored": true, "duplicate": false,
  "question_id": 7783, "attach": "graph.jpg",
  "attach_file_name": "https://…/storage/uploads/images/attach_1764…jpg" }}`

Server behaviour: verify the digest, store exactly where `ExamSetting::PostAnswerfile`
stores (`storage/uploads/images/attach_*.ext`), then write `attach` / `attach_file_name`
onto the student's `student_assessment` row. A second upload of the same digest returns
`duplicate: true` and does nothing. Reject anything outside `attachment_rules` with `422`.

### `POST /api/student/attempts/{attemptId}/finalize`  (stage 2)
Header: `Idempotency-Key: final:{attempt_id}:{submission_uuid}`
```json
{ "submission_uuid": "9f3c…", "answer_checksum": "sha256:aa31…",
  "attachment_manifest": [{ "question_id": 7783, "sha256": "c1d2…" }] }
```
→ `200`
```json
{ "success": 1, "data": { "attempt_status": "submitted", "synced_at": "2026-11-25T11:02:10Z",
  "auto_score": 41, "total_weight": 60, "pending_review": 2, "results_released": false }}
```
Calls `ExamResults::finalizeAttempt($attempt, 'submitted')` — the single existing marking
path, so marks, `minor_exam_marks` and the teacher's "still to mark" count behave exactly as
they do for the parent app. `409 { "code": "missing_attachments", … }` when the manifest is
not fully present (client keeps the item queued → `needs_attention` after its retries).

### `GET /api/student/attempts/status?attempt_ids=551,552`
Proctor view / post-sync reconciliation.
→ `{ "success": 1, "data": { "items": [{ "attempt_id": 551, "status": "submitted",
     "synced_at": "…", "attachments_stored": 1, "pending_review": 2 }]}}`

## 3. HTTP semantics the client depends on

| Code | Client reaction |
|---|---|
| `2xx` | item `synced` — the **only** success signal |
| `409` with `"code": "already_synced"` | treated as success (a retry raced) |
| `408`, `425`, `429`, `5xx`, network/timeout | retry with backoff (10 attempts) |
| other `4xx` | `needs_attention`, server `message[]` surfaced to the proctor verbatim |

Idempotency keys are stable across process restarts because they are derived from
server-issued ids (`attempt_id`, `submission_uuid`) and content digests — never from a
random value generated at send time.

## 4. Dev mode without the backend

`VITE_API_DRIVER=mock` swaps in `src/core/api/mock.ts`: an in-memory Laravel stand-in with
seeded exams, realistic latency, forced-failure switches (`?fail=submission`) and the same
idempotency rules, so the whole lab flow — including sync — is demonstrable and testable
before the backend routes are merged.
