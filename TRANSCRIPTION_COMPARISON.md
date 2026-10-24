# Manual transcription comparison

The Ah Nerede sample comparison used OpenRouter GPT Transcribe, Scribe v2 and Qwen3-ASR on three
original/vocal pairs. That limited run does not validate every provider or rank full-film accuracy.

## 1. Prepare representative audio once

Use an existing job whose temp/JOB_ID/manifest.json and prepared audio chunks remain on disk.
**Pause before transcription** in Studio (or `PAUSE_BEFORE_TRANSCRIPTION: true` in `config.ts`) lets
a new job stop after source chunking. Choose IDs from that manifest: quiet dialogue, loud music
under speech, hiss/crackle, shouting, overlapping speakers, names/slang and genuine silence. Five to
ten short chunks are a better first comparison than an entire film. Do not clean intermediates until
the comparisons are finished.

The CLI requires the original audioStat and checks each retained file's size and mtime. Cloud
request checkpoints additionally bind the actual audio SHA-256. It does not download a film, run
separation, or start Whisper unless local is explicitly included in your matrix. Profiles, when
present, are reused.

## 2. Prepare a plan (no inference, no provider request)

After building, from the repository or the image terminal (`/app`):

```bash
node build/scripts/compare-transcribers.js --job JOB_ID --chunks 1,7,19 --name first-pass
```

Replace IDs with real IDs in your manifest. Omit --chunks to select the first three retained chunks.
Default choices are in transcription-matrix.example.json: Groq large-v3 baseline, Voxtral Mini 3,
GPT Transcribe, Scribe v2, Grok Voice Transcribe 2.0, Gemini 3.5 Transcribe and OpenRouter Voxtral
Small 3. Copy/edit the matrix and pass --matrix my-matrix.json to choose fewer/different models. Use
provider names from [TRANSCRIPTION_PROVIDERS.md](TRANSCRIPTION_PROVIDERS.md).

output/comparisons/first-pass/ contains plan.json, reference.template.json and manual.template.json.
The plan includes exact prepared audio paths, original film offsets, each provider's gross price
estimate and separate currency totals. No keys are needed to create the plan. Audio files are not
re-encoded or uploaded.

## 3. Create a corrected reference

Copy reference.template.json to a new file. Replace every null with the exact Turkish speech for
that chunk. Use an empty string for genuine silence. Preserve the chunk IDs. Keep the reference
independent of any one model's guess.

WER/CER use Unicode normalization and Turkish casing for language tr without stripping Turkish
letters. For an auto-language job, add "language": "tr" to the reference object when evaluating
Turkish. Punctuation is ignored; CER excludes spaces. Errors are weighted by reference
word/character counts across chunks. Silent-reference insertions are reported separately; their WER
is undefined, not falsely zero. This scores the unfiltered source transcript, not translated English
or hallucination-filtered output. Timing quality is a separate listening task.

## 4. Explicitly run the selected APIs when ready

Save the desired keys in Connections, then run against the same `DATA_DIR` and data volume:

```bash
node build/scripts/compare-transcribers.js --job JOB_ID --chunks 1,7,19 --name first-pass --reference corrected.json --run --budget USD=2
```

If your matrix includes Gladia, supply a separate EUR allowance, e.g. --budget USD=2,EUR=1. Unpriced
models require pricePerMinute and currency in their matrix row. A budget is required even for a
free-tier key; account benefits do not remove the need to bound the gross usage estimate. A
local-only matrix still uses an explicit run and a positive allowance, but has zero estimated API
cost.

The tool checks total planned cost before starting. Each provider keeps a separate checkpoint
namespace and the comparison accounts for other rows' retained usage before new requests. It runs
sequentially and prints chunk progress. One provider failure is recorded while other selected
providers can continue within their remaining estimate allowance. Ctrl-C cancels local work/waiting.
An accepted remote request may finish and be billed after cancellation.

Rerun the same command/name to reuse completed chunks and poll existing remote jobs. The
matrix/audio selection is immutable under that name. To change models, chunks or quotes, choose a
new name. Supply a higher --budget to resume after an estimate allowance failure. A hard-killed
comparison leaves run.lock; inspect its PID and remove it only after the process is gone.
Per-request locks have their own reconciliation command below.

## 5. Review outputs

provider-N.json includes raw transcript text by chunk, runtime/model information, word/character
error metrics (if a reference was supplied), timing flags, elapsed wall time, cached-chunk count and
usage. provider-N.srt uses the original film offsets and normal cue splitting. It intentionally does
not apply hallucination filters or another alignment pass to the benchmark: those would obscure
model differences. The production pipeline still performs those stages.

results.json collects successful rows and errors. Check provider-N.error.json when a request fails.
Reused results must not be interpreted as fresh latency measurements. The raw ASR checkpoint
namespace is compare-NAME-ROWINDEX.

Evaluate transcript omissions, invented speech in silence/music, Turkish names, dialect/slang and
timing boundaries. Do not rank providers solely on fluent text. Confirm sample charges and
subscription-credit usage in the provider dashboard. Only OpenRouter currently returns a captured
monetary cost directly. Other providers retain reported usage and dated price estimates; Gemini
additionally gets a token-based estimate. No cross-currency total is presented as a dollar bill.

## 6. Compare a subscription web app without an API call

Use the exact audio paths listed in plan.json with a supported upload interface. Request verbatim
Turkish, with no translation or rewriting. Copy manual.template.json, give it a simple label and
model name, and replace each null with that chunk's transcript. Then:

```bash
node build/scripts/compare-transcribers.js --job JOB_ID --chunks 1,7,19 --name first-pass --reference corrected.json --import manual-transcripts.json
```

Do not combine --import with --run. Import makes no API request and does not assume the web model
equals its API counterpart. Text-only imports get explicitly estimated timing. Manual results are
saved separately from API results and can be scored against the same corrected reference. The tool
cannot establish a UI service's quota, model identity or bill from copied text.

## 7. Reconcile uncertain submissions before retrying

Stop/cancel the affected job or comparison. Inspect without modifying:

```bash
node build/scripts/reconcile-transcription.js --job JOB_ID --chunk CHUNK_ID
```

If an asynchronous provider accepted the job but its response was lost, recover the job ID from its
dashboard and attach it:

```bash
node build/scripts/reconcile-transcription.js --job JOB_ID --chunk CHUNK_ID --remote-id PROVIDER_JOB_ID
```

For a stale request lock, run this command inside the same application container and add --unlock;
the tool refuses to unlock a live owner. New request locks record process start time and boot
identity so a reused container PID is not mistaken for the old owner. Legacy PID-only locks remain
conservative. If no result can be recovered and you deliberately accept another possible charge:

```bash
node build/scripts/reconcile-transcription.js --job JOB_ID --chunk CHUNK_ID --allow-new-request --note "Checked provider dashboard; accept a second submission"
```

This archives the old request and normalized response. The old reservation/cost still counts; the
next normal retry can submit again. The command itself makes no provider request. It also handles a
malformed paid response that needs a new inference. Changing a model/configuration still requires a
new job, not this tool.

## Manual acceptance cases

- For every chosen provider: a short Turkish speech chunk, silence, mixed music, and a chunk with a
  large nonzero film offset; inspect payload response/timings.
- For text-only models: all estimated cues are flagged; no invented native word confidence, and
  existing vocal/speech alignment still runs in production.
- Retry after completed chunks: no second submission; cached chunks are marked.
- Cancel while an async request is pending, then resume: same remote job ID.
- Interrupt a POST response: uncertainty blocks an automatic second submission.
- Invalid key/unsupported model/rate limit: useful failure and retained evidence; no local fallback,
  hidden provider switch or repeated paid inference.
- Quotes, per-request minimums, currency totals and account subscription credits: compare the usage
  report against the actual account dashboard/invoice.
- Manual import, missing/duplicate IDs and incomplete references: reject incomplete data; original
  film offsets survive; no API call during import/planning.
- Run the existing [MANUAL_CHECKS.md](MANUAL_CHECKS.md) for separation, alignment, queue, recovery
  and translation after the cloud sample comparison passes.

Job Details now offers the same request inspection/reconciliation controls as the CLI. Existing
ElevenLabs transcript IDs are retrieved with GET, without another audio submission. Async/webhook
submission is available upstream, but this app retains synchronous submissions plus retrieval; no
unverified webhook receiver is exposed. See the
[official retrieval endpoint](https://elevenlabs.io/docs/api-reference/speech-to-text/get).
