# Hybrid local movies

Studio's **Local file** route keeps the original movie on the user's computer. No companion app,
local Codex installation, or local provider key is needed. Codex runs on the VPS under the server
owner's ChatGPT login; direct ElevenLabs remains the ASR fallback.

| Work                                        | Where it runs                         | What reaches the VPS                                                      |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| Inspect media and select embedded subtitles | Browser                               | Filename, duration, frame rate, audio index, size and sampled fingerprint |
| Extract text subtitles                      | Browser                               | Selected SRT, at most 1 MiB                                               |
| Check OpenSubtitles                         | Browser computes hash; VPS searches   | A 16-character movie hash and file size                                   |
| Prepare audio if subtitles are unavailable  | Browser                               | Continuous 16 kHz mono FLAC, including silence and delays                 |
| Transcribe and translate                    | VPS orchestrates ElevenLabs and Codex | Audio to the configured ASR provider; subtitle context to Codex           |
| Playback, screening conversion and waveform | Browser                               | No video, decoded PCM or waveform upload                                  |
| Correct and export subtitles                | Browser UI and VPS                    | Cue edits, notes and playback position                                    |

Embedded tracks use the same language, forced/signs-only, SDH, completeness and timing rules as
server-side files. Reused tracks use exact-timing translation. A target-language track skips ASR and
translation. Otherwise, OpenSubtitles checks hash-matched target and explicit source-language tracks
before audio preparation. Its credentials stay on the server. Bitmap subtitles need OCR and fall
back to audio. No failed translation silently falls back to ASR.

Hybrid audio uploads must contain exactly one 16 kHz mono FLAC stream with the movie's duration.
Video and truncated/mismatched audio are rejected. Full-movie ElevenLabs jobs use this prepared file
directly, without re-encoding on the VPS. Chunked ASR modes retain server-side chunking and
analysis. Server-resident watched files, YouTube and the existing raw-upload API retain their
previous processing and screening paths; folder watching always refers to the server filesystem.

## Screening and corrections

After generation, the VPS automatically creates the bilingual correction document without a
screening video. **Watch & correct** opens another tab and reuses the File reference from the open
Studio tab. Movies are never copied into IndexedDB. After closing the tabs or restarting the
browser, choose the matching local movie again. Size and a sampled content hash catch selecting
another cut; this edition check is not a full-file integrity hash.

Compatible movies play through a local Blob URL. A non-default selected soundtrack or unsupported
audio codec requires a local copy, preventing silent or wrong-track playback. The copy action is
also available if native playback has picture/sound problems. **Prepare local screening copy** makes
a 480p H.264/AAC MP4 on the user's computer. This optional operation can be slow on long films and
has a cancel button. **Save local screening copy** downloads it locally for reuse; its embedded
identity and duration are checked when reopening it. There is no automatic full-movie upload
fallback.

Waveforms decode audio in two-minute windows into 10 ms peak/RMS bins. IndexedDB caches only the
compact waveform, not the movie or PCM. Delayed audio, silence and chunk boundaries stay on the
playback timeline. Corrections and revision checks remain on the server. Playback, waveform
generation and screening preparation never rerun ASR or Codex. Existing jobs and edits are
unchanged.

## Deployment and limits

- Use HTTPS on the VPS; localhost also works. Fingerprinting needs a secure context. Prefer a
  current desktop browser for long films; Brave is covered by the browser check.
- `npm ci` and `npm run build` ship pinned, same-origin ffmpeg.wasm assets. The first engine
  download is roughly 31 MB and uses versioned private caching. There are no CDN requests. The CSP
  permits WASM compilation and same-origin workers without JavaScript `unsafe-eval`.
- WORKERFS reads File slices rather than copying a movie into WASM memory. The selection limit is
  128 GiB with `MAX_INPUT_DURATION_SEC` enforced. Only extracted audio is constrained by the smaller
  of `MAX_UPLOAD_BYTES`, `MAX_MOVIE_AUDIO_BYTES`, and the 512 MiB browser output ceiling.
- Optional screening output also has a 512 MiB ceiling. A truncated conversion is rejected.
  Demanding files may need a locally converted browser-playable copy or a more capable computer.
- Keep the tab open through preparation and transfer. Cancel stops the worker/transfer. If a
  transfer already completed, check the job list before submitting again.

See the upstream
[WORKERFS documentation](https://ffmpegwasm.netlify.app/docs/getting-started/usage/#use-workerfs).
The pinned core has a
[known ffprobe return-code issue](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/817); the app
requires fresh, valid metadata. Licenses and upstream source links are at `media-tools.html`.

## Verification

`npm test` covers server validation, translation without a movie, correction preservation,
audio-only upload rejection/reuse, hashing, and existing workflows. `npm run test:browser` builds
the app and uses Brave, synthetic media, fake Codex and an isolated server without provider keys.
Set `BROWSER_EXECUTABLE` if Brave is elsewhere. It checks real WASM extraction, transfers, playback,
saved edits, cancellation, waveforms with delayed audio across chunk boundaries, local screening,
wrong-file rejection and desktop/mobile layout.

Optionally set `HYBRID_LARGE_FILE` to a local movie over 2 GiB. The check reads metadata and decodes
50 ms near its end. It never uploads that movie or processes its whole soundtrack; this verifies
large-file seeking, not full-film browser throughput.
