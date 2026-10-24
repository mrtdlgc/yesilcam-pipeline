/**
 * Audio Analysis Worker - Spectral Analysis
 * Processes a segment of audio samples in parallel
 */

import { parentPort as suppliedPort, workerData } from 'worker_threads';

if (!suppliedPort) throw new Error('This script must run in a worker thread');
const parentPort = suppliedPort;

try {
  const {
    samples,
    startIdx,
    endIdx,
    globalOffset = 0,
    config,
    medianEnergy,
    workerId,
  } = workerData;

  // Send immediate startup confirmation
  parentPort.postMessage({
    type: 'started',
    workerId,
    startIdx,
    endIdx,
    globalOffset,
    samplesLength: samples?.byteLength,
  });

  // Reconstruct Float32Array from transferred buffer
  const samplesArray = new Float32Array(samples);

  const silenceThreshold = medianEnergy * config.SILENCE_THRESHOLD_MULTIPLIER;
  const analysisWindowSamples = Math.floor(config.SAMPLE_RATE * config.ANALYSIS_WINDOW_SEC);
  const hopSamples = Math.floor(analysisWindowSamples / 2);
  const fftSize = config.FFT_SIZE;
  const energyWindowSize = Math.floor((config.SAMPLE_RATE * config.WINDOW_MS) / 1000);

  /**
   * Compute energy directly from samples (no pre-computed profile needed)
   */
  function computeWindowEnergy(windowStart: number, windowEnd: number) {
    let sum = 0;
    let count = 0;

    for (let i = windowStart; i < windowEnd && i < samplesArray.length; i++) {
      sum += samplesArray[i] * samplesArray[i];
      count++;
    }

    return count > 0 ? Math.sqrt(sum / count) : 0;
  }

  /**
   * Cooley-Tukey FFT (radix-2, in-place) - O(n log n)
   */
  let fftDebugOnce = true;
  function fft(real: Float32Array, imag: Float32Array) {
    const n = real.length;

    if (fftDebugOnce) {
      parentPort.postMessage({
        type: 'debug',
        workerId,
        msg: `FFT: n=${n}, real.len=${real.length}, imag.len=${imag.length}`,
      });
    }

    // Bit-reversal permutation
    if (fftDebugOnce) {
      parentPort.postMessage({ type: 'debug', workerId, msg: `FFT: starting bit-reversal loop` });
    }

    for (let i = 0, j = 0; i < n; i++) {
      if (fftDebugOnce && i === 0) {
        parentPort.postMessage({ type: 'debug', workerId, msg: `FFT: first iteration i=0` });
      }
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
      let k = n >> 1;
      while (k <= j && k > 0) {
        // Added '&& k > 0' check
        j -= k;
        k >>= 1;
      }
      j += k;
      if (fftDebugOnce && i === 0) {
        parentPort.postMessage({
          type: 'debug',
          workerId,
          msg: `FFT: first iteration done, j=${j}`,
        });
      }
    }

    if (fftDebugOnce) {
      parentPort.postMessage({ type: 'debug', workerId, msg: `FFT: bit-reversal done` });
    }

    // Cooley-Tukey FFT
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const angleStep = (-2 * Math.PI) / size;

      for (let i = 0; i < n; i += size) {
        for (let j = 0, angle = 0; j < halfSize; j++, angle += angleStep) {
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const idx1 = i + j;
          const idx2 = i + j + halfSize;

          const tReal = real[idx2] * cos - imag[idx2] * sin;
          const tImag = real[idx2] * sin + imag[idx2] * cos;

          real[idx2] = real[idx1] - tReal;
          imag[idx2] = imag[idx1] - tImag;
          real[idx1] += tReal;
          imag[idx1] += tImag;
        }
      }
    }

    if (fftDebugOnce) {
      parentPort.postMessage({ type: 'debug', workerId, msg: `FFT: butterfly done` });
      fftDebugOnce = false;
    }
  }

  /**
   * Compute magnitude spectrum using FFT
   */
  function computeSpectrum(sampleStartIdx: number) {
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    const magnitudes = new Float32Array(fftSize / 2);

    // Apply Hann window and copy samples
    for (let i = 0; i < fftSize && sampleStartIdx + i < samplesArray.length; i++) {
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
      real[i] = samplesArray[sampleStartIdx + i] * window;
    }

    // Run FFT
    fft(real, imag);

    // Compute magnitudes
    for (let k = 0; k < fftSize / 2; k++) {
      magnitudes[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
    }

    return magnitudes;
  }

  /**
   * Calculate spectral flatness (Wiener entropy)
   */
  function calculateSpectralFlatness(magnitudes: Float32Array) {
    const epsilon = 1e-10;
    let logSum = 0;
    let sum = 0;
    let count = 0;

    for (let i = 1; i < magnitudes.length; i++) {
      const mag = magnitudes[i] + epsilon;
      logSum += Math.log(mag);
      sum += mag;
      count++;
    }

    if (count === 0 || sum === 0) return 1;

    const geometricMean = Math.exp(logSum / count);
    const arithmeticMean = sum / count;

    return geometricMean / arithmeticMean;
  }

  /**
   * Calculate ratio of energy in speech frequency band (300-3400 Hz)
   */
  function calculateSpeechBandRatio(magnitudes: Float32Array) {
    const binWidth = config.SAMPLE_RATE / fftSize;
    const lowBin = Math.floor(config.SPEECH_FREQ_LOW / binWidth);
    const highBin = Math.min(Math.floor(config.SPEECH_FREQ_HIGH / binWidth), magnitudes.length - 1);

    let speechEnergy = 0;
    let totalEnergy = 0;

    for (let i = 1; i < magnitudes.length; i++) {
      const energy = magnitudes[i] * magnitudes[i];
      totalEnergy += energy;
      if (i >= lowBin && i <= highBin) {
        speechEnergy += energy;
      }
    }

    return totalEnergy > 0 ? speechEnergy / totalEnergy : 0;
  }

  /**
   * Calculate spectral centroid (center of mass of spectrum)
   */
  function calculateSpectralCentroid(magnitudes: Float32Array) {
    const binWidth = config.SAMPLE_RATE / fftSize;
    let weightedSum = 0;
    let sum = 0;

    for (let i = 1; i < magnitudes.length; i++) {
      const freq = i * binWidth;
      weightedSum += freq * magnitudes[i];
      sum += magnitudes[i];
    }

    return sum > 0 ? weightedSum / sum : 0;
  }

  /**
   * Calculate energy modulation from samples directly
   */
  function calculateEnergyModulation(windowStart: number, windowEnd: number) {
    // Sample energy at multiple points within the window
    const numSamples = 10;
    const stepSize = Math.floor((windowEnd - windowStart) / numSamples);

    if (stepSize < energyWindowSize) return 0;

    const energies = [];
    for (let i = 0; i < numSamples; i++) {
      const pos = windowStart + i * stepSize;
      energies.push(computeWindowEnergy(pos, pos + energyWindowSize));
    }

    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    if (mean === 0) return 0;

    let variation = 0;
    for (let i = 1; i < energies.length; i++) {
      variation += Math.abs(energies[i] - energies[i - 1]);
    }

    return variation / (energies.length * mean);
  }

  /**
   * Calculate zero-crossing rate
   */
  function calculateZCR(windowStartIdx: any, windowEndIdx: any) {
    let crossings = 0;
    for (let i = windowStartIdx + 1; i < windowEndIdx && i < samplesArray.length; i++) {
      if (samplesArray[i] >= 0 !== samplesArray[i - 1] >= 0) {
        crossings++;
      }
    }
    return crossings / (windowEndIdx - windowStartIdx);
  }

  /**
   * Classify a single window using spectral features
   */
  // Debug flag - only log for first window
  let debugFirstWindow = true;

  function classifyWindow(windowStartIdx: any) {
    const windowEndIdx = windowStartIdx + analysisWindowSamples;
    // Use globalOffset to calculate actual timestamps in the original audio
    const startTime = (windowStartIdx + globalOffset) / config.SAMPLE_RATE;
    const endTime = (windowEndIdx + globalOffset) / config.SAMPLE_RATE;

    if (debugFirstWindow)
      parentPort.postMessage({
        type: 'debug',
        workerId,
        msg: `step1: computing energy ${windowStartIdx}-${windowEndIdx}`,
      });

    // Compute energy directly from samples
    const avgEnergy = computeWindowEnergy(windowStartIdx, windowEndIdx);

    if (debugFirstWindow)
      parentPort.postMessage({
        type: 'debug',
        workerId,
        msg: `step2: energy=${avgEnergy.toFixed(6)}, threshold=${silenceThreshold.toFixed(6)}`,
      });

    // Check for silence first
    if (avgEnergy < silenceThreshold) {
      debugFirstWindow = false;
      return {
        start: startTime,
        end: endTime,
        type: 'silence',
        speechScore: 0,
        features: { avgEnergy, reason: 'low_energy' },
      };
    }

    if (debugFirstWindow)
      parentPort.postMessage({
        type: 'debug',
        workerId,
        msg: `step3: computing FFT, fftSize=${fftSize}, samplesLen=${samplesArray.length}`,
      });

    // Compute spectral features using 3 FFT samples (start, middle, end)
    let avgSpectralFlatness = 0;
    let avgSpeechBandRatio = 0;
    let avgSpectralCentroid = 0;
    let spectrumCount = 0;

    const samplePoints = [
      windowStartIdx,
      windowStartIdx + Math.floor(analysisWindowSamples / 2),
      windowStartIdx + analysisWindowSamples - fftSize,
    ];

    if (debugFirstWindow)
      parentPort.postMessage({
        type: 'debug',
        workerId,
        msg: `step3a: samplePoints=${JSON.stringify(samplePoints)}`,
      });

    for (let pi = 0; pi < samplePoints.length; pi++) {
      const j = samplePoints[pi];
      if (debugFirstWindow)
        parentPort.postMessage({
          type: 'debug',
          workerId,
          msg: `step3b: point ${pi}, j=${j}, check=${j >= 0 && j + fftSize <= samplesArray.length}`,
        });

      if (j >= 0 && j + fftSize <= samplesArray.length) {
        if (debugFirstWindow)
          parentPort.postMessage({
            type: 'debug',
            workerId,
            msg: `step3c: calling computeSpectrum(${j})`,
          });
        const spectrum = computeSpectrum(j);
        if (debugFirstWindow)
          parentPort.postMessage({
            type: 'debug',
            workerId,
            msg: `step3d: spectrum done, len=${spectrum.length}`,
          });
        avgSpectralFlatness += calculateSpectralFlatness(spectrum);
        avgSpeechBandRatio += calculateSpeechBandRatio(spectrum);
        avgSpectralCentroid += calculateSpectralCentroid(spectrum);
        spectrumCount++;
      }
    }

    if (spectrumCount > 0) {
      avgSpectralFlatness /= spectrumCount;
      avgSpeechBandRatio /= spectrumCount;
      avgSpectralCentroid /= spectrumCount;
    }

    if (debugFirstWindow)
      parentPort.postMessage({
        type: 'debug',
        workerId,
        msg: `step4: FFT done, computing modulation`,
      });

    // Calculate other features
    const energyModulation = calculateEnergyModulation(windowStartIdx, windowEndIdx);

    if (debugFirstWindow)
      parentPort.postMessage({ type: 'debug', workerId, msg: `step5: computing ZCR` });

    const zcr = calculateZCR(windowStartIdx, windowEndIdx);

    if (debugFirstWindow)
      parentPort.postMessage({ type: 'debug', workerId, msg: `step6: scoring` });

    // Speech scoring based on multiple features
    let speechScore = 0;
    const reasons = [];

    // 1. Spectral flatness: speech is more tonal (lower flatness) than noise
    if (avgSpectralFlatness < config.SPECTRAL_FLATNESS_THRESHOLD) {
      speechScore += 0.15;
      reasons.push('tonal');
    }

    // 2. Speech band energy ratio: speech has energy concentrated in 300-3400 Hz
    if (avgSpeechBandRatio > config.SPEECH_BAND_RATIO_THRESHOLD) {
      speechScore += 0.25;
      reasons.push('speech_band');
    }

    // 3. Spectral centroid: speech typically 500-2000 Hz
    if (avgSpectralCentroid > 400 && avgSpectralCentroid < 2500) {
      speechScore += 0.2;
      reasons.push('centroid_ok');
    }

    // 4. Energy modulation: speech has syllable-rate variation
    if (energyModulation > config.ENERGY_MODULATION_THRESHOLD) {
      speechScore += 0.25;
      reasons.push('modulated');
    }

    // 5. ZCR: speech typically has moderate ZCR
    if (zcr > 0.02 && zcr < 0.15) {
      speechScore += 0.15;
      reasons.push('zcr_ok');
    }

    // Determine type based on score
    let type;
    if (speechScore >= config.SPEECH_SCORE_THRESHOLD) {
      type = 'speech';
    } else if (avgSpectralFlatness < 0.2 && energyModulation < 0.05) {
      type = 'music';
    } else {
      type = 'ambiguous';
    }

    if (debugFirstWindow) {
      parentPort.postMessage({ type: 'debug', workerId, msg: `step7: done, type=${type}` });
      debugFirstWindow = false;
    }

    return {
      start: startTime,
      end: endTime,
      type,
      speechScore,
      features: {
        avgEnergy,
        spectralFlatness: avgSpectralFlatness,
        speechBandRatio: avgSpeechBandRatio,
        spectralCentroid: avgSpectralCentroid,
        energyModulation,
        zcr,
        reasons,
      },
    };
  }

  // Process assigned range
  const results = [];
  let processed = 0;
  const totalWindows = Math.ceil((endIdx - startIdx - analysisWindowSamples) / hopSamples);

  // Report progress every 5%
  const progressInterval = Math.max(1, Math.floor(totalWindows / 20));

  parentPort.postMessage({
    type: 'debug',
    workerId,
    msg: `Starting loop: ${totalWindows} windows, interval=${progressInterval}`,
  });

  for (let i = startIdx; i + analysisWindowSamples <= endIdx; i += hopSamples) {
    if (processed === 0) {
      parentPort.postMessage({ type: 'debug', workerId, msg: `First window at i=${i}` });
    }

    const result = classifyWindow(i);

    if (processed === 0) {
      parentPort.postMessage({
        type: 'debug',
        workerId,
        msg: `First window done, type=${result?.type}`,
      });
    }

    if (result) {
      results.push(result);
    }

    processed++;
    if (processed % progressInterval === 0) {
      parentPort.postMessage({ type: 'progress', workerId, processed, total: totalWindows });
    }
  }

  // Send final results
  parentPort.postMessage({ type: 'done', workerId, results, processed, total: totalWindows });
} catch (err) {
  parentPort.postMessage({
    type: 'error',
    workerId: workerData?.workerId,
    error: err.message,
    stack: err.stack,
  });
}
