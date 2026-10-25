import { credential } from './credentials.js';
import { chatGPTStatus, chatGPTToken } from './chatgpt-oauth.js';
import { assertPaidSubmissionAllowed, trackPaidWork } from './paid-work.js';
import type { Settings } from '../../types/pipeline.js';

export async function responseStatus(settings: Settings) {
  const plan = settings.TRANSLATION_PROVIDER === 'chatgpt-oauth';
  const available = plan
    ? chatGPTStatus().connected
    : settings.TRANSLATION_PROVIDER === 'openai-api' && Boolean(await credential('OPENAI_API_KEY'));
  return {
    available,
    version: null,
    model: settings.CODEX_MODEL || 'gpt-5.4',
    message: plan
      ? available
        ? 'Translation uses your connected ChatGPT plan.'
        : chatGPTStatus().message
      : available
        ? 'Translation uses your OpenAI API key. API charges are separate from a ChatGPT subscription.'
        : 'Add your OpenAI API key in Connections to translate subtitles.',
  };
}
export async function responseTranslation(
  prompt: string,
  settings: Settings,
  signal?: AbortSignal,
) {
  const token =
    settings.TRANSLATION_PROVIDER === 'chatgpt-oauth'
      ? await chatGPTToken()
      : await credential('OPENAI_API_KEY');
  if (!token) throw new Error('Your translation connection expired or is missing');
  assertPaidSubmissionAllowed();
  return trackPaidWork(async () => {
    const deadline = AbortSignal.timeout(settings.CODEX_TRANSLATION_TIMEOUT_MS);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.CODEX_MODEL || 'gpt-5.4',
        store: false,
        stream: true,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Translation provider returned HTTP ${response.status}. Check your connection and allowance; retry manually.`,
      );
    }
    if (!response.body) throw new Error('Translation response was empty');
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = '',
      size = 0;
    let completed: { text: string; usage: unknown } | undefined;
    const event = (block: string) => {
      const payload = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!payload || payload === '[DONE]') return;
      const value = JSON.parse(payload);
      if (['response.failed', 'response.incomplete', 'error'].includes(value.type))
        throw new Error(
          'The translation did not complete. Retry manually; no billing fallback was used.',
        );
      if (value.type === 'response.completed') {
        if (value.response?.status !== 'completed')
          throw new Error('Incomplete translation response');
        const output = value.response.output;
        if (!Array.isArray(output)) throw new Error('Invalid translation response');
        const text = output
          .filter((item) => item.type === 'message' && item.role === 'assistant')
          .flatMap((item) => item.content ?? [])
          .filter((item) => item.type === 'output_text')
          .map((item) => item.text)
          .join('');
        if (!text || Buffer.byteLength(text) > 4 * 1024 * 1024)
          throw new Error('Translation output was empty or too large');
        completed = { text, usage: value.response.usage ?? null };
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) throw new Error('Translation stream exceeded its size limit');
        pending += decoder.decode(value, { stream: true });
        pending = pending.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          event(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
        }
      }
      event(pending + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!completed) throw new Error('Translation stream ended before completion. Retry manually.');
    return completed;
  });
}
