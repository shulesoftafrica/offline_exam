<?php

namespace App\Http\Controllers\Api\Student;

use App\Http\Controllers\Controller;
use App\Services\OnlineExam\ExamGrader;
use App\Services\OnlineExam\ExamResults;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;

/**
 * Online exams sat offline, in a school computer lab, on exam.shulesoft.africa.
 *
 * The flow this serves (see the PWA's docs/ARCHITECTURE.md):
 *   1. while online: GET exams, POST bundle  → the whole exam goes to the browser
 *   2. the lab's internet is switched off    → the browser is on its own
 *   3. while offline: the student answers, attaches files and submits locally
 *   4. internet back on: POST submission → POST attachments → POST finalize
 *
 * Everything here is additive. It reads the same tables the web Online Exam module and the
 * parent app already use (`minor_exams`, `questions`, `valid_answers`, `student_assessment`,
 * `minor_exam_marks`, `minor_exam_attempts`), decides which exams a student may see with the
 * same rule as DigitalLearningExams, and marks through the one existing marking path,
 * ExamResults::finalizeAttempt(), so an offline attempt scores exactly as a phone attempt
 * would. The answer key (`valid_answers.status`) never leaves the server.
 *
 * Three properties the lab depends on:
 *  - **Idempotency.** Every write endpoint keys off `submission_uuid` (issued here, stored on
 *    the attempt) or a file's SHA-256, so a retry over flaky lab Wi-Fi is a no-op rather than
 *    a duplicate.
 *  - **Staged acceptance.** Answers first, then files, then finalize; finalize refuses while
 *    a declared file is missing, so an attempt is never marked complete with half its work.
 *  - **Offline tolerance.** An `offline` attempt gets a generous server window and is not
 *    swept as timed out while it is unsynced; the browser's own timing arrives with the
 *    submission and is compared, not trusted blindly.
 */
class OfflineExamController extends Controller
{
    /** Extra server-side head-room on an offline attempt's window, on top of the duration. */
    private const OFFLINE_WINDOW_HOURS = 12;

    /** A client elapsed time this far beyond the allowed duration is logged for the school. */
    private const OVERRUN_TOLERANCE_SECONDS = 120;

    /** Exams with no duration set get this many minutes, as the parent app does. */
    private const DEFAULT_MINUTES = 60;

    // ── Endpoints ─────────────────────────────────────────────────────────────

    /** GET /api/student/exams */
    public function exams(Request $request)
    {
        $student = $this->student($request);
        $subjects = $this->subjects($student);
        $rows = $this->examQuery($student, $subjects)
            ->orderByDesc('m.date')->orderByDesc('m.id')->limit(60)->get();

        return $this->ok(['items' => $this->items($student, $subjects, $rows)]);
    }

    /**
     * POST /api/student/exams/{examId}/bundle
     *
     * The one call that must happen while the lab is still online. Creates (or returns) the
     * student's single attempt and hands back everything needed to sit the exam with no
     * network at all.
     */
    public function bundle(Request $request, $examId)
    {
        $student = $this->student($request);
        $subjects = $this->subjects($student);
        $examId = (int) $examId;

        $exam = $this->examQuery($student, $subjects)->where('m.id', $examId)->first();
        if (!$exam) {
            return $this->fail(['You do not have access to this exam.'], 404);
        }

        $item = $this->items($student, $subjects, collect([$exam]))[0];
        if (!in_array($item['state'], ['available', 'in_progress'], true)) {
            $messages = [
                'upcoming' => 'This exam opens on ' . ($item['date_text'] ?? 'its date') . '.',
                'not_ready' => 'The questions of this exam are not ready yet.',
                'submitted' => 'This exam has already been taken.',
            ];

            return $this->fail([$messages[$item['state']] ?? 'This exam cannot be started.'], 409);
        }

        $mode = $request->input('mode') === 'online' ? 'online' : 'offline';
        $deviceId = substr((string) $request->input('device_id', ''), 0, 64);
        $minutes = (int) $exam->total_time > 0 ? (int) $exam->total_time : self::DEFAULT_MINUTES;
        $durationSeconds = $minutes * 60;

        $attempt = $this->attemptFor($student, $examId);
        if (!$attempt) {
            $now = now();
            // An offline attempt's server window covers the whole sitting plus the time the
            // lab may stay offline afterwards; the countdown itself is enforced in the
            // browser and re-checked when the submission arrives.
            $endsAt = $mode === 'offline'
                ? $now->copy()->addMinutes($minutes)->addHours(self::OFFLINE_WINDOW_HOURS)
                : $now->copy()->addMinutes($minutes);

            try {
                DB::table('shulesoft.minor_exam_attempts')->insert([
                    'schema_name' => $student->schema_name,
                    'minor_exam_id' => $examId,
                    'student_id' => (int) $student->student_id,
                    'started_at' => $now,
                    'ends_at' => $endsAt,
                    'status' => 'in_progress',
                    'mode' => $mode,
                    'submission_uuid' => (string) Str::uuid(),
                    'device_id' => $deviceId ?: null,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            } catch (\Throwable $e) {
                // Two machines, or two taps: the unique key keeps one attempt, which is the
                // one we then read back.
                Log::info('Offline exam: attempt already started: ' . $e->getMessage());
            }
            $attempt = $this->attemptFor($student, $examId);
        }

        if (!$attempt) {
            return $this->fail(['The exam could not be started. Please try again.'], 503);
        }
        if ($attempt->status !== 'in_progress') {
            return $this->fail(['This exam has already been taken.'], 409);
        }

        // An attempt started on a phone and resumed in the lab (or the reverse) keeps its
        // identity; only the mode and the window are widened.
        if ($mode === 'offline' && ($attempt->mode ?? 'online') !== 'offline') {
            DB::table('shulesoft.minor_exam_attempts')->where('id', $attempt->id)->update([
                'mode' => 'offline',
                'ends_at' => Carbon::parse($attempt->ends_at)->addHours(self::OFFLINE_WINDOW_HOURS),
                'device_id' => $deviceId ?: $attempt->device_id,
                'updated_at' => now(),
            ]);
            $attempt = $this->attemptFor($student, $examId);
        }
        if (empty($attempt->submission_uuid)) {
            DB::table('shulesoft.minor_exam_attempts')->where('id', $attempt->id)
                ->update(['submission_uuid' => (string) Str::uuid(), 'updated_at' => now()]);
            $attempt = $this->attemptFor($student, $examId);
        }

        [$questions, $media, $totalWeight] = $this->questionsPayload($student, $examId);

        $examPayload = [
            'exam_id' => $examId,
            'title' => $this->title($exam),
            'subject' => (string) ($subjects[$exam->subject_id] ?? ''),
            'subject_id' => (int) $exam->subject_id,
            'instructions' => ExamGrader::plain($exam->note ?? ''),
            'date' => $exam->date ? substr((string) $exam->date, 0, 10) : null,
            'minutes' => $minutes,
            'question_count' => count($questions),
            'total_weight' => $totalWeight,
        ];

        return $this->ok([
            'attempt' => [
                'attempt_id' => (int) $attempt->id,
                'submission_uuid' => (string) $attempt->submission_uuid,
                'mode' => (string) ($attempt->mode ?? 'online'),
                'status' => (string) $attempt->status,
                'started_at' => Carbon::parse($attempt->started_at)->toIso8601String(),
                'ends_at' => Carbon::parse($attempt->ends_at)->toIso8601String(),
                'duration_seconds' => $durationSeconds,
                'submitted_at' => $attempt->submitted_at ? Carbon::parse($attempt->submitted_at)->toIso8601String() : null,
                'synced_at' => $attempt->synced_at ? Carbon::parse($attempt->synced_at)->toIso8601String() : null,
            ],
            'exam' => $examPayload,
            'attachment_rules' => $this->attachmentRules($questions),
            'questions' => $questions,
            'media' => $media,
            // The client recomputes this over the canonical {exam, questions} payload and
            // refuses to start the exam if it disagrees.
            'bundle_checksum' => $this->bundleChecksum($examPayload, $questions),
            'issued_at' => now()->toIso8601String(),
        ]);
    }

    /**
     * POST /api/student/attempts/{attemptId}/submission   (stage 0)
     * Header: Idempotency-Key: attempt:{attempt_id}:{submission_uuid}
     *
     * Writes the answers into `student_assessment` exactly as the web module does, records
     * what the browser measured, and leaves the attempt `syncing` until finalize.
     */
    public function submission(Request $request, $attemptId)
    {
        $student = $this->student($request);
        $attempt = $this->attemptById($student, (int) $attemptId);
        if (!$attempt) {
            return $this->fail(['Exam attempt not found.'], 404);
        }

        $validator = Validator::make($request->all(), [
            'submission_uuid' => 'required|string|max:64',
            'answer_checksum' => 'nullable|string|max:80',
            'client_started_at' => 'nullable|date',
            'client_submitted_at' => 'nullable|date',
            'client_elapsed_seconds' => 'nullable|integer|min:0',
            'device_id' => 'nullable|string|max:64',
            'answers' => 'present|array|max:500',
            'answers.*.question_id' => 'required|integer|min:1',
            'answers.*.option_id' => 'nullable|integer|min:0',
            'answers.*.text' => 'nullable|string|max:8000',
            'attachment_manifest' => 'present|array|max:200',
            'attachment_manifest.*.question_id' => 'required|integer|min:1',
            'attachment_manifest.*.sha256' => 'required|string|size:64',
        ]);
        if ($validator->fails()) {
            return $this->fail($validator->errors()->all(), 422);
        }

        if ((string) $attempt->submission_uuid !== (string) $request->input('submission_uuid')) {
            return $this->fail(['This submission does not belong to that attempt.'], 409);
        }

        // Already accepted and closed: a replay must change nothing.
        if (in_array($attempt->status, ['submitted', 'timed_out'], true) && $attempt->synced_at) {
            return $this->ok([
                'accepted' => 0,
                'attempt_status' => (string) $attempt->status,
                'missing_attachments' => [],
                'already_synced' => true,
                'code' => 'already_synced',
            ]);
        }

        $questions = DB::table('shulesoft.questions')
            ->where('schema_name', $student->schema_name)
            ->where('minor_exam_id', (int) $attempt->minor_exam_id)
            ->get(['id', 'type', 'weight'])
            ->keyBy('id');
        if ($questions->isEmpty()) {
            return $this->fail(['This exam has no questions.'], 409);
        }

        $answerIds = collect($request->input('answers', []))->pluck('question_id')->map(fn($v) => (int) $v)->all();
        $options = $this->answerOptions($student->schema_name, $answerIds);

        $accepted = 0;
        DB::transaction(function () use ($request, $student, $attempt, $questions, $options, &$accepted) {
            foreach ($request->input('answers', []) as $answer) {
                $questionId = (int) ($answer['question_id'] ?? 0);
                $question = $questions->get($questionId);
                if (!$question) {
                    continue; // a question that is not part of this exam is ignored, not fatal
                }

                $kind = ExamGrader::kind((array) $question, $options[$questionId] ?? []);
                $optionId = isset($answer['option_id']) ? (int) $answer['option_id'] : 0;
                $text = trim(strip_tags((string) ($answer['text'] ?? '')));

                $values = ['valid_answer_id' => null, 'student_answer' => null];
                if ($kind === ExamGrader::CHOICE && $optionId > 0) {
                    $belongs = collect($options[$questionId] ?? [])
                        ->contains(fn($o) => (int) $o['id'] === $optionId);
                    if (!$belongs) {
                        continue; // an option from another question is dropped, as the web does
                    }
                    $values['valid_answer_id'] = $optionId;
                } elseif ($text !== '') {
                    $values['student_answer'] = $text;
                } elseif ($kind !== ExamGrader::UPLOAD) {
                    continue; // nothing to store for this question
                }

                $where = [
                    'schema_name' => $student->schema_name,
                    'student_id' => (int) $student->student_id,
                    'question_id' => $questionId,
                ];
                $existing = DB::table('shulesoft.student_assessment')->where($where)->first();
                if ($existing) {
                    // A score a teacher typed by hand is never overwritten by a sync.
                    DB::table('shulesoft.student_assessment')->where('id', $existing->id)
                        ->update($values + ['updated_at' => now()]);
                } else {
                    DB::table('shulesoft.student_assessment')
                        ->insert($where + $values + ['created_at' => now(), 'updated_at' => now()]);
                }
                $accepted += 1;
            }

            $manifest = collect($request->input('attachment_manifest', []));
            $elapsed = $request->input('client_elapsed_seconds');
            DB::table('shulesoft.minor_exam_attempts')->where('id', $attempt->id)->update([
                'status' => 'syncing',
                'answer_checksum' => (string) $request->input('answer_checksum', '') ?: null,
                'client_started_at' => $request->input('client_started_at')
                    ? Carbon::parse($request->input('client_started_at')) : null,
                'client_submitted_at' => $request->input('client_submitted_at')
                    ? Carbon::parse($request->input('client_submitted_at')) : null,
                'client_elapsed_seconds' => $elapsed === null ? null : (int) $elapsed,
                'attachment_count' => $manifest->count(),
                'device_id' => substr((string) $request->input('device_id', (string) $attempt->device_id), 0, 64) ?: null,
                'updated_at' => now(),
            ]);
        });

        $this->logTiming($attempt, $request);

        return $this->ok([
            'accepted' => $accepted,
            'attempt_status' => 'syncing',
            'missing_attachments' => $this->missingAttachments($student, (int) $attempt->id, $request->input('attachment_manifest', [])),
            'already_synced' => false,
        ]);
    }

    /**
     * POST /api/student/attempts/{attemptId}/attachments   (stage 1, multipart/form-data)
     * Header: Idempotency-Key: attach:{attempt_id}:{question_id}:{sha256}
     *
     * Stores one answer file where the web module stores them, and writes `attach` /
     * `attach_file_name` onto the student's `student_assessment` row. The stored filename
     * contains the digest, so a retried upload is recognised without a new table.
     */
    public function attachment(Request $request, $attemptId)
    {
        $student = $this->student($request);
        $attempt = $this->attemptById($student, (int) $attemptId);
        if (!$attempt) {
            return $this->fail(['Exam attempt not found.'], 404);
        }

        $validator = Validator::make($request->all(), [
            'submission_uuid' => 'required|string|max:64',
            'question_id' => 'required|integer|min:1',
            'sha256' => 'required|string|size:64',
            'file' => 'required|file|max:' . (int) (10 * 1024), // kilobytes
        ]);
        if ($validator->fails()) {
            return $this->fail($validator->errors()->all(), 422);
        }
        if ((string) $attempt->submission_uuid !== (string) $request->input('submission_uuid')) {
            return $this->fail(['This upload does not belong to that attempt.'], 409);
        }

        $questionId = (int) $request->input('question_id');
        $question = DB::table('shulesoft.questions')
            ->where('schema_name', $student->schema_name)
            ->where('minor_exam_id', (int) $attempt->minor_exam_id)
            ->where('id', $questionId)
            ->first(['id']);
        if (!$question) {
            return $this->fail(['That question is not part of this exam.'], 422);
        }

        $file = $request->file('file');
        $digest = strtolower((string) $request->input('sha256'));
        $actual = hash_file('sha256', $file->getRealPath());
        if (!hash_equals($digest, (string) $actual)) {
            // The bytes that arrived are not the bytes the client hashed: a truncated upload.
            // Retryable, so the client keeps the file and tries again.
            return $this->fail(['The uploaded file was incomplete. Please try again.'], 422);
        }

        $extension = strtolower((string) ($file->getClientOriginalExtension() ?: $file->guessExtension() ?: 'bin'));
        if (!preg_match('/^[a-z0-9]{1,5}$/', $extension)) {
            return $this->fail(['That file type is not accepted.'], 422);
        }
        $name = 'attach_' . substr($digest, 0, 24) . '_' . $questionId . '.' . $extension;
        $directory = base_path() . '/storage/uploads/images/';
        $url = url('storage/uploads/images/' . $name);

        $duplicate = is_file($directory . $name);
        if (!$duplicate) {
            $file->move($directory, $name);
        }

        $where = [
            'schema_name' => $student->schema_name,
            'student_id' => (int) $student->student_id,
            'question_id' => $questionId,
        ];
        $existing = DB::table('shulesoft.student_assessment')->where($where)->first();
        $patch = [
            'attach' => substr((string) $file->getClientOriginalName() ?: $name, 0, 190),
            'attach_file_name' => $url,
            'updated_at' => now(),
        ];
        if ($existing) {
            DB::table('shulesoft.student_assessment')->where('id', $existing->id)->update($patch);
        } else {
            DB::table('shulesoft.student_assessment')->insert($where + $patch + ['created_at' => now()]);
        }

        return $this->ok([
            'stored' => true,
            'duplicate' => $duplicate,
            'question_id' => $questionId,
            'attach' => $patch['attach'],
            'attach_file_name' => $url,
        ]);
    }

    /**
     * POST /api/student/attempts/{attemptId}/finalize   (stage 2)
     * Header: Idempotency-Key: final:{attempt_id}:{submission_uuid}
     *
     * Marks and closes the attempt through ExamResults::finalizeAttempt() — the single
     * existing marking path — so the teacher's results, `minor_exam_marks` and the
     * "still to mark" count all behave exactly as they do for a phone attempt.
     */
    public function finalize(Request $request, $attemptId)
    {
        $student = $this->student($request);
        $attempt = $this->attemptById($student, (int) $attemptId);
        if (!$attempt) {
            return $this->fail(['Exam attempt not found.'], 404);
        }

        $validator = Validator::make($request->all(), [
            'submission_uuid' => 'required|string|max:64',
            'answer_checksum' => 'nullable|string|max:80',
            'attachment_manifest' => 'present|array|max:200',
            'attachment_manifest.*.question_id' => 'required|integer|min:1',
            'attachment_manifest.*.sha256' => 'required|string|size:64',
        ]);
        if ($validator->fails()) {
            return $this->fail($validator->errors()->all(), 422);
        }
        if ((string) $attempt->submission_uuid !== (string) $request->input('submission_uuid')) {
            return $this->fail(['This submission does not belong to that attempt.'], 409);
        }

        $missing = $this->missingAttachments($student, (int) $attempt->id, $request->input('attachment_manifest', []));
        if (!empty($missing)) {
            return response()->json([
                'success' => 0,
                'message' => [count($missing) . ' answer file(s) have not arrived yet.'],
                'data' => ['code' => 'missing_attachments', 'missing_attachments' => $missing],
            ], 409);
        }

        if ($attempt->status === 'in_progress' || $attempt->status === 'syncing') {
            // finalizeAttempt() expects an in_progress row (it locks and re-reads it), so an
            // attempt parked in `syncing` is put back for the one statement that closes it.
            DB::table('shulesoft.minor_exam_attempts')->where('id', $attempt->id)
                ->update(['status' => 'in_progress', 'updated_at' => now()]);
            $attempt = $this->attemptById($student, (int) $attempt->id);

            if (!app(ExamResults::class)->finalizeAttempt($attempt, 'submitted')) {
                DB::table('shulesoft.minor_exam_attempts')->where('id', $attempt->id)
                    ->update(['status' => 'syncing', 'updated_at' => now()]);

                return $this->fail(
                    ['Your answers are saved, but the exam could not be closed just now. Please sync again.'],
                    503,
                );
            }
        }

        DB::table('shulesoft.minor_exam_attempts')->where('id', $attempt->id)->update([
            'synced_at' => now(),
            'answer_checksum' => (string) $request->input('answer_checksum', (string) $attempt->answer_checksum) ?: null,
            'updated_at' => now(),
        ]);

        $closed = $this->attemptById($student, (int) $attempt->id);
        $exam = DB::table('shulesoft.minor_exams')->where('schema_name', $student->schema_name)
            ->where('id', (int) $attempt->minor_exam_id)->first(['publish_result']);

        return $this->ok([
            'attempt_status' => (string) ($closed->status ?? 'submitted'),
            'synced_at' => Carbon::parse($closed->synced_at ?? now())->toIso8601String(),
            'auto_score' => (float) ($closed->auto_score ?? 0),
            'total_weight' => (float) ($closed->total_weight ?? 0),
            'pending_review' => (int) ($closed->pending_review ?? 0),
            'results_released' => (int) ($exam->publish_result ?? 0) === 1,
        ]);
    }

    /** GET /api/student/attempts/status?attempt_ids=551,552 */
    public function status(Request $request)
    {
        $student = $this->student($request);
        $ids = collect(explode(',', (string) $request->query('attempt_ids', '')))
            ->map(fn($v) => (int) trim($v))->filter()->take(100)->values()->all();
        if (!$ids) {
            return $this->ok(['items' => []]);
        }

        $attempts = DB::table('shulesoft.minor_exam_attempts')
            ->where('schema_name', $student->schema_name)
            ->where('student_id', (int) $student->student_id)
            ->whereIn('id', $ids)
            ->get();

        $items = [];
        foreach ($attempts as $attempt) {
            $stored = DB::table('shulesoft.student_assessment as a')
                ->join('shulesoft.questions as q', 'q.id', '=', 'a.question_id')
                ->where('a.schema_name', $student->schema_name)
                ->where('a.student_id', (int) $student->student_id)
                ->where('q.minor_exam_id', (int) $attempt->minor_exam_id)
                ->whereNotNull('a.attach_file_name')
                ->count();

            $items[] = [
                'attempt_id' => (int) $attempt->id,
                'status' => (string) $attempt->status,
                'synced_at' => $attempt->synced_at ? Carbon::parse($attempt->synced_at)->toIso8601String() : null,
                'attachments_stored' => $stored,
                'pending_review' => (int) ($attempt->pending_review ?? 0),
            ];
        }

        return $this->ok(['items' => $items]);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** The signed-in student's row. `EnsureActiveStudent` has already proved it exists. */
    private function student(Request $request): object
    {
        $user = $request->user();

        return DB::table('shulesoft.student')
            ->where('schema_name', (string) $user->schema_name)
            ->where('student_id', (int) $user->id)
            ->first(['student_id', 'name', 'classesID', 'sectionID', 'academic_year_id', 'schema_name']);
    }

    /** The student's subjects — the same rule as DigitalLearning::dlSubjects. */
    private function subjects(object $student): array
    {
        $took = DB::table('shulesoft.subject_student')->where('schema_name', $student->schema_name)
            ->where('student_id', $student->student_id)->select('subject_id');

        return DB::table('shulesoft.subject')->where('schema_name', $student->schema_name)
            ->where('classesID', $student->classesID)
            ->where(fn($q) => $q->whereRaw("coalesce(lower(subject_type), 'core') <> 'option'")
                ->orWhereIn('subjectID', $took))
            ->pluck('subject', 'subjectID')->all();
    }

    /** Published exams of the student's subjects — DigitalLearningExams::dleExamQuery. */
    private function examQuery(object $student, array $subjects)
    {
        return DB::table('shulesoft.minor_exams as m')
            ->leftJoin('shulesoft.exam_groups as g', function ($j) {
                $j->on('g.id', '=', 'm.exam_group_id')->on('g.schema_name', '=', 'm.schema_name');
            })
            ->where('m.schema_name', $student->schema_name)
            ->where('m.publish_exam', 1)
            ->whereIn('m.subject_id', array_keys($subjects) ?: [0])
            ->select('m.id', 'm.subject_id', 'm.date', 'm.total_time', 'm.total_question', 'm.publish_result', 'm.note', 'g.name as group_name');
    }

    private function title(object $exam): string
    {
        $t = trim((string) ($exam->group_name ?? ''));

        return $t !== '' ? $t : 'Online exam';
    }

    private function attemptFor(object $student, int $examId): ?object
    {
        return DB::table('shulesoft.minor_exam_attempts')
            ->where('schema_name', $student->schema_name)
            ->where('student_id', (int) $student->student_id)
            ->where('minor_exam_id', $examId)
            ->first() ?: null;
    }

    private function attemptById(object $student, int $attemptId): ?object
    {
        return DB::table('shulesoft.minor_exam_attempts')
            ->where('id', $attemptId)
            ->where('schema_name', $student->schema_name)
            ->where('student_id', (int) $student->student_id)
            ->first() ?: null;
    }

    /** `valid_answers` by question id, **without** the status column. */
    private function answerOptions(string $schema, array $questionIds): array
    {
        $out = [];
        if (!$questionIds) {
            return $out;
        }
        $rows = DB::table('shulesoft.valid_answers')->where('schema_name', $schema)
            ->whereIn('question_id', $questionIds)->orderBy('id')->get(['id', 'question_id', 'answer', 'status']);
        foreach ($rows as $row) {
            $out[(int) $row->question_id][] = [
                'id' => (int) $row->id,
                'answer' => (string) $row->answer,
                'status' => $row->status, // used only server-side, by ExamGrader::kind()
            ];
        }

        return $out;
    }

    /**
     * The exam's questions for the bundle: every question, its options **with no answer
     * key**, and the pictures to cache. Shuffling is deliberately not done here — a paper
     * exam in a lab is invigilated, and a stable order is what makes "question 4" mean the
     * same thing to the student and the invigilator.
     *
     * @return array{0: array<int, array>, 1: array<int, array>, 2: float}
     */
    private function questionsPayload(object $student, int $examId): array
    {
        $hasGroups = Schema::hasColumn('shulesoft.questions', 'group_ref');
        $columns = ['id', 'question', 'type', 'weight', 'attach'];
        if ($hasGroups) {
            $columns[] = 'group_ref';
            $columns[] = 'part_label';
        }

        $rows = DB::table('shulesoft.questions')
            ->where('schema_name', $student->schema_name)
            ->where('minor_exam_id', $examId)
            ->orderBy('id')
            ->get($columns);

        $options = $this->answerOptions($student->schema_name, $rows->pluck('id')->map(fn($v) => (int) $v)->all());

        $questions = [];
        $media = [];
        $totalWeight = 0.0;

        foreach ($rows as $index => $row) {
            $opts = $options[(int) $row->id] ?? [];
            $kind = ExamGrader::kind((array) $row, $opts);
            $imageUrl = $this->imageUrl((string) ($row->attach ?? ''));
            $totalWeight += (float) $row->weight;

            $questions[] = [
                'question_id' => (int) $row->id,
                'number' => $hasGroups && !empty($row->part_label)
                    ? ($index + 1) . strtolower(trim((string) $row->part_label, '()'))
                    : (string) ($index + 1),
                'kind' => $kind,
                'text' => ExamGrader::plain($row->question),
                'weight' => (int) $row->weight,
                'image_url' => $imageUrl,
                'max_chars' => $kind === ExamGrader::WRITTEN ? 4000 : null,
                'group_ref' => $hasGroups ? ($row->group_ref ?: null) : null,
                'part_label' => $hasGroups ? ($row->part_label ?: null) : null,
                'input_hint' => $this->inputHint((int) ($row->type ?? 0), $kind),
                // The answer key never leaves the server: only ids and texts go out.
                'options' => $kind === ExamGrader::CHOICE
                    ? array_map(fn($o) => ['option_id' => $o['id'], 'text' => ExamGrader::plain($o['answer'])], $opts)
                    : [],
            ];

            if ($imageUrl) {
                $media[] = ['url' => $imageUrl, 'question_id' => (int) $row->id, 'bytes' => null];
            }
        }

        return [$questions, $media, $totalWeight];
    }

    /**
     * Which input the student should be given for a written answer. `questions.type` carries
     * more than the three kinds the web module's own form can create (1 multiple choice,
     * 2 fill-in-the-blanks, 3 attach a picture): the AI exam generator also writes 4
     * true/false, 5 short answer, 6 matching and 7 essay — the map is in
     * `AIController::$typeMapping`.
     *
     * `ExamGrader::kind()` calls all of those `written`, because each stores one model answer
     * in `valid_answers` and is marked by comparing text. That is left exactly as it is: this
     * is only a hint about the input, so a true/false question gets True/False buttons
     * instead of an empty box a student has to guess the wording for. Nothing here reveals
     * the answer — both labels are sent for every one of them, and which is right stays in
     * `valid_answers.status`, server-side.
     */
    private function inputHint(int $type, string $kind): ?string
    {
        if ($kind !== ExamGrader::WRITTEN) {
            return null;
        }

        return match ($type) {
            4 => 'boolean',
            5 => 'short_text',
            7 => 'long_text',
            default => null,
        };
    }

    /** A picture on a question: a full link (S3) or a file of this server; images only. */
    private function imageUrl(string $attach): ?string
    {
        $attach = trim($attach);
        if ($attach === '' || !preg_match('/\.(jpe?g|png|gif|webp)(\?.*)?$/i', $attach)) {
            return null;
        }
        if (preg_match('#^https?://#i', $attach)) {
            return $attach;
        }

        return str_contains($attach, '..') ? null : url('storage/uploads/attach/' . basename($attach));
    }

    /**
     * Attachment rules the client enforces locally before a byte is written. Conservative on
     * purpose: a lab machine should refuse an oversized photograph immediately rather than at
     * sync time, hours later.
     *
     * @param array<int, array> $questions
     */
    private function attachmentRules(array $questions): array
    {
        $wantsFiles = collect($questions)->contains(fn($q) => $q['kind'] === ExamGrader::UPLOAD);

        return [
            'enabled' => $wantsFiles,
            'max_files_per_question' => 3,
            'max_file_bytes' => 10 * 1024 * 1024,
            'allowed_mime' => ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
        ];
    }

    /** SHA-256 over the canonical {exam, questions} payload; the client recomputes it. */
    private function bundleChecksum(array $exam, array $questions): string
    {
        return 'sha256:' . hash('sha256', $this->canonical(['exam' => $exam, 'questions' => $questions]));
    }

    /**
     * Canonical JSON: keys sorted, no insignificant whitespace, nulls kept. Must match
     * `src/core/util/checksum.ts#canonicalJson` in the PWA exactly, or no bundle verifies.
     */
    private function canonical($value): string
    {
        if (is_array($value)) {
            // An empty PHP array is ambiguous — it is both [] and {} — and `range(0, -1)`
            // is [0, -1], so the plain check below calls it an object and writes `{}`.
            // json_encode() puts `[]` on the wire for it, and that is what a client parsing
            // the response sees and hashes, so an empty array is a list here too. Without
            // this, every bundle holding a written question (`"options": []`) is signed with
            // a digest no client can reproduce.
            $isList = $value === [] || array_keys($value) === range(0, count($value) - 1);
            if ($isList) {
                return '[' . implode(',', array_map(fn($v) => $this->canonical($v), $value)) . ']';
            }
            ksort($value, SORT_STRING);
            $parts = [];
            foreach ($value as $key => $item) {
                $parts[] = json_encode((string) $key, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
                    . ':' . $this->canonical($item);
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

    /**
     * Which declared files are not on disk yet. The stored filename carries the digest, so
     * this needs no extra table and survives a partially completed sync.
     *
     * @param array<int, array> $manifest
     * @return array<int, array{question_id: int, sha256: string}>
     */
    private function missingAttachments(object $student, int $attemptId, array $manifest): array
    {
        if (!$manifest) {
            return [];
        }
        $directory = base_path() . '/storage/uploads/images/';
        $missing = [];
        foreach ($manifest as $entry) {
            $digest = strtolower((string) ($entry['sha256'] ?? ''));
            $questionId = (int) ($entry['question_id'] ?? 0);
            if ($digest === '' || $questionId === 0) {
                continue;
            }
            $prefix = 'attach_' . substr($digest, 0, 24) . '_' . $questionId . '.';
            $found = false;
            foreach (glob($directory . $prefix . '*') ?: [] as $_path) {
                $found = true;
                break;
            }
            if (!$found) {
                $missing[] = ['question_id' => $questionId, 'sha256' => $digest];
            }
        }
        unset($attemptId, $student);

        return $missing;
    }

    /**
     * How the exams list reads — the same states DigitalLearningExams produces, so the web
     * module, the parent app and the lab PWA never disagree about whether an exam is taken.
     *
     * @param \Illuminate\Support\Collection $exams
     * @return array<int, array>
     */
    private function items(object $student, array $subjects, $exams): array
    {
        $ids = $exams->pluck('id')->map(fn($v) => (int) $v)->all();
        if (!$ids) {
            return [];
        }

        $attempts = DB::table('shulesoft.minor_exam_attempts')
            ->where('schema_name', $student->schema_name)
            ->where('student_id', (int) $student->student_id)
            ->whereIn('minor_exam_id', $ids)
            ->get()->keyBy('minor_exam_id');

        // An attempt whose server window really has run out is closed here, EXCEPT an
        // offline attempt that has not synced: its answers are still on a lab machine and
        // closing it would mark an exam the student has actually finished as timed out.
        foreach ($attempts as $attempt) {
            $offlinePending = ($attempt->mode ?? 'online') === 'offline' && empty($attempt->synced_at);
            if ($attempt->status === 'in_progress' && !$offlinePending
                && Carbon::parse($attempt->ends_at)->lt(now())) {
                app(ExamResults::class)->finalizeAttempt($attempt, 'timed_out');
            }
        }
        $attempts = DB::table('shulesoft.minor_exam_attempts')
            ->where('schema_name', $student->schema_name)
            ->where('student_id', (int) $student->student_id)
            ->whereIn('minor_exam_id', $ids)
            ->get()->keyBy('minor_exam_id');

        $stats = DB::table('shulesoft.questions')
            ->where('schema_name', $student->schema_name)->whereIn('minor_exam_id', $ids)
            ->groupBy('minor_exam_id')
            ->selectRaw('minor_exam_id, count(*) n, coalesce(sum(weight), 0) w')
            ->get()->keyBy('minor_exam_id');

        $marks = DB::table('shulesoft.minor_exam_marks')
            ->where('schema_name', $student->schema_name)->where('student_id', (int) $student->student_id)
            ->whereIn('minor_exam_id', $ids)->get()->keyBy('minor_exam_id');

        $today = now()->toDateString();
        $out = [];

        foreach ($exams as $exam) {
            $id = (int) $exam->id;
            $attempt = $attempts[$id] ?? null;
            $questions = (int) ($stats[$id]->n ?? 0);
            $date = $exam->date ? substr((string) $exam->date, 0, 10) : null;
            $minutes = (int) $exam->total_time > 0 ? (int) $exam->total_time : self::DEFAULT_MINUTES;

            if ($attempt && $attempt->status === 'in_progress') {
                $state = 'in_progress';
            } elseif ($attempt || isset($marks[$id])) {
                $state = 'submitted';
            } elseif ($questions === 0) {
                $state = 'not_ready';
            } elseif ($date && $date > $today) {
                $state = 'upcoming';
            } else {
                $state = 'available';
            }

            $released = (int) $exam->publish_result === 1;
            $total = (float) ($stats[$id]->w ?? 0);

            $out[] = [
                'exam_id' => $id,
                'title' => $this->title($exam),
                'subject' => (string) ($subjects[$exam->subject_id] ?? ''),
                'subject_id' => (int) $exam->subject_id,
                'date' => $date,
                'date_text' => $date ? Carbon::parse($date)->format('j M Y') : null,
                'minutes' => $minutes,
                'questions' => $questions,
                'total_weight' => $total,
                'state' => $state,
                'results_released' => $released,
                'score' => $state === 'submitted' && $released && isset($marks[$id]) && $total > 0
                    ? round((float) $marks[$id]->mark / 100 * $total, 2) : null,
                'total' => $state === 'submitted' && $released ? $total : null,
                'attempt' => $attempt ? [
                    'attempt_id' => (int) $attempt->id,
                    'submission_uuid' => (string) ($attempt->submission_uuid ?? ''),
                    'mode' => (string) ($attempt->mode ?? 'online'),
                    'status' => (string) $attempt->status,
                    'started_at' => Carbon::parse($attempt->started_at)->toIso8601String(),
                    'ends_at' => Carbon::parse($attempt->ends_at)->toIso8601String(),
                    'duration_seconds' => $minutes * 60,
                    'submitted_at' => $attempt->submitted_at ? Carbon::parse($attempt->submitted_at)->toIso8601String() : null,
                    'synced_at' => $attempt->synced_at ? Carbon::parse($attempt->synced_at)->toIso8601String() : null,
                ] : null,
            ];
        }

        return $out;
    }

    /**
     * Records client timing that does not add up, for the school to look at. Never blocks a
     * submission: an unexplained clock is a question for an invigilator, not grounds for
     * throwing away a student's exam.
     */
    private function logTiming(object $attempt, Request $request): void
    {
        $elapsed = (int) $request->input('client_elapsed_seconds', 0);
        $allowed = Carbon::parse($attempt->ends_at)->diffInSeconds(Carbon::parse($attempt->started_at));
        $duration = DB::table('shulesoft.minor_exams')->where('schema_name', $attempt->schema_name)
            ->where('id', (int) $attempt->minor_exam_id)->value('total_time');
        $allowedSeconds = ((int) $duration > 0 ? (int) $duration : self::DEFAULT_MINUTES) * 60;

        if ($elapsed > $allowedSeconds + self::OVERRUN_TOLERANCE_SECONDS) {
            Log::warning('Offline exam: client reported more time than the exam allows', [
                'attempt_id' => (int) $attempt->id,
                'student_id' => (int) $attempt->student_id,
                'schema_name' => (string) $attempt->schema_name,
                'client_elapsed_seconds' => $elapsed,
                'allowed_seconds' => $allowedSeconds,
                'server_window_seconds' => $allowed,
                'device_id' => (string) $request->input('device_id', ''),
            ]);
        }
    }

    private function ok(array $data)
    {
        return response()->json(['success' => 1, 'data' => $data]);
    }

    private function fail(array $messages, int $status)
    {
        return response()->json(['success' => 0, 'message' => $messages], $status);
    }
}
