// State
let selectedJobId = null;
let refreshInterval = null;

// Get base path from server config (set by app-config.js)
const BASE = window.APP_BASE_PATH || '';

// Helper to build API URLs
function api(path) {
  return `${BASE}${path}`;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadJobs();
  loadTranslations();
  loadScannerStatus();
  loadPausedJobs();
  setupEventListeners();

  // Auto-refresh every 5 seconds
  refreshInterval = setInterval(() => {
    loadJobs();
    loadTranslations();
    loadScannerStatus();
    loadPausedJobs();
  }, 5000);
});

// Event Listeners
function setupEventListeners() {
  document.getElementById('submitForm').addEventListener('submit', handleSubmit);
  document.getElementById('refreshBtn').addEventListener('click', loadJobs);
  document.getElementById('refreshTranslationsBtn').addEventListener('click', loadTranslations);
  document.getElementById('deleteJobBtn').addEventListener('click', handleDelete);

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Toggle skipped files
  document.getElementById('toggleSkipped').addEventListener('click', () => {
    const list = document.getElementById('skippedList');
    const btn = document.getElementById('toggleSkipped');
    list.classList.toggle('hidden');
    btn.textContent = list.classList.contains('hidden') ? 'Show' : 'Hide';
  });

  // Toggle found subtitles
  document.getElementById('toggleFound').addEventListener('click', () => {
    const list = document.getElementById('foundList');
    const btn = document.getElementById('toggleFound');
    list.classList.toggle('hidden');
    btn.textContent = list.classList.contains('hidden') ? 'Show' : 'Hide';
  });

  // Manual scan button
  document.getElementById('scanNowBtn').addEventListener('click', triggerScan);

  // Reset all processed files
  document.getElementById('resetAllBtn').addEventListener('click', resetAllProcessed);

  // Clear queue button
  document.getElementById('clearQueueBtn').addEventListener('click', clearQueue);

  // Refresh paused jobs
  document.getElementById('refreshPausedBtn').addEventListener('click', loadPausedJobs);

  // File upload handling
  setupFileUpload();
}

// Switch between tabs
function switchTab(tabName) {
  // Update button states
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab content
  document.getElementById('uploadTab').classList.toggle('active', tabName === 'upload');
  document.getElementById('youtubeTab').classList.toggle('active', tabName === 'youtube');
}

// Setup file upload (drag & drop + click)
function setupFileUpload() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('audioFileInput');

  // Click to select file
  dropZone.addEventListener('click', () => {
    if (!dropZone.classList.contains('uploading')) {
      fileInput.click();
    }
  });

  // File selected
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });

  // Drag events
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  });
}

// Handle file upload
async function handleFileUpload(file) {
  const title = document.getElementById('uploadTitle').value.trim();

  if (!title) {
    alert('Please enter a movie title first!');
    document.getElementById('uploadTitle').focus();
    return;
  }

  // Validate file type
  const validTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/ogg', 'audio/flac', 'audio/x-m4a'];
  if (!validTypes.includes(file.type) && !file.name.match(/\.(mp3|wav|m4a|ogg|flac)$/i)) {
    alert('Please upload an audio file (MP3, WAV, M4A, OGG, or FLAC)');
    return;
  }

  const dropZone = document.getElementById('dropZone');
  const progressContainer = document.getElementById('uploadProgress');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressText = document.getElementById('uploadProgressText');
  const dropContent = dropZone.querySelector('.drop-zone-content');

  // Show uploading state
  dropZone.classList.add('uploading');
  dropContent.style.display = 'none';
  progressContainer.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = 'Uploading...';

  try {
    // Use XMLHttpRequest for progress tracking
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = percent + '%';
          progressText.textContent = `Uploading: ${percent}%`;
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('Invalid server response'));
          }
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.error || 'Upload failed'));
          } catch {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

      xhr.open('POST', api(`/api/upload-audio?title=${encodeURIComponent(title)}`));
      xhr.setRequestHeader('Content-Type', 'audio/mpeg');
      xhr.send(file);
    });

    progressFill.style.width = '100%';
    progressText.textContent = 'Processing started!';

    // Reset after delay
    setTimeout(() => {
      dropZone.classList.remove('uploading');
      dropContent.style.display = 'flex';
      progressContainer.classList.add('hidden');
      document.getElementById('uploadTitle').value = '';
      document.getElementById('audioFileInput').value = '';
    }, 2000);

    alert(`Audio uploaded successfully! Job ID: ${result.jobId}\n\nProcessing has started.`);
    loadJobs();

  } catch (error) {
    // Reset on error
    dropZone.classList.remove('uploading');
    dropContent.style.display = 'flex';
    progressContainer.classList.add('hidden');

    alert(`Upload failed: ${error.message}`);
  }
}

// Submit new job
async function handleSubmit(e) {
  e.preventDefault();
  
  const formData = new FormData(e.target);
  const data = {
    youtubeUrl: formData.get('youtubeUrl'),
    imdbId: formData.get('imdbId'),
    title: formData.get('title')
  };
  
  try {
    const response = await fetch(api('/api/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) throw new Error('Failed to submit job');
    
    const result = await response.json();
    
    // Reset form
    e.target.reset();
    
    // Show success
    alert(`Job submitted successfully! ID: ${result.jobId}`);
    
    // Reload jobs
    loadJobs();
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Load all jobs
async function loadJobs() {
  try {
    const response = await fetch(api('/api/jobs'));
    if (!response.ok) throw new Error('Failed to load jobs');

    const jobs = await response.json();
    renderJobs(jobs);
  } catch (error) {
    console.error('Error loading jobs:', error);
  }
}

// Load translation folders
async function loadTranslations() {
  try {
    const response = await fetch(api('/api/translations'));
    if (!response.ok) throw new Error('Failed to load translations');

    const translations = await response.json();
    renderTranslations(translations);
  } catch (error) {
    console.error('Error loading translations:', error);
  }
}

// Load scanner and queue status
async function loadScannerStatus() {
  try {
    const response = await fetch(api('/api/status'));
    if (!response.ok) throw new Error('Failed to load status');

    const status = await response.json();
    renderScannerStatus(status);
  } catch (error) {
    console.error('Error loading scanner status:', error);
    document.getElementById('scannerStatus').textContent = 'Error';
    document.getElementById('scannerStatus').className = 'scanner-badge error';
  }
}

// Render scanner status
function renderScannerStatus(status) {
  const { scanner, queue, skippedFiles, config } = status;

  // Update badge
  const badge = document.getElementById('scannerStatus');
  if (queue.isProcessing) {
    badge.textContent = 'Processing';
    badge.className = 'scanner-badge processing';
  } else if (queue.pendingJobs > 0) {
    badge.textContent = `${queue.pendingJobs} Queued`;
    badge.className = 'scanner-badge queued';
  } else {
    badge.textContent = 'Idle';
    badge.className = 'scanner-badge idle';
  }

  // Update stats
  document.getElementById('statTotalFiles').textContent = scanner.totalFiles;
  document.getElementById('statProcessed').textContent = scanner.processedCount;
  document.getElementById('statPending').textContent = scanner.pendingInDir;
  document.getElementById('statQueued').textContent = queue.pendingJobs;

  // Show current job
  const currentJobEl = document.getElementById('currentJob');
  if (queue.isProcessing && queue.pendingTitles.length >= 0) {
    // Get current processing job from the jobs list
    const processingJobs = document.querySelectorAll('.job-card.processing');
    if (processingJobs.length > 0) {
      const title = processingJobs[0].querySelector('.job-title')?.textContent || 'Processing...';
      document.getElementById('currentJobTitle').textContent = title;
      currentJobEl.classList.remove('hidden');
    }
  } else {
    currentJobEl.classList.add('hidden');
  }

  // Show queue
  const queueListEl = document.getElementById('queueList');
  if (queue.pendingJobs > 0) {
    document.getElementById('queueTitles').textContent = queue.pendingTitles.join(', ');
    queueListEl.classList.remove('hidden');
  } else {
    queueListEl.classList.add('hidden');
  }

  // Render skipped files and found subtitles
  renderSkippedFiles(skippedFiles, config);
  renderFoundSubtitles(skippedFiles);
}

// Render found subtitles (downloaded from OpenSubtitles)
function renderFoundSubtitles(skippedFiles) {
  const container = document.getElementById('foundList');
  const foundFiles = (skippedFiles || []).filter(f => f.details?.downloaded === true);

  // Update count
  document.getElementById('statFound').textContent = foundFiles.length;

  if (foundFiles.length === 0) {
    container.innerHTML = '<p class="empty-state-small">No subtitles downloaded yet</p>';
    return;
  }

  container.innerHTML = foundFiles.map(f => {
    const matchTitle = f.details?.matchTitle || 'Unknown';
    return `
      <div class="found-item">
        <div class="found-info">
          <span class="found-filename">${escapeHtml(f.filename)}</span>
          <span class="found-match">Matched: ${escapeHtml(matchTitle)}</span>
        </div>
        <div class="found-actions">
          ${f.details?.imdbId ? `<a href="https://www.imdb.com/title/${f.details.imdbId}" target="_blank" class="imdb-link">${f.details.imdbId}</a>` : ''}
          <span class="found-time">${formatTime(f.timestamp)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Render skipped files list
function renderSkippedFiles(skippedFiles, config) {
  const container = document.getElementById('skippedList');

  // Filter out downloaded files (shown in Found section)
  const nonDownloadedFiles = (skippedFiles || []).filter(f => f.details?.downloaded !== true);

  if (nonDownloadedFiles.length === 0) {
    container.innerHTML = '<p class="empty-state-small">No files skipped yet</p>';
    return;
  }

  const reasonLabels = {
    'has_embedded_subtitles': '📎 Embedded subs',
    'found_on_opensubtitles': '🌐 On OpenSubtitles',
    'downloaded_from_opensubtitles': '📥 Downloaded',
    'has_existing_translation': '📂 Already transcribed'
  };

  container.innerHTML = nonDownloadedFiles.map(f => {
    const reason = reasonLabels[f.reason] || f.reason;
    let details = '';

    if (f.details?.languages) {
      details = ` (${f.details.languages.join(', ')})`;
    }
    if (f.details?.folder) {
      details = ` (${escapeHtml(f.details.folder)})`;
    }
    if (f.details?.imdbId) {
      details += ` <a href="https://www.imdb.com/title/${f.details.imdbId}" target="_blank" class="imdb-link">${f.details.imdbId}</a>`;
    }

    return `
      <div class="skipped-item">
        <span class="skipped-filename">${escapeHtml(f.filename)}</span>
        <span class="skipped-reason">${reason}${details}</span>
        <div class="skipped-actions">
          <button onclick="resetFile('${escapeHtml(f.filename)}')" class="btn-tiny" title="Re-check this file">↻</button>
          <span class="skipped-time">${formatTime(f.timestamp)}</span>
        </div>
      </div>
    `;
  }).join('');

  // Add config warning if OpenSubtitles not configured
  if (!config.opensubtitlesConfigured) {
    container.innerHTML = `
      <div class="config-warning">
        ⚠️ OpenSubtitles API not configured. Add OPENSUBTITLES_API_KEY to .env for online subtitle checking.
      </div>
    ` + container.innerHTML;
  }
}

// Render translations list
function renderTranslations(translations) {
  const container = document.getElementById('translationsList');

  if (translations.length === 0) {
    container.innerHTML = '<p class="empty-state">No translation chunks found. Process a video first!</p>';
    return;
  }

  container.innerHTML = translations.map(t => `
    <div class="translation-card">
      <div class="translation-header">
        <div class="translation-name">${escapeHtml(t.name)}</div>
        <div class="translation-progress ${t.progress === 100 ? 'complete' : ''}">${t.progress}%</div>
      </div>
      <div class="translation-meta">
        <span>${t.jsonFiles} chunk${t.jsonFiles > 1 ? 's' : ''}</span>
        <span>${t.translatedEntries}/${t.totalEntries} entries translated</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill ${t.progress === 100 ? 'complete' : ''}" style="width: ${t.progress}%"></div>
      </div>
      <div class="translation-actions">
        <button onclick="showTranslationDetails('${escapeHtml(t.name)}')" class="btn-secondary btn-small">
          View Chunks
        </button>
        <button onclick="mergeTranslation('${escapeHtml(t.name)}')" class="btn-submit btn-small" ${t.progress === 0 ? 'disabled' : ''}>
          Merge to SRT
        </button>
      </div>
    </div>
  `).join('');
}

// Show translation chunk details
async function showTranslationDetails(folder) {
  try {
    const response = await fetch(api(`/api/translations/${encodeURIComponent(folder)}`));
    if (!response.ok) throw new Error('Failed to load details');

    const data = await response.json();

    const chunksHtml = data.chunks.map(c => `
      <div class="chunk-item">
        <div class="chunk-info">
          <span class="chunk-name">${escapeHtml(c.file)}</span>
          <span class="chunk-progress">${c.translated}/${c.entries} (${c.progress}%)</span>
        </div>
        <div class="chunk-actions">
          ${c.slimFile ? `
            <a href="${BASE}/output/translation_chunks/${encodeURIComponent(folder)}/${encodeURIComponent(c.slimFile)}"
               download class="btn-link" title="Slim JSON for LLM (id + text only)">📤 For LLM</a>
          ` : ''}
          <a href="${BASE}/output/translation_chunks/${encodeURIComponent(folder)}/${encodeURIComponent(c.file)}"
             download class="btn-link" title="Full JSON with timestamps">📥 Full</a>
          <label class="btn-link upload-label" title="Upload translated JSON">
            📥 Import
            <input type="file" accept=".json" onchange="uploadChunk('${escapeHtml(folder)}', '${escapeHtml(c.slimFile || c.file)}', this)" hidden>
          </label>
        </div>
      </div>
    `).join('');

    document.getElementById('modalTitle').textContent = `Translation Chunks: ${folder}`;
    document.getElementById('jobDetails').innerHTML = `
      <div style="margin-bottom: 15px; font-size: 0.9rem;">
        <p style="margin-bottom: 8px;"><strong>Workflow:</strong></p>
        <ol style="margin: 0; padding-left: 20px; color: #666;">
          <li>Download "For LLM" (slim JSON with id + text only)</li>
          <li>Translate the "text" field in each entry</li>
          <li>Upload the translated file using "Import"</li>
          <li>Repeat for all chunks, then merge to SRT</li>
        </ol>
      </div>
      <div class="chunks-list">
        ${chunksHtml}
      </div>
    `;
    document.getElementById('jobLogs').innerHTML = '';
    document.getElementById('deleteJobBtn').style.display = 'none';

    document.getElementById('jobModal').classList.remove('hidden');
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Upload translated chunk
async function uploadChunk(folder, filename, input) {
  const file = input.files[0];
  if (!file) return;

  try {
    const content = await file.text();

    // Validate JSON
    JSON.parse(content);

    const response = await fetch(api(`/api/translations/${encodeURIComponent(folder)}/upload?filename=${encodeURIComponent(filename)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: content
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Upload failed');
    }

    // Show appropriate message based on response
    if (result.imported !== undefined) {
      alert(`Imported ${result.imported}/${result.total} translations!`);
    } else {
      alert(result.message || 'Uploaded successfully!');
    }

    loadTranslations();
    showTranslationDetails(folder); // Refresh the modal
  } catch (error) {
    alert(`Error: ${error.message}`);
  }

  // Reset input
  input.value = '';
}

// Merge translation chunks
async function mergeTranslation(folder) {
  if (!confirm(`Merge all translated chunks for "${folder}" into an SRT file?`)) {
    return;
  }

  try {
    const response = await fetch(api(`/api/translations/${encodeURIComponent(folder)}/merge`), {
      method: 'POST'
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Merge failed');
    }

    alert(`Merged successfully!\n\nOutput: output/subtitles/${result.outputFile}`);
    loadTranslations();
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Render jobs list
function renderJobs(jobs) {
  const container = document.getElementById('jobsList');
  
  if (jobs.length === 0) {
    container.innerHTML = '<p class="empty-state">No jobs yet. Submit a video to get started!</p>';
    return;
  }
  
  // Sort by creation date (newest first)
  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  container.innerHTML = jobs.map(job => `
    <div class="job-card ${job.status}" onclick="showJobDetails('${job.id}')">
      <div class="job-header">
        <div class="job-title">${escapeHtml(job.title)}</div>
        <div class="job-status status-${job.status}">${job.status}</div>
      </div>
      <div class="job-meta">
        <div>ID: ${job.id}</div>
        <div>Created: ${formatDate(job.createdAt)}</div>
        ${job.imdbId ? `<div>IMDB: ${job.imdbId}</div>` : ''}
      </div>
      ${job.status === 'processing' ? `
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${job.progress}%"></div>
        </div>
        <div style="font-size: 0.85rem; color: #666; margin-top: 5px;">
          ${job.progress}% - ${job.logs[job.logs.length - 1]?.message || 'Processing...'}
        </div>
      ` : ''}
    </div>
  `).join('');
}

// Show job details modal
async function showJobDetails(jobId) {
  selectedJobId = jobId;

  try {
    const response = await fetch(api(`/api/jobs/${jobId}`));
    if (!response.ok) throw new Error('Failed to load job details');

    const job = await response.json();

    // Show delete button for job details
    document.getElementById('deleteJobBtn').style.display = 'inline-block';

    // Update modal content
    document.getElementById('modalTitle').textContent = `${job.title} - ${job.status}`;
    
    document.getElementById('jobDetails').innerHTML = `
      <div class="detail-row">
        <span class="detail-label">Job ID:</span>
        <span class="detail-value">${job.id}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Status:</span>
        <span class="detail-value">${job.status}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Progress:</span>
        <span class="detail-value">${job.progress}%</span>
      </div>
      ${job.youtubeUrl ? `
      <div class="detail-row">
        <span class="detail-label">YouTube URL:</span>
        <span class="detail-value"><a href="${job.youtubeUrl}" target="_blank">Open</a></span>
      </div>
      ` : `
      <div class="detail-row">
        <span class="detail-label">Source:</span>
        <span class="detail-value">Uploaded Audio</span>
      </div>
      `}
      ${job.imdbId ? `
        <div class="detail-row">
          <span class="detail-label">IMDB ID:</span>
          <span class="detail-value">${job.imdbId}</span>
        </div>
      ` : ''}
      <div class="detail-row">
        <span class="detail-label">Created:</span>
        <span class="detail-value">${formatDate(job.createdAt)}</span>
      </div>
      ${job.updatedAt ? `
        <div class="detail-row">
          <span class="detail-label">Updated:</span>
          <span class="detail-value">${formatDate(job.updatedAt)}</span>
        </div>
      ` : ''}
      ${job.result ? `
        <div class="detail-row">
          <span class="detail-label">Output:</span>
          <span class="detail-value">
            ${job.result.subtitleFile ? `<a href="${BASE}/output/subtitles/${job.result.subtitleFile}" target="_blank">Download SRT</a>` : 'N/A'}
          </span>
        </div>
      ` : ''}
    `;
    
    // Render logs
    document.getElementById('jobLogs').innerHTML = job.logs.map(log => `
      <div class="log-entry">
        <span class="log-time">${formatTime(log.time)}</span>
        <span>${escapeHtml(log.message)}</span>
      </div>
    `).join('');
    
    // Show modal
    document.getElementById('jobModal').classList.remove('hidden');
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Close modal
function closeModal() {
  document.getElementById('jobModal').classList.add('hidden');
  selectedJobId = null;
}

// Delete job
async function handleDelete() {
  if (!selectedJobId) return;
  
  if (!confirm('Are you sure you want to delete this job?')) return;
  
  try {
    const response = await fetch(api(`/api/jobs/${selectedJobId}`), {
      method: 'DELETE'
    });
    
    if (!response.ok) throw new Error('Failed to delete job');
    
    closeModal();
    loadJobs();
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Clear the processing queue
async function clearQueue() {
  const clearAll = confirm('Clear ALL jobs including history?\n\nOK = Clear everything\nCancel = Clear only queued jobs (keep completed/failed)');

  try {
    const response = await fetch(api('/api/jobs/clear'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearAll })
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.error || 'Failed to clear queue');

    alert(result.message);
    loadJobs();
    loadScannerStatus();
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Trigger manual scan
async function triggerScan() {
  const btn = document.getElementById('scanNowBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';

  try {
    const response = await fetch(api('/api/movies/scan'), { method: 'POST' });
    if (!response.ok) throw new Error('Failed to trigger scan');

    // Refresh status after a short delay
    setTimeout(() => {
      loadScannerStatus();
      loadJobs();
    }, 1000);
  } catch (error) {
    alert(`Error: ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan Now';
  }
}

// Reset all processed files
async function resetAllProcessed() {
  if (!confirm('Reset ALL processed files? This will re-check all movies on the next scan.')) {
    return;
  }

  try {
    const response = await fetch(api('/api/movies/reset-all'), { method: 'POST' });
    const result = await response.json();

    if (!response.ok) throw new Error(result.error || 'Failed to reset');

    alert(result.message);
    loadScannerStatus();
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Reset a single file for re-checking
async function resetFile(filename) {
  if (!confirm(`Reset "${filename}"? It will be re-checked on the next scan.`)) {
    return;
  }

  try {
    const response = await fetch(api('/api/movies/reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.error || 'Failed to reset');

    alert(result.message);
    loadScannerStatus();
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Utility functions
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatTime(dateString) {
  const date = new Date(dateString);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// === Paused Jobs Management ===

// Load paused jobs
async function loadPausedJobs() {
  try {
    const response = await fetch(api('/api/paused-jobs'));
    if (!response.ok) throw new Error('Failed to load paused jobs');

    const data = await response.json();
    renderPausedJobs(data.jobs || []);
  } catch (error) {
    console.error('Error loading paused jobs:', error);
  }
}

// Render paused jobs list
function renderPausedJobs(jobs) {
  const container = document.getElementById('pausedJobsList');

  if (jobs.length === 0) {
    container.innerHTML = '<p class="empty-state">No paused jobs. Enable PAUSE_AFTER_DEMUCS in config to use this feature.</p>';
    return;
  }

  container.innerHTML = jobs.map(job => `
    <div class="paused-card">
      <div class="paused-header">
        <div class="paused-title">${escapeHtml(job.title)}</div>
        <div class="paused-meta">${job.chunkCount} chunks ready</div>
      </div>
      <div class="paused-info">
        <span>Job ID: ${job.jobId}</span>
        <span>Paused: ${formatDate(job.pausedAt)}</span>
      </div>
      <div class="paused-actions">
        <button onclick="resumePausedJob('${job.jobId}')" class="btn-submit btn-small">
          ▶️ Resume Transcription
        </button>
      </div>
    </div>
  `).join('');
}

// Resume a paused job
async function resumePausedJob(jobId) {
  if (!confirm(`Resume transcription for job ${jobId}?\n\nThis will start the Whisper transcription process.`)) {
    return;
  }

  try {
    const response = await fetch(api(`/api/paused-jobs/${jobId}/resume`), {
      method: 'POST'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to resume job');
    }

    const result = await response.json();
    alert(`Resume started!\n\nNew job ID: ${result.jobId}`);

    // Refresh lists
    loadPausedJobs();
    loadJobs();
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

// Close modal on outside click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('jobModal');
  if (e.target === modal) {
    closeModal();
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
