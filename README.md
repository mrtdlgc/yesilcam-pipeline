# Yeşilçam Revival

A private subtitle studio for classic Turkish films: transcribe original audio with **ElevenLabs
Scribe v2**, through OpenRouter for short requests or directly through ElevenLabs for a complete
movie. Preserve word timings and speaker turns for contextual translation. Other providers remain
selectable.

This checkout was recovered from the original Windows Downloads copy. That copy and its existing
outputs were preserved. The local Git baseline records the imported source; the remediation is
available as a working-tree diff. No GitHub remote is configured.

## Deploy on Coolify

Use the root [Dockerfile](Dockerfile), expose **3000**, and mount a persistent volume at
**`/data`**. Set **`PUBLIC_ORIGIN`** to your HTTPS origin and **`APP_PASSWORD`** to a first-start
password of at least 12 characters. Use one replica and **Consistent name (no rolling updates)** so
the old queue owner stops before its replacement starts.

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
your first deployment. Strict TypeScript migration details are in [MIGRATION.md](MIGRATION.md). The
Scribe default follows a small Ah Nerede comparison of original/vocal audio using GPT Transcribe,
Scribe v2, and Qwen3-ASR. It is a workflow choice, not proof of accuracy on every film.

## Current pipeline

All inputs—audio uploads, YouTube videos, watched films, and resumed jobs—use `scripts/pipeline.ts`:

1. Check for usable target-language subtitles. Local films can reuse embedded text subtitles or an
   exact OpenSubtitles movie-hash match. IMDb lookup is supported for submitted videos. Provider
   failures are logged and generation continues.
2. Choose request granularity. **Direct ElevenLabs + Automatic/Full movie** prepares one continuous
   16 kHz mono FLAC, including all music and silence. Other providers and explicit **Short chunks**
   keep the original energy-selected PCM chunking and film offsets.
3. Optionally pause to review prepared audio before paid transcription.
4. Full-movie Scribe streams one multipart upload and uses native word timing; no local VAD,
   hallucination filter, or alignment model runs. Chunked mode retains optional local speech checks.
5. Save raw responses, request identity and usage before normalization. Completed responses are
   reused; an uncertain paid submission requires reconciliation rather than an automatic repeat.
6. Build Scribe cues from actual words, split at speaker changes, and keep request-scoped labels.
   Zero-duration or unusually long words are retained with review flags. Native long cues are
   flagged rather than silently truncated. Chunked jobs can also use local filtering and alignment.
7. Export SRT, styled ASS, layout/readability reports, and speaker annotations. The default
   Netflix-inspired layout targets two lines of 42 characters; anonymous voice groups are not names.
8. Optional Codex translation receives the complete SRT and cue-linked speaker context, preserving
   every cue ID and timestamp. Translating an unchanged saved source later also reuses its matching
   speaker sidecar. Uploaded or modified subtitles do not inherit unverified annotations.

Your spectral classifier remains in `scripts/workers/audio_analysis_worker.ts`, with the original
backup alongside it. `scripts/test_speech_detection.ts` is a separate diagnostic; the live chunker
does not claim to run that classifier.

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

The following are setup/build commands. The native local deployment was rebuilt on 2026-10-24;
Docker and ARM image builds still require deployment checks:

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

Open `http://127.0.0.1:3000/`. `npm run dev` performs a build, then watches the compiled server for
restarts; rerun the build after source edits. Source CLI tools also have
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
compatible binary wheel exists. Demucs and its model downloads are excluded. Its legacy worker
source is retained for historical experiments, but is not called by the application and its
dependency is not in the image.

## Processing and review

Upload original-quality audio, submit a single YouTube video, or put films in persistent `movies/`
directory (`/data/movies` in Docker). Enable watching in **Library** after saving the provider key.
The scanner observes files twice and waits for stability; it fills at most 20 waiting slots and
checks the remaining films on later scans. **Pause queue** lets the current job finish and prevents
the next one from starting. Failures and interrupted restarts pause the queue for inspection.
Failed, interrupted and paused jobs remain visible; use Retry/Resume instead of creating duplicate
jobs. A scanner reset allows a finished film to be submitted again.

Docker removes temporary media only after successful completion by default. Turn on **Keep temporary
audio after success** for comparison work. Subtitles, raw ASR checkpoints, translation receipts and
automatic review sessions and saved corrections remain on the volume. Failed and paused jobs keep
their recovery files. A screening-preparation failure retains the source and pauses the batch by
default; its separate retry never resubmits transcription.

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
**Review audio chunks** opens source audio with film offsets, individual WAV downloads and paginated
players. Historical jobs also expose their saved vocal comparisons. Only committed archived vocal
files are offered, and audio requests require the workspace login.

Keep the same original/vocal pairs when refining difficult material such as _Ah Nerede_. The
existing comparison tool can reuse selected prepared chunks across ASR models without rerunning
separation; see [TRANSCRIPTION_COMPARISON.md](TRANSCRIPTION_COMPARISON.md). Audio review and model
comparisons are separate steps; a completed progress bar does not establish audio or transcript
quality.

## Translation

Open **Translations**, choose a complete SRT from the library or upload an SRT/SRT-formatted TXT,
set the film title and languages, then click **Translate with local Codex**. UTF-8 and Turkish
Windows-1254 uploads are supported (1 MB maximum). The existing transcription/audio stages are not
rerun. **Studio** also has an option to translate automatically after transcription.

This invokes the installed `codex exec` using the server user's existing **ChatGPT login**. The CLI
runs locally; the model runs in the cloud and uses your Codex subscription allowance. The app does
not read/copy OAuth credentials, call paid OpenAI translation APIs, or fall back to API keys. No
translation splitting is performed: each film is one task with the complete subtitle context. An
optional model field selects a model available to your Codex account; blank uses the CLI default.
Translation runs with high reasoning and without shell, browser, connector, or subagent tools.

Results appear in the job queue with cancellation and explicit retry. The app rejects missing,
duplicate, reordered or retimed cues, empty translations and malformed markup. Original cue-number
and timing lines are copied exactly into UTF-8 BOM / CRLF output; the source stays untouched. The
downloadable translation report includes usage tokens and readability notes for cues over two lines
or 42 visible characters per line, plus reading-speed and duration issues. These checks establish
structural integrity, not linguistic accuracy. Review the film before publishing. Partial/failed
Codex responses are never published. There is no automatic retry that silently spends more plan
allowance. A verified result is reusable after interruption; an incomplete task starts over when you
explicitly retry.

Native installs: run `codex login` as the same OS user running the app. Docker includes the CLI; run
`codex login --device-auth` in its terminal once. Set `CODEX_BIN` to an absolute executable path if
it is outside the service's PATH. `CODEX_TRANSLATION_TIMEOUT_MS` defaults to 30 minutes per film.
[Official Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes the supported CLI interface; [authentication](https://learn.chatgpt.com/docs/auth)
explains ChatGPT subscription login. The standard CPU Docker image does not include Codex or your
host login; this integration is intended for the native local deployment.

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

For local Ollama translation, set `TRANSLATION_PROVIDER: 'ollama'`, enable `TRANSLATION_ENABLED` and
configure an installed Ollama model. Model matching is exact. Prompts use the job's source and
target languages. Failures retain the source SRT, chunk exports and completed translation
checkpoints. Ollama unload is requested after completion/failure. The default model choice remains
yours; no translation model was benchmarked here.

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
retry. Use `scripts/reconcile-transcription.ts` only after checking the provider dashboard, as
described in [the comparison guide](TRANSCRIPTION_COMPARISON.md).

Raw regeneration requires an exact current-format manifest and every retained chunk's response:

```bash
node build/scripts/process_raw_transcriptions.js JOB_ID
```

Missing offsets fail explicitly. Old output folders were not migrated or overwritten, and old
checkpoints cannot safely be interpreted as new manifests. Keep any existing subtitle translations
separately until you deliberately migrate them.

Manual diagnostics, to run only when wanted:

```bash
.venv-whisper/bin/python scripts/test_faster_whisper.py --list
.venv-whisper/bin/python scripts/test_faster_whisper.py --job JOB_ID --limit 3 --device cuda --compute-type float16
node build/scripts/test_speech_detection.js short-clip.wav --save-report
```

For the standalone Whisper diagnostic, export its CUDA library directory as `LD_LIBRARY_PATH` before
launching Python, as in the upstream instructions; the Node launcher applies `WHISPER_LIBRARY_PATH`
automatically. Spectral diagnostics are limited to ten-minute clips and two workers. No diagnostic
was executed during this migration.
