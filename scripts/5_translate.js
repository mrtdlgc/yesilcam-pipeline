/**
 * LLM Translation using Ollama
 * Context-aware Turkish to English translation for subtitles
 *
 * Features:
 * - Uses surrounding sentences for context
 * - Infers dialogue meaning from context
 * - Corrects obvious Whisper typos
 * - Configurable model selection
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

/**
 * Ollama API client
 */
class OllamaClient {
  constructor(baseUrl = 'http://localhost:11434') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Check if Ollama is running and accessible
   */
  async checkHealth() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return {
        healthy: true,
        models: data.models?.map(m => m.name) || []
      };
    } catch (err) {
      return {
        healthy: false,
        error: err.message
      };
    }
  }

  /**
   * Check if a specific model is available
   */
  async hasModel(modelName) {
    const health = await this.checkHealth();
    if (!health.healthy) return false;

    // Normalize model name (remove :latest suffix for comparison)
    const normalizedName = modelName.split(':')[0];
    return health.models.some(m =>
      m.split(':')[0] === normalizedName || m === modelName
    );
  }

  /**
   * Send a chat completion request
   */
  async chat(model, messages, options = {}) {
    const timeout = options.timeout || config.TRANSLATION_TIMEOUT_MS || 60000;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.3,
          top_p: options.top_p ?? 0.9
        }
      }),
      signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error: ${response.status} ${text}`);
    }

    return await response.json();
  }
}

/**
 * Build translation prompt with surrounding context
 */
function buildTranslationPrompt(segment, contextBefore, contextAfter, movieContext) {
  const systemPrompt = `You are a professional Turkish to English subtitle translator.
You are translating dialogue from "${movieContext?.title || 'a Turkish film'}"${movieContext?.year ? ` (${movieContext.year})` : ''}.

Guidelines:
- Translate naturally for English subtitles
- Preserve the tone and emotion of the dialogue
- Fix obvious transcription errors if the meaning is clear from context
- Keep translations concise for subtitle readability (max 2 lines)
- Do not add explanations, notes, or quotes around the translation
- Return ONLY the English translation, nothing else

Important: If the text appears to be a transcription error or nonsense, try to infer the likely intended meaning from context. If impossible, translate literally.`;

  const userPromptParts = [];

  // Add context before
  if (contextBefore.length > 0) {
    userPromptParts.push('PREVIOUS LINES (for context):');
    contextBefore.forEach((s, i) => {
      userPromptParts.push(`  ${i + 1}. "${s.text}"`);
    });
    userPromptParts.push('');
  }

  // The line to translate
  userPromptParts.push(`TRANSLATE THIS LINE TO ENGLISH:`);
  userPromptParts.push(`"${segment.text}"`);

  // Add context after
  if (contextAfter.length > 0) {
    userPromptParts.push('');
    userPromptParts.push('NEXT LINES (for context):');
    contextAfter.forEach((s, i) => {
      userPromptParts.push(`  ${i + 1}. "${s.text}"`);
    });
  }

  return {
    system: systemPrompt,
    user: userPromptParts.join('\n')
  };
}

/**
 * Clean up LLM response to extract just the translation
 */
function cleanTranslation(response) {
  let text = response.trim();

  // Remove common prefixes
  const prefixes = [
    /^(Here'?s? )?the translation:?\s*/i,
    /^Translation:?\s*/i,
    /^In English:?\s*/i,
    /^English:?\s*/i
  ];

  for (const prefix of prefixes) {
    text = text.replace(prefix, '');
  }

  // Remove surrounding quotes if present
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }

  return text.trim();
}

/**
 * Translate a batch of segments
 *
 * @param {Array} segments - Segments to translate (with text, start, end)
 * @param {Object} movieContext - Movie metadata for context
 * @param {Function} progressCallback - Progress callback (percent, message)
 * @returns {Promise<Array>} - Segments with translations added
 */
export async function translateSegments(segments, movieContext = {}, progressCallback = null) {
  const client = new OllamaClient(config.OLLAMA_URL);

  // Check Ollama availability
  console.log('Checking Ollama connection...');
  const health = await client.checkHealth();

  if (!health.healthy) {
    throw new Error(`Ollama not available at ${config.OLLAMA_URL}: ${health.error}`);
  }

  console.log(`  Ollama connected, ${health.models.length} models available`);

  // Check model availability
  const model = config.OLLAMA_MODEL || 'llama3.1:8b';
  const hasModel = await client.hasModel(model);

  if (!hasModel) {
    console.log(`  Warning: Model '${model}' not found, available: ${health.models.join(', ')}`);

    // Try fallback model if configured
    if (config.OLLAMA_FALLBACK_MODEL) {
      const hasFallback = await client.hasModel(config.OLLAMA_FALLBACK_MODEL);
      if (hasFallback) {
        console.log(`  Using fallback model: ${config.OLLAMA_FALLBACK_MODEL}`);
      } else {
        throw new Error(`Neither ${model} nor ${config.OLLAMA_FALLBACK_MODEL} available`);
      }
    } else {
      throw new Error(`Model '${model}' not available. Run: ollama pull ${model}`);
    }
  }

  const effectiveModel = hasModel ? model : config.OLLAMA_FALLBACK_MODEL;
  console.log(`  Using model: ${effectiveModel}`);

  const translated = [];
  const contextWindow = config.TRANSLATION_CONTEXT_WINDOW || 5;
  const retryAttempts = config.TRANSLATION_RETRY_ATTEMPTS || 3;

  console.log(`Translating ${segments.length} segments...`);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // Skip empty segments
    if (!segment.text || segment.text.trim().length === 0) {
      translated.push({
        ...segment,
        translatedText: '',
        _translated: true
      });
      continue;
    }

    // Get context windows
    const contextBefore = segments.slice(Math.max(0, i - contextWindow), i);
    const contextAfter = segments.slice(i + 1, Math.min(segments.length, i + 1 + contextWindow));

    // Build prompt
    const prompt = buildTranslationPrompt(segment, contextBefore, contextAfter, movieContext);

    // Translate with retries
    let translation = null;
    let lastError = null;

    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      try {
        const response = await client.chat(effectiveModel, [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ]);

        if (response.message?.content) {
          translation = cleanTranslation(response.message.content);
          break;
        }
      } catch (err) {
        lastError = err;
        console.log(`    Retry ${attempt + 1}/${retryAttempts}: ${err.message}`);

        // Wait before retry
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (!translation) {
      console.log(`    Warning: Translation failed for segment ${i + 1}, keeping original`);
      translation = `[TRANSLATION_FAILED] ${segment.text}`;
    }

    translated.push({
      ...segment,
      translatedText: translation,
      _translated: true
    });

    // Progress
    if ((i + 1) % 10 === 0 || i === segments.length - 1) {
      const pct = Math.round((i + 1) / segments.length * 100);
      console.log(`  Progress: ${i + 1}/${segments.length} (${pct}%)`);
    }

    if (progressCallback) {
      progressCallback((i + 1) / segments.length * 100, `Translating ${i + 1}/${segments.length}...`);
    }
  }

  console.log(`✓ Translation complete: ${translated.length} segments`);

  return translated;
}

/**
 * Parse SRT file to segments
 */
export async function parseSrtFile(srtPath) {
  const content = await fs.readFile(srtPath, 'utf-8');
  const segments = [];

  // Split by subtitle blocks (double newline)
  const blocks = content.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');

    if (lines.length < 2) continue;

    // Parse index (first line)
    const index = parseInt(lines[0], 10);
    if (isNaN(index)) continue;

    // Parse timestamp (second line)
    const timestampMatch = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );

    if (!timestampMatch) continue;

    const start =
      parseInt(timestampMatch[1]) * 3600 +
      parseInt(timestampMatch[2]) * 60 +
      parseInt(timestampMatch[3]) +
      parseInt(timestampMatch[4]) / 1000;

    const end =
      parseInt(timestampMatch[5]) * 3600 +
      parseInt(timestampMatch[6]) * 60 +
      parseInt(timestampMatch[7]) +
      parseInt(timestampMatch[8]) / 1000;

    // Text is remaining lines
    const text = lines.slice(2).join('\n').trim();

    segments.push({ index, start, end, text });
  }

  return segments;
}

/**
 * Format seconds to SRT timestamp
 */
function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Generate SRT content from translated segments
 */
export function segmentsToSrt(segments, useTranslation = true) {
  let srt = '';

  segments.forEach((segment, index) => {
    const startTime = formatSrtTime(segment.start);
    const endTime = formatSrtTime(segment.end);
    const text = useTranslation && segment.translatedText
      ? segment.translatedText
      : segment.text;

    srt += `${index + 1}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${text.trim()}\n\n`;
  });

  return srt;
}

/**
 * Save translated segments to SRT file
 */
export async function saveTranslatedSrt(segments, outputPath) {
  const srtContent = segmentsToSrt(segments, true);
  await fs.writeFile(outputPath, srtContent, 'utf-8');
  console.log(`  English SRT saved: ${path.basename(outputPath)}`);
}

/**
 * Main translation pipeline entry point
 *
 * @param {string} turkishSrtPath - Path to Turkish SRT file
 * @param {string} outputPath - Path for English SRT output
 * @param {Object} movieContext - Movie metadata
 * @param {Function} progressCallback - Progress callback
 */
export async function translateSrtFile(turkishSrtPath, outputPath, movieContext = {}, progressCallback = null) {
  console.log(`Translating SRT: ${path.basename(turkishSrtPath)}`);

  // Parse Turkish SRT
  const segments = await parseSrtFile(turkishSrtPath);
  console.log(`  Parsed ${segments.length} segments`);

  // Translate
  const translated = await translateSegments(segments, movieContext, progressCallback);

  // Save English SRT
  await saveTranslatedSrt(translated, outputPath);

  return translated;
}

/**
 * Check if translation is available
 */
export async function checkTranslationAvailable() {
  if (!config.TRANSLATION_ENABLED) {
    return { available: false, reason: 'disabled' };
  }

  const client = new OllamaClient(config.OLLAMA_URL);
  const health = await client.checkHealth();

  if (!health.healthy) {
    return { available: false, reason: `Ollama not reachable: ${health.error}` };
  }

  const model = config.OLLAMA_MODEL || 'llama3.1:8b';
  const hasModel = await client.hasModel(model);

  if (!hasModel && config.OLLAMA_FALLBACK_MODEL) {
    const hasFallback = await client.hasModel(config.OLLAMA_FALLBACK_MODEL);
    if (hasFallback) {
      return { available: true, model: config.OLLAMA_FALLBACK_MODEL };
    }
  }

  if (!hasModel) {
    return { available: false, reason: `Model '${model}' not available` };
  }

  return { available: true, model };
}

// CLI usage
if (process.argv[1].includes('5_translate')) {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const result = await checkTranslationAvailable();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.available ? 0 : 1);
  }

  const srtFile = args.find(a => a.endsWith('.srt'));
  if (!srtFile) {
    console.log('Usage: node 5_translate.js <input.srt> [--output <output.srt>] [--check]');
    console.log('');
    console.log('Translates Turkish SRT to English using Ollama LLM.');
    console.log('');
    console.log('Options:');
    console.log('  --check      Check if translation is available');
    console.log('  --output     Output file path (default: input_en.srt)');
    console.log('  --title      Movie title for context');
    console.log('  --year       Movie year for context');
    process.exit(1);
  }

  const outputIdx = args.indexOf('--output');
  const outputFile = outputIdx >= 0
    ? args[outputIdx + 1]
    : srtFile.replace('.srt', '_en.srt');

  const titleIdx = args.indexOf('--title');
  const yearIdx = args.indexOf('--year');

  const movieContext = {
    title: titleIdx >= 0 ? args[titleIdx + 1] : null,
    year: yearIdx >= 0 ? args[yearIdx + 1] : null
  };

  try {
    await translateSrtFile(srtFile, outputFile, movieContext);
    console.log(`\n✓ Translation saved to: ${outputFile}`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}
