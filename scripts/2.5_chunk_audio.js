import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set FFmpeg and FFprobe paths
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
if (ffprobePath.path) {
  ffmpeg.setFfprobePath(ffprobePath.path);
}

// Get number of CPU cores for parallel processing
const NUM_WORKERS = Math.max(1, os.cpus().length - 1); // Leave 1 core free

// VAD-based chunking configuration with spectral analysis
const CHUNK_CONFIG = {
  MIN_CHUNK_DURATION: 20,    // Start looking for silence after this (seconds)
  TARGET_CHUNK_DURATION: 25, // Ideal chunk duration (seconds)
  MAX_CHUNK_DURATION: 30,    // Hard cut before this to avoid whisper auto-truncation
  MIN_OUTPUT_CHUNK_DURATION: 0.5, // Skip chunks shorter than this (avoid VAD/Whisper failures)
  SAMPLE_RATE: 16000,        // For energy analysis
  WINDOW_MS: 25,             // Energy window size in ms
  ANALYSIS_WINDOW_SEC: 2.0,  // Window for speech/music classification (2 seconds)
  SILENCE_THRESHOLD_MULTIPLIER: 0.2, // Silence = energy below median * this
  MIN_SILENCE_DURATION_MS: 200,  // Minimum silence duration to consider as cut point
  MIN_SPEECH_DURATION_SEC: 3,    // Minimum speech duration to create a chunk
  MIN_NONSPEECH_GAP_SEC: 5,      // Minimum gap between speech regions to split

  // Spectral analysis for speech detection
  FFT_SIZE: 256,                 // FFT window size
  SPEECH_FREQ_LOW: 300,          // Speech formant range low (Hz)
  SPEECH_FREQ_HIGH: 3400,        // Speech formant range high (Hz)

  // Speech detection thresholds
  SPECTRAL_FLATNESS_THRESHOLD: 0.3,  // Below this = more tonal (speech/music)
  SPEECH_BAND_RATIO_THRESHOLD: 0.4,  // Speech energy concentrated in speech band
  ENERGY_MODULATION_THRESHOLD: 0.1,  // Speech has 3-6 Hz modulation

  // Combined scoring
  SPEECH_SCORE_THRESHOLD: 0.35,  // Threshold for speech classification
};

/**
 * Get audio duration in seconds
 */
function getAudioDuration(inputFile) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputFile, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

/**
 * Decode audio to raw PCM float32 mono 16kHz for energy analysis
 */
async function decodeToRawPCM(audioFile) {
  const pcmPath = audioFile.replace(/\.[^.]+$/, '_vad_temp.pcm');

  return new Promise((resolve, reject) => {
    const ffmpegProc = spawn('ffmpeg', [
      '-y',
      '-i', audioFile,
      '-ac', '1',
      '-ar', String(CHUNK_CONFIG.SAMPLE_RATE),
      '-f', 'f32le',
      pcmPath
    ]);

    let stderr = '';
    ffmpegProc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpegProc.on('close', (code) => {
      if (code === 0) {
        resolve(pcmPath);
      } else {
        reject(new Error(`ffmpeg decode failed: ${stderr}`));
      }
    });

    ffmpegProc.on('error', (err) => {
      reject(new Error(`ffmpeg error: ${err.message}`));
    });
  });
}

/**
 * Build energy profile for the audio (fast, single-threaded)
 */
function buildEnergyProfile(samples) {
  const windowSize = Math.floor(CHUNK_CONFIG.SAMPLE_RATE * CHUNK_CONFIG.WINDOW_MS / 1000);
  const hopSize = Math.floor(windowSize / 2);
  const profile = [];

  for (let i = 0; i + windowSize <= samples.length; i += hopSize) {
    let sum = 0;
    for (let j = i; j < i + windowSize; j++) {
      sum += samples[j] * samples[j];
    }
    const energy = Math.sqrt(sum / windowSize);
    const time = i / CHUNK_CONFIG.SAMPLE_RATE;
    profile.push({ time, energy });
  }

  return profile;
}

/**
 * Draw progress bar
 */
function drawProgressBar(current, total, startTime, barWidth = 30) {
  const percent = Math.min(100, Math.floor((current / total) * 100));
  const filled = Math.floor((percent / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  // Calculate ETA
  const elapsed = (Date.now() - startTime) / 1000;
  let eta = '';
  if (current > 0 && percent < 100) {
    const remaining = (elapsed / current) * (total - current);
    if (remaining < 60) {
      eta = `ETA: ${Math.ceil(remaining)}s`;
    } else {
      eta = `ETA: ${Math.floor(remaining / 60)}m ${Math.ceil(remaining % 60)}s`;
    }
  } else if (percent >= 100) {
    eta = `Done in ${elapsed.toFixed(1)}s`;
  }

  process.stdout.write(`\r    [${bar}] ${percent}% ${eta}    `);
}

/**
 * Run audio analysis in parallel using worker threads
 */
async function classifyAudioParallel(samples, energyProfile, medianEnergy) {
  const totalSamples = samples.length;
  const analysisWindowSamples = Math.floor(CHUNK_CONFIG.SAMPLE_RATE * CHUNK_CONFIG.ANALYSIS_WINDOW_SEC);
  const hopSamples = Math.floor(analysisWindowSamples / 2);

  // Calculate work distribution
  const samplesPerWorker = Math.ceil(totalSamples / NUM_WORKERS);
  const workerPromises = [];

  // Estimate total windows for progress
  const estimatedTotalWindows = Math.ceil((totalSamples - analysisWindowSamples) / hopSamples);

  console.log(`    Using ${NUM_WORKERS} worker threads for parallel analysis...`);
  console.log(`    Estimated windows to analyze: ${estimatedTotalWindows.toLocaleString()}`);

  const progressByWorker = new Map();
  const totalByWorker = new Map();
  const startTime = Date.now();
  let activeWorkers = 0;

  // Show initial progress bar immediately
  drawProgressBar(0, estimatedTotalWindows, startTime);

  // Set up periodic progress refresh (every 500ms) in case messages are batched
  const progressRefreshInterval = setInterval(() => {
    const totalProcessed = Array.from(progressByWorker.values()).reduce((a, b) => a + b, 0);
    const totalWindows = Array.from(totalByWorker.values()).reduce((a, b) => a + b, 0) || estimatedTotalWindows;
    if (totalProcessed > 0) {
      drawProgressBar(totalProcessed, totalWindows, startTime);
    }
  }, 500);

  for (let i = 0; i < NUM_WORKERS; i++) {
    const startIdx = i * samplesPerWorker;
    const endIdx = Math.min((i + 1) * samplesPerWorker + analysisWindowSamples, totalSamples);

    if (startIdx >= totalSamples) break;
    activeWorkers++;

    // Only send the slice of samples this worker needs (not the full buffer!)
    const workerSamples = samples.slice(startIdx, endIdx);
    const workerSamplesBuffer = workerSamples.buffer.slice(
      workerSamples.byteOffset,
      workerSamples.byteOffset + workerSamples.byteLength
    );

    const workerPromise = new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'workers', 'audio_analysis_worker.js'), {
        workerData: {
          samples: workerSamplesBuffer,
          startIdx: 0,  // Worker uses local indices now
          endIdx: endIdx - startIdx,
          globalOffset: startIdx,  // For calculating correct timestamps
          config: CHUNK_CONFIG,
          medianEnergy,
          workerId: i
        }
      });

      let results = [];

      worker.on('message', (msg) => {
        if (msg.type === 'started') {
          console.log(`\n    Worker ${msg.workerId} started: samples=${msg.samplesLength}, offset=${msg.globalOffset}`);
        } else if (msg.type === 'debug') {
          console.log(`    Worker ${msg.workerId}: ${msg.msg}`);
        } else if (msg.type === 'error') {
          console.error(`\n    Worker ${msg.workerId} error: ${msg.error}`);
          console.error(`    Stack: ${msg.stack}`);
        } else if (msg.type === 'progress') {
          progressByWorker.set(msg.workerId, msg.processed);
          totalByWorker.set(msg.workerId, msg.total);

          const totalProcessed = Array.from(progressByWorker.values()).reduce((a, b) => a + b, 0);
          const totalWindows = Array.from(totalByWorker.values()).reduce((a, b) => a + b, 0) || estimatedTotalWindows;

          drawProgressBar(totalProcessed, totalWindows, startTime);
        } else if (msg.type === 'done') {
          progressByWorker.set(msg.workerId, msg.processed || msg.results.length);
          totalByWorker.set(msg.workerId, msg.total || msg.results.length);
          results = msg.results;
          worker.terminate();
          resolve(results);
        }
      });

      worker.on('error', (err) => {
        console.error(`\n    Worker ${i} crashed: ${err.message}`);
        reject(err);
      });
      worker.on('exit', (code) => {
        if (code !== 0 && results.length === 0) {
          reject(new Error(`Worker ${i} exited with code ${code}`));
        }
      });
    });

    workerPromises.push(workerPromise);
  }

  // Wait for all workers to complete
  const allResults = await Promise.all(workerPromises);

  // Stop the progress refresh interval
  clearInterval(progressRefreshInterval);

  // Final progress update
  const totalProcessed = Array.from(progressByWorker.values()).reduce((a, b) => a + b, 0);
  drawProgressBar(totalProcessed, totalProcessed, startTime);
  console.log(''); // New line after progress bar

  // Merge and sort results by start time
  const classifications = allResults.flat().sort((a, b) => a.start - b.start);

  // Remove duplicates (from overlapping worker regions)
  const unique = [];
  for (const c of classifications) {
    if (unique.length === 0 || Math.abs(c.start - unique[unique.length - 1].start) > 0.01) {
      unique.push(c);
    }
  }

  return unique;
}

/**
 * Cooley-Tukey FFT for single-threaded fallback
 */
function fft(real, imag) {
  const n = real.length;
  for (let i = 0, j = 0; i < n; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let k = n >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const angleStep = -2 * Math.PI / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, angle = 0; j < halfSize; j++, angle += angleStep) {
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const idx1 = i + j, idx2 = i + j + halfSize;
        const tReal = real[idx2] * cos - imag[idx2] * sin;
        const tImag = real[idx2] * sin + imag[idx2] * cos;
        real[idx2] = real[idx1] - tReal;
        imag[idx2] = imag[idx1] - tImag;
        real[idx1] += tReal;
        imag[idx1] += tImag;
      }
    }
  }
}

function computeSpectrumSimple(samples, startIdx, fftSize) {
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const magnitudes = new Float32Array(fftSize / 2);
  for (let i = 0; i < fftSize && (startIdx + i) < samples.length; i++) {
    const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    real[i] = samples[startIdx + i] * window;
  }
  fft(real, imag);
  for (let k = 0; k < fftSize / 2; k++) {
    magnitudes[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
  }
  return magnitudes;
}

/**
 * Single-threaded fallback with spectral analysis
 */
function classifyAudioSimple(samples, energyProfile, medianEnergy) {
  const analysisWindowSamples = Math.floor(CHUNK_CONFIG.SAMPLE_RATE * CHUNK_CONFIG.ANALYSIS_WINDOW_SEC);
  const hopSamples = Math.floor(analysisWindowSamples / 2);
  const totalSamples = samples.length;
  const silenceThreshold = medianEnergy * CHUNK_CONFIG.SILENCE_THRESHOLD_MULTIPLIER;
  const fftSize = CHUNK_CONFIG.FFT_SIZE;

  // Pre-compute for fast energy lookup
  const energyHopSec = (CHUNK_CONFIG.WINDOW_MS / 2) / 1000;

  function getEnergyFrames(startTime, endTime) {
    const startIdx = Math.max(0, Math.floor(startTime / energyHopSec));
    const endIdx = Math.min(energyProfile.length - 1, Math.ceil(endTime / energyHopSec));
    const frames = [];
    for (let j = startIdx; j <= endIdx; j++) {
      if (energyProfile[j] && energyProfile[j].time >= startTime && energyProfile[j].time <= endTime) {
        frames.push(energyProfile[j]);
      }
    }
    return frames;
  }

  const classifications = [];
  let lastProgress = 0;

  console.log('    Analyzing with spectral features (single-thread fallback)...');

  for (let i = 0; i + analysisWindowSamples <= totalSamples; i += hopSamples) {
    const progress = Math.floor((i / totalSamples) * 100);
    if (progress >= lastProgress + 10) {
      process.stdout.write(`\r    Progress: ${progress}%`);
      lastProgress = progress;
    }

    const startTime = i / CHUNK_CONFIG.SAMPLE_RATE;
    const endTime = (i + analysisWindowSamples) / CHUNK_CONFIG.SAMPLE_RATE;

    const windowFrames = getEnergyFrames(startTime, endTime);
    if (windowFrames.length === 0) continue;

    const avgEnergy = windowFrames.reduce((sum, f) => sum + f.energy, 0) / windowFrames.length;

    if (avgEnergy < silenceThreshold) {
      classifications.push({
        start: startTime,
        end: endTime,
        type: 'silence',
        speechScore: 0,
        features: { avgEnergy, reason: 'low_energy' }
      });
      continue;
    }

    // Compute spectral features (3 samples per window)
    let avgFlatness = 0, avgSpeechBand = 0, avgCentroid = 0, count = 0;
    const samplePoints = [i, i + Math.floor(analysisWindowSamples / 2), i + analysisWindowSamples - fftSize];

    for (const j of samplePoints) {
      if (j >= 0 && j + fftSize <= totalSamples) {
        const spectrum = computeSpectrumSimple(samples, j, fftSize);

        // Spectral flatness
        let logSum = 0, sum = 0;
        for (let k = 1; k < spectrum.length; k++) {
          const mag = spectrum[k] + 1e-10;
          logSum += Math.log(mag);
          sum += mag;
        }
        avgFlatness += Math.exp(logSum / (spectrum.length - 1)) / (sum / (spectrum.length - 1));

        // Speech band ratio
        const binWidth = CHUNK_CONFIG.SAMPLE_RATE / fftSize;
        const lowBin = Math.floor(CHUNK_CONFIG.SPEECH_FREQ_LOW / binWidth);
        const highBin = Math.min(Math.floor(CHUNK_CONFIG.SPEECH_FREQ_HIGH / binWidth), spectrum.length - 1);
        let speechE = 0, totalE = 0;
        for (let k = 1; k < spectrum.length; k++) {
          const e = spectrum[k] * spectrum[k];
          totalE += e;
          if (k >= lowBin && k <= highBin) speechE += e;
        }
        avgSpeechBand += totalE > 0 ? speechE / totalE : 0;

        // Spectral centroid
        let weightedSum = 0, specSum = 0;
        for (let k = 1; k < spectrum.length; k++) {
          weightedSum += (k * binWidth) * spectrum[k];
          specSum += spectrum[k];
        }
        avgCentroid += specSum > 0 ? weightedSum / specSum : 0;

        count++;
      }
    }

    if (count > 0) {
      avgFlatness /= count;
      avgSpeechBand /= count;
      avgCentroid /= count;
    }

    // Energy modulation
    const energies = windowFrames.map(f => f.energy);
    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    let variation = 0;
    for (let k = 1; k < energies.length; k++) {
      variation += Math.abs(energies[k] - energies[k - 1]);
    }
    const energyMod = mean > 0 ? variation / (energies.length * mean) : 0;

    // ZCR
    let zcr = 0;
    for (let k = i + 1; k < i + analysisWindowSamples && k < totalSamples; k++) {
      if ((samples[k] >= 0) !== (samples[k - 1] >= 0)) zcr++;
    }
    zcr /= analysisWindowSamples;

    // Scoring
    let speechScore = 0;
    const reasons = [];
    if (avgFlatness < CHUNK_CONFIG.SPECTRAL_FLATNESS_THRESHOLD) { speechScore += 0.15; reasons.push('tonal'); }
    if (avgSpeechBand > CHUNK_CONFIG.SPEECH_BAND_RATIO_THRESHOLD) { speechScore += 0.25; reasons.push('speech_band'); }
    if (avgCentroid > 400 && avgCentroid < 2500) { speechScore += 0.2; reasons.push('centroid_ok'); }
    if (energyMod > CHUNK_CONFIG.ENERGY_MODULATION_THRESHOLD) { speechScore += 0.25; reasons.push('modulated'); }
    if (zcr > 0.02 && zcr < 0.15) { speechScore += 0.15; reasons.push('zcr_ok'); }

    let type;
    if (speechScore >= CHUNK_CONFIG.SPEECH_SCORE_THRESHOLD) type = 'speech';
    else if (avgFlatness < 0.2 && energyMod < 0.05) type = 'music';
    else type = 'ambiguous';

    classifications.push({
      start: startTime,
      end: endTime,
      type,
      speechScore,
      features: { avgEnergy, spectralFlatness: avgFlatness, speechBandRatio: avgSpeechBand, spectralCentroid: avgCentroid, energyModulation: energyMod, zcr, reasons }
    });
  }

  process.stdout.write('\r    Progress: 100%\n');
  return classifications;
}

/**
 * Find speech regions using spectral classification
 * More permissive - includes ambiguous regions with speech
 */
function findSpeechRegions(classifications, totalDuration) {
  if (classifications.length === 0) {
    return [{ start: 0, end: totalDuration, hasSpeech: true }];
  }

  // Log classification summary
  const speechCount = classifications.filter(c => c.type === 'speech').length;
  const musicCount = classifications.filter(c => c.type === 'music').length;
  const silenceCount = classifications.filter(c => c.type === 'silence').length;
  const ambiguousCount = classifications.filter(c => c.type === 'ambiguous').length;

  console.log(`    Classifications: ${speechCount} speech, ${musicCount} music, ${silenceCount} silence, ${ambiguousCount} ambiguous`);

  // Calculate average speech score for speech regions
  const speechScores = classifications.filter(c => c.type === 'speech').map(c => c.speechScore);
  if (speechScores.length > 0) {
    const avgScore = speechScores.reduce((a, b) => a + b, 0) / speechScores.length;
    console.log(`    Average speech score: ${avgScore.toFixed(3)}`);
  }

  const regions = [];
  let currentRegion = null;

  for (const c of classifications) {
    // Consider speech or ambiguous as "has speech" - be permissive
    const isSpeech = c.type === 'speech' || c.type === 'ambiguous';

    if (!currentRegion) {
      currentRegion = {
        start: c.start,
        end: c.end,
        hasSpeech: isSpeech,
        speechFrames: isSpeech ? 1 : 0,
        totalFrames: 1
      };
    } else if (currentRegion.hasSpeech === isSpeech) {
      currentRegion.end = c.end;
      currentRegion.totalFrames++;
      if (isSpeech) currentRegion.speechFrames++;
    } else {
      // Type changed
      const regionDuration = currentRegion.end - currentRegion.start;

      // If current region is non-speech but short, and we're now seeing speech, extend through it
      if (!currentRegion.hasSpeech && regionDuration < CHUNK_CONFIG.MIN_NONSPEECH_GAP_SEC && isSpeech) {
        currentRegion.hasSpeech = true;
        currentRegion.end = c.end;
        currentRegion.totalFrames++;
        currentRegion.speechFrames++;
      }
      // If current region has speech and we see short non-speech, extend through it
      else if (currentRegion.hasSpeech && !isSpeech) {
        // Don't close the region yet - wait to see if speech continues
        currentRegion.end = c.end;
        currentRegion.totalFrames++;
      }
      else {
        // Significant change - save current and start new
        regions.push(currentRegion);
        currentRegion = {
          start: c.start,
          end: c.end,
          hasSpeech: isSpeech,
          speechFrames: isSpeech ? 1 : 0,
          totalFrames: 1
        };
      }
    }
  }

  if (currentRegion) {
    regions.push(currentRegion);
  }

  // Merge adjacent speech regions that are close together
  const mergedRegions = [];
  for (const region of regions) {
    if (mergedRegions.length === 0) {
      mergedRegions.push(region);
    } else {
      const last = mergedRegions[mergedRegions.length - 1];
      const gap = region.start - last.end;

      // Merge if both have speech and gap is small
      if (last.hasSpeech && region.hasSpeech && gap < CHUNK_CONFIG.MIN_NONSPEECH_GAP_SEC) {
        last.end = region.end;
        last.speechFrames += region.speechFrames;
        last.totalFrames += region.totalFrames;
      }
      // Merge short non-speech gaps into speech
      else if (last.hasSpeech && !region.hasSpeech && (region.end - region.start) < CHUNK_CONFIG.MIN_NONSPEECH_GAP_SEC) {
        last.end = region.end;
      }
      // Merge if next region has speech and current non-speech is short
      else if (!last.hasSpeech && region.hasSpeech && (last.end - last.start) < CHUNK_CONFIG.MIN_NONSPEECH_GAP_SEC) {
        last.hasSpeech = true;
        last.end = region.end;
        last.speechFrames += region.speechFrames;
        last.totalFrames += region.totalFrames;
      }
      else {
        mergedRegions.push(region);
      }
    }
  }

  // Second pass: merge any remaining close speech regions
  const finalRegions = [];
  for (const region of mergedRegions) {
    if (finalRegions.length === 0) {
      finalRegions.push(region);
    } else {
      const last = finalRegions[finalRegions.length - 1];
      const gap = region.start - last.end;

      if (last.hasSpeech && region.hasSpeech && gap < CHUNK_CONFIG.MIN_NONSPEECH_GAP_SEC * 2) {
        // Merge close speech regions even with larger gap
        last.end = region.end;
      } else {
        finalRegions.push(region);
      }
    }
  }

  // Filter out very short speech regions, but keep non-speech for logging
  return finalRegions.filter(r =>
    !r.hasSpeech || (r.end - r.start) >= CHUNK_CONFIG.MIN_SPEECH_DURATION_SEC
  );
}

/**
 * Find the best silence point for cutting between minTime and maxTime
 */
function findSilenceCutPoint(energyProfile, minTime, maxTime, silenceThreshold) {
  const framesInWindow = energyProfile.filter(
    p => p.time >= minTime && p.time <= maxTime
  );

  if (framesInWindow.length === 0) {
    return maxTime;
  }

  const silenceRuns = [];
  let currentRun = null;

  for (const frame of framesInWindow) {
    if (frame.energy < silenceThreshold) {
      if (!currentRun) {
        currentRun = { start: frame.time, end: frame.time, minEnergy: frame.energy };
      } else {
        currentRun.end = frame.time;
        currentRun.minEnergy = Math.min(currentRun.minEnergy, frame.energy);
      }
    } else {
      if (currentRun) {
        const durationMs = (currentRun.end - currentRun.start) * 1000;
        if (durationMs >= CHUNK_CONFIG.MIN_SILENCE_DURATION_MS) {
          silenceRuns.push(currentRun);
        }
        currentRun = null;
      }
    }
  }

  if (currentRun) {
    const durationMs = (currentRun.end - currentRun.start) * 1000;
    if (durationMs >= CHUNK_CONFIG.MIN_SILENCE_DURATION_MS) {
      silenceRuns.push(currentRun);
    }
  }

  if (silenceRuns.length === 0) {
    // No silence found - find lowest energy point
    let minEnergyFrame = framesInWindow[0];
    for (const frame of framesInWindow) {
      if (frame.energy < minEnergyFrame.energy) {
        minEnergyFrame = frame;
      }
    }
    return minEnergyFrame.time;
  }

  // Find silence run closest to target time
  const targetTime = minTime + (CHUNK_CONFIG.TARGET_CHUNK_DURATION - CHUNK_CONFIG.MIN_CHUNK_DURATION);

  silenceRuns.sort((a, b) => {
    const midA = (a.start + a.end) / 2;
    const midB = (b.start + b.end) / 2;
    const distA = Math.abs(midA - targetTime);
    const distB = Math.abs(midB - targetTime);

    if (Math.abs(distA - distB) > 0.5) {
      return distA - distB;
    }
    return a.minEnergy - b.minEnergy;
  });

  const bestRun = silenceRuns[0];
  return (bestRun.start + bestRun.end) / 2;
}

/**
 * Calculate chunk boundaries for a content region
 */
function calculateChunkBoundariesForRegion(region, energyProfile, silenceThreshold) {
  const boundaries = [];
  let currentStart = region.start;
  const regionEnd = region.end;

  while (currentStart < regionEnd) {
    const remainingDuration = regionEnd - currentStart;

    if (remainingDuration <= CHUNK_CONFIG.MAX_CHUNK_DURATION) {
      boundaries.push({ startTime: currentStart, endTime: regionEnd });
      break;
    }

    if (remainingDuration <= CHUNK_CONFIG.MAX_CHUNK_DURATION + CHUNK_CONFIG.MIN_CHUNK_DURATION) {
      boundaries.push({ startTime: currentStart, endTime: regionEnd });
      break;
    }

    const minTime = currentStart + CHUNK_CONFIG.MIN_CHUNK_DURATION;
    const maxTime = currentStart + CHUNK_CONFIG.MAX_CHUNK_DURATION;

    const cutPoint = findSilenceCutPoint(energyProfile, minTime, maxTime, silenceThreshold);

    boundaries.push({ startTime: currentStart, endTime: cutPoint });
    currentStart = cutPoint;
  }

  return boundaries;
}

/**
 * Find extended silence regions (>= MIN_SILENCE_TO_SKIP seconds of consecutive low energy)
 * These are regions we can skip entirely - no speech there
 */
function findSilenceRegions(energyProfile, silenceThreshold, totalDuration) {
  const MIN_SILENCE_TO_SKIP = 5; // Only skip silence regions >= 5 seconds
  const regions = [];
  let silenceStart = null;

  for (const frame of energyProfile) {
    if (frame.energy < silenceThreshold) {
      if (silenceStart === null) {
        silenceStart = frame.time;
      }
    } else {
      if (silenceStart !== null) {
        const silenceDuration = frame.time - silenceStart;
        if (silenceDuration >= MIN_SILENCE_TO_SKIP) {
          regions.push({ start: silenceStart, end: frame.time, type: 'silence' });
        }
        silenceStart = null;
      }
    }
  }

  // Handle trailing silence
  if (silenceStart !== null) {
    const silenceDuration = totalDuration - silenceStart;
    if (silenceDuration >= MIN_SILENCE_TO_SKIP) {
      regions.push({ start: silenceStart, end: totalDuration, type: 'silence' });
    }
  }

  return regions;
}

/**
 * Calculate content regions (inverse of silence regions)
 */
function getContentRegions(silenceRegions, totalDuration) {
  if (silenceRegions.length === 0) {
    return [{ start: 0, end: totalDuration, hasSpeech: true }];
  }

  const contentRegions = [];
  let lastEnd = 0;

  for (const silence of silenceRegions) {
    if (silence.start > lastEnd) {
      contentRegions.push({ start: lastEnd, end: silence.start, hasSpeech: true });
    }
    lastEnd = silence.end;
  }

  if (lastEnd < totalDuration) {
    contentRegions.push({ start: lastEnd, end: totalDuration, hasSpeech: true });
  }

  return contentRegions;
}

/**
 * Analyze audio and calculate chunk boundaries using energy-based silence detection
 * Simple and fast - just skips extended silence regions
 */
async function calculateSpeechAwareChunks(audioFile, totalDuration) {
  console.log('  Analyzing audio for silence detection (energy-based)...');

  const pcmPath = await decodeToRawPCM(audioFile);
  const buffer = await fs.readFile(pcmPath);
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

  console.log(`  Samples: ${samples.length.toLocaleString()} (${(samples.length / CHUNK_CONFIG.SAMPLE_RATE / 60).toFixed(1)} min)`);

  const energyProfile = buildEnergyProfile(samples);

  const energies = energyProfile.map(p => p.energy).sort((a, b) => a - b);
  const medianEnergy = energies[Math.floor(energies.length / 2)];
  const silenceThreshold = medianEnergy * CHUNK_CONFIG.SILENCE_THRESHOLD_MULTIPLIER;

  console.log(`  Median energy: ${medianEnergy.toFixed(6)}, silence threshold: ${silenceThreshold.toFixed(6)}`);

  // Find extended silence regions to skip
  const silenceRegions = findSilenceRegions(energyProfile, silenceThreshold, totalDuration);
  const contentRegions = getContentRegions(silenceRegions, totalDuration);

  const totalSilenceDuration = silenceRegions.reduce((sum, r) => sum + (r.end - r.start), 0);
  const totalContentDuration = contentRegions.reduce((sum, r) => sum + (r.end - r.start), 0);

  console.log(`  Found ${contentRegions.length} content regions (${totalContentDuration.toFixed(1)}s total)`);
  console.log(`  Found ${silenceRegions.length} silence regions (${totalSilenceDuration.toFixed(1)}s) - will skip`);

  // Log regions
  for (const region of silenceRegions) {
    const duration = region.end - region.start;
    console.log(`    SKIP: ${region.start.toFixed(1)}s - ${region.end.toFixed(1)}s (${duration.toFixed(1)}s silence)`);
  }

  try {
    await fs.unlink(pcmPath);
  } catch (e) {}

  const allBoundaries = [];
  for (const region of contentRegions) {
    const regionBoundaries = calculateChunkBoundariesForRegion(region, energyProfile, silenceThreshold);
    allBoundaries.push(...regionBoundaries);
  }

  return {
    boundaries: allBoundaries,
    speechRegions: contentRegions,
    nonSpeechRegions: silenceRegions,
    totalSpeechDuration: totalContentDuration,
    totalNonSpeechDuration: totalSilenceDuration
  };
}

/**
 * Create a single audio chunk
 */
function createChunk(inputFile, outputFile, startTime, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .setStartTime(startTime)
      .setDuration(duration)
      .outputOptions('-c:a', 'copy')
      .on('end', () => resolve())
      .on('error', () => {
        ffmpeg(inputFile)
          .setStartTime(startTime)
          .setDuration(duration)
          .audioBitrate('320k')
          .audioChannels(2)
          .audioFrequency(48000)
          .on('end', () => resolve())
          .on('error', (err2) => reject(new Error(`Chunking error: ${err2.message}`)))
          .save(outputFile);
      })
      .save(outputFile);
  });
}

/**
 * Split audio file into chunks using speech-aware VAD with spectral analysis
 */
export async function chunkAudio(inputFile, jobId) {
  console.log(`Speech-aware audio chunking (${NUM_WORKERS} CPU cores, spectral analysis)...`);

  const totalDuration = await getAudioDuration(inputFile);
  console.log(`  Total duration: ${totalDuration.toFixed(2)}s (${(totalDuration/60).toFixed(1)} min)`);

  if (totalDuration <= CHUNK_CONFIG.MAX_CHUNK_DURATION) {
    console.log('  Audio short enough, no chunking needed');
    return [{
      file: inputFile,
      startTime: 0,
      endTime: totalDuration,
      hasSpeech: true
    }];
  }

  const {
    boundaries,
    nonSpeechRegions,
    totalSpeechDuration,
    totalNonSpeechDuration
  } = await calculateSpeechAwareChunks(inputFile, totalDuration);

  if (boundaries.length === 0) {
    console.log('  WARNING: No speech detected, processing entire file');
    return [{
      file: inputFile,
      startTime: 0,
      endTime: totalDuration,
      hasSpeech: false
    }];
  }

  const estimatedSavedRequests = Math.floor(totalNonSpeechDuration / CHUNK_CONFIG.TARGET_CHUNK_DURATION);
  console.log(`  Skipping ${totalNonSpeechDuration.toFixed(1)}s of non-speech (~${estimatedSavedRequests} fewer API calls)`);

  // Filter out chunks that are too short (would cause VAD/Whisper failures)
  const validBoundaries = boundaries.filter(({ startTime, endTime }) => {
    const duration = endTime - startTime;
    if (duration < CHUNK_CONFIG.MIN_OUTPUT_CHUNK_DURATION) {
      console.log(`  SKIP: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s (${duration.toFixed(2)}s < ${CHUNK_CONFIG.MIN_OUTPUT_CHUNK_DURATION}s minimum)`);
      return false;
    }
    return true;
  });

  const skippedCount = boundaries.length - validBoundaries.length;
  if (skippedCount > 0) {
    console.log(`  Filtered out ${skippedCount} ultra-short chunk(s)`);
  }

  console.log(`  Creating ${validBoundaries.length} chunks for ${totalSpeechDuration.toFixed(1)}s of speech...`);

  const chunks = [];
  const inputExt = path.extname(inputFile);

  for (let i = 0; i < validBoundaries.length; i++) {
    const { startTime, endTime } = validBoundaries[i];
    const duration = endTime - startTime;
    const chunkFile = path.join('./temp', `${jobId}_chunk_${i}${inputExt}`);

    await createChunk(inputFile, chunkFile, startTime, duration);

    chunks.push({
      file: chunkFile,
      startTime,
      endTime,
      hasSpeech: true
    });

    console.log(`  Chunk ${i + 1}/${validBoundaries.length}: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s (${duration.toFixed(2)}s)`);
  }

  chunks.skippedRegions = nonSpeechRegions;

  return chunks;
}

// SRT utilities
export function mergeSrtFiles(srtChunks) {
  let mergedContent = '';
  let globalCounter = 1;

  for (const chunk of srtChunks) {
    const { srt, startTime } = chunk;
    const entries = parseSrt(srt);

    for (const entry of entries) {
      mergedContent += `${globalCounter}\n`;
      mergedContent += `${adjustTimestamp(entry.startTime, startTime)} --> ${adjustTimestamp(entry.endTime, startTime)}\n`;
      mergedContent += `${entry.text}\n\n`;
      globalCounter++;
    }
  }

  return mergedContent.trim();
}

function parseSrt(srtContent) {
  const entries = [];
  const blocks = srtContent.trim().split('\n\n');

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;

    const timeLine = lines[1];
    const text = lines.slice(2).join('\n');
    const [startTime, endTime] = timeLine.split(' --> ');

    entries.push({
      startTime: startTime.trim(),
      endTime: endTime.trim(),
      text: text.trim()
    });
  }

  return entries;
}

function adjustTimestamp(timestamp, offsetSeconds) {
  const [time, ms] = timestamp.split(',');
  const [hours, minutes, seconds] = time.split(':').map(Number);

  let totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000 + parseInt(ms);
  totalMs += offsetSeconds * 1000;

  const newHours = Math.floor(totalMs / 3600000);
  totalMs %= 3600000;
  const newMinutes = Math.floor(totalMs / 60000);
  totalMs %= 60000;
  const newSeconds = Math.floor(totalMs / 1000);
  const newMs = totalMs % 1000;

  return `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}:${String(newSeconds).padStart(2, '0')},${String(newMs).padStart(3, '0')}`;
}
