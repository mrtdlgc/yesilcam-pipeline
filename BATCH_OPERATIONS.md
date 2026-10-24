# ARM batch operation

The default route is direct ElevenLabs Scribe v2 on continuous original audio, followed by optional
Codex translation of the complete supplied SRT. This configuration needs FFmpeg for audio
preparation, but no local neural inference. The existing word timings, speaker context and fixed
translation cue boundaries are retained.

## Oracle / Coolify setup

Use one container, port 3000 behind HTTPS, and one persistent local volume at `/data`. Set
`PUBLIC_ORIGIN` and a first-start `APP_PASSWORD`. Keep local audio/Whisper build arguments false.
The image uses architecture-matched Node/Python bases and `@openai/codex@0.164.0`, whose lockfile
includes the Linux ARM64 binary package. No x86-only download path is used for the default route.

For the four-CPU host, the Compose example caps the application at two CPUs, 4 GiB RAM and 256
processes. Set equivalent limits in Coolify's Dockerfile deployment settings. These are initial
operating limits, not a measured throughput or memory guarantee. Rotate container logs; the Compose
example keeps three 10 MB files. Do not run multiple replicas against the volume.

An ARM image has **not** been built or run in this audit. Validate it on the target before loading a
library. The image build checks the installed Codex and yt-dlp executables without signing in or
running inference. Local source checks and fixture tests are described below.

## Codex subscription login

The CLI is included; an account login is not. In the running container's terminal, as the default
application user (UID 10001), run:

```sh
codex login --device-auth
codex login status
```

With Compose, use `docker compose exec studio codex login --device-auth`. Follow the one-time link
and code in your own browser. Device-code login may need enabling in ChatGPT's security settings.
The [official authentication guide](https://learn.chatgpt.com/docs/auth) documents this headless
flow and file-backed login storage. Do not paste tokens or `auth.json` into the app or repository.

The image sets `CODEX_HOME=/data/data/private/codex`; login and refresh state survive redeployment.
Use the same non-root user for login and the app. A bind mount must be writable by UID/GID 10001.
The **Translations** page reports availability. Translation requires ChatGPT login and never falls
back to API billing. Subscription allowance still applies; quota failure pauses the batch.

Enable the per-film translation checkbox in Studio. For watched films, set
`TRANSLATION_ENABLED=true` after logging in. No new image is needed for runtime setting changes.

## Queue and storage controls

| Control                    | Default                           | Behavior                                                     |
| -------------------------- | --------------------------------- | ------------------------------------------------------------ |
| Provider                   | `elevenlabs` / `scribe_v2`        | Full movie with native word timing and diarization           |
| Watching                   | Off on a new volume               | Enable in Library; persisted across restarts                 |
| `MAX_QUEUED_JOBS`          | `20`                              | Waiting-job cap; scans leave excess films on disk for later  |
| `PAUSE_ON_FAILURE`         | `true`                            | A failed job stops subsequent jobs until Resume queue        |
| `KEEP_INTERMEDIATES`       | `false` in Docker; `true` locally | Remove only successfully completed jobs' temp media          |
| `PREPARE_REVIEW`           | `true`                            | Prepare persistent screening media and the correction editor |
| `MAX_TEMP_BYTES`           | `12884901888`                     | 12 GiB shared temporary-media budget                         |
| `MIN_FREE_DISK_BYTES`      | `1073741824`                      | Keep at least 1 GiB free when reserving temporary work       |
| `CLOUD_MAX_ESTIMATED_COST` | `5`                               | Per-film estimate allowance in the selected model's currency |
| `CLOUD_PRICE_PER_MINUTE`   | Empty                             | Optional account-specific rate for new/scanned jobs          |
| `TRANSLATION_ENABLED`      | `false`                           | Enable Codex automatically for new/scanned films             |

Library scanning uses server defaults, not unsaved Studio form values. It verifies that required
credentials/login are configured, waits for stable files, and deduplicates by filename, size and
modification time. Source changes after queueing fail safely. **Scan now** performs a single scan
even when watching is off; new files still need a second observation at least ten seconds later.
Paused queues do not enqueue from scans. Enabling watching never resumes a paused queue.

Identical YouTube submissions and identical translation inputs/context reuse their existing job ID.
This includes failed jobs: inspect and retry the saved job. Deliberate new runs can use
`forceNew: true` on the corresponding submission API. Changed provider/model or subtitle content
creates a separate comparison. Raw uploads have no cross-job audio-content deduplication.

Pausing finishes the current job. Cancelling stops that job. After a failure, fix the cause, use
Retry if needed, then Resume queue. Retry may start another Codex request if its previous attempt
failed; a validated completed result is reused. An interrupted server pauses the queue on restart
and never automatically retries the interrupted job.

The Studio shows temporary storage usage and free disk space. Successful automatic cleanup never
removes source films from `movies/`, subtitles, raw requests, translation receipts or
`review-sessions/`. Those retained collections still consume disk: export/back up or remove unneeded
collections before the volume fills. Explicit cleanup of failed/cancelled jobs removes their ability
to resume audio work. Keep intermediate audio enabled for experiments that need listening
comparisons.

Completed films open with **Watch & correct**. Generated subtitles are available immediately; the
reviewer changes only problematic passages. Text, notes and paired-language timing edits save to
`data/subtitle-reviews/`; current SRT/ASS downloads use that saved document. Raw generated subtitle
files remain unchanged. Back up the review documents too. See
[the correction workflow](SUBTITLE_REVIEW.md).

New YouTube jobs retain video up to 720p for screening. Compatible video is remuxed; unsupported
codecs use a 480p, two-thread transcode. This can add CPU time and persistent disk usage despite the
cloud ASR route. Screening failure keeps the original media and pauses the batch by default. **Retry
screening preparation** reruns only media/review preparation, never ASR or translation.

## Costs and recovery

The public [ElevenAPI price](https://elevenlabs.io/pricing/api) is $0.22/hour. The half-film trial's
account dashboard used a different credit conversion, so the catalog rate is not a reliable invoice
for every account. Set a custom rate from your account and inspect provider usage during the first
few films. Included credits, plan fees, taxes and overage are separate. The application does not
enforce a provider-wide monetary ceiling; set provider/key limits for a large run.

Paid ASR request checkpoints live in `output/raw_transcriptions/JOB_ID/`. A disconnected or
ambiguous response is marked uncertain and cannot be automatically submitted again. Follow
[request reconciliation](TRANSCRIPTION_PROVIDERS.md) before allowing a replacement request. HTTP
failure request IDs are retained when the provider supplies them.

Codex receipts, source copies and candidate results live in `data/translation-receipts/JOB_ID/`.
Completed legacy receipts migrate there before cleanup. A saved completion event plus a structurally
valid result can be recovered after interruption without a second Codex call. An unknown interrupted
attempt needs explicit job retry. Cue IDs and timestamp strings are verified before publication.

Back up `/data` while the service is stopped. Include the encrypted connection vault **and** its
master key, queue, receipts, outputs, review sessions and Codex login store. Never put this backup
in a public repository. Existing local manifests contain absolute paths; copying them to a new host
without deliberately migrating paths does not make interrupted audio jobs portable.

## First deployment check

1. Build/run the image on the ARM host, sign in to the app, save the ElevenLabs key and sign Codex
   in.
2. Submit a short clip with a small explicit allowance and temporary-audio retention enabled.
3. Check source SRT/ASS, speaker report, English translation and unchanged cue timings. Open **Watch
   & correct**, change one translation and one cue time, then download both languages. Confirm that
   only the intentional changes appear, and generated originals are still available.
4. Pause the queue, add another clip, restart, and verify it stays queued until resumed.
5. Redeploy with the same volume; confirm keys, Codex login, outputs, screening media and
   corrections remain available, including after temporary cleanup.
6. Run one full film, inspect the account's actual usage and host resource usage, then enable
   watching.

The local regression suite uses fake ASR/Codex responses, isolated HTTP servers and short synthetic
audio. It verifies request reuse, ambiguous billing, queue limits, failure/restart pauses, source
timing preservation, receipt migration/recovery and authenticated range serving. No build, live API
inference or Oracle deployment is part of those checks.

Validation on 2026-10-24: both server and browser `npm run typecheck` checks passed; `npm test`
passed all **46 tests** in approximately 13 seconds. Shell syntax, Compose parsing, the pinned Linux
ARM64/x64 Codex package entries, changed-file formatting and tracked whitespace checks also passed.
Tests ran against source in isolated temporary directories. The running localhost application was
not rebuilt or restarted. New browser controls and the container still need deployment acceptance.

The subsequent correction-handoff change passed **53 tests** and both TypeScript checks. Its
regressions exercise automatic screening, real four-second media remux/transcode, audio-only review,
paired timing edits, immutable generated originals, missing/omitted lines, conflicting saves,
browser draft recovery, authenticated exports/ranges under a subpath, and persistence after
cleanup/restart. The editor controller runs with a small DOM adapter; real-browser visual/playback
acceptance remains manual. No local/Docker build, live inference, app restart or ARM application
deployment was run.
