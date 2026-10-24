# Opus audit: Yeşilçam Revival (`yesilcam-pipeline`)

- **Date:** 2026-10-24
- **Auditor:** Claude Opus 5.5
- **Scope:** the complete working tree, meaning commit `7d8589a` plus all uncommitted and untracked
  changes. That covers every TypeScript, Python, HTML, CSS, config, Docker, test and Markdown file
  except `package-lock.json` and `node_modules/`, about 22,000 lines in total.

---

## 1. Method

I read every source file in full: server, pipeline stages, libraries, provider adapters, Python
helpers, browser code, styles, tests, build/deploy files and all thirteen Markdown documents. I then
ran the project's own checks and a few targeted probes to confirm suspected bugs.

| Check                                             | Result                                      |
| ------------------------------------------------- | ------------------------------------------- |
| `npm run typecheck` (server and browser projects) | Pass, no errors                             |
| `npx prettier --check .`                          | Pass                                        |
| `npm test`                                        | **53 / 53 pass** (~23 s)                    |
| `npm audit --omit=dev`                            | 0 vulnerabilities                           |
| Targeted probes (Node/tsx scripts in scratch dir) | 6 suspected bugs confirmed; see items below |

I did not build the Docker image, run a real provider request, or start the app against real media.
Every finding without the label "verified" comes from reading the code. The file:line references
point to the current working tree.

**Severity scale**

- **High:** in normal operation this will lose work, strand jobs where the UI cannot recover them,
  or put un-versioned code at risk.
- **Medium:** a real bug or risk under plausible conditions. A workaround exists.
- **Low:** an edge case, papercut, inconsistency or hygiene issue.
- **Info:** an observation, not a defect.

---

## 2. Executive summary

The codebase is careful work. Paid-request accounting, timestamp integrity, queue durability and the
security posture of a single-tenant web app are all clearly deliberate, and the test suite is real
integration testing, not a set of mocks. The main risks are operational rather than algorithmic:

| #   | Severity | Finding                                                                                                                                                                                                                          |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | [R-1](#r-1-high-the-entire-typescript-rewrite-is-uncommitted) The whole rewrite (~20k lines, 99 untracked files) is uncommitted. There is one commit and no remote.                                                              |
| 2   | High     | [O-1](#o-1-high-a-restart-or-redeploy-during-a-paid-request-strands-the-job) A restart or redeploy during a paid ASR request strands the job. Recovery needs a container shell, and for direct ElevenLabs it means paying again. |
| 3   | Medium   | [C-1](#c-1-medium-one-malformed-word-fails-an-entire-paid-transcript) One out-of-order word, or one sub-millisecond cue, fails a whole paid full-film transcript (verified).                                                     |
| 4   | Medium   | [O-2](#o-2-medium-screening-media-preparation-occupies-the-queue-slot) Screening transcode runs inside the queue slot. A long re-encode blocks the batch and can time out and pause it.                                          |
| 5   | Medium   | [O-3](#o-3-medium-a-screening-re-download-is-never-cleaned-and-blocks-history-deletion) A screening re-download is never cleaned up, and the UI can then neither clean the job nor delete it.                                    |
| 6   | Medium   | [S-1](#s-1-medium-the-login-throttle-lets-anyone-lock-out-the-owner) Anyone on the internet can use the login throttle to lock out the owner. Successful logins also count toward the limit.                                     |
| 7   | Medium   | [C-2](#c-2-medium-an-imdb-based-opensubtitles-match-can-replace-transcription-with-mistimed-subtitles) An IMDb-based OpenSubtitles match can finish a job using another release's mistimed subtitles.                            |
| 8   | Medium   | [O-4](#o-4-medium-codex-heartbeats-flood-the-job-log) The Codex heartbeat adds a log line every 15 s and pushes useful warnings out of the 200-line log.                                                                         |
| 9   | Medium   | [P-1](#p-1-medium-the-queue-file-is-rewritten-in-full-with-two-fsyncs-on-every-progress-event) Every progress event rewrites the whole queue file. History is never pruned.                                                      |
| 10  | Medium   | [DOC-1](#doc-1-medium-documentation-contradicts-the-code-in-several-places) Several documents contradict the code: Codex in the image, the Ollama path, default provider/model, Deepgram.                                        |

Other notable items: chunk mode uploads 32-bit float stereo WAV, roughly 12× the needed bandwidth
([B-1](#b-1-medium-chunk-mode-sends-32-bit-float-stereo-48-khz-wav-to-providers)). Ten of the eleven
cloud adapters have no contract tests
([T-2](#t-2-medium-ten-of-eleven-cloud-adapters-have-no-contract-tests)). A sizeable amount of dead
legacy code is still compiled and shipped
([Q-1](#q-1-medium-dead-and-legacy-code-is-compiled-and-shipped)).

---

## 3. System overview (for orientation)

```
Browser (public/*.ts)  ──fetch + X-Yesilcam-Request──►  server.ts (Express 5, single process)
   app.ts: Studio/Library/Translations/Connections        │  auth.ts (scrypt, in-memory sessions)
   review-editor.ts: Watch & correct (?job=)              │  credentials.ts (AES-GCM vault)
   review-player.ts: legacy screening (?session=)         │  JsonStore → data/processing-queue.json
                                                          │  instance-lock.ts (flock child)
                                                          ▼
                                pump() — one job at a time ─► scripts/pipeline.ts runPipeline()
   0 existing subs (embedded / YouTube json3 / OpenSubtitles)
   1 YouTube download (yt-dlp)            2 probe (2_extract_audio — no-op)
   2.5 chunk (energy cut points, f32 WAV)  or  movie-audio (one 16 kHz FLAC, ElevenLabs only)
   [pause before ASR]  2.6/3.5 Silero profiles (optional Python)
   3 transcribe (local Whisper worker | providers/client.ts → adapters.ts → normalize.ts)
   3.1 hallucination filter → 3.2 merge/split → 3.5 align → 3.7 clean/overlap repair
   finalize: SRT + ASS + style report + speakers → 5_translate → codex-translation.ts (codex exec)
   then (still inside the queue slot) review-preparation.ts: screening media + review document
```

State lives under `DATA_DIR`. `temp/<job>/manifest.json` holds per-job recovery state,
`output/raw_transcriptions/<job>/` holds paid-request checkpoints,
`data/translation-receipts/<job>/` holds Codex receipts, `data/subtitle-reviews/<job>.json` holds
human corrections, and `review-sessions/<job>/` holds screening media.

---

## 4. What is done well

The fixes below should not undo these:

- **Paid-request safety.** Each request identity is a hash of the audio's SHA-256 plus the full
  configuration ([client.ts:197-217](scripts/providers/client.ts#L197-L217)). Requests move through
  an explicit `prepared → submitting → accepted/complete | rejected | uncertain` state machine. An
  ambiguous POST is never resubmitted automatically. Before every submission the job's estimated
  allowance is checked against all retained requests
  ([client.ts:271-303](scripts/providers/client.ts#L271-L303)). Raw responses are saved before
  normalization and reused.
- **Durable single-writer queue.** A kernel `flock` makes the server the only writer, which also
  holds across replacement containers. Writes are atomic: temp file, then fsync, rename and a
  directory fsync. Jobs interrupted by a restart are marked as such and pause the queue instead of
  retrying silently.
- **Timestamp integrity end to end.** Film offsets are added exactly once. Codex translations are
  rejected unless every cue ID and timing line matches byte for byte
  ([codex-translation.ts:33-73](scripts/lib/codex-translation.ts#L33-L73)). Human edits are
  revision-checked, and the generated originals stay immutable.
- **Web security for a single-tenant app.** The app uses:
  - scrypt hashing and opaque session tokens stored as hashes
  - `SameSite=Strict` HttpOnly cookies
  - a custom header required on mutating requests, plus strict Host/Origin checks
  - a tight CSP and HSTS
  - `contained()` path resolution that is symlink-aware
  - no shell anywhere, argument arrays, and `--` before URLs
  - secrets stripped from child environments
  - credentials redacted from provider error text
  - no `innerHTML` anywhere in the frontend; captions go through `VTTCue`.
- **Codex isolation.** Codex runs with a read-only sandbox, every tool and feature disabled, an
  ignored user config, a forced ChatGPT login, subtitle data explicitly marked untrusted in the
  prompt, and strict validation of the output.
- **Streaming for large media.** Uploads stream through a byte-limited Transform. Full-movie uploads
  use a file-backed `Blob`. PCM is decoded incrementally and never held whole in RAM.
- **Tests that exercise reality.** The tests spawn the real server and run real FFmpeg on tiny
  inputs, use fake `codex` binaries, cover restart and interruption, and check authenticated range
  requests under a subpath.

---

## 5. Findings

### 5.1 Repository and process

#### R-1 (High) The entire TypeScript rewrite is uncommitted

- **Where:** the git state. `git diff --stat` shows 36 tracked files changed (+3,605 / −14,283), and
  there are 99 untracked files totalling about 20,000 lines. Among them are `server.ts`, every
  `scripts/**/*.ts`, all tests, `Dockerfile`, `compose.yaml` and all new documentation. The
  repository has one commit (`7d8589a`, the original JavaScript) and `git remote -v` is empty.
- **Why it matters:** A disk failure, a mistyped `git checkout .` / `git clean -fd`, or a wrong tool
  action would lose the whole migration. Nothing can be reviewed, bisected or rolled back. The
  Docker build context is the working tree, so whatever gets deployed cannot be reproduced from
  version control. The docs already warn about this hazard ([README.md:8-10](README.md#L8-L10),
  [SKILL.md:234-237](skills/yesilcam-operator/SKILL.md#L234-L237)).
- **Fix:** Commit now on a branch, ideally in logical slices: the TypeScript migration,
  auth/connections/Docker, full-movie Scribe, the review editor, then docs. Push to a private remote
  and tag each revision that gets deployed.

---

### 5.2 Reliability and recovery

#### O-1 (High) A restart or redeploy during a paid request strands the job

- **Where:**
  - [server.ts:1471](server.ts#L1471): shutdown aborts the active job.
  - [client.ts:286-299](scripts/providers/client.ts#L286-L299): any failure that is not a listed 4xx
    is recorded as `uncertain`.
  - [client.ts:119-127](scripts/providers/client.ts#L119-L127): a request lock left behind by a hard
    kill fails the next attempt with "Cloud request is locked".
  - [reconcile-transcription.ts](scripts/reconcile-transcription.ts) is the only recovery path.
- **What happens:** SIGTERM aborts the in-flight `fetch`. The resulting AbortError carries no HTTP
  status, so the request is saved as `uncertain`, and Retry then refuses with "may already have been
  charged". In the default full-movie mode one request covers the whole film and may stay open for
  up to 30 minutes ([config.ts:17](config.ts#L17)). Any Coolify redeploy, container restart, OOM
  kill or crash in that window lands here. After a hard kill the `.request.lock` file also remains.
  `processLockIsLive()` could tell that its owner is dead, but only the CLI calls it. For direct
  ElevenLabs there is no `--remote-id` recovery, which exists only for AssemblyAI, Speechmatics and
  Gladia. The only way forward is `docker exec … reconcile-transcription.js --allow-new-request`,
  which pays again.
- **Why it matters:** The conservative accounting is correct, so this is not a billing bug. The
  problem is that a routine operation (redeploy) turns into a shell-only, billing-sensitive
  procedure that the UI never explains. The money at list price is small, about USD 0.44 for a
  two-hour film. The cost is operator time and shell access to the server.
- **Fix:**
  1. While a paid submission is in flight, make shutdown stop claiming new work and let the request
     finish within the grace period, instead of aborting it. At minimum, track whether the request
     body finished uploading. An abort before the provider received the whole file can safely be
     recorded as `rejected`.
  2. In `transcribeCloud`, remove a lock automatically when `processLockIsLive()` reports a dead
     owner (same boot ID and start-time test the CLI already uses).
  3. Show `uncertain` requests in Job Details with the reconcile choices (inspect, or accept a new
     attempt with a note) so a container shell is not required.
  4. Check whether ElevenLabs offers transcript retrieval by ID, or an async/webhook mode for long
     files. If it does, save the ID and support `--remote-id` for it.
  5. Promote "pause the queue and wait for the active job before redeploying" from the operator
     skill ([SKILL.md:274-276](skills/yesilcam-operator/SKILL.md#L274-L276)) into the main
     deployment docs.

#### O-2 (Medium) Screening media preparation occupies the queue slot

- **Where:** [server.ts:397-398](server.ts#L397-L398) awaits `prepareJobReview` before marking the
  job completed. [review-preparation.ts:107-117](scripts/lib/review-preparation.ts#L107-L117) does
  the transcode.
- **What happens:** Video that is not H.264/yuv420p or VP8/VP9 gets a full libx264 480p re-encode on
  two threads. HEVC, AV1, MPEG-4 Part 2 and interlaced MPEG-2 are all common in old-film rips. On an
  Oracle A1 core pair, a two-hour film can take close to real time or longer. The whole transcode is
  bounded by `MEDIA_TIMEOUT_MS`, which defaults to 1 hour. On timeout the review status becomes
  `failed`, and with `PAUSE_ON_FAILURE` the whole batch pauses
  ([server.ts:404-408](server.ts#L404-L408)). The next film's cloud ASR, which takes minutes, waits
  behind this local CPU work.
- **Fix:** Mark the job completed once export (and translation) is done. Run screening preparation
  as a separate low-priority background task; the `prepare-review` endpoint and its `preparing`
  state already exist. Scale its timeout with media duration. Consider not pausing the ASR batch
  when only the screening failed, or put that behind its own setting.

#### O-3 (Medium) A screening re-download is never cleaned and blocks history deletion

- **Where:** [review-preparation.ts:251-260](scripts/lib/review-preparation.ts#L251-L260)
  re-downloads a YouTube source into `temp/<id>/review-download`. [server.ts:943](server.ts#L943)
  calls `cleanupSuccessfulJob`, which returns immediately when `intermediatesRemoved` is already
  true ([server.ts:336](server.ts#L336)). [app.ts:565](public/app.ts#L565) hides "Remove
  intermediate audio" for such jobs, and DELETE refuses while `temp/<id>` exists
  ([server.ts:1014](server.ts#L1014)).
- **Scenario (from code reading):** A YouTube job whose temporary files were already removed is
  given **Prepare screening**. This happens to jobs completed with `PREPARE_REVIEW=false` or before
  screenings existed. The app downloads up to `MAX_UPLOAD_BYTES` (2 GiB) of video, builds the
  screening copy, and leaves the download in place permanently. It counts against `MAX_TEMP_BYTES`
  for every later job, and the UI can neither clean it nor delete the history entry. Only a direct
  `POST /api/jobs/:id/cleanup` still works.
- **Fix:** Once the screening copy exists, delete `review-download` explicitly; it is never needed
  again. Offer cleanup in the UI whenever `temp/<id>` exists, regardless of the flag.

#### O-4 (Medium) Codex heartbeats flood the job log

- **Where:** [codex-translation.ts:319-332](scripts/lib/codex-translation.ts#L319-L332) reports
  progress every 15 s. [pipeline.ts:307](scripts/pipeline.ts#L307) forwards it to
  `options.progress`, and [server.ts:388-395](server.ts#L388-L395) appends every progress message to
  `job.logs`, which is capped at 200 lines.
- **What happens:** A 20-minute translation writes about 80 "Codex is working… Ns elapsed" lines, up
  to 120 at the 30-minute timeout. They push out earlier warnings such as subtitle-lookup failures,
  OpenSubtitles errors and Silero fallbacks. Each heartbeat also rewrites the whole queue file (see
  P-1).
- **Fix:** Send heartbeats through `onStage`, as the ElevenLabs heartbeat already does
  ([3_transcribe.ts:237-253](scripts/3_transcribe.ts#L237-L253)), or merge consecutive heartbeat log
  lines into one.

#### O-5 (Low) A crashed server leaves detached child processes running (native installs)

- **Where:** [process.ts:64](scripts/lib/process.ts#L64) starts every child with `detached: true`.
  The process has no `uncaughtException` or `unhandledRejection` handler.
- **What happens:** On a crash, ffmpeg, yt-dlp or codex keep running in their own process groups. In
  Docker, tini cleans them up when the container stops. A native install can keep, for example, a
  Codex translation running and consuming allowance after the server has died.
- **Fix:** Track live children and kill their process groups on `exit`. Add top-level handlers that
  abort the active job before exiting.

---

### 5.3 Correctness

#### C-1 (Medium) One malformed word fails an entire paid transcript

- **Where:** [normalize.ts:142-155](scripts/providers/normalize.ts#L142-L155),
  [3_transcribe.ts:31-40](scripts/3_transcribe.ts#L31-L40) and
  [3_transcribe.ts:186](scripts/3_transcribe.ts#L186),
  [3.7_clean_srt.ts:20-26](scripts/3.7_clean_srt.ts#L20-L26).
- **Verified:** Three words, where the third starts 10 ms before the second, produce "Provider
  returned invalid word timestamps". A cue from 1.0001 to 1.0004 s produces "Cannot export invalid
  subtitle timing".
- **What happens:** A single word with a non-monotonic start, a negative time, or an end more than
  0.25 s past the audio rejects the whole response. Paid responses are kept and never re-requested,
  which is correct, so the job then fails the same way on every retry until the code changes. With
  diarized overlapping speech across a 90-minute film, one such word is plausible, and the result is
  no subtitles at all.
- **Fix:** Keep rejecting structural failures such as a missing text field. For isolated anomalies,
  sort or clamp the word, add a review flag such as `timestamp_repaired`, and continue. The code
  already handles zero-duration words this way. Do the same for sub-millisecond cues: widen them to
  1 ms and flag them, as `segmentsFromWords` already does.

#### C-2 (Medium) An IMDb-based OpenSubtitles match can replace transcription with mistimed subtitles

- **Where:** [0_check_subs.ts:59-66](scripts/0_check_subs.ts#L59-L66),
  [pipeline.ts:511-539](scripts/pipeline.ts#L511-L539).
- **What happens:** Given an IMDb ID, the code downloads the first target-language result that has a
  single file. Nothing ranks the results by downloads or rating, excludes `ai_translated` or
  `machine_translated` entries, matches frame rate or release, or checks the timing against the
  actual media. A YouTube upload's cut rarely matches a disc release, so for YouTube jobs (the only
  place the UI offers an IMDb field) the timing is likely to be wrong. The job then finishes with
  that file and skips both ASR and translation, because the source language equals the target. The
  job looks complete while its subtitles are mistimed.
- **Fix:** Treat an IMDb-only match as a reference: save it, but still transcribe. Alternatively,
  require a timing sanity check, such as comparing cue onsets with the speech/energy profile, or ask
  the user to confirm. Prefer movie-hash matches, filter machine-translated entries, and rank by
  download count.

#### C-3 (Low) The repetition pattern misses Turkish words and drops genuine repetition

- **Where:** [3.1_filter_hallucinations.ts:72](scripts/3.1_filter_hallucinations.ts#L72). In
  JavaScript, `\b` and `\w` match ASCII only.
- **Verified:** `"evet evet evet evet"` matches, but `"çok çok çok çok"` and `"gül gül gül gül"` do
  not. A match also scores +10, an immediate drop, even when the repetition is genuine dialogue.
- **Fix:** Use `/(?<!\p{L})(\p{L}+)(?:\s+\1){3,}(?!\p{L})/iu`. Consider sending pattern-only
  repetition to a "suspicious" flag instead of a drop.

#### C-4 (Low) The FFT coverage label prints a fraction as a percentage

- [3.1_filter_hallucinations.ts:327](scripts/3.1_filter_hallucinations.ts#L327) prints
  `coverage.toFixed(0)%`, and coverage is a value from 0 to 1. **Verified:** 0.85 is shown as
  `fft_music=1%`. Use `(coverage * 100).toFixed(0)`.

#### C-5 (Low) The mojibake check rejects valid Russian and Turkish prompts

- [3_transcribe.ts:21](scripts/3_transcribe.ts#L21): `Р[°-я]` matches any word that starts with
  Cyrillic "Р" ("Россия"), and `Â.` matches Turkish words with a capital Â ("Âşık"). **Verified.**
  The previous-sentence prompt is then dropped silently. The impact is low because this only affects
  chunk mode with prompting enabled. Detect real mojibake byte patterns instead, or remove the
  check. The `movieContext` parameter of `buildSandwichPrompt` is unused.

#### C-6 (Low) Energy-relative scoring can drop quiet dialogue in chunk mode

- [3.1_filter_hallucinations.ts:357-361](scripts/3.1_filter_hallucinations.ts#L357-L361): the
  low-energy test (+3) compares against the chunk's median energy, and an `avg_logprob` below −1
  adds +1. Together they reach the drop threshold of 4. A soft line inside a chunk dominated by
  music can therefore be dropped; it is still kept in the report. This applies only to chunk mode
  with providers that return Whisper diagnostics: local Whisper, Groq, OpenAI `whisper-1`, and
  compatible `verbose_json`. Require at least one signal other than energy before dropping.

#### C-7 (Low) Uploaded videos skip embedded-subtitle and movie-hash lookup

- [server.ts:675](server.ts#L675) gives every upload the type `audio`, including MKV and MP4 files.
  [pipeline.ts:503](scripts/pipeline.ts#L503) and [pipeline.ts:515](scripts/pipeline.ts#L515) check
  embedded tracks and the OpenSubtitles hash only for type `video`, which only the watched folder
  produces. This contradicts [README.md:40-41](README.md#L40-L41). Set the type from the probe
  result, which shows whether a video stream exists.

#### C-8 (Low) Review exports keep non-sequential cue numbers

- [subtitle-review.ts:145](scripts/lib/subtitle-review.ts#L145) exports after a chronological sort
  while preserving cue IDs. Added cues (ID = max + 1) and shifted ranges then produce numbering such
  as `1, 2, 1043, 3`. Most players accept this, but some tools and upload targets expect sequential
  numbers. Renumber on export and keep the IDs internally.

#### C-9 (Low) Smaller correctness notes

- [2_extract_audio.ts](scripts/2_extract_audio.ts) `extractAndOptimizeAudio` only probes the
  duration and returns its input unchanged. The name is misleading.
- The embedded-subtitle language aliases cover only en/tr/uk/ru
  ([pipeline.ts:205-210](scripts/pipeline.ts#L205-L210)). A `de` target misses `ger`/`deu` tags.
- The YouTube json3 lookup reads only `subtitles[language]`
  ([0_check_subs.ts:95](scripts/0_check_subs.ts#L95)), so tracks keyed `en-US` or `en-GB` are
  missed.
- `prepareReviewMedia` rejects outputs whose duration differs from the source by more than 1 s
  ([review-preparation.ts:162](scripts/lib/review-preparation.ts#L162)). Containers whose audio and
  video lengths differ will fail screening.

---

### 5.4 Cost and billing

#### B-1 (Medium) Chunk mode sends 32-bit float stereo 48 kHz WAV to providers

- **Where:** [2.5_chunk_audio.ts:116-123](scripts/2.5_chunk_audio.ts#L116-L123). These chunks are
  sent unchanged by [client.ts:308](scripts/providers/client.ts#L308).
- **What happens:** A 30 s chunk is about 11.5 MB, against about 0.96 MB at 16 kHz mono 16-bit. A
  two-hour film in chunk mode means about 2.7 GB of uploads, and OpenRouter receives it as base64
  inside JSON, which adds a third. That sits close to the app's 20 MiB per-request cap and
  OpenRouter's documented 25 MB inline limit. Some APIs reject or mishandle IEEE-float WAV (format
  tag 3).
- **Fix:** Keep lossless float chunks for local analysis if useful. Send providers 16 kHz mono s16
  FLAC, as the full-movie path already does. This changes request identities, so apply it to new
  jobs only.

#### B-2 (Low) Prices and model IDs are a hard-coded snapshot

- [catalog.ts:9-208](scripts/providers/catalog.ts#L9-L208) records `PRICING_DATE = '2026-10-23'`.
  The pre-submission allowance check depends on these numbers. The refresh procedure is documented.
  Consider showing a staleness warning in the UI once the snapshot is N days old.

#### B-3 (Info) Legacy-job migration targets OpenRouter, not the current default

- [source-audio.ts:55](scripts/lib/source-audio.ts#L55) moves pre-ASR Demucs jobs to OpenRouter
  `elevenlabs/scribe-v2`, while new jobs default to direct ElevenLabs full-movie mode. This is
  documented ([MANUAL_CHECKS.md](MANUAL_CHECKS.md)). Note that migrated jobs bill to the OpenRouter
  balance.

---

### 5.5 Security

#### S-1 (Medium) The login throttle lets anyone lock out the owner

- **Where:** [auth.ts:86-96](scripts/lib/auth.ts#L86-L96).
- **What happens:** Counters increase before the password is verified and are never reset on
  success. A `global` counter caps all clients together at 30 attempts per minute. Anyone on the
  internet can send 30 bad passwords a minute and keep the owner locked out indefinitely. Ten
  successful logins within a minute also lock out that IP. Behind Coolify's proxy,
  `req.socket.remoteAddress` is the proxy's address, so the per-IP key effectively becomes global.
- **Fix:** Count failures only and reset on success. Use per-client exponential backoff keyed on a
  trusted `X-Forwarded-For` from the known proxy. Keep any global cap high enough that it only
  protects the CPU (scrypt), not access.

#### S-2 (Low) FFmpeg opens untrusted media without protocol restrictions

- **Where:** every `ffprobe`/`ffmpeg` call in [process.ts](scripts/lib/process.ts),
  [audio.ts](scripts/lib/audio.ts), [2.5_chunk_audio.ts](scripts/2.5_chunk_audio.ts),
  [movie-audio.ts](scripts/lib/movie-audio.ts) and
  [review-preparation.ts](scripts/lib/review-preparation.ts).
- **What happens:** A crafted playlist (HLS or m3u8 text) uploaded as "audio" can make FFmpeg fetch
  network URLs or read local files. Uploads require login, so exposure is limited to someone holding
  the password or a session.
- **Fix:** Add `-protocol_whitelist file,pipe` to every input that comes from an upload, the movies
  folder or YouTube.

#### S-3 (Low) 5xx responses echo internal error text

- [server.ts:1437-1446](server.ts#L1437-L1446) returns `error.message` for every error, including
  filesystem paths and up to 4,000 characters of child-process stderr
  ([process.ts:122](scripts/lib/process.ts#L122)). Responses are visible to logged-in users only.
  Return a generic message for 5xx and keep the details in the server log.

#### S-4 (Info) The vault key is stored beside the vault

- `data/private/master.key` sits next to `credentials.json`
  ([credentials.ts:38-40](scripts/lib/credentials.ts#L38-L40)). The docs say this honestly
  ([DEPLOYMENT.md:113-117](DEPLOYMENT.md#L113-L117)): the encryption protects against leaking the
  vault file alone, not against anyone who can read the volume. An optional externally supplied key
  would make it meaningful.

#### S-5 (Info) Dialogue text appears in server logs

- [3.1_filter_hallucinations.ts](scripts/3.1_filter_hallucinations.ts) has 47 `console.log` calls,
  which write dropped and suspicious dialogue to stdout for every chunk. Container logs therefore
  contain transcript text. This is harmless for a private studio, but worth knowing if logs are
  shipped anywhere.

---

### 5.6 Performance and resource use

#### P-1 (Medium) The queue file is rewritten in full, with two fsyncs, on every progress event

- **Where:** [files.ts:118-134](scripts/lib/files.ts#L118-L134). Each job also carries a full config
  snapshot (3,531 bytes, measured; see [server.ts:249-256](server.ts#L249-L256)) and up to 200 log
  lines.
- **What happens:** History is never pruned from the UI. A `clearAll` option exists at
  [server.ts:893](server.ts#L893), but no UI control sends it. With a few hundred films the queue
  file reaches tens of megabytes. Every progress event (FFmpeg every 2 s, each chunk, each
  heartbeat) parses it, stringifies it twice, writes it and fsyncs twice. Reads, including
  `/api/jobs` every 5 s for each open tab, wait behind those writes. Some routes also hold the store
  lock while running external processes: `/api/paused-jobs/:id/configure` calls `jobInput`, which
  calls `codexStatus` and spawns `codex` twice inside `updateJob`
  ([server.ts:1072](server.ts#L1072)). That can block pipeline progress writes for up to about 20 s.
- **Fix:**
  - Persist only settings that differ from the defaults, or rely on the manifest.
  - Move logs to per-job files.
  - Throttle progress persistence to at most once a second per job.
  - Keep external I/O out of `store.update` callbacks.
  - Add a history archive or prune action.
  - In the long run, consider SQLite.

#### P-2 (Low) Several scans over the energy profile are quadratic

- [2.5_chunk_audio.ts:32](scripts/2.5_chunk_audio.ts#L32) filters the whole film's profile for every
  chunk boundary: about 576,000 frames times about 290 chunks for two hours.
- [3.1_filter_hallucinations.ts:270-271](scripts/3.1_filter_hallucinations.ts#L270-L271) and
  [alignment.ts:18-34](scripts/lib/alignment.ts#L18-L34) are O(segments × frames/intervals).
- These are fine at today's sizes. A binary search over sorted times would make them linear.

#### P-3 (Low) Saving the playback position rewrites the whole review document every 10 s

- [review-editor.ts:465-468](public/review-editor.ts#L465-L468) leads to
  [subtitle-review.ts:325-330](scripts/lib/subtitle-review.ts#L325-L330), which fsyncs the entire
  JSON (current cues, originals, both languages) during playback. Store the position in a small
  separate file.

#### P-4 (Low) The UI refreshes everything every 5 s

- [app.ts:907-945](public/app.ts#L907-L945) and [app.ts:1139-1141](public/app.ts#L1139-L1141) make
  six requests per tick. One of them, `/api/translations`, opens every legacy chunk JSON. The job
  list is rebuilt from scratch each time. Use a change counter or ETag and render only the
  differences.

#### P-5 (Low) Persistent media grows without retention tooling

- `review-sessions/*` (screening copies of roughly 0.5–2 GB each), `output/raw_transcriptions` (full
  provider JSON) and `data/subtitle-reviews` grow without bound. The docs warn about this, but no UI
  shows the space used or offers pruning.

#### P-6 (Info) Editor responsiveness

- [review-editor.ts:208-227](public/review-editor.ts#L208-L227) removes and re-adds every caption
  cue on each keystroke. `cues()` sorts the whole list on every `timeupdate` (about 4 Hz). This is
  fine for around 1,500 cues and may lag near the 10,000-cue limit.

---

### 5.7 Frontend, UX and accessibility

#### U-1 (Low) Job cards re-render every 5 s and drop keyboard focus

- [app.ts:281-373](public/app.ts#L281-L373) rebuilds the list with `replaceChildren()`. A focused
  button disappears and screen readers re-announce the list. A button that `button()` disabled
  mid-request is replaced by a fresh, enabled one, so a double submission is possible; server state
  checks mostly reject it. Skip the re-render when nothing changed. The code already does this for
  subtitle files ([app.ts:692-696](public/app.ts#L692-L696)).

#### U-2 (Low) "Scan now" needs two clicks at least 10 s apart when watching is off

- [server.ts:1252](server.ts#L1252). This is documented
  ([BATCH_OPERATIONS.md:65-66](BATCH_OPERATIONS.md#L65-L66)), but the UI only says "Waiting for file
  to stop changing". For a manual scan, stat the file twice with a short delay, or show a countdown.

#### U-3 (Low) The Translations view shows only translation jobs on the current Studio page

- [app.ts:931-934](public/app.ts#L931-L934) filters the paginated 50 jobs. Older translations vanish
  from that view.

#### U-4 (Low) An unauthenticated link to `review-player.html` returns JSON

- [auth.ts:115](scripts/lib/auth.ts#L115) redirects only `/` and `/index.html` to the login page.
  Anyone opening a shared Watch & correct link while signed out gets a 401 JSON body.

#### U-5 (Low) Non-UTF-8 uploads are always decoded as Windows-1254

- [app.ts:754-758](public/app.ts#L754-L758): the Windows-1254 decoder never fails, so a Windows-1251
  or 1256 file silently becomes mojibake and is sent for translation. Add a heuristic check or an
  explicit encoding selector.

#### U-6 (Low) Accessibility and polish

- Text at 6–9 px in several places ([style.css:206](public/style.css#L206), 285, 354, 982, 1060,
  1114, 1215).
- `button:disabled { cursor: wait }` ([style.css:41](public/style.css#L41)) shows a busy cursor for
  buttons that are simply unavailable.
- The merge button loses its disabled state after a click, because `button()` re-enables it
  ([app.ts:26-39](public/app.ts#L26-L39), [app.ts:685](public/app.ts#L685)).
- Error notices never auto-hide and have no close button.

#### U-7 (Info) The legacy player defaults to one specific film

- [review-player.ts:343](public/review-player.ts#L343) falls back to the session
  `ah-nerede-first-half`, and line 483 says "first-half screening". The HTML hard-codes the track
  label "Turkish · Scribe v2". This is fine for the legacy path; remove it once that path is
  retired.

---

### 5.8 Code health and dead code

#### Q-1 (Medium) Dead and legacy code is compiled and shipped

None of the following is reachable from the server, yet all of it is compiled into `build/` and the
Docker image:

| Code                                                                                                                                                                    | Status                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [2.7_demucs_clean.ts](scripts/2.7_demucs_clean.ts) + `.py`                                                                                                              | Nothing imports them. Demucs is not installed.                                                                                                                                                                                      |
| [2.6_vad_filter.py](scripts/2.6_vad_filter.py), `checkSileroAvailable`                                                                                                  | Unused                                                                                                                                                                                                                              |
| [audio_analysis_worker_backup.ts](scripts/workers/audio_analysis_worker_backup.ts)                                                                                      | Backup copy, still compiled                                                                                                                                                                                                         |
| [pipeline.ts:875-948](scripts/pipeline.ts#L875-L948) `processMovie/processAudioFile/processVideoFile/resumePausedJob/listPausedJobs`                                    | Unused wrappers                                                                                                                                                                                                                     |
| [3_transcribe.ts:318-336](scripts/3_transcribe.ts#L318-L336) `transcribeToSegments`                                                                                     | Unused. It also re-imports `probe` dynamically even though `process.js` is already imported.                                                                                                                                        |
| [2.5_chunk_audio.ts:132](scripts/2.5_chunk_audio.ts#L132) `mergeSrtFiles`; `importSlimTranslation`; re-exports `segmentsToSrtContent`, `srtToSegments`, `formatSRTTime` | Unused                                                                                                                                                                                                                              |
| The Ollama path in [5_translate.ts](scripts/5_translate.ts)                                                                                                             | **Unreachable.** The server forces `TRANSLATION_PROVIDER: 'codex-local'` ([server.ts:565](server.ts#L565), [716](server.ts#L716), [803](server.ts#L803)), yet [README.md:276-280](README.md#L276-L280) tells users to configure it. |
| Demucs config keys ([config.ts:102-108](config.ts#L102-L108)), `PAUSE_AFTER_DEMUCS`                                                                                     | Legacy compatibility only                                                                                                                                                                                                           |
| [test_faster_whisper.py](scripts/test_faster_whisper.py)                                                                                                                | Looks for `vocals/` chunks that new jobs never produce                                                                                                                                                                              |
| The FFT branch of the hallucination filter                                                                                                                              | The pipeline never passes `fftReportPath`; reachable only from the CLI                                                                                                                                                              |

**Fix:** Delete this code, or move it to a `legacy/` folder outside the build. Either remove the
Ollama documentation or make the provider selectable again.

#### Q-2 (Low) Type safety is weaker than "strict" suggests

- There are 251 occurrences of `any`. `Segment`, `Chunk` and `PipelineOptions` carry
  `[key: string]: any` index signatures ([types/pipeline.ts:45](types/pipeline.ts#L45), 65, 73, 86),
  and `useUnknownInCatchVariables` is `false` ([tsconfig.json:9](tsconfig.json#L9)). The manifest,
  request-state and receipt shapes are untyped. Introduce `Manifest`, `RequestState` and
  `CodexReceipt` types and tighten them over time.

#### Q-3 (Low) Inconsistencies

- Module specifiers mix `node:`-prefixed and bare forms
  ([3.1_filter_hallucinations.ts:12-13](scripts/3.1_filter_hallucinations.ts#L12-L13),
  [test_speech_detection.ts](scripts/test_speech_detection.ts), workers).
- Debug `postMessage` calls are left inside the FFT loop of
  [audio_analysis_worker.ts:59-128](scripts/workers/audio_analysis_worker.ts#L59-L128).
- The Node tsconfig includes the `DOM` library ([tsconfig.json:15](tsconfig.json#L15)), which lets
  server code use browser globals by accident.
- [compare-transcribers.ts:112-123](scripts/compare-transcribers.ts#L112-L123) uses a PID-only lock,
  while request locks use the stronger boot-ID plus start-time identity.
- `style.css` has duplicate selectors (`textarea` ×3, `.btn-danger`, `.modal-footer`,
  `.nav-item.active`) and two `prefers-reduced-motion` blocks.
- Review documents keep a stale `text` field inherited from `parseSrt` beside `texts`
  ([subtitle-review.ts:96-107](scripts/lib/subtitle-review.ts#L96-L107)).

---

### 5.9 Tests

#### T-1 (Info) Current status

- All 53 tests pass in about 23 s. Coverage is strongest where it matters most: the queue lifecycle,
  restart and interruption, paid-request reuse and uncertainty, the integrity and recovery of Codex
  translations, review editing and its conflicts, and authenticated media ranges.

#### T-2 (Medium) Ten of eleven cloud adapters have no contract tests

- Only the direct ElevenLabs path runs end to end with a mocked `fetch`
  ([full-movie.test.ts:137-284](scripts/tests/full-movie.test.ts#L137-L284)). Ten adapters in
  [adapters.ts:40-368](scripts/providers/adapters.ts#L40-L368) have no request-shape or
  normalization tests: OpenAI, Groq, Mistral and compatible endpoints, plus OpenRouter, Deepgram,
  AssemblyAI, Gemini, xAI, Speechmatics and Gladia. The docs acknowledge that they "still require
  live verification". A wrong field name either costs money or yields unusable timing. Add
  recorded-fixture tests per adapter that assert the URL, headers and body, and the output of
  `normalize()`.

#### T-3 (Low) Two test files write into the repository's `data/` directory

- [subtitle-style.test.ts](scripts/tests/subtitle-style.test.ts) and
  [codex-translation.test.ts](scripts/tests/codex-translation.test.ts) import modules statically, so
  `DATA_ROOT` resolves to the project root and `codexStatus` creates `data/codex-runtime`
  ([codex-translation.ts:124](scripts/lib/codex-translation.ts#L124)). That is the stray
  `data/codex-runtime/` directory in this checkout. Set `DATA_DIR` before importing, using dynamic
  imports as [full-movie.test.ts:7-11](scripts/tests/full-movie.test.ts#L7-L11) does.

#### T-4 (Low) Worthwhile additions

- Login throttling (S-1), the scanner's stability logic, overlap repair edge cases in `alignment`
  and `cleanSegments`, variants of `validateYouTubeUrl`, preparing a screening after cleanup (O-3),
  shutdown during a submitted request (O-1), and tolerant normalization once C-1 is fixed.

---

### 5.10 Build and deployment

#### D-1 (Low) The image ships compiled tests and dead code

- [tsconfig.json:17](tsconfig.json#L17) includes `scripts/**/*.ts`, so `build/scripts/tests/*` and
  every Q-1 module end up in the runtime image. Use a separate `tsconfig.build.json` that excludes
  tests.

#### D-2 (Low) The optional Whisper build shares the audio venv despite comments saying otherwise

- [Dockerfile:43](Dockerfile#L43) installs `requirements-whisper.txt` into `/opt/audio`, next to
  torch, while [requirements-whisper.txt:1](requirements-whisper.txt#L1) and
  [requirements.txt:11](requirements.txt#L11) say it must be isolated. This is harmless for a
  CPU-only image. Fix the comments or the layout.

#### D-3 (Low) Local development papercuts

- The Host check rejects `http://localhost:3000` when `PUBLIC_ORIGIN` is the default `127.0.0.1`
  ([server.ts:483](server.ts#L483)). New local users get a confusing 403.
- `npm run dev` watches only the compiled output ([package.json:9](package.json#L9)). This is
  documented.
- The local `node_modules` lacks `@openai/codex` (`npm ls` reports `UNMET DEPENDENCY`) even though
  the lockfile pins it. This is harmless locally because `CODEX_BIN` points at the system binary.
- The app runs on Linux only: `flock` ([instance-lock.ts](scripts/lib/instance-lock.ts)) and `/proc`
  request identities ([process-identity.ts](scripts/lib/process-identity.ts)). This is documented.

#### D-4 (Info) No image has been built or run

- The docs say so plainly ([DEPLOYMENT.md:9-11](DEPLOYMENT.md#L9-L11),
  [BATCH_OPERATIONS.md:20-22](BATCH_OPERATIONS.md#L20-L22)). A native ARM64 build and its first run
  remain the largest unverified step.

#### D-5 (Info) Absolute paths make data non-portable

- Manifests store absolute chunk paths, and the ASR checkpoint signature hashes them
  ([3_transcribe.ts:103-109](scripts/3_transcribe.ts#L103-L109)). Audio review resolves them as
  absolute paths ([audio-review.ts:19](scripts/lib/audio-review.ts#L19)). Moving `DATA_DIR` (laptop
  to Oracle, or a volume remount at a new path) therefore breaks resume, and it also invalidates
  checkpoint reuse even after paths are rewritten. The docs warn about this. Storing paths relative
  to `DATA_DIR` would remove the problem for new jobs.

---

### 5.11 Documentation drift

#### DOC-1 (Medium) Documentation contradicts the code in several places

| Document                                                        | Claim                                                               | Reality                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md:261-262](README.md#L261-L262)                        | "The standard CPU Docker image does not include Codex"              | It does ([Dockerfile:50](Dockerfile#L50), [package.json:26](package.json#L26)). README:24 and DEPLOYMENT:3-4 say so too.                                                                                             |
| [README.md:276-280](README.md#L276-L280)                        | Set `TRANSLATION_PROVIDER: 'ollama'` for Ollama                     | Unreachable; the server forces `codex-local` (see Q-1)                                                                                                                                                               |
| [MIGRATION.md:5](MIGRATION.md#L5)                               | The default pipeline uses OpenRouter Scribe v2                      | The default is direct ElevenLabs, full movie ([config.ts:13](config.ts#L13))                                                                                                                                         |
| [MANUAL_CHECKS.md:39](MANUAL_CHECKS.md#L39)                     | "OpenRouter and `elevenlabs/scribe-v2` are selected by default"     | Same as above                                                                                                                                                                                                        |
| [TRANSCRIPTION_PROVIDERS.md:32](TRANSCRIPTION_PROVIDERS.md#L32) | OpenRouter default model is `mistralai/voxtral-mini-transcribe-3-0` | `DEFAULT_OPENROUTER_MODEL = 'elevenlabs/scribe-v2'` ([config.ts:8](config.ts#L8))                                                                                                                                    |
| [TRANSCRIPTION_PROVIDERS.md:35](TRANSCRIPTION_PROVIDERS.md#L35) | Deepgram does "full movie or chunks; word times and speakers"       | Full movie is ElevenLabs-only ([catalog.ts:328-335](scripts/providers/catalog.ts#L328-L335)), and the Deepgram adapter does not request diarization ([adapters.ts:111-121](scripts/providers/adapters.ts#L111-L121)) |
| [TRANSCRIPTION_PROVIDERS.md:94](TRANSCRIPTION_PROVIDERS.md#L94) | xAI receives "already-cleaned vocal chunks"                         | Demucs was removed; the chunks are original audio                                                                                                                                                                    |
| [DEPLOYMENT.md:107](DEPLOYMENT.md#L107)                         | `temp/` holds "vocal stems"                                         | Only legacy jobs have vocal stems                                                                                                                                                                                    |
| [README.md:316-317](README.md#L316-L317)                        | `test_faster_whisper.py` diagnostics                                | It needs vocal chunks that new jobs never create                                                                                                                                                                     |
| [README.md:40-41](README.md#L40-L41)                            | Local films reuse embedded or movie-hash subtitles                  | Only watched-folder films do; uploads do not (C-7)                                                                                                                                                                   |
| MANUAL_CHECKS / TRANSCRIPTION_COMPARISON                        | `PAUSE_BEFORE_TRANSCRIPTION=true` presented like an env var         | It is a `config.ts` constant or the UI checkbox                                                                                                                                                                      |

The docs also contain machine-specific paths and stale operational state. Examples:
[SUBTITLE_REVIEW.md:103-114](SUBTITLE_REVIEW.md#L103-L114) refers to `/media/mrtdlgc/Windows-C/…`
and says "the server was not restarted… the main full-film job remains paused";
[MIGRATION.md:37-38](MIGRATION.md#L37-L38) and [59-60](MIGRATION.md#L59-L60), and
[REMEDIATION.md:81-83](REMEDIATION.md#L81-L83) have the same problem. Dated validation logs inside
operational guides ([BATCH_OPERATIONS.md:139-151](BATCH_OPERATIONS.md#L139-L151): "46 tests", then
"53 tests") will drift with every change.

**Fix:** Keep one current README plus reference docs. Move history (REMEDIATION, the MIGRATION
narrative, validation logs) into `docs/history/` or a CHANGELOG, remove machine-specific paths, and
regenerate the provider table from `catalog.ts`.

---

## 6. Recommended order of work

1. **R-1:** commit and push today.
2. **O-1, O-3, O-4:** recovery and cleanup fixes that affect every batch run. Until O-1 is done,
   follow "pause the queue and wait before redeploying".
3. **C-1:** tolerant normalization, before the first full-library run.
4. **O-2:** move screening preparation out of the queue slot.
5. **S-1:** fix the login throttle; the app is internet-facing.
6. **T-2:** add adapter contract tests before relying on any provider other than direct ElevenLabs.
   Also **B-1** if chunk mode will be used.
7. **DOC-1 and Q-1:** a documentation pass and removal of dead code. Each makes the other easier.
8. **P-1:** slim the queue storage before the history reaches hundreds of films.
9. The remaining Low items as convenient.

---

## Appendix A: verification log

```text
$ npm run typecheck                      → exit 0
$ npx prettier --check .                 → "All matched files use Prettier code style!"
$ npm test                               → tests 53, pass 53, fail 0 (≈22.9 s)
$ npm audit --omit=dev                   → found 0 vulnerabilities
$ git diff --stat | tail -1              → 36 files changed, 3605 insertions(+), 14283 deletions(-)
$ git ls-files --others --exclude-standard | wc -l → 99   (≈20,257 lines)
$ git log --oneline | wc -l              → 1;  git remote -v → (empty)

Probe results (scratch scripts, no repo changes):
  /(\b\w+\b)\s+\1\s+\1\s+\1/i  "evet evet evet evet" → true; "çok çok çok çok" → false   (C-3)
  mojibake regex  "Россия большая" → true; "Âşık Veysel geldi" → true                      (C-5)
  fft label for coverage 0.85 → "fft_music=1%"                                            (C-4)
  TextDecoder('windows-1254',{fatal:true}) on CP1251 bytes → "Ïğèâåò" (no error)          (U-5)
  cleanSegments([{start:1.0001,end:1.0004}]) → "Cannot export invalid subtitle timing"   (C-1)
  normalize(Scribe, third word starts 10 ms before second) → "invalid word timestamps"   (C-1)
  JSON.stringify(config) → 3,531 bytes stored per job                                     (P-1)
```

## Appendix B: inventory reviewed

- **Server and libraries:** [server.ts](server.ts), [config.ts](config.ts), [types/](types/),
  [scripts/lib/](scripts/lib/) (26 modules), [scripts/providers/](scripts/providers/) (catalog,
  client, adapters, normalize, evaluate, OpenRouter snapshot).
- **Pipeline stages:** `scripts/0_…5_*.ts`, [pipeline.ts](scripts/pipeline.ts), and the CLIs
  `compare-transcribers`, `reconcile-transcription`, `process_raw_transcriptions` and
  `test_speech_detection`, plus both workers.
- **Python:** `whisper_runtime`, `whisper_worker`, `local_whisper`, `silero_runtime`,
  `3.5_align_silero`, `2.6_vad_filter`, `2.7_demucs_clean`, `test_faster_whisper`.
- **Browser:** `app.ts`, `login.ts`, `review-player.ts`, `review-editor.ts`, three HTML pages, two
  stylesheets, `globals.d.ts`, `favicon.svg`.
- **Build and deploy:** `package.json`, both tsconfigs, `Dockerfile`, `compose.yaml`,
  `.dockerignore`, `.gitignore`, `.env.example`, Prettier config, four requirements files,
  `container-entrypoint.sh`, `copy-assets.ts`, the transcription matrix example.
- **Tests:** all seven files in [scripts/tests/](scripts/tests/).
- **Docs:** README, DEPLOYMENT, BATCH_OPERATIONS, FULL_MOVIE_SCRIBE, MANUAL_CHECKS, MIGRATION,
  REMEDIATION, SUBTITLE_REVIEW, TRANSCRIPTION_COMPARISON, TRANSCRIPTION_PROVIDERS,
  TRANSCRIPTION_SUBSCRIPTIONS, `skills/yesilcam-operator/SKILL.md`.
