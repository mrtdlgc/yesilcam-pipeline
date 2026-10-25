# Deploying Yeşilçam Revival

The default image targets a **CPU host with cloud transcription**. It includes Node 24, Python 3.12,
FFmpeg, yt-dlp with its matching EJS solver, and pinned Codex CLI 0.164.0. PyTorch/Silero and
faster-whisper are optional; Demucs is excluded. Direct ElevenLabs full-movie mode needs no local
neural models. Faster-whisper is optional. The Python stages remain Python; the application,
browser, orchestration, adapters, workers, and CLI tools are TypeScript.

GitHub Actions builds and smoke-tests the default cloud image on native ARM64 and x64 runners. The
target host, real account login, media playback and paid providers still need acceptance. Start with
the [ARM batch operation guide](BATCH_OPERATIONS.md), then use the acceptance checklist below.

## Native local Codex translation

The **Translations** page uses an installed Codex CLI and the server OS user's existing ChatGPT
login. It sends the complete SRT as one task, uses the subscription allowance, and never reads OAuth
tokens or switches to paid API-key translation. Sign in with `codex login` on that machine; set
`CODEX_BIN` to an absolute executable path for services with a restricted PATH. An optional
`CODEX_MODEL` sets the default; the frontend can choose a model per job without a rebuild.

`CODEX_TRANSLATION_TIMEOUT_MS` defaults to 1800000 (30 minutes). Job work files are under
`DATA_DIR/temp/JOB_ID`; Codex runtime logs and SQLite state are under `DATA_DIR/data/codex-runtime`.
Translation receipts, candidate results and source copies persist separately under
`DATA_DIR/data/translation-receipts/JOB_ID`, including after temporary-media cleanup. Completed
receipts from older jobs are preserved there before cleanup.

The image includes the CLI but no account credentials. Open a terminal in the running container as
UID 10001 and run `codex login --device-auth`, then `codex login status`. The image sets
`CODEX_HOME=/data/data/private/codex` so login refresh state survives redeployment. The
[official headless login guide](https://learn.chatgpt.com/docs/auth) explains enabling device login
and entering the one-time code in your browser. Native local installs keep using their normal
credential store. Never bake or paste OAuth tokens into the image or app.

The application performs structural verification and writes UTF-8 BOM / CRLF SRT output plus an
integrity/readability report. Model quality, context capacity, and account allowance still need
manual checks with a real film. The local integration was checked with a fake CLI, including the
authenticated queue, cancellation, output rejection and cached-result reuse; no inference request
was used for that validation.

## Coolify setup

1. Select the **Dockerfile** build pack for this repository, with the root build context and
   `Dockerfile` at the root. Alternatively, build/push the image in your own CI and use Coolify's
   Docker Image deployment.
2. Set the application domain to your HTTPS URL and expose container port **3000**. The image
   listens on `0.0.0.0`. Keep the original Host header and URL path when proxying.
3. Add the two **runtime** variables below. They are not build arguments. Add no transcription keys
   here.
4. Add a persistent **Volume Mount** with destination **`/data`** before the first deployment.
   Retain this same volume on subsequent deployments.
5. Use **one replica**. Set container naming to **Consistent name (no rolling updates)**, or use a
   custom container name. This app owns a file-backed queue and must stop before its replacement
   starts. The kernel lock refuses a second writer.
6. Set **Stop Grace Period** to at least **31 minutes** (longer than `SHUTDOWN_GRACE_MS` plus
   cleanup). Pause the queue and wait for active work and screenings before every redeploy. Use the
   image's built-in health check: it calls `/health` inside the container and needs no curl
   installation.
7. On a four-CPU ARM host, start with a two-CPU / 4 GiB application limit and log rotation. These
   are operating limits, not measured resource requirements. The Compose example sets these limits.
8. Deploy, open the HTTPS URL, sign in, and add keys under **Connections**. Select the saved
   provider and model in **Studio** before submitting a clip.
9. Sign Codex in inside the container, verify a short clip, and enable watching in **Library** when
   ready. Watching starts disabled. Enable automatic translation for scanned films with runtime
   `TRANSLATION_ENABLED=true` after login works.

| Runtime variable | Value                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`  | `https://subtitles.example.com` — origin only, without a path                   |
| `APP_PASSWORD`   | A unique password of at least 12 characters; used to initialize an empty volume |

The Dockerfile already sets `DATA_DIR=/data`, `HOST=0.0.0.0`, `PORT=3000`, cloud transcription, and
CPU devices. Keep these defaults unless you deliberately change the deployment layout.

The public origin is checked against the request Host and Origin. A mismatch returns 403. Arbitrary
forwarded host headers are not trusted. TLS can terminate at Coolify; the session cookie is still
marked Secure when `PUBLIC_ORIGIN` uses HTTPS. Local HTTP accepts localhost, 127.0.0.1 and ::1 on
the configured port. Set `TRUSTED_PROXIES` to the actual reverse-proxy IPs/CIDRs so failed-login
backoff uses each client address. Never use a blanket trust setting or allow direct clients to forge
the trusted proxy source.

For a subpath, set `BASE_PATH=/revival`, keep `PUBLIC_ORIGIN` as the origin alone, and forward
`/revival/...` without stripping the prefix. `/health` stays at the root. A dedicated subdomain is
simpler.

Coolify's current [Dockerfile workflow](https://coolify.io/docs/applications/builds/dockerfile),
[persistent-storage instructions](https://coolify.io/docs/applications/configuration/persistent-storage),
and [container replacement rules](https://coolify.io/docs/applications/deployments/rolling-updates)
describe these settings. Use
[storage backups](https://coolify.io/docs/core/persistent-storage/storage-mounts/overview) in
addition to a persistent mount.

### Storage permissions

The image runs as UID/GID **10001:10001**, not root. A new Docker-managed volume inherits `/data`
ownership from the image. If you mount an existing host directory, make that specific directory
writable by UID/GID 10001 before starting. Do not mount over `/app`.

The volume must be a local filesystem supporting advisory locks and atomic rename. Do not share it
across multiple servers or replicas. Prefer the named volume to an NFS share.

| Location inside `/data`               | Contents                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| `data/processing-queue.json`          | Durable queue and scanner history                               |
| `data/private/password.json`          | Salted scrypt password hash                                     |
| `data/private/credentials.json`       | AES-256-GCM encrypted connection values                         |
| `data/private/master.key`             | Encryption key; must be backed up with the vault                |
| `data/private/codex/`                 | Container Codex login and refresh state                         |
| `data/translation-receipts/`          | Durable Codex candidates, source copies and receipts            |
| `data/subtitle-reviews/`              | Human corrections, paired timing, notes and generated baselines |
| `data/job-logs/`, `data/job-archive/` | Per-job logs and explicitly archived history                    |
| `data/subtitle-review-positions/`     | Small playback-position records                                 |
| `data/subtitle-review-media/`         | Completed screening media identities                            |
| `movies/`                             | Watched source films                                            |
| `temp/`                               | Uploaded sources, original audio, profiles, recovery manifests  |
| `output/`                             | Subtitles, translations, reviews, raw responses, comparisons    |
| `found/`                              | Reused existing subtitles                                       |
| `cache/`                              | Downloaded model weights and runtime caches                     |
| `review-sessions/`                    | Automatically prepared screening media; legacy static sessions  |

Back up the entire volume while jobs are stopped. The vault and encryption key are both in the
volume: encryption protects the values in the JSON file, but does not protect them from someone who
can read the whole volume or operate the server. Never publish the private directory. Losing
`master.key` makes saved secrets unrecoverable; the application refuses to create a replacement for
an existing vault. Alternatively, supply `CREDENTIALS_MASTER_KEY` as a 32-byte hex value from an
external secret store; the app never writes it. If migrating an existing vault, use the exact
original key and back it up separately before removing the colocated copy. The key is stripped from
child environments.

New jobs use `@data/` paths on disk and root-relative request signatures. Copy the complete volume
while stopped, preserving source mtimes. Legacy manifests retain absolute paths and need deliberate
migration; their paid identities are never silently rewritten.

## Credentials and password lifecycle

Connections supports all implemented transcription provider keys, a custom endpoint URL/key,
Speechmatics region, OpenSubtitles settings, and optional YouTube cookies. Saves are encrypted and
atomic. The next request reads the saved value; an already-started request continues with the
credentials it captured. Saved status means a value exists, not that a provider accepted it.

Secret fields are blank on reload and cannot be read back through the API. A blank field does
nothing; **Clear** removes a saved value and masks any environment fallback. New jobs use updated
endpoint/region settings. A different endpoint or region can invalidate an old job's request
identity; start a new job when changing those settings.

Environment credentials from older installations remain supported when a field has never been saved
or cleared. They are optional. Adding/changing a key through Connections needs **neither restart nor
rebuild**.

The initial `APP_PASSWORD` is stored only as a salted hash. After initialization, change it in
**Connections → Workspace password**; every browser session is revoked. Changing the environment
variable does not overwrite an existing password hash. Sessions expire after 12 hours, and a server
restart signs out all browsers.

If you lose the password, stop the app, back up the volume, remove only
`data/private/password.json`, set a new `APP_PASSWORD`, and start again. Leave `credentials.json`
and `master.key` intact. Startup fails closed when a new password is missing or too short.

## YouTube downloads

Both subtitle lookup and audio download use the same configured downloader. The image installs
`yt-dlp[default]==2026.10.21`, which includes the matching EJS solver, and explicitly enables its
Node runtime. Downloads explicitly disable simulation, reject live/upcoming/overlong media, bound
retries and network waits, and monitor downloaded size. This addresses the missing challenge runtime
in the original path. See yt-dlp's [EJS setup guide](https://github.com/yt-dlp/yt-dlp/wiki/ejs).

If YouTube requests sign-in, paste a Netscape `cookies.txt` export into **Connections → YouTube
cookies**. The backend decrypts it to a temporary owner-only file for each downloader invocation,
removes it afterward, and removes abandoned cookie files at the next startup. The stored export is
not automatically refreshed; replace expired cookies yourself.

YouTube can reject a data-center IP even with fresh cookies. Such failures now give an actionable
error; they are not treated as a successful download. Uploading a local audio/video file is the
fallback. No successful live YouTube download has been claimed from the static checks.

When YouTube changes again, update the pinned downloader in `requirements-download.txt`, keeping its
`[default]` extra, and rebuild the image. API key changes do not require this.

## CPU usage, uploads, and optional local ASR

See [full-movie Scribe](FULL_MOVIE_SCRIBE.md) for API-key setup, request sizing, speaker metadata,
and changing a paused pre-ASR job. File preparation uses bounded FFmpeg threads and upload streams
from disk. This removes the local neural-model requirement; CI validates image startup on both
architectures; resource use on the target host remains a deployment check.

The default is **direct ElevenLabs Scribe v2 on original audio**. Demucs is neither installed nor
invoked. Automatic/Full movie streams one file and preserves native word timing. Chunked mode
retains energy alignment and optional Silero checks. Add Silero with Docker build argument
`INSTALL_LOCAL_AUDIO=true`; the default image has `LOCAL_AUDIO_ENABLED=false`. API credentials go in
Connections, and no local ASR model runs unless a local provider is explicitly selected.

Start with a 30–60 second clip. Measure memory and processing time on your host before running a
feature film. Continuous-file FFmpeg preparation uses one decoder/encoder/filter thread; optional
local models use two threads and cache weights under `/data`. The default cloud route downloads no
neural weights. No benchmark or guaranteed RAM/throughput claim is implied by this image.

| Runtime variable            | Default           | Purpose                                               |
| --------------------------- | ----------------- | ----------------------------------------------------- |
| `TRANSCRIBE_BACKEND`        | `elevenlabs`      | Default for new/scanned jobs                          |
| `TRANSCRIPTION_MODEL`       | empty             | Direct ElevenLabs defaults to `scribe_v2`             |
| `LOCAL_WHISPER_CPU_THREADS` | `2`               | Worker/PyTorch thread limit                           |
| `WORKER_START_TIMEOUT_MS`   | `300000`          | Local Whisper startup, including first model download |
| `MEDIA_TIMEOUT_MS`          | `3600000`         | Deadline for a media process                          |
| `MAX_UPLOAD_BYTES`          | `2147483648`      | 2 GiB input limit                                     |
| `MAX_INPUT_DURATION_SEC`    | `14400`           | Four-hour media limit                                 |
| `MAX_TEMP_BYTES`            | `12884901888`     | 12 GiB temporary storage budget                       |
| `MIN_FREE_DISK_BYTES`       | `1073741824`      | Reserve free disk space when starting temporary work  |
| `MAX_QUEUED_JOBS`           | `20`              | Limit waiting jobs; scanner fills slots over time     |
| `KEEP_INTERMEDIATES`        | `false` in Docker | Free temporary media after successful jobs            |
| `PAUSE_ON_FAILURE`          | `true`            | Pause queue after failure until explicitly resumed    |

The web upload timeout is 30 minutes. Make the reverse proxy/CDN's upload limit and timeout
compatible with your inputs; the app cannot override an upstream 413 or connection timeout. For
large films, placing a stable file in `/data/movies` avoids browser upload limits. Save the default
provider's key and enable watching in Library. The scanner respects queue pause, capacity, and
credential availability. Its enabled state persists. See [batch controls](BATCH_OPERATIONS.md).

Faster-whisper is excluded from the default image and disabled in its provider selector. To include
CPU local ASR in a future build, set Docker build argument `INSTALL_LOCAL_WHISPER=true`. The image
installs `requirements-whisper.txt` and uses CPU/int8. This image is not a CUDA deployment recipe.

`compose.yaml` is an alternative single-service example. In Coolify Compose mode, assign a domain to
`studio:3000`; standalone Compose needs your own reverse proxy on its network. It deliberately
exposes no public host port.

## Manual deployment acceptance

These checks are for the owner to run after deployment:

- [ ] Fresh volume: startup without a valid bootstrap password fails; with one, `/health` is healthy
      and the HTTPS URL shows the login page.
- [ ] Signed out: `/api/jobs`, `/api/connections`, output URLs, and found-subtitle URLs return 401.
      Login assets contain no credentials or job information.
- [ ] Wrong password fails; repeated guesses reach a temporary 429 limit. Correct login creates a
      Secure, HttpOnly, SameSite=Strict cookie over HTTPS.
- [ ] Save a provider key, reload, and confirm only “Saved” returns. Submit one short, deliberately
      budgeted clip. Replace/clear the key without a restart and verify the next request uses the
      new state.
- [ ] Change the password and confirm an existing second browser session is rejected.
      Restart/redeploy with the same volume: password, saved keys, queue, and outputs persist;
      sessions require a fresh login.
- [ ] Redeploy with consistent container naming and check that only one queue owner runs. An
      interrupted job should offer Retry without duplicate automatic paid submissions.
- [ ] Submit a public, finished YouTube video. Confirm a nonempty source file is downloaded. Try an
      invalid/live video and an account-restricted link; failures must be useful and retryable.
      Check cleanup of temporary cookie files after success, failure, cancellation, and restart.
- [ ] Check Studio, library, translations, Connections, and the details dialog at desktop and mobile
      widths, by keyboard as well as pointer. Verify tab selection, upload progress, errors, and
      authenticated downloads.
- [ ] Complete [audio/pipeline checks](MANUAL_CHECKS.md) and
      [provider comparison checks](TRANSCRIPTION_COMPARISON.md), including timing, low-volume
      dialogue, original offsets, translation round trips, cancellation, and uncertain billing
      recovery.

Screening preparation is a separate low-priority worker and does not block the ASR queue or pause it
on failure. Its deadline scales with media duration. Re-downloads used only to prepare a screening
are removed once the durable screening exists. Studio displays persistent media use; Job Details can
remove screening copies without deleting corrections, and finished history can be archived.
Diagnostic transcript text is omitted from stdout unless `LOG_TRANSCRIPT_TEXT=true` is explicitly
set.

# Hosted accounts

This guide describes personal workspace deployment. For a public service with email/username
registration, private user workspaces and BYOK, use [HOSTED.md](HOSTED.md) and `APP_MODE=hosted`.
The owner-only Codex login below is not a billing fallback for hosted users.
