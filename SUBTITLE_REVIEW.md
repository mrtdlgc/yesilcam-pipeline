# Subtitle screening and corrections

Completed jobs automatically prepare a screening. Choose **Watch & correct** on the job card:
`review-player.html?job=JOB_ID`. Subtitles are usable immediately; there is no approval state or
requirement to mark good cues. Watch and edit only the problematic passages.

## Correction workflow

- Press **E** or **Edit current cue** to pause on a line. Turkish/source dialogue and its
  translation appear together. Edit either text; corrections save automatically to the backend.
  **Ctrl/⌘+Enter** finishes saving and resumes playback.
- Adjust start/end times, use **Start here** / **End here** at the playback position, or nudge a cue
  by 0.1 seconds. Timing changes apply to both language tracks. Exact-timing translation preserves
  source timestamps; editorial translation builds a new paired timeline from source anchors.
- **Shift a passage or the whole film** applies an offset to the chosen cue range. Positive offsets
  show subtitles later. Invalid times are rejected; overlaps are flagged without blocking export.
- **Add missing dialogue** adds one paired cue. **Exclude this cue** omits an unwanted line from
  both tracks without erasing it. Existing cue IDs are retained; new IDs are unique and exports
  follow chronological order.
- Switch the playback language, replay/loop a line, search either language, or filter warnings,
  edits and notes. **Mark for later** and notes are optional reminders, not approval controls.
- **Download SRT/ASS** in the player or on the job card serves the current saved corrections.
  Generated originals remain separate and can be downloaded or restored per cue. Edited text keeps
  the reviewer's line breaks; current layout/readability reports flag lines that need shortening.

Editorial screenings pair regrouped source words with their translation. The original source SRT
remains downloadable from Job Details. Background lyrics omitted by the editorial pass still appear
as excluded cues; clear **Exclude this cue** to restore one. Story lyrics are italicized. Warnings
identify tentative song matches, proposed transcription repairs, uncertain delivery and unresolved
timing problems. Filter warnings to find these passages; every cue does not require approval.
Automatic omissions form part of the generated baseline, so restoring a cue to its original state
also restores its original omission decision.

Changing source dialogue does not run translation again: adjust the adjacent translation when its
meaning needs changing. No edit, screening retry, media playback or subtitle export invokes ASR or
Codex. Native subtitle preview updates as you edit; downloads wait for pending saves to finish.

Corrections, notes and playback position live on the persistent server volume. A revision check
prevents another tab from silently overwriting changes. Unsaved edits also have a browser draft;
network/login failures stay visible. On conflict, download the draft, load the saved version, or
explicitly keep your edits. Invalid unfinished timing fields are retained and block downloading an
older saved version by accident. Closing a page with unsaved changes prompts the browser's usual
leave-page protection. Export notes remains available as Markdown.

## Automatic preparation and storage

`PREPARE_REVIEW=true` is the default. New YouTube jobs select video up to 720p, preferring
H.264/AAC, so transcription and screening use the same downloaded source. Compatible H.264 and
VP8/VP9 video is remuxed without video encoding. Unsupported video gets a 480p H.264 copy with two
CPU threads; audio is copied when compatible or encoded to AAC/Opus. Audio-only jobs get audio
playback. The configured audio stream is used consistently. This work has its own **Prepare
screening** bar.

Media preparation respects the input size/duration, temporary reservation, free-space and media
timeout limits. Persistent screening copies consume additional disk and are not removed by temp
cleanup. Screening runs outside the queue slot. A failed screening retains source media and does not
pause the batch, while completed subtitles stay downloadable. **Retry screening preparation**
retries only this step. Older completed jobs have **Prepare screening**; their original input must
still exist, or a YouTube source must remain downloadable. Previously audio-only YouTube jobs can
only provide audio review when that is the retained source.

| Persistent path                                                | Contents                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `data/subtitle-reviews/JOB_ID.json`                            | Current bilingual cues, generated baseline, notes, revision and playback position |
| `data/subtitle-review-media/JOB_ID.json`                       | Completed-media identity and reuse metadata                                       |
| `review-sessions/JOB_ID/screening.mp4` or `.webm`              | Durable screening media                                                           |
| `output/subtitles/`                                            | Unchanged generated subtitle files                                                |
| `output/reviews/JOB_ID-editorial-source.json`                  | Native source anchors, scoped voices, audio events and available scene cuts       |
| `output/reviews/*-paired-source.srt` and `*-paired-target.srt` | Matching editorial review tracks, including omitted lyrics                        |
| `output/reviews/JOB_ID-translation.json`                       | Source coverage, editorial decisions, repairs and paired-track hashes             |

Current exports are generated from one atomically saved review document. Back up that document
alongside media and the rest of `/data`; copying only `output/subtitles/` does not include human
corrections. All review APIs and media require the app login and support deployment subpaths; media
supports byte-range seeking.

Standalone translation jobs reuse their original job's screening when linked. A separately supplied
SRT with no film opens the text editor; **Open matching film** lets the reviewer play a local file
without uploading it. That local file stays in the browser and must be selected on another device.

## Legacy Ah Nerede screening

The older `?session=...` player remains available for the prepared Ah Nerede comparison. Its notes
are browser-local and do not edit subtitles. New `?job=...` screenings use the backend correction
workflow above.

The review player at `review-player.html?session=ah-nerede-first-half` plays the first 45:04 of Ah
Nerede with the unchanged Turkish Scribe v2 transcription. It uses the running studio's password
gate and does not start a pipeline job.

### Reviewing the legacy screening

- Press Play and watch with subtitles enabled. The native video controls also provide seeking,
  volume, and fullscreen playback.
- Click a subtitle in Dialogue to jump to one second before it. Search by dialogue text or cue
  number, such as `563`, and filter automatic timing/layout warnings.
- Use Replay cue or Loop selected cue to inspect a line with surrounding audio.
- Click Note current cue to pause and select the line currently on screen. Mark Needs correction and
  describe the wrong word, timing, speaker, or missing speech.
- Export review notes downloads a Markdown file with the original cue numbers, timestamps, speaker
  labels, original text, and your notes.

Notes and playback position are saved in this browser's local storage, keyed to the source SRT's
SHA-256. They are not saved to the server or synchronized across browsers. Export them before
clearing browser data. Notes never modify the SRT. Speaker IDs are tentative voice groups, not
verified character names.

When a translation is prepared, the screening includes a link to the other language. Switching
carries the current playback time across; each language keeps its own notes and subtitle file. The
English first-half screening uses the session ID `ah-nerede-first-half-en`.

### Legacy prepared sessions

Legacy sessions require an explicit `?session=SESSION_ID` URL. Put their media, `session.json` and
subtitle tracks under `DATA_DIR/review-sessions/SESSION_ID/`. Symlinks must stay inside that root.
These older browser-local notes are separate from the persistent `?job=JOB_ID` correction editor.

Current exports use sequential cue numbers in chronological order while the editor retains stable
internal IDs. Original exports preserve their original IDs. Playback positions are saved separately
under `data/subtitle-review-positions/`; watching does not rewrite the full correction document.
Removing a screening copy from Job Details preserves all corrections and allows later preparation.
