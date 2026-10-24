> Historical record of the earlier implementation. For current behavior, use
> [README](../../README.md) and [deployment](../../DEPLOYMENT.md).

# YEŞİLÇAM REVIVAL — IMPLEMENTATION HANDOFF

> Historical report for the original local-app audit on 2026-10-23. The verification counts and
> no-install statements below describe that pass. The TypeScript/Docker migration supersedes its
> loopback-only deployment and JavaScript setup. See [Deployment](DEPLOYMENT.md) and
> [current validation](MIGRATION.md). 2026-10-23

Working checkout: [local evidence directory] Original preserved: [original local archive] Audit
evidence: [local evidence directory]

This is a source-level remediation of the 27 audit findings and the subsequent audio-path review.
Runtime acceptance remains for the owner's manual checks. No build, application test, model
import/inference, model download or dependency installation was performed. The Node lockfile was
resolved with lifecycle scripts disabled. No GitHub remote, push, deployment or original-output
migration occurred.

## WHAT WAS KEPT

Demucs vocal separation, faster-whisper large-v3, previous-sentence context, sequential resource
use, energy/Silero timing, source offsets, raw-response checkpoints, the custom hallucination
patterns and the spectral diagnostic worker. Word timestamps remain optional and off by default. The
work targets the actual disconnects between these components; it does not substitute an
unbenchmarked ASR model or claim measured accuracy gains.

## AUDIT FINDING -> IMPLEMENTATION

- **H-01:** Translation writes accept only manifest-listed filenames and cue content; path
  components/real paths are checked. Password gating, configured Host/Origin checks and a custom
  mutation header now protect the deployed UI. server.ts, lib/files.ts.
- **H-02:** All active ffmpeg/ffprobe/yt-dlp calls use argument arrays without a shell.
  scripts/lib/process.ts, 1_download_video.ts, pipeline.ts.
- **H-03:** UI uses textContent/DOM creation and addEventListener. No innerHTML or inline event
  handlers remain. Input URLs/IMDb IDs are validated. public/app.ts.
- **H-04:** Every queue reader/writer uses one serialized JsonStore and atomic rename; async route
  errors are handled by Express 5. server.ts, lib/files.ts.
- **H-05:** Resume/retry use the durable scheduler. Each job owns its worker with request IDs, one
  pending request and scoped cleanup. lib/whisper-worker.ts.
- **H-06:** Child exit/error/abort and startup/request deadlines reject pending work; cancellation
  kills the Linux process group. lib/process.ts, whisper-worker.ts.
- **H-07:** Every retained chunk uses its explicit film offset, including a single late chunk after
  filtering. pipeline.ts, 3_transcribe.ts.
- **H-08:** One SRT parser supports BOM, CRLF, LF and whitespace separators. lib/srt.ts.

- **M-01:** Queued work survives restart; running jobs become interrupted and resumable. Paused jobs
  stay paused. No invisible in-memory-only job map. server.ts.
- **M-02:** local_whisper.py --check no longer requires an audio argument. Cloud fallback is
  disabled unless explicitly configured. 3_transcribe.ts, local_whisper.py.
- **M-03:** Removed the hidden 10% speech gate. VAD runs after separation and flags uncertain chunks
  by default; explicit discard settings are recorded.
- **M-04:** Upload byte/time/concurrency/duration checks, abort/startup staging cleanup, temporary
  storage reservations, per-job cache directories and cleanup UI. History removal cannot orphan
  retained cache through the UI.
- **M-05:** Unique job folders and immutable manifests isolate reruns. Same-source retry reuses
  translation files; merge reads only the authoritative file list.
- **M-06:** Translation imports validate complete unique IDs and immutable source/timing. Merge and
  Ollama completion reject missing text/placeholders. Original cue IDs and timestamp strings survive
  translation. 4_chunk_srt.ts, 5_translate.ts.
- **M-07:** Source/target language travel with each job; prompts and filenames use them. Track
  metadata replaces the broken regex language guess. Auto can report unknown/multiple languages
  without inventing a Turkish label.
- **M-08:** One OpenSubtitles client uses POST /download and bounded HTTP requests. Local movie
  lookup requires an exact hash match; no fuzzy completion skip.
- **M-09:** A movie is marked processed only after usable output is saved. Failed downloads are
  warnings followed by generation, not successful completion.
- **M-10:** Segmentation considers both characters and duration, uses real word times when present,
  and flags estimates. Final cues enforce the duration limit.
- **M-11:** Shared chunk settings, rebalanced tails and a hard maximum duration.
- **M-12:** Both aligners can adjust in either direction. Cleanup resolves overlap once and
  validates final positive, nonoverlapping millisecond timing.
- **M-13:** Media processes are asynchronous and bounded; no synchronous shell extraction.
- **M-14:** Worker and one-file transcription share whisper_runtime.py and explicit environment
  resource limits. CPU fallback is recorded in runtime metadata.
- **M-15:** Upload, YouTube, watched-film and resume wrappers share runPipeline; pause and
  translation switches no longer diverge across entry points.
- **M-16:** Original chunk manifests are saved independently of Demucs results. Recovery maps stable
  IDs and refuses missing/mismatched offsets/responses.
- **M-17:** Node dependency surface reduced to Express/dotenv with refreshed lockfile. Direct Python
  versions pinned; packaged Silero replaces moving torch.hub. scipy explicit; patched PyTorch pinned
  with separate CUDA-runtime setup.

- **L-01:** Ignore credentials, cookies, local settings, environments, runtime data, intermediate
  audio and generated outputs. No original secrets were copied.
- **L-02:** README rewritten around this local implementation; [MANUAL_CHECKS.md](MANUAL_CHECKS.md)
  covers quality, alignment, recovery, imports and local service boundaries.

## ADDITIONAL AUDIO-PATH REPAIRS

- Hallucination filtering and alignment consume the SAME vocal chunk that was transcribed. No
  fallback to the mixed full-film soundtrack for these stages.
- Alignment occurs after splitting, so new cue boundaries are checked too.
- Suspicious/filter/alignment metadata survives merging and export into reviews.
- Duration anomalies alone do not raise deletion scores. Whisper seek is treated as a normal window
  offset, not independent hallucination evidence.
- One Demucs model load per batch; CPU-held bags avoid loading all submodels into GPU memory
  together; shifts and overlap settings are connected; vocals are float.
- Separation checkpoints use input hashes/model settings and atomic output files.
- Silero frames use a sequential 512-sample hop and reset model state per chunk.
- Native source quality is retained until lossless chunk extraction; accurate input seeking avoids
  repeatedly decoding an entire film prefix. Timestamped audio gaps are compensated before WAV
  export.
- Both alignment thresholds and silence settings are wired through. Missing Silero is an explicit
  energy fallback with review flags; failed Demucs fails the job so unseparated input cannot
  silently masquerade as cleaned speech.
- Raw responses survive for review; translated text is checkpointed cue by cue.

## STATIC VERIFICATION

- JavaScript: node --check on all 31 JS files; no syntax errors.
- Python: ast.parse on all 8 Python files; no syntax errors. No imports executed.
- Relative JS imports resolve; only express and dotenv are external imports.
- Browser element references match HTML IDs, with no duplicate IDs.
- git diff --check passes. Removed hazardous-pattern scans have no matches for execSync, shell:true,
  torch.hub, innerHTML or inline event handlers in active code.
- npm audit --package-lock-only: 0 reported vulnerabilities in the new lockfile.
- OSV metadata queries: 0 reported advisories for the 9 directly pinned Python runtime packages,
  including CUDA library pins. This is NOT a scan of a resolved Python environment or every
  transitive dependency.
- SHA-256 comparison: all 36 originally audited source files unchanged.
- No node_modules directory created in the working checkout.

Evidence JSON files are in the audit directory: static-checks-after.json, npm-audit-after.json and
python-direct-audit-after.json.

## PRACTICAL LIMITS / NEXT CHECK

The implementation is ready for manual verification, not declared runtime-proven. Python wheel
compatibility, GPU memory/runtime behavior, provider credentials, browser behavior and film-level
timing/transcription quality remain untested. The original source/output copies are untouched; old
queues and incomplete raw artifacts were not silently migrated. A fresh local setup is needed in
this checkout.

Start with [MANUAL_CHECKS.md](MANUAL_CHECKS.md) sections 1–3 on a familiar short passage. Review the
actual vocal stem and resulting cues before spending time on a full film or changing the ASR model.
The named goal's authorized implementation work is complete once the final static pass succeeds; the
owner explicitly reserved runtime checks.
