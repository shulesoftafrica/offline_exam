<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Offline exams in a computer lab: the columns an attempt needs when the internet is
 * switched off for the whole sitting and the answers arrive later.
 *
 * Additive and nullable throughout. Nothing existing changes meaning:
 *  - an attempt with no `mode` is an ordinary online attempt (default 'online'), exactly as
 *    the parent app creates it today;
 *  - the server keeps its own `started_at` / `ends_at`, and the `client_*` columns record
 *    what the browser measured, so the two can be compared instead of one being trusted;
 *  - `submission_uuid` is what makes a retried sync a no-op: the PWA sends the same uuid for
 *    the same submission however many times the lab's Wi-Fi drops mid-upload.
 *
 * Why the client needs to be believed at all: with the lab switched off there is no way to
 * ask the server what time it is, so the countdown is enforced in the browser (monotonic
 * clock + persisted checkpoints) and re-validated here on arrival. An attempt whose client
 * timing is implausible is flagged, not discarded — the answers are a student's work.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (!Schema::hasTable('shulesoft.minor_exam_attempts')) {
            return;
        }

        Schema::table('shulesoft.minor_exam_attempts', function (Blueprint $table) {
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'mode')) {
                $table->string('mode', 16)->default('online');          // online | offline
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'submission_uuid')) {
                $table->string('submission_uuid', 64)->nullable();      // idempotency key, server-issued
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'client_started_at')) {
                $table->timestamp('client_started_at')->nullable();
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'client_submitted_at')) {
                $table->timestamp('client_submitted_at')->nullable();
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'client_elapsed_seconds')) {
                $table->integer('client_elapsed_seconds')->nullable();
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'device_id')) {
                $table->string('device_id', 64)->nullable();            // which lab machine
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'answer_checksum')) {
                $table->string('answer_checksum', 80)->nullable();      // sha256: of the canonical payload
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'attachment_count')) {
                $table->smallInteger('attachment_count')->default(0);   // manifest size, so finalize can refuse a partial attempt
            }
            if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'synced_at')) {
                $table->timestamp('synced_at')->nullable();             // when the offline submission was accepted
            }
        });

        // One submission uuid per school. A replayed sync therefore cannot create a second
        // attempt even if the unique key on (schema, exam, student) were ever relaxed.
        $indexExists = DB::selectOne(
            "select 1 from pg_indexes where schemaname = 'shulesoft' and indexname = ?",
            ['minor_exam_attempts_submission_uuid_unique'],
        );
        if (!$indexExists) {
            DB::statement(
                'CREATE UNIQUE INDEX minor_exam_attempts_submission_uuid_unique
                 ON shulesoft.minor_exam_attempts (schema_name, submission_uuid)
                 WHERE submission_uuid IS NOT NULL',
            );
        }

        // Offline attempts that have not synced yet must not be swept as "timed out" while
        // the lab's internet is still off; see the note in backend-proposal/README.md about
        // ExamResults::closeExpired().
        if (!Schema::hasColumn('shulesoft.minor_exam_attempts', 'mode')) {
            return;
        }
        DB::statement(
            "CREATE INDEX IF NOT EXISTS minor_exam_attempts_mode_status_idx
             ON shulesoft.minor_exam_attempts (mode, status)",
        );
    }

    public function down(): void
    {
        if (!Schema::hasTable('shulesoft.minor_exam_attempts')) {
            return;
        }

        DB::statement('DROP INDEX IF EXISTS shulesoft.minor_exam_attempts_submission_uuid_unique');
        DB::statement('DROP INDEX IF EXISTS shulesoft.minor_exam_attempts_mode_status_idx');

        Schema::table('shulesoft.minor_exam_attempts', function (Blueprint $table) {
            foreach (
                [
                    'mode',
                    'submission_uuid',
                    'client_started_at',
                    'client_submitted_at',
                    'client_elapsed_seconds',
                    'device_id',
                    'answer_checksum',
                    'attachment_count',
                    'synced_at',
                ] as $column
            ) {
                if (Schema::hasColumn('shulesoft.minor_exam_attempts', $column)) {
                    $table->dropColumn($column);
                }
            }
        });
    }
};
