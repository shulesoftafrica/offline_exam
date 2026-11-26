<?php

/**
 * POST /api/student/login against the real users view, with a password set and then rolled
 * back. Nothing is committed: no student's real password is touched, and the test's own
 * password never exists outside this transaction.
 */

// The Laravel app this checks. Override with the SHULESOFT_PATH environment variable.
$base = rtrim(getenv('SHULESOFT_PATH') ?: 'C:/xampp/htdocs/shulesoft_newversion', '/');
require $base . '/vendor/autoload.php';

/** @var Illuminate\Foundation\Application $app */
$app = require_once $base . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

// A school to borrow one student from. Pass your own: php student_login.php <schema>
define('SCHEMA', $argv[1] ?? 'akilistars');
const SECRET = 'e2e-only-never-committed';

setSchema(SCHEMA);
$httpKernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$pass = 0;
$fail = 0;

function check(string $what, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    $ok ? $pass++ : $fail++;
    printf("  %s %s%s\n", $ok ? '[ok]  ' : '[FAIL]', $what, $detail !== '' ? '  — ' . $detail : '');
}

function call(string $method, string $uri, array $body = [], ?string $token = null): array
{
    global $httpKernel, $app;
    $app['auth']->forgetGuards();
    $server = ['HTTP_ACCEPT' => 'application/json', 'HTTP_HOST' => 'exam.shulesoft.africa'];
    if ($token !== null) {
        $server['HTTP_AUTHORIZATION'] = 'Bearer ' . $token;
    }
    $request = Request::create($uri, $method, [], [], [], $server, $body ? json_encode($body) : null);
    if ($body) {
        $request->headers->set('Content-Type', 'application/json');
        $request->server->set('CONTENT_TYPE', 'application/json');
    }
    $response = $httpKernel->handle($request);
    $decoded = json_decode((string) $response->getContent(), true);

    return [$response->getStatusCode(), is_array($decoded) ? $decoded : ['raw' => (string) $response->getContent()]];
}

DB::beginTransaction();

try {
    $student = DB::table('shulesoft.student')->where('schema_name', SCHEMA)->where('status', 1)
        ->whereNotNull('username')->orderBy('student_id')->first(['student_id', 'name', 'username']);
    DB::table('shulesoft.student')->where('schema_name', SCHEMA)->where('student_id', $student->student_id)
        ->update(['password' => Hash::make(SECRET)]);

    echo "Student " . $student->student_id . " · " . $student->username . " (" . SCHEMA . ")\n\n";

    echo "1. the right password\n";
    [$status, $ok] = call('POST', '/api/student/login', [
        'school' => SCHEMA, 'username' => $student->username, 'password' => SECRET,
    ]);
    check('200', $status === 200, 'got ' . $status . ' ' . json_encode($ok['message'] ?? ''));
    $token = (string) ($ok['data']['token'] ?? '');
    check('a token came back', $token !== '');
    $profile = $ok['data']['student'] ?? [];
    check('the student id is theirs', (int) ($profile['student_id'] ?? 0) === (int) $student->student_id);
    check('the school name is filled in', ($profile['school_name'] ?? '') !== '');
    check('the class is filled in', ($profile['class'] ?? null) !== null, 'class=' . json_encode($profile['class'] ?? null));
    check('the server time came with it', !empty($ok['data']['server_time']));
    check('the password is not echoed anywhere', !str_contains(strtolower(json_encode($ok)), 'password'));

    echo "\n2. that token works on the exam endpoints\n";
    [$status, $me] = call('GET', '/api/student/me', [], $token);
    check('GET /me is 200', $status === 200, 'got ' . $status);
    check('and names the same student', (int) ($me['data']['student']['student_id'] ?? 0) === (int) $student->student_id);
    [$status, ] = call('GET', '/api/student/exams', [], $token);
    check('GET /exams is 200', $status === 200, 'got ' . $status);

    echo "\n3. the wrong password\n";
    [$status, $bad] = call('POST', '/api/student/login', [
        'school' => SCHEMA, 'username' => $student->username, 'password' => 'not the password',
    ]);
    check('401', $status === 401, 'got ' . $status);
    check('and says so plainly', str_contains(strtolower(json_encode($bad['message'] ?? [])), 'wrong username or password'));
    check('the attempt is logged for the school', DB::table('shulesoft.login_attempts')->where('schema_name', SCHEMA)->where('username', $student->username)->exists());

    echo "\n4. the awkward cases\n";
    [$status, ] = call('POST', '/api/student/login', ['school' => SCHEMA, 'username' => $student->username]);
    check('a missing password is 422', $status === 422, 'got ' . $status);
    [$status, ] = call('POST', '/api/student/login', ['school' => 'no_such_school', 'username' => $student->username, 'password' => SECRET]);
    check('the wrong school cannot sign in', $status === 401, 'got ' . $status);

    // A teacher of the same school must not get through the student door.
    $teacher = DB::table('shulesoft.teacher')->where('schema_name', SCHEMA)->whereNotNull('username')
        ->orderBy('teacherID')->first(['teacherID', 'username']);
    if ($teacher) {
        DB::table('shulesoft.teacher')->where('schema_name', SCHEMA)->where('teacherID', $teacher->teacherID)
            ->update(['password' => Hash::make(SECRET)]);
        [$status, $refused] = call('POST', '/api/student/login', [
            'school' => SCHEMA, 'username' => $teacher->username, 'password' => SECRET,
        ]);
        check('a teacher is refused', $status === 403, 'got ' . $status);
        check('and told why', str_contains(strtolower(json_encode($refused['message'] ?? [])), 'students only'));
    }

    echo "\n5. logging out\n";
    [$status, ] = call('POST', '/api/student/logout', [], $token);
    check('200', $status === 200, 'got ' . $status);
    [$status, ] = call('GET', '/api/student/exams', [], $token);
    check('the token is dead afterwards', $status === 401, 'got ' . $status);

    echo "\n" . str_repeat('─', 60) . "\n";
    echo $fail === 0 ? "ALL $pass CHECKS PASSED\n" : "$pass passed, $fail FAILED\n";
} catch (\Throwable $e) {
    echo "\nEXCEPTION: " . $e->getMessage() . "\n  at " . $e->getFile() . ':' . $e->getLine() . "\n";
    echo $e->getTraceAsString() . "\n";
    $fail++;
} finally {
    DB::rollBack();
    // Prove the borrowed password is gone: the real hash is back, so SECRET no longer works.
    $live = DB::table('shulesoft.student')->where('schema_name', SCHEMA)->where('status', 1)
        ->whereNotNull('username')->orderBy('student_id')->first(['password']);
    echo "\nrolled back · the test password still works: "
        . (Hash::check(SECRET, (string) $live->password) ? 'YES — CHECK THIS' : 'no') . "\n";
}

exit($fail === 0 ? 0 : 1);
