<?php

/**
 * End-to-end check of the offline exam API against the real Laravel app and the real
 * database, driven through the HTTP kernel so routing, Sanctum and EnsureActiveStudent all
 * run. Everything happens inside one transaction that is rolled back at the end, so the
 * school's data is left exactly as it was.
 *
 * Usage: php lab_e2e.php
 */

// The Laravel app this checks. Override with the SHULESOFT_PATH environment variable.
$base = rtrim(getenv('SHULESOFT_PATH') ?: 'C:/xampp/htdocs/shulesoft_newversion', '/');
require $base . '/vendor/autoload.php';

/** @var Illuminate\Foundation\Application $app */
$app = require_once $base . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;

// A school and one of its published online exams. Pass your own:
//   php offline_exam_cycle.php <schema> <minor_exams.id>
define('SCHEMA', $argv[1] ?? 'akilistars');
define('EXAM_ID', (int) ($argv[2] ?? 10285667));

setSchema(SCHEMA);

$httpKernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$token = null;
$createdFiles = [];
$pass = 0;
$fail = 0;

function say(string $line): void
{
    echo $line . "\n";
}

function check(string $what, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    $ok ? $pass++ : $fail++;
    say(sprintf('  %s %s%s', $ok ? '[ok]  ' : '[FAIL]', $what, $detail !== '' ? '  — ' . $detail : ''));
}

/**
 * Canonical JSON as the PWA computes it (`src/core/util/checksum.ts#canonicalJson`): keys
 * sorted, no whitespace, nulls kept, and — the part that matters — an empty array written
 * as `[]`, because that is what a JSON parser in a browser sees. Deliberately a separate
 * implementation from the controller's, so that this checks agreement rather than itself.
 */
function browser_canonical($value): string
{
    if (is_array($value)) {
        if ($value === [] || array_keys($value) === range(0, count($value) - 1)) {
            return '[' . implode(',', array_map('browser_canonical', $value)) . ']';
        }
        ksort($value, SORT_STRING);
        $parts = [];
        foreach ($value as $k => $v) {
            $parts[] = json_encode((string) $k, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ':' . browser_canonical($v);
        }

        return '{' . implode(',', $parts) . '}';
    }
    if (is_bool($value)) {
        return $value ? 'true' : 'false';
    }
    if ($value === null) {
        return 'null';
    }
    if (is_int($value) || is_float($value)) {
        return json_encode($value + 0);
    }

    return json_encode((string) $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

/** One API call through the whole stack. @return array{0:int,1:array} */
function call(string $method, string $uri, array $body = [], array $headers = [], array $files = []): array
{
    global $httpKernel, $token, $app;

    // One process serving many requests: the auth manager caches the guard (and the user it
    // resolved) in the container, so without this a later call would keep whoever signed in
    // first. A real request gets a fresh container.
    $app['auth']->forgetGuards();

    $server = ['HTTP_ACCEPT' => 'application/json', 'HTTP_HOST' => 'exam.shulesoft.africa'];
    if ($token !== null) {
        $server['HTTP_AUTHORIZATION'] = 'Bearer ' . $token;
    }
    foreach ($headers as $name => $value) {
        $server['HTTP_' . strtoupper(str_replace('-', '_', $name))] = $value;
    }

    if ($files) {
        $request = Request::create($uri, $method, $body, [], $files, $server);
    } else {
        $request = Request::create($uri, $method, [], [], [], $server, $body ? json_encode($body) : null);
        if ($body) {
            $request->headers->set('Content-Type', 'application/json');
            $request->server->set('CONTENT_TYPE', 'application/json');
        }
    }

    $response = $httpKernel->handle($request);
    $decoded = json_decode((string) $response->getContent(), true);

    return [$response->getStatusCode(), is_array($decoded) ? $decoded : ['raw' => (string) $response->getContent()]];
}

DB::beginTransaction();

try {
    // ── the student we borrow for the test ────────────────────────────────────
    $exam = DB::table('shulesoft.minor_exams')->where('schema_name', SCHEMA)->where('id', EXAM_ID)
        ->first(['id', 'subject_id', 'total_time', 'publish_exam']);
    $subject = DB::table('shulesoft.subject')->where('schema_name', SCHEMA)
        ->where('subjectID', $exam->subject_id)->first(['classesID', 'subject']);

    $student = DB::table('shulesoft.student as s')
        ->join('shulesoft.users as u', function ($j) {
            $j->on('u.id', '=', 's.student_id')->where('u.table', '=', 'student')->on('u.schema_name', '=', 's.schema_name');
        })
        ->where('s.schema_name', SCHEMA)
        ->where('s.classesID', $subject->classesID)
        ->where('s.status', 1)
        ->whereNotExists(function ($q) {
            // somebody who has not sat this exam, so nothing of theirs is disturbed
            $q->select(DB::raw(1))->from('shulesoft.minor_exam_attempts as a')
                ->whereColumn('a.student_id', 's.student_id')->where('a.minor_exam_id', EXAM_ID);
        })
        ->orderBy('s.student_id')
        ->first(['s.student_id', 's.name', 'u.sid', 'u.username']);

    say('School ' . SCHEMA . ' · exam ' . EXAM_ID . ' (' . $subject->subject . ', ' . $exam->total_time . ' min)');
    say('Student ' . $student->student_id . ' · ' . $student->name);
    say('');

    $user = App\Model\User::withoutGlobalScopes()->where('sid', $student->sid)->firstOrFail();
    $token = $user->createToken('exam-offline-pwa', ['exam-offline'])->plainTextToken;

    // ── an upload question, so the attachment stage is exercised too ──────────
    $uploadQuestionId = (int) DB::table('shulesoft.questions')->where('schema_name', SCHEMA)->max('id') + 1;
    DB::table('shulesoft.questions')->insert([
        'id' => $uploadQuestionId,
        'schema_name' => SCHEMA,
        'minor_exam_id' => EXAM_ID,
        'question' => '<p>Photograph your working for question 1 and upload it.</p>',
        'type' => 3,
        'weight' => 5,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // ── 1. the exam list, while the lab is still online ───────────────────────
    say('1. GET /api/student/exams');
    [$status, $list] = call('GET', '/api/student/exams');
    check('200', $status === 200, 'got ' . $status);
    $mine = collect($list['data']['items'] ?? [])->firstWhere('exam_id', EXAM_ID);
    check('the exam is listed', $mine !== null);
    check('state is available', ($mine['state'] ?? '') === 'available', 'state=' . ($mine['state'] ?? '?'));
    check('no answer key in the list', !str_contains(json_encode($list), '"status":"1"'));

    // ── 2. the bundle ─────────────────────────────────────────────────────────
    say('');
    say('2. POST /api/student/exams/' . EXAM_ID . '/bundle');
    [$status, $bundle] = call(
        'POST',
        '/api/student/exams/' . EXAM_ID . '/bundle',
        ['mode' => 'offline', 'device_id' => 'lab-e2e-01'],
        ['Idempotency-Key' => 'bundle:' . $student->student_id . ':' . EXAM_ID],
    );
    check('200', $status === 200, 'got ' . $status . ' ' . json_encode($bundle['message'] ?? ''));
    $data = $bundle['data'] ?? [];
    $attemptId = (int) ($data['attempt']['attempt_id'] ?? 0);
    $uuid = (string) ($data['attempt']['submission_uuid'] ?? '');
    $questions = $data['questions'] ?? [];
    check('an attempt id came back', $attemptId > 0, 'attempt=' . $attemptId);
    check('a submission uuid came back', $uuid !== '');
    check('mode is offline', ($data['attempt']['mode'] ?? '') === 'offline');
    check('duration is the exam duration', (int) ($data['attempt']['duration_seconds'] ?? 0) === (int) $exam->total_time * 60);
    check('all 11 questions are in the bundle', count($questions) === 11, 'got ' . count($questions));
    $choices = array_values(array_filter($questions, fn ($q) => $q['kind'] === 'choice'));
    $uploads = array_values(array_filter($questions, fn ($q) => $q['kind'] === 'upload'));
    check('choice questions carry their options', count($choices) > 0 && count($choices[0]['options']) >= 2);
    check('the upload question is marked upload', count($uploads) === 1);
    check('attachment rules are sent', ($data['attachment_rules']['enabled'] ?? false) === true);
    check('a bundle checksum is sent', str_starts_with((string) ($data['bundle_checksum'] ?? ''), 'sha256:'));
    // And that it is a digest the browser can actually reproduce. `browser_canonical()` is a
    // second, independent implementation of the PWA's canonical JSON, run over the decoded
    // response body — exactly what the client has to work from, offline, with no way to ask.
    // A checksum that merely looks like a checksum is worth nothing: the first version of
    // this signed `"options": []` as `{}` and no exam with a written question could be
    // started at all.
    $reproduced = 'sha256:' . hash('sha256', browser_canonical([
        'exam' => $data['exam'] ?? null,
        'questions' => $questions,
    ]));
    check(
        'the checksum is reproducible from the response body',
        $reproduced === ($data['bundle_checksum'] ?? ''),
        'server=' . substr((string) ($data['bundle_checksum'] ?? ''), 0, 22) . '… browser=' . substr($reproduced, 0, 22) . '…'
    );
    // The one property the whole design rests on: the key stays on the server.
    $keyLeaked = false;
    foreach ($questions as $q) {
        foreach ($q['options'] as $o) {
            if (array_key_exists('status', $o) || array_key_exists('is_correct', $o) || array_key_exists('correct', $o)) {
                $keyLeaked = true;
            }
        }
    }
    check('no answer key in the bundle', !$keyLeaked);

    // a replay of the bundle call returns the same attempt, not a second one
    [, $again] = call('POST', '/api/student/exams/' . EXAM_ID . '/bundle', ['mode' => 'offline', 'device_id' => 'lab-e2e-01']);
    check('replaying the bundle returns the same attempt', (int) ($again['data']['attempt']['attempt_id'] ?? 0) === $attemptId);

    // ── 3. the sitting happens offline; now the answers arrive ────────────────
    say('');
    say('3. POST /api/student/attempts/' . $attemptId . '/submission');
    // Half the choice questions are answered right and half wrong, so the mark the server
    // works out can be predicted exactly. The right option is read from valid_answers here
    // in the harness — the bundle the student received does not contain it.
    $keys = DB::table('shulesoft.valid_answers')->where('schema_name', SCHEMA)
        ->whereIn('question_id', collect($questions)->pluck('question_id'))
        ->get(['id', 'question_id', 'status'])
        ->groupBy('question_id');

    $answers = [];
    $expectedScore = 0.0;
    $expectedTotal = 0.0;
    $answeredRight = 0;
    foreach ($questions as $q) {
        $expectedTotal += (float) $q['weight'];
        if ($q['kind'] === 'choice') {
            $options = $keys[$q['question_id']] ?? collect();
            $right = $options->first(fn ($o) => in_array((string) $o->status, ['1', 't'], true));
            $wrong = $options->first(fn ($o) => !in_array((string) $o->status, ['1', 't'], true));
            $answerRight = $answeredRight < 5 && $right !== null;
            if ($answerRight) {
                $answeredRight++;
                $expectedScore += (float) $q['weight'];
            }
            $pick = $answerRight ? $right : ($wrong ?? $right);
            $answers[] = ['question_id' => $q['question_id'], 'option_id' => (int) $pick->id];
        } elseif ($q['kind'] === 'written') {
            $answers[] = ['question_id' => $q['question_id'], 'text' => 'Written offline in the lab.'];
        }
    }
    $fileBytes = "lab e2e attachment\n";
    $digest = hash('sha256', $fileBytes);
    $manifest = [['question_id' => $uploads[0]['question_id'], 'sha256' => $digest]];

    [$status, $submission] = call('POST', '/api/student/attempts/' . $attemptId . '/submission', [
        'submission_uuid' => $uuid,
        'answers' => $answers,
        'attachment_manifest' => $manifest,
        'answer_checksum' => 'sha256:' . str_repeat('ab', 32),
        'client_started_at' => now()->subMinutes((int) $exam->total_time)->toIso8601String(),
        'client_submitted_at' => now()->toIso8601String(),
        'client_elapsed_seconds' => (int) $exam->total_time * 60 - 30,
        'device_id' => 'lab-e2e-01',
    ], ['Idempotency-Key' => 'attempt:' . $attemptId . ':' . $uuid]);

    check('200', $status === 200, 'got ' . $status . ' ' . json_encode($submission['message'] ?? ''));
    check('every answer was accepted', (int) ($submission['data']['accepted'] ?? 0) === count($answers), 'accepted=' . ($submission['data']['accepted'] ?? '?') . ' of ' . count($answers));
    check('attempt is now syncing', ($submission['data']['attempt_status'] ?? '') === 'syncing');
    check('the missing file is reported', count($submission['data']['missing_attachments'] ?? []) === 1);
    check('answers are in student_assessment', DB::table('shulesoft.student_assessment')->where('schema_name', SCHEMA)->where('student_id', $student->student_id)->whereIn('question_id', collect($questions)->pluck('question_id'))->count() === count($answers));

    // ── 3b. finalize must refuse while the file is missing ────────────────────
    say('');
    say('3b. POST .../finalize with the file still missing');
    [$status, $refused] = call('POST', '/api/student/attempts/' . $attemptId . '/finalize', [
        'submission_uuid' => $uuid,
        'attachment_manifest' => $manifest,
    ]);
    check('409, not closed', $status === 409, 'got ' . $status);
    check('code says why', ($refused['data']['code'] ?? '') === 'missing_attachments');
    check('the attempt is untouched', DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->value('status') === 'syncing');

    // ── 4. the file ───────────────────────────────────────────────────────────
    say('');
    say('4. POST /api/student/attempts/' . $attemptId . '/attachments');
    $tmp = sys_get_temp_dir() . '/lab_e2e_upload.txt';
    file_put_contents($tmp, $fileBytes);
    [$status, $attach] = call('POST', '/api/student/attempts/' . $attemptId . '/attachments', [
        'submission_uuid' => $uuid,
        'question_id' => $uploads[0]['question_id'],
        'sha256' => $digest,
    ], ['Idempotency-Key' => 'attach:' . $attemptId . ':' . $uploads[0]['question_id'] . ':' . $digest], [
        'file' => new UploadedFile($tmp, 'working.txt', 'text/plain', null, true),
    ]);
    check('200', $status === 200, 'got ' . $status . ' ' . json_encode($attach['message'] ?? ''));
    check('stored', ($attach['data']['stored'] ?? false) === true);
    $storedName = 'attach_' . substr($digest, 0, 24) . '_' . $uploads[0]['question_id'] . '.txt';
    $storedPath = $base . '/storage/uploads/images/' . $storedName;
    check('the file is on disk, named by its digest', is_file($storedPath), $storedName);
    if (is_file($storedPath)) {
        $createdFiles[] = $storedPath;
        check('the bytes are the bytes', file_get_contents($storedPath) === $fileBytes);
    }
    check('student_assessment carries the link', DB::table('shulesoft.student_assessment')->where('schema_name', SCHEMA)->where('student_id', $student->student_id)->where('question_id', $uploads[0]['question_id'])->value('attach_file_name') !== null);

    // a retried upload is recognised, not stored twice
    file_put_contents($tmp, $fileBytes);
    [$status, $dup] = call('POST', '/api/student/attempts/' . $attemptId . '/attachments', [
        'submission_uuid' => $uuid,
        'question_id' => $uploads[0]['question_id'],
        'sha256' => $digest,
    ], [], ['file' => new UploadedFile($tmp, 'working.txt', 'text/plain', null, true)]);
    check('a retried upload says duplicate', $status === 200 && ($dup['data']['duplicate'] ?? false) === true);

    // a truncated upload is refused and stays retryable
    file_put_contents($tmp, 'not the same bytes');
    [$status, $bad] = call('POST', '/api/student/attempts/' . $attemptId . '/attachments', [
        'submission_uuid' => $uuid,
        'question_id' => $uploads[0]['question_id'],
        'sha256' => hash('sha256', 'something else entirely'),
    ], [], ['file' => new UploadedFile($tmp, 'working.txt', 'text/plain', null, true)]);
    check('a file whose digest does not match is refused', $status === 422, 'got ' . $status);

    // ── 5. finalize ───────────────────────────────────────────────────────────
    say('');
    say('5. POST /api/student/attempts/' . $attemptId . '/finalize');
    [$status, $final] = call('POST', '/api/student/attempts/' . $attemptId . '/finalize', [
        'submission_uuid' => $uuid,
        'answer_checksum' => 'sha256:' . str_repeat('ab', 32),
        'attachment_manifest' => $manifest,
    ], ['Idempotency-Key' => 'final:' . $attemptId . ':' . $uuid]);
    check('200', $status === 200, 'got ' . $status . ' ' . json_encode($final['message'] ?? ''));
    check('the attempt is submitted', ($final['data']['attempt_status'] ?? '') === 'submitted', 'status=' . ($final['data']['attempt_status'] ?? '?'));
    check('synced_at is set', !empty($final['data']['synced_at']));
    check('the upload is waiting for the teacher', (int) ($final['data']['pending_review'] ?? 0) >= 1, 'pending_review=' . ($final['data']['pending_review'] ?? '?'));

    $row = DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->first();
    check('total_weight is the exam total', (float) $row->total_weight === $expectedTotal, $row->total_weight . ' vs ' . $expectedTotal);
    check('client timing was recorded', $row->client_elapsed_seconds !== null && $row->client_submitted_at !== null);
    check('the device is recorded', $row->device_id === 'lab-e2e-01');

    check(
        'the server marked exactly the right answers',
        (float) $row->auto_score === $expectedScore,
        'auto_score=' . $row->auto_score . ', expected ' . $expectedScore . ' from ' . $answeredRight . ' right answers',
    );

    $mark = DB::table('shulesoft.minor_exam_marks')->where('schema_name', SCHEMA)
        ->where('student_id', $student->student_id)->where('minor_exam_id', EXAM_ID)->first();
    check('a mark row was written', $mark !== null);
    if ($mark) {
        $expectedPercent = round($expectedScore / $expectedTotal * 100, 2);
        check('the mark is that score as a percent', (float) $mark->mark === $expectedPercent, 'mark=' . $mark->mark . ', expected ' . $expectedPercent);
        check('it is attributed to the student, not a teacher', $mark->created_by_table === 'student');
    }
    say('      marked ' . $row->auto_score . ' of ' . $row->total_weight . ' automatically, ' . $row->pending_review . ' left for the teacher');

    // ── 6. replays of a finished attempt change nothing ───────────────────────
    say('');
    say('6. replays after the exam is closed');
    $before = DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->first();
    [$status, $replaySubmission] = call('POST', '/api/student/attempts/' . $attemptId . '/submission', [
        'submission_uuid' => $uuid,
        'answers' => $answers,
        'attachment_manifest' => $manifest,
    ], ['Idempotency-Key' => 'attempt:' . $attemptId . ':' . $uuid]);
    check('a replayed submission says already_synced', $status === 200 && ($replaySubmission['data']['already_synced'] ?? false) === true);
    [$status, ] = call('POST', '/api/student/attempts/' . $attemptId . '/finalize', [
        'submission_uuid' => $uuid,
        'attachment_manifest' => $manifest,
    ]);
    check('a replayed finalize is still 200', $status === 200, 'got ' . $status);
    $after = DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->first();
    check('the score did not move', (float) $after->auto_score === (float) $before->auto_score);
    check('one attempt row, not two', DB::table('shulesoft.minor_exam_attempts')->where('schema_name', SCHEMA)->where('student_id', $student->student_id)->where('minor_exam_id', EXAM_ID)->count() === 1);
    check('one mark row, not two', DB::table('shulesoft.minor_exam_marks')->where('schema_name', SCHEMA)->where('student_id', $student->student_id)->where('minor_exam_id', EXAM_ID)->count() === 1);

    // a submission uuid from another attempt is refused
    [$status, ] = call('POST', '/api/student/attempts/' . $attemptId . '/finalize', [
        'submission_uuid' => 'not-this-attempts-uuid',
        'attachment_manifest' => [],
    ]);
    check('a foreign submission uuid is refused', $status === 409, 'got ' . $status);

    // ── 7. what the lab's sync screen reads back ──────────────────────────────
    say('');
    say('7. GET /api/student/attempts/status');
    [$status, $statusList] = call('GET', '/api/student/attempts/status?attempt_ids=' . $attemptId);
    check('200', $status === 200, 'got ' . $status);
    $item = ($statusList['data']['items'] ?? [])[0] ?? [];
    check('status is submitted', ($item['status'] ?? '') === 'submitted');
    check('the stored file is counted', (int) ($item['attachments_stored'] ?? 0) === 1);

    // ── 8. the exam list no longer offers it ──────────────────────────────────
    say('');
    say('8. GET /api/student/exams again');
    [, $list2] = call('GET', '/api/student/exams');
    $mine2 = collect($list2['data']['items'] ?? [])->firstWhere('exam_id', EXAM_ID);
    check('state is submitted', ($mine2['state'] ?? '') === 'submitted', 'state=' . ($mine2['state'] ?? '?'));
    check('the finished attempt is reported with it', ($mine2['attempt']['status'] ?? '') === 'submitted');
    [$status, ] = call('POST', '/api/student/exams/' . EXAM_ID . '/bundle', ['mode' => 'offline']);
    check('a second bundle download is refused', $status === 409, 'got ' . $status);

    // ── 9. the expiry sweep leaves an unsynced offline attempt alone ──────────
    say('');
    say('9. the server-side expiry sweep');
    DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->update([
        'status' => 'in_progress', 'ends_at' => now()->subHours(3), 'synced_at' => null, 'mode' => 'offline',
    ]);
    $closed = app(App\Services\OnlineExam\ExamResults::class)->closeExpired(SCHEMA, EXAM_ID);
    check('an unsynced offline attempt is not swept', DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->value('status') === 'in_progress', 'closeExpired closed ' . $closed);
    DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->update(['mode' => 'online']);
    app(App\Services\OnlineExam\ExamResults::class)->closeExpired(SCHEMA, EXAM_ID);
    check('an ordinary online attempt still is', DB::table('shulesoft.minor_exam_attempts')->where('id', $attemptId)->value('status') === 'timed_out');

    // ── 10. another student's token cannot touch this attempt ─────────────────
    say('');
    say('10. somebody else’s attempt');
    $other = DB::table('shulesoft.student as s')
        ->join('shulesoft.users as u', function ($j) {
            $j->on('u.id', '=', 's.student_id')->where('u.table', '=', 'student')->on('u.schema_name', '=', 's.schema_name');
        })
        ->where('s.schema_name', SCHEMA)->where('s.classesID', $subject->classesID)->where('s.status', 1)
        ->where('s.student_id', '<>', $student->student_id)->orderBy('s.student_id')->first(['s.student_id', 'u.sid']);
    $otherUser = App\Model\User::withoutGlobalScopes()->where('sid', $other->sid)->firstOrFail();
    $mineToken = $token;
    $token = $otherUser->createToken('exam-offline-pwa', ['exam-offline'])->plainTextToken;
    [$status, ] = call('POST', '/api/student/attempts/' . $attemptId . '/finalize', ['submission_uuid' => $uuid, 'attachment_manifest' => []]);
    check('another student gets 404, not the attempt', $status === 404, 'got ' . $status);
    [$status, $otherStatus] = call('GET', '/api/student/attempts/status?attempt_ids=' . $attemptId);
    check('and sees nothing of it in status', $status === 200 && count($otherStatus['data']['items'] ?? []) === 0);
    $token = $mineToken;

    say('');
    say(str_repeat('─', 60));
    say($fail === 0 ? "ALL $pass CHECKS PASSED" : "$pass passed, $fail FAILED");
} catch (\Throwable $e) {
    say('');
    say('EXCEPTION: ' . $e->getMessage());
    say('  at ' . $e->getFile() . ':' . $e->getLine());
    say($e->getTraceAsString());
    $fail++;
} finally {
    DB::rollBack();
    foreach ($createdFiles as $path) {
        @unlink($path);
    }
    @unlink(sys_get_temp_dir() . '/lab_e2e_upload.txt');

    // the transaction is gone; prove the school's data is as it was
    $left = DB::table('shulesoft.minor_exam_attempts')->where('schema_name', SCHEMA)->where('minor_exam_id', EXAM_ID)->count();
    $tokens = DB::table('shulesoft.personal_access_tokens')->where('name', 'exam-offline-pwa')->count();
    say('');
    say('rolled back · attempts left for this exam: ' . $left . ' · tokens left: ' . $tokens
        . ' · files left: ' . count(array_filter($createdFiles, 'is_file')));
}

exit($fail === 0 ? 0 : 1);
