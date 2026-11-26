<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * `auth:sanctum` proves a token. This proves the token belongs to a student who is still
 * active in `shulesoft.student` — not a staff account, not a disabled one — and pins the
 * tenant schema for the rest of the request.
 *
 * Mirrors App\Http\Middleware\EnsureActiveTeacher, which does the same job for the teacher
 * app, so the two APIs behave identically when an account is deactivated mid-term.
 */
class EnsureActiveStudent
{
    public function handle(Request $request, Closure $next)
    {
        $user = $request->user();

        if (!$user || strtolower((string) $user->getTableName()) !== 'student') {
            return response()->json(['success' => 0, 'message' => ['This endpoint is for students only.']], 403);
        }

        $schema = (string) $user->schema_name;
        $active = DB::table('shulesoft.student')
            ->where('schema_name', $schema)
            ->where('student_id', (int) $user->id)
            ->where('status', 1)
            ->exists();

        if (!$active) {
            return response()->json([
                'success' => 0,
                'message' => ['Your account has been disabled. Please contact the school office.'],
            ], 403);
        }

        // Every query in the controllers names `shulesoft.` explicitly and filters by
        // schema_name, but the search path is set as well so any helper that relies on it
        // behaves as it does on the web.
        setSchema($schema);

        return $next($request);
    }
}
