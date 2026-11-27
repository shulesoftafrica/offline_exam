# Deploying, and what is already deployed

Live since **27 November 2026**. This is the record of what runs where, how to update it,
and the one setting that still needs somebody with a Cloudflare login.

## What is where

| | |
|---|---|
| The app | `https://exam.shulesoft.africa` — the static build of this repository |
| The API | `https://ai.shulesoft.africa/api` — the Laravel app, the host the parent experience apps already call |
| Server | `hz-hel1`, `65.108.7.225`, nginx + php8.4-fpm, behind Cloudflare |
| App root | `/usr/share/nginx/html/exam_shulesoft` (owned `www-data`) |
| API root | `/usr/share/nginx/html/shulesoft_staging`, branch `ai_upgrades` |
| vhost | `/etc/nginx/conf.d/exam.shulesoft.africa.conf` |
| TLS | `/etc/ssl/hz/cloudflare-origin.crt`, a Cloudflare origin certificate covering `*.shulesoft.africa` |

Two hosts, so every call the app makes is cross-origin. That is the whole reason
`config/cors.php` and `HandleCors` exist on the API side.

## Still to do: one Cloudflare cache rule

**The only thing between this and a clean update story.** The origin sends
`Cache-Control: no-cache` for `/sw.js`; Cloudflare rewrites it to `max-age=14400`, because
the zone's Browser Cache TTL overrides the origin for static files:

```
origin : cache-control: no-cache
edge   : cache-control: max-age=14400
```

The service worker is how a lab machine learns a new version exists, so until this is
changed a deployment can take up to **four hours** to reach a machine that has the app
installed. Nothing else is affected: first install, sitting an exam and syncing all work.

In the Cloudflare dashboard for `shulesoft.africa`, **Caching → Cache Rules**, add a rule
matching `http.host eq "exam.shulesoft.africa" and (http.request.uri.path eq "/sw.js" or
http.request.uri.path eq "/index.html")` with **Browser TTL: respect origin** (bypassing the
cache entirely also works). Then re-check:

```powershell
curl -s -o /dev/null -D - https://exam.shulesoft.africa/sw.js | findstr /i cache-control
```

## Updating the app

```powershell
cd C:\xampp\htdocs\offline_exams; Move-Item .env.production.local .env.production.local.off; npm run build; Move-Item .env.production.local.off .env.production.local
```

The move is what makes the build point at the live API: `.env.production.local` is the
git-ignored override that keeps local builds on XAMPP, and Vite gives it the last word.
Check before uploading — this has to print the live host and nothing else:

```powershell
findstr /s /c:"https://ai.shulesoft.africa/api" dist\assets\*.js
```

Then upload. A single tar stream, because `scp -r` of the whole tree was reset mid-transfer
on this link and left a half-populated directory:

```powershell
tar -czf - -C dist --exclude=*.map . | ssh -i ~/.ssh/shulesoft_staging root@65.108.7.225 "tar -xzf - -C /usr/share/nginx/html/exam_shulesoft && chown -R www-data:www-data /usr/share/nginx/html/exam_shulesoft"
```

Uploading over the top is right: `index.html` is replaced, the new hashed assets land beside
the old ones, and a machine mid-exam keeps running from its own precache until the worker
offers the update. No nginx reload is needed — nothing about the server changed.

## Updating the API

As the release checklist says: pull, migrate by path, clear, reload.

```powershell
ssh -i ~/.ssh/shulesoft_staging root@65.108.7.225 "cd /usr/share/nginx/html/shulesoft_staging && git status --short && git pull --no-rebase origin ai_upgrades"
```

`git status --short` first, every time: this server carries its own commits (`composer.lock`
and `public/storage` as of this writing) and a pull is a merge, not a fast-forward.

```powershell
ssh -i ~/.ssh/shulesoft_staging root@65.108.7.225 "cd /usr/share/nginx/html/shulesoft_staging && php8.4 artisan migrate --path=database/migrations/<file>.php --force && php8.4 artisan route:clear && php8.4 artisan config:clear && php8.4 artisan view:clear && systemctl reload php8.4-fpm"
```

Never a bare `php artisan migrate`: that database has unrelated pending migrations, one of
which crashes.

## Checking it is really up

```powershell
curl -s https://ai.shulesoft.africa/api/health -H "Origin: https://exam.shulesoft.africa"
```

```powershell
curl -s -o /dev/null -D - -X OPTIONS https://ai.shulesoft.africa/api/student/login -H "Origin: https://exam.shulesoft.africa" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,idempotency-key"
```

Wanted: `200` with `{"ok":true}` and an `access-control-allow-origin` echoing the app's
origin; then `204` with `idempotency-key` among the allowed headers. A `302` to
`/install/index` means `AppServiceProvider::isStudentExamApiPath()` did not reach the
server — the installed-check resolves a school from the HTTP host and neither of these hosts
is a school's subdomain.

Then open `https://exam.shulesoft.africa` and look at the console: it should say the API
driver is `laravel` with the live base URL, connectivity `online` (which only happens if the
cross-origin health probe succeeded), and *"The exam app is installed and will work with the
internet off."* — that last line is the service worker, and it only appears over HTTPS.

## Three things that bit during the first deployment

**The subdomain was a wildcard.** `apps.conf` has `server_name *.shulesoft.africa`, so
`exam.shulesoft.africa` landed in the Laravel app, which treated it as an unknown school and
302'd every visitor to `www.shulesoft.africa`. The vhost names the host exactly; an exact
`server_name` beats a wildcard in nginx whatever the file order.

**nginx had no `.webmanifest` MIME type**, so the manifest went out as
`application/octet-stream` and the browser ignored it — no install prompt, no name, no icons.
The vhost sets `default_type application/manifest+json` for that one file.

**`config/` and `tests/Unit/` are git-ignored in the API repository**, so `config/cors.php`
and the two tests were force-added, as `config/ai_learning.php` and
`tests/Unit/Providers/AccountantApiInstalledCheckTest.php` already were. A deployment that
restores those ignore rules would quietly leave the API with no CORS headers at all, and the
app would fail at the login screen with nothing in the server log.

## Before the first real sitting

Nobody has signed in on the live site yet — that needs a real student's credentials. One dry
run on a lab machine, end to end (download, internet off, sit, submit, internet on, sync),
before a school uses this for an exam that counts. [`LAB_RUNBOOK.md`](LAB_RUNBOOK.md) is the
page to hand the invigilator.
