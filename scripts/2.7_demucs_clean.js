/**
 * Demucs Audio Cleaning - Node.js wrapper
 * Uses Demucs to extract vocals and remove background music/noise
 *
 * This improves Whisper transcription accuracy for films with heavy soundtracks.
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
let demucsAvailable = null;

/**
 * Check if Demucs is available
 * @returns {Promise<{available: boolean, version: string, cuda: boolean}>}
 */
export async function checkDemucsAvailable() {
  if (demucsAvailable !== null) {
    return demucsAvailable;
  }

  try {
    const pythonScript = path.join(__dirname, '2.7_demucs_clean.py');
    const result = execSync(`${PYTHON_CMD} "${pythonScript}" --check`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const info = JSON.parse(result.trim());
    demucsAvailable = {
      available: info.installed === true && info.errors.length === 0,
      version: info.version,
      cuda: info.cuda_available,
      details: info
    };

    if (demucsAvailable.available) {
      console.log(`  Demucs available (v${info.version}, ${info.cuda_available ? 'CUDA' : 'CPU'})`);
    }

    return demucsAvailable;
  } catch (err) {
    demucsAvailable = {
      available: false,
      version: null,
      cuda: false,
      details: { error: err.message }
    };
    return demucsAvailable;
  }
}

/**
 * Clean audio chunks using Demucs
 *
 * @param {Array} chunks - Array of chunk objects from VAD filter
 * @param {string} jobId - Job ID for output directory
 * @param {Object} options - Processing options
 * @returns {Promise<Array>} - Chunks with cleaned audio paths
 */
export async function cleanWithDemucs(chunks, jobId, options = {}) {
  // Check if Demucs is enabled
  if (!config.DEMUCS_ENABLED) {
    console.log('  Demucs cleaning disabled in config, using original audio');
    return chunks;
  }

  // Check availability
  const availability = await checkDemucsAvailable();
  if (!availability.available) {
    console.log('  Demucs not available, using original audio');
    console.log(`    Reason: ${JSON.stringify(availability.details)}`);
    return chunks;
  }

  console.log('Cleaning audio with Demucs...');

  // Prepare directories
  const tempDir = './temp';
  const demucsDir = path.join(tempDir, `${jobId}_demucs`);
  await fs.mkdir(demucsDir, { recursive: true });

  const inputFile = path.join(tempDir, `${jobId}_demucs_input.json`);

  // Write chunks to temp file
  await fs.writeFile(inputFile, JSON.stringify({ chunks }), 'utf-8');

  // Get settings from config
  const model = options.model ?? config.DEMUCS_MODEL ?? 'htdemucs_ft';
  const device = options.device ?? config.DEMUCS_DEVICE ?? 'cpu';
  const shifts = options.shifts ?? config.DEMUCS_SHIFTS ?? 1;

  // Use CUDA if available and configured
  const effectiveDevice = (device === 'cuda' && availability.cuda) ? 'cuda' : 'cpu';

  const pythonScript = path.join(__dirname, '2.7_demucs_clean.py');

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, [
      pythonScript,
      '--batch', inputFile,
      '--output', demucsDir,
      '--model', model,
      '--device', effectiveDevice,
      '--shifts', String(shifts)
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
        console.log(`  Warning: Demucs failed (code ${code}), using original audio`);
        resolve(chunks);
        return;
      }

      try {
        // Parse result from stdout (last JSON line)
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const result = JSON.parse(lastLine);

        if (result.chunks) {
          console.log(`  Demucs complete: ${result.stats.success}/${result.stats.total} chunks cleaned`);
          resolve(result.chunks);
        } else {
          console.log('  Warning: Invalid Demucs result, using original audio');
          resolve(chunks);
        }
      } catch (err) {
        console.log(`  Warning: Failed to parse Demucs results: ${err.message}`);
        resolve(chunks);
      }
    });

    proc.on('error', (err) => {
      console.log(`  Warning: Failed to spawn Demucs process: ${err.message}`);
      resolve(chunks);
    });
  });
}

/**
 * Clean a single audio file using Demucs
 *
 * @param {string} audioFile - Path to audio file
 * @param {string} outputDir - Output directory
 * @param {Object} options - Processing options
 * @returns {Promise<string|null>} - Path to cleaned audio or null on failure
 */
export async function cleanSingleFile(audioFile, outputDir, options = {}) {
  const availability = await checkDemucsAvailable();
  if (!availability.available) {
    return null;
  }

  const model = options.model ?? config.DEMUCS_MODEL ?? 'htdemucs_ft';
  const device = options.device ?? config.DEMUCS_DEVICE ?? 'cpu';
  const shifts = options.shifts ?? config.DEMUCS_SHIFTS ?? 1;

  const effectiveDevice = (device === 'cuda' && availability.cuda) ? 'cuda' : 'cpu';

  const pythonScript = path.join(__dirname, '2.7_demucs_clean.py');

  return new Promise((resolve) => {
    const proc = spawn(PYTHON_CMD, [
      pythonScript,
      audioFile,
      '--output', outputDir,
      '--model', model,
      '--device', effectiveDevice,
      '--shifts', String(shifts)
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      process.stderr.write(data.toString());
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.success && result.output) {
          resolve(result.output);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

// CLI usage
if (process.argv[1].includes('2.7_demucs_clean')) {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const result = await checkDemucsAvailable();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.available ? 0 : 1);
  }

  const audioFile = args.find(a => !a.startsWith('--'));
  if (!audioFile) {
    console.log('Usage: node 2.7_demucs_clean.js <audio_file> [--check]');
    console.log('');
    console.log('Extracts vocals from audio using Demucs.');
    console.log('Removes background music and noise for cleaner transcription.');
    process.exit(1);
  }

  const outputDir = './temp/demucs_test';
  const result = await cleanSingleFile(audioFile, outputDir);

  if (result) {
    console.log(`Cleaned audio saved to: ${result}`);
  } else {
    console.log('Failed to clean audio');
    process.exit(1);
  }
}
