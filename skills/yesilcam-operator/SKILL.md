---
name: yesilcam-operator
description: Deploy and operate Yeşilçam Revival on Oracle ARM.
version: 1.1.0
author: Codex
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [yesilcam, subtitles, turkish, elevenlabs, codex, coolify, oracle, arm64]
    related_skills: [coolify-app-operations]
---

# Yeşilçam Revival operator

## When to Use

Use for deploying, maintaining, monitoring, processing films with, or recovering the user's Yeşilçam
Revival subtitle studio. The project makes classic Turkish cinema accessible through contextual
translations while reducing manual transcription and alignment work.

Operate within the current request. Deploying the app, processing a named film/batch, and inspecting
status are different actions. Loading this skill alone does not start a deployment or paid job.
Carry out already-authorized work without repeatedly asking for confirmation. Ask only for missing
information or authority that materially affects the next action.

## Discover the actual installation

The intended host is the user's Oracle Always Free ARM server, known over SSH as `oracle-a1`. Hermes
runs on that host; commands below execute there. Verify current architecture, available disk,
running containers and the app's actual Coolify resource before changing anything. Do not create a
second deployment beside an existing studio or alter unrelated services on the shared host.

Locate the application checkout or deployed image; do not assume this skill's directory is the repo.
The project package is `yesilcam-subtitle-pipeline`; its entrypoint is `build/server.js`. The
original development checkout is `/home/mrtdlgc/repos/yesilcam-pipeline` on the user's laptop, not
the Oracle deployment path. No Git remote, Oracle app path, domain, or container name is established
by this skill. Obtain those from the actual deployment/source, not a guessed GitHub URL.

Read the current checkout's `BATCH_OPERATIONS.md` first. For the task at hand, use `DEPLOYMENT.md`,
`FULL_MOVIE_SCRIBE.md`, `SUBTITLE_REVIEW.md` or `TRANSCRIPTION_PROVIDERS.md`. Check `Dockerfile`,
`compose.yaml`, `config.ts` and `server.ts` when behavior differs from documentation. The running
version and persisted settings take precedence over defaults in this file. If only an image is
available, inspect its compiled configuration and the corresponding source revision.

Use Hermes's `search_files` and `read_file` tools for source inspection when available. The
installed `coolify-app-operations` skill can help with proxy/container discovery. For this app,
provider keys belong in Connections and are runtime data; generic advice to bake secrets into
frontend envs or rebuild after changing keys does not apply.

## Preserve the tested pipeline

- Use direct **ElevenLabs `scribe_v2`**, automatic/full-movie mode, original audio and diarization.
  FFmpeg prepares one continuous 16 kHz mono FLAC, retaining music and silence. It streams from
  disk.
- Do not restore Demucs, Silero, pyannote, WhisperX or local Whisper as a prerequisite for cloud
  jobs. They are unnecessary for this chosen route. Local chunking and optional neural processing
  remain available for explicitly requested experiments; other ASR providers remain selectable.
- OpenRouter is a separate paid route with short requests and separate credits. Do not silently
  substitute it for direct ElevenLabs, or submit a whole film through its chunk adapter.
- Native word timing and tentative speaker groups feed cue generation. Speaker IDs are comparable
  only within their request scope; they are not verified character identities. Do not infer names or
  gender from anonymous IDs.
- Translation uses **the application's Codex CLI integration**, a ChatGPT login, and the complete
  supplied SRT plus matching speaker context in one task. The file may be a film excerpt. Do not
  split it into independent translation chunks or use Hermes's own chat response as a substitute for
  the app's validated translation job. There is no paid OpenAI API fallback.
- Preserve every translation cue ID, order and timestamp exactly. Keep cultural meaning, humor,
  profanity and character voices. Never invent missing dialogue to conceal an ASR error.
- Human review works by correction: generated subtitles are usable immediately, without approving
  the film or every cue. Only explicit human edits may retime paired tracks, add missing dialogue or
  omit a cue. Use the current export URLs after corrections; keep generated originals recoverable.
- Exports include SRT, styled ASS, and review reports. The Netflix-inspired profile targets two
  lines of 42 visible characters, with English 20 CPS and Turkish 17 CPS review thresholds. Meaning
  and exact source timing take priority; these are review targets, not Netflix certification.

## Deploy or update when requested

1. Confirm the intended source revision/image, domain, data volume and active work. A source
   checkout can contain uncommitted/untracked implementation files; do not discard them or deploy an
   older Git revision while claiming to deploy the prepared work. Keep a recoverable prior
   image/revision.
2. Use the repository's Dockerfile on native ARM64, or a matching ARM64 image. Keep
   `INSTALL_LOCAL_AUDIO=false` and `INSTALL_LOCAL_WHISPER=false`. Do not use amd64 emulation or
   install local neural models to make the default cloud route work. Respect any request to skip
   builds/checks; never transfer a build to the user's development laptop without authorization.
3. Configure one replica, internal port **3000**, HTTPS through Coolify, and persistent **`/data`**.
   Use consistent container naming/no overlapping rolling replacement. The queue has one owner
   enforced by `flock`; never delete/bypass the lock to start a competing writer.
4. Set runtime `PUBLIC_ORIGIN` to the exact public origin and initialize a fresh volume with
   `APP_PASSWORD` of at least 12 characters. Use protected configuration entry; never include the
   password in command arguments, chat or source. Keep Host and Origin intact through the proxy.
   `BASE_PATH`, if used, is forwarded without stripping it. `/health` remains at the root.
5. Start with the Compose example's **2 CPUs, 4 GiB RAM, 256 PIDs**, 30-second stop grace and
   rotated logs (three 10 MB files). Apply equivalent limits for Coolify's Dockerfile build pack.
   These are initial operating caps, not measured requirements; check actual host headroom and job
   behavior.
6. Run as **UID/GID 10001:10001**. Existing bind mounts need matching write access on that specific
   app directory. Do not recursively change ownership of the host's `/data` or Coolify installation.
   Back up a consistent app volume with the service stopped before a migration/replacement that
   could change persisted state. Preserve the exact volume when redeploying.
7. Save the ElevenLabs key under the studio's **Connections**. Changes take effect on subsequent
   requests without a rebuild/restart. Keep secrets out of this skill, Hermes memory, logs and shell
   history. Do not dump `.env`, full Docker inspection output, decrypted vault values or auth files.
8. Sign Codex in as the container's default application user. With the verified container name in
   `studio_container`, use:

   ```sh
   docker exec -it "$studio_container" codex login --device-auth
   docker exec "$studio_container" codex login status
   ```

   Let the owner complete the browser login. The image's `CODEX_HOME=/data/data/private/codex`
   persists its separate login and refresh state. Do not copy the host Hermes login or the laptop's
   Codex tokens into it. If device login is unavailable, check the
   [official authentication guide](https://learn.chatgpt.com/docs/auth). The frontend's `/api/codex`
   reports whether the CLI is available with ChatGPT login.

9. For updates, pause the queue and let the active job finish before replacement when possible.
   Cancelling an in-flight transcription can leave uncertain billing. Verify the new runtime before
   resuming. A failed/interrupted job remains an explicit recovery action, not an automatic retry.

## Operate a batch

Process the user-authorized films with the selected provider and allowance. Authorization for a
named batch need not be requested again for every film, but does not authorize extra films, provider
changes or a second potentially billed attempt. The app's allowance is an **estimate per job**, not
an account-wide spending ceiling. Use the account's rate and provider/key limits; do not promise a
fixed movie cost from the public catalog or assume subscription usage is unlimited.

| Control          | Behavior                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Watching         | Starts off on a new volume; enable in Library after credentials are ready; persists thereafter                    |
| Scanner defaults | Server configuration, not the unsaved Studio form; `TRANSLATION_ENABLED=true` enables Codex for new scanned films |
| Queue capacity   | `MAX_QUEUED_JOBS=20` waiting jobs by default; excess files wait for later scans                                   |
| Scan now         | One scan even if watching is off; stable files need two observations at least ten seconds apart                   |
| Pause queue      | Current job may finish; subsequent jobs and scanner enqueueing stop                                               |
| Failure/restart  | Default `PAUSE_ON_FAILURE=true`; an interrupted worker pauses the queue on restart                                |
| Resume           | Fix the cause, retry the affected job if appropriate, then resume the queue; enabling watching does not resume it |
| Retention        | Docker defaults `KEEP_INTERMEDIATES=false`; enable per-job retention for listening comparisons                    |
| Storage          | 12 GiB temp budget and 1 GiB free-space reserve by default; retained movies/outputs still consume disk            |

For a fresh deployment, use one authorized short clip and then one film before enabling a large
batch. If the owner chose manual acceptance, hand over the URL and leave paid smoke work to them.
Prefer stable files in `/data/movies` for large inputs; browser uploads are limited to 2 GiB and 30
minutes by default. Full-movie prepared audio is capped at 512 MiB/four hours. Preserve the original
timeline; do not strip silence or manually split a movie to work around timing concerns.

Use the authenticated UI/API for queue changes. API requests require the app session cookie and
`X-Yesilcam-Request: 1`; mutating JSON requests also need `Content-Type: application/json`. Respect
`PUBLIC_ORIGIN` and any `BASE_PATH`. Do not extract browser cookies or disable the password gate to
automate operations; use an authorized app session or have the owner operate the UI.

| Endpoint                                       | Purpose                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/status`                              | Queue pause reason, scanner state, active job and storage                           |
| `GET /api/jobs?view=summary&limit=50&offset=0` | Paginated job summaries; fetch a job by ID for full detail                          |
| `POST /api/queue/control`                      | `{"paused":true}`, `{"paused":false}`, or `{"scannerEnabled":true}`                 |
| `POST /api/jobs/ID/retry`                      | Explicit retry; queues work, does not clear a global queue pause                    |
| `POST /api/jobs/ID/cancel`                     | Stop an active job or cancel queued/paused work                                     |
| `POST /api/jobs/ID/cleanup`                    | Remove terminal-job intermediates; audio recovery is then unavailable               |
| `POST /api/subtitle-translations`              | Translate a saved `filename` or supplied SRT `content`; include title and languages |

Identical YouTube and translation submissions reuse an existing job. Inspect/retry that job rather
than evading deduplication with `forceNew`. Raw uploads do not have cross-job content deduplication.
Do not edit `processing-queue.json` while the application owns it.

## Diagnose and recover

Check live state, stage progress and recent sanitized logs together. A provider request or Codex
translation may legitimately have an indeterminate progress bar. Do not call it stuck solely because
its percentage does not move. Report progress during lengthy work; do not leave an operation quiet
for more than two minutes or launch a competing worker/build while investigating it.

| Symptom                          | Response                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| HTTP 403                         | Check Host/Origin/subpath against runtime configuration; do not relax the same-origin checks                           |
| HTTP 401                         | App login/session expired; restarting revokes browser sessions, not stored credentials                                 |
| Codex unavailable                | Check bundled CLI path and `codex login status` as UID 10001; renew ChatGPT login if needed                            |
| Codex quota/rate limit           | Leave the batch paused until allowance is available; do not switch to paid API translation                             |
| Storage budget / HTTP 507        | Check actual free space, retained completed temp media, source films and review media; do not delete recovery evidence |
| YouTube 403/429 or bot challenge | Refresh authorized cookies in Connections or upload a local source; hosted IPs can remain blocked                      |
| YouTube JS challenge failure     | Inspect the pinned yt-dlp/EJS and Node runtime; update through the source/deployment, not an ephemeral container patch |
| Changed source/configuration     | Restore the exact saved source or prepare an explicitly new job; do not rewrite hashes to force reuse                  |
| Queue ownership error            | Find the existing owner and complete its shutdown; do not remove the lock file as a workaround                         |

For uncertain ASR billing, first inspect the saved request without submitting anything:

```sh
docker exec "$studio_container" node build/scripts/reconcile-transcription.js --job "$studio_job_id" --chunk 0
```

Full-movie Scribe uses chunk ID `0`; inspect the manifest for other modes. Check status, request ID,
the saved result and provider usage before retrying. Stop/cancel the affected queued/active job
before reconciliation. `--unlock` is only for a proven stale owner. `--allow-new-request --note ...`
explicitly permits another potentially billed attempt: use it only when the user has authorized that
duplicate cost after reviewing the evidence. Never delete request files to make retry work.
`--remote-id` recovery currently supports AssemblyAI, Speechmatics and Gladia, not direct
ElevenLabs.

Codex has a separate recovery path: completed receipts and valid saved completion results are reused
without another inference. An unknown interrupted attempt needs explicit retry and may consume more
subscription allowance. Preserve its candidate, receipt and source when investigating validation
failures. Do not publish a partial translation or remove the ID/timestamp checks to accept one.

## Persistent artifacts and review

Paths below are relative to the app's `/data` mount:

| Path                                     | Purpose                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `data/processing-queue.json`             | Queue, controls and scanner deduplication                                              |
| `data/private/`                          | Password hash, encrypted key vault, master key and container Codex login; never expose |
| `data/translation-receipts/JOB_ID/`      | Codex receipt, candidate, source copy and integrity report                             |
| `temp/JOB_ID/`                           | Prepared audio and manifests; retained for failed/paused jobs                          |
| `output/raw_transcriptions/JOB_ID/`      | ASR request/result checkpoints and usage evidence                                      |
| `output/subtitles/`, `output/reviews/`   | SRT/ASS, timing/style flags and speaker sidecars                                       |
| `data/subtitle-reviews/JOB_ID.json`      | Current human edits, notes, playback position and generated baseline                   |
| `data/subtitle-review-media/JOB_ID.json` | Reusable screening media identity                                                      |
| `movies/`, `review-sessions/`            | Watched originals and persistent automatically prepared screening media                |

Back up the vault with its master key and the other persistent state. Do not use
`docker compose down -v` or global Docker pruning to fix this app. Legacy manifests contain absolute
paths; copying the laptop's state into Oracle without deliberate path migration does not make it
resumable.

`PREPARE_REVIEW=true` automatically adds **Watch & correct** at `/review-player.html?job=JOB_ID`
under the app's origin/subpath. New YouTube jobs download video up to 720p; compatible video is
remuxed, while unsupported formats get a 480p copy with two CPU threads. Media preparation can add
CPU time and persistent disk use. Audio-only inputs remain audio-only. The chosen source audio
stream is retained in the screening.

Human text, notes and timing changes autosave to `data/subtitle-reviews/`. Timing edits apply to
both language tracks. Source-text corrections do not trigger another translation: the reviewer
adjusts the adjacent translated text when needed. Passage offsets, missing-line insertion, omission
and per-cue restoration are available. Never add an approval gate or mark all good cues as a
prerequisite.

Use the job result's `currentSubtitleFile`/`currentAssFile` or
`GET /api/reviews/ID/subtitles/LANGUAGE.srt` (also `.ass`, `.vtt`, `.json`) for current exports. Raw
`output/subtitles/` files remain generated originals. Backing up that directory alone misses human
corrections. `GET /api/reviews/ID` loads the correction document; `POST /api/reviews/ID` requires
the current revision and explicit cue edits. A 409 means a competing edit: preserve the draft and
resolve it, never bypass the revision check.

Screening failure retains source media and pauses the batch by default, but leaves finished
subtitles available. `POST /api/jobs/ID/prepare-review` or **Retry screening preparation** runs only
the handoff step; it does not repeat ASR/Codex. Resume the queue after recovery. Legacy completed
jobs may need their original source restored. Subtitle-only jobs can use a local file for playback
without uploading it; that selection is browser-local, while corrections still save on the server.

The old Ah Nerede `?session=SESSION_ID` screenings remain compatible and keep browser-local notes.
Export those notes before clearing browser data. New job screenings persist notes and position on
the backend. Symlinks must stay within the review-media root; never expose the whole data mount.

## Verify and report

After an authorized deployment, verify the image architecture, runtime tools, writable persistent
volume, one queue owner, container health and public HTTPS login. `/health` is public liveness only;
it does not prove that Codex is signed in, a provider key works or the queue is advancing. Verify
that signed-out API/output/review-media requests are rejected and authenticated media can seek.

For an authorized film test, verify provider/model, exactly which audio was submitted, source and
translated exports, speaker context, cue/timestamp preservation, usage evidence and retention. Keep
account-reported usage separate from estimates. Do not rerun paid inference merely to check that an
existing export is readable.

Read `BATCH_OPERATIONS.md` for the latest dated source-test evidence. Ah Nerede's first-half
transcription and translation were reviewed by the owner. The ARM image and new browser controls
still needed target-host/manual acceptance at handoff. Establish current evidence before describing
those checks as passed. Source checks are `npm run typecheck` and `npm test`; the production image
intentionally omits development dependencies.

Report the actual URL, deployed revision/image, queue state, completed checks, source/translated
artifact links and any unresolved blocker. Distinguish source changes, a successful image build, a
running deployment and a successful paid film run. They are separate milestones.
