import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs/promises';
import path from 'path';

// Set FFmpeg path
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

/**
 * Pass through audio without quality degradation
 *
 * Previously this function would compress audio to meet Groq's 25MB limit.
 * Now that we use VAD-based chunking (max 30 seconds per chunk), file size
 * is no longer an issue and we preserve original audio quality to avoid
 * transcription hallucinations caused by compression artifacts.
 *
 * @param {string} inputFile - Input audio file path
 * @param {string} jobId - Job ID for naming
 * @returns {Promise<string>} - Path to audio file (same as input, no conversion)
 */
export async function extractAndOptimizeAudio(inputFile, jobId) {
  console.log('Audio preparation (no quality degradation)...');

  const stats = await fs.stat(inputFile);
  const fileSizeMB = stats.size / (1024 * 1024);

  console.log(`  Input file size: ${fileSizeMB.toFixed(2)} MB`);
  console.log('  Preserving original audio quality for accurate transcription');

  // Return input file as-is - no conversion needed
  // VAD-based chunking handles the segmentation at silence boundaries
  return inputFile;
}
