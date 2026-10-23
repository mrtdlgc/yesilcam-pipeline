/**
 * Speech Detection Test Script
 *
 * Run this to test speech/music/silence classification on an audio file
 * WITHOUT making any API calls or creating chunk files.
 *
 * Usage:
 *   node scripts/test_speech_detection.js <audio_file> [--verbose] [--save-report]
 */

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

// Set FFmpeg paths
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath.path) ffmpeg.setFfprobePath(ffprobePath.path);

// Get CPU count
const NUM_WORKERS = Math.max(1, os.cpus().length - 1);

// Configuration (same as 2.5_chunk_audio.js)
const CONFIG = {
  SAMPLE_RATE: 16000,
  WINDOW_MS: 25,
  ANALYSIS_WINDOW_SEC: 2.0,
  SILENCE_THRESHOLD_MULTIPLIER: 0.2,
  MIN_SPEECH_DURATION_SEC: 3,
  MIN_NONSPEECH_GAP_SEC: 5,
  MIN_CHUNK_DURATION: 20,
  TARGET_CHUNK_DURATION: 25,
  MAX_CHUNK_DURATION: 30,
  FFT_SIZE: 256,
  SPEECH_FREQ_LOW: 300,
  SPEECH_FREQ_HIGH: 3400,
  SPECTRAL_FLATNESS_THRESHOLD: 0.3,
  SPEECH_BAND_RATIO_THRESHOLD: 0.4,
  ENERGY_MODULATION_THRESHOLD: 0.1,
  SPEECH_SCORE_THRESHOLD: 0.35,
};

// Parse command line args
const args = process.argv.slice(2);
const audioFile = args.find(a => !a.startsWith('--'));
const verbose = args.includes('--verbose') || args.includes('-v');
const saveReport = args.includes('--save-report') || args.includes('-s');

if (!audioFile) {
  console.log(`
Speech Detection Test (Spectral Analysis)
==========================================

Tests speech/music/silence classification without making API calls.
Uses ${NUM_WORKERS} CPU cores for parallel spectral analysis.

Usage:
  node scripts/test_speech_detection.js <audio_file> [options]

Options:
  --verbose, -v      Show detailed per-window classification
  --save-report, -s  Save detailed JSON report to output folder

Examples:
  node scripts/test_speech_detection.js temp/abc123_raw.mp3
  node scripts/test_speech_detection.js "temp/my file.mp3" --verbose
`);
  process.exit(1);
}

// Helper functions
function getAudioDuration(inputFile) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputFile, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

async function decodeToRawPCM(audioFile) {
  const pcmPath = audioFile.replace(/\.[^.]+$/, '_test_temp.pcm');

  return new Promise((resolve, reject) => {
    const ffmpegProc = spawn('ffmpeg', [
      '-y', '-i', audioFile,
      '-ac', '1',
      '-ar', String(CONFIG.SAMPLE_RATE),
      '-f', 'f32le',
      pcmPath
    ]);

    let stderr = '';
    ffmpegProc.stderr.on('data', (data) => stderr += data.toString());
    ffmpegProc.on('close', (code) => {
      if (code === 0) resolve(pcmPath);
      else reject(new Error(`ffmpeg failed: ${stderr}`));
    });
    ffmpegProc.on('error', (err) => reject(err));
  });
}

function buildEnergyProfile(samples) {
  const windowSize = Math.floor(CONFIG.SAMPLE_RATE * CONFIG.WINDOW_MS / 1000);
  const hopSize = Math.floor(windowSize / 2);
  const profile = [];

  for (let i = 0; i + windowSize <= samples.length; i += hopSize) {
    let sum = 0;
    for (let j = i; j < i + windowSize; j++) {
      sum += samples[j] * samples[j];
    }
    profile.push({
      time: i / CONFIG.SAMPLE_RATE,
      energy: Math.sqrt(sum / windowSize)
    });
  }
  return profile;
}

// Draw progress bar
function drawProgressBar(current, total, startTime, barWidth = 30) {
  const percent = Math.min(100, Math.floor((current / total) * 100));
  const filled = Math.floor((percent / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

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

  process.stdout.write(`\r  [${bar}] ${percent}% ${eta}    `);
}

// Parallel classification using workers
async function classifyAudioParallel(samples, medianEnergy) {
  const totalSamples = samples.length;
  const analysisWindowSamples = Math.floor(CONFIG.SAMPLE_RATE * CONFIG.ANALYSIS_WINDOW_SEC);
  const hopSamples = Math.floor(analysisWindowSamples / 2);
  const samplesPerWorker = Math.ceil(totalSamples / NUM_WORKERS);
  const workerPromises = [];

  const estimatedTotalWindows = Math.ceil((totalSamples - analysisWindowSamples) / hopSamples);

  console.log(`  Using ${NUM_WORKERS} worker threads for spectral analysis...`);
  console.log(`  Estimated windows: ${estimatedTotalWindows.toLocaleString()}`);

  const progressByWorker = new Map();
  const totalByWorker = new Map();
  const startTime = Date.now();

  // Show initial progress bar immediately
  drawProgressBar(0, estimatedTotalWindows, startTime);

  // Set up periodic progress refresh (every 500ms) in case messages are batched
  const progressInterval = setInterval(() => {
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

    // Only send the slice of samples this worker needs (not the full 346MB buffer!)
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
          config: CONFIG,
          medianEnergy,
          workerId: i
        }
      });

      let results = [];

      worker.on('message', (msg) => {
        if (msg.type === 'started') {
          console.log(`\n  Worker ${msg.workerId} started: samples=${msg.samplesLength}, offset=${msg.globalOffset}`);
        } else if (msg.type === 'debug') {
          console.log(`  Worker ${msg.workerId}: ${msg.msg}`);
        } else if (msg.type === 'error') {
          console.error(`\n  Worker ${msg.workerId} error: ${msg.error}`);
          console.error(`  Stack: ${msg.stack}`);
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
        console.error(`\n  Worker ${i} crashed: ${err.message}`);
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

  const allResults = await Promise.all(workerPromises);

  // Stop the progress refresh interval
  clearInterval(progressInterval);

  // Final progress
  const totalProcessed = Array.from(progressByWorker.values()).reduce((a, b) => a + b, 0);
  drawProgressBar(totalProcessed, totalProcessed, startTime);
  console.log(''); // New line after progress bar

  const classifications = allResults.flat().sort((a, b) => a.start - b.start);

  // Remove duplicates
  const unique = [];
  for (const c of classifications) {
    if (unique.length === 0 || Math.abs(c.start - unique[unique.length - 1].start) > 0.01) {
      unique.push(c);
    }
  }

  return unique;
}

function findSpeechRegions(classifications, totalDuration) {
  if (classifications.length === 0) {
    return [{ start: 0, end: totalDuration, hasSpeech: true }];
  }

  const regions = [];
  let currentRegion = null;

  for (const c of classifications) {
    const isSpeech = c.type === 'speech' || c.type === 'ambiguous';

    if (!currentRegion) {
      currentRegion = { start: c.start, end: c.end, hasSpeech: isSpeech, frameCount: 1 };
    } else if (currentRegion.hasSpeech === isSpeech) {
      currentRegion.end = c.end;
      currentRegion.frameCount++;
    } else {
      const regionDuration = currentRegion.end - currentRegion.start;

      if (!currentRegion.hasSpeech && regionDuration < CONFIG.MIN_NONSPEECH_GAP_SEC && isSpeech) {
        currentRegion.hasSpeech = true;
        currentRegion.end = c.end;
        currentRegion.frameCount++;
      } else if (currentRegion.hasSpeech && !isSpeech) {
        currentRegion.end = c.end;
        currentRegion.frameCount++;
      } else {
        regions.push(currentRegion);
        currentRegion = { start: c.start, end: c.end, hasSpeech: isSpeech, frameCount: 1 };
      }
    }
  }

  if (currentRegion) regions.push(currentRegion);

  // Merge close speech regions
  const mergedRegions = [];
  for (const region of regions) {
    if (mergedRegions.length === 0) {
      mergedRegions.push(region);
    } else {
      const last = mergedRegions[mergedRegions.length - 1];
      const gap = region.start - last.end;

      if (last.hasSpeech && region.hasSpeech && gap < CONFIG.MIN_NONSPEECH_GAP_SEC) {
        last.end = region.end;
      } else if (last.hasSpeech && !region.hasSpeech && (region.end - region.start) < CONFIG.MIN_NONSPEECH_GAP_SEC) {
        last.end = region.end;
      } else if (!last.hasSpeech && region.hasSpeech && (last.end - last.start) < CONFIG.MIN_NONSPEECH_GAP_SEC) {
        last.hasSpeech = true;
        last.end = region.end;
      } else {
        mergedRegions.push(region);
      }
    }
  }

  // Second pass merge
  const finalRegions = [];
  for (const region of mergedRegions) {
    if (finalRegions.length === 0) {
      finalRegions.push(region);
    } else {
      const last = finalRegions[finalRegions.length - 1];
      const gap = region.start - last.end;

      if (last.hasSpeech && region.hasSpeech && gap < CONFIG.MIN_NONSPEECH_GAP_SEC * 2) {
        last.end = region.end;
      } else {
        finalRegions.push(region);
      }
    }
  }

  return finalRegions.filter(r => !r.hasSpeech || (r.end - r.start) >= CONFIG.MIN_SPEECH_DURATION_SEC);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Main test function
async function runTest() {
  console.log('');
  console.log('=========================================');
  console.log('  SPEECH DETECTION TEST (SPECTRAL)');
  console.log('=========================================');
  console.log(`  File: ${audioFile}`);
  console.log(`  CPU cores: ${NUM_WORKERS}`);
  console.log('');

  // Check file exists
  try {
    await fs.access(audioFile);
  } catch {
    console.error(`ERROR: File not found: ${audioFile}`);
    process.exit(1);
  }

  // Get duration
  console.log('Getting audio info...');
  const totalDuration = await getAudioDuration(audioFile);
  console.log(`  Duration: ${formatTime(totalDuration)} (${totalDuration.toFixed(2)}s)`);
  console.log('');

  // Decode to PCM
  console.log('Decoding audio to PCM...');
  const pcmPath = await decodeToRawPCM(audioFile);
  const buffer = await fs.readFile(pcmPath);
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  console.log(`  Samples: ${samples.length.toLocaleString()}`);
  console.log('');

  // Build energy profile
  console.log('Building energy profile...');
  const energyProfile = buildEnergyProfile(samples);
  const energies = energyProfile.map(p => p.energy).sort((a, b) => a - b);
  const medianEnergy = energies[Math.floor(energies.length / 2)];
  const silenceThreshold = medianEnergy * CONFIG.SILENCE_THRESHOLD_MULTIPLIER;

  console.log(`  Frames: ${energyProfile.length.toLocaleString()}`);
  console.log(`  Median energy: ${medianEnergy.toFixed(6)}`);
  console.log(`  Silence threshold: ${silenceThreshold.toFixed(6)}`);
  console.log('');

  // Classify regions
  console.log('Classifying audio regions (spectral analysis)...');
  let classifications;
  try {
    classifications = await classifyAudioParallel(samples, medianEnergy);
  } catch (err) {
    console.error(`  Worker error: ${err.message}`);
    process.exit(1);
  }

  const speechCount = classifications.filter(c => c.type === 'speech').length;
  const musicCount = classifications.filter(c => c.type === 'music').length;
  const silenceCount = classifications.filter(c => c.type === 'silence').length;
  const ambiguousCount = classifications.filter(c => c.type === 'ambiguous').length;

  console.log('');
  console.log('-----------------------------------------');
  console.log('  CLASSIFICATION RESULTS');
  console.log('-----------------------------------------');
  console.log(`  Total windows: ${classifications.length}`);
  console.log(`  Speech:    ${speechCount} (${(speechCount/classifications.length*100).toFixed(1)}%)`);
  console.log(`  Music:     ${musicCount} (${(musicCount/classifications.length*100).toFixed(1)}%)`);
  console.log(`  Silence:   ${silenceCount} (${(silenceCount/classifications.length*100).toFixed(1)}%)`);
  console.log(`  Ambiguous: ${ambiguousCount} (${(ambiguousCount/classifications.length*100).toFixed(1)}%)`);

  // Average scores
  const speechScores = classifications.filter(c => c.type === 'speech').map(c => c.speechScore);
  if (speechScores.length > 0) {
    console.log(`  Avg speech score: ${(speechScores.reduce((a,b)=>a+b,0)/speechScores.length).toFixed(3)}`);
  }

  // Verbose: show each window
  if (verbose) {
    console.log('');
    console.log('-----------------------------------------');
    console.log('  DETAILED CLASSIFICATIONS (first 50)');
    console.log('-----------------------------------------');

    for (const c of classifications.slice(0, 50)) {
      const time = `${formatTime(c.start)}-${formatTime(c.end)}`;
      const score = c.speechScore?.toFixed(2) || '0.00';
      const reasons = c.features?.reasons?.join(',') || '-';
      const type = c.type.padEnd(9);
      console.log(`  ${time} | ${type} | score=${score} | ${reasons}`);
    }

    if (classifications.length > 50) {
      console.log(`  ... and ${classifications.length - 50} more`);
    }
  }

  // Find speech regions
  console.log('');
  console.log('Finding speech regions...');
  const regions = findSpeechRegions(classifications, totalDuration);

  const speechRegions = regions.filter(r => r.hasSpeech);
  const nonSpeechRegions = regions.filter(r => !r.hasSpeech);
  const totalSpeechDuration = speechRegions.reduce((sum, r) => sum + (r.end - r.start), 0);
  const totalNonSpeechDuration = nonSpeechRegions.reduce((sum, r) => sum + (r.end - r.start), 0);

  console.log('');
  console.log('-----------------------------------------');
  console.log('  SPEECH REGIONS');
  console.log('-----------------------------------------');
  console.log(`  Speech regions: ${speechRegions.length}`);
  console.log(`  Non-speech regions: ${nonSpeechRegions.length}`);
  console.log(`  Total speech: ${formatTime(totalSpeechDuration)} (${totalSpeechDuration.toFixed(1)}s)`);
  console.log(`  Total non-speech: ${formatTime(totalNonSpeechDuration)} (${totalNonSpeechDuration.toFixed(1)}s)`);
  console.log(`  Speech percentage: ${(totalSpeechDuration/totalDuration*100).toFixed(1)}%`);
  console.log('');

  for (const region of regions) {
    const duration = region.end - region.start;
    const type = region.hasSpeech ? 'SPEECH' : 'SKIP  ';
    console.log(`  ${type}: ${formatTime(region.start)} - ${formatTime(region.end)} (${duration.toFixed(1)}s)`);
  }

  // Estimate chunks
  console.log('');
  console.log('-----------------------------------------');
  console.log('  CHUNK ESTIMATION');
  console.log('-----------------------------------------');

  let estimatedChunks = 0;
  for (const region of speechRegions) {
    const duration = region.end - region.start;
    estimatedChunks += Math.ceil(duration / CONFIG.TARGET_CHUNK_DURATION);
  }

  const estimatedWithoutFiltering = Math.ceil(totalDuration / CONFIG.TARGET_CHUNK_DURATION);
  const savedChunks = estimatedWithoutFiltering - estimatedChunks;

  console.log(`  Without speech filtering: ~${estimatedWithoutFiltering} chunks`);
  console.log(`  With speech filtering: ~${estimatedChunks} chunks`);
  console.log(`  Chunks saved: ~${savedChunks} (${(savedChunks/estimatedWithoutFiltering*100).toFixed(0)}% reduction)`);
  console.log(`  Estimated API time saved: ~${Math.ceil(savedChunks * 3.5 / 60)} minutes`);

  // Clean up
  try {
    await fs.unlink(pcmPath);
  } catch (e) {}

  // Save report
  if (saveReport) {
    const reportDir = './output/speech_detection_reports';
    await fs.mkdir(reportDir, { recursive: true });

    const reportName = path.basename(audioFile, path.extname(audioFile)) + '_speech_report.json';
    const reportPath = path.join(reportDir, reportName);

    const report = {
      file: audioFile,
      duration: totalDuration,
      cpuCores: NUM_WORKERS,
      config: CONFIG,
      summary: {
        totalWindows: classifications.length,
        speech: speechCount,
        music: musicCount,
        silence: silenceCount,
        ambiguous: ambiguousCount,
        speechPercentage: (speechCount / classifications.length * 100).toFixed(1),
      },
      regions: regions.map(r => ({
        start: r.start,
        end: r.end,
        duration: r.end - r.start,
        type: r.hasSpeech ? 'speech' : 'non-speech'
      })),
      estimatedChunks,
      chunksSaved: savedChunks,
      ...(verbose ? { classifications } : {})
    };

    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log('');
    console.log(`Report saved: ${reportPath}`);
  }

  console.log('');
  console.log('=========================================');
  console.log('  TEST COMPLETE');
  console.log('=========================================');
  console.log('');

  // Recommendations
  if (speechCount === 0 && ambiguousCount > 0) {
    console.log('RECOMMENDATION: No windows classified as speech, but some are ambiguous.');
    console.log('Try lowering SPEECH_SCORE_THRESHOLD from 0.35 to 0.25 in config.');
  } else if (speechCount < classifications.length * 0.1) {
    console.log('RECOMMENDATION: Very few speech windows detected (<10%).');
    console.log('This might be normal for music-heavy content, or thresholds may need adjustment.');
  } else if (savedChunks < 5) {
    console.log('NOTE: Speech filtering is not saving many chunks.');
    console.log('This content may have speech throughout, which is fine.');
  }
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
