export function parseTime(value: string) {
  const match = String(value).match(/^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  const seconds =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(Math.round(seconds * 1000)))
    throw new Error('Subtitle timestamp is out of range');
  return seconds;
}
export function parseSrt(content: string) {
  const normalized = String(content)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];
  const entries = normalized.split(/\n(?:[ \t]*\n)+/).map((block, index) => {
    const lines = block.split('\n');
    const id = lines[0].trim();
    const match = lines[1]
      ?.trim()
      .match(/^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})$/);
    if (
      !/^\d+$/.test(id) ||
      !Number.isSafeInteger(Number(id)) ||
      Number(id) < 1 ||
      !match ||
      lines.length < 3
    )
      throw new Error(`Malformed SRT cue ${index + 1}`);
    const start = parseTime(match[1]),
      end = parseTime(match[2]);
    const text = lines.slice(2).join('\n').trim();
    if (end <= start || !text) throw new Error(`Empty or invalid SRT cue ${id}`);
    return { id, start, end, startTime: match[1], endTime: match[2], text };
  });
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
    throw new Error('Duplicate SRT cue IDs');
  return entries;
}
