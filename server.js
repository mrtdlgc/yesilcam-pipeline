import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { execSync } from 'child_process';
import { processMovie, processAudioFile, processVideoFile, resumePausedJob, listPausedJobs } from './scripts/pipeline.js';
import { mergeTranslatedChunks, importSlimTranslation } from './scripts/4_chunk_srt.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '';  // e.g., '/yesilcam-pipeline'

// Middleware
app.use(express.json());

// Serve config with base path for frontend
app.get(`${BASE_PATH}/app-config.js`, (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_BASE_PATH = '${BASE_PATH}';`);
});

// Static files under base path
app.use(`${BASE_PATH}`, express.static('public'));

// In-memory job queue (use Redis/DB for production)
const jobs = new Map();

// Simple lock to prevent concurrent file writes
let isWriting = false;
const writeQueue = [];

// Sequential processing queue - only one job processes at a time
let isProcessing = false;
const pendingJobs = [];

// Ensure directories exist
await fs.mkdir('./temp', { recursive: true });
await fs.mkdir('./output/subtitles', { recursive: true });
await fs.mkdir('./output/translation_chunks', { recursive: true });
await fs.mkdir('./data', { recursive: true });
await fs.mkdir('./movies', { recursive: true });
await fs.mkdir('./found', { recursive: true });

// Video file extensions to watch
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];

// Movies directory scanner interval (check every 60 seconds)
const MOVIES_SCAN_INTERVAL = 60 * 1000;

// Initialize processing queue file
try {
  await fs.access('./data/processing-queue.json');
} catch {
  await fs.writeFile('./data/processing-queue.json', JSON.stringify({ jobs: [] }, null, 2));
}

// API Routes (all prefixed with BASE_PATH)

// Get all jobs
app.get(`${BASE_PATH}/api/jobs`, async (req, res) => {
  try {
    const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
    const queue = JSON.parse(data);
    res.json(queue.jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit new job
app.post(`${BASE_PATH}/api/jobs`, async (req, res) => {
  const { youtubeUrl, imdbId, title } = req.body;
  
  if (!youtubeUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const jobId = Date.now().toString();
  const job = {
    id: jobId,
    youtubeUrl,
    imdbId,
    title: title || 'Unknown',
    status: 'queued',
    progress: 0,
    createdAt: new Date().toISOString(),
    logs: []
  };

  // Save to queue
  const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
  const queue = JSON.parse(data);
  queue.jobs.push(job);
  await fs.writeFile('./data/processing-queue.json', JSON.stringify(queue, null, 2));

  // Add to processing queue (sequential - only one at a time)
  queueJob({ type: 'youtube', job });

  res.json({ jobId, message: 'Job queued successfully' });
});

// Get job status
app.get(`${BASE_PATH}/api/jobs/:id`, async (req, res) => {
  try {
    const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
    const queue = JSON.parse(data);
    const job = queue.jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete job
app.delete(`${BASE_PATH}/api/jobs/:id`, async (req, res) => {
  try {
    const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
    const queue = JSON.parse(data);
    queue.jobs = queue.jobs.filter(j => j.id !== req.params.id);
    await fs.writeFile('./data/processing-queue.json', JSON.stringify(queue, null, 2));
    res.json({ message: 'Job deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear all jobs from queue (both file and in-memory)
app.post(`${BASE_PATH}/api/jobs/clear`, async (req, res) => {
  try {
    // Clear in-memory pending jobs
    const pendingCount = pendingJobs.length;
    pendingJobs.length = 0;

    // Clear jobs from file (keep only completed/failed for history, or clear all)
    const { clearAll } = req.body || {};
    const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
    const queue = JSON.parse(data);

    let clearedCount = 0;
    if (clearAll) {
      clearedCount = queue.jobs.length;
      queue.jobs = [];
    } else {
      // Only clear queued jobs, keep completed/failed for history
      const before = queue.jobs.length;
      queue.jobs = queue.jobs.filter(j => j.status === 'completed' || j.status === 'failed');
      clearedCount = before - queue.jobs.length;
    }

    await fs.writeFile('./data/processing-queue.json', JSON.stringify(queue, null, 2));

    console.log(`Cleared queue: ${clearedCount} jobs from file, ${pendingCount} from memory`);
    res.json({
      message: `Cleared ${clearedCount} jobs`,
      clearedFromFile: clearedCount,
      clearedFromMemory: pendingCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Paused Jobs API ===
// List all paused jobs (ready for resume)
app.get(`${BASE_PATH}/api/paused-jobs`, async (req, res) => {
  try {
    const paused = await listPausedJobs();
    res.json({ jobs: paused });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resume a paused job
app.post(`${BASE_PATH}/api/paused-jobs/:jobId/resume`, async (req, res) => {
  try {
    const { jobId } = req.params;

    // Create a new job entry for tracking
    const newJobId = `resume_${jobId}_${Date.now()}`;
    jobs.set(newJobId, {
      id: newJobId,
      originalJobId: jobId,
      type: 'resume',
      status: 'processing',
      progress: 0,
      message: 'Resuming transcription...',
      startedAt: new Date().toISOString()
    });

    res.json({
      message: 'Resume started',
      jobId: newJobId,
      originalJobId: jobId
    });

    // Process in background
    resumePausedJob(jobId, (progress, message) => {
      const job = jobs.get(newJobId);
      if (job) {
        job.progress = progress;
        job.message = message;
      }
    }).then(result => {
      const job = jobs.get(newJobId);
      if (job) {
        job.status = 'completed';
        job.progress = 100;
        job.result = result;
        job.completedAt = new Date().toISOString();
      }
    }).catch(error => {
      const job = jobs.get(newJobId);
      if (job) {
        job.status = 'failed';
        job.error = error.message;
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset a processed file (allow re-check)
app.post(`${BASE_PATH}/api/movies/reset`, async (req, res) => {
  try {
    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    const processed = await loadProcessedFiles();
    const initialCount = processed.files.length;
    processed.files = processed.files.filter(f => f !== filename);

    if (processed.files.length === initialCount) {
      return res.status(404).json({ error: 'File not found in processed list' });
    }

    await fs.writeFile('./data/processed-movies.json', JSON.stringify(processed, null, 2));

    console.log(`Reset processed status for: ${filename}`);
    res.json({ message: `File "${filename}" will be re-checked on next scan` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset all processed files (re-check everything)
app.post(`${BASE_PATH}/api/movies/reset-all`, async (req, res) => {
  try {
    const processed = await loadProcessedFiles();
    const count = processed.files.length;

    await fs.writeFile('./data/processed-movies.json', JSON.stringify({ files: [] }, null, 2));

    console.log(`Reset all ${count} processed files`);
    res.json({ message: `Reset ${count} files. All movies will be re-checked on next scan.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all processed files
app.get(`${BASE_PATH}/api/movies/processed`, async (req, res) => {
  try {
    const processed = await loadProcessedFiles();
    res.json(processed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger immediate scan of movies directory
app.post(`${BASE_PATH}/api/movies/scan`, async (req, res) => {
  try {
    console.log('Manual scan triggered');
    scanMoviesDirectory();
    res.json({ message: 'Scan triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List found subtitles (downloaded from OpenSubtitles)
app.get(`${BASE_PATH}/api/found`, async (req, res) => {
  try {
    const files = await fs.readdir('./found');
    const srtFiles = files.filter(f => f.endsWith('.srt'));

    const results = [];
    for (const file of srtFiles) {
      const filePath = `./found/${file}`;
      const stats = await fs.stat(filePath);
      results.push({
        filename: file,
        size: stats.size,
        downloadedAt: stats.mtime.toISOString()
      });
    }

    // Sort by date (newest first)
    results.sort((a, b) => new Date(b.downloadedAt) - new Date(a.downloadedAt));

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve found subtitles
app.use(`${BASE_PATH}/found`, express.static('found'));

// Process job asynchronously
async function processJobAsync(job) {
  try {
    await updateJobStatus(job.id, 'processing', 0, 'Starting pipeline...');
    
    const result = await processMovie(job.youtubeUrl, job.imdbId, (progress, message) => {
      updateJobStatus(job.id, 'processing', progress, message);
    });
    
    await updateJobStatus(job.id, 'completed', 100, 'Processing complete!', result);
  } catch (error) {
    await updateJobStatus(job.id, 'failed', 0, `Error: ${error.message}`);
  }
}

// Update job status with file locking to prevent race conditions
async function updateJobStatus(jobId, status, progress, message, result = null) {
  return new Promise((resolve, reject) => {
    const writeOperation = async () => {
      try {
        const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
        const queue = JSON.parse(data);
        const job = queue.jobs.find(j => j.id === jobId);

        if (job) {
          job.status = status;
          job.progress = progress;
          job.logs.push({ time: new Date().toISOString(), message });
          job.updatedAt = new Date().toISOString();
          if (result) job.result = result;

          await fs.writeFile('./data/processing-queue.json', JSON.stringify(queue, null, 2));
        }

        isWriting = false;
        if (writeQueue.length > 0) {
          const next = writeQueue.shift();
          isWriting = true;
          next();
        }
        resolve();
      } catch (error) {
        isWriting = false;
        if (writeQueue.length > 0) {
          const next = writeQueue.shift();
          isWriting = true;
          next();
        }
        reject(error);
      }
    };

    if (isWriting) {
      writeQueue.push(writeOperation);
    } else {
      isWriting = true;
      writeOperation();
    }
  });
}

// List available translation chunk folders
app.get(`${BASE_PATH}/api/translations`, async (req, res) => {
  try {
    const chunksDir = './output/translation_chunks';

    try {
      await fs.access(chunksDir);
    } catch {
      return res.json([]);
    }

    const folders = await fs.readdir(chunksDir);
    const results = [];

    for (const folder of folders) {
      const folderPath = path.join(chunksDir, folder);
      const stat = await fs.stat(folderPath);

      if (stat.isDirectory()) {
        const files = await fs.readdir(folderPath);
        // Only count full JSON files (not _translate.json slim files)
        const fullJsonFiles = files.filter(f => f.endsWith('.json') && !f.includes('_translate'));
        const slimJsonFiles = files.filter(f => f.includes('_translate.json'));

        // Check translation progress from full JSON files
        let translated = 0;
        let total = 0;

        for (const jsonFile of fullJsonFiles) {
          const content = await fs.readFile(path.join(folderPath, jsonFile), 'utf-8');
          const data = JSON.parse(content);
          total += data.entries.length;
          translated += data.entries.filter(e => e.translated && e.translated.trim()).length;
        }

        results.push({
          name: folder,
          path: folderPath,
          jsonFiles: fullJsonFiles.length,
          slimFiles: slimJsonFiles.length,
          totalEntries: total,
          translatedEntries: translated,
          progress: total > 0 ? Math.round((translated / total) * 100) : 0
        });
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get translation folder details
app.get(`${BASE_PATH}/api/translations/:folder`, async (req, res) => {
  try {
    const folderPath = path.join('./output/translation_chunks', req.params.folder);

    try {
      await fs.access(folderPath);
    } catch {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const files = await fs.readdir(folderPath);
    const fullJsonFiles = files.filter(f => f.endsWith('.json') && !f.includes('_translate')).sort();
    let slimJsonFiles = files.filter(f => f.includes('_translate.json')).sort();

    const chunks = [];
    for (const jsonFile of fullJsonFiles) {
      const content = await fs.readFile(path.join(folderPath, jsonFile), 'utf-8');
      const data = JSON.parse(content);
      const translated = data.entries.filter(e => e.translated && e.translated.trim()).length;

      // Find matching slim file
      const chunkNum = jsonFile.match(/_chunk_(\d+)\.json$/)?.[1];
      let slimFile = slimJsonFiles.find(f => f.includes(`_chunk_${chunkNum}_translate`));

      // Auto-generate slim file if missing
      if (!slimFile && chunkNum) {
        const baseName = jsonFile.replace(/_chunk_\d+\.json$/, '');
        const slimFilename = `${baseName}_chunk_${chunkNum}_translate.json`;
        const slimPath = path.join(folderPath, slimFilename);

        const slimData = {
          entries: data.entries.map(e => ({
            id: e.id,
            text: e.original
          }))
        };

        await fs.writeFile(slimPath, JSON.stringify(slimData, null, 2), 'utf-8');
        slimFile = slimFilename;
        console.log(`Generated missing slim file: ${slimFilename}`);
      }

      chunks.push({
        file: jsonFile,
        slimFile: slimFile || null,
        entries: data.entries.length,
        translated,
        progress: Math.round((translated / data.entries.length) * 100)
      });
    }

    res.json({
      folder: req.params.folder,
      chunks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Merge translated chunks into SRT
app.post(`${BASE_PATH}/api/translations/:folder/merge`, async (req, res) => {
  try {
    const folderPath = path.join('./output/translation_chunks', req.params.folder);

    try {
      await fs.access(folderPath);
    } catch {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const files = await fs.readdir(folderPath);
    // Only merge full JSON files (not slim _translate.json files)
    const jsonFiles = files
      .filter(f => f.endsWith('.json') && !f.includes('_translate'))
      .map(f => path.join(folderPath, f))
      .sort();

    if (jsonFiles.length === 0) {
      return res.status(400).json({ error: 'No JSON files found' });
    }

    const outputPath = path.join('./output/subtitles', `${req.params.folder}_en.srt`);
    await mergeTranslatedChunks(jsonFiles, outputPath);

    res.json({
      success: true,
      outputFile: `${req.params.folder}_en.srt`,
      message: 'Merged successfully!'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload translated JSON file (full or slim format)
app.post(`${BASE_PATH}/api/translations/:folder/upload`, express.text({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const { folder } = req.params;
    const { filename, type } = req.query;

    if (!filename || !filename.endsWith('.json')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const folderPath = path.join('./output/translation_chunks', folder);

    // Verify folder exists
    try {
      await fs.access(folderPath);
    } catch {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Validate JSON
    let parsedData;
    try {
      parsedData = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON content' });
    }

    // Handle slim translation import
    if (type === 'slim' || filename.includes('_translate')) {
      // This is a translated slim file - import into the corresponding full JSON
      const chunkNum = filename.match(/_chunk_(\d+)/)?.[1];
      if (!chunkNum) {
        return res.status(400).json({ error: 'Cannot determine chunk number from filename' });
      }

      // Find the corresponding full JSON file
      const files = await fs.readdir(folderPath);
      const fullJsonFile = files.find(f =>
        f.includes(`_chunk_${chunkNum}.json`) && !f.includes('_translate')
      );

      if (!fullJsonFile) {
        return res.status(400).json({ error: `Full JSON file for chunk ${chunkNum} not found` });
      }

      // Save the slim file first
      const slimFilePath = path.join(folderPath, filename);
      await fs.writeFile(slimFilePath, req.body, 'utf-8');

      // Import into full JSON
      const fullFilePath = path.join(folderPath, fullJsonFile);
      const result = await importSlimTranslation(fullFilePath, slimFilePath);

      res.json({
        success: true,
        message: `Imported ${result.imported}/${result.total} translations`,
        imported: result.imported,
        total: result.total
      });
    } else {
      // Standard full JSON upload
      const filePath = path.join(folderPath, filename);
      await fs.writeFile(filePath, req.body, 'utf-8');
      res.json({ success: true, message: `Saved ${filename}` });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve output files
app.use(`${BASE_PATH}/output`, express.static('output'));

// Upload audio file and process (for when YouTube download doesn't work)
app.post(`${BASE_PATH}/api/upload-audio`, async (req, res) => {
  const jobId = Date.now().toString();
  const tempPath = `./temp/${jobId}_upload.mp3`;

  try {
    // Get title from query param
    const title = req.query.title || 'Uploaded_Audio';

    // Stream the upload to disk
    const writeStream = createWriteStream(tempPath);

    req.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Check file size
    const stats = await fs.stat(tempPath);
    if (stats.size === 0) {
      await fs.unlink(tempPath);
      return res.status(400).json({ error: 'Empty file uploaded' });
    }

    console.log(`Audio uploaded: ${tempPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    // Create job
    const job = {
      id: jobId,
      youtubeUrl: null,
      audioFile: tempPath,
      imdbId: null,
      title: title,
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      logs: []
    };

    // Save to queue
    const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
    const queue = JSON.parse(data);
    queue.jobs.push(job);
    await fs.writeFile('./data/processing-queue.json', JSON.stringify(queue, null, 2));

    // Add to processing queue (sequential - only one at a time)
    queueJob({ type: 'audio', job });

    res.json({ jobId, message: 'Audio uploaded and queued for processing' });
  } catch (error) {
    // Cleanup on error
    try { await fs.unlink(tempPath); } catch {}
    res.status(500).json({ error: error.message });
  }
});

// Process uploaded audio job
async function processAudioJobAsync(job) {
  try {
    await updateJobStatus(job.id, 'processing', 0, 'Starting pipeline with uploaded audio...');

    const result = await processAudioFile(job.audioFile, job.title, (progress, message) => {
      updateJobStatus(job.id, 'processing', progress, message);
    });

    await updateJobStatus(job.id, 'completed', 100, 'Processing complete!', result);
  } catch (error) {
    await updateJobStatus(job.id, 'failed', 0, `Error: ${error.message}`);
  }
}

// Queue a job for sequential processing (only one job runs at a time)
function queueJob(jobData) {
  pendingJobs.push(jobData);
  console.log(`Job ${jobData.job.id} queued. Queue length: ${pendingJobs.length}`);
  processNextJob();
}

// Process the next job in the queue
async function processNextJob() {
  if (isProcessing || pendingJobs.length === 0) {
    return;
  }

  isProcessing = true;
  const jobData = pendingJobs.shift();
  const { type, job } = jobData;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Starting job: ${job.id} (${job.title})`);
  console.log(`Remaining in queue: ${pendingJobs.length}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    if (type === 'youtube') {
      await processJobAsync(job);
    } else if (type === 'audio') {
      await processAudioJobAsync(job);
    } else if (type === 'video') {
      await processVideoJobAsync(job);
    }
  } catch (error) {
    console.error(`Job ${job.id} failed:`, error.message);
  } finally {
    isProcessing = false;
    console.log(`\nJob ${job.id} finished. Checking queue...`);
    // Process next job in queue
    processNextJob();
  }
}

// Process video file from movies directory
async function processVideoJobAsync(job) {
  try {
    await updateJobStatus(job.id, 'processing', 0, 'Starting pipeline with video file...');

    const result = await processVideoFile(job.videoFile, (progress, message) => {
      updateJobStatus(job.id, 'processing', progress, message);
    });

    await updateJobStatus(job.id, 'completed', 100, 'Processing complete!', result);

    // Mark file as processed
    await markFileAsProcessed(job.videoFile);
  } catch (error) {
    await updateJobStatus(job.id, 'failed', 0, `Error: ${error.message}`);
  }
}

// Load list of processed video files
async function loadProcessedFiles() {
  try {
    const data = await fs.readFile('./data/processed-movies.json', 'utf-8');
    return JSON.parse(data);
  } catch {
    return { files: [] };
  }
}

// Mark a file as processed
async function markFileAsProcessed(filePath, reason = 'transcribed') {
  const processed = await loadProcessedFiles();
  const filename = path.basename(filePath);
  if (!processed.files.includes(filename)) {
    processed.files.push(filename);
    await fs.writeFile('./data/processed-movies.json', JSON.stringify(processed, null, 2));
    console.log(`Marked as processed (${reason}): ${filename}`);
  }
}

// Check if video file has embedded subtitles using ffprobe
async function hasEmbeddedSubtitles(filePath) {
  try {
    const result = execSync(
      `ffprobe -v quiet -print_format json -show_streams "${filePath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    const data = JSON.parse(result);
    const subtitleStreams = data.streams?.filter(s => s.codec_type === 'subtitle') || [];

    if (subtitleStreams.length > 0) {
      const languages = subtitleStreams.map(s => s.tags?.language || 'unknown');
      console.log(`  Found ${subtitleStreams.length} embedded subtitle(s): ${languages.join(', ')}`);
      return { found: true, count: subtitleStreams.length, languages };
    }
    return { found: false };
  } catch (error) {
    console.log(`  Warning: Could not check embedded subtitles: ${error.message}`);
    return { found: false };
  }
}

// Extract clean title from filename for comparison
function extractCleanTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, '')  // Remove extension
    .replace(/[\._\-\[\]\(\)]/g, ' ')  // Replace separators with spaces
    .replace(/\b(1080p|720p|480p|2160p|4k|bluray|bdrip|webrip|hdtv|dvdrip|hdrip|web-?dl|x264|x265|hevc|aac|ac3|dts|remux|repack|proper|extended|unrated|directors?\s*cut)\b/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '')  // Remove years
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Calculate similarity between two strings (0-1)
function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) {
    return Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
  }

  // Word-based matching
  const words1 = s1.split(/\s+/).filter(w => w.length > 2);
  const words2 = s2.split(/\s+/).filter(w => w.length > 2);

  if (words1.length === 0 || words2.length === 0) return 0;

  const matchingWords = words1.filter(w => words2.some(w2 => w2.includes(w) || w.includes(w2)));
  return matchingWords.length / Math.max(words1.length, words2.length);
}

// Download subtitle from OpenSubtitles
async function downloadOpenSubtitle(fileId, filename, apiKey) {
  try {
    // First, get the download link
    const downloadResponse = await fetch('https://api.opensubtitles.com/api/v1/download', {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'yesilcam-pipeline v1.0'
      },
      body: JSON.stringify({ file_id: fileId })
    });

    if (!downloadResponse.ok) {
      const errorText = await downloadResponse.text();
      console.log(`  Download API error: ${downloadResponse.status} - ${errorText}`);
      return false;
    }

    const downloadData = await downloadResponse.json();
    const downloadUrl = downloadData.link;

    if (!downloadUrl) {
      console.log('  No download link received');
      return false;
    }

    // Download the actual subtitle file
    const subtitleResponse = await fetch(downloadUrl);
    if (!subtitleResponse.ok) {
      console.log(`  Failed to download subtitle file: ${subtitleResponse.status}`);
      return false;
    }

    const subtitleContent = await subtitleResponse.text();

    // Save to found directory
    const cleanFilename = filename.replace(/\.[^.]+$/, '');
    const outputPath = `./found/${cleanFilename}.srt`;
    await fs.writeFile(outputPath, subtitleContent, 'utf-8');

    console.log(`  ✅ Downloaded subtitle to: ${outputPath}`);
    return true;
  } catch (error) {
    console.log(`  Download error: ${error.message}`);
    return false;
  }
}

// Search OpenSubtitles for existing subtitles (strict matching)
async function searchOpenSubtitles(filename) {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) {
    console.log('  OpenSubtitles API key not configured, skipping online check');
    return null;
  }

  try {
    const cleanTitle = extractCleanTitle(filename);

    // Extract year from filename if present
    const yearMatch = filename.match(/\b(19|20)\d{2}\b/);
    const filenameYear = yearMatch ? yearMatch[0] : null;

    console.log(`  Searching OpenSubtitles for: "${cleanTitle}"${filenameYear ? ` (${filenameYear})` : ''}`);

    const searchParams = {
      query: cleanTitle,
      languages: 'en'  // Only English subs - Turkish films need English translation
    };

    // Add year filter if we have one
    if (filenameYear) {
      searchParams.year = filenameYear;
    }

    const response = await fetch('https://api.opensubtitles.com/api/v1/subtitles?' + new URLSearchParams(searchParams), {
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'yesilcam-pipeline v1.0'
      }
    });

    if (!response.ok) {
      console.log(`  OpenSubtitles API error: ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (data.data && data.data.length > 0) {
      // STRICT MATCHING: Filter results to only those with high similarity
      const validMatches = data.data.filter(sub => {
        const subTitle = sub.attributes?.feature_details?.title ||
                        sub.attributes?.release ||
                        '';
        const subYear = sub.attributes?.feature_details?.year;

        const similarity = calculateSimilarity(cleanTitle, extractCleanTitle(subTitle));

        // Require at least 60% similarity
        if (similarity < 0.6) {
          return false;
        }

        // If we have a year in filename, it should match (within 1 year tolerance)
        if (filenameYear && subYear) {
          const yearDiff = Math.abs(parseInt(filenameYear) - parseInt(subYear));
          if (yearDiff > 1) {
            return false;
          }
        }

        return true;
      });

      if (validMatches.length === 0) {
        console.log(`  Found ${data.data.length} result(s) but none match closely enough`);
        return { found: false };
      }

      // Sort by download count (most popular = likely correct)
      validMatches.sort((a, b) =>
        (b.attributes?.download_count || 0) - (a.attributes?.download_count || 0)
      );

      const bestMatch = validMatches[0];
      const matchTitle = bestMatch.attributes?.feature_details?.title || bestMatch.attributes?.release || 'Unknown';
      const imdbId = bestMatch.attributes?.feature_details?.imdb_id;
      const fileId = bestMatch.attributes?.files?.[0]?.file_id;

      console.log(`  ✓ Found match: "${matchTitle}" (${validMatches.length} valid result(s))`);
      if (imdbId) console.log(`    IMDB: ${imdbId}`);

      // Try to download the subtitle
      let downloaded = false;
      if (fileId) {
        downloaded = await downloadOpenSubtitle(fileId, filename, apiKey);
      }

      return {
        found: true,
        count: validMatches.length,
        languages: ['en'],
        imdbId,
        matchTitle,
        downloaded
      };
    }

    console.log('  No subtitles found on OpenSubtitles');
    return { found: false };
  } catch (error) {
    console.log(`  OpenSubtitles search error: ${error.message}`);
    return null;
  }
}

// Check if we should skip processing this file
async function shouldSkipFile(filePath, filename) {
  console.log(`\n  Checking: ${filename}`);

  // Check 1: Already has translation chunks in output folder
  const translationResult = await hasExistingTranslation(filename);
  if (translationResult.found) {
    return {
      skip: true,
      reason: 'has_existing_translation',
      details: { folder: translationResult.folder }
    };
  }

  // Check 2: Embedded subtitles (only skip if they're in a useful language)
  const embeddedResult = await hasEmbeddedSubtitles(filePath);
  if (embeddedResult.found) {
    // Only skip if embedded subtitles include Turkish or English
    const usefulLanguages = ['tr', 'tur', 'turkish', 'en', 'eng', 'english'];
    const hasUsefulSubs = embeddedResult.languages.some(lang =>
      usefulLanguages.includes((lang || '').toLowerCase())
    );

    if (hasUsefulSubs) {
      return {
        skip: true,
        reason: 'has_embedded_subtitles',
        details: { languages: embeddedResult.languages, count: embeddedResult.count }
      };
    } else {
      console.log(`  Embedded subtitles found (${embeddedResult.languages.join(', ')}) but not in Turkish/English - proceeding`);
    }
  }

  // Check 3: OpenSubtitles database
  const osResult = await searchOpenSubtitles(filename);
  if (osResult?.found) {
    return {
      skip: true,
      reason: osResult.downloaded ? 'downloaded_from_opensubtitles' : 'found_on_opensubtitles',
      imdbId: osResult.imdbId,
      details: {
        languages: osResult.languages,
        count: osResult.count,
        imdbId: osResult.imdbId,
        matchTitle: osResult.matchTitle,
        downloaded: osResult.downloaded
      }
    };
  }

  return { skip: false };
}

// Check if a file is already queued or being processed
function isFileAlreadyQueued(filename) {
  // Check in-memory pending jobs queue
  const inPendingQueue = pendingJobs.some(j =>
    j.job.videoFile && path.basename(j.job.videoFile) === filename
  );
  return inPendingQueue;
}

// Check if translation chunks already exist for this file
async function hasExistingTranslation(filename) {
  try {
    const baseName = filename.replace(/\.[^.]+$/, '');
    const chunksDir = './output/translation_chunks';

    // Check if a folder exists for this movie
    const folders = await fs.readdir(chunksDir);
    for (const folder of folders) {
      // Match folder name to filename (folder might have different naming)
      if (folder.toLowerCase().includes(baseName.toLowerCase().substring(0, 20)) ||
          baseName.toLowerCase().includes(folder.toLowerCase().substring(0, 20))) {
        const folderPath = path.join(chunksDir, folder);
        const stat = await fs.stat(folderPath);
        if (stat.isDirectory()) {
          const files = await fs.readdir(folderPath);
          const jsonFiles = files.filter(f => f.endsWith('.json') && !f.includes('_translate'));
          if (jsonFiles.length > 0) {
            console.log(`  Found existing translation chunks in: ${folder}`);
            return { found: true, folder };
          }
        }
      }
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

// Scan movies directory for new video files
async function scanMoviesDirectory() {
  try {
    const files = await fs.readdir('./movies');
    const processed = await loadProcessedFiles();

    // Get ALL jobs from queue file (any status except completed/failed means it's being worked on)
    let activeJobFiles = [];
    try {
      const queueData = await fs.readFile('./data/processing-queue.json', 'utf-8');
      const queue = JSON.parse(queueData);
      activeJobFiles = queue.jobs
        .filter(j => j.status === 'queued' || j.status === 'processing')
        .map(j => {
          if (j.videoFile) return path.basename(j.videoFile);
          if (j.title) return j.title; // Also match by title
          return null;
        })
        .filter(Boolean);
    } catch {}

    // Also get titles from in-memory queue
    const pendingTitles = pendingJobs.map(j => j.job.title).filter(Boolean);

    // Filter to video files that haven't been processed AND aren't already queued
    const newVideos = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) return false;
      if (processed.files.includes(file)) return false;
      if (activeJobFiles.includes(file)) return false;
      if (isFileAlreadyQueued(file)) return false;

      // Also check by title (filename without extension)
      const title = file.replace(/\.[^.]+$/, '');
      if (activeJobFiles.includes(title)) return false;
      if (pendingTitles.includes(title)) return false;

      return true;
    });

    if (newVideos.length > 0) {
      console.log(`\n📁 Found ${newVideos.length} new video(s) in movies directory`);

      for (const filename of newVideos) {
        const filePath = path.resolve('./movies', filename);
        const jobId = Date.now().toString();

        // Check if file is still being written (size changing)
        const stats1 = await fs.stat(filePath);
        await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds
        const stats2 = await fs.stat(filePath);

        if (stats1.size !== stats2.size) {
          console.log(`  Skipping ${filename} - still downloading...`);
          continue;
        }

        // Check if we should skip this file (has subtitles already)
        const skipCheck = await shouldSkipFile(filePath, filename);
        if (skipCheck.skip) {
          if (skipCheck.details?.downloaded) {
            console.log(`  📥 Downloaded subtitle for ${filename} -> ./found/`);
          } else {
            console.log(`  ⏭️  Skipping ${filename} - ${skipCheck.reason}`);
          }
          logSkippedFile(filename, skipCheck.reason, skipCheck.details || {});
          await markFileAsProcessed(filePath, skipCheck.reason);
          continue;
        }

        const job = {
          id: jobId,
          youtubeUrl: null,
          videoFile: filePath,
          imdbId: skipCheck.imdbId || null,
          title: filename.replace(/\.[^.]+$/, ''),
          status: 'queued',
          progress: 0,
          createdAt: new Date().toISOString(),
          logs: [],
          source: 'movies_directory'
        };

        // Save to queue
        const data = await fs.readFile('./data/processing-queue.json', 'utf-8');
        const queue = JSON.parse(data);
        queue.jobs.push(job);
        await fs.writeFile('./data/processing-queue.json', JSON.stringify(queue, null, 2));

        // Add to processing queue
        queueJob({ type: 'video', job });
        console.log(`  ✅ Queued for transcription: ${filename}`);
      }
    }
  } catch (error) {
    console.error('Error scanning movies directory:', error.message);
  }
}

// Start movies directory scanner
function startMoviesScanner() {
  console.log(`📂 Movies directory scanner active (checking every ${MOVIES_SCAN_INTERVAL / 1000}s)`);
  console.log(`   Drop video files into ./movies/ for automatic processing\n`);

  // Initial scan
  scanMoviesDirectory();

  // Periodic scan
  setInterval(scanMoviesDirectory, MOVIES_SCAN_INTERVAL);
}

// Track skipped files in memory (last 50)
const skippedFilesLog = [];
const MAX_SKIPPED_LOG = 50;

function logSkippedFile(filename, reason, details = {}) {
  skippedFilesLog.unshift({
    filename,
    reason,
    details,
    timestamp: new Date().toISOString()
  });
  if (skippedFilesLog.length > MAX_SKIPPED_LOG) {
    skippedFilesLog.pop();
  }
}

// API: Get scanner and queue status
app.get(`${BASE_PATH}/api/status`, async (req, res) => {
  try {
    // Get movies directory contents
    let movieFiles = [];
    try {
      const files = await fs.readdir('./movies');
      movieFiles = files.filter(f => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    } catch {}

    // Get processed files
    const processed = await loadProcessedFiles();

    // Count pending (not yet processed)
    const pendingInDir = movieFiles.filter(f => !processed.files.includes(f));

    res.json({
      scanner: {
        active: true,
        interval: MOVIES_SCAN_INTERVAL / 1000,
        moviesDir: './movies',
        totalFiles: movieFiles.length,
        processedCount: processed.files.length,
        pendingInDir: pendingInDir.length
      },
      queue: {
        isProcessing,
        pendingJobs: pendingJobs.length,
        pendingTitles: pendingJobs.map(j => j.job.title)
      },
      skippedFiles: skippedFilesLog,
      config: {
        opensubtitlesConfigured: !!process.env.OPENSUBTITLES_API_KEY
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get(`${BASE_PATH}/health`, (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      groq: !!process.env.GROQ_API_KEY,
      openai: !!process.env.OPENAI_API_KEY
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n🎬 Yeşilçam Subtitle Pipeline`);
  console.log(`📡 Server running at http://localhost:${PORT}${BASE_PATH}`);
  if (BASE_PATH) {
    console.log(`📂 Base path: ${BASE_PATH}`);
  }
  console.log(`\n✨ Open your browser and start processing!\n`);

  // Start watching movies directory for new files
  startMoviesScanner();
});
