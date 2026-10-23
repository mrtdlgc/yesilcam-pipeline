/**
 * Audio energy-based timestamp alignment
 * Uses raw PCM analysis for precise speech boundary detection
 *
 * Process:
 * 1. Decode audio to raw PCM (mono, 16kHz, float32)
 * 2. Compute RMS energy in 20-30ms windows
 * 3. Detect speech using energy threshold
 * 4. Snap subtitle timestamps to actual speech boundaries
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';

const SAMPLE_RATE = 16000;
const WINDOW_MS = 25;  // 25ms windows
const WINDOW_SIZE = Math.floor(SAMPLE_RATE * WINDOW_MS / 1000);  // 400 samples
const HOP_SIZE = Math.floor(WINDOW_SIZE / 2);  // 50% overlap
const PADDING_MS = 100;  // Add 100ms padding to boundaries

/**
 * Decode audio to raw PCM float32 mono 16kHz
 * @param {string} audioFile - Path to audio file
 * @returns {Promise<string>} Path to PCM file
 */
async function decodeToRawPCM(audioFile) {
  const pcmPath = audioFile.replace(/\.[^.]+$/, '_temp.pcm');

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', audioFile,
      '-ac', '1',           // mono
      '-ar', '16000',       // 16kHz
      '-f', 'f32le',        // raw float32 little-endian
      pcmPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(pcmPath);
      } else {
        reject(new Error(`ffmpeg decode failed: ${stderr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg error: ${err.message}`));
    });
  });
}

/**
 * Compute RMS energy for a frame of samples
 * @param {Float32Array} frame - Audio samples
 * @returns {number} RMS energy value
 */
function computeRMS(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Analyze audio and build energy profile
 * @param {string} pcmPath - Path to raw PCM file
 * @returns {Promise<Array<{time: number, energy: number}>>} Energy profile
 */
async function buildEnergyProfile(pcmPath) {
  const buffer = await fs.readFile(pcmPath);
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

  const profile = [];

  for (let i = 0; i + WINDOW_SIZE <= samples.length; i += HOP_SIZE) {
    const frame = samples.slice(i, i + WINDOW_SIZE);
    const energy = computeRMS(frame);
    const time = i / SAMPLE_RATE;

    profile.push({ time, energy });
  }

  return profile;
}

/**
 * Compute dynamic threshold based on energy distribution
 * @param {Array<{time: number, energy: number}>} profile - Energy profile
 * @returns {number} Speech threshold
 */
function computeThreshold(profile) {
  const energies = profile.map(p => p.energy).sort((a, b) => a - b);

  // Use median + offset for dynamic threshold
  const medianIdx = Math.floor(energies.length / 2);
  const median = energies[medianIdx];

  // Get 75th percentile for reference
  const p75Idx = Math.floor(energies.length * 0.75);
  const p75 = energies[p75Idx];

  // Threshold between median and 75th percentile
  // This works well for speech vs silence
  const threshold = median + (p75 - median) * 0.3;

  return Math.max(threshold, 0.01);  // Minimum threshold
}

/**
 * Find speech boundary by scanning from a timestamp
 * @param {Array} profile - Energy profile
 * @param {number} timestamp - Starting timestamp (seconds)
 * @param {number} threshold - Energy threshold
 * @param {string} direction - 'backward' or 'forward'
 * @param {number} maxScan - Maximum scan distance in seconds
 * @returns {number} Adjusted timestamp
 */
function findSpeechBoundary(profile, timestamp, threshold, direction, maxScan = 0.5) {
  // Find nearest profile index for timestamp
  let startIdx = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i].time >= timestamp) {
      startIdx = i;
      break;
    }
    startIdx = i;
  }

  const maxSteps = Math.floor(maxScan / (WINDOW_MS / 1000 * 0.5));  // Account for hop size

  if (direction === 'backward') {
    // Scan backward to find first speech frame
    for (let i = startIdx; i >= 0 && startIdx - i < maxSteps; i--) {
      if (profile[i].energy > threshold) {
        // Found speech, now find where it started
        let speechStart = i;
        while (speechStart > 0 && profile[speechStart - 1].energy > threshold) {
          speechStart--;
          if (startIdx - speechStart >= maxSteps) break;
        }
        return Math.max(0, profile[speechStart].time - PADDING_MS / 1000);
      }
    }
  } else {
    // Scan forward to find last speech frame
    for (let i = startIdx; i < profile.length && i - startIdx < maxSteps; i++) {
      if (profile[i].energy > threshold) {
        // Found speech, now find where it ends
        let speechEnd = i;
        while (speechEnd < profile.length - 1 && profile[speechEnd + 1].energy > threshold) {
          speechEnd++;
          if (speechEnd - startIdx >= maxSteps) break;
        }
        return profile[speechEnd].time + PADDING_MS / 1000;
      }
    }
  }

  return timestamp;  // No adjustment if no speech found
}

/**
 * Align segment timestamps to speech boundaries
 * @param {string} audioFile - Path to audio file
 * @param {Array} segments - Array of segments with start/end timestamps
 * @param {Object} options - Alignment options (unused, kept for API compatibility)
 * @returns {Promise<Array>} Aligned segments
 */
export async function alignToSpeechBoundaries(audioFile, segments, options = {}) {
  console.log('Decoding audio to raw PCM...');
  const pcmPath = await decodeToRawPCM(audioFile);

  console.log('Building energy profile (25ms windows)...');
  const profile = await buildEnergyProfile(pcmPath);
  console.log(`  ${profile.length} energy frames computed`);

  const threshold = computeThreshold(profile);
  console.log(`  Dynamic threshold: ${threshold.toFixed(4)}`);

  // Clean up temp PCM file
  try {
    await fs.unlink(pcmPath);
  } catch (e) {
    // Ignore cleanup errors
  }

  if (profile.length === 0) {
    console.log('No audio data, keeping original timestamps');
    return segments;
  }

  let adjustedCount = 0;

  const aligned = segments.map((seg, i) => {
    const originalStart = seg.start;
    const originalEnd = seg.end;

    // Scan backward from start to find actual speech beginning
    const newStart = findSpeechBoundary(profile, originalStart, threshold, 'backward');

    // Scan forward from end to find actual speech ending
    const newEnd = findSpeechBoundary(profile, originalEnd, threshold, 'forward');

    // Ensure valid duration (at least 0.2s)
    let finalStart = newStart;
    let finalEnd = newEnd;

    if (finalEnd - finalStart < 0.2) {
      finalEnd = finalStart + 0.2;
    }

    // Ensure we don't overlap with next segment
    if (i < segments.length - 1) {
      const nextStart = segments[i + 1].start;
      if (finalEnd > nextStart - 0.05) {
        finalEnd = nextStart - 0.05;
      }
    }

    const wasAdjusted = Math.abs(finalStart - originalStart) > 0.01 ||
                        Math.abs(finalEnd - originalEnd) > 0.01;
    if (wasAdjusted) adjustedCount++;

    return {
      ...seg,
      start: finalStart,
      end: finalEnd
    };
  });

  console.log(`Aligned ${adjustedCount}/${segments.length} segments to speech boundaries`);

  return aligned;
}

/**
 * Standalone function to detect silence periods (for compatibility)
 * Returns silence periods based on energy analysis
 */
export async function detectSilence(audioFile, noiseThreshold = -30, minSilenceDuration = 0.3) {
  const pcmPath = await decodeToRawPCM(audioFile);
  const profile = await buildEnergyProfile(pcmPath);
  const threshold = computeThreshold(profile);

  // Clean up
  try {
    await fs.unlink(pcmPath);
  } catch (e) {}

  // Find silence periods
  const silences = [];
  let silenceStart = null;

  for (let i = 0; i < profile.length; i++) {
    const isSilent = profile[i].energy < threshold;

    if (isSilent && silenceStart === null) {
      silenceStart = profile[i].time;
    } else if (!isSilent && silenceStart !== null) {
      const duration = profile[i].time - silenceStart;
      if (duration >= minSilenceDuration) {
        silences.push({
          start: silenceStart,
          end: profile[i].time
        });
      }
      silenceStart = null;
    }
  }

  return silences;
}

// CLI usage
if (process.argv[1].includes('3.5_align_energy')) {
  const [,, audioFile] = process.argv;

  if (!audioFile) {
    console.log('Usage: node 3.5_align_energy.js <audio_file>');
    console.log('');
    console.log('Analyzes audio energy profile for speech detection.');
    process.exit(1);
  }

  console.log(`Analyzing: ${audioFile}`);

  const pcmPath = await decodeToRawPCM(audioFile);
  const profile = await buildEnergyProfile(pcmPath);
  const threshold = computeThreshold(profile);

  console.log('');
  console.log(`Total frames: ${profile.length}`);
  console.log(`Duration: ${(profile[profile.length - 1]?.time || 0).toFixed(2)}s`);
  console.log(`Threshold: ${threshold.toFixed(4)}`);

  // Count speech vs silence
  const speechFrames = profile.filter(p => p.energy > threshold).length;
  const speechPercent = (speechFrames / profile.length * 100).toFixed(1);
  console.log(`Speech: ${speechPercent}% of audio`);

  // Clean up
  await fs.unlink(pcmPath);
}
