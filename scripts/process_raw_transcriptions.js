/**
 * Process existing raw transcription files without re-running Whisper
 * Usage: node scripts/process_raw_transcriptions.js <jobId> <audioFile>
 */

import { config } from '../config.js';
import { filterHallucinations, saveFilterResults } from './3.1_filter_hallucinations.js';
import { mergeSegments } from './3.2_merge_sentences.js';
import { alignToSpeechBoundaries as alignSilero } from './3.5_align_silero.js';
import { alignToSpeechBoundaries as alignEnergy } from './3.5_align_energy.js';
import { cleanSegments, segmentsToSrt } from './3.7_clean_srt.js';
import { chunkSrtForTranslation } from './4_chunk_srt.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

async function processRawTranscriptions(jobId, audioFile, title) {
  console.log(`Processing raw transcriptions for job: ${jobId}`);
  console.log(`Audio file: ${audioFile}`);

  const rawDir = './output/raw_transcriptions';
  const outputDir = './output/subtitles';

  // Load chunk metadata from demucs result
  const demucsResultPath = `./temp/${jobId}_demucs/demucs_result.json`;
  let chunkMetadata = [];

  if (existsSync(demucsResultPath)) {
    const demucsResult = JSON.parse(await fs.readFile(demucsResultPath, 'utf-8'));
    chunkMetadata = demucsResult.chunks;
    console.log(`Loaded ${chunkMetadata.length} chunk metadata entries`);
  } else {
    console.log('Warning: No demucs_result.json found, timestamps may be incorrect');
  }

  // Find all raw transcription files for this job
  const files = await fs.readdir(rawDir);
  const rawFiles = files
    .filter(f => f.startsWith(`${jobId}_chunk_`) && f.endsWith('_raw.json'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/chunk_(\d+)/)?.[1] || '0');
      const numB = parseInt(b.match(/chunk_(\d+)/)?.[1] || '0');
      return numA - numB;
    });

  console.log(`Found ${rawFiles.length} raw transcription files`);

  // Load and combine all segments
  let allSegments = [];

  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    const chunkIndex = parseInt(file.match(/chunk_(\d+)/)?.[1] || '0');
    const filePath = path.join(rawDir, file);

    const rawData = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    const segments = rawData.segments || [];

    // Get chunk start time from metadata
    let chunkStartTime = 0;
    if (chunkMetadata[i]) {
      chunkStartTime = chunkMetadata[i].startTime || 0;
    }

    // Adjust timestamps
    const adjustedSegments = segments.map(seg => ({
      text: seg.text,
      start: seg.start + chunkStartTime,
      end: seg.end + chunkStartTime,
      seek: seg.seek || 0,
      no_speech_prob: seg.no_speech_prob || 0,
      avg_logprob: seg.avg_logprob || 0,
      compression_ratio: seg.compression_ratio || 1,
      temperature: seg.temperature || 0
    }));

    allSegments.push(...adjustedSegments);

    if ((i + 1) % 20 === 0) {
      console.log(`  Loaded ${i + 1}/${rawFiles.length} files...`);
    }
  }

  console.log(`Total segments: ${allSegments.length}`);

  // Step 1: Filter hallucinations
  console.log('\nFiltering hallucinations...');
  let filteredSegments = allSegments;

  if (config.FILTER_HALLUCINATIONS && audioFile && existsSync(audioFile)) {
    const filterResult = await filterHallucinations(audioFile, allSegments, {
      dropThreshold: config.HALLUCINATION_DROP_THRESHOLD || 4,
      markThreshold: config.HALLUCINATION_MARK_THRESHOLD || 2
    });
    filteredSegments = filterResult.kept;
    await saveFilterResults(jobId, filterResult.kept, filterResult.dropped, filterResult.stats);
    console.log(`  Dropped ${filterResult.stats.dropped} hallucinated segments`);
  } else {
    console.log('  Skipping (no audio file or filter disabled)');
  }

  // Step 2: Align to speech boundaries
  const alignmentMethod = config.ALIGNMENT_METHOD || 'silero';
  console.log(`\nAligning to speech boundaries (${alignmentMethod})...`);
  let alignedSegments = filteredSegments;

  if (config.ALIGN_TO_SPEECH && audioFile && existsSync(audioFile)) {
    const alignFn = alignmentMethod === 'silero' ? alignSilero : alignEnergy;
    alignedSegments = await alignFn(audioFile, filteredSegments, {
      noiseThreshold: config.SILENCE_THRESHOLD_DB,
      minSilenceDuration: config.MIN_SILENCE_DURATION,
      threshold: config.SILERO_VAD_THRESHOLD || 0.5
    });
    console.log('  Done');
  } else {
    console.log('  Skipping (no audio file or alignment disabled)');
  }

  // Step 3: Merge segments
  console.log('\nMerging segments...');
  const mergedSegments = mergeSegments(alignedSegments);
  console.log(`  ${alignedSegments.length} -> ${mergedSegments.length} segments`);

  // Step 4: Clean segments
  console.log('\nCleaning segments...');
  const cleanedSegments = cleanSegments(mergedSegments);
  console.log(`  ${cleanedSegments.length} final segments`);

  // Step 5: Save SRT
  await fs.mkdir(outputDir, { recursive: true });
  const srtFilename = `${title}_uk.srt`;
  const srtPath = path.join(outputDir, srtFilename);
  const srtContent = segmentsToSrt(cleanedSegments);
  await fs.writeFile(srtPath, srtContent);
  console.log(`\nSaved: ${srtPath}`);

  // Step 6: Create translation chunks
  console.log('\nCreating translation chunks...');
  const chunksDir = path.join('./output', 'translation_chunks', title);
  const { srtFiles, jsonFiles } = await chunkSrtForTranslation(
    cleanedSegments,
    chunksDir,
    title
  );
  console.log(`  Created ${srtFiles.length} SRT chunks and ${jsonFiles.length} JSON chunks`);

  console.log('\n✓ Processing complete!');
  console.log(`  SRT file: ${srtPath}`);
  console.log(`  Translation chunks: ${chunksDir}`);

  return {
    srtFile: srtPath,
    segments: cleanedSegments.length,
    chunksDir
  };
}

// Main
const jobId = process.argv[2] || 'ml6oh54d';
const audioFile = process.argv[3] || 'temp/ml6oh54d_optimized.wav';
const title = process.argv[4] || 'Dandelions_Bloom_1992';

processRawTranscriptions(jobId, audioFile, title)
  .then(result => {
    console.log('\nResult:', result);
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
