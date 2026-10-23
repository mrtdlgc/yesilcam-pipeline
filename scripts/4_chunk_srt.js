import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { formatSRTTime } from './3_transcribe.js';

/**
 * Parse SRT content into segments
 */
export function parseSrt(srtContent) {
  const segments = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const index = parseInt(lines[0]);
    const timeLine = lines[1];
    const text = lines.slice(2).join('\n');

    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!timeMatch) continue;

    segments.push({
      index,
      start: timeMatch[1],
      end: timeMatch[2],
      text: text.trim()
    });
  }

  return segments;
}

/**
 * Convert segments back to SRT format
 */
export function segmentsToSrtContent(segments) {
  return segments.map((seg, i) => {
    return `${i + 1}\n${seg.start} --> ${seg.end}\n${seg.text}`;
  }).join('\n\n') + '\n';
}

/**
 * Format seconds to SRT timestamp
 */
function formatTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Chunk segments into smaller files for translation
 * Accepts either SRT string or array of segment objects
 *
 * @param {string|Array} input - SRT content or segments array
 * @param {string} outputDir - Directory to save chunks
 * @param {string} baseName - Base filename for chunks
 * @returns {Promise<{srtFiles: string[], jsonFiles: string[]}>}
 */
export async function chunkSrtForTranslation(input, outputDir, baseName) {
  // Handle both SRT string and segments array
  let segments;
  if (typeof input === 'string') {
    segments = parseSrt(input);
  } else {
    // Convert segments with numeric timestamps to SRT format
    segments = input.map((seg, i) => ({
      index: i + 1,
      start: typeof seg.start === 'number' ? formatTimestamp(seg.start) : seg.start,
      end: typeof seg.end === 'number' ? formatTimestamp(seg.end) : seg.end,
      text: seg.text
    }));
  }

  const chunkSize = config.SRT_CHUNK_SIZE;
  const totalChunks = Math.ceil(segments.length / chunkSize);
  console.log(`Chunking ${segments.length} entries into ${totalChunks} files (max ${chunkSize} each)`);

  const srtFiles = [];
  const jsonFiles = [];

  await fs.mkdir(outputDir, { recursive: true });

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, segments.length);
    const chunkSegments = segments.slice(start, end);

    const chunkNum = String(i + 1).padStart(2, '0');

    // Save SRT chunk
    const srtFilename = `${baseName}_chunk_${chunkNum}.srt`;
    const srtPath = path.join(outputDir, srtFilename);
    await fs.writeFile(srtPath, segmentsToSrtContent(chunkSegments));
    srtFiles.push(srtPath);

    // Save JSON chunk (structured format for LLM translation)
    const jsonFilename = `${baseName}_chunk_${chunkNum}.json`;
    const jsonPath = path.join(outputDir, jsonFilename);

    const jsonData = {
      metadata: {
        chunk: i + 1,
        totalChunks,
        entriesInChunk: chunkSegments.length,
        indexRange: `${start + 1}-${end}`
      },
      entries: chunkSegments.map(seg => ({
        id: seg.index,
        start: seg.start,
        end: seg.end,
        original: seg.text,
        translated: ""
      }))
    };

    await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');
    jsonFiles.push(jsonPath);

    // Save slim JSON for LLM translation (id + text only, smaller payload)
    const slimFilename = `${baseName}_chunk_${chunkNum}_translate.json`;
    const slimPath = path.join(outputDir, slimFilename);

    const slimData = {
      entries: chunkSegments.map(seg => ({
        id: seg.index,
        text: seg.text
      }))
    };

    await fs.writeFile(slimPath, JSON.stringify(slimData, null, 2), 'utf-8');

    console.log(`  Chunk ${i + 1}/${totalChunks}: entries ${start + 1}-${end}`);
  }

  return { srtFiles, jsonFiles };
}

/**
 * Merge translated JSON chunks back into a single SRT
 * Supports both full JSON (with translated field) and slim JSON import
 *
 * @param {string[]} jsonFiles - Array of full JSON chunk file paths
 * @param {string} outputPath - Output SRT file path
 * @param {Object} options - Optional settings
 * @param {string[]} options.translatedSlimFiles - Array of translated slim JSON files to import
 */
export async function mergeTranslatedChunks(jsonFiles, outputPath, options = {}) {
  const { translatedSlimFiles } = options;

  // If slim files provided, import translations first
  const translationMap = new Map();
  if (translatedSlimFiles && translatedSlimFiles.length > 0) {
    for (const slimFile of translatedSlimFiles) {
      const content = await fs.readFile(slimFile, 'utf-8');
      const data = JSON.parse(content);

      for (const entry of data.entries) {
        if (entry.text) {
          translationMap.set(entry.id, entry.text);
        }
      }
    }
    console.log(`Imported ${translationMap.size} translations from slim files`);
  }

  const allSegments = [];

  // Sort files by chunk number
  const sortedFiles = [...jsonFiles].sort();

  for (const jsonFile of sortedFiles) {
    const content = await fs.readFile(jsonFile, 'utf-8');
    const data = JSON.parse(content);

    for (const entry of data.entries) {
      // Priority: slim import > translated field > original
      const translatedText = translationMap.get(entry.id) || entry.translated || entry.original;

      allSegments.push({
        index: entry.id,
        start: entry.start,
        end: entry.end,
        text: translatedText
      });

      // Update the full JSON with translation if imported from slim
      if (translationMap.has(entry.id)) {
        entry.translated = translationMap.get(entry.id);
      }
    }

    // Save updated full JSON with translations
    if (translationMap.size > 0) {
      await fs.writeFile(jsonFile, JSON.stringify(data, null, 2), 'utf-8');
    }
  }

  // Sort by index to ensure correct order
  allSegments.sort((a, b) => a.index - b.index);

  // Write merged SRT
  const srtContent = segmentsToSrtContent(allSegments);
  await fs.writeFile(outputPath, srtContent, 'utf-8');

  console.log(`Merged ${allSegments.length} entries into ${outputPath}`);
  return outputPath;
}

/**
 * Import translations from a slim JSON file into the full JSON
 * This updates the full JSON in place and returns stats
 *
 * @param {string} fullJsonPath - Path to the full JSON chunk
 * @param {string} slimJsonPath - Path to the translated slim JSON
 * @returns {Promise<{imported: number, total: number}>}
 */
export async function importSlimTranslation(fullJsonPath, slimJsonPath) {
  const fullContent = await fs.readFile(fullJsonPath, 'utf-8');
  const fullData = JSON.parse(fullContent);

  const slimContent = await fs.readFile(slimJsonPath, 'utf-8');
  const slimData = JSON.parse(slimContent);

  // Build translation map from slim
  const translationMap = new Map();
  for (const entry of slimData.entries) {
    if (entry.text) {
      translationMap.set(entry.id, entry.text);
    }
  }

  // Apply translations to full JSON
  let importedCount = 0;
  for (const entry of fullData.entries) {
    if (translationMap.has(entry.id)) {
      entry.translated = translationMap.get(entry.id);
      importedCount++;
    }
  }

  // Save updated full JSON
  await fs.writeFile(fullJsonPath, JSON.stringify(fullData, null, 2), 'utf-8');

  console.log(`Imported ${importedCount}/${fullData.entries.length} translations into ${path.basename(fullJsonPath)}`);

  return { imported: importedCount, total: fullData.entries.length };
}

// CLI usage
if (process.argv[1].includes('4_chunk_srt')) {
  const [,, srtFile, outputDir] = process.argv;

  if (!srtFile) {
    console.log('Usage: node 4_chunk_srt.js <input.srt> [output_dir]');
    console.log('');
    console.log('Chunks SRT file into smaller files for LLM translation.');
    console.log('');
    console.log('Output files per chunk:');
    console.log('  - *_chunk_XX.srt            : SRT format (reference)');
    console.log('  - *_chunk_XX.json           : Full JSON with timestamps');
    console.log('  - *_chunk_XX_translate.json : Slim JSON for LLM (id + text only)');
    console.log('');
    console.log('Workflow:');
    console.log('  1. Send *_translate.json to LLM for translation');
    console.log('  2. LLM translates the "text" field');
    console.log('  3. Import translated file to update full JSON');
    console.log('  4. Merge all chunks into final SRT');
    process.exit(1);
  }

  const content = await fs.readFile(srtFile, 'utf-8');
  const baseName = path.basename(srtFile, '.srt');
  const outDir = outputDir || './output/chunks';

  const { srtFiles, jsonFiles } = await chunkSrtForTranslation(content, outDir, baseName);

  console.log('');
  console.log('Created files:');
  console.log('  SRT chunks:', srtFiles.length);
  console.log('  Full JSON chunks:', jsonFiles.length);
  console.log('  Slim JSON for LLM:', jsonFiles.length);
  console.log('');
  console.log('Use *_translate.json files for LLM translation (smaller payload).');
}
