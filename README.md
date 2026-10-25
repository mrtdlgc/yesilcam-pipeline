# Yeşilçam Revival

A subtitle studio for films that deserve a wider audience. Prepare local movies in the browser,
reuse embedded subtitles, and transcribe missing dialogue with **direct ElevenLabs Scribe v2**.
Preserve word timings and speaker turns for contextual translation, then watch and correct the
result. Other cloud transcription providers remain selectable.

Source is available under **AGPL-3.0-only** in the
[GitHub repository](https://github.com/mrtdlgc/yesilcam-pipeline). Runtime media, credentials and
account state are excluded. Historical implementation notes are in [docs/history](docs/history/).
See [the Opus audit remediation record](AUDIT_FIXES.md).

**Hosted service:** [email/username accounts and per-user BYOK](HOSTED.md), with temporary keys by
default and optional encrypted persistence. Each user has private jobs and corrections. OpenAI API
translation is available; ChatGPT subscription OAuth is prepared for later activation after provider
approval. **Personal installation:** the existing shared-password workspace and local Codex
subscription workflow remain available. [Hybrid media preparation](HYBRID_MEDIA.md) keeps local
films, playback and waveforms on the viewer's computer.

## Deploy on Coolify

For a personal installation, use the root [Dockerfile](Dockerfile), expose **3000**, and mount a
persistent volume at **`/data`**. Set **`PUBLIC_ORIGIN`** to your HTTPS origin and
**`APP_PASSWORD`** to a first-start password of at least 12 characters. Use one replica and
**Consistent name (no rolling updates)** so the old queue owner stops before its replacement starts.

For a hosted BYOK service, set `APP_MODE=hosted` and follow [HOSTED.md](HOSTED.md) instead of using
a shared workspace password. Do not share the operator's provider credentials with hosted accounts.

Sign in and save provider keys in **Connections**. Keys are encrypted on the backend and become
available to the next request without rebuilding or restarting. The frontend, APIs, and downloads
require a session. The default image uses **original audio + cloud transcription**; it includes
FFmpeg and a YouTube downloader with Node challenge solving. PyTorch, Silero, and faster-whisper are
optional build additions. Demucs is no longer installed or invoked. The image includes a pinned
Codex CLI with Linux ARM64 packaging; sign in once inside the deployed container using device login.
See the [ARM batch operation guide](BATCH_OPERATIONS.md) for exact setup and recovery steps.

For Hermes running on the deployment host, the [operator skill](skills/yesilcam-operator/SKILL.md)
covers deployment, batch controls, transcription/translation recovery, and review. Install the file
at `~/.hermes/skills/yesilcam-operator/SKILL.md` and invoke `/yesilcam-operator` in a new session.

Read [deployment, storage, password recovery, and the acceptance checklist](DEPLOYMENT.md) before
your first deployment. Strict TypeScript migration details are in
[the migration history](docs/history/MIGRATION.md). The Scribe default follows a small Ah Nerede
comparison of original/vocal audio using GPT Transcribe, Scribe v2, and Qwen3-ASR. It is a workflow
choice, not proof of accuracy on every film.

## Current pipeline

All inputs—audio uploads, YouTube videos, watched films, and resumed jobs—use `scripts/pipeline.ts`:

1. Check local films for embedded text subtitles before preparing audio. Prefer a full
   target-language track, then the requested source language, selected audio language, and other
   labelled dialogue tracks. Reuse an existing target track directly; translate other tracks with
   their timing intact. Forced, signs/song-only, commentary, image-based, unlabelled and clearly
   incomplete tracks do not replace full dialogue. When no usable track exists, check YouTube
   captions or an exact OpenSubtitles movie-hash match before transcription. IMDb-only matches
   remain references. Machine-translated online matches are excluded; provider failures are logged
   and generation continues.
2. Choose request granularity. **Direct ElevenLabs + Automatic/Full movie** prepares one continuous
   16 kHz mono FLAC, including all music and silence. Other providers and explicit **Short chunks**
   keep energy-selected chunks and film offsets. New cloud chunks use 16 kHz mono signed-16 FLAC;
   existing checkpoints retain their original audio and identities.
3. Optionally pause to review prepared audio before paid transcription.
4. Full-movie Scribe streams one multipart upload and uses native word timing; no local VAD,
   hallucination filter, or alignment model runs. Chunked mode retains optional local speech checks.
5. Save raw responses, request identity and usage before normalization. Completed responses are
   reused; an uncertain paid submission requires reconciliation rather than an automatic repeat.
6. Build Scribe cues from actual words, split at speaker changes, and keep request-scoped labels.
   Isolated timestamp anomalies are repaired, sorted or clamped and marked `timestamp_repaired`;
   zero-duration and unusually long words are retained with review flags. Native long cues are
   flagged rather than silently truncated. Chunked jobs can also use local filtering and alignment.
7. Export SRT, styled ASS, layout/readability reports, and speaker annotations. The default
   Netflix-inspired layout targets two lines of 42 characters; anonymous voice groups are not names.
8. Optional Codex translation reads the complete film, then chooses meaningful target-language cues
   from native words and scoped speaker turns. Lyrics follow the selective song policy below.
   Exact-timing mode remains available. Saved films reuse matching timing evidence without ASR;
   uploaded or modified subtitles do not inherit unverified annotations.

Your spectral classifier remains in `scripts/workers/audio_analysis_worker.ts`, as a standalone
diagnostic. `scripts/test_speech_detection.ts` is a separate diagnostic; the live chunker does not
claim to run that classifier.

The default is **direct `elevenlabs` / `scribe_v2`, one continuous movie**. OpenRouter and other
adapters remain available. Optional local ASR still uses **large-v3**. Local `WORD_TIMESTAMPS` stays
false by default; cloud adapters request supported native timestamps. Text-only models get
explicitly flagged estimates distributed over cached speech intervals. Neither pyannote nor WhisperX
is required. Speech-activity alignment is not word-level forced alignment, and accuracy on a
particular film still needs listening checks.

## Cloud transcription and subscriptions

The UI selects provider, model, quoted rate and an estimated usage allowance per job. Implemented
cloud adapters cover OpenRouter, OpenAI, Groq, Mistral, Deepgram, AssemblyAI, ElevenLabs, Gemini,
xAI, Speechmatics and Gladia. A custom OpenAI-compatible endpoint is also supported. OpenRouter has
a dated catalog of 28 STT models. Folder scanning uses `config.ts` defaults; API keys are saved in
**Connections**. Direct ElevenLabs defaults to full-movie submission; OpenRouter remains chunked.
See [full-movie setup and recovery](FULL_MOVIE_SCRIBE.md). Local work is limited to media
preparation, optional speech detection, and subtitle postprocessing.

Read [provider contracts and prices](TRANSCRIPTION_PROVIDERS.md),
[subscription eligibility](TRANSCRIPTION_SUBSCRIPTIONS.md), and the
[manual comparison workflow](TRANSCRIPTION_COMPARISON.md). ElevenLabs subscription credits and
eligible Google Cloud credits can fund ordinary API calls. Mistral advertises API credits on current
plans; Grok's subscription pool needs confirmation for a specific transcription API key. ChatGPT
sign-in's documented Responses API access does not establish transcription API access. The app never
assumes a subscription makes requests free.

Prepare a comparison without inference or an API request:

```bash
node build/scripts/compare-transcribers.js --job JOB_ID --chunks 1,7,19 --name first-pass
```

It reuses the job's prepared chunks and writes a plan plus corrected-reference and manual-import
templates. Actual inference requires `--run --budget USD=2` (with a separate EUR allowance when
needed). See the workflow before running. Reports preserve original film offsets, raw transcript
WER/CER, timing flags, cache reuse and gross usage. Subscription UI transcripts can be imported for
the same comparison. The Ah Nerede pilot exercised the OpenRouter GPT Transcribe, Scribe v2, and
Qwen3-ASR routes; it does not validate every available provider or subtitle alignment.

## Local development

The web application and tooling use strict TypeScript, ESM, Express, and a small browser client. The
audio/ML stages remain Python. Use Linux (or the Docker image), Node 22.12+ (Node 24 in the image),
Python 3.12, FFmpeg/ffprobe, and `flock` from util-linux.

The following are setup/build commands. CI checks the production image on native x64 and ARM64
runners; deployment-specific provider login and playback still need acceptance checks:

```bash
npm ci --ignore-scripts
cp .env.example .env
python3.12 -m venv .venv-audio
.venv-audio/bin/python -m pip install --only-binary=:all: -r requirements-download.txt
```

Set a password in `.env`, plus absolute paths for `PYTHON_BIN` and `YTDLP_BIN` from your new
environment. Keep the loopback `PUBLIC_ORIGIN` for local development. Then:

```bash
npm run typecheck  # static checks; emits no application code
npm test          # bounded fixtures, local HTTP and tiny FFmpeg inputs; no paid inference
npm run build     # compile TypeScript and copy browser/Python resources
npm start
```

Open `http://127.0.0.1:3000/`. `npm run dev` watches TypeScript, browser assets and configuration,
rebuilding before restarting the compiled server. Source CLI tools also have
`npm run compare:transcription -- ...` and `npm run recover:transcription -- ...` commands using
tsx. The production image uses the compiled `node build/scripts/...js` commands and excludes
development dependencies.

For optional local Silero, install CPU PyTorch and `requirements.txt`, then set
`LOCAL_AUDIO_ENABLED=true`. The cloud-only local setup uses `LOCAL_AUDIO_ENABLED=false`.

For optional CPU faster-whisper, install `requirements-whisper.txt` in the chosen interpreter and
set `LOCAL_WHISPER_ENABLED=true`. Use CPU/int8. Local CUDA setup remains possible outside this CPU
image, with separate PyTorch and CTranslate2 environments/library paths; follow the
[upstream CUDA instructions](https://github.com/SYSTRAN/faster-whisper#gpu) and the existing
`requirements-whisper-cuda.txt`. CUDA was not exercised during this migration.

The requirements pin direct Python dependencies, not the complete transitive environment. The
Dockerfile installs CPU wheels only when local audio/ASR build options are enabled and fails if no
compatible binary wheel exists. Demucs and its model downloads are excluded. Obsolete workers and
wrappers are retained in Git history, not shipped in the image.

## Processing and review

Choose a **Local file** in Studio, submit a YouTube video, or put films in the server’s persistent
`movies/` directory (`/data/movies` in Docker). Local files use the
[hybrid workflow](HYBRID_MEDIA.md): the browser extracts subtitles or compact audio, plays the movie
and draws its waveform. The movie stays on that computer; Codex translation runs on the server.
Enable server-folder watching in **Library** after saving the provider key. The scanner observes
files twice and waits for stability; it fills at most 20 waiting slots and checks the remaining
films on later scans. **Pause queue** lets the current job finish and prevents the next one from
starting. Failures and interrupted restarts pause the queue for inspection. Failed, interrupted and
paused jobs remain visible; use Retry/Resume instead of creating duplicate jobs. A scanner reset
allows a finished film to be submitted again.

Docker removes temporary media only after successful completion by default. Turn on **Keep temporary
audio after success** for comparison work. Subtitles, raw ASR checkpoints, translation receipts and
automatic review sessions and saved corrections remain on the volume. Failed and paused jobs keep
their recovery files. Exported jobs complete immediately. Screening preparation runs as a separate
low-priority worker for server-resident media; hybrid jobs create only the correction document and
play locally. A preparation failure retains the source and does not pause transcription. Its
separate retry never resubmits transcription.

Completed jobs open through **Watch & correct**. Fix only problematic text or timing: edits save to
the server, timing changes apply to both languages, and SRT/ASS downloads immediately reflect saved
corrections. There is no approval gate. Generated originals remain recoverable. New YouTube jobs
retain video for screening, while compatible local video is remuxed without video re-encoding. See
[subtitle review](SUBTITLE_REVIEW.md) for passage offsets, missing dialogue, recovery and storage.

Choose spoken and target language in the UI. Scanned films use the defaults in `config.ts`.
Automatic language detection labels unknown results `und` and mixed detected languages `mul`; it
does not assume Turkish.

For films with multiple audio tracks, `AUDIO_STREAM_INDEX` selects the zero-based audio stream; the
default is the first track. Energy analysis and chunk extraction use the same selected track.

**Studio** controls the provider, review pause, and alignment. `config.ts` controls default models,
chunk durations, speech thresholds, alignment, pause and optional translation. Jobs retain their
model/language/signal-processing configuration on retry. Timeouts and temporary-storage limits can
be raised for retries without invalidating transcription checkpoints. New model or processing
choices require a new job once transcription has started.

On startup, legacy Demucs jobs that have no ASR checkpoint migrate to source audio and Scribe v2.
The original manifest is backed up as `manifest.before-scribe-original.json`, vocal files stay
available for comparison, and a paused job stays paused. Old speech profiles are recomputed on the
source audio when processing resumes. Any existing ASR chunk/request checkpoint prevents this
migration, including an uncertain or rejected submission; those jobs retain their saved model and
audio to protect recovery identities. Completed jobs are unchanged.

The default limits are 2 GiB per upload, one simultaneous upload, 30 minutes for transfer, four
hours of media, and 12 GiB total temporary storage. Processing reserves expected PCM storage before
writing. Native local jobs keep intermediates by default; Docker cleans successful jobs unless the
per-job retention checkbox is enabled. Use **Details → Remove intermediate audio** after completing
review; it removes that job's resume files and disables retry. Exported subtitles, raw responses and
review reports remain. History deletion requires cache cleanup first, so retained audio does not
become unreachable through the UI.

Job Details provides source/target subtitle downloads, a review report, and flagged cues. The report
contains:

- Final cues and reasons such as `estimated_split_timing`, `boundary_unconfirmed`,
  `overlap_repaired`, `reading_speed`, or `silero_alignment_fallback`.
- Existing filter scores, suspicious cues and dropped transcripts.
- Vocal/original chunk paths, film offsets and execution metadata.

`_alignment` and `_sourceSpan` retain chunk-local diagnostic times; cue `start`/`end` and `words`
are on the film timeline, and `_filmOffset` gives the conversion. Known hallucination patterns still
participate in filtering, so inspect dropped text on a representative sample. No unmeasured
transcription-quality improvement is claimed.

## Progress and audio review

Job cards and the Details dialog show separate stage bars for subtitle search, download, lossless
chunk creation, speech detection, ASR, cue filtering/splitting, alignment, export and translation.
Counts advance after chunks are saved; download progress uses reported bytes. A stage without a
measurable total stays indeterminate. Skipped stages, interruptions and failures remain visible, and
the Details progress refreshes without closing the dialog.

Select **Pause before transcription** in Studio to stop before speech detection and ASR. A retry or
server restart does not bypass that stop. **Continue to ASR** explicitly resumes the review pause.
**Review audio chunks** opens source audio with film offsets, individual audio downloads and
paginated players. Historical jobs also expose their saved vocal comparisons. Only committed
archived vocal files are offered, and audio requests require the workspace login.

Keep the same original/vocal pairs when refining difficult material such as _Ah Nerede_. The
existing comparison tool can reuse selected prepared chunks across ASR models without rerunning
separation; see [TRANSCRIPTION_COMPARISON.md](TRANSCRIPTION_COMPARISON.md). Audio review and model
comparisons are separate steps; a completed progress bar does not establish audio or transcript
quality.

## Translation

Open **Translations**, choose a complete SRT from the library or upload an SRT/SRT-formatted TXT,
set the film title and languages, then click **Translate with local Codex**. Choose the uploaded
file’s encoding explicitly: UTF-8, Windows-1254/1251/1256/1252, or UTF-16 (1 MB maximum). The
existing transcription/audio stages are not rerun. **Studio** also has an option to translate
automatically after transcription.

This invokes the installed `codex exec` using the server user's existing **ChatGPT login**. The CLI
runs on the server; the model runs in the cloud and uses the server owner’s Codex allowance. The app
does not read/copy OAuth credentials, call paid OpenAI translation APIs, or fall back to API keys.
No translation splitting is performed: each film is one task with the complete subtitle context. An
optional model field selects a model available to your Codex account; blank uses the CLI default.
Translation runs with high reasoning and without shell, browser, connector, or subagent tools.

Choose **Editorial** for natural translated subtitles. This is the default for new media jobs and
library selections. Codex can regroup adjacent words from one voice into complete thoughts instead
of inheriting every punctuation cut. Two-speaker captions require distinct scoped voices and one
short complete sentence per line; the app supplies their dashes. Every original anchor must be
accounted for exactly once. Missing, repeated, reordered, invented or mixed-speaker ranges are
rejected. An SRT without native words remains cue-granular; estimated timings never become word
evidence. Older source reports can supply native words when their exported SRT still matches.

Choose **Exact timing** when synchronization must stay identical. Uploaded subtitles and API calls
without a mode default to this option. Cue IDs, order and timing lines are checked and copied
exactly into UTF-8 BOM / CRLF output. No cues, including lyrics, may be omitted in this mode.

Reused embedded subtitles automatically use **Exact timing**: their established cues do not pass
through ASR splitting/alignment or editorial regrouping. MKV SRT/ASS/SSA and MP4 text tracks are
converted to SRT locally; language aliases such as `eng`/`en` are recognized. Plain dialogue tracks
are preferred over SDH, but full SDH tracks remain usable. PGS/VobSub and other image subtitles need
OCR, which is not automatic; missing-language and partial tracks are reported and generation falls
back to transcription. Subtitle tracks cannot prove complete dialogue coverage, so review sparse
passages. For films at least ten minutes long, tracks with fewer than ten cues or ending before
halfway are treated as incomplete. Job Details shows the selected source and offers the original
extracted subtitle. Server-extracted tracks also have a selection report. Translation retries reuse
the saved, hash-checked track and never pay for ASR just because translation failed. Existing
completed jobs and edits are unchanged. The browser checks embedded and hash-matched online
subtitles before preparing audio locally. Server-side uploads inspect subtitles before requiring ASR
credentials; provider readiness is checked before server audio preparation. Codex login is needed
only when a translation is actually performed on the reused track.

Editorial mode translates story-relevant songs in italics and allows incidental background lyrics to
be omitted with a recorded reason. Omitted lyrics and their translation remain in the correction
editor and can be restored. An omission needs explicit lyric markers or singing evidence tied to the
same scoped voice. Music, an unscoped singing event, rhyme or recognition alone cannot justify
deleting words. Alternating singing and dialogue receive separate cues. Scribe audio events are
retained separately from speech, but they are **not a reliable singing classifier**: uncertain
passages stay present and are flagged for listening. No additional paid audio classifier is used.

Both prompts include a **known-song rule**. Optional song notes can contain titles, performance
details or supplied reference lyrics. Remembered lyrics are hypotheses, not proof of what this
performance sang. Codex must not fill missing verses from memory or claim online verification; web
access is disabled. Editorial source repairs are recorded as review notes while the original
transcript stays unchanged. Recognized songs still require listening where attribution or wording is
uncertain.

The final renderer uses source-word bounds, natural line wrapping, duration and reading-speed
checks. It allows up to half a second of trailing display time where space permits. Whole-film
scene-cut scanning has been removed: decoding the video was too costly for this optional refinement.
Only a quick container metadata probe supplies duration and the constant-frame-rate two-frame gap;
audio-only or unverified frame rates use an 80 ms fallback. Unavoidable overlaps, short cues and
fast reading are flagged without discarding dialogue. Existing cached scene evidence stays readable
for translation recovery, but new jobs never scan video frames. Final visual timing adjustments can
be made against the video and waveform in the correction editor.

The translation report includes token usage, source-anchor ranges, song decisions, proposed source
repairs and readability notes. Paired review files follow the new cue boundaries; original source
downloads and existing human corrections remain separate. Existing manifests retain their prior mode
and audio-event request identity. Completed Codex receipts remain reusable across prompt updates;
applying new instructions to completed work requires a new translation job.

Pauses within a phrase and overlong source intervals produce review warnings instead of rejecting
the whole film. Native timing is retained for listening and correction; target words are never split
mechanically or clipped to force a duration. Missing content and speaker-boundary violations still
block publication. A completed model result rejected by local validation is retained and can be
revalidated after a validator fix, without another Codex request. Failed model execution is tracked
separately and is not treated as a locally rejected success.

Results appear in the job queue with cancellation and explicit retry. These checks establish
structural integrity, not linguistic accuracy or Netflix delivery certification. Review a real film
before release; the fixture suite does not evaluate live model translation quality. Partial/failed
Codex responses are never published. There is no automatic retry that silently spends more plan
allowance. A verified result is reusable after interruption; an incomplete task starts over when you
explicitly retry.

The editorial targets follow Netflix's
[English timed-text guide](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide),
[template guide](https://partnerhelp.netflixstudios.com/hc/en-us/articles/219375728-Timed-Text-Style-Guide-Subtitle-Templates)
and
[timing guidance](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines).
Visual placement, linguistic accuracy and ambiguous singing still need screening.

Native installs: run `codex login` as the same OS user running the app. Docker includes the CLI; run
`codex login --device-auth` in its terminal once. Set `CODEX_BIN` to an absolute executable path if
it is outside the service's PATH. `CODEX_TRANSLATION_TIMEOUT_MS` defaults to 30 minutes per film.
[Official Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes the supported CLI interface; [authentication](https://learn.chatgpt.com/docs/auth)
explains ChatGPT subscription login. The standard CPU Docker image includes Codex. It needs its own
login; no host account state is copied.

For older workflows, set `EXPORT_TRANSLATION_CHUNKS: true`. Each job then has a unique
`output/translation_chunks/<title>_<job-id>/` folder. Its manifest holds immutable source cues and
the authoritative chunk list. Retrying the same source reuses these files without resetting reviewed
translations.

Download a full or slim JSON template. Fill `translated` for every entry in that chunk, preserving
`id` and `original`; full JSON must also preserve `start` and `end`. Slim imports also accept legacy
`{id, text}` results. Import through the UI. Unknown, duplicate, missing or altered cues and obvious
placeholders are rejected. A merge requires every cue to have a valid translation and preserves
source cue IDs and timestamp strings, including CRLF/BOM input parsing. Structural validation cannot
establish translation quality; review the result.

Translation uses the Codex integration. The unused Ollama route has been removed.

The deployment defaults to cloud transcription; local transcription is optional.
`TRANSCRIBE_BACKEND: 'local'` sends no audio to transcription providers. Legacy `auto` uses Groq
only with `ALLOW_CLOUD_FALLBACK: true` and a configured key. Cloud selection starts no Whisper
worker. Model downloads and optional providers still require network access. OpenSubtitles uses
`POST /download`, with optional token/key settings; credentials are never copied from the original
project.

## Recovery and diagnostics

All runtime paths are relative to `DATA_DIR` (`/data` in Docker, the project root locally). State is
in `data/processing-queue.json`; audio manifests and checkpoints are under `temp/<job-id>/`; raw
responses are in `output/raw_transcriptions/<job-id>/`. Writes use temporary files and atomic
rename. Startup preserves queued work and marks formerly running jobs interrupted. Cancellation
terminates the job's subprocess group on Linux.

Cloud request checkpoints retain raw provider responses, remote IDs and usage. An uncertain
submission blocks automatic resubmission; an accepted remote job can continue after local
cancellation. Job Details links the usage report and supports changing the estimate allowance on
retry. Job Details exposes request status and reconciliation: attach an existing provider ID or
explicitly authorize another attempt with a note. ElevenLabs transcript retrieval by ID is supported
alongside AssemblyAI, Speechmatics and Gladia. The CLI provides the same recovery actions; see
[the comparison guide](TRANSCRIPTION_COMPARISON.md).

Raw regeneration requires an exact current-format manifest and every retained chunk's response:

```bash
node build/scripts/process_raw_transcriptions.js JOB_ID
```

Missing offsets fail explicitly. Old output folders were not migrated or overwritten, and old
checkpoints cannot safely be interpreted as new manifests. Keep any existing subtitle translations
separately until you deliberately migrate them.

Manual diagnostics, to run only when wanted:

```bash
node build/scripts/test_speech_detection.js short-clip.wav --save-report
```

Spectral diagnostics are limited to ten-minute clips and two workers.

Before redeploying, **pause the queue and wait for active work and screening preparation to
finish**. Shutdown stops new claims/submissions, then lets submitted transcription responses reach
disk for up to `SHUTDOWN_GRACE_MS` (30 minutes by default). Set the container stop grace to at least
31 minutes. A forced kill or elapsed grace still requires inspecting an uncertain request before
retrying.

Studio shows temporary, screening and raw-transcript storage. Job Details can remove a screening
copy while retaining corrections and generated originals. Archive finished history after temporary
cleanup to keep the active queue small; archived records remain in `data/job-archive/`. Logs live in
`data/job-logs/`, and playback positions use small separate files. New jobs use portable data-root
paths; legacy absolute-path checkpoints require deliberate migration. Preserve mtimes when copying
source media so integrity checks still identify the original files.
