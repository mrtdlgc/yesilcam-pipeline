/**
 * Silero VAD-based timestamp alignment
 * Uses neural speech probabilities instead of raw energy for precise alignment.
 *
 * Benefits over energy-based:
 * - Specifically detects human speech, not music/noise
 * - No "hovering" subtitles during music sections
 * - More accurate speech boundaries
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const PADDING_MS = 80;  // Padding around speech boundaries

// Hysteresis thresholds to avoid triggering on coughs/laughs
const P_START = 0.6;    // Probability to START considering speech
const P_DROP = 0.4;     // Probability below which speech ENDS
const T_CONFIRM_MS = 300;  // Minimum duration (ms) to confirm as actual speech

// Cache for speech profile (avoid re-computing for same audio)
let cachedProfile = null;
let cachedAudioFile = null;

/**
 * Check if Silero alignment is available
 */
export async function checkSileroAlignmentAvailable() {
  try {
    const pythonScript = path.join(__dirname, '3.5_align_silero.py');
    const result = execSync(`${PYTHON_CMD} "${pythonScript}" --check`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const info = JSON.parse(result.trim());
    return info.installed === true;
  } catch (err) {
    return false;
  }
}

/**
 * Generate speech probability profile using Silero VAD
 * @param {string} audioFile - Path to audio file
 * @returns {Promise<Array<{time: number, prob: number}>>}
 */
async function generateSpeechProfile(audioFile) {
  // Return cached profile if same audio file
  if (cachedProfile && cachedAudioFile === audioFile) {
    console.log('  Using cached speech profile');
    return cachedProfile;
  }

  const pythonScript = path.join(__dirname, '3.5_align_silero.py');
  const tempOutput = audioFile.replace(/\.[^.]+$/, '_speech_profile.json');

  return new Promise((resolve, reject) => {
    console.log('Generating speech probability profile with Silero VAD...');

    const proc = spawn(PYTHON_CMD, [
      pythonScript,
      audioFile,
      '--output', tempOutput
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8'
      }
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      const line = data.toString();
      stderr += line;
      process.stderr.write('  ' + line);
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Silero profile generation failed: ${stderr}`));
        return;
      }

      try {
        const content = await fs.readFile(tempOutput, 'utf-8');
        const result = JSON.parse(content);

        // Clean up temp file
        try { await fs.unlink(tempOutput); } catch (e) {}

        // Cache the profile
        cachedProfile = result.profile;
        cachedAudioFile = audioFile;

        resolve(result.profile);
      } catch (err) {
        reject(new Error(`Failed to parse speech profile: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Silero process: ${err.message}`));
    });
  });
}

/**
 * Find speech probability at a given timestamp
 * @param {Array} profile - Speech probability profile
 * @param {number} timestamp - Time in seconds
 * @returns {number} Speech probability (0-1)
 */
function getProbabilityAt(profile, timestamp) {
  // Binary search for nearest frame
  let low = 0;
  let high = profile.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (profile[mid].time < timestamp) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  // Return probability at nearest frame
  if (low > 0 && Math.abs(profile[low - 1].time - timestamp) < Math.abs(profile[low].time - timestamp)) {
    return profile[low - 1].prob;
  }
  return profile[low]?.prob ?? 0;
}

/**
 * Check if a speech region is confirmed (lasts at least T_CONFIRM_MS)
 * This filters out coughs, laughs, and other transient sounds
 */
function isSpeechConfirmed(profile, startIdx, direction, frameTime) {
  const confirmFrames = Math.ceil((T_CONFIRM_MS / 1000) / frameTime);
  let consecutiveHigh = 0;

  if (direction === 'forward') {
    for (let i = startIdx; i < profile.length && i - startIdx < confirmFrames * 2; i++) {
      if (profile[i].prob >= P_DROP) {
        consecutiveHigh++;
        if (consecutiveHigh >= confirmFrames) return true;
      } else {
        consecutiveHigh = 0;
      }
    }
  } else {
    for (let i = startIdx; i >= 0 && startIdx - i < confirmFrames * 2; i--) {
      if (profile[i].prob >= P_DROP) {
        consecutiveHigh++;
        if (consecutiveHigh >= confirmFrames) return true;
      } else {
        consecutiveHigh = 0;
      }
    }
  }

  return false;
}

/**
 * Find speech boundary by scanning from a timestamp
 * Uses hysteresis (P_START/P_DROP) and confirmation time to avoid
 * triggering on transient sounds like coughs and laughs
 */
function findSpeechBoundary(profile, timestamp, threshold, direction, maxScan = 0.5) {
  // Find starting index
  let startIdx = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i].time >= timestamp) {
      startIdx = i;
      break;
    }
    startIdx = i;
  }

  // Calculate max steps based on frame rate (~62.5 fps with 512 samples, 256 hop at 16kHz)
  const frameTime = profile.length > 1 ? profile[1].time - profile[0].time : 0.016;
  const maxSteps = Math.floor(maxScan / frameTime);

  if (direction === 'backward') {
    // Scan backward to find where speech starts
    // Use P_START threshold - need higher confidence to START speech
    for (let i = startIdx; i >= 0 && startIdx - i < maxSteps; i--) {
      if (profile[i].prob >= P_START) {
        // Check if this is confirmed speech (not just a cough)
        if (!isSpeechConfirmed(profile, i, 'forward', frameTime)) {
          continue;  // Skip transient sounds
        }

        // Found confirmed speech, find where it actually started using P_DROP
        // (hysteresis: we started at P_START but trace back to P_DROP)
        let speechStart = i;
        while (speechStart > 0 && profile[speechStart - 1].prob >= P_DROP) {
          speechStart--;
          if (startIdx - speechStart >= maxSteps) break;
        }
        return Math.max(0, profile[speechStart].time - PADDING_MS / 1000);
      }
    }
  } else {
    // Scan forward to find where speech ends
    for (let i = startIdx; i < profile.length && i - startIdx < maxSteps; i++) {
      if (profile[i].prob >= P_START) {
        // Check if this is confirmed speech
        if (!isSpeechConfirmed(profile, i, 'forward', frameTime)) {
          continue;  // Skip transient sounds
        }

        // Found confirmed speech, find where it ends using P_DROP
        // (hysteresis: speech continues until prob drops below P_DROP)
        let speechEnd = i;
        while (speechEnd < profile.length - 1 && profile[speechEnd + 1].prob >= P_DROP) {
          speechEnd++;
          if (speechEnd - startIdx >= maxSteps) break;
        }
        return profile[speechEnd].time + PADDING_MS / 1000;
      }
    }
  }

  return timestamp;  // No adjustment if no confirmed speech found
}

/**
 * Align segment timestamps to speech boundaries using Silero VAD
 * @param {string} audioFile - Path to audio file
 * @param {Array} segments - Array of segments with start/end timestamps
 * @param {Object} options - Alignment options
 * @returns {Promise<Array>} Aligned segments
 */
export async function alignToSpeechBoundaries(audioFile, segments, options = {}) {
  // Note: options.threshold is ignored - we use P_START/P_DROP hysteresis instead

  // Check availability
  const available = await checkSileroAlignmentAvailable();
  if (!available) {
    console.log('Silero VAD not available, falling back to energy-based alignment');
    // Import and use energy-based alignment as fallback
    const { alignToSpeechBoundaries: energyAlign } = await import('./3.5_align_energy.js');
    return energyAlign(audioFile, segments, options);
  }

  // Generate speech probability profile
  const profile = await generateSpeechProfile(audioFile);

  if (profile.length === 0) {
    console.log('No speech profile data, keeping original timestamps');
    return segments;
  }

  console.log(`Aligning ${segments.length} segments using speech probabilities...`);
  console.log(`  Profile: ${profile.length} frames, P_start=${P_START}, P_drop=${P_DROP}, T_confirm=${T_CONFIRM_MS}ms`);

  let adjustedCount = 0;
  let speechFoundCount = 0;

  const aligned = segments.map((seg, i) => {
    const originalStart = seg.start;
    const originalEnd = seg.end;

    // Check if there's any speech in this segment's vicinity
    const midPoint = (originalStart + originalEnd) / 2;
    const midProb = getProbabilityAt(profile, midPoint);

    // Find actual speech boundaries
    const newStart = findSpeechBoundary(profile, originalStart, P_START, 'backward');
    const newEnd = findSpeechBoundary(profile, originalEnd, P_START, 'forward');

    // Ensure valid duration
    let finalStart = newStart;
    let finalEnd = newEnd;

    if (finalEnd - finalStart < 0.2) {
      finalEnd = finalStart + 0.2;
    }

    // Prevent overlap with next segment
    if (i < segments.length - 1) {
      const nextStart = segments[i + 1].start;
      if (finalEnd > nextStart - 0.05) {
        finalEnd = nextStart - 0.05;
      }
    }

    const wasAdjusted = Math.abs(finalStart - originalStart) > 0.01 ||
                        Math.abs(finalEnd - originalEnd) > 0.01;
    if (wasAdjusted) adjustedCount++;
    if (midProb >= P_START) speechFoundCount++;

    return {
      ...seg,
      start: finalStart,
      end: finalEnd,
      _alignment: {
        method: 'silero_vad',
        speech_prob: midProb,
        adjusted: wasAdjusted
      }
    };
  });

  console.log(`  Adjusted: ${adjustedCount}/${segments.length} segments`);
  console.log(`  Speech detected: ${speechFoundCount}/${segments.length} segments`);

  return aligned;
}

// CLI usage
if (process.argv[1].includes('3.5_align_silero')) {
  const [,, audioFile] = process.argv;

  if (!audioFile) {
    console.log('Usage: node 3.5_align_silero.js <audio_file>');
    console.log('');
    console.log('Generates speech probability profile using Silero VAD.');
    process.exit(1);
  }

  const available = await checkSileroAlignmentAvailable();
  console.log(`Silero VAD available: ${available}`);

  if (available) {
    const profile = await generateSpeechProfile(audioFile);
    console.log(`\nProfile generated: ${profile.length} frames`);

    // Show sample
    const duration = profile[profile.length - 1]?.time || 0;
    console.log(`Duration: ${duration.toFixed(2)}s`);

    const speechFrames = profile.filter(p => p.prob > 0.5).length;
    console.log(`Speech: ${(speechFrames / profile.length * 100).toFixed(1)}%`);
  }
}
