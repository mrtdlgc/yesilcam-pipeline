import type { CloudContext } from '../../types/providers.js';
import { scribeDiarization, scribeAudioEvents } from '../lib/transcription-mode.js';
import { setTimeout as delay } from 'node:timers/promises';

const bearer = (key: string | undefined) => ({ Authorization: `Bearer ${key}` });
const jsonBody = (value: any) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
const offset = (value: any) =>
  typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value) ? Number(value.slice(0, -1)) : NaN;
const baseResponse = (r: any) => ({ ...r, language: r.language ?? r.languages?.[0]?.code });
function form(ctx: CloudContext, fields: any, fileField = 'file') {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    for (const part of Array.isArray(value) ? value : [value]) body.append(key, String(part));
  }
  // Some streaming multipart parsers (notably xAI) require the file LAST.
  body.append(
    fileField,
    ctx.audioFile ?? new Blob([ctx.audio], { type: ctx.mime }),
    `audio.${ctx.format}`,
  );
  return body;
}
async function poll(ctx: CloudContext, operation: any, ready: any, failed: any) {
  for (;;) {
    ctx.signal.throwIfAborted();
    const result = await operation();
    if (ready(result)) return result;
    if (failed(result))
      throw new Error(
        `${ctx.selected.provider.id} remote job failed; inspect its dashboard (request checkpoint retained)`,
      );
    await delay(ctx.settings.CLOUD_POLL_INTERVAL_MS, undefined, { signal: ctx.signal });
  }
}

async function openAIStyle(ctx: CloudContext) {
  const { provider, model } = ctx.selected;
  const endpoints: Record<string, string | undefined> = {
    openai: 'https://api.openai.com/v1/audio/transcriptions',
    groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
    mistral: 'https://api.mistral.ai/v1/audio/transcriptions',
  };
  let url = endpoints[provider.id];
  if (provider.id === 'compatible') {
    url = ctx.endpoint;
    if (!url)
      throw new Error('TRANSCRIPTION_API_URL must be the complete /audio/transcriptions endpoint');
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !(
        parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
      )
    )
      throw new Error('Custom API URL must use HTTPS (or local HTTP) without URL credentials');
  }
  const fields: Record<string, unknown> = { model: model.id };
  if (provider.id === 'mistral') {
    fields.timestamp_granularities = 'segment';
    fields.return_language = true;
    if (ctx.language !== 'auto') fields.language = ctx.language;
    if (ctx.prompt) fields.context_bias = ctx.prompt;
  } else {
    fields.response_format = model.timing === 'estimated' ? 'json' : 'verbose_json';
    if (fields.response_format === 'verbose_json')
      fields['timestamp_granularities[]'] = ['segment', 'word'];
    if (ctx.language !== 'auto')
      fields[
        provider.id === 'openai' && model.id === 'gpt-transcribe' ? 'languages[]' : 'language'
      ] = ctx.language;
    if (ctx.prompt) fields.prompt = ctx.prompt;
  }
  const r = await ctx.submit(url!, {
    headers: ctx.key ? bearer(ctx.key) : {},
    body: form(ctx, fields),
  });
  return baseResponse(r);
}

async function openrouter(ctx: CloudContext) {
  const { model } = ctx.selected;
  const data: Record<string, any> = {
    model: model.id,
    input_audio: { data: ctx.audio.toString('base64'), format: ctx.format },
    response_format: model.timing === 'estimated' ? 'json' : 'verbose_json',
  };
  if (ctx.language !== 'auto') data.language = ctx.language;
  if (data.response_format === 'verbose_json')
    data.timestamp_granularities = model.timing === 'word' ? ['segment', 'word'] : ['segment'];
  if (scribeDiarization(ctx.settings) || scribeAudioEvents(ctx.settings))
    data.provider = {
      options: {
        elevenlabs: {
          diarize: scribeDiarization(ctx.settings),
          tag_audio_events: scribeAudioEvents(ctx.settings),
        },
      },
    };
  // OpenRouter ignores top-level prompt. Do not silently claim context parity.
  const init = jsonBody(data);
  return baseResponse(
    await ctx.submit('https://openrouter.ai/api/v1/audio/transcriptions', {
      ...init,
      headers: { ...init.headers, ...bearer(ctx.key) },
    }),
  );
}

async function deepgram(ctx: CloudContext) {
  const params = new URLSearchParams({
    model: ctx.selected.model.id,
    smart_format: 'false',
    punctuate: 'true',
    language: ctx.language === 'auto' ? 'multi' : ctx.language,
  });
  const r = await ctx.submit(`https://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${ctx.key}`, 'Content-Type': ctx.mime },
    body: ctx.audio,
  });
  const a = r.results?.channels?.[0]?.alternatives?.[0];
  return {
    text: a?.transcript,
    words: a?.words?.map((w: any) => ({ ...w, word: w.punctuated_word ?? w.word })),
    language:
      r.results?.channels?.[0]?.detected_language ??
      (ctx.language !== 'auto' ? ctx.language : undefined),
    usage: { seconds: r.metadata?.duration },
    model: r.metadata?.model_info,
    raw: r,
  };
}

async function elevenlabs(ctx: CloudContext) {
  const r = ctx.state.remoteId
    ? await ctx.request(
        `https://api.elevenlabs.io/v1/speech-to-text/transcripts/${encodeURIComponent(ctx.state.remoteId)}`,
        {
          headers: { 'xi-api-key': ctx.key! },
        },
      )
    : await ctx.submit('https://api.elevenlabs.io/v1/speech-to-text', {
        headers: { 'xi-api-key': ctx.key! },
        body: form(ctx, {
          model_id: ctx.selected.model.id,
          language_code: ctx.language === 'auto' ? undefined : ctx.language,
          timestamps_granularity: 'word',
          tag_audio_events: scribeAudioEvents(ctx.settings),
          diarize: scribeDiarization(ctx.settings),
        }),
      });
  if (r.transcription_id) await ctx.save({ remoteId: r.transcription_id });
  return {
    ...r,
    language: r.language_code,
    audioEvents: r.words
      ?.filter((w: any) => w.type === 'audio_event')
      .map((w: any) => ({ start: w.start, end: w.end, text: w.text, speaker_id: w.speaker_id })),
    words: r.words
      ?.filter((w: any) => w.type === 'word')
      .map((w: any) => ({ ...w, word: w.text, speaker: w.speaker_id })),
  };
}

async function gemini(ctx: CloudContext) {
  const transcription: Record<string, unknown> = {
    mode: { type: 'verbatim', timestamp_granularities: ['word'] },
  };
  if (ctx.language !== 'auto') transcription.language_codes = [ctx.language];
  const init = jsonBody({
    model: ctx.selected.model.id,
    store: false,
    input: [
      {
        type: 'audio',
        data: ctx.audio.toString('base64'),
        mime_type: ctx.format === 'm4a' ? 'audio/m4a' : ctx.mime,
      },
    ],
    generation_config: { transcription_config: transcription },
  });
  const r = await ctx.submit('https://generativelanguage.googleapis.com/v1beta/interactions', {
    ...init,
    headers: { ...init.headers, 'x-goog-api-key': ctx.key! },
  });
  if (r.status && r.status !== 'completed')
    throw new Error(`Gemini returned ${r.status}; response retained`);
  const blocks = r.outputs?.filter((b: any) => b.type === 'text');
  return {
    text: blocks?.map((b: any) => b.text).join(' '),
    words: blocks?.flatMap((b: any) =>
      (b.annotations ?? [])
        .filter((a: any) => a.type === 'word_info')
        .map((a: any) => ({
          word: a.text,
          start: offset(a.start_offset),
          end: offset(a.end_offset),
          speaker: a.speaker,
        })),
    ),
    usage: r.usage,
    model: r.model,
    raw: r,
  };
}

async function xai(ctx: CloudContext) {
  return ctx.submit('https://api.x.ai/v1/stt', {
    headers: bearer(ctx.key),
    body: form(ctx, {
      model: ctx.selected.model.id,
      language: ctx.language === 'auto' ? undefined : ctx.language,
      format: false,
      filler_words: true,
      vad_threshold: 0,
      diarize: false,
    }),
  });
}

async function assemblyai(ctx: CloudContext) {
  const headers = { authorization: ctx.key! };
  if (!ctx.state.uploadUrl && !ctx.state.submissionResponse) {
    const r = await ctx.request('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: ctx.audio,
    });
    if (typeof r.upload_url !== 'string') throw new Error('AssemblyAI upload returned no URL');
    await ctx.save({ uploadUrl: r.upload_url });
  }
  const init = jsonBody({
    audio_url: ctx.state.uploadUrl,
    speech_models: [ctx.selected.model.id],
    ...(ctx.language === 'auto' ? { language_detection: true } : { language_code: ctx.language }),
    speaker_labels: false,
  });
  const submitted = await ctx.submit('https://api.assemblyai.com/v2/transcript', {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (typeof submitted.id !== 'string' || !submitted.id)
    throw new Error('AssemblyAI returned no job ID');
  await ctx.save({ remoteId: submitted.id });
  const r = await poll(
    ctx,
    () =>
      ctx.request(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(submitted.id)}`, {
        headers,
      }),
    (r: any) => r.status === 'completed',
    (r: any) => r.status === 'error',
  );
  return {
    text: r.text,
    language: r.language_code,
    model: r.speech_model_used ?? r.speech_model,
    words: r.words?.map((w: any) => ({
      ...w,
      word: w.text,
      start: w.start / 1000,
      end: w.end / 1000,
    })),
    usage: { seconds: r.audio_duration },
    raw: r,
  };
}

async function speechmatics(ctx: CloudContext) {
  const headers = bearer(ctx.key);
  const region = ctx.region;
  if (!['eu1', 'us1'].includes(region)) throw new Error('SPEECHMATICS_REGION must be eu1 or us1');
  const base = `https://${region}.asr.api.speechmatics.com/v2`;
  const transcriptionConfig: Record<string, unknown> = {
    model: ctx.selected.model.id,
    language: ctx.selected.model.id === 'melia-1' ? 'multi' : ctx.language,
  };
  if (ctx.selected.model.id === 'melia-1' && ctx.language !== 'auto')
    transcriptionConfig.language_hints = [ctx.language];
  const submitted = await ctx.submit(`${base}/jobs/`, {
    headers,
    body: form(
      ctx,
      {
        config: JSON.stringify({
          type: 'transcription',
          transcription_config: transcriptionConfig,
        }),
      },
      'data_file',
    ),
  });
  if (typeof submitted.id !== 'string' || !submitted.id)
    throw new Error('Speechmatics returned no job ID');
  await ctx.save({ remoteId: submitted.id });
  await poll(
    ctx,
    () => ctx.request(`${base}/jobs/${encodeURIComponent(submitted.id)}`, { headers }),
    (r: any) => r.job?.status === 'done',
    (r: any) => ['rejected', 'deleted', 'expired'].includes(r.job?.status),
  );
  const r = await ctx.request(
    `${base}/jobs/${encodeURIComponent(submitted.id)}/transcript?format=json-v2`,
    { headers },
  );
  const words = [];
  for (const item of r.results ?? []) {
    const a = item.alternatives?.[0];
    if (!a?.content) continue;
    if (item.type === 'punctuation' && words.length) words.at(-1)!.word += a.content;
    else if (item.type === 'word')
      words.push({
        word: a.content,
        start: item.start_time,
        end: item.end_time,
        confidence: a.confidence,
        speaker: a.speaker,
        language: a.language,
      });
  }
  const languages = [...new Set(words.map((w) => w.language).filter(Boolean))];
  const language =
    languages.length > 1 ? 'mul' : (languages[0] ?? r.metadata?.transcription_config?.language);
  return {
    text: words.map((w) => w.word).join(' '),
    words,
    language: ['auto', 'multi'].includes(language) ? undefined : language,
    usage: { seconds: r.job?.duration },
    raw: r,
  };
}

async function gladia(ctx: CloudContext) {
  const headers = { 'x-gladia-key': ctx.key! };
  if (!ctx.state.uploadUrl && !ctx.state.submissionResponse) {
    const r = await ctx.request('https://api.gladia.io/v2/upload', {
      method: 'POST',
      headers,
      body: form(ctx, {}, 'audio'),
    });
    if (typeof r.audio_url !== 'string') throw new Error('Gladia upload returned no URL');
    await ctx.save({ uploadUrl: r.audio_url });
  }
  const init = jsonBody({
    audio_url: ctx.state.uploadUrl,
    model: ctx.selected.model.id,
    diarization: false,
    language_config:
      ctx.language === 'auto'
        ? { code_switching: true }
        : { languages: [ctx.language], code_switching: false },
  });
  const submitted = await ctx.submit('https://api.gladia.io/v2/pre-recorded', {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (typeof submitted.id !== 'string' || !submitted.id)
    throw new Error('Gladia returned no job ID');
  await ctx.save({ remoteId: submitted.id });
  const r = await poll(
    ctx,
    () =>
      ctx.request(`https://api.gladia.io/v2/pre-recorded/${encodeURIComponent(submitted.id)}`, {
        headers,
      }),
    (r: any) => r.status === 'done',
    (r: any) => r.status === 'error',
  );
  const t = r.result?.transcription;
  return {
    text: t?.full_transcript,
    words: t?.utterances?.flatMap((u: any) => u.words ?? []),
    language:
      t?.languages?.length === 1 ? t.languages[0] : t?.languages?.length > 1 ? 'mul' : undefined,
    usage: r.result?.metadata,
    raw: r,
  };
}

export const adapters: Record<string, (ctx: CloudContext) => Promise<any>> = {
  openai: openAIStyle,
  groq: openAIStyle,
  mistral: openAIStyle,
  compatible: openAIStyle,
  openrouter,
  deepgram,
  assemblyai,
  elevenlabs,
  gemini,
  xai,
  speechmatics,
  gladia,
};
