/**
 * Clean SRT/segments
 * - Remove empty entries
 * - Fix overlapping timestamps
 * - Normalize whitespace
 * - Remove duplicate entries
 */

/**
 * Clean segments array directly (preserves speakerChange)
 * @param {Array} segments - Array of segment objects
 * @returns {Array} - Cleaned segments
 */
export function cleanSegments(segments) {
  // Remove empty entries
  let cleaned = segments.filter(e => e.text.trim().length > 0);

  // Remove duplicates (same text within 1 second)
  cleaned = removeDuplicates(cleaned);

  // Fix overlapping timestamps
  cleaned = fixOverlaps(cleaned);

  // Normalize text whitespace
  cleaned = cleaned.map(e => ({
    ...e,
    text: normalizeText(e.text)
  }));

  console.log(`Cleaned: ${segments.length} → ${cleaned.length} entries`);

  return cleaned;
}

/**
 * Clean and normalize SRT content
 * @param {string} srtContent - Raw SRT content
 * @returns {string} - Cleaned SRT content
 */
export function cleanSrt(srtContent) {
  const entries = parseSrt(srtContent);
  const cleaned = cleanSegments(entries);
  return entriesToSrt(cleaned);
}

function parseSrt(srtContent) {
  const entries = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const timeLine = lines[1];
    const text = lines.slice(2).join('\n');

    const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!timeMatch) continue;

    const start = parseInt(timeMatch[1]) * 3600 +
                  parseInt(timeMatch[2]) * 60 +
                  parseInt(timeMatch[3]) +
                  parseInt(timeMatch[4]) / 1000;

    const end = parseInt(timeMatch[5]) * 3600 +
                parseInt(timeMatch[6]) * 60 +
                parseInt(timeMatch[7]) +
                parseInt(timeMatch[8]) / 1000;

    entries.push({ start, end, text: text.trim() });
  }

  return entries;
}

function removeDuplicates(entries) {
  const seen = new Set();
  return entries.filter(e => {
    // Create a key based on approximate time and text
    const timeKey = Math.round(e.start);
    const key = `${timeKey}:${e.text}`;

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fixOverlaps(entries) {
  // Sort by start time
  entries.sort((a, b) => a.start - b.start);

  for (let i = 0; i < entries.length - 1; i++) {
    const current = entries[i];
    const next = entries[i + 1];

    // If current ends after next starts, adjust
    if (current.end > next.start) {
      // Set current end to just before next starts
      current.end = next.start - 0.001;

      // Ensure minimum duration
      if (current.end <= current.start) {
        current.end = current.start + 0.5;
      }
    }
  }

  return entries;
}

function normalizeText(text) {
  return text
    .replace(/\s+/g, ' ')           // Multiple spaces to single
    .replace(/\n\s*\n/g, '\n')      // Multiple newlines to single
    .replace(/^\s+|\s+$/gm, '')     // Trim each line
    .trim();
}

function entriesToSrt(entries) {
  return entries.map((e, i) => {
    const start = formatTimestamp(e.start);
    const end = formatTimestamp(e.end);
    return `${i + 1}\n${start} --> ${end}\n${e.text}`;
  }).join('\n\n');
}

export function formatTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Convert segments to SRT string
 */
export function segmentsToSrt(segments) {
  return entriesToSrt(segments);
}
