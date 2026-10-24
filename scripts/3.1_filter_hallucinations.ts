import type { Segment } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
/**
 * Score Whisper hallucination indicators against the matching vocal stem.
 * Preserve the project's text patterns, acoustic checks and optional spectral
 * report support. Timing anomalies affect review flags only, not deletion scores.
 * Retained suspicious cues and all dropped text remain available for review.
 */

import { energyProfile } from './lib/audio.js';
import { at, writeJson } from './lib/files.js';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

// Common Whisper hallucination patterns (case-insensitive matching)
const HALLUCINATION_PATTERNS = [
  // Turkish - Subtitle credits and channel promos
  /^İzlediğiniz için teşekkür/i,
  /^Altyazı\s*(M\.?K\.?|çeviri|hazırlayan)?\.?$/i,
  /^Altyazı\s*:/i,
  /^Türkçe altyazı/i,
  /^MÜZİK$/i,
  /^Sesli Betimleme/i,
  /^Bu dizinin betimlemesi/i,
  /^TRT tarafından/i,
  /^Abone ol/i,
  /^Like butonuna/i,
  /^İyi seyirler/i,
  /^Beğenmeyi unutmay/i,
  /^Kanala abone ol/i,
  /^Videoyu beğen/i,
  /^Yorum yap/i,
  /^Paylaşmayı unutma/i,
  /^Çeviri:/i,
  /^Alt yazı/i,
  /^www\./i,
  /^http/i,
  /^@\w+/, // Social media handles

  // Turkish - Music and sound descriptors
  /^\[Müzik\]$/i,
  /^\[Alkış\]$/i,
  /^\(Müzik\)$/i,
  /^\(Alkış\)$/i,
  /^Müzik$/i,
  /^Alkış$/i,

  // English
  /^Thanks? (for )?watch/i,
  /^Thank you for watching/i,
  /^Subscribe/i,
  /^Like and subscribe/i,
  /^Please subscribe/i,
  /^Hit the (like|bell|subscribe)/i,
  /^MUSIC$/i,
  /^♪+$/,
  /^\[Music\]$/i,
  /^\[Applause\]$/i,
  /^Subtitles by/i,
  /^Captions by/i,
  /^Translated by/i,
  /^Copyright/i,

  // Generic
  /^\.{3,}$/, // Just dots
  /^[♪♫🎵🎶\s]+$/, // Just music symbols
  /^#\w+/, // Hashtags

  // Repetition artifacts (Whisper looping)
  /(.)\1{10,}/, // Same character repeated 10+ times
  /(\b\w+\b)\s+\1\s+\1\s+\1/i, // Same word repeated 4+ times
];

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: any) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get extra hallucination patterns from config
 */
function getExtraPatterns(settings = config) {
  const patterns = [];
  if (
    settings.EXTRA_HALLUCINATION_PATTERNS &&
    Array.isArray(settings.EXTRA_HALLUCINATION_PATTERNS)
  ) {
    for (const p of settings.EXTRA_HALLUCINATION_PATTERNS) {
      try {
        patterns.push(new RegExp(`^${escapeRegex(p)}`, 'i'));
      } catch (e) {
        console.warn(`Invalid hallucination pattern: ${p}`);
      }
    }
  }
  return patterns;
}

// Combined patterns (built-in + config)
function getAllPatterns(settings = config) {
  return [...HALLUCINATION_PATTERNS, ...getExtraPatterns(settings)];
}

// Thresholds for hallucination detection
const THRESHOLDS = {
  NO_SPEECH_PROB: 0.6, // Above this = likely no speech
  COMPRESSION_RATIO: 2.4, // Above this = repetitive (hallucination)
  AVG_LOGPROB: -1.0, // Below this = low confidence
  MIN_DURATION: 0.3, // Segments shorter than this are suspicious
  MAX_DURATION: 30, // Segments longer than this are suspicious
  ENERGY_MULTIPLIER: 0.5, // Segment energy must be at least this * median
  // Duration/text ratio - normal speech is 2-4 words per second
  MIN_WORDS_PER_SECOND: 0.3, // Below this = duration way too long for text
  MAX_WORDS_PER_SECOND: 8, // Above this = duration way too short for text
  // Minimum duration for text length (seconds per word)
  MIN_SECONDS_PER_WORD: 0.15, // At least 150ms per word expected
};

// FFT classification scoring - segments in these regions are more likely hallucinations
const FFT_SCORES: Record<string, number> = {
  silence: 4, // Silence regions - very likely hallucination
  music: 3, // Music regions - likely hallucination (no dialogue)
  ambiguous: 1, // Ambiguous - slight penalty
  speech: 0, // Speech - no penalty
};

/**
 * Load FFT speech detection report
 * @param {string} reportPath - Path to the FFT report JSON
 * @returns {Object|null} Report data or null if not found
 */
async function loadFFTReport(reportPath: any) {
  try {
    const content = await fs.readFile(reportPath, 'utf-8');
    const report = JSON.parse(content);
    console.log(`  Loaded FFT report: ${report.summary?.totalWindows || 0} windows analyzed`);
    return report;
  } catch (err) {
    console.log(`  No FFT report found at ${reportPath}`);
    return null;
  }
}

/**
 * Get the dominant FFT classification for a time range
 * Uses the detailed classifications if available, otherwise falls back to regions
 * @param {Object} fftReport - The FFT report data
 * @param {number} startTime - Segment start time
 * @param {number} endTime - Segment end time
 * @returns {{type: string, score: number, coverage: number}}
 */
function getFFTClassification(fftReport: any, startTime: number, endTime: any) {
  if (!fftReport) {
    return { type: 'unknown', score: 0, coverage: 0 };
  }

  // If we have detailed classifications (from --verbose), use them
  if (fftReport.classifications && fftReport.classifications.length > 0) {
    const overlapping = fftReport.classifications.filter(
      (c: any) => c.start < endTime && c.end > startTime,
    );

    if (overlapping.length === 0) {
      return { type: 'unknown', score: 0, coverage: 0 };
    }

    // Count coverage by type
    const typeCoverage: Record<string, number> = { speech: 0, music: 0, silence: 0, ambiguous: 0 };
    const segmentDuration = endTime - startTime;

    for (const c of overlapping) {
      const overlapStart = Math.max(c.start, startTime);
      const overlapEnd = Math.min(c.end, endTime);
      const overlapDuration = overlapEnd - overlapStart;
      const type = c.type || 'ambiguous';
      typeCoverage[type] = (typeCoverage[type] || 0) + overlapDuration;
    }

    // Find dominant type
    let dominantType = 'speech';
    let maxCoverage = 0;
    for (const [type, coverage] of Object.entries(typeCoverage)) {
      if (coverage > maxCoverage) {
        maxCoverage = coverage;
        dominantType = type;
      }
    }

    const coveragePercent = maxCoverage / segmentDuration;
    const score = FFT_SCORES[dominantType] || 0;

    return { type: dominantType, score, coverage: coveragePercent };
  }

  // Fall back to regions (from summary)
  if (fftReport.regions && fftReport.regions.length > 0) {
    for (const region of fftReport.regions) {
      if (startTime >= region.start && endTime <= region.end) {
        const type = region.type === 'non-speech' ? 'silence' : 'speech';
        const score = FFT_SCORES[type] || 0;
        return { type, score, coverage: 1.0 };
      }
    }
  }

  return { type: 'unknown', score: 0, coverage: 0 };
}

/**
 * Check if text matches known hallucination patterns
 * @returns {string|null} Pattern name if matched, null otherwise
 */
function matchesHallucinationPattern(text: string, patterns = getAllPatterns()) {
  const trimmed = text.trim();

  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return pattern.toString();
    }
  }

  return null;
}

/**
 * Check duration/text ratio for sanity
 * A 4-word phrase spanning 30 seconds is clearly wrong
 * @returns {{valid: boolean, wordsPerSecond: number, reason: string|null}}
 */
function checkDurationTextRatio(text: string, duration: number) {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w: any) => w.length > 0);
  const wordCount = words.length;

  if (duration <= 0 || wordCount === 0) {
    return { valid: true, wordsPerSecond: 0, reason: null };
  }

  const wordsPerSecond = wordCount / duration;

  // Too few words for the duration (e.g., 4 words in 30 seconds = 0.13 wps)
  if (wordsPerSecond < THRESHOLDS.MIN_WORDS_PER_SECOND) {
    return {
      valid: false,
      wordsPerSecond,
      reason: `duration_mismatch: ${wordCount} words in ${duration.toFixed(1)}s (${wordsPerSecond.toFixed(2)} wps)`,
    };
  }

  // Too many words for the duration (speaking impossibly fast)
  if (wordsPerSecond > THRESHOLDS.MAX_WORDS_PER_SECOND) {
    return {
      valid: false,
      wordsPerSecond,
      reason: `too_fast: ${wordCount} words in ${duration.toFixed(1)}s (${wordsPerSecond.toFixed(2)} wps)`,
    };
  }

  return { valid: true, wordsPerSecond, reason: null };
}

/**
 * Get energy for a time range
 */
function getEnergyInRange(profile: any, startTime: number, endTime: any) {
  const framesInRange = profile.filter((p: any) => p.time >= startTime && p.time <= endTime);
  if (framesInRange.length === 0) return { avg: 0, max: 0, frames: 0 };

  const energies = framesInRange.map((p: any) => p.energy);
  const avgEnergy = energies.reduce((a: any, b: any) => a + b, 0) / energies.length;
  const maxEnergy = Math.max(...energies);

  return { avg: avgEnergy, max: maxEnergy, frames: framesInRange.length };
}

/**
 * Compute dynamic threshold based on overall energy distribution
 */
function computeEnergyThreshold(profile: any) {
  const energies = profile.map((p: any) => p.energy).sort((a: any, b: any) => a - b);
  const medianIdx = Math.floor(energies.length / 2);
  const median = energies[medianIdx];

  // Threshold is a fraction of the median energy
  return Math.max(1e-5, (median || 0) * THRESHOLDS.ENERGY_MULTIPLIER);
}

/**
 * Classify a segment for hallucination likelihood
 */
function classifySegment(
  seg: any,
  energyData: any,
  energyThreshold: any,
  medianEnergy: number,
  fftReport = null,
  patterns = getAllPatterns(),
) {
  const reasons = [];
  let score = 0; // Higher = more likely hallucination

  const duration = seg.end - seg.start;

  // 1. CHECK TEXT PATTERNS FIRST (highest priority - immediate high score)
  const patternMatch = matchesHallucinationPattern(seg.text, patterns);
  if (patternMatch) {
    score += 10; // Immediate drop
    reasons.push(`pattern_match: "${seg.text.substring(0, 30)}"`);
  }

  // 2. CHECK DURATION/TEXT RATIO
  const durationCheck = checkDurationTextRatio(seg.text, duration);
  if (!durationCheck.valid) {
    score += 5; // Strong indicator
    reasons.push(durationCheck.reason ?? 'invalid_duration_text_ratio');
  }

  // 3. CHECK FFT CLASSIFICATION (if report available)
  const fftClass = getFFTClassification(fftReport, seg.start, seg.end);
  if (fftClass.score > 0) {
    score += fftClass.score;
    reasons.push(`fft_${fftClass.type}=${fftClass.coverage.toFixed(0)}%`);
  }

  // 4. Check Whisper metadata indicators
  if (seg.no_speech_prob > THRESHOLDS.NO_SPEECH_PROB) {
    score += 2;
    reasons.push(`no_speech_prob=${seg.no_speech_prob.toFixed(2)}`);
  }

  if (seg.compression_ratio > THRESHOLDS.COMPRESSION_RATIO) {
    score += 2;
    reasons.push(`compression_ratio=${seg.compression_ratio.toFixed(2)}`);
  }

  if (seg.avg_logprob < THRESHOLDS.AVG_LOGPROB) {
    score += 1;
    reasons.push(`avg_logprob=${seg.avg_logprob.toFixed(2)}`);
  }

  // 5. Check duration bounds
  if (duration < THRESHOLDS.MIN_DURATION) {
    score += 1;
    reasons.push(`short_duration=${duration.toFixed(2)}s`);
  }

  if (duration > THRESHOLDS.MAX_DURATION) {
    score += 1;
    reasons.push(`long_duration=${duration.toFixed(2)}s`);
  }

  // 6. Check energy - important signal
  if (energyData.avg < energyThreshold) {
    score += 3;
    reasons.push(`low_energy=${energyData.avg.toFixed(4)}<${energyThreshold.toFixed(4)}`);
  }

  // Whisper's seek is a normal window offset, not an independent hallucination signal.

  // 8. COMBO: FFT non-speech + low energy = very likely hallucination
  if (
    fftClass.type !== 'speech' &&
    fftClass.type !== 'unknown' &&
    energyData.avg < energyThreshold
  ) {
    score += 2;
    reasons.push(`fft_${fftClass.type}+low_energy`);
  }

  const timingScore =
    (!durationCheck.valid ? 5 : 0) +
    (duration < THRESHOLDS.MIN_DURATION ? 1 : 0) +
    (duration > THRESHOLDS.MAX_DURATION ? 1 : 0);
  return { score, dropScore: score - timingScore, reasons };
}

/**
 * Filter hallucinations from Whisper segments
 *
 * @param {string} audioFile - Path to audio file
 * @param {Array} segments - Raw segments from Whisper with metadata
 * @param {Object} options - Filter options
 * @returns {Promise<{kept: Array, dropped: Array, stats: Object}>}
 */
export async function filterHallucinations(
  audioFile: string,
  segments: Segment[],
  options: PipelineOptions = {},
) {
  const {
    dropThreshold = 4, // Score >= this = drop the segment
    markThreshold = 2, // Score >= this but < drop = mark as suspicious
    fftReportPath = null, // Optional path to FFT speech detection report
  } = options;

  console.log('Filtering hallucinations...');
  console.log(`  Analyzing ${segments.length} segments`);

  // Load FFT report if provided
  let fftReport = null;
  if (fftReportPath) {
    fftReport = await loadFFTReport(fftReportPath);
  }

  const profile = options.profile ?? (await energyProfile(audioFile, { signal: options.signal }));
  const energyThreshold = computeEnergyThreshold(profile);
  const medianEnergy =
    profile.map((p: any) => p.energy).sort((a: any, b: any) => a - b)[
      Math.floor(profile.length / 2)
    ] || 0;

  const kept = [];
  const dropped = [];
  const suspicious = [];
  const patterns = getAllPatterns({ ...config, ...options.settings });

  for (const seg of segments) {
    const energyData = getEnergyInRange(profile, seg.start, seg.end);
    const { score, dropScore, reasons } = classifySegment(
      seg,
      energyData,
      energyThreshold,
      medianEnergy,
      fftReport,
      patterns,
    );

    // Timing alone is not evidence that the words are invented. Retain and flag it.
    if (dropScore >= dropThreshold) {
      dropped.push({
        ...seg,
        _filterScore: score,
        _dropScore: dropScore,
        _filterReasons: reasons,
        _energy: energyData,
      });
    } else if (score >= markThreshold) {
      suspicious.push({
        ...seg,
        _filterScore: score,
        _filterReasons: reasons,
        _energy: energyData,
        _suspicious: true,
      });
      kept.push(suspicious[suspicious.length - 1]); // Keep the actual annotations
    } else {
      kept.push(seg);
    }
  }

  // Categorize dropped segments
  const patternDrops = dropped.filter((s) =>
    s._filterReasons.some((r: any) => r.startsWith('pattern_match')),
  );
  const durationDrops = dropped.filter((s) =>
    s._filterReasons.some((r: any) => r.startsWith('duration_mismatch')),
  );
  const fftDrops = dropped.filter((s) => s._filterReasons.some((r: any) => r.startsWith('fft_')));
  const energyDrops = dropped.filter(
    (s) =>
      !s._filterReasons.some(
        (r: any) =>
          r.startsWith('pattern_match') ||
          r.startsWith('duration_mismatch') ||
          r.startsWith('fft_'),
      ),
  );

  const stats = {
    total: segments.length,
    kept: kept.length,
    dropped: dropped.length,
    suspicious: suspicious.length,
    byReason: {
      pattern: patternDrops.length,
      duration: durationDrops.length,
      fft: fftDrops.length,
      energy: energyDrops.length,
    },
    fftReportUsed: !!fftReport,
  };

  console.log(
    `  Results: ${stats.kept} kept, ${stats.dropped} dropped, ${stats.suspicious} suspicious`,
  );
  console.log(`    - Pattern matches: ${patternDrops.length}`);
  console.log(`    - Duration mismatch: ${durationDrops.length}`);
  if (fftReport) {
    console.log(`    - FFT non-speech: ${fftDrops.length}`);
  }
  console.log(`    - Low energy: ${energyDrops.length}`);

  // Log pattern-based drops (always show all - these are definite hallucinations)
  if (patternDrops.length > 0) {
    console.log('');
    console.log('  Pattern-matched hallucinations:');
    for (const seg of patternDrops) {
      console.log(`    [${seg.start.toFixed(2)}-${seg.end.toFixed(2)}] "${seg.text}"`);
    }
  }

  // Log duration mismatch drops
  if (durationDrops.length > 0) {
    console.log('');
    console.log('  Duration mismatch drops:');
    for (const seg of durationDrops.slice(0, 5)) {
      const duration = seg.end - seg.start;
      const words = seg.text.split(/\s+/).length;
      console.log(
        `    [${seg.start.toFixed(2)}-${seg.end.toFixed(2)}] ${words} words in ${duration.toFixed(1)}s: "${seg.text.substring(0, 40)}..."`,
      );
    }
    if (durationDrops.length > 5) {
      console.log(`    ... and ${durationDrops.length - 5} more`);
    }
  }

  // Log energy-based drops (sample)
  if (energyDrops.length > 0) {
    console.log('');
    console.log('  Energy-based drops (sample):');
    for (const seg of energyDrops.slice(0, 5)) {
      console.log(
        `    [${seg.start.toFixed(2)}-${seg.end.toFixed(2)}] "${seg.text.substring(0, 40)}..." (${seg._filterReasons.join(', ')})`,
      );
    }
    if (energyDrops.length > 5) {
      console.log(`    ... and ${energyDrops.length - 5} more`);
    }
  }

  return { kept, dropped, suspicious, stats };
}

/**
 * Save filter results for debugging
 */
export async function saveFilterResults(jobId: any, kept: any, dropped: any, stats: any) {
  const resultPath = at('output', 'raw_transcriptions', `${jobId}_filter_results.json`);
  await writeJson(resultPath, {
    stats,
    kept,
    suspicious: kept.filter((s: any) => s._suspicious),
    dropped,
    timestamp: new Date().toISOString(),
  });
}

// CLI usage
if (process.argv[1]?.endsWith('3.1_filter_hallucinations.js')) {
  const args = process.argv.slice(2);
  const audioFile = args.find(
    (a) => !a.startsWith('--') && !a.endsWith('.json') && !a.endsWith('_speech_report.json'),
  );
  const rawJsonFile = args.find((a) => a.endsWith('.json') && !a.endsWith('_speech_report.json'));
  const fftReportPath =
    args.find((a) => a.endsWith('_speech_report.json')) ||
    args.find((a) => a.startsWith('--fft='))?.replace('--fft=', '');

  if (!audioFile || !rawJsonFile) {
    console.log(
      'Usage: node 3.1_filter_hallucinations.js <audio_file> <raw_json_file> [fft_report.json]',
    );
    console.log('');
    console.log('Filters hallucinations from Whisper transcription using audio energy analysis.');
    console.log('');
    console.log('Inputs:');
    console.log('  audio_file      - The audio file that was transcribed');
    console.log('  raw_json_file   - The raw JSON output from Groq Whisper');
    console.log(
      '  fft_report.json - (Optional) FFT speech report from test_speech_detection.js --save-report',
    );
    console.log('');
    console.log('The FFT report adds scoring for segments in silence/music/ambiguous regions.');
    console.log(
      'Generate it with: node build/scripts/test_speech_detection.js <audio> --save-report',
    );
    console.log('');
    console.log('Outputs filtered results to console and saves to raw_transcriptions folder.');
    process.exit(1);
  }

  console.log(`Audio: ${audioFile}`);
  console.log(`Raw JSON: ${rawJsonFile}`);
  if (fftReportPath) {
    console.log(`FFT Report: ${fftReportPath}`);
  }
  console.log('');

  const rawContent = await fs.readFile(rawJsonFile, 'utf-8');
  const rawData = JSON.parse(rawContent);

  // Extract segments with metadata (no word-level data needed)
  const segments = rawData.segments.map((seg: any) => ({
    text: seg.text.trim(),
    start: seg.start,
    end: seg.end,
    seek: seg.seek || 0,
    no_speech_prob: seg.no_speech_prob || 0,
    avg_logprob: seg.avg_logprob || 0,
    compression_ratio: seg.compression_ratio || 1,
    temperature: seg.temperature || 0,
  }));

  const { kept, dropped, stats } = await filterHallucinations(audioFile, segments, {
    fftReportPath,
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  FILTER SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total segments: ${stats.total}`);
  console.log(`  Kept: ${stats.kept}`);
  console.log(`  Dropped: ${stats.dropped}`);
  console.log(`  Suspicious: ${stats.suspicious}`);
  if (stats.fftReportUsed) {
    console.log(`  FFT report: Used`);
  }
  console.log('═══════════════════════════════════════════════════════════════');
}
