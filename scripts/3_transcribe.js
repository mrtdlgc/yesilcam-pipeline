import Groq from 'groq-sdk';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import dotenv from 'dotenv';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect Python command (python3 on Linux/Mac, python on Windows)
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

dotenv.config();

// Lazy-load Groq client only when needed
let groq = null;
function getGroqClient() {
  if (!groq) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groq;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Check if local whisper (faster-whisper) is available
let localWhisperAvailable = null;
async function checkLocalWhisper() {
  if (localWhisperAvailable !== null) {
    return localWhisperAvailable;
  }

  try {
    const pythonScript = path.join(__dirname, 'local_whisper.py');
    const result = execSync(`${PYTHON_CMD} "${pythonScript}" --check`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const info = JSON.parse(result.trim());
    localWhisperAvailable = info.installed === true;

    if (localWhisperAvailable) {
      console.log(`Local Whisper available: ${info.cpu_threads}/${info.total_cpus} threads`);
    }
    return localWhisperAvailable;
  } catch (err) {
    localWhisperAvailable = false;
    return false;
  }
}

/**
 * Persistent Whisper Worker - keeps model loaded in memory
 * Eliminates ~5 second model load time per chunk
 */
class WhisperWorker {
  constructor() {
    this.process = null;
    this.readline = null;
    this.ready = false;
    this.loadTime = 0;
  }

  async start() {
    if (this.process) {
      return; // Already running
    }

    const workerScript = path.join(__dirname, 'whisper_worker.py');

    console.log('Starting Whisper Worker (model loads once)...');

    return new Promise((resolve, reject) => {
      this.process = spawn(PYTHON_CMD, [workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',  // Force UTF-8 for stdin/stdout (Cyrillic, etc.)
          WHISPER_MODEL: config.LOCAL_WHISPER_MODEL || 'large-v3',
          WHISPER_DEVICE: config.LOCAL_WHISPER_DEVICE || 'cpu',
          WHISPER_COMPUTE_TYPE: config.LOCAL_WHISPER_COMPUTE_TYPE || 'int8'
        }
      });

      // Stream stderr (progress messages) to console
      this.process.stderr.on('data', (data) => {
        process.stderr.write(data.toString());
      });

      // Read JSON responses from stdout
      this.readline = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity
      });

      // Wait for ready signal
      const onFirstLine = (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.status === 'ready') {
            this.ready = true;
            this.loadTime = msg.load_time;
            resolve();
          } else if (msg.error) {
            reject(new Error(msg.error));
          }
        } catch (e) {
          reject(new Error(`Invalid worker response: ${line}`));
        }
      };

      this.readline.once('line', onFirstLine);

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start Whisper worker: ${err.message}`));
      });

      this.process.on('close', (code) => {
        if (!this.ready) {
          reject(new Error(`Whisper worker exited with code ${code}`));
        }
        this.process = null;
        this.readline = null;
        this.ready = false;
      });
    });
  }

  async transcribe(audioFile, language, prompt = null) {
    if (!this.ready || !this.process) {
      throw new Error('Whisper worker not ready');
    }

    return new Promise((resolve, reject) => {
      const request = {
        file: audioFile,
        language: language
      };
      if (prompt) {
        request.prompt = prompt;
      }

      // Send request
      this.process.stdin.write(JSON.stringify(request) + '\n');

      // Wait for response
      const onLine = (line) => {
        try {
          const response = JSON.parse(line);
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        } catch (e) {
          reject(new Error(`Invalid worker response: ${line}`));
        }
      };

      this.readline.once('line', onLine);
    });
  }

  async stop() {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      this.process.stdin.write(JSON.stringify({ command: 'quit' }) + '\n');

      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill();
        }
        resolve();
      }, 5000);

      this.process.on('close', () => {
        clearTimeout(timeout);
        this.process = null;
        this.readline = null;
        this.ready = false;
        resolve();
      });
    });
  }
}

// Global worker instance for batch processing
let whisperWorker = null;

// Whisper prompt token limit (conservative estimate - actual limit is 224 tokens)
const MAX_PROMPT_CHARS = 250; // Keep it short to reduce hallucinations

/**
 * Check if text has encoding corruption (mojibake, replacement chars, etc.)
 * Returns true if the text appears corrupted and shouldn't be used as a prompt
 * @param {string} text - Text to validate
 * @returns {boolean} - True if corrupted, false if valid
 */
function hasEncodingCorruption(text) {
  if (!text) return true;

  // Check for Unicode replacement character (U+FFFD)
  if (text.includes('\uFFFD')) return true;

  // Check for common mojibake string patterns (UTF-8 decoded as Latin-1/Windows-1252)
  // These specific strings appear when Turkish/Cyrillic UTF-8 is misinterpreted
  const mojibakeStrings = [
    'Ã¼', 'Ã¶', 'Ã§', 'ÅŸ', 'Ä±', 'Äž', 'Ä°',  // Turkish lowercase mojibake
    'Ã–', 'Ã‡', 'Ãœ',  // Turkish uppercase mojibake
    'Ð', 'Ñ',  // Cyrillic mojibake prefixes
    'â€', 'â€™', 'â€œ', 'â€"',  // Smart quote mojibake
  ];

  for (const str of mojibakeStrings) {
    if (text.includes(str)) return true;
  }

  // Check for the specific corruption pattern seen: ŏ¼, ĕ¼, ů¼, etc.
  // These are fullwidth characters mixed with Latin that indicate corruption
  if (/[\u014F\u0115\u016F]\u00BC/.test(text)) return true;  // ŏ¼, ĕ¼, ů¼
  if (/.\u00BC(?![0-9])/.test(text)) return true;  // ¼ not used as fraction

  // Check for Latin Extended chars followed by symbols (common corruption pattern)
  if (/[\u0100-\u017F][\u00A0-\u00BF]/.test(text)) return true;

  // Check for characters that shouldn't appear in normal text
  // Control characters (except whitespace), private use area
  const invalidChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF]/;
  if (invalidChars.test(text)) return true;

  return false;
}

/**
 * Build simple prompt for Whisper transcription
 * Only uses last sentence from previous chunk for continuity
 * Simpler prompts = fewer hallucinations
 *
 * @param {Object} movieContext - Movie metadata (unused, kept for compatibility)
 * @param {string|null} previousSentence - Last sentence from previous chunk
 * @returns {string|null} - Previous sentence or null
 */
export function buildSandwichPrompt(movieContext = {}, previousSentence = null) {
  // Check if prompting is enabled
  if (!config.WHISPER_PROMPT_ENABLED) {
    return null;
  }

  // Only use previous sentence if enabled
  if (!config.WHISPER_USE_PREVIOUS_SENTENCE || !previousSentence) {
    return null;
  }

  // Truncate if too long
  let prompt = previousSentence.trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(-MAX_PROMPT_CHARS);
    // Try to start at word boundary
    const firstSpace = prompt.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 30) {
      prompt = prompt.slice(firstSpace + 1);
    }
  }

  // Safety check: skip corrupted text (encoding issues cause Whisper errors)
  if (hasEncodingCorruption(prompt)) {
    console.log('  Skipping corrupted prompt in buildSandwichPrompt');
    return null;
  }

  return prompt || null;
}

/**
 * Save raw Groq response for debugging and iteration
 */
async function saveRawResponse(response, jobId, chunkIndex = null) {
  const rawDir = './output/raw_transcriptions';
  await fsPromises.mkdir(rawDir, { recursive: true });

  const suffix = chunkIndex !== null ? `_chunk_${String(chunkIndex).padStart(2, '0')}` : '';
  const filename = `${jobId}${suffix}_raw.json`;
  const filepath = path.join(rawDir, filename);

  await fsPromises.writeFile(filepath, JSON.stringify(response, null, 2), 'utf-8');
  console.log(`  Raw JSON saved: ${filename}`);

  return filepath;
}

/**
 * Extract the last sentence from segments to use as prompt for next chunk
 * This helps Whisper maintain context across chunk boundaries
 * @param {Array} segments - Array of transcribed segments
 * @returns {string|null} - Last sentence text or null if none available
 */
function extractLastSentenceForPrompt(segments) {
  if (!segments || segments.length === 0) {
    return null;
  }

  // Get text from the last few segments (in case last segment is very short)
  const lastSegments = segments.slice(-3);
  const combinedText = lastSegments.map(s => s.text).join(' ').trim();

  if (!combinedText) {
    return null;
  }

  // Try to extract the last complete sentence
  // Turkish sentence endings: . ! ? (also handles ... and similar)
  const sentenceEndPattern = /[.!?]+\s*/g;
  const sentences = combinedText.split(sentenceEndPattern).filter(s => s.trim());

  if (sentences.length === 0) {
    // No clear sentence boundary, use the last segment's text
    const lastText = segments[segments.length - 1].text.trim();
    const fallbackPrompt = lastText.slice(-MAX_PROMPT_CHARS);
    // Skip if corrupted
    if (hasEncodingCorruption(fallbackPrompt)) {
      console.log('  Skipping corrupted prompt (encoding issue detected)');
      return null;
    }
    return fallbackPrompt;
  }

  // Get the last 1-2 sentences, respecting the character limit
  let prompt = '';
  for (let i = sentences.length - 1; i >= 0 && prompt.length < MAX_PROMPT_CHARS; i--) {
    const sentence = sentences[i].trim();
    if (sentence) {
      prompt = sentence + (prompt ? '. ' + prompt : '');
    }
  }

  // Trim to max length if needed
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(-MAX_PROMPT_CHARS);
    // Try to start at a word boundary
    const firstSpace = prompt.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 50) {
      prompt = prompt.slice(firstSpace + 1);
    }
  }

  // Skip if corrupted (encoding issues, mojibake, etc.)
  if (hasEncodingCorruption(prompt)) {
    console.log('  Skipping corrupted prompt (encoding issue detected)');
    return null;
  }

  return prompt || null;
}

/**
 * Transcribe audio using persistent Whisper worker (faster-whisper)
 * Model stays loaded in memory - no reload between chunks
 * Returns segments matching Groq API format
 */
async function transcribeWithLocalWhisper(audioFile, language, jobId, chunkIndex = null, prompt = null, useWorker = false) {
  if (prompt) {
    console.log(`  Using prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);
  }

  // Use persistent worker if available (for batch processing)
  if (useWorker && whisperWorker && whisperWorker.ready) {
    const response = await whisperWorker.transcribe(audioFile, language, prompt);

    // Save to raw_transcriptions for consistency
    await saveRawResponse(response, jobId, chunkIndex);

    console.log(`✓ Transcribed: ${response.segments.length} segments`);

    // Return segments with metadata
    return response.segments.map(seg => ({
      text: seg.text.trim(),
      start: seg.start,
      end: seg.end,
      seek: seg.seek || 0,
      no_speech_prob: seg.no_speech_prob || 0,
      avg_logprob: seg.avg_logprob || 0,
      compression_ratio: seg.compression_ratio || 1,
      temperature: seg.temperature || 0
    }));
  }

  // Fallback: spawn new process (for single-file transcription)
  console.log('Transcribing with local Whisper (faster-whisper)...');

  const pythonScript = path.join(__dirname, 'local_whisper.py');
  const outputFile = path.join('./temp', `${jobId}_local_${chunkIndex ?? 'full'}.json`);

  const args = [
    pythonScript,
    audioFile,
    '--language', language,
    '--model', config.LOCAL_WHISPER_MODEL || 'large-v3',
    '--output', outputFile
  ];

  if (prompt) {
    args.push('--prompt', prompt);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WHISPER_CPU_THREADS: String(config.LOCAL_WHISPER_CPU_THREADS || 0),
        WHISPER_WORKERS: String(config.LOCAL_WHISPER_WORKERS || 0)
      }
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      const line = data.toString();
      stderr += line;
      process.stderr.write(line);
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Local Whisper failed (code ${code}): ${stderr}`));
        return;
      }

      try {
        const jsonContent = await fsPromises.readFile(outputFile, 'utf-8');
        const response = JSON.parse(jsonContent);

        await saveRawResponse(response, jobId, chunkIndex);
        try { await fsPromises.unlink(outputFile); } catch (e) {}

        console.log(`✓ Local Whisper complete: ${response.segments.length} segments`);

        resolve(response.segments.map(seg => ({
          text: seg.text.trim(),
          start: seg.start,
          end: seg.end,
          seek: seg.seek || 0,
          no_speech_prob: seg.no_speech_prob || 0,
          avg_logprob: seg.avg_logprob || 0,
          compression_ratio: seg.compression_ratio || 1,
          temperature: seg.temperature || 0
        })));
      } catch (err) {
        reject(new Error(`Failed to parse local Whisper output: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn local Whisper: ${err.message}`));
    });
  });
}

/**
 * Transcribe audio using Groq API with segment-level timestamps
 * Returns segments with timing and metadata for hallucination filtering
 * Note: We only request segment granularity (not word) to reduce JSON size
 *
 * @param {string} audioFile - Path to audio file
 * @param {string} language - Language code (e.g., 'tr')
 * @param {string} jobId - Job ID for saving raw output
 * @param {number|null} chunkIndex - Chunk index for multi-chunk transcription
 * @param {string|null} prompt - Optional prompt (last sentence from previous chunk)
 */
async function transcribeWithGroq(audioFile, language, jobId, chunkIndex = null, prompt = null) {
  console.log('Transcribing with Groq Whisper API...');

  if (prompt) {
    console.log(`  Using prompt from previous chunk: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);
  }

  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set in .env file');
  }

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audioStream = fs.createReadStream(audioFile);

      // Build request options
      const requestOptions = {
        file: audioStream,
        model: config.GROQ_MODEL,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment']  // Only segment-level, no word-level
      };

      // Only set language if not 'auto' (omitting triggers auto-detection)
      if (language && language !== 'auto') {
        requestOptions.language = language;
      }

      // Add prompt if provided (helps maintain context across chunks)
      if (prompt) {
        requestOptions.prompt = prompt;
      }

      const response = await getGroqClient().audio.transcriptions.create(requestOptions);

      console.log(`✓ Groq transcription complete: ${response.segments.length} segments`);

      // Save raw response for debugging/iteration
      await saveRawResponse(response, jobId, chunkIndex);

      // Return segments with metadata for hallucination filtering
      return response.segments.map(seg => ({
        text: seg.text.trim(),
        start: seg.start,
        end: seg.end,
        // Metadata for hallucination detection
        seek: seg.seek || 0,                           // Position in audio (0 = start)
        no_speech_prob: seg.no_speech_prob || 0,       // Probability of no speech
        avg_logprob: seg.avg_logprob || 0,             // Average log probability
        compression_ratio: seg.compression_ratio || 1, // Text compression ratio
        temperature: seg.temperature || 0              // Model temperature used
      }));
    } catch (error) {
      const isConnectionError = !error.status ||
        error.message?.includes('Connection') ||
        error.message?.includes('ECONNRESET') ||
        error.message?.includes('ETIMEDOUT');

      if (isConnectionError && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`Connection error on attempt ${attempt}/${MAX_RETRIES}. Retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }

      throw new Error(`Groq transcription failed: ${error.status || 'Connection'} ${JSON.stringify(error.error || error.message)}`);
    }
  }
}

/**
 * Transcribe audio with automatic backend selection
 * Tries local Whisper first (if available), falls back to Groq API
 *
 * @param {string} audioFile - Path to audio file
 * @param {string} language - Language code (e.g., 'tr')
 * @param {string} jobId - Job ID for saving raw output
 * @param {number|null} chunkIndex - Chunk index for multi-chunk transcription
 * @param {string|null} prompt - Optional prompt (last sentence from previous chunk)
 * @param {Object|null} movieContext - Optional movie context for sandwich prompt
 */
export async function transcribeToSegments(audioFile, language, jobId, chunkIndex = null, prompt = null, movieContext = null) {
  // Build sandwich prompt if movie context provided
  const effectivePrompt = movieContext ? buildSandwichPrompt(movieContext, prompt) : prompt;
  const backend = config.TRANSCRIBE_BACKEND || 'auto';

  // Determine which backend to use
  if (backend === 'local') {
    // Force local only
    return transcribeWithLocalWhisper(audioFile, language, jobId, chunkIndex, effectivePrompt);
  }

  if (backend === 'groq') {
    // Force Groq only
    return transcribeWithGroq(audioFile, language, jobId, chunkIndex, effectivePrompt);
  }

  // Auto mode: try local first, fall back to Groq
  const hasLocalWhisper = await checkLocalWhisper();

  if (hasLocalWhisper) {
    try {
      return await transcribeWithLocalWhisper(audioFile, language, jobId, chunkIndex, effectivePrompt);
    } catch (localError) {
      console.log(`  Local Whisper failed: ${localError.message}`);
      console.log('  Falling back to Groq API...');
    }
  }

  // Fallback to Groq
  return transcribeWithGroq(audioFile, language, jobId, chunkIndex, effectivePrompt);
}

/**
 * Get checkpoint file path for a job
 */
function getCheckpointPath(jobId) {
  return path.join('./temp', `${jobId}_transcription_checkpoint.json`);
}

/**
 * Load checkpoint if it exists
 */
async function loadCheckpoint(jobId) {
  const checkpointPath = getCheckpointPath(jobId);
  try {
    if (existsSync(checkpointPath)) {
      const data = await fsPromises.readFile(checkpointPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.log('Warning: Could not load checkpoint, starting fresh');
  }
  return null;
}

/**
 * Save checkpoint after successful chunk
 */
async function saveCheckpoint(jobId, completedChunks, segments, totalChunks, lastPrompt = null) {
  const checkpointPath = getCheckpointPath(jobId);
  const checkpoint = {
    completedChunks,
    segments,
    totalChunks,
    lastPrompt,  // Save prompt for resuming
    savedAt: new Date().toISOString()
  };
  await fsPromises.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Delete checkpoint file after successful completion
 */
async function deleteCheckpoint(jobId) {
  const checkpointPath = getCheckpointPath(jobId);
  try {
    if (existsSync(checkpointPath)) {
      await fsPromises.unlink(checkpointPath);
    }
  } catch (err) {
    // Ignore deletion errors
  }
}

/**
 * Transcribe multiple audio chunks and return merged segments
 * Uses persistent Whisper worker to avoid model reload between chunks
 * Includes checkpoint/resume functionality for fault tolerance
 * Passes last sentence from previous chunk as prompt for context continuity
 *
 * @param {Array} chunks - Array of audio chunks with file paths and timing
 * @param {string} language - Language code (e.g., 'tr')
 * @param {string} jobId - Job ID for checkpointing
 * @param {Object|null} movieContext - Optional movie context for sandwich prompt
 */
export async function transcribeChunksToSegments(chunks, language, jobId, movieContext = null) {
  // Determine backend for rate limiting decisions
  const backend = config.TRANSCRIBE_BACKEND || 'auto';
  const hasLocalWhisper = await checkLocalWhisper();
  const usingGroq = backend === 'groq' || (backend === 'auto' && !hasLocalWhisper);
  const usingLocalWhisper = !usingGroq;

  // Start persistent Whisper worker for batch processing (loads model once)
  if (usingLocalWhisper) {
    whisperWorker = new WhisperWorker();
    try {
      await whisperWorker.start();
    } catch (err) {
      console.log(`  Failed to start Whisper worker: ${err.message}`);
      console.log('  Falling back to per-chunk process spawning...');
      whisperWorker = null;
    }
  }

  // Check for existing checkpoint
  const checkpoint = await loadCheckpoint(jobId);
  let allSegments = [];
  let startIndex = 0;
  let lastPrompt = null;

  if (checkpoint && checkpoint.completedChunks > 0) {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║  RESUMING FROM CHECKPOINT                                      ║');
    console.log(`║  Previously completed: ${checkpoint.completedChunks}/${checkpoint.totalChunks} chunks`.padEnd(65) + '║');
    console.log(`║  Saved at: ${checkpoint.savedAt}`.padEnd(65) + '║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');

    allSegments = checkpoint.segments;
    startIndex = checkpoint.completedChunks;
    lastPrompt = checkpoint.lastPrompt || null;

    // If resuming, extract prompt from last completed chunk's segments
    if (!lastPrompt && allSegments.length > 0) {
      lastPrompt = extractLastSentenceForPrompt(allSegments);
    }
  }

  // Calculate estimated time (only relevant for Groq with rate limiting)
  const chunksToProcess = chunks.length - startIndex;

  console.log(`Transcribing ${chunks.length} chunks...`);

  if (usingGroq) {
    const estimatedSeconds = chunksToProcess * (config.GROQ_RATE_LIMIT_DELAY_MS / 1000);
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
    console.log(`  Backend: Groq API`);
    console.log(`  Rate limit: ${config.GROQ_RATE_LIMIT_DELAY_MS / 1000}s between requests (Groq 20 RPM limit)`);
    console.log(`  Estimated time: ~${estimatedMinutes} minutes for ${chunksToProcess} chunks`);
  } else {
    console.log(`  Backend: Local Whisper (persistent worker)`);
    console.log(`  Model loaded once - no reload between chunks`);
  }

  if (startIndex > 0) {
    console.log(`  Resuming from chunk ${startIndex + 1} (${startIndex} already completed)`);
  }

  try {
    for (let i = startIndex; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log('');
      console.log(`━━━ CHUNK ${i + 1}/${chunks.length} ━━━`);
      console.log(`Time: ${chunk.startTime.toFixed(2)}s - ${chunk.endTime.toFixed(2)}s`);

      // Rate limiting: only needed for Groq API
      if (usingGroq && i > startIndex) {
        const remainingChunks = chunks.length - i;
        const estimatedMinutes = Math.ceil((remainingChunks * config.GROQ_RATE_LIMIT_DELAY_MS) / 60000);
        console.log(`  Rate limit delay: ${config.GROQ_RATE_LIMIT_DELAY_MS / 1000}s (est. ${estimatedMinutes} min remaining)`);
        await sleep(config.GROQ_RATE_LIMIT_DELAY_MS);
      }

      try {
        // Build sandwich prompt with movie context + previous sentence
        const previousSentence = i > 0 ? lastPrompt : null;
        const promptForThisChunk = buildSandwichPrompt(movieContext, previousSentence);

        let segments;
        if (usingLocalWhisper) {
          // Use persistent worker (model already loaded)
          segments = await transcribeWithLocalWhisper(chunk.file, language, jobId, i, promptForThisChunk, true);
        } else {
          segments = await transcribeWithGroq(chunk.file, language, jobId, i, promptForThisChunk);
        }

        // Adjust timestamps by chunk start time, preserve all metadata
        const adjustedSegments = segments.map(seg => ({
          text: seg.text,
          start: seg.start + chunk.startTime,
          end: seg.end + chunk.startTime,
          // Preserve metadata for hallucination filtering
          seek: seg.seek,
          no_speech_prob: seg.no_speech_prob,
          avg_logprob: seg.avg_logprob,
          compression_ratio: seg.compression_ratio,
          temperature: seg.temperature
        }));

        allSegments.push(...adjustedSegments);

        // Extract last sentence for next chunk's prompt
        lastPrompt = extractLastSentenceForPrompt(adjustedSegments);

        // Save checkpoint after each successful chunk
        await saveCheckpoint(jobId, i + 1, allSegments, chunks.length, lastPrompt);
        console.log(`✓ Chunk ${i + 1}/${chunks.length} complete (${adjustedSegments.length} segments)`);

      } catch (error) {
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════════╗');
        console.log('║  TRANSCRIPTION FAILED - PROGRESS SAVED                         ║');
        console.log(`║  Failed at chunk: ${i + 1}/${chunks.length}`.padEnd(65) + '║');
        console.log(`║  Completed: ${i}/${chunks.length} chunks`.padEnd(65) + '║');
        console.log('║                                                                 ║');
        console.log('║  Run again with same URL to resume from checkpoint.            ║');
        console.log('╚════════════════════════════════════════════════════════════════╝');
        console.log('');
        throw error;
      }
    }
  } finally {
    // Always stop the worker when done (success or failure)
    if (whisperWorker) {
      console.log('Stopping Whisper worker...');
      await whisperWorker.stop();
      whisperWorker = null;
    }
  }

  // All chunks completed - delete checkpoint
  await deleteCheckpoint(jobId);

  console.log('');
  console.log(`✓ All chunks transcribed: ${allSegments.length} total segments`);

  return allSegments;
}

// SRT formatting utilities
export function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

function pad(num, size = 2) {
  return num.toString().padStart(size, '0');
}

export function segmentsToSrt(segments) {
  let srt = '';
  segments.forEach((segment, index) => {
    const startTime = formatSRTTime(segment.start);
    const endTime = formatSRTTime(segment.end);
    srt += `${index + 1}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${segment.text.trim()}\n\n`;
  });
  return srt;
}
