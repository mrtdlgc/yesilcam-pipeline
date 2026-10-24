# Full-movie Scribe with a direct ElevenLabs key

## Use it

1. Save your **ElevenLabs API key** in Connections. Key changes need no rebuild or restart.
2. In Studio, choose **ElevenLabs**, model **scribe_v2**, and **Automatic** or **Full movie**.
3. Keep **Identify speakers** enabled. Optionally pause to review the audio before paid ASR.
4. Submit the movie. The app prepares one continuous 16 kHz mono, signed 16-bit FLAC and streams it
   to ElevenLabs. Music and silence remain; no Demucs, local VAD, or alignment model runs.
5. Review the source SRT, timing flags, and speaker JSON before translating. Speaker labels help
   distinguish dialogue turns, but require listening checks and do not identify characters.

OpenRouter remains selectable and uses short requests. Direct ElevenLabs also supports explicit
**Short chunks**, which retains the local processing workflow. Short requests have separate speaker
ID scopes. Identical IDs in different requests are not assumed to be the same voice.

For a paused pre-ASR job such as Ah Nerede, select the new options in the form and click **Use form
options (stay paused)** on its row. This backs up the manifest and preserves the old audio files.
Resume prepares the new audio and pauses again for review; a second Resume permits transcription.
Changing options is refused after any ASR request/checkpoint exists, including uncertain requests.

## Cost and account

The published base rate is **USD 0.22 per audio hour**: approximately **USD 0.33 / 90 minutes** or
**USD 0.44 / two hours**. This is a gross usage estimate, not the effective cost of a subscription
or an invoice. Taxes, plan fees, available included usage and overage depend on your account.
ElevenAPI offers pay-as-you-go as well as plans. OpenRouter credits are a separate balance. The Ah
Nerede half-film dashboard observation used a different credit conversion than this public rate. Use
**Custom price / minute**, or `CLOUD_PRICE_PER_MINUTE` for scanner defaults, when your account rate
differs. The app does not translate account credits into a verified invoice amount.

The adapter does not request paid keyterms, entity processing, transcript editing or speaker-role
detection. The app's estimate allowance is checked before submission. ElevenLabs responses do not
provide the same `usage.cost` field as OpenRouter, so direct usage remains estimated unless an
actual charge is reported; check the provider dashboard for the bill.

[ElevenAPI pricing](https://elevenlabs.io/pricing/api)

## Timing, speakers and translation

Scribe cues are built from word timestamps and split at speaker changes, even if a provider wraps
the full transcript in one segment. The merger keeps speaker boundaries. Labels are retained in
review JSON and a cue-linked speaker sidecar; ordinary SRT text does not gain anonymous labels.

Zero-duration native words remain in the raw response and word metadata with review flags. A
standalone zero-duration cue gets a flagged 1 ms display interval rather than losing its text.
Unusually long words and cues are flagged without silently truncating their native duration.
Overlapping final cues still use the existing visible overlap-repair flags; the raw timing remains
available for manual repair. Diarization is not forced alignment or proof of character identity.

Automatic Codex translation receives the full SRT and scoped speaker annotations. Translating an
unchanged generated source later through the translation tab also loads the matching sidecar. Its
source hash must match; uploaded or edited subtitles do not inherit stale annotations. Translation
still preserves every cue ID and timestamp and has no paid API fallback.

## Resources, progress and recovery

### Upload limits checked 2026-10-24

| Route                    | Published provider limit                                                                                               | Application limit                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| OpenRouter Scribe        | 25 MB inline; upstream processing may time out after 60 seconds                                                        | 20 MiB per short request                       |
| Direct ElevenLabs Scribe | Overview: 3 GB / 10 hours in standard mode. Endpoint reference: file must be below 5 GB. These pages disagree on size. | 512 MiB prepared audio / four hours by default |

The OpenRouter documentation describes larger base64 requests specifically for OpenAI/Groq models,
and URL input for models which accept it. Those exceptions are not our current Scribe route. For
full films, use direct ElevenLabs. Two hours of 16 kHz mono 16-bit PCM is about 230 MB before FLAC
compression, comfortably below this app's direct cap. These limits apply to prepared audio; the
source video upload is governed separately by `MAX_UPLOAD_BYTES`.

### Local work

- FFmpeg prepares the continuous file with one decoder/encoder thread and one filter thread. The
  multipart upload uses Node's file-backed Blob, rather than a full-film Buffer/base64 copy.
- The app currently caps prepared movie audio at **512 MiB**, input duration at **four hours** by
  default, and the direct request at **30 minutes**. These limits are below the provider's published
  standard-mode ceiling. They can be adjusted in `config.ts`; media/input limits also have existing
  environment controls.
- File preparation reports measured progress. The single provider request reports elapsed time with
  an indeterminate bar: no fake chunk-completion percentages. It runs in the server queue,
  independently of the browser request; a public webhook endpoint is not required.
- Completed raw responses are persisted before normalization and reused on retry. A timeout,
  disconnect, or ambiguous server error retains an uncertain checkpoint and refuses automatic
  resubmission. Check/reconcile the provider result before accepting a second charge.
- The default Docker image omits PyTorch, Silero and faster-whisper. Enable
  `INSTALL_LOCAL_AUDIO=true` for Silero or `INSTALL_LOCAL_WHISPER=true` for local ASR; local audio
  options use `LOCAL_AUDIO_ENABLED`. The existing native installation is not uninstalled or rebuilt.

The ten-minute controlled experiment used OpenRouter and supported longer requests. Direct upload,
recovery and speaker propagation have automated coverage using provider fixtures, including a file
larger than the old chunk upload cap and a real one-second FFmpeg preparation. The 45:04 Ah Nerede
first-half direct Scribe transcription and Codex translation were reviewed locally. **A complete
feature-film submission and the ARM Docker runtime still require target-host checks.**

## Default subtitle presentation

New source and translated exports use a **Netflix-inspired adult profile**. SRT is rewrapped at word
boundaries, targeting at most two lines of 42 visible characters. Existing speaker/lyric line breaks
are retained. Language rules are heuristic: verify names and grammatical breaks manually. The review
report flags reading rates above 20 characters/second for English or a conservative 17 for Turkish,
durations outside 5/6–7 seconds, overlaps, and text which cannot fit without editing. Other
languages use a clearly identified generic fallback. Nothing is truncated to make it fit.

The style pass does not change SRT cue IDs, timing lines or dialogue words. Codex is prompted to
produce concise contextual translations within the same limits; exact timing validation still runs.
Previously completed translation receipts can be reformatted without another Codex inference. Old
completed jobs are not silently rewritten on startup.

Every new export also gets an **ASS** companion: white Arial (or the player's fallback), black
outline, light shadow and bottom-center placement. Select it in a player such as VLC or mpv to see
the style; SRT font/placement is controlled by the player. ASS uses centisecond times, so boundaries
round to 10 ms and a shorter cue receives a minimum 10 ms ASS interval. The SRT is the exact-timing
artifact. Italic/bold/underline markup is retained; custom font/color overrides are omitted in ASS.

Downloads and readable layout warnings appear in job Details. Both automatic/standalone translations
and legacy merged translations receive the companion files. This is not Netflix-certified delivery:
frame gaps, shot changes, on-screen text collisions, language-specific editorial decisions and final
visual acceptance need review against the film. The outline, shadow and margins are our visual
preset.

Sources:
[general timing/layout](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements),
[English](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide),
[Turkish](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215342858-Turkish-Timed-Text-Style-Guide).

[ElevenLabs transcription API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) ·
[Long-recording behavior](https://elevenlabs.io/docs/overview/capabilities/speech-to-text) ·
[OpenRouter request limits](https://openrouter.ai/docs/guides/overview/multimodal/stt) ·
[Acceptance checks](MANUAL_CHECKS.md)
