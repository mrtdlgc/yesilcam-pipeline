import { acquireProcessLock } from './lib/process-identity.js';
import { credential } from './lib/credentials.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { at, jobId, readJson, writeJson, atomicWrite } from './lib/files.js';
import { transcribeChunksToSegments, offsetSegment } from './3_transcribe.js';
import { cloudPlan, checkCloudPlan, usageReport, reservedAmount } from './providers/client.js';
import { selection, billingScenario } from './providers/catalog.js';
import { normalize } from './providers/normalize.js';
import { score, aggregate } from './providers/evaluate.js';
import { mergeSegments } from './3.2_merge_sentences.js';
import { cleanSegments } from './3.7_clean_srt.js';
import { segmentsToSrt } from './lib/srt.js';

const { values: args } = parseArgs({
  options: {
    job: { type: 'string' },
    chunks: { type: 'string' },
    matrix: { type: 'string' },
    name: { type: 'string' },
    run: { type: 'boolean', default: false },
    budget: { type: 'string' },
    reference: { type: 'string' },
    import: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});
if (args.help || !args.job) {
  console.log(
    'Usage: node build/scripts/compare-transcribers.js --job JOB_ID --chunks 1,7,19 --name trial1 [--matrix transcription-matrix.example.json] [--reference reference.json] [--run --budget USD=2,EUR=1] [--import manual-transcripts.json]\nWithout --run this only prepares a comparison plan. --import scores user-supplied transcripts without API calls. Reuse the same --name to resume.',
  );
  process.exit(args.help ? 0 : 1);
}
if (args.run && args.import)
  throw new Error('Choose API execution or manual transcript import in one invocation');
if (!args.name || !/^[a-zA-Z0-9_-]{1,55}$/.test(args.name))
  throw new Error('Supply --name with 1–55 letters, numbers, underscores or hyphens');
const sourceId = jobId(args.job);
const source = await readJson(at('temp', sourceId, 'manifest.json'));
if (!source.chunks?.length || !source.settings)
  throw new Error('This job has no prepared audio. Process/pause it after Demucs first.');
const wanted = args.chunks
  ? args.chunks.split(',')
  : source.chunks.slice(0, 3).map((c: any) => String(c.id));
if (new Set(wanted).size !== wanted.length) throw new Error('Duplicate selected chunk IDs');
const chunks = source.chunks.filter((c: any) => wanted.includes(String(c.id)));
if (chunks.length !== wanted.length)
  throw new Error('Selected chunk IDs are missing from the source job');
for (const c of chunks) {
  const stat = await fs.stat(c.file);
  if (!c.audioStat || c.audioStat.size !== stat.size || c.audioStat.mtimeMs !== stat.mtimeMs)
    throw new Error(`Prepared audio changed for chunk ${c.id}`);
}
const language = source.settings.DEFAULT_LANGUAGE;
const matrix = await readJson(path.resolve(args.matrix ?? at('transcription-matrix.example.json')));
if (!Array.isArray(matrix.providers) || !matrix.providers.length || matrix.providers.length > 50)
  throw new Error('Matrix must contain 1–50 providers');
const rows = matrix.providers.map((row: any, index: number) => {
  const settings = {
    ...config,
    ...source.settings,
    TRANSCRIBE_BACKEND: row.provider,
    TRANSCRIPTION_MODEL: row.model ?? '',
    CLOUD_PRICE_PER_MINUTE: row.pricePerMinute ?? null,
    CLOUD_PRICE_CURRENCY: row.currency ?? 'USD',
    // Independent chunks ensure one provider's earlier errors do not bias later
    // samples. Production continuity prompting is unchanged.
    WHISPER_PROMPT_ENABLED: false,
    ALLOW_CLOUD_FALLBACK: false,
  };
  if (row.provider === 'auto') throw new Error('Benchmark requires an explicit provider');
  const plan = cloudPlan(chunks, settings, language);
  return {
    row,
    index,
    settings,
    plan,
    scenario: billingScenario(plan, row.billingScenario),
    id: `compare-${args.name}-${index}`,
  };
});
const budgets: Record<string, number> = {};
for (const item of args.budget?.split(',') ?? []) {
  const match = /^([A-Z]{3})=(\d+(?:\.\d+)?)$/.exec(item);
  if (!match || Number(match[2]) <= 0 || budgets[match[1]] !== undefined)
    throw new Error('Use --budget USD=2,EUR=1 with positive, unique currency limits');
  budgets[match[1]] = Number(match[2]);
}
const totals: Record<string, number | null> = {};
for (const { plan } of rows) {
  const current = totals[plan.currency] ?? 0;
  totals[plan.currency] = plan.amount === null || current === null ? null : current + plan.amount;
}
if (args.run) {
  for (const [currency, amount] of Object.entries(totals)) {
    if (amount === null || budgets[currency] === undefined || amount > budgets[currency])
      throw new Error(
        `Provide a quoted rate and sufficient --budget for ${currency}; total estimate: ${amount ?? 'unknown'}`,
      );
  }
  for (const { settings } of rows) {
    const { provider } = selection(settings, language);
    if (provider.key && !(await credential(provider.key)) && provider.id !== 'compatible')
      throw new Error(`Missing ${provider.key}`);
  }
}
const dir = at('output', 'comparisons', args.name);
await fs.mkdir(dir, { recursive: true });
const lockFile = path.join(dir, 'run.lock');
const release = await acquireProcessLock(lockFile);
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const signature = createHash('sha256')
    .update(JSON.stringify({ sourceId, chunks, matrix, language, schema: 1 }))
    .digest('hex');
  const previous = await readJson(path.join(dir, 'plan.json'), null);
  if (previous && previous.signature !== signature)
    throw new Error(
      'This comparison name belongs to a different matrix/audio selection; choose a new name',
    );
  const plan = {
    version: 1,
    signature,
    sourceId,
    language,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    input: source.settings.DEMUCS_ENABLED ? 'prepared vocals' : 'prepared audio (Demucs disabled)',
    chunks: chunks.map((c: any) => ({
      id: c.id,
      file: c.file,
      filmStart: c.startTime,
      filmEnd: c.endTime,
    })),
    providers: rows.map((r: any) => ({ ...r.plan, billingScenario: r.scenario })),
    estimatedTotals: totals,
    note: 'Compare identical chunks. No source download, separation, or Whisper worker unless local is explicitly selected. Gross rates exclude subscription credits and fees.',
  };
  await writeJson(path.join(dir, 'plan.json'), plan);
  const template = Object.fromEntries(chunks.map((c: any) => [c.id, null]));
  if (!(await readJson(path.join(dir, 'reference.template.json'), null)))
    await writeJson(path.join(dir, 'reference.template.json'), { chunks: template });
  if (!(await readJson(path.join(dir, 'manual.template.json'), null)))
    await writeJson(path.join(dir, 'manual.template.json'), {
      label: 'subscription-upload',
      model: 'enter model name',
      chunks: template,
      note: 'Replace each null with the verbatim transcript, including an empty string for silence. Upload the matching WAV listed in plan.json using a supported provider UI.',
    });
  const reference = args.reference ? await readJson(path.resolve(args.reference)) : null;
  if (reference)
    for (const chunk of chunks) {
      if (typeof reference.chunks?.[chunk.id] !== 'string')
        throw new Error(`Missing corrected reference for chunk ${chunk.id}`);
    }
  const exportResult = async (records: any, name: string, metadata: any) => {
    const evaluated = records.map((r: any) => {
      const text = r.text ?? r.segments.map((s: any) => s.text).join(' ');
      return {
        chunkId: r.chunk.id,
        text,
        runtime: r.runtime,
        ...(reference
          ? { score: score(reference.chunks[r.chunk.id], text, reference.language ?? language) }
          : {}),
      };
    });
    const film = records.flatMap((r: any) =>
      mergeSegments(r.segments, { settings: source.settings }).map((s) =>
        offsetSegment(s, r.chunk.startTime),
      ),
    );
    const cues = cleanSegments(film, { settings: source.settings });
    await atomicWrite(path.join(dir, `${name}.srt`), segmentsToSrt(cues));
    const output = {
      ...metadata,
      chunks: evaluated,
      cues,
      quality: reference ? aggregate(evaluated.map((c: any) => c.score)) : null,
      note: 'Accuracy uses the raw ASR transcript. SRT uses original film offsets and cue splitting. No hallucination filtering or additional alignment is applied here; timing flags require listening.',
    };
    await writeJson(path.join(dir, `${name}.json`), output);
    return output;
  };
  const results = [];
  if (args.import) {
    const imported = await readJson(path.resolve(args.import));
    if (!/^[a-zA-Z0-9_-]{1,55}$/.test(imported.label ?? ''))
      throw new Error('Manual import label must be a simple filename');
    const records = [];
    for (const chunk of chunks) {
      const text = imported.chunks?.[chunk.id];
      if (typeof text !== 'string' || text.length > 12000)
        throw new Error(`Missing/oversized manual transcript for ${chunk.id}`);
      const response = await normalize(
        { text, language },
        chunk,
        { ...config, ...source.settings },
        { provider: { id: 'manual' }, model: { id: String(imported.model ?? 'unspecified') } },
      );
      records.push({ chunk, text, segments: response.segments, runtime: response._runtime });
    }
    results.push(
      await exportResult(records, `manual-${imported.label}`, {
        provider: 'manual',
        model: imported.model,
        billing: 'User supplied transcript; no API calls by this tool',
        wallMs: null,
      }),
    );
  } else if (args.run) {
    for (const item of rows) {
      controller.signal.throwIfAborted();
      console.log(
        `${item.plan.provider} / ${item.plan.model}: ${item.plan.amount.toFixed(6)} ${item.plan.currency} estimated`,
      );
      const start = Date.now();
      try {
        let otherReserved = 0;
        for (const other of rows.filter(
          (r: any) => r.index !== item.index && r.plan.currency === item.plan.currency,
        )) {
          const existing = await readJson(
            at('output', 'raw_transcriptions', other.id, 'usage.json'),
            null,
          );
          otherReserved += (existing?.requests ?? [])
            .filter((r: any) => !['rejected', 'prepared'].includes(r.status))
            .reduce((n: any, r: any) => n + reservedAmount(r, item.plan.currency), 0);
        }
        const remaining = budgets[item.plan.currency] - otherReserved;
        if (remaining <= 0) throw new Error('Comparison estimate allowance is exhausted');
        const settings = { ...item.settings, CLOUD_MAX_ESTIMATED_COST: remaining };
        checkCloudPlan(item.plan, settings);
        const records = await transcribeChunksToSegments(
          chunks,
          language,
          item.id,
          {},
          {
            settings,
            signal: controller.signal,
            returnChunks: true,
            onProgress: (done, total) => console.log(`  ${done}/${total} chunks`),
          },
        );
        const usage = await usageReport(at('output', 'raw_transcriptions', item.id), item.plan);
        results.push(
          await exportResult(records, `provider-${item.index}`, {
            provider: item.plan.provider,
            model: item.plan.model,
            wallMs: Date.now() - start,
            cachedChunks: records.filter((r) => r.cached).length,
            usage,
            billingScenario: item.scenario,
          }),
        );
        await fs.rm(path.join(dir, `provider-${item.index}.error.json`), { force: true });
      } catch (error) {
        await writeJson(path.join(dir, `provider-${item.index}.error.json`), {
          error: error.message,
          plan: item.plan,
          at: new Date().toISOString(),
        });
        results.push({
          provider: item.plan.provider,
          model: item.plan.model,
          error: error.message,
        });
        process.exitCode = 1;
        if (controller.signal.aborted) throw error;
        console.error(`  ${error.message}`);
      }
      await writeJson(path.join(dir, 'results.json'), { plan, results });
    }
  } else
    console.log(
      JSON.stringify(
        {
          ...plan,
          action:
            'Plan only. Add --run --budget USD=... for API requests, or --import for manual UI transcripts.',
        },
        null,
        2,
      ),
    );
  if (results.length)
    await writeJson(path.join(dir, args.import ? 'manual-results.json' : 'results.json'), {
      plan,
      results,
    });
  console.log(`Comparison files: ${dir}`);
} finally {
  await release();
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
