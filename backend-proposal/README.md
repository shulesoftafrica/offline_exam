# Laravel side of the offline exam PWA

> **Applied to `C:\xampp\htdocs\shulesoft_newversion` on 26 Nov 2026.** This folder is now
> the reference copy; [what was actually applied](#what-was-applied) lists every file
> touched there, including four changes that are **not** in the copy table below and were
> needed to make the endpoints reachable at all.

These files were **ready to copy** into `C:\xampp\htdocs\shulesoft_newversion`, and nothing
in them changes an existing table, column, route or response. They were written against the
code as it stands: `minor_exams` → `questions` →
`valid_answers`, answers in `student_assessment`, marks in `minor_exam_marks`, attempts in
`minor_exam_attempts`, marking in `App\Services\OnlineExam\{ExamGrader,ExamResults}`, and
student credentials in the `shulesoft.users` view (`id = student_id`, `table = 'student'`).

## What to copy where

| From here | To |
|---|---|
| `migrations/2026_11_25_100000_add_offline_mode_to_minor_exam_attempts.php` | `database/migrations/` |
| `controllers/StudentAuthController.php` | `app/Http/Controllers/Api/Student/` |
| `controllers/OfflineExamController.php` | `app/Http/Controllers/Api/Student/` |
| `middleware/EnsureActiveStudent.php` | `app/Http/Middleware/` |
| `routes/student-exam-routes.php` | paste the block into `routes/api.php` |
| `verify/*.php` | nothing — run them in place to check a backend ([below](#what-was-verified-against-the-real-database)) |

Then:

```powershell
php artisan migrate
```

## What was applied

Nine files in `shulesoft_newversion`. The first five are the copy table above; the last four
are the ones nobody asks for until the first request 302s into the web installer.

| File | What changed |
|---|---|
| `database/migrations/2026_11_25_100000_add_offline_mode_to_minor_exam_attempts.php` | new — the nine columns and the two indexes |
| `app/Http/Controllers/Api/Student/StudentAuthController.php` | new |
| `app/Http/Controllers/Api/Student/OfflineExamController.php` | new |
| `app/Http/Middleware/EnsureActiveStudent.php` | new |
| `routes/api.php` | two imports beside the existing ones, the route block at the end. Nothing existing touched; `/api/health` was free (the other two `/health` routes are inside the `ai` and `hr` prefixes) |
| `app/Services/OnlineExam/ExamResults.php` | `closeExpired()` now skips an offline attempt with no `synced_at`, behind a `Schema::hasColumn` guard so the scheduled sweep still runs on a database where the migration has not been applied |
| `config/cors.php` | new — the file was missing entirely, so Laravel was sending no CORS headers at all. `paths: ['api/*']`, the exam subdomain plus the PWA's dev and preview ports, `Idempotency-Key` allowed, `supports_credentials: false`. Origins can be overridden with `CORS_ALLOWED_ORIGINS` in `.env` |
| `app/Http/Kernel.php` | `Illuminate\Http\Middleware\HandleCors` added to the global stack (Laravel's own default, absent here). It has to be global: a preflight `OPTIONS` never reaches the router, so route middleware would be too late |
| `app/Providers/AppServiceProvider.php` | `isStudentExamApiPath()` beside the existing `isAccountantApiPath()`, and used in the same `getInstalledStatus()` early return. Without it every call answers `302 → /install/index`, because the installed-check resolves the tenant from the **host**, and `exam.shulesoft.africa` is not a school's subdomain. The tenant of these calls comes from the Sanctum token instead |

One line inside `StudentAuthController` also differs from the copy in this folder:
`Auth::guard('web')->attempt(...)` rather than `Auth::attempt(...)`. The default guard is
only `web` at the start of a request; on an API route that has already been through
`auth:sanctum` it is `sanctum`, which has no `attempt()`. Naming it keeps the credential
check the web login's own whatever ran before it.

### Migrations run

`php artisan migrate` was **not** run, because this database has dozens of unrelated pending
migrations. Four were run by path, in this order:

```powershell
php artisan migrate --path=vendor/laravel/sanctum/database/migrations
```

```powershell
php artisan migrate --path=database/migrations/2026_11_14_100000_create_minor_exam_attempts.php
```

```powershell
php artisan migrate --path=database/migrations/2026_11_23_100000_online_exam_teacher_marking.php
```

```powershell
php artisan migrate --path=database/migrations/2026_11_25_100000_add_offline_mode_to_minor_exam_attempts.php
```

The first three were already in the repository and were prerequisites, not new work:
`personal_access_tokens` did not exist (so **no** Sanctum token could be issued, the teacher
app's included), `minor_exam_attempts` did not exist, and `student_assessment` had no
`teacher_marked_at`, which `ExamResults::finalizeAttempt()` reads.

### What was verified against the real database

Two harnesses, kept in [`verify/`](verify/) so this is repeatable:

```powershell
cd C:\xampp\htdocs\shulesoft_newversion; php ..\offline_exams\backend-proposal\verify\offline_exam_cycle.php
```

```powershell
cd C:\xampp\htdocs\shulesoft_newversion; php ..\offline_exams\backend-proposal\verify\student_login.php
```

Each takes a school and (for the cycle) a published exam as arguments — `php
offline_exam_cycle.php mtakuja 10285667` — and `SHULESOFT_PATH` overrides where the Laravel
app is. They drive real HTTP requests through the real kernel, so routing, Sanctum,
`EnsureActiveStudent` and the controllers all run.

Both run inside one transaction that is rolled back, so no school's data is
changed. `student_login.php` sets a password on one borrowed student (and one teacher) to
check the credential path; that write is rolled back with everything else and the script
prints whether its password still works afterwards — it must say `no`. A failed sign-in does
leave its row in `shulesoft.login_attempts`, exactly as a mistyped password does, because
that insert is the behaviour under test. 59 checks on the exam cycle and 19 on sign-in, all passing: sign-in against the real
`users` view (a teacher's credentials are refused with 403), the bundle with no answer key in
it, answers into `student_assessment`, a digest-named attachment on disk, `finalize` refusing
an attempt whose declared file never arrived, marking through `finalizeAttempt()` scoring
exactly the right answers (50 of 105 → 47.62% in `minor_exam_marks`), every write replayed
with the same idempotency key changing nothing, another student's token getting 404 for the
attempt, and `closeExpired()` leaving an unsynced offline attempt alone while still closing an
ordinary online one.

The PWA was then pointed at this API (`offline_exams/.env.local`) and a real student sat a
real exam in a browser, end to end: sign in, download, answer, reload mid-exam, submit with
the API unreachable, and sync. `lufadahighschool` exam 10285838, attempt 7 — five of ten
true/false questions answered, four right, and `minor_exam_marks.mark` came out 40 with
`student_assessment` holding the five answers and `synced_at` set on the attempt.

### What that first live run broke, and what was changed

Two things that no test against the mock backend could have caught, because the mock has no
wire format of its own:

**1. No exam could be downloaded at all.** `canonical()` wrote an empty array as `{}` —
`range(0, -1)` is `[0, -1]`, so `[]` failed the is-this-a-list test — while `json_encode()`
had put `[]` on the wire. Every bundle with a written question therefore carried a
`bundle_checksum` no browser could reproduce, and the PWA refused to start the exam with
"the exam download is incomplete or was altered in transit". Fixed here; the client was also
hashing its own camel-cased mapping rather than the response as sent, which was fixed on
that side. Both now have a test holding the same constant, and the cycle harness recomputes
the digest with an independent implementation instead of only checking that it starts with
`sha256:`.

**2. True/false questions were shown as empty text boxes.** `questions.type` carries more
than the three kinds the web module's own form creates: the AI exam generator writes 4
true/false, 5 short answer, 6 matching and 7 essay (`AIController::$typeMapping`), each with
a single model answer in `valid_answers`, so `ExamGrader::kind()` correctly calls them all
`written`. Marking is unchanged, but a student should not have to guess whether the marker
wants "True", "T" or "yes". The bundle now carries an `input_hint` per question and the PWA
renders True/False buttons for type 4. The answer key is not exposed: both labels go out for
every true/false question and `valid_answers.status` stays on the server.

## The one schema change

Nine nullable/defaulted columns on `shulesoft.minor_exam_attempts` (`mode`,
`submission_uuid`, `client_started_at`, `client_submitted_at`, `client_elapsed_seconds`,
`device_id`, `answer_checksum`, `attachment_count`, `synced_at`) plus a partial unique index
on `(schema_name, submission_uuid)`.

An attempt created by the parent app keeps working untouched: `mode` defaults to `'online'`
and every other column stays null.

## Two existing places that needed changing (both done)

**1. The expiry sweep must skip unsynced offline attempts.**
`App\Services\OnlineExam\ExamResults::closeExpired()` closes every `in_progress` attempt
whose `ends_at` has passed. A lab attempt is finished on the machine but not yet synced, so
closing it server-side would mark a completed exam as `timed_out` and score it as empty:

```php
// app/Services/OnlineExam/ExamResults.php, in closeExpired()
$q = DB::table('shulesoft.minor_exam_attempts')
    ->where('status', 'in_progress')
    ->where('ends_at', '<', now()->subSeconds(self::GRACE_SECONDS))
    // offline attempts are closed by the lab's sync, not by the sweep
    ->where(function ($w) {
        $w->whereNull('mode')->orWhere('mode', '<>', 'offline')->orWhereNotNull('synced_at');
    });
```

`App\Console\Commands\CloseExpiredOnlineExams` needs no change once `closeExpired()` filters.

The generous `ends_at` this controller writes for an offline attempt
(`duration + OFFLINE_WINDOW_HOURS`) is a second belt for the same problem: even without the
filter, a morning sitting synced the same afternoon still lands inside its window.

**2. CORS for the exam subdomain.** Live, the PWA is served from
`https://exam.shulesoft.africa` and calls this API on `https://ai.shulesoft.africa` — the
same host the Virtual Accountant and Jitsi modules already use — so every call is
cross-origin. `config/cors.php` did not exist in this repository and `HandleCors` was not
in the middleware stack, so the file was written and the middleware registered — see
[what was applied](#what-was-applied). What it holds:

```php
'paths' => ['api/*'],
'allowed_origins' => [/* … */, 'https://exam.shulesoft.africa'],
'allowed_headers' => ['Accept', 'Authorization', 'Content-Type', 'Idempotency-Key', 'X-Requested-With'],
'supports_credentials' => false,   // bearer tokens, not cookies
```

## Optional, for structured questions

The PWA renders a "structured" question (one stem, parts (a), (b), (c)) when sibling question
rows share a `group_ref`. The controller already looks for those columns and simply omits the
grouping when they are absent:

```php
Schema::table('shulesoft.questions', function (Blueprint $table) {
    $table->string('group_ref', 32)->nullable();   // questions sharing this render as one
    $table->string('part_label', 8)->nullable();   // '(a)', '(b)', …
});
```

Until then every question renders on its own, which is exactly today's behaviour.

## How marking stays identical

`finalize` calls `ExamResults::finalizeAttempt($attempt, 'submitted')` — the single existing
path, already used by the parent app and the scheduled sweep. So:

* choice questions and written answers with a model answer are scored by `ExamGrader`, with
  the web's own `compareStrings()` rule;
* upload answers and written answers with no model answer stay `pending_review`, and the
  teacher's "still to mark" count in the Teacher app is correct;
* `minor_exam_marks.mark` is written as a percent, and a mark a teacher typed by hand
  (`created_by_table <> 'student'`) is never overwritten.

The answer key never leaves the server: the bundle sends option ids and texts only, and
`valid_answers.status` is used server-side exclusively.

## Idempotency, concretely

| Endpoint | Key | Behaviour on replay |
|---|---|---|
| `POST /exams/{id}/bundle` | `bundle:{student_id}:{exam_id}` | returns the same attempt (unique key on `schema+exam+student`) |
| `POST /attempts/{id}/submission` | `attempt:{attempt_id}:{submission_uuid}` | `already_synced: true`, nothing written, once the attempt is closed |
| `POST /attempts/{id}/attachments` | `attach:{attempt_id}:{question_id}:{sha256}` | `duplicate: true`; the stored filename contains the digest, so no second copy |
| `POST /attempts/{id}/finalize` | `final:{attempt_id}:{submission_uuid}` | re-runs `finalizeAttempt()`, which is itself safe to call twice |

The client derives every key from server-issued ids and content digests, never from a random
value made at send time, so a retry after a browser restart carries exactly the same key.

## Checking it by hand

```powershell
curl -s -X POST http://localhost/shulesoft_newversion/api/student/login -H "Content-Type: application/json" --data-raw '{\"school\":\"demo\",\"username\":\"a-student\",\"password\":\"secret\"}'
```

```powershell
curl -s http://localhost/shulesoft_newversion/api/student/exams -H "Authorization: Bearer <token>"
```

```powershell
curl -s -X POST http://localhost/shulesoft_newversion/api/student/exams/91/bundle -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Idempotency-Key: bundle:4812:91" --data-raw '{\"mode\":\"offline\",\"device_id\":\"lab-01\"}'
```

Then point the PWA at it: `VITE_API_DRIVER=laravel`,
`VITE_API_BASE_URL=http://localhost/shulesoft_newversion/api` (that is what the PWA's
git-ignored `.env.local` and `.env.production.local` already hold on this machine).

## Deploying this to `ai.shulesoft.africa`

Nothing host-specific is compiled in, so a deployment is the ordinary one plus two checks:

1. Run the offline-mode migration there — by path, as below, if that database also has
   unrelated pending migrations.
2. Confirm the PWA's origin is answered: `CORS_ALLOWED_ORIGINS` in `.env` if the app is not
   on `https://exam.shulesoft.africa`, otherwise the committed default already covers it.

```powershell
curl -s -i -X OPTIONS https://ai.shulesoft.africa/api/student/login -H "Origin: https://exam.shulesoft.africa" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,idempotency-key"
```

A `204` with `access-control-allow-origin` echoing the app's origin means the browser will
be allowed to make the call; a `200` HTML page or a `302` to `/install/index` means
`HandleCors` or the `isStudentExamApiPath()` bypass did not make it into that deployment.

## What is deliberately *not* here

* **No new tables.** Answers, marks and attempts stay where they are.
* **No change to the parent app or the web module.** Both keep writing the same rows; an
  attempt is an attempt whichever screen produced it.
* **No server-side timer for the offline window.** With the lab's internet switched off there
  is nothing to ask. The browser enforces the countdown (monotonic clock, persisted
  checkpoints, auto-submit) and reports what it measured; this controller logs anything
  implausible for the school instead of silently discarding a student's work.
