# Opus audit remediation

This records the response to [opus-audit.md](opus-audit.md), dated 2026-10-24. The original audit
remains a historical snapshot. Runtime media, credentials and account state are excluded from Git.

## Repository and recovery

- **R-1:** Preserved the complete pre-fix TypeScript implementation in commit `cc77fe4` on
  `audit-fixes`, pushed to the private `mrtdlgc/yesilcam-pipeline` repository after verifying its
  visibility. Remediation follows in a separate commit. Deployment revisions should be tagged only
  when actually deployed; this work does not deploy the production application.
- **O-1:** Shutdown stops new work and submissions, lets submitted ASR operations save their
  responses within `SHUTDOWN_GRACE_MS`, then aborts remaining local work. Compose uses a 31-minute
  stop grace. Kernel-guarded request locks reclaim a verified dead owner without racing another
  reconciler. Job Details and the CLI share inspection, existing-ID retrieval and explicit
  replacement authorization, retaining prior billing evidence and requiring a note for another paid
  attempt. Direct ElevenLabs retrieval uses its official
  [GET transcript API](https://elevenlabs.io/docs/api-reference/speech-to-text/get). Its webhook
  mode exists upstream but is not enabled here. A forced kill or elapsed shutdown grace remains
  uncertain: incomplete upload is never assumed to prove non-billing.
- **O-2:** Subtitle completion releases the queue slot. A separate serialized screening worker runs
  at reduced priority, with a timeout scaled to media duration. Screening failures retain sources
  and do not pause transcription.
- **O-3:** Screening-only re-downloads are removed after durable media preparation. Cleanup checks
  actual temporary files instead of relying on a historical removal flag.
- **O-4:** Codex heartbeats update stage detail without appending log entries.
- **O-5:** Child process groups are registered and terminated on normal process exit. Fatal server
  exceptions abort active work and terminate children; graceful shutdown has a separate drain path.

## Correctness and billing

- **C-1:** Finite isolated timing anomalies are clamped/sorted and flagged `timestamp_repaired`.
  Millisecond collisions get a valid flagged display interval. Structural failures, including
  missing transcript/word text and non-numeric word times, remain errors; raw responses survive.
- **C-2:** IMDb-only OpenSubtitles results are saved as references and cannot bypass ASR. Machine
  translations are excluded; exact movie-hash matches take priority, ranked by download count.
- **C-3–C-6:** Unicode repetition is flagged without being sufficient to delete dialogue; FFT
  coverage displays a real percentage; valid Cyrillic/circumflex prompts survive; relative energy
  plus low log probability alone cannot delete quiet dialogue.
- **C-7:** Uploaded media is classified from probe streams, including embedded subtitle/hash lookup
  for video uploads.
- **C-8:** Current SRT/VTT exports use sequential chronological numbers; editor IDs and original
  exports retain their original identities.
- **C-9:** Source validation has an accurate function name; embedded language aliases include common
  ISO 639 alternatives; YouTube regional language keys are supported; screening duration validation
  uses the selected streams with a bounded tolerance.
- **B-1:** Newly prepared cloud chunks use 16 kHz mono signed-16 FLAC. Saved audio/checkpoints keep
  their original identities, avoiding an implicit replacement charge.
- **B-2:** The UI warns when the catalog's price snapshot is older than 30 days. Rates and model IDs
  are not silently refreshed and no estimate is represented as an invoice.
- **B-3:** Legacy pre-ASR migration deliberately retains its documented OpenRouter billing route.
  New jobs default to direct ElevenLabs; existing paid jobs are not migrated.

## Security, storage and interface

- **S-1:** Login backoff counts failures per client and resets on success. There is no shared
  failures quota; bounded concurrent verification protects scrypt resources. `TRUSTED_PROXIES`
  explicitly identifies proxies whose forwarded client addresses can be trusted.
- **S-2:** All app-launched FFmpeg/ffprobe media inputs use `file,pipe` protocol restrictions.
- **S-3:** HTTP 5xx responses are generic; internal details stay in server logs.
- **S-4:** An optional externally supplied vault key is never persisted or passed to children.
  Existing vaults reject a different key. The colocated-key mode remains supported and documented.
- **S-5:** Dialogue diagnostics require explicit `LOG_TRANSCRIPT_TEXT=true`.
- **P-1:** Queue state is cached by its sole owner, shared saved defaults replace per-job full
  settings copies, logs are stored per job, and progress is coalesced to one write per second with
  explicit flushes at transitions. Codex availability checks run outside the queue mutation lock.
  Finished history can be archived without deleting output/corrections.
- **P-2:** Sorted energy/time searches and nearest alignment boundaries use binary bounds.
- **P-3:** Playback positions use separate small files.
- **P-4 / U-1:** Polling follows the visible workspace, slow-changing lists are cached, and GETs use
  conditional ETags. Unchanged job lists retain their nodes; focused or busy controls are not
  replaced during refresh.
- **P-5:** Studio reports temporary and persistent storage use. Job Details can remove a screening
  copy while keeping corrections and originals; history archiving keeps per-job records on disk. Raw
  paid-request evidence is intentionally retained.
- **P-6:** Captions update in place; sorted editor cues are cached between edits.
- **U-2:** Manual scans take two observations one second apart in a single action; automatic scans
  still require ten seconds of file stability.
- **U-3:** Translation jobs have their own server-filtered pagination.
- **U-4:** Signed-out HTML links redirect to login.
- **U-5:** Subtitle upload encoding is explicit, with UTF-8 as the default. Invalid decoding cannot
  silently fall back to Turkish text.
- **U-6:** Tiny interface text has been enlarged, unavailable/busy cursors differ, async buttons
  preserve availability, and notices can be dismissed.
- **U-7:** The legacy player requires an explicit session; its film-specific default and track label
  are removed.

## Code, tests and deployment

- **Q-1:** Removed obsolete Demucs/VAD Python entrypoints, the backup worker, unused wrappers,
  obsolete Whisper diagnostics and unreachable Ollama translation. Git retains their history.
  Compatibility settings needed to read old jobs remain explicitly supported.
- **Q-2:** Added typed manifest, paid-request and Codex-receipt shapes; removed unrestricted index
  signatures from words, segments, chunks and pipeline options. Vendor payloads are still validated
  at subsystem boundaries; this is not a claim that every historical `any` has been eliminated.
- **Q-3:** Node import prefixes, FFT debug noise, duplicate CSS rules, comparison lock identities
  and stale review `text` fields are corrected. Production TypeScript has no DOM library; browser
  and DOM-based test projects are checked separately.
- **T-1–T-4:** Retained the existing integration suite, isolated the two test data roots, added
  synthetic wire-contract fixtures for all 12 adapter entrypoints, and added regressions for timing,
  login, cleanup, locks, queue persistence, URL variants, portable paths and shutdown during a
  submitted request. Synthetic fixtures do not establish live provider compatibility or billing.
- **D-1:** Production build excludes tests and documentation generation; asset copying excludes test
  fixtures. Build output is cleaned first so obsolete compiled files cannot survive.
- **D-2:** Python comments accurately distinguish the shared CPU image venv from native CUDA
  installations that need isolated libraries.
- **D-3:** Loopback host aliases work locally, development watches source and rebuilds it, and
  `npm ci --ignore-scripts` installs the exact lockfile including the pinned Codex CLI. Linux
  remains required for process identities and advisory locks.
- **D-4:** GitHub Actions validates the cloud image on native x64 and ARM64 runners and performs
  credential-free startup/access-control checks. Its actual outcome is recorded below.
- **D-5:** New jobs/manifests use data-root-relative paths and signatures. Legacy paid checkpoint
  identities are retained. Moving data still requires preserving source metadata and copying the
  complete volume, including external source media when applicable.
- **DOC-1:** Current docs describe actual defaults, Codex packaging, recovery, chunk formats,
  screening behavior and retention. Dated operational narratives moved to `docs/history/`.
  `npm run docs:providers` generates the provider table from the catalog and supports `--check`.

## Verification

- `npm ci --ignore-scripts`: clean lockfile install, no reported vulnerabilities.
- `npm run typecheck`, `npm run build`, `npm run format:check`, generated provider-doc check and
  `git diff --check`: passed. The production build excludes test fixtures.
- Full automated suite: 83 tests passed, including submitted-request shutdown and retry without a
  second POST. A further real-server scanner regression checks stable versus growing files.
- Isolated headless Chrome check: login redirects, polling focus, existing-ID recovery, translation
  pagination, encoding selection, desktop/mobile layout, saved correction reload and media playback
  passed with no page errors. No real account or provider was used.
- The native ARM64/x64 CI image-build result will be recorded after the private push.

No paid transcription, Codex inference, model download, or production deployment is part of this
remediation. Live provider contracts and target-host acceptance remain operational checks.
