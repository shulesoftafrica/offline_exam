<?php

namespace App\Http\Controllers\Api\Student;

use App\Http\Controllers\Controller;
use App\Model\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;

/**
 * Sanctum token issuance for the offline exam PWA (exam.shulesoft.africa).
 *
 * Deliberately the same shape as Api\TeacherAuthController: the credential check is the web
 * login's own `Auth::attempt` against the unified `shulesoft.users` view (so a student's
 * existing ShuleSoft username and password work unchanged, including however their password
 * happens to be hashed), and the session is then dropped in favour of a Sanctum token.
 *
 * Nothing about student credentials changes here. No new password, no new identity, no OTP.
 */
class StudentAuthController extends Controller
{
    /**
     * POST /api/student/login
     * Body: school (schema_name), username, password
     */
    public function login(Request $request)
    {
        $validator = Validator::make($request->all(), [
            'school'   => 'required|string|max:64',
            'username' => 'required|string|max:120',
            'password' => 'required|string|max:200',
        ]);
        if ($validator->fails()) {
            return response()->json(['success' => 0, 'message' => $validator->errors()->all()], 422);
        }

        $schema = trim((string) $request->input('school'));
        setSchema($schema);

        $username = trim((string) $request->input('username'));
        $password = (string) $request->input('password');

        // Username, then email: the same two paths the web login offers a student.
        $ok = Auth::attempt(['username' => $username, 'password' => $password])
            || Auth::attempt(['email' => $username, 'password' => $password]);

        if (!$ok) {
            DB::table('shulesoft.login_attempts')->insert([
                'username' => $username,
                'schema_name' => $schema,
            ]);

            return response()->json(['success' => 0, 'message' => ['Wrong username or password']], 401);
        }

        /** @var User $user */
        $user = Auth::user();
        Auth::logout();

        if (strtolower((string) $user->getTableName()) !== 'student') {
            return response()->json(['success' => 0, 'message' => ['This login is for students only.']], 403);
        }
        if ((string) $user->schema_name !== $schema) {
            return response()->json(['success' => 0, 'message' => ['Wrong username or password']], 401);
        }

        $student = DB::table('shulesoft.student')
            ->where('schema_name', $schema)
            ->where('student_id', (int) $user->id)
            ->where('status', 1)
            ->first(['student_id', 'name', 'username', 'photo', 'classesID', 'sectionID', 'academic_year_id']);

        if (!$student) {
            return response()->json([
                'success' => 0,
                'message' => ['Your account is not active. Please see the school office.'],
            ], 403);
        }

        // `exam-offline` ability, so a token from this app can never be used for anything
        // else that may be added to the student API later.
        $token = $user->createToken('exam-offline-pwa', ['exam-offline'])->plainTextToken;

        return response()->json([
            'success' => 1,
            'data' => [
                'token' => $token,
                'student' => $this->profile($schema, $student),
                'server_time' => now()->toIso8601String(),
            ],
        ]);
    }

    /** GET /api/student/me — revalidates a cached token when a lab machine comes back online. */
    public function me(Request $request)
    {
        $user = $request->user();
        $schema = (string) $user->schema_name;
        $student = DB::table('shulesoft.student')
            ->where('schema_name', $schema)
            ->where('student_id', (int) $user->id)
            ->first(['student_id', 'name', 'username', 'photo', 'classesID', 'sectionID', 'academic_year_id']);

        if (!$student) {
            return response()->json(['success' => 0, 'message' => ['Student not found.']], 404);
        }

        return response()->json([
            'success' => 1,
            'data' => [
                'student' => $this->profile($schema, $student),
                'server_time' => now()->toIso8601String(),
            ],
        ]);
    }

    /** POST /api/student/logout — revokes only the token that made this request. */
    public function logout(Request $request)
    {
        $request->user()->currentAccessToken()->delete();

        return response()->json(['success' => 1, 'data' => ['ok' => true]]);
    }

    /** GET /api/health — unauthenticated reachability probe used by the PWA. */
    public function health()
    {
        return response()
            ->json(['success' => 1, 'data' => ['ok' => true, 'server_time' => now()->toIso8601String()]])
            ->header('Cache-Control', 'no-store, max-age=0');
    }

    private function profile(string $schema, object $student): array
    {
        $setting = DB::table('shulesoft.setting')->where('schema_name', $schema)->first(['sname']);
        $class = DB::table('shulesoft.classes')->where('schema_name', $schema)
            ->where('classesID', $student->classesID)->value('classes');
        $section = DB::table('shulesoft.section')->where('schema_name', $schema)
            ->where('sectionID', $student->sectionID)->value('section');

        return [
            'student_id' => (int) $student->student_id,
            'name' => (string) $student->name,
            'username' => (string) ($student->username ?? ''),
            'schema_name' => $schema,
            'school_name' => (string) ($setting->sname ?? ''),
            'class' => $class ? (string) $class : null,
            'section' => $section ? (string) $section : null,
            'photo' => $student->photo ? url('storage/uploads/images/' . $student->photo) : null,
        ];
    }
}
