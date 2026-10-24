# YEŞİLÇAM REVIVAL — MANUAL ACCEPTANCE CHECKS

Updated 2026-10-24 for direct ElevenLabs full-movie Scribe, diarization, original audio, and
Netflix-inspired SRT/ASS exports.

This end-to-end checklist remains for manual execution. Focused automated checks and the small Ah
Nerede API comparison do not replace it. Start with short clips, then one complete film. Keep
existing subtitle/translation outputs unchanged.

## Direct ElevenLabs full-movie acceptance

Save an ElevenLabs key in Connections, then select ElevenLabs / `scribe_v2` / Automatic (or Full
movie), with Identify speakers enabled. First use a short clip and Pause before transcription.
Expect one `movie.flac`, no Silero/Demucs process, and a review pause. Resume explicitly: the ASR
bar is indeterminate with elapsed-time updates until the response arrives. Check word times, speaker
turn boundaries, source SRT, speaker JSON, and gross usage estimate. Restart after completion and
retry without another API submission. A timeout must leave uncertain request evidence and refuse an
automatic second charge.

For Ah Nerede, select these options in the form and click **Use form options (stay paused)** on the
paused row. Old audio remains on disk. Resume prepares the full audio and pauses again; review it
before the second Resume sends it. Changing settings must be rejected if any ASR checkpoint exists.

Compare speaker labels by listening; they are tentative voice clusters, not identified characters.
Translate an unchanged generated source through the translation tab and check the Codex prompt
contains the matching speaker sidecar. Modify that source and verify stale speaker metadata is not
attached. Neither path may change cue IDs or timing during translation.

After the short check, test a complete film, including its first dialogue, long silence, scene
changes, overlapping speech and final dialogue. Confirm the container stays within host RAM and that
native timing matches the actual video. Direct full-film provider acceptance and ARM image execution
remain manual checks; automated tests use simulated provider responses.

## 1. setup and first input

Complete the deployment checks in [DEPLOYMENT.md](DEPLOYMENT.md), then follow README setup. Keep
movies/ empty initially to avoid automatic film jobs. Sign in to your deployment. Upload a 30–60
second clip containing dialogue over music, a quiet/short line, and a silent passage. Use spoken tr
/ target en. Expected: direct ElevenLabs and `scribe_v2` are selected by default; a continuous
original-audio FLAC feeds ASR without a Demucs stage, process, or model download. Source SRT and
review JSON appear. A translation appears only when enabled. A missing dependency is a visible
error.

## 2. transcription quality

Listen to the original chunks and compare raw Scribe output with the speech. Inspect low-speech
flags and dropped text, especially brief exclamations and names. The default VAD policy must keep a
chunk containing one second of dialogue in 30 seconds. Historical jobs may retain vocal pairs for
comparison, but new jobs should show original audio only.

## 3. film timeline

Load the source SRT against the original film, not against concatenated vocals. Check cue
onsets/offsets at the beginning, a chunk boundary and near the end. Include a source whose audio
starts later than video, and a film with gaps. Check both Silero and energy alignment in separate
NEW jobs. Starts may move later and ends earlier as well as expand, within configured limits.
Inspect review flags for approximate timing. Cues must have positive duration, no overlap and within
the normal seven-second target, except flagged native long-word intervals which remain intact for
review. Confirm no line vanished just because its original timing was unusually long/short.
Optional: enable WORD_TIMESTAMPS for a new job and compare the split timing.

Open the SRT and styled ASS in a player against the same clip. Check white outlined text at bottom
center, Turkish glyphs, italics, sensible line breaks, and no more than two lines/42 characters
unless flagged. Check the layout report in Details: short/long durations, reading speed, overlaps
and long words must remain visible for review, with no text silently deleted. SRT timing remains
exact; ASS rounds to centiseconds. Test dual-speaker lines and a very short cue. Check scene cuts
and on-screen text manually; the automated preset does not claim Netflix delivery certification.

## 4. chunk edge cases

In explicit Short chunks mode, a 45-second clip must produce at least two chunks, each <=30 seconds.
In direct ElevenLabs Full movie mode, the same clip must remain one request. A short clip must still
run through the same pipeline. If testing SILERO_DROP_NON_SPEECH=true, retain a late speech chunk
and confirm its source-film offset survives even when it is the only retained chunk. That discard
policy is intentionally OFF by default.

## 5. queue, pause and restart

Submit two small jobs while one is processing; only one may run inference. With the **Pause before
transcription** checkbox (or `PAUSE_BEFORE_TRANSCRIPTION: true` in `config.ts`), try upload, YouTube
and movies/ inputs. Each should stop as paused, remain listed, and resume through the same queue.
Stop the server during transcription and restart. The interrupted job must remain visible, and Retry
should reuse validated completed chunks. Cancel a job and confirm no child ffmpeg/Python process
continues working. Terminate a worker once during a short test: failure must release the queue. A
restart or retry before the review gate must still pause before ASR; only explicitly continuing a
paused job crosses the gate.

On a copy of a legacy paused Demucs job with no ASR checkpoints, restart the updated server. It must
remain paused, select OpenRouter Scribe v2 and original chunks, save the previous manifest, and keep
archived vocal playback. Repeat with any ASR request checkpoint: model and input must remain
unchanged. A missing original must produce a visible error without rewriting the manifest.

## 6. recovery integrity

Work only on a copy of a small job for this check. Remove a chunk response or its manifest, then
invoke the raw recovery CLI. It must refuse to fabricate zero offsets or match a later response by
array position. Change a retained input chunk: retry must report that the audio changed. Raising an
operational timeout/storage limit should not invalidate completed transcription checkpoints.
Changing the model requires a new job.

## 7. translation round-trip

In **Translations**, confirm Codex reports ChatGPT login. Select/upload a complete SRT, set the
source and target languages, and translate. Include Turkish Windows-1254 TXT input and a BOM/CRLF
SRT. Compare every cue number and timestamp in the result, check the original is untouched, and read
the integrity/readability report. Verify the title, slang, recurring jokes and names in context.
Cancel a running translation: it must stop without publishing a partial SRT. Retry only when ready
to use more plan allowance. A failed or exhausted Codex account must never trigger a paid API call.
Also check Studio's optional post-transcription translation and that no new translation chunk folder
is generated by default. The model may reject a film beyond its context/output capacity; that must
be a visible failure rather than a truncated published subtitle.

For legacy exports (`EXPORT_TRANSLATION_CHUNKS: true`): download a JSON chunk. Translate all entries
and import it. Compare all cue numbers and timestamp strings in the merged SRT with the source SRT.
Try an unknown/duplicate/missing ID, changed time/source, invalid JSON, empty translation and a
placeholder. Each must fail without changing saved cues. Leave one chunk untranslated: merge must
fail rather than export source text under an English filename. Repeat with slim JSON and CRLF/BOM
source content. Re-run the same title as a NEW job: both translation folders must remain. If using
Ollama, interrupt translation and retry; completed cues should resume, and source SRT/downloads
should remain accessible after failure.

## 8. ui and local http boundaries

Watch each stage bar during a small job: chunk counts should advance independently, disabled stages
should say Skipped, and model setup with no percentage should stay indeterminate. Keep Details open
to verify live updates. Cancel a stage and check that its last measured count remains visible. For a
job with **Pause before transcription**, interrupt/retry before preparation finishes: it must still
pause before speech detection and ASR. Open **Review audio chunks**, play the source audio, change
pages, and download a prepared audio file. A legacy job should retain its archived vocal comparison.
Seeking should work via HTTP Range requests. An incomplete archived vocal file must not be playable;
a signed-out audio request must return 401. Closing the dialog should stop playback.

Use a title containing apostrophes, quotes, Turkish characters and HTML text. It must display
literally, including in logs and modal details. A request with another Origin/Host or without
X-Yesilcam-Request: 1 on a mutation must be rejected. Normal UI uploads/imports must still work.
Translation filenames containing ../, encoded separators, or targeting a manifest/non-manifest file
must be rejected. A symlink escaping the export directory must not allow reading or overwriting an
outside file.

## 9. upload, storage and cleanup

Interrupt an upload and confirm its staging files are removed and no job is queued. Confirm
oversized/empty/non-audio/over-duration files are rejected. A second simultaneous upload should be
rejected. A storage-budget failure must be explicit. Cleanup must be refused for
queued/active/paused jobs. After a finished job's cleanup, exports remain downloadable, retry is
disabled, and history can be deleted. Restart must remove abandoned upload staging only.

## 10. existing subtitles and scanner

A growing file should wait until stable. A file with embedded Turkish only must not count as
completed English output. A usable embedded English SRT or exact OpenSubtitles match can complete
the job after validation and saving. A provider download failure must continue generation or produce
a visible retryable error, never permanently mark the film processed with no output. Failed jobs
should not be silently requeued every minute; use Retry/Reset.

## 11. full film

After the short checks pass, run one familiar film. Review short dialogue, soundtrack-heavy scenes,
names, singing, emotional speech, chunk joins and the final minutes. Record processing time, peak
memory and manual correction count. This is the evidence needed before selecting a replacement ASR
model or scaling to the film catalogue.

## 12. Automatic screening and corrections

Complete a short video job with temporary retention off. Its **Prepare screening** bar should finish
and **Watch & correct** should open working video and subtitles after the temporary source is gone.
Try a YouTube source too: the new download should include video up to 720p. Check seeking,
fullscreen, audio-track selection, language switching and phone-sized layout on the actual
deployment.

Press **E** during a line, edit its translation and use **Ctrl/⌘+Enter** to save and continue.
Adjust a cue with **Start here**, **End here** and 0.1-second nudges; check the changed preview and
both downloaded language tracks. Apply an offset to a short range and confirm neighboring cues stay
unchanged. Add a missing line, exclude an unwanted one, and restore a generated cue. Downloads
should always be available without marking untouched cues or approving the film.

Edit in two tabs, simulate a dropped connection, and reload. Unsaved drafts/conflicts must be
visible; saved text, notes and position should return. Invalid half-typed timestamps must not be
silently discarded or let a stale subtitle download through. Inspect current SRT/ASS and generated
originals separately. After a server restart/redeploy, verify the corrections and screening media
survive.

A screening-preparation failure should leave subtitles available, retain the source while the next
subtitle job proceeds. Use **Retry screening preparation**; provider usage must not increase. Legacy
`?session=...` Ah Nerede screenings keep their original browser-local notes workflow.
