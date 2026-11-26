<?php

/*
|--------------------------------------------------------------------------
| Offline exam PWA (exam.shulesoft.africa) — student API
|--------------------------------------------------------------------------
|
| Paste this block into routes/api.php. It adds routes only; nothing existing
| is touched. The shape follows the teacher app's block above it: Sanctum for
| the token, a middleware that proves the token belongs to an active student.
|
| The PWA at exam.shulesoft.africa is a different origin from the API, so the
| exam subdomain must be in config/cors.php `allowed_origins` with
| `allowed_headers` including `Idempotency-Key`. Tokens are bearer tokens in
| IndexedDB, not cookies, so `supports_credentials` can stay false.
*/

use App\Http\Controllers\Api\Student\OfflineExamController;
use App\Http\Controllers\Api\Student\StudentAuthController;

// Unauthenticated reachability probe. The PWA trusts this, not `navigator.onLine`:
// a lab switch leaves the NIC up with no route out.
Route::get('/health', [StudentAuthController::class, 'health'])->name('api.health');

Route::prefix('student')->name('api.student.')->group(function () {
    Route::post('/login', [StudentAuthController::class, 'login'])
        ->middleware('throttle:10,1')->name('login');

    Route::middleware(['auth:sanctum', \App\Http\Middleware\EnsureActiveStudent::class])->group(function () {
        Route::get('/me', [StudentAuthController::class, 'me'])->name('me');
        Route::post('/logout', [StudentAuthController::class, 'logout'])->name('logout');

        // Online, before the lab's internet is switched off.
        Route::get('/exams', [OfflineExamController::class, 'exams'])->name('exams');
        Route::post('/exams/{examId}/bundle', [OfflineExamController::class, 'bundle'])
            ->whereNumber('examId')->middleware('throttle:30,1')->name('exams.bundle');

        // Online again, after the sitting: the three sync stages, in this order.
        Route::post('/attempts/{attemptId}/submission', [OfflineExamController::class, 'submission'])
            ->whereNumber('attemptId')->middleware('throttle:60,1')->name('attempts.submission');
        Route::post('/attempts/{attemptId}/attachments', [OfflineExamController::class, 'attachment'])
            ->whereNumber('attemptId')->middleware('throttle:120,1')->name('attempts.attachments');
        Route::post('/attempts/{attemptId}/finalize', [OfflineExamController::class, 'finalize'])
            ->whereNumber('attemptId')->middleware('throttle:60,1')->name('attempts.finalize');

        Route::get('/attempts/status', [OfflineExamController::class, 'status'])->name('attempts.status');
    });
});
