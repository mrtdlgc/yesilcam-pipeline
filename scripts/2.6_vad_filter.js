/**
 * Silero VAD Filter - Node.js wrapper
 * Filters audio chunks using Silero VAD to discard non-speech segments
 *
 * This is a secondary filter after FFT-based chunking.
 * Helps reduce Whisper processing time by skipping silent/music chunks.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect Python command (python3 on Linux/Mac, python on Windows)
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

// Cache availability check
let sileroAvailable = null;

/**
 * Check if Silero VAD dependencies are available
 * @returns {Promise<{available: boolean, details: Object}>}
 */
export async function checkSileroAvailable() {
  if (sileroAvailable !== null) {
    return sileroAvailable;
  }

  try {
    const pythonScript = path.join(__dirname, '2.6_vad_filter.py');
    const result = execSync(`${PYTHON_CMD} "${pythonScript}" --check`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const info = JSON.parse(result.trim());
    sileroAvailable = {
      available: info.installed === true,
      details: info
    };

    if (sileroAvailable.available) {
      console.log(`  Silero VAD available (torch ${info.torch_version})`);
    }

    return sileroAvailable;
  } catch (err) {
    sileroAvailable = {
      available: false,
      details: { error: err.message }
    };
    return sileroAvailable;
  }
}

/**
 * Filter audio chunks using Silero VAD
 *
 * @param {Array} chunks - Array of chunk objects from FFT chunking
 *   Each chunk: { file, startTime, endTime, ... }
 * @param {string} jobId - Job ID for temp files
 * @param {Object} options - Filter options
 * @returns {Promise<{kept: Array, discarded: Array, stats: Object}>}
 */
export async function filterWithSileroVAD(chunks, jobId, options = {}) {
  // Check if VAD is enabled
  if (!config.SILERO_VAD_ENABLED) {
    console.log('  Silero VAD disabled in config, skipping filter');
    return {
      kept: chunks,
      discarded: [],
      stats: {
        total_chunks: chunks.length,
        kept_count: chunks.length,
        discarded_count: 0,
        saved_duration_s: 0,
        skipped: 'disabled'
      }
    };
  }

  // Check availability
  const availability = await checkSileroAvailable();
  if (!availability.available) {
    console.log('  Silero VAD not available, skipping filter');
    console.log(`    Reason: ${JSON.stringify(availability.details)}`);
    return {
      kept: chunks,
      discarded: [],
      stats: {
        total_chunks: chunks.length,
        kept_count: chunks.length,
        discarded_count: 0,
        saved_duration_s: 0,
        skipped: 'unavailable'
      }
    };
  }

  console.log('Filtering chunks with Silero VAD...');

  // Prepare temp files
  const tempDir = './temp';
  await fs.mkdir(tempDir, { recursive: true });

  const inputFile = path.join(tempDir, `${jobId}_vad_input.json`);
  const outputFile = path.join(tempDir, `${jobId}_vad_output.json`);

  // Write chunks to temp file
  await fs.writeFile(inputFile, JSON.stringify({ chunks }), 'utf-8');

  // Run Python VAD filter
  const pythonScript = path.join(__dirname, '2.6_vad_filter.py');

  const threshold = options.threshold ?? config.SILERO_VAD_THRESHOLD ?? 0.5;
  const minSpeechMs = options.minSpeechMs ?? config.SILERO_MIN_SPEECH_MS ?? 250;

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, [
      pythonScript,
      inputFile,
      '--output', outputFile,
      '--threshold', String(threshold),
      '--min-speech-ms', String(minSpeechMs)
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      const line = data.toString();
      stderr += line;
      process.stderr.write(line);
    });

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.on('close', async (code) => {
      // Clean up input file
      try { await fs.unlink(inputFile); } catch (e) {}

      if (code !== 0) {
        // On error, return all chunks (don't filter)
        console.log(`  Warning: VAD filter failed (code ${code}), using all chunks`);
        resolve({
          kept: chunks,
          discarded: [],
          stats: {
            total_chunks: chunks.length,
            kept_count: chunks.length,
            discarded_count: 0,
            saved_duration_s: 0,
            error: stderr || 'Process failed'
          }
        });
        return;
      }

      try {
        // Read results
        const resultContent = await fs.readFile(outputFile, 'utf-8');
        const result = JSON.parse(resultContent);

        // Clean up output file
        try { await fs.unlink(outputFile); } catch (e) {}

        resolve(result);
      } catch (err) {
        console.log(`  Warning: Failed to parse VAD results: ${err.message}`);
        resolve({
          kept: chunks,
          discarded: [],
          stats: {
            total_chunks: chunks.length,
            kept_count: chunks.length,
            discarded_count: 0,
            saved_duration_s: 0,
            error: err.message
          }
        });
      }
    });

    proc.on('error', (err) => {
      console.log(`  Warning: Failed to spawn VAD process: ${err.message}`);
      resolve({
        kept: chunks,
        discarded: [],
        stats: {
          total_chunks: chunks.length,
          kept_count: chunks.length,
          discarded_count: 0,
          saved_duration_s: 0,
          error: err.message
        }
      });
    });
  });
}

// CLI usage
if (process.argv[1].includes('2.6_vad_filter')) {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const result = await checkSileroAvailable();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.available ? 0 : 1);
  }

  const chunksFile = args.find(a => !a.startsWith('--'));
  if (!chunksFile) {
    console.log('Usage: node 2.6_vad_filter.js <chunks.json> [--check]');
    console.log('');
    console.log('Filters audio chunks using Silero VAD speech detection.');
    console.log('Removes chunks without speech to speed up transcription.');
    process.exit(1);
  }

  try {
    const content = await fs.readFile(chunksFile, 'utf-8');
    const data = JSON.parse(content);
    const chunks = Array.isArray(data) ? data : data.chunks;

    const jobId = path.basename(chunksFile, '.json');
    const result = await filterWithSileroVAD(chunks, jobId);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  VAD FILTER RESULTS');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Total chunks: ${result.stats.total_chunks}`);
    console.log(`  Kept: ${result.stats.kept_count}`);
    console.log(`  Discarded: ${result.stats.discarded_count}`);
    console.log(`  Saved: ${result.stats.saved_duration_s}s of processing`);
    console.log('═══════════════════════════════════════════════════════════════');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
