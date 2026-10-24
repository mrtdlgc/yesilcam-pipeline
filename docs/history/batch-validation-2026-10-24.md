# Earlier batch validation

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
