# Earlier static screening

### Legacy local files and deployment

Source files are `public/review-player.html`, `public/review-player.css`, and
`public/review-player.ts`. The normal TypeScript/assets build includes this page. The existing
deployment received only these page assets and its browser module; the server was not restarted and
the main full-film job remains paused.

The prepared screening lives on the Windows-C disk:

```text
[local screening archive]
```

The older running server uses `build/public/review-sessions/ah-nerede-first-half` as a symlink to
that directory. New deployments serve prepared sessions from the persistent volume instead:
`DATA_DIR/review-sessions/SESSION_ID/` (`/data/review-sessions/SESSION_ID` in Docker). Put only the
session metadata, video, subtitle tracks and review README there. Use the same
`review-player.html?session=SESSION_ID` URL. No image rebuild or pipeline run is needed when adding
a prepared session. There is no cloud media-upload endpoint for creating screenings automatically.

Copy both the Turkish and English session directories to the server. Dereference local symlinks when
copying, or replace them with links that stay within `/data/review-sessions`. The server rejects
links escaping that root and supports authenticated byte ranges for seeking. This route does not
expose the state root or credentials. Old local static links remain a compatibility fallback.

The directory contains `session.json` (800 cues, speaker labels and warnings),
`Ah-Nerede-first-half.webm`, the original `.tr.srt`, and its `.tr.vtt` conversion for browser
playback. The VTT preserves every cue number and timestamp. All media and subtitle requests use the
same authenticated local origin.

For a desktop player, `Ah-Nerede-first-half.mkv` contains the same video and audio with the Turkish
SRT embedded as the default subtitle track. A matching-name `Ah-Nerede-first-half.srt` is also
provided. No subtitle text is burned into the video.

The video is 720p from the same YouTube source used for transcription. Its audio comes from the
saved original soundtrack, copied without re-encoding. No ASR, Demucs, Silero, or translation
request is needed to watch it.
