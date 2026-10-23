import youtubedl from 'youtube-dl-exec';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

export async function downloadVideo(youtubeUrl, jobId) {
  console.log('Downloading audio from YouTube...');
  console.log(`  URL: ${youtubeUrl}`);
  console.log(`  Working dir: ${process.cwd()}`);

  const tempDir = path.resolve('./temp');
  await fs.mkdir(tempDir, { recursive: true });
  console.log(`  Temp dir: ${tempDir}`);

  const outputPath = path.join(tempDir, `${jobId}_raw.%(ext)s`);
  console.log(`  Output template: ${outputPath}`);

  try {
    const result = await youtubedl(youtubeUrl, {
  extractAudio: true,
  format: 'bestaudio/best',
  audioFormat: 'mp3',
  audioQuality: 0,
  output: outputPath,

  // 🚑 FORCE NON-SABR CLIENT
  extractorArgs: {
    youtube: ['player_client=android']
  },

  print: 'after_move:filepath'
});

    console.log(`  yt-dlp result: ${result}`);
  } catch (error) {
    console.error('  yt-dlp error:', error.message);
    if (error.stderr) console.error('  stderr:', error.stderr);
    if (error.stdout) console.error('  stdout:', error.stdout);
    throw new Error(`yt-dlp failed: ${error.message}`);
  }

  // List temp directory contents
  const files = await fs.readdir(tempDir);
  console.log(`  Files in temp after download: ${files.filter(f => f.includes(jobId)).join(', ') || 'none matching jobId'}`);

  // Find the downloaded file
  const expectedFile = path.join(tempDir, `${jobId}_raw.mp3`);

  if (existsSync(expectedFile)) {
    console.log(`✓ Audio downloaded: ${expectedFile}`);
    return expectedFile;
  }

  // Try to find any matching file
  const downloadedFile = files.find(f => f.startsWith(`${jobId}_raw`));

  if (downloadedFile) {
    const audioFile = path.join(tempDir, downloadedFile);
    console.log(`✓ Audio downloaded: ${audioFile}`);
    return audioFile;
  }

  throw new Error(`Download completed but file not found. Expected: ${expectedFile}`);
}
