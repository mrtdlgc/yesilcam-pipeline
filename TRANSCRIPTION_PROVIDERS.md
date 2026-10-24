# Transcription providers — catalog 2026-10-23; ElevenLabs full-movie path updated 2026-10-24

The current default is **direct ElevenLabs / `scribe_v2`**, using one continuous original-audio
file. OpenRouter, lossless chunking, optional Silero profiling, film offsets, hallucination review,
alignment and translation remain selectable; Demucs is no longer run or installed in the default
image. The Ah Nerede pilot completed 18 OpenRouter requests across GPT Transcribe, Scribe v2, and
Qwen3-ASR on original/vocal samples. Other adapters still require live verification. API contracts
were reviewed against official documentation; account compatibility and film accuracy need the
manual checks in [TRANSCRIPTION_COMPARISON.md](TRANSCRIPTION_COMPARISON.md).

Direct **ElevenLabs / `scribe_v2`** now defaults to full-movie submission; explicit Short chunks
remains available. It streams file-backed multipart data, enables diarization, and builds cues from
native words. OpenRouter Scribe also supports speaker labels but stays chunked.
[Full-movie setup and limits](FULL_MOVIE_SCRIBE.md). The direct path has mocked integration coverage
and a locally reviewed 45:04 direct ElevenLabs first-half transcription. The earlier 9m51s
continuous/chunked experiment used OpenRouter.

Choose a provider/model in **Studio**. Save API keys in **Connections**; updates apply to future
requests without a restart or build. Secret values are encrypted on the backend and are never read
back by the browser. Environment keys remain an optional compatibility fallback. Clearing a saved
field disables that fallback. Folder-scanned films use `config.ts` defaults; `TRANSCRIBE_BACKEND`
and `TRANSCRIPTION_MODEL` can also be set as runtime environment variables. Transcription uses
official API keys. Optional YouTube cookies are used only by the downloader, never as subscription
credentials for a transcription API.

## Implemented adapters and default models

| Provider       | Default model                           | Response                                      |
| -------------- | --------------------------------------- | --------------------------------------------- |
| `local`        | `large-v3`                              | local faster-whisper                          |
| `groq`         | `whisper-large-v3`                      | multipart, native segment/word times          |
| `openrouter`   | `mistralai/voxtral-mini-transcribe-3-0` | dedicated STT endpoint                        |
| `openai`       | `gpt-transcribe`                        | text; estimated timing flagged                |
| `mistral`      | `voxtral-mini-transcribe-3-0`           | native segment times, public preview          |
| `deepgram`     | `nova-3`                                | full movie or chunks; word times and speakers |
| `assemblyai`   | `universal-2`                           | upload, submit, poll; word times              |
| `elevenlabs`   | `scribe_v2`                             | native word times                             |
| `gemini`       | `gemini-3.5-transcribe`                 | Interactions API; word annotations            |
| `xai`          | `grok-voice-transcribe-2.0`             | REST /v1/stt; native word times               |
| `speechmatics` | `enhanced`                              | submit, poll, JSON-v2 word times              |
| `gladia`       | `solaria-1`                             | upload, submit, poll; word times              |
| `compatible`   | `explicitly selected`                   | custom OpenAI-compatible server               |

OpenRouter's 28-model STT catalog is saved in scripts/providers/openrouter-models.json. This
includes Microsoft MAI, Qwen ASR, NVIDIA ASR, Fish, Meta, Google Chirp and other models in addition
to the direct adapters. These are routed through OpenRouter; they are not separate native
Azure/AWS/Google Cloud account integrations. The catalog is a dated snapshot, not a guarantee of
access or Turkish support for every entry. Its generic pricing.prompt field does not consistently
identify the billing unit. Models without a separately understood price need a user quote. Unknown
timestamp capabilities default to text with explicitly estimated timings; the adapter does not send
unsupported verbose_json fields speculatively.

## Selected gross list-price estimates (per audio hour, before credits/taxes)

| Model                        | Estimate per audio hour                            |
| ---------------------------- | -------------------------------------------------- |
| Groq large-v3                | USD 0.111; minimum 10 seconds per request          |
| Groq large-v3-turbo          | USD 0.040; minimum 10 seconds per request          |
| OpenAI gpt-transcribe        | USD 0.270                                          |
| Mistral Voxtral Mini 3       | USD 0.210                                          |
| Mistral Voxtral Small 3      | USD 0.240                                          |
| Deepgram Nova-3              | USD 0.258 pinned language; USD 0.312 multilingual  |
| AssemblyAI Universal-2       | USD 0.150, per-second billing                      |
| AssemblyAI Universal-3.5 Pro | USD 0.210, per-second billing                      |
| ElevenLabs Scribe v2         | USD 0.220 published API audio-hour rate            |
| Gemini 3.5 Transcribe        | approx. USD 0.306; actual input/output tokens vary |
| Grok Voice Transcribe 2.0    | USD 0.100 for REST, not the streaming price        |
| Speechmatics Enhanced        | USD 0.380; Standard 0.230; Melia 1 0.120           |
| Gladia Solaria-1             | EUR 0.270 (keep this currency separate)            |

These are planning estimates, not negotiated account rates or accuracy rankings. Token-based
estimates, route changes, billing rounding, channel billing and subscription allowances can change
the final charge. OpenRouter route costs can exceed its minimum published route price. Set
CLOUD_PRICE_PER_MINUTE and CLOUD_PRICE_CURRENCY for an account-specific quote. Quotes for OpenRouter
must be USD, matching its usage.cost. The application deliberately does not turn subscription
eligibility into an assumed zero price.

## Language and alignment details

- Mistral's new Voxtral 3 models list Turkish support. They return segment times, not word times.
  Sending a request for word timestamps would be an API error.
- OpenAI gpt-transcribe uses languages[] hints and currently returns text. The former Whisper/GPT-4o
  transcription models are deprecated for 2027-02-26; legacy choices remain selectable for
  comparison, with retirement dates shown.
- Deepgram Nova-3 currently supports Turkish. A pinned language uses the monolingual rate; auto uses
  its multilingual mode/rate.
- AssemblyAI Universal-2 explicitly covers Turkish. Universal-3.5 Pro has narrower coverage; check
  its current language list. Requests select exactly one model, so a benchmark does not silently
  fall back to another model.
- Gladia Solaria-3 supports en/fr/de/es/it, not Turkish. Validation rejects it for tr or auto. Use
  Solaria-1 for Turkish.
- Speechmatics Melia 1 uses language="multi" with an optional language_hints list. It does not
  accept the literal language="auto". Auto omits only the hint.
- xAI keeps filler words, disables its additional VAD gate for the already-cleaned vocal chunks, and
  puts the file last in multipart data as required by its API.
- Providers with real segments/words retain those timestamps. Genuine Whisper diagnostics survive
  normalization for the existing hallucination filter. Other providers do not get invented Whisper
  no_speech_prob or log-probability fields.
- Text-only results distribute words across cached Silero speech intervals when available, or across
  the chunk otherwise. These are estimates, not forced alignment. Every resulting cue carries
  estimated_timing_manual_review. The normal production pipeline then applies its existing
  speech-boundary alignment. Speech/music separation and VAD cannot determine exact word boundaries
  alone.
- Original film offsets are added once, after chunk-local processing. No provider is asked to
  translate; source transcription and subtitle translation stay distinct.

## Pricing, recovery and limits

The upload cap is 20 MiB per prepared WAV chunk across adapters. Requests are sequential. Async jobs
have a total polling deadline, per-request timeouts and cancellation. Polls use fixed provider URLs
and returned IDs; response URLs are not followed with API credentials. Custom endpoints require
HTTPS or local HTTP.

`output/raw_transcriptions/JOB_ID/` contains:

| File                    | Contents                                                |
| ----------------------- | ------------------------------------------------------- |
| `chunk_ID.json`         | Normalized response used by the pipeline                |
| `chunk_ID.request.json` | Paid-request intent, remote IDs, raw response and usage |
| `usage.json`            | Gross estimates, reported costs and uncertainty         |

OpenRouter usage.cost is retained as a reported USD amount. Gemini token counts are also multiplied
by published rates in usageCostEstimate; that remains an estimate, not an invoice. Providers without
a reported charge remain unreported, not "free". Included credits, subscription fees and taxes are
not silently mixed into this ledger. Old Groq checkpoints predate this ledger and cannot establish
the amount previously charged.

With OpenRouter BYOK, its reported cost may cover only OpenRouter's platform fee; the upstream
provider can bill separately. The allowance conservatively reserves the larger of the quote and
available reported/usage-derived cost, rather than treating a low platform fee as free upstream
inference.

CLOUD_MAX_ESTIMATED_COST is a per-job estimate allowance in the selected price's currency. The whole
planned audio is checked before ASR and each new request is checked against retained requests. This
is not a hard provider billing cap. Job Details allows retry with a changed estimate allowance.
Models, languages, prepared audio and prompt configuration remain fixed; changing them needs a new
job or a separately named comparison.

A saved successful response is reused. Async retries poll the existing remote job. Timeouts, network
failures and ambiguous HTTP responses after a submission are marked uncertain; the pipeline does not
automatically submit again. Cancel stops local waiting; an already-accepted remote job can still run
and be billed. See the reconciliation commands in
[TRANSCRIPTION_COMPARISON.md](TRANSCRIPTION_COMPARISON.md). Malformed paid responses are retained
for inspection instead of triggering another paid call.

Local cleanup removes local intermediates only. Provider uploads, transcripts, retention settings
and remote cancellation/deletion are managed by each provider. No provider retention policy is
changed automatically by this application.

## Adding a provider/model

1. For an OpenAI-compatible /audio/transcriptions API, use compatible, set the complete URL and
   optional key in Connections, choose the model, response format (json or verbose_json), and quoted
   rate. Compatibility includes file/model/language/prompt and the selected response format; verify
   these fields against that server's documentation.
2. For another protocol, add one adapter in scripts/providers/adapters.ts and a catalog entry in
   catalog.ts. ctx.submit checkpoints paid submissions; use it for inference. ctx.request handles
   uploads and polling; keep secrets in headers. Return text plus native segments/words when
   present, language and raw usage.
3. To refresh OpenRouter's list, fetch its public models endpoint with
   output_modalities=transcription. Review IDs, language/timestamp support and pricing units before
   replacing the snapshot. Do not interpret all prompt prices as per-token rates or automatically
   select a newly listed paid model.

## Official references

- [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [Catalog](https://openrouter.ai/api/v1/models?output_modalities=transcription)
- [OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text)
- [OpenAI rates](https://developers.openai.com/api/docs/models/gpt-transcribe)
- [Groq](https://console.groq.com/docs/speech-to-text)
- [Mistral](https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files)
- [Voxtral Mini](https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0)
- [Voxtral Small](https://docs.mistral.ai/models/voxtral-small-transcribe-3-0)
- [Mistral languages](https://docs.mistral.ai/studio/audio/specs-and-limits/languages)
- [Deepgram](https://developers.deepgram.com/docs/models-languages-overview)
- [Deepgram rates](https://deepgram.com/pricing)
- [AssemblyAI](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit)
- [AssemblyAI rates](https://www.assemblyai.com/docs/billing-and-pricing)
- [ElevenLabs](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
- [ElevenLabs rates](https://elevenlabs.io/speech-to-text)
- [Gemini](https://ai.google.dev/gemini-api/docs/transcribe)
- [Gemini schemas](https://ai.google.dev/api/interactions)
- [Gemini rates](https://ai.google.dev/gemini-api/docs/pricing)
- [xAI](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
- [xAI rates](https://docs.x.ai/developers/models/speech-to-text)
- [Speechmatics](https://docs.speechmatics.com/api-ref/batch/create-a-new-job) Speechmatics
  models/languages: https://docs.speechmatics.com/speech-to-text/languages
- [Speechmatics batch hints](https://docs.speechmatics.com/speech-to-text/batch/input)
- [Speechmatics rates](https://www.speechmatics.com/pricing)
- [Gladia](https://docs.gladia.io/api-reference/v2/pre-recorded/init)
- [Gladia rates](https://www.gladia.io/product/speech-to-text-api/async)
