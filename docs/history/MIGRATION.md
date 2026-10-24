> Historical record of the earlier implementation. For current behavior, use
> [README](../../README.md) and [deployment](../../DEPLOYMENT.md).

# TypeScript and deployment migration

Implemented 2026-10-23–24 for a CPU Coolify host using cloud transcription.

Follow-up on 2026-10-24: the default pipeline now uses original audio and OpenRouter Scribe v2;
Demucs was removed from the application path and default image. The sections below record the
earlier TypeScript migration. See [README.md](README.md) for the current processing flow and safe
migration of pre-ASR jobs.

## What changed

| Area                 | Result                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application language | All 38 former JavaScript source files moved to TypeScript; strict server and browser compiler configurations; shared queue, audio, model, and adapter types                                                         |
| Python               | The eight audio/ML scripts remain Python; the Whisper diagnostic now respects `DATA_DIR`                                                                                                                            |
| Build                | TypeScript compilation plus an explicit asset copy for HTML/CSS/SVG, provider catalog, Python helpers, and the comparison matrix                                                                                    |
| Container            | Multi-stage image, Node 24, Python 3.12, CPU wheels, FFmpeg, yt-dlp/EJS, non-root user, init process, health check, persistent `/data`                                                                              |
| Authentication       | Bootstrap password, scrypt hash, opaque expiring sessions, login throttling, logout/password rotation; frontend, API, and generated files gated                                                                     |
| Connections          | Encrypted persistent values, masked secret fields, immediate runtime updates, explicit clearing, optional legacy environment fallback                                                                               |
| Frontend             | Responsive cinema-themed workspace, accessible native details dialog, Studio/library/translations/connections navigation, login page, per-job cleanup controls                                                      |
| YouTube              | Shared downloader configuration, explicitly enabled Node runtime, bundled matching challenge solver, no-simulation download, finite-video checks, bounded retries/size, optional saved cookies, actionable failures |
| Persistence          | Application assets and runtime paths separated; kernel queue lock works across replacement containers; request lock identities distinguish PID reuse                                                                |
| Documentation        | Five prose TXT guides converted to Markdown with headings, tables, links, and fenced commands; pip requirement files retain their required `.txt` format                                                            |

The existing separation, VAD, hallucination review, original offsets, cloud request checkpoints,
cost allowances, translation validation, and recovery flow were retained. Shared audio types
describe timing and words; raw vendor JSON and legacy diagnostic metadata remain explicitly dynamic
where their shapes vary. Strict compilation does not replace the existing runtime validation or
manual listening checks.

The new password and connection modules are separate from the queue/pipeline. Credentials are
captured for each operation and never persisted in a job's settings. A key save affects later
operations; a change of endpoint, region, model, or audio can invalidate a recovery identity instead
of silently reusing a different request.

The original recovered checkout and output files were not changed. This goal's starting working tree
was separately snapshotted under [local evidence directory] with a SHA-256 manifest. Nothing was
pushed or deployed.

## Verification performed

- `npm run typecheck`: both strict TypeScript projects pass using `tsc --noEmit`.
- Python AST parsing: all eight Python scripts parse without importing their dependencies.
- JSON parsing, relative module references, HTML IDs/handlers, and local Markdown links checked.
- Browser DOM references match the HTML; duplicate IDs and inline event handlers checked.
- Formatting checked with Prettier; tracked diff whitespace checked with Git.
- Production npm lockfile audit: zero reported vulnerabilities. This does not cover the eventual
  container OS or resolved Python environment.
- Public package metadata checked for the downloader's EJS dependency and the pinned CPython 3.12
  Linux x86-64 CPU PyTorch wheel. No wheel/model download or Python installation was performed
  locally.
- Confirmed no `build/`, `.env`, queue, temporary audio, or generated output directories were
  created by verification.

Small Node development dependencies were installed with lifecycle scripts disabled for type checking
and formatting. The host uses Node 22; the image selects Node 24. No build output was emitted
locally.

Local evidence is under [local evidence directory], including `typecheck.log`, `source-checks.json`,
`npm-production-audit.json`, and the starting snapshot.

## Verification reserved for deployment

No local build, Docker build/run, application test, browser run, model inference, or paid
transcription was performed. The image's first build, proxy behavior, login/credential persistence,
visual layout, actual YouTube access, provider compatibility, and audio quality must be checked on
the deployed host.

Start with the checklist in [DEPLOYMENT.md](DEPLOYMENT.md), then the
[pipeline checks](MANUAL_CHECKS.md) and
[transcription comparison workflow](TRANSCRIPTION_COMPARISON.md). A successful static check is not a
claim that YouTube permits the hosting IP or that a transcription model improves every Yeşilçam
soundtrack.
