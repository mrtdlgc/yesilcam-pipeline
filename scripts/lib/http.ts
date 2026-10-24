export async function fetchLimited(
  url: string,
  options: RequestInit & { timeout?: number; maxBytes?: number } = {},
) {
  const { signal, timeout = 30000, maxBytes = 8 * 1024 * 1024, ...init } = options;
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) {
    let detail = '';
    const errorReader = response.body?.getReader();
    if (errorReader) {
      const parts = [];
      let size = 0;
      try {
        while (size < 8192) {
          const { value, done } = await errorReader.read();
          if (done) break;
          parts.push(Buffer.from(value).subarray(0, 8192 - size));
          size += value.length;
        }
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const message =
          body.error?.message ??
          body.message ??
          (typeof body.error === 'string' ? body.error : null);
        if (typeof message === 'string') detail = message;
      } catch {
        /* Non-JSON/oversized error bodies are not exposed. */
      } finally {
        await errorReader.cancel().catch(() => {});
      }
    }
    // Error messages sometimes echo credentials. Redact sensitive request header
    // values before putting any provider detail in local job logs or checkpoints.
    for (const [name, value] of new Headers(init.headers))
      if (/authorization|api.?key|token/i.test(name)) {
        for (const secret of [value, value.replace(/^Bearer\s+|^Token\s+/i, '')]) {
          if (secret) detail = detail.replaceAll(secret, '[redacted]');
        }
      }
    detail = detail.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
    throw Object.assign(
      new Error(`HTTP ${response.status} from ${new URL(url).host}${detail ? `: ${detail}` : ''}`),
      {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        retryAfter: response.headers.get('retry-after'),
      },
    );
  }
  if (!response.body) throw new Error('HTTP response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error('HTTP response exceeded size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const content = Buffer.concat(chunks).toString('utf8');
  return { text: content, json: () => JSON.parse(content), headers: response.headers };
}
