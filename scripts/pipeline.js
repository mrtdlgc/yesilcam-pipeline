import { config } from '../config.js';
import { checkExistingSubtitles } from './0_check_subs.js';
import { downloadVideo } from './1_download_video.js';
import { extractAndOptimizeAudio } from './2_extract_audio.js';
import { chunkAudio } from './2.5_chunk_audio.js';
import { filterWithSileroVAD } from './2.6_vad_filter.js';
import { cleanWithDemucs } from './2.7_demucs_clean.js';
import { transcribeToSegments, transcribeChunksToSegments, buildSandwichPrompt } from './3_transcribe.js';
import { filterHallucinations, saveFilterResults } from './3.1_filter_hallucinations.js';
import { mergeSegments } from './3.2_merge_sentences.js';
import { alignToSpeechBoundaries as alignEnergy } from './3.5_align_energy.js';
import { alignToSpeechBoundaries as alignSilero } from './3.5_align_silero.js';

// Select alignment function based on config
function getAlignmentFn() {
  return config.ALIGNMENT_METHOD === 'silero' ? alignSilero : alignEnergy;
}
import { cleanSegments, segmentsToSrt } from './3.7_clean_srt.js';
import { chunkSrtForTranslation } from './4_chunk_srt.js';
import { translateSrtFile, checkTranslationAvailable } from './5_translate.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import youtubedl from 'youtube-dl-exec';

// === Language Helpers ===
const LANGUAGE_LABELS = {
  'tr': 'Turkish',
  'en': 'English',
  'uk': 'Ukrainian',
  'ru': 'Russian',
  'de': 'German',
  'fr': 'French',
  'es': 'Spanish',
  'it': 'Italian',
  'auto': 'Auto-detected'
};

function getLanguageLabel(code) {
  return LANGUAGE_LABELS[code] || code.toUpperCase();
}

// === Pause/Resume State Management ===
const PAUSED_JOBS_DIR = './output/paused_jobs';

/**
 * Save pipeline state after Demucs for later resumption
 */
async function savePausedState(jobId, title, chunks, optimizedAudio, context) {
  await fs.mkdir(PAUSED_JOBS_DIR, { recursive: true });
  const statePath = path.join(PAUSED_JOBS_DIR, `${jobId}_state.json`);

  const state = {
    jobId,
    title,
    chunks,
    optimizedAudio,
    context,
    pausedAt: new Date().toISOString(),
    stage: 'after_demucs'
  };

  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  console.log(`Pipeline paused. State saved to: ${statePath}`);
  return statePath;
}

/**
 * Load paused pipeline state
 */
async function loadPausedState(jobId) {
  const statePath = path.join(PAUSED_JOBS_DIR, `${jobId}_state.json`);
  if (!existsSync(statePath)) {
    return null;
  }
  const data = await fs.readFile(statePath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Delete paused state after successful completion
 */
async function deletePausedState(jobId) {
  const statePath = path.join(PAUSED_JOBS_DIR, `${jobId}_state.json`);
  try {
    if (existsSync(statePath)) {
      await fs.unlink(statePath);
    }
  } catch (e) {
    // Ignore
  }
}

/**
 * List all paused jobs
 */
export async function listPausedJobs() {
  try {
    await fs.mkdir(PAUSED_JOBS_DIR, { recursive: true });
    const files = await fs.readdir(PAUSED_JOBS_DIR);
    const jobs = [];

    for (const file of files) {
      if (file.endsWith('_state.json')) {
        const statePath = path.join(PAUSED_JOBS_DIR, file);
        const data = await fs.readFile(statePath, 'utf-8');
        const state = JSON.parse(data);
        jobs.push({
          jobId: state.jobId,
          title: state.title,
          pausedAt: state.pausedAt,
          chunkCount: state.chunks?.length || 0
        });
      }
    }

    return jobs;
  } catch (e) {
    return [];
  }
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

// Generate a deterministic jobId from URL for checkpoint resume functionality
function generateJobId(url) {
  const videoIdMatch = url.match(/(?:v=|\/)([\w-]{11})(?:\?|&|$)/);
  if (videoIdMatch) {
    return videoIdMatch[1];
  }
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export async function processMovie(youtubeUrl, imdbId, progressCallback, movieContext = null) {
  const jobId = generateJobId(youtubeUrl);
  console.log(`Job ID: ${jobId}`);
  const outputDir = './output/subtitles';

  try {
    // Get video title for better filename
    progressCallback(2, 'Fetching video info...');
    let videoTitle = 'unknown';
    try {
      const info = await youtubedl(youtubeUrl, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        skipDownload: true
      });
      videoTitle = sanitizeFilename(info.title || 'unknown');
    } catch (err) {
      console.log('Could not fetch video title:', err.message);
    }

    // Build movie context for sandwich prompt
    const context = movieContext || {
      title: videoTitle.replace(/_/g, ' '),
      year: null,
      genre: null
    };

    // Step 0: Check for existing subtitles
    progressCallback(5, 'Checking for existing subtitles...');
    const existingSubs = await checkExistingSubtitles(youtubeUrl, imdbId);

    if (existingSubs) {
      const language = existingSubs.language || config.DEFAULT_LANGUAGE;
      const languageLabel = getLanguageLabel(language);

      progressCallback(90, `Found ${languageLabel} subtitles from ${existingSubs.source}`);

      const filename = `${videoTitle}_${language}.srt`;
      await fs.writeFile(path.join(outputDir, filename), existingSubs.content);

      progressCallback(100, `${languageLabel} subtitles saved!`);

      return {
        skipTranscription: true,
        subtitleFile: filename,
        source: existingSubs.source,
        language: language
      };
    }

    // Step 1: Download video (audio only)
    progressCallback(8, 'Downloading audio from YouTube...');
    const audioFile = await downloadVideo(youtubeUrl, jobId);

    // Step 2: Audio preparation (no quality degradation)
    progressCallback(12, 'Preparing audio file...');
    const optimizedAudio = await extractAndOptimizeAudio(audioFile, jobId);

    // Step 2.5: Speech-aware audio chunking (skips music/silence regions)
    progressCallback(15, 'Speech detection & chunking...');
    let audioChunks = await chunkAudio(optimizedAudio, jobId);
    console.log(`FFT chunking: ${audioChunks.length} chunks`);

    // Step 2.6: Silero VAD filtering (discard non-speech chunks)
    if (config.SILERO_VAD_ENABLED) {
      progressCallback(18, 'VAD filtering chunks...');
      const vadResult = await filterWithSileroVAD(audioChunks, jobId);
      audioChunks = vadResult.kept;
      console.log(`VAD filter: kept ${vadResult.stats.kept_count}/${vadResult.stats.total_chunks} chunks`);
    }

    // Step 2.7: Demucs audio cleaning (extract vocals)
    if (config.DEMUCS_ENABLED) {
      progressCallback(20, 'Cleaning audio with Demucs...');
      audioChunks = await cleanWithDemucs(audioChunks, jobId);
    }

    // Step 3: Transcribe with Whisper + Sandwich Prompt
    progressCallback(25, 'Transcribing with Whisper...');
    let rawSegments;

    if (audioChunks.length === 1) {
      rawSegments = await transcribeToSegments(audioChunks[0].file, config.DEFAULT_LANGUAGE, jobId, null, null, context);
    } else {
      rawSegments = await transcribeChunksToSegments(audioChunks, config.DEFAULT_LANGUAGE, jobId, context);
    }

    // Step 3.1: Filter hallucinations using audio energy verification
    progressCallback(40, 'Filtering hallucinations...');
    let filteredSegments = rawSegments;
    if (config.FILTER_HALLUCINATIONS) {
      const filterResult = await filterHallucinations(optimizedAudio, rawSegments, {
        dropThreshold: config.HALLUCINATION_DROP_THRESHOLD || 4,
        markThreshold: config.HALLUCINATION_MARK_THRESHOLD || 2
      });
      filteredSegments = filterResult.kept;

      // Save filter results for debugging
      await saveFilterResults(jobId, filterResult.kept, filterResult.dropped, filterResult.stats);

      console.log(`Hallucination filter: ${filterResult.stats.dropped} segments dropped`);
    } else {
      progressCallback(40, 'Skipping hallucination filter (disabled in config)');
    }

    // Step 3.5: Align timestamps to speech boundaries using audio energy
    let alignedSegments = filteredSegments;
    if (config.ALIGN_TO_SPEECH) {
      progressCallback(50, 'Aligning to speech boundaries...');
      const alignFn = getAlignmentFn();
      alignedSegments = await alignFn(optimizedAudio, filteredSegments, {
        noiseThreshold: config.SILENCE_THRESHOLD_DB,
        minSilenceDuration: config.MIN_SILENCE_DURATION,
        threshold: config.SILERO_VAD_THRESHOLD || 0.5
      });
    } else {
      progressCallback(50, 'Skipping speech alignment (disabled in config)');
    }

    // Step 3.6: Smart segmentation (respects duration/char limits)
    progressCallback(55, 'Smart segmentation...');
    const mergedSegments = mergeSegments(alignedSegments);

    // Step 3.7: Clean segments (remove duplicates, fix overlaps)
    progressCallback(60, 'Cleaning segments...');
    const cleanedSegments = cleanSegments(mergedSegments);

    // Save Turkish subtitle (SRT)
    progressCallback(65, 'Saving Turkish subtitle...');
    const trFilename = `${videoTitle}_tr.srt`;
    const trSrtPath = path.join(outputDir, trFilename);
    const srtContent = segmentsToSrt(cleanedSegments);
    await fs.writeFile(trSrtPath, srtContent);

    // Step 5: LLM Translation (if enabled)
    let enFilename = null;
    if (config.TRANSLATION_ENABLED) {
      progressCallback(70, 'Checking translation availability...');
      const translationCheck = await checkTranslationAvailable();

      if (translationCheck.available) {
        progressCallback(75, 'Translating to English...');
        enFilename = `${videoTitle}_en.srt`;
        const enSrtPath = path.join(outputDir, enFilename);

        try {
          await translateSrtFile(trSrtPath, enSrtPath, context, (pct, msg) => {
            progressCallback(75 + pct * 0.15, msg);
          });
          console.log(`English SRT saved: ${enFilename}`);
        } catch (translateErr) {
          console.log(`Warning: Translation failed: ${translateErr.message}`);
          enFilename = null;
        }
      } else {
        console.log(`Translation skipped: ${translationCheck.reason}`);
      }
    }

    // Step 6: Chunk for manual review
    progressCallback(92, 'Creating translation chunks...');
    const chunksDir = path.join('./output', 'translation_chunks', videoTitle);
    const { srtFiles, jsonFiles } = await chunkSrtForTranslation(
      cleanedSegments,
      chunksDir,
      videoTitle
    );

    progressCallback(100, 'Done! Turkish SRT + translation ready.');

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  OUTPUT FILES');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Turkish SRT: output/subtitles/${trFilename}`);
    if (enFilename) {
      console.log(`  English SRT: output/subtitles/${enFilename}`);
    }
    console.log('');
    console.log('  Translation chunks:');
    console.log(`    ${chunksDir}/`);
    console.log(`    - ${jsonFiles.length} JSON files`);
    console.log(`    - ${srtFiles.length} SRT files`);
    console.log('═══════════════════════════════════════════════════════════════');

    return {
      subtitleFile: trFilename,
      englishSubtitleFile: enFilename,
      translationChunks: {
        dir: chunksDir,
        jsonFiles,
        srtFiles
      },
      source: 'generated',
      language: config.DEFAULT_LANGUAGE
    };

  } catch (error) {
    console.error('Pipeline error:', error);
    throw new Error(`Processing failed: ${error.message}`);
  }
}

// Process from an uploaded audio file (skips download step)
export async function processAudioFile(audioFilePath, title, progressCallback) {
  const jobId = Date.now().toString(36);
  const videoTitle = sanitizeFilename(title || 'uploaded_audio');
  const outputDir = './output/subtitles';

  console.log(`Processing uploaded audio: ${audioFilePath}`);
  console.log(`Job ID: ${jobId}, Title: ${videoTitle}`);

  try {
    // Step 2: Audio preparation (no quality degradation)
    progressCallback(15, 'Preparing audio file...');
    const optimizedAudio = await extractAndOptimizeAudio(audioFilePath, jobId);

    // Step 2.5: Speech-aware audio chunking (skips music/silence regions)
    progressCallback(20, 'Speech detection & chunking...');
    let audioChunks = await chunkAudio(optimizedAudio, jobId);
    console.log(`FFT chunking: ${audioChunks.length} chunks`);

    // Step 2.6: Silero VAD filtering (discard non-speech chunks)
    if (config.SILERO_VAD_ENABLED) {
      progressCallback(22, 'VAD filtering chunks...');
      const vadResult = await filterWithSileroVAD(audioChunks, jobId);
      audioChunks = vadResult.kept;
      console.log(`VAD filter: kept ${vadResult.stats.kept_count}/${vadResult.stats.total_chunks} chunks`);
    }

    // Step 2.7: Demucs audio cleaning (extract vocals)
    if (config.DEMUCS_ENABLED) {
      progressCallback(24, 'Cleaning audio with Demucs...');
      audioChunks = await cleanWithDemucs(audioChunks, jobId);
    }

    // Build context for prompt
    const context = {
      title: videoTitle.replace(/_/g, ' '),
      year: null,
      genre: null
    };

    // === PAUSE POINT ===
    // If configured to pause after Demucs, save state and return
    if (config.PAUSE_AFTER_DEMUCS) {
      progressCallback(25, 'Pausing pipeline - audio processing complete');
      const statePath = await savePausedState(jobId, videoTitle, audioChunks, optimizedAudio, context);

      console.log('');
      console.log('╔════════════════════════════════════════════════════════════════╗');
      console.log('║  PIPELINE PAUSED AFTER AUDIO PROCESSING                        ║');
      console.log(`║  Job ID: ${jobId}`.padEnd(65) + '║');
      console.log(`║  Chunks ready: ${audioChunks.length}`.padEnd(65) + '║');
      console.log('║                                                                 ║');
      console.log('║  Resume transcription later via UI or API.                     ║');
      console.log('╚════════════════════════════════════════════════════════════════╝');

      return {
        paused: true,
        jobId,
        title: videoTitle,
        chunkCount: audioChunks.length,
        statePath,
        message: 'Audio processing complete. Resume to start transcription.'
      };
    }

    // Step 3: Transcribe with Whisper
    progressCallback(30, 'Transcribing with Whisper...');
    let rawSegments;

    if (audioChunks.length === 1) {
      rawSegments = await transcribeToSegments(audioChunks[0].file, config.DEFAULT_LANGUAGE, jobId, null, null, context);
    } else {
      rawSegments = await transcribeChunksToSegments(audioChunks, config.DEFAULT_LANGUAGE, jobId, context);
    }

    // Step 3.1: Filter hallucinations using audio energy verification
    progressCallback(35, 'Filtering hallucinations...');
    let filteredSegments = rawSegments;
    if (config.FILTER_HALLUCINATIONS) {
      const filterResult = await filterHallucinations(optimizedAudio, rawSegments, {
        dropThreshold: config.HALLUCINATION_DROP_THRESHOLD || 4,
        markThreshold: config.HALLUCINATION_MARK_THRESHOLD || 2
      });
      filteredSegments = filterResult.kept;

      await saveFilterResults(jobId, filterResult.kept, filterResult.dropped, filterResult.stats);
      console.log(`Hallucination filter: ${filterResult.stats.dropped} segments dropped`);
    }

    // Step 3.5: Align timestamps to speech boundaries using audio energy
    let alignedSegments = filteredSegments;
    if (config.ALIGN_TO_SPEECH) {
      progressCallback(45, 'Aligning to speech boundaries...');
      const alignFn = getAlignmentFn();
      alignedSegments = await alignFn(optimizedAudio, filteredSegments, {
        noiseThreshold: config.SILENCE_THRESHOLD_DB,
        minSilenceDuration: config.MIN_SILENCE_DURATION,
        threshold: config.SILERO_VAD_THRESHOLD || 0.5
      });
    }

    // Step 3.6: Smart segmentation (respects duration/char limits)
    progressCallback(55, 'Smart segmentation...');
    const mergedSegments = mergeSegments(alignedSegments);

    // Step 3.7: Clean segments (remove duplicates, fix overlaps)
    progressCallback(60, 'Cleaning segments...');
    const cleanedSegments = cleanSegments(mergedSegments);

    // Save Turkish subtitle (SRT)
    progressCallback(70, 'Saving Turkish subtitle...');
    const trFilename = `${videoTitle}_tr.srt`;
    const srtContent = segmentsToSrt(cleanedSegments);
    await fs.writeFile(path.join(outputDir, trFilename), srtContent);

    // Step 4: Chunk for manual translation
    progressCallback(80, 'Creating translation chunks...');
    const chunksDir = path.join('./output', 'translation_chunks', videoTitle);
    const { srtFiles, jsonFiles } = await chunkSrtForTranslation(
      cleanedSegments,
      chunksDir,
      videoTitle
    );

    progressCallback(100, 'Done! Turkish SRT + translation chunks ready.');

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  OUTPUT FILES');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Turkish SRT: output/subtitles/${trFilename}`);
    console.log(`  Translation chunks: ${chunksDir}/`);
    console.log('═══════════════════════════════════════════════════════════════');

    return {
      subtitleFile: trFilename,
      translationChunks: {
        dir: chunksDir,
        jsonFiles,
        srtFiles
      },
      source: 'uploaded',
      language: config.DEFAULT_LANGUAGE
    };

  } catch (error) {
    console.error('Pipeline error:', error);
    throw new Error(`Processing failed: ${error.message}`);
  }
}

/**
 * Process a local video file (from movies directory)
 * Extracts audio and runs the full transcription pipeline with enhanced stages:
 * - Silero VAD filtering
 * - Demucs audio cleaning
 * - Sandwich Prompt for context
 * - LLM Translation
 */
export async function processVideoFile(videoFilePath, progressCallback, movieContext = null) {
  const jobId = Date.now().toString(36);

  // Extract title from filename (remove extension)
  const filename = path.basename(videoFilePath);
  const title = sanitizeFilename(filename.replace(/\.[^.]+$/, ''));
  const outputDir = './output/subtitles';

  // Build movie context for sandwich prompt
  const context = movieContext || {
    title: title.replace(/_/g, ' '),
    year: null,
    genre: null
  };

  console.log(`Processing video file: ${videoFilePath}`);
  console.log(`Job ID: ${jobId}, Title: ${title}`);

  try {
    // Step 1: Extract audio from video file
    progressCallback(5, 'Extracting audio from video...');
    const tempAudioPath = `./temp/${jobId}_extracted.mp3`;

    const { execSync } = await import('child_process');
    try {
      // Extract audio using ffmpeg - mono, 16kHz for Whisper
      execSync(`ffmpeg -i "${videoFilePath}" -vn -acodec libmp3lame -ar 16000 -ac 1 -q:a 2 "${tempAudioPath}" -y`, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      throw new Error(`FFmpeg audio extraction failed: ${err.message}`);
    }

    console.log(`Audio extracted to: ${tempAudioPath}`);

    // Step 2: Audio preparation (no quality degradation)
    progressCallback(10, 'Preparing audio file...');
    const optimizedAudio = await extractAndOptimizeAudio(tempAudioPath, jobId);

    // Step 2.5: Speech-aware audio chunking (skips music/silence regions)
    progressCallback(15, 'Speech detection & chunking...');
    let audioChunks = await chunkAudio(optimizedAudio, jobId);
    console.log(`FFT chunking: ${audioChunks.length} chunks`);

    // Step 2.6: Silero VAD filtering (discard non-speech chunks)
    if (config.SILERO_VAD_ENABLED) {
      progressCallback(18, 'VAD filtering chunks...');
      const vadResult = await filterWithSileroVAD(audioChunks, jobId);
      audioChunks = vadResult.kept;
      console.log(`VAD filter: kept ${vadResult.stats.kept_count}/${vadResult.stats.total_chunks} chunks`);
    }

    // Step 2.7: Demucs audio cleaning (extract vocals)
    if (config.DEMUCS_ENABLED) {
      progressCallback(20, 'Cleaning audio with Demucs...');
      audioChunks = await cleanWithDemucs(audioChunks, jobId);
    }

    // Step 3: Transcribe with Whisper + Sandwich Prompt
    progressCallback(25, 'Transcribing with Whisper...');
    let rawSegments;

    if (audioChunks.length === 1) {
      rawSegments = await transcribeToSegments(audioChunks[0].file, config.DEFAULT_LANGUAGE, jobId, null, null, context);
    } else {
      rawSegments = await transcribeChunksToSegments(audioChunks, config.DEFAULT_LANGUAGE, jobId, context);
    }

    // Step 3.1: Filter hallucinations using audio energy verification
    progressCallback(40, 'Filtering hallucinations...');
    let filteredSegments = rawSegments;
    if (config.FILTER_HALLUCINATIONS) {
      const filterResult = await filterHallucinations(optimizedAudio, rawSegments, {
        dropThreshold: config.HALLUCINATION_DROP_THRESHOLD || 4,
        markThreshold: config.HALLUCINATION_MARK_THRESHOLD || 2
      });
      filteredSegments = filterResult.kept;

      await saveFilterResults(jobId, filterResult.kept, filterResult.dropped, filterResult.stats);
      console.log(`Hallucination filter: ${filterResult.stats.dropped} segments dropped`);
    }

    // Step 3.5: Align timestamps to speech boundaries using audio energy
    let alignedSegments = filteredSegments;
    if (config.ALIGN_TO_SPEECH) {
      progressCallback(50, 'Aligning to speech boundaries...');
      const alignFn = getAlignmentFn();
      alignedSegments = await alignFn(optimizedAudio, filteredSegments, {
        noiseThreshold: config.SILENCE_THRESHOLD_DB,
        minSilenceDuration: config.MIN_SILENCE_DURATION,
        threshold: config.SILERO_VAD_THRESHOLD || 0.5
      });
    }

    // Step 3.6: Smart segmentation (respects duration/char limits)
    progressCallback(55, 'Smart segmentation...');
    const mergedSegments = mergeSegments(alignedSegments);

    // Step 3.7: Clean segments (remove duplicates, fix overlaps)
    progressCallback(60, 'Cleaning segments...');
    const cleanedSegments = cleanSegments(mergedSegments);

    // Save Turkish subtitle (SRT)
    progressCallback(65, 'Saving Turkish subtitle...');
    const trFilename = `${title}_tr.srt`;
    const trSrtPath = path.join(outputDir, trFilename);
    const srtContent = segmentsToSrt(cleanedSegments);
    await fs.writeFile(trSrtPath, srtContent);

    // Step 5: LLM Translation (if enabled)
    let enFilename = null;
    if (config.TRANSLATION_ENABLED) {
      progressCallback(70, 'Checking translation availability...');
      const translationCheck = await checkTranslationAvailable();

      if (translationCheck.available) {
        progressCallback(75, 'Translating to English...');
        enFilename = `${title}_en.srt`;
        const enSrtPath = path.join(outputDir, enFilename);

        try {
          await translateSrtFile(trSrtPath, enSrtPath, context, (pct, msg) => {
            progressCallback(75 + pct * 0.15, msg);
          });
          console.log(`English SRT saved: ${enFilename}`);
        } catch (translateErr) {
          console.log(`Warning: Translation failed: ${translateErr.message}`);
          enFilename = null;
        }
      } else {
        console.log(`Translation skipped: ${translationCheck.reason}`);
      }
    }

    // Step 6: Chunk for manual translation/review
    progressCallback(92, 'Creating translation chunks...');
    const chunksDir = path.join('./output', 'translation_chunks', title);
    const { srtFiles, jsonFiles } = await chunkSrtForTranslation(
      cleanedSegments,
      chunksDir,
      title
    );

    // Cleanup temp audio
    try { await fs.unlink(tempAudioPath); } catch (e) {}

    progressCallback(100, 'Done! Turkish SRT + translation ready.');

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  OUTPUT FILES');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Source: ${filename}`);
    console.log(`  Turkish SRT: output/subtitles/${trFilename}`);
    if (enFilename) {
      console.log(`  English SRT: output/subtitles/${enFilename}`);
    }
    console.log(`  Translation chunks: ${chunksDir}/`);
    console.log('═══════════════════════════════════════════════════════════════');

    return {
      subtitleFile: trFilename,
      englishSubtitleFile: enFilename,
      translationChunks: {
        dir: chunksDir,
        jsonFiles,
        srtFiles
      },
      source: 'video_file',
      sourceFile: filename,
      language: config.DEFAULT_LANGUAGE
    };

  } catch (error) {
    console.error('Pipeline error:', error);
    throw new Error(`Processing failed: ${error.message}`);
  }
}

/**
 * Resume a paused pipeline job (continue from transcription)
 * Loads saved state and runs transcription + post-processing
 */
export async function resumePausedJob(jobId, progressCallback) {
  console.log(`Resuming paused job: ${jobId}`);

  const state = await loadPausedState(jobId);
  if (!state) {
    throw new Error(`No paused job found with ID: ${jobId}`);
  }

  const { title, chunks: audioChunks, optimizedAudio, context } = state;
  const outputDir = './output/subtitles';

  console.log(`Loaded state: ${audioChunks.length} chunks, title: ${title}`);

  try {
    // Step 3: Transcribe with Whisper
    progressCallback(30, 'Transcribing with Whisper...');
    let rawSegments;

    if (audioChunks.length === 1) {
      rawSegments = await transcribeToSegments(audioChunks[0].file, config.DEFAULT_LANGUAGE, jobId, null, null, context);
    } else {
      rawSegments = await transcribeChunksToSegments(audioChunks, config.DEFAULT_LANGUAGE, jobId, context);
    }

    // Step 3.1: Filter hallucinations (requires audio file)
    progressCallback(50, 'Filtering hallucinations...');
    let filteredSegments = rawSegments;
    if (config.FILTER_HALLUCINATIONS && optimizedAudio) {
      const filterResult = await filterHallucinations(optimizedAudio, rawSegments, {
        dropThreshold: config.HALLUCINATION_DROP_THRESHOLD || 4,
        markThreshold: config.HALLUCINATION_MARK_THRESHOLD || 2
      });
      filteredSegments = filterResult.kept;
      await saveFilterResults(jobId, filterResult.kept, filterResult.dropped, filterResult.stats);
      console.log(`Hallucination filter: ${filterResult.stats.dropped} segments dropped`);
    } else if (!optimizedAudio) {
      console.log('Skipping hallucination filter (no audio file available)');
    }

    // Step 3.5: Align timestamps (requires audio file)
    let alignedSegments = filteredSegments;
    if (config.ALIGN_TO_SPEECH && optimizedAudio) {
      progressCallback(60, 'Aligning to speech boundaries...');
      const alignFn = getAlignmentFn();
      alignedSegments = await alignFn(optimizedAudio, filteredSegments, {
        noiseThreshold: config.SILENCE_THRESHOLD_DB,
        minSilenceDuration: config.MIN_SILENCE_DURATION,
        threshold: config.SILERO_VAD_THRESHOLD || 0.5
      });
    } else if (!optimizedAudio) {
      console.log('Skipping speech alignment (no audio file available)');
    }

    // Step 3.6: Smart segmentation
    progressCallback(70, 'Smart segmentation...');
    const mergedSegments = mergeSegments(alignedSegments);

    // Step 3.7: Clean segments
    progressCallback(75, 'Cleaning segments...');
    const cleanedSegments = cleanSegments(mergedSegments);

    // Save Turkish subtitle
    progressCallback(80, 'Saving Turkish subtitle...');
    const trFilename = `${title}_tr.srt`;
    const trSrtPath = path.join(outputDir, trFilename);
    const srtContent = segmentsToSrt(cleanedSegments);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(trSrtPath, srtContent);

    // Step 6: Chunk for translation
    progressCallback(90, 'Creating translation chunks...');
    const chunksDir = path.join('./output', 'translation_chunks', title);
    const { srtFiles, jsonFiles } = await chunkSrtForTranslation(
      cleanedSegments,
      chunksDir,
      title
    );

    // Delete paused state
    await deletePausedState(jobId);

    progressCallback(100, 'Done! Turkish SRT ready.');

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  OUTPUT FILES');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Turkish SRT: output/subtitles/${trFilename}`);
    console.log(`  Translation chunks: ${chunksDir}/`);
    console.log('═══════════════════════════════════════════════════════════════');

    return {
      subtitleFile: trFilename,
      translationChunks: {
        dir: chunksDir,
        jsonFiles,
        srtFiles
      },
      source: 'resumed',
      language: config.DEFAULT_LANGUAGE
    };

  } catch (error) {
    console.error('Pipeline error:', error);
    throw new Error(`Resume failed: ${error.message}`);
  }
}
