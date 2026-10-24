export {};
const BASE = window.APP_BASE_PATH || '';
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}
let selectedJobId: string | null = null,
  refreshing = false;
let providersReady = false;
let translationOffset = 0;
let jobOffset = 0,
  queuePaused = false,
  scannerEnabled = false;
const jobPageSize = 50;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: unknown,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function button(text: string, action: () => unknown, className = 'btn-small btn-secondary') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    const wasDisabled = node.disabled;
    if (wasDisabled) return;
    node.disabled = true;
    node.dataset.busy = 'true';
    Promise.resolve()
      .then(action)
      .catch((error) => notice(error.message))
      .finally(() => {
        delete node.dataset.busy;
        node.disabled = wasDisabled;
      });
  });
  return node;
}
function download(text: string, url: string) {
  if (
    typeof url !== 'string' ||
    !(
      /^\/(output|found)\//.test(url) ||
      /^\/api\/reviews\/[a-zA-Z0-9_-]+\/subtitles\/[a-z]{2,3}\.(srt|ass|vtt|json)$/.test(url)
    ) ||
    /[\\\r\n]/.test(url)
  )
    return element('span', 'Unavailable download');
  const node = element('a', text, 'btn-small btn-secondary');
  node.href = `${BASE}${url}`;
  node.download = '';
  return node;
}
const readCache = new Map<string, { at: number; data: unknown }>();
async function occasional(url: string) {
  const cached = readCache.get(url);
  if (cached && Date.now() - cached.at < 30000) return cached.data as any;
  const data = await request(url);
  readCache.set(url, { at: Date.now(), data });
  return data;
}
const responseCache = new Map<string, { etag: string; data: unknown }>();
async function request(url: string, options: RequestInit = {}): Promise<any> {
  const cached = !options.method || options.method === 'GET' ? responseCache.get(url) : undefined;
  if (options.method && options.method !== 'GET') {
    responseCache.clear();
    readCache.clear();
  }
  const response = await fetch(`${BASE}${url}`, {
    ...options,
    headers: {
      'X-Yesilcam-Request': '1',
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401) {
    window.location.assign(`${BASE}/login`);
    throw new Error('Session expired. Sign in again.');
  }
  if (response.status === 304 && cached) return cached.data;
  const data = await response.json().catch(() => {
    throw new Error(`Server returned an unreadable response (${response.status})`);
  });
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  const etag = response.headers.get('etag');
  if (etag && (!options.method || options.method === 'GET')) {
    if (responseCache.size >= 100) responseCache.delete(responseCache.keys().next().value!);
    responseCache.set(url, { etag, data });
  }
  return data;
}
const post = (url: string, data?: unknown) =>
  request(url, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) });
function languages() {
  if (!providersReady)
    throw new Error('Wait for the provider catalog to load, then choose a connection');
  return {
    sourceLanguage: $<HTMLInputElement>('sourceLanguage').value.trim(),
    targetLanguage: $<HTMLInputElement>('targetLanguage').value.trim(),
    provider: $<HTMLSelectElement>('transcriptionProvider').value,
    model: $<HTMLInputElement>('transcriptionModel').value.trim(),
    transcriptionMode: $<HTMLSelectElement>('transcriptionMode').value,
    diarization: String(
      !$<HTMLInputElement>('diarization').disabled && $<HTMLInputElement>('diarization').checked,
    ),
    maxEstimatedCost: $<HTMLInputElement>('maxEstimatedCost').value,
    pricePerMinute: $<HTMLInputElement>('pricePerMinute').value,
    priceCurrency: $<HTMLInputElement>('priceCurrency').value.trim().toUpperCase(),
    alignmentMethod: $<HTMLSelectElement>('alignmentMethod').value,
    pauseBeforeTranscription: String($<HTMLInputElement>('pauseBeforeTranscription').checked),
    translateWithCodex: String($<HTMLInputElement>('translateWithCodex').checked),
    keepIntermediates: String($<HTMLInputElement>('keepIntermediates').checked),
    codexModel: $<HTMLInputElement>('codexModel').value.trim(),
    translationMode: $<HTMLSelectElement>('pipelineTranslationMode').value,
    songReferences: $<HTMLTextAreaElement>('pipelineSongReferences').value.trim(),
  };
}
interface ProviderModel {
  id: string;
  perMinute: number | null;
  currency: string;
  timing: string;
  note?: string;
  preview?: boolean;
  deprecated?: string;
}
interface Provider {
  id: string;
  name: string;
  key: string | null;
  defaultModel: string;
  configured: boolean;
  available: boolean;
  billing: string;
  models: ProviderModel[];
}
interface ProviderCatalog {
  localAudioAvailable: boolean;
  providers: Provider[];
  defaultProvider: string;
  defaultModel: string;
  maxEstimatedCost: number;
  defaultPricePerMinute: number | null;
  defaultPriceCurrency: string;
  checkedAt: string;
}
let providerCatalog: ProviderCatalog | undefined;
function showProviderDetails(reset = false) {
  const p = providerCatalog?.providers.find(
    (p) => p.id === $<HTMLSelectElement>('transcriptionProvider').value,
  );
  if (!p) return;
  $('cloudControls').hidden = p.id === 'local';
  const ageDays = Math.floor(
    (Date.now() - Date.parse(providerCatalog?.checkedAt || '')) / 86400000,
  );
  $('pricingWarning').textContent =
    ageDays > 30
      ? `Prices were checked ${ageDays} days ago. Verify your provider rate and enter a current quote before submitting.`
      : '';
  if (reset) {
    $<HTMLInputElement>('transcriptionModel').value = p.defaultModel;
    $<HTMLInputElement>('pricePerMinute').value = '';
    $<HTMLSelectElement>('transcriptionMode').value = 'auto';
  }
  $('transcriptionModels').replaceChildren(
    ...p.models.map((m) => {
      const option = element('option');
      option.value = m.id;
      return option;
    }),
  );
  const m =
    p.models.find((m) => m.id === $<HTMLInputElement>('transcriptionModel').value) ??
    p.models.find((m) => m.id === p.defaultModel);
  const mode = $<HTMLSelectElement>('transcriptionMode');
  const direct = p.id === 'elevenlabs' && m?.id === 'scribe_v2';
  const scribe = direct || (p.id === 'openrouter' && m?.id === 'elevenlabs/scribe-v2');
  const movieOption = mode.querySelector<HTMLOptionElement>('option[value="movie"]')!;
  movieOption.disabled = !direct;
  if (!direct && mode.value === 'movie') mode.value = 'auto';
  const movie = direct && mode.value !== 'chunks';
  const alignment = $<HTMLSelectElement>('alignmentMethod');
  alignment.querySelector<HTMLOptionElement>('option[value="silero"]')!.disabled =
    providerCatalog?.localAudioAvailable === false;
  alignment.disabled = movie;
  if (movie || (reset && scribe)) alignment.value = 'native';
  else if (reset)
    alignment.value = providerCatalog?.localAudioAvailable === false ? 'native' : 'silero';
  $<HTMLInputElement>('diarization').disabled = !scribe;
  $('transcriptionModeDetails').textContent = movie
    ? 'One continuous movie submission to ElevenLabs. Save a direct ElevenLabs API key in Connections. Uses its word timings and speaker labels; no local VAD or alignment model.'
    : 'Short transcription requests. Local audio checks remain available. Speaker IDs are separate for each request; OpenRouter credits and an ElevenLabs subscription are separate balances.';
  $('providerDetails').textContent =
    `${p.configured ? 'Configured' : 'Add a key in Connections'}. ${p.billing}. ` +
    (m
      ? `${m.perMinute === null ? 'Enter a quoted price' : `${m.currency} ${m.perMinute.toFixed(6)}/minute estimated`}; timing: ${m.timing}. ${m.note ?? ''} ${m.preview ? 'Public preview.' : ''} ${m.deprecated ? `Retires ${m.deprecated}.` : ''}`
      : 'Custom model: save an endpoint in Connections and specify a price.') +
    ` Prices checked ${providerCatalog?.checkedAt}.`;
}
async function loadProviders(reset = true) {
  const previous = $<HTMLSelectElement>('transcriptionProvider').value,
    previousModel = $<HTMLInputElement>('transcriptionModel').value;
  const catalog: ProviderCatalog = await request('/api/transcription-providers');
  providerCatalog = catalog;
  $<HTMLSelectElement>('transcriptionProvider').replaceChildren(
    ...catalog.providers.map((p) => {
      const option = element('option', p.name);
      option.value = p.id;
      option.disabled = p.available === false;
      if (option.disabled) option.textContent += ' (not installed)';
      return option;
    }),
  );
  if (reset) {
    $<HTMLSelectElement>('transcriptionProvider').value =
      catalog.defaultProvider === 'auto' ? 'local' : catalog.defaultProvider;
    $<HTMLInputElement>('maxEstimatedCost').value = String(catalog.maxEstimatedCost);
    showProviderDetails(true);
    $<HTMLInputElement>('pricePerMinute').value =
      catalog.defaultPricePerMinute === null ? '' : String(catalog.defaultPricePerMinute);
    $<HTMLInputElement>('priceCurrency').value = catalog.defaultPriceCurrency;
    if (catalog.defaultModel)
      $<HTMLInputElement>('transcriptionModel').value = catalog.defaultModel;
  } else {
    $<HTMLSelectElement>('transcriptionProvider').value = previous;
    $<HTMLInputElement>('transcriptionModel').value = previousModel;
  }
  providersReady = true;
  showProviderDetails();
}
function empty(container: HTMLElement, message: string) {
  container.replaceChildren(element('p', message, 'empty-state'));
}

interface StageView {
  id: string;
  label: string;
  status: string;
  percentage: number | null;
  completed?: number;
  total?: number;
  unit?: string;
  detail?: string;
}
function stageBars(stages: StageView[] = []) {
  const group = element('div', null, 'pipeline-stages');
  for (const stage of stages) {
    const row = element('div', null, 'pipeline-stage');
    row.dataset.status = stage.status;
    const heading = element('div', null, 'stage-heading');
    const states: Record<string, string> = {
      pending: 'Waiting',
      running: 'Working',
      completed: 'Done',
      skipped: 'Skipped',
      failed: 'Failed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
    };
    const state = states[stage.status] ?? stage.status;
    const measured = stage.percentage !== null && Number.isFinite(stage.percentage);
    const percentage = measured ? Math.max(0, Math.min(100, stage.percentage!)) : null;
    let summary = state;
    if (stage.total && stage.completed !== undefined && stage.status !== 'skipped') {
      summary =
        stage.unit === 'bytes'
          ? `${(stage.completed / 1048576).toFixed(1)} / ${(stage.total / 1048576).toFixed(1)} MB`
          : `${stage.completed}/${stage.total} ${stage.unit ?? ''}`.trim();
      summary += ` · ${percentage === null ? state : `${Math.floor(percentage)}%`}`;
      if (['failed', 'cancelled', 'interrupted'].includes(stage.status)) summary += ` · ${state}`;
    } else if (percentage !== null && stage.status === 'running')
      summary = `${Math.floor(percentage)}%`;
    heading.append(element('strong', stage.label), element('span', summary));
    const bar = element('progress');
    bar.max = 100;
    bar.setAttribute('aria-label', stage.label);
    bar.setAttribute('aria-valuetext', summary);
    if (stage.status === 'running' && percentage === null) bar.removeAttribute('value');
    else bar.value = stage.status === 'skipped' ? 0 : (percentage ?? 0);
    row.append(heading, bar);
    if (stage.detail) row.append(element('p', stage.detail, 'stage-detail'));
    group.append(row);
  }
  return group;
}
function updateJobLive(job: JobView) {
  const progress = document.getElementById('jobStageProgress');
  if (progress) progress.replaceChildren(stageBars(job.stages));
  const status = document.getElementById('jobLiveStatus');
  if (status)
    status.textContent =
      job.status === 'paused'
        ? 'Paused for audio review. Continue to ASR when ready.'
        : `Status: ${job.status}`;
  $('jobLogs').replaceChildren(
    ...(job.logs ?? []).map((log) =>
      element(
        'div',
        `${log.time ? new Date(log.time).toLocaleTimeString() : ''} ${log.message}`,
        'log-entry',
      ),
    ),
  );
}

const jobListSignatures = new Map<string, string>();
function renderJobs(jobs: JobView[], container = 'jobsList') {
  const list = $(container);
  const signature = JSON.stringify(jobs);
  if (
    jobListSignatures.get(container) === signature ||
    list.contains(document.activeElement) ||
    list.querySelector('[data-busy]')
  )
    return;
  jobListSignatures.set(container, signature);
  list.replaceChildren();
  if (!jobs.length)
    return empty(
      list,
      container === 'translationJobs'
        ? 'Whole-film translations will appear here.'
        : 'No jobs yet. Upload audio or add a film to movies/.',
    );
  for (const job of [...jobs].reverse()) {
    const card = element('div', null, 'job-card');
    if (
      [
        'queued',
        'processing',
        'completed',
        'failed',
        'paused',
        'interrupted',
        'cancelled',
      ].includes(job.status)
    )
      card.classList.add(job.status);
    card.append(
      element('h3', job.title, 'job-title'),
      element('p', job.status === 'paused' ? 'Paused for audio review' : job.status),
    );
    card.append(stageBars(job.stages));
    if (
      (job.settings?.PAUSE_BEFORE_TRANSCRIPTION || job.settings?.PAUSE_AFTER_DEMUCS) &&
      ['queued', 'processing'].includes(job.status)
    )
      card.append(
        element(
          'p',
          'Will pause after audio chunking, before speech detection and ASR.',
          'field-note',
        ),
      );
    if (job.error) card.append(element('p', job.error, 'error-message'));
    if (job.type === 'translation' && job.logs?.length)
      card.append(element('p', job.logs.at(-1)?.message, 'field-note'));
    if (job.status === 'completed') {
      const result = job.result;
      if (result?.reviewUrl) {
        const link = element('a', 'Watch & correct', 'btn-small btn-primary');
        link.href = `${BASE}/review-player.html?job=${encodeURIComponent(job.id)}`;
        card.append(link);
      }
      if (result?.reviewStatus === 'preparing')
        card.append(element('p', 'Preparing screening…', 'field-note'));
      else if (!result?.reviewUrl || result?.reviewStatus === 'removed')
        card.append(
          button(
            result?.reviewError ? 'Retry screening preparation' : 'Prepare screening',
            async () => {
              await post(`/api/jobs/${encodeURIComponent(job.id)}/prepare-review`);
              await refresh();
            },
          ),
        );
      if (result?.reviewError) card.append(element('p', result.reviewError, 'error-message'));
      const srt =
        result?.currentSubtitleFile || result?.englishSubtitleFile || result?.subtitleFile;
      const ass = result?.currentAssFile || result?.translatedAssFile || result?.subtitleAssFile;
      if (srt) card.append(download('Download SRT', srt));
      if (ass) card.append(download('Download styled ASS', ass));
    }
    card.append(button('Details', () => showJob(job.id)));
    if (job.type !== 'translation' && !job.intermediatesRemoved && job.progress >= 18)
      card.append(button('Review audio chunks', () => showAudioReview(job.id)));
    if (
      ['paused', 'failed', 'interrupted', 'cancelled'].includes(job.status) &&
      !job.intermediatesRemoved
    ) {
      card.append(
        button(job.status === 'paused' ? 'Continue to ASR' : 'Retry', async () => {
          await post(`/api/jobs/${encodeURIComponent(job.id)}/retry`);
          await refresh();
        }),
      );
    }
    if (['processing', 'queued', 'paused', 'interrupted'].includes(job.status)) {
      card.append(
        button('Cancel', async () => {
          await post(`/api/jobs/${encodeURIComponent(job.id)}/cancel`);
          await refresh();
        }),
      );
    }
    list.append(card);
  }
}

function showModal(title: string) {
  document.querySelectorAll<HTMLAudioElement>('#jobModal audio').forEach((audio) => audio.pause());
  $('modalTitle').textContent = title;
  $('jobDetails').replaceChildren();
  $('jobLogs').replaceChildren();
  if (!$<HTMLDialogElement>('jobModal').open) $<HTMLDialogElement>('jobModal').showModal();
  $('deleteJobBtn').hidden = !selectedJobId;
}
function closeModal() {
  document.querySelectorAll<HTMLAudioElement>('#jobModal audio').forEach((audio) => audio.pause());
  $<HTMLDialogElement>('jobModal').close();
  selectedJobId = null;
}

async function showJob(id: string) {
  const job = await request(`/api/jobs/${encodeURIComponent(id)}`);
  selectedJobId = id;
  showModal(job.title);
  const details = $('jobDetails');
  const status = element('p');
  status.id = 'jobLiveStatus';
  const stages = element('div');
  stages.id = 'jobStageProgress';
  details.append(status, stages);
  updateJobLive(job);
  if (job.type !== 'translation' && !job.intermediatesRemoved && job.progress >= 18)
    details.append(button('Review audio chunks', () => showAudioReview(job.id)));
  if (job.error) details.append(element('p', job.error));
  if (
    ['paused', 'failed', 'interrupted', 'cancelled'].includes(job.status) &&
    !job.intermediatesRemoved &&
    job.type !== 'translation' &&
    job.settings?.TRANSCRIBE_BACKEND !== 'local'
  ) {
    const label = element(
      'label',
      'Estimated usage allowance for retry (same currency as original job) ',
    );
    const limit = element('input');
    limit.type = 'number';
    limit.min = '0.0001';
    limit.step = 'any';
    limit.value = String(job.settings?.CLOUD_MAX_ESTIMATED_COST ?? 5);
    label.append(limit);
    details.append(label);
    details.append(
      button('Retry with this allowance', async () => {
        await post(`/api/jobs/${encodeURIComponent(id)}/retry`, {
          maxEstimatedCost: Number(limit.value),
        });
        await showJob(id);
        await refresh();
      }),
    );
  }
  if (['failed', 'interrupted', 'cancelled', 'paused'].includes(job.status)) {
    const { requests } = await request(`/api/jobs/${encodeURIComponent(id)}/requests`);
    for (const entry of requests.filter((entry: { status: string }) =>
      ['uncertain', 'submitting', 'accepted'].includes(entry.status),
    )) {
      const panel = element('div', null, 'review-cues');
      panel.append(
        element(
          'p',
          `${entry.provider} / ${entry.model}, chunk ${entry.chunkId}: ${entry.status}. This request may already have been billed. Request ID: ${entry.requestId || 'unavailable'}.`,
        ),
      );
      if (['elevenlabs', 'assemblyai', 'speechmatics', 'gladia'].includes(entry.provider)) {
        const label = element('label', 'Existing provider transcript/job ID ');
        const remote = element('input');
        remote.value = entry.remoteId || '';
        label.append(remote);
        panel.append(label);
        panel.append(
          button('Use existing transcript', async () => {
            await post(`/api/jobs/${encodeURIComponent(id)}/reconcile`, {
              chunkId: String(entry.chunkId),
              remoteId: remote.value.trim(),
            });
            await showJob(id);
            notice(
              'Existing transcript attached. Retry to retrieve it without resubmitting audio.',
              true,
            );
          }),
        );
      }
      const noteLabel = element('label', 'Reason for authorizing another paid attempt ');
      const note = element('textarea');
      noteLabel.append(note);
      panel.append(noteLabel);
      panel.append(
        button(
          'Authorize a new paid attempt',
          async () => {
            if (!note.value.trim())
              throw new Error('Record what you checked in the provider dashboard first.');
            if (
              !confirm(
                'A new attempt can charge again. Prior billing evidence will be retained. Continue?',
              )
            )
              return;
            await post(`/api/jobs/${encodeURIComponent(id)}/reconcile`, {
              chunkId: String(entry.chunkId),
              allowNewRequest: true,
              note: note.value,
            });
            await showJob(id);
          },
          'btn-small btn-warning',
        ),
      );
      details.append(panel);
    }
  }
  if (job.screeningBytes > 0 && job.status === 'completed')
    details.append(
      button(
        `Remove screening copy (${(job.screeningBytes / 1024 ** 3).toFixed(2)} GiB)`,
        async () => {
          if (
            !confirm(
              'Remove the screening video to free space? Subtitle corrections and generated originals are preserved.',
            )
          )
            return;
          await post(`/api/jobs/${encodeURIComponent(id)}/remove-screening`);
          await showJob(id);
        },
      ),
    );
  if (job.youtubeUrl) details.append(element('p', job.youtubeUrl));
  const result = job.result || {};
  if (result.reviewUrl) {
    const link = element('a', 'Watch & correct subtitles', 'btn-small btn-primary');
    link.href = `${BASE}/review-player.html?job=${encodeURIComponent(job.id)}`;
    details.append(link);
    for (const language of result.reviewLanguages ?? []) {
      details.append(
        download(
          `Current SRT (${language})`,
          `/api/reviews/${encodeURIComponent(job.id)}/subtitles/${language}.srt`,
        ),
      );
      details.append(
        download(
          `Current ASS (${language})`,
          `/api/reviews/${encodeURIComponent(job.id)}/subtitles/${language}.ass`,
        ),
      );
    }
    details.append(
      element(
        'p',
        'Current downloads include saved human corrections. Generated originals and their reports are retained below.',
        'field-note',
      ),
    );
  }
  if (result.usageFile) {
    details.append(download('Transcription cost and usage', result.usageFile));
    details.append(
      button('Show usage', async () => {
        const report = await request(result.usageFile);
        const reported = report.requests.some((r: { reportedCost?: unknown }) => r.reportedCost)
          ? `${report.reportedAmountKnown.toFixed(4)} USD`
          : 'unavailable';
        details.append(
          element(
            'p',
            `${report.plan.provider} / ${report.plan.model}: planned gross usage ${report.plan.amount?.toFixed(4) ?? 'unknown'} ${report.plan.currency}; ` +
              `tracked submitted estimate ${report.estimatedReserved.toFixed(4)} ${report.plan.currency}; provider-reported ${reported}. ` +
              `${report.unreportedRequests} requests lack a reported bill; ${report.untrackedCachedChunks ?? 0} older cached chunks lack a usage record. ${report.note}`,
          ),
        );
      }),
    );
  }
  if (result.subtitleFile)
    details.append(
      download(`Source subtitles (${result.sourceLanguage || 'original'})`, result.subtitleFile),
    );
  if (result.englishSubtitleFile)
    details.append(
      download(`Subtitles (${result.targetLanguage || 'en'})`, result.englishSubtitleFile),
    );
  if (result.translationReviewFile)
    details.append(
      download('Translation integrity and readability report', result.translationReviewFile),
    );
  if (result.editorialSourceFile)
    details.append(download('Source words and timing evidence', result.editorialSourceFile));
  if (result.subtitleAssFile)
    details.append(
      download(`Styled ASS (${result.sourceLanguage || 'original'})`, result.subtitleAssFile),
    );
  if (result.translatedAssFile && result.translatedAssFile !== result.subtitleAssFile)
    details.append(
      download(`Styled ASS (${result.targetLanguage || 'en'})`, result.translatedAssFile),
    );
  for (const [url, label] of [
    [result.subtitleStyleReviewFile, 'Source subtitle layout checks'],
    [
      result.translationStyleReviewFile !== result.subtitleStyleReviewFile
        ? result.translationStyleReviewFile
        : null,
      'Translated subtitle layout checks',
    ],
  ]) {
    if (!url) continue;
    details.append(download(label, url));
    details.append(
      button(`Show ${label.toLowerCase()}`, async () => {
        const report = await request(url);
        const container = element('div', null, 'review-cues');
        container.append(
          element(
            'p',
            `${report.profile.name}: ${report.warnings.length} review notes across ${report.cues} cues. ${report.note}`,
          ),
        );
        for (const warning of report.warnings.slice(0, 100))
          container.append(
            element(
              'p',
              `#${warning.id}: ${warning.reason}${warning.actual === undefined ? '' : ` (${warning.actual}; limit ${warning.limit})`}`,
            ),
          );
        details.append(container);
      }),
    );
  }
  if (result.reviewFile) {
    details.append(download('Review report', result.reviewFile));
    details.append(
      button('Show flagged cues', async () => {
        const review = await request(result.reviewFile);
        const container = element('div', null, 'review-cues');
        const flagged = review.segments.filter(
          (segment: { _suspicious?: boolean; review?: string[] }) =>
            segment._suspicious || segment.review?.length,
        );
        container.append(
          element(
            'p',
            `${flagged.length} cues flagged; ${review.dropped.length} segments filtered out. Full details are in the report.`,
          ),
        );
        for (const segment of flagged.slice(0, 100))
          container.append(
            element(
              'p',
              `#${segment.id} [${segment.start.toFixed(2)}–${segment.end.toFixed(2)}] ${segment.text}\n${[...(segment.review || []), ...(segment._filterReasons || [])].join(', ')}`,
            ),
          );
        for (const segment of review.dropped.slice(0, 30))
          container.append(
            element(
              'p',
              `Filtered [${segment.start.toFixed(2)}–${segment.end.toFixed(2)}] ${segment.text} (${(segment._filterReasons || []).join(', ')})`,
            ),
          );
        details.append(container);
      }),
    );
  }
  if (result.speakerFile)
    details.append(download('Speaker annotations for translation', result.speakerFile));
  if (['completed', 'failed', 'cancelled'].includes(job.status) && job.hasIntermediates) {
    details.append(
      button('Remove intermediate audio', async () => {
        if (
          !confirm(
            'Remove this job’s cached audio and resume files? Exported subtitles and review reports will remain. This job will no longer be resumable.',
          )
        )
          return;
        await post(`/api/jobs/${encodeURIComponent(id)}/cleanup`);
        await showJob(id);
      }),
    );
  }
  $('deleteJobBtn').hidden = !['completed', 'failed', 'cancelled'].includes(job.status);
}

interface AudioChunkView {
  id: number;
  start: number;
  end: number;
  originalUrl: string | null;
  vocalsUrl: string | null;
}
async function showAudioReview(id: string, page = 0) {
  const data = await request(`/api/jobs/${encodeURIComponent(id)}/audio-review`);
  selectedJobId = null;
  showModal(`${data.title} · Audio review`);
  const details = $('jobDetails');
  details.append(
    element(
      'p',
      `${data.originalsReady}/${data.total} original chunks ready.` +
        (data.hasVocalComparison
          ? ` ${data.ready}/${data.total} saved vocal comparisons available · ${data.model}. Both versions share the same film offsets.`
          : ' Transcription uses these original audio chunks.'),
    ),
  );
  details.append(button('Refresh chunks', () => showAudioReview(id, page)));
  const selector = element('select');
  selector.id = 'audioChunkPage';
  const pageSize = 12,
    pages = Math.ceil(data.total / pageSize);
  for (let index = 0; index < pages; index++) {
    const option = element(
      'option',
      `Chunks ${index * pageSize + 1}–${Math.min((index + 1) * pageSize, data.total)}`,
    );
    option.value = String(index);
    selector.append(option);
  }
  selector.value = String(Math.min(page, pages - 1));
  selector.addEventListener('change', () => {
    void showAudioReview(id, Number(selector.value)).catch((error) => notice(error.message));
  });
  const label = element('label', 'Chunk range');
  label.htmlFor = selector.id;
  details.append(label, selector);
  const time = (seconds: number) =>
    `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  for (const chunk of (data.chunks as AudioChunkView[]).slice(
    page * pageSize,
    (page + 1) * pageSize,
  )) {
    const row = element('section', null, 'audio-review-chunk');
    row.append(element('h3', `Chunk ${chunk.id} · ${time(chunk.start)}–${time(chunk.end)}`));
    const pair = element('div', null, 'audio-pair');
    const tracks = [['Original', chunk.originalUrl]];
    if (data.hasVocalComparison)
      tracks.push([data.archivedVocals ? 'Archived vocals' : 'Vocals', chunk.vocalsUrl]);
    for (const [name, url] of tracks) {
      const cell = element('div');
      cell.append(element('strong', name));
      if (url && /^\/api\/jobs\/[a-zA-Z0-9_-]+\/audio\/\d+\/(original|vocals)$/.test(url)) {
        const audio = element('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = `${BASE}${url}`;
        audio.setAttribute('aria-label', `Chunk ${chunk.id} ${name}`);
        audio.addEventListener('play', () =>
          document.querySelectorAll<HTMLAudioElement>('#jobModal audio').forEach((other) => {
            if (other !== audio) other.pause();
          }),
        );
        const link = element('a', `Download ${name?.toLowerCase()}`, 'btn-small btn-secondary');
        link.href = `${BASE}${url}`;
        link.download = `chunk_${chunk.id}_${name?.toLowerCase()}.wav`;
        cell.append(audio, link);
      } else cell.append(element('p', 'Not ready yet', 'field-note'));
      pair.append(cell);
    }
    row.append(pair);
    details.append(row);
  }
}

function renderTranslations(folders: TranslationView[]) {
  $('legacyTranslations').hidden = !folders.length;
  const list = $('translationsList');
  list.replaceChildren();
  if (!folders.length) return empty(list, 'Translation chunks appear after transcription.');
  for (const folder of folders) {
    const card = element('div', null, 'translation-card');
    card.append(element('h3', folder.name));
    if (folder.error) card.append(element('p', folder.error));
    else {
      card.append(
        element(
          'p',
          `${folder.translatedEntries}/${folder.totalEntries} cues translated (${folder.progress}%)`,
        ),
      );
      card.append(button('Chunks and imports', () => showTranslation(folder.name)));
      const merge = button('Merge translated subtitles', async () => {
        const result = await post(`/api/translations/${encodeURIComponent(folder.name)}/merge`);
        card.append(download('Download merged SRT', result.outputFile));
        if (result.assFile) card.append(download('Download styled ASS', result.assFile));
        if (result.styleReviewFile)
          card.append(download('Subtitle layout checks', result.styleReviewFile));
      });
      merge.disabled = folder.translatedEntries !== folder.totalEntries;
      card.append(merge);
    }
    list.append(card);
  }
}

let subtitleFilesSignature = '';
function renderSubtitleFiles(files: { filename: string }[]) {
  const signature = JSON.stringify(files);
  if (signature === subtitleFilesSignature) return;
  subtitleFilesSignature = signature;
  const select = $<HTMLSelectElement>('translationSource'),
    previous = select.value;
  const placeholder = element('option', 'Choose an SRT or upload one below');
  placeholder.value = '';
  select.replaceChildren(
    placeholder,
    ...files.map((file) => {
      const option = element('option', file.filename);
      option.value = file.filename;
      return option;
    }),
  );
  select.value = files.some((file) => file.filename === previous) ? previous : '';
}
async function loadCodexStatus() {
  const status = await request('/api/codex');
  $('codexStatus').textContent = `${status.message}${status.version ? ` (${status.version})` : ''}`;
  $<HTMLButtonElement>('startCodexTranslation').disabled = !status.available;
  if (!$<HTMLInputElement>('codexModel').value && status.model)
    $<HTMLInputElement>('codexModel').value = status.model;
}
function initializeCodexTranslations() {
  void loadCodexStatus().catch((error) => {
    $('codexStatus').textContent = error.message;
  });
  $('refreshTranslationsBtn').addEventListener('click', () => {
    readCache.clear();
    void refresh();
    void loadCodexStatus().catch((error) => notice(error.message));
  });
  $('translationSource').addEventListener('change', () => {
    const filename = $<HTMLSelectElement>('translationSource').value;
    if (filename) {
      $<HTMLInputElement>('translationUpload').value = '';
      $<HTMLInputElement>('translationTitle').value = filename.replace(/\.srt$/i, '').slice(0, 200);
      $<HTMLSelectElement>('translationMode').value = 'editorial';
    }
  });
  $('translationUpload').addEventListener('change', () => {
    const file = $<HTMLInputElement>('translationUpload').files?.[0];
    if (file) {
      $<HTMLSelectElement>('translationSource').value = '';
      $<HTMLSelectElement>('translationMode').value = 'fixed';
      $<HTMLInputElement>('translationTitle').value = file.name
        .replace(/\.(srt|txt)$/i, '')
        .slice(0, 200);
    }
  });
  $('codexTranslationForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $<HTMLButtonElement>('startCodexTranslation');
    submit.disabled = true;
    try {
      const file = $<HTMLInputElement>('translationUpload').files?.[0];
      const filename = $<HTMLSelectElement>('translationSource').value;
      if (!file && !filename) throw new Error('Choose a complete subtitle file');
      let content: string | undefined;
      if (file) {
        if (!file.size || file.size > 1024 * 1024)
          throw new Error('Subtitle files must be between 1 byte and 1 MB');
        const bytes = await file.arrayBuffer();
        const encoding = $<HTMLSelectElement>('subtitleEncoding').value;
        try {
          content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        } catch {
          throw new Error(
            'The subtitle does not use the selected encoding. Choose its encoding before translating.',
          );
        }
      }
      const result = await post('/api/subtitle-translations', {
        ...(file ? { content } : { filename }),
        title: $<HTMLInputElement>('translationTitle').value.trim(),
        sourceLanguage: $<HTMLInputElement>('translationSourceLanguage').value.trim(),
        targetLanguage: $<HTMLInputElement>('translationTargetLanguage').value.trim(),
        model: $<HTMLInputElement>('codexModel').value.trim(),
        translationMode: $<HTMLSelectElement>('translationMode').value,
        songReferences: $<HTMLTextAreaElement>('songReferences').value.trim(),
      });
      await refresh();
      await showJob(result.jobId);
    } catch (error) {
      notice(error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

async function showTranslation(folder: string) {
  const data = await request(`/api/translations/${encodeURIComponent(folder)}`);
  selectedJobId = null;
  showModal(folder);
  const details = $('jobDetails');
  details.append(
    element(
      'p',
      `Translate each cue into ${data.targetLanguage}. Keep IDs, timestamps and original text unchanged. Import a complete chunk; incomplete or mismatched files are rejected.`,
    ),
  );
  for (const chunk of data.chunks) {
    const row = element('div', null, 'translation-card');
    row.append(element('p', `${chunk.file}: ${chunk.translated}/${chunk.entries}`));
    for (const [filename, slim] of [
      [chunk.file, false],
      [chunk.slimFile, true],
    ] as [string, boolean][]) {
      row.append(
        download(
          slim ? 'Slim template' : 'Full JSON',
          `/output/translation_chunks/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`,
        ),
      );
      const label = element('label', slim ? ' Import slim JSON ' : ' Import full JSON ');
      const input = element('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async () => {
        try {
          if (!input.files?.[0]) return;
          if (input.files?.[0].size > 2 * 1024 * 1024)
            throw new Error('Translation JSON exceeds 2 MB');
          const content = JSON.parse(await input.files?.[0].text());
          input.disabled = true;
          await post(
            `/api/translations/${encodeURIComponent(folder)}/upload?filename=${encodeURIComponent(filename)}&type=${slim ? 'slim' : 'full'}`,
            content,
          );
          await showTranslation(folder);
          await refresh();
        } catch (error) {
          notice(error.message);
        } finally {
          input.disabled = false;
        }
      });
      label.append(input);
      row.append(label);
    }
    details.append(row);
  }
}

function renderPaused(
  jobs: {
    jobId: string;
    title: string;
    chunkCount?: number;
    provider: string;
    transcriptionMode: string;
  }[],
) {
  const list = $('pausedJobsList');
  list.replaceChildren();
  if (!jobs.length) return empty(list, 'No jobs waiting for audio review.');
  for (const job of jobs) {
    const row = element('div', null, 'paused-job');
    row.append(
      element(
        'p',
        `${job.title} · ${job.provider} · ${job.transcriptionMode} · ${job.chunkCount ?? 0} prepared audio parts`,
      ),
    );
    row.append(
      button('Use form options (stay paused)', async () => {
        await post(`/api/paused-jobs/${encodeURIComponent(job.jobId)}/configure`, languages());
        await refresh();
      }),
    );
    row.append(
      button('Resume', async () => {
        await post(`/api/paused-jobs/${encodeURIComponent(job.jobId)}/resume`);
        await refresh();
      }),
    );
    list.append(row);
  }
}
function renderStatus(status: StatusView, found: { filename: string }[]) {
  queuePaused = status.queue.paused;
  scannerEnabled = status.scanner.active;
  $('queueControlBtn').textContent = queuePaused ? 'Resume queue' : 'Pause queue';
  $('scannerControlBtn').textContent = scannerEnabled ? 'Disable watching' : 'Enable watching';
  $('queueControlStatus').textContent = queuePaused
    ? `Queue paused. ${status.queue.reason || ''} Retry failed jobs as needed, then resume when ready.`
    : `One film runs at a time · ${status.queue.pendingJobs}/${status.queue.maxQueuedJobs} waiting. Pausing lets the current job finish.`;
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  $('storageStatus').textContent =
    `${gib(status.storage.temporaryBytes)} / ${gib(status.storage.maxTemporaryBytes)} GiB temporary media · ${gib(status.storage.availableBytes)} GiB disk available · ${gib(status.storage.screeningBytes || 0)} GiB screenings · ${gib(status.storage.transcriptBytes || 0)} GiB provider transcripts`;
  $('scannerStatus').textContent =
    status.scanner.error || (status.scanner.active ? 'Watching movies/' : 'Stopped');
  $('statTotalFiles').textContent = String(status.scanner.totalFiles);
  $('statProcessed').textContent = String(status.scanner.processedCount);
  $('statPending').textContent = String(status.scanner.pendingInDir);
  $('statQueued').textContent = String(status.queue.pendingJobs);
  $('statFound').textContent = String(found.length);
  $('currentJob').classList.toggle('hidden', !status.queue.isProcessing);
  $('currentJobTitle').textContent = status.queue.currentTitle || '';
  $('queueList').classList.toggle('hidden', !status.queue.pendingJobs);
  $('queueTitles').textContent = status.queue.pendingTitles.join(', ');
  $('skippedList').replaceChildren();
  for (const file of status.skippedFiles) {
    const row = element('div');
    row.append(element('span', `${file.filename}: ${file.reason} `));
    row.append(
      button('Recheck', async () => {
        await post('/api/movies/reset', { filename: file.filename });
        await refresh();
      }),
    );
    $('skippedList').append(row);
  }
  $('foundList').replaceChildren();
  for (const file of found)
    $('foundList').append(download(file.filename, `/found/${encodeURIComponent(file.filename)}`));
  if (!found.length)
    empty($('foundList'), 'No downloaded subtitles. Job outputs are available in Details.');
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const view =
      document.querySelector<HTMLElement>('[data-view].active')?.dataset.view || 'studio';
    if (view === 'studio') {
      const [jobs, paused, status, found] = await Promise.all([
        request(`/api/jobs?view=summary&limit=${jobPageSize}&offset=${jobOffset}`),
        occasional('/api/paused-jobs'),
        request('/api/status'),
        occasional('/api/found'),
      ]);
      if (jobOffset >= jobs.total && jobOffset > 0)
        jobOffset = Math.max(0, jobOffset - jobPageSize);
      renderJobs(jobs.jobs);
      $('jobPageStatus').textContent = jobs.total
        ? `${jobOffset + 1}–${Math.min(jobOffset + jobPageSize, jobs.total)} of ${jobs.total} jobs`
        : 'No jobs yet';
      $<HTMLButtonElement>('newerJobsBtn').disabled = jobOffset === 0;
      $<HTMLButtonElement>('olderJobsBtn').disabled = jobOffset + jobPageSize >= jobs.total;
      renderPaused(paused.jobs);
      renderStatus(status, found);
    } else if (view === 'library') {
      const [status, found, paused] = await Promise.all([
        request('/api/status'),
        occasional('/api/found'),
        request('/api/paused-jobs'),
      ]);
      renderStatus(status, found);
      renderPaused(paused.jobs);
    } else if (view === 'translations') {
      const [translations, folders, subtitles] = await Promise.all([
        request(
          `/api/jobs?view=summary&type=translation&limit=${jobPageSize}&offset=${translationOffset}`,
        ),
        occasional('/api/translations'),
        occasional('/api/subtitle-translations'),
      ]);
      if (translationOffset >= translations.total && translationOffset > 0)
        translationOffset = Math.max(0, translationOffset - jobPageSize);
      renderJobs(translations.jobs, 'translationJobs');
      $('translationPageStatus').textContent =
        `${Math.min(translationOffset + 1, translations.total)}–${Math.min(translationOffset + jobPageSize, translations.total)} of ${translations.total}`;
      $<HTMLButtonElement>('newerTranslationsBtn').disabled = translationOffset === 0;
      $<HTMLButtonElement>('olderTranslationsBtn').disabled =
        translationOffset + jobPageSize >= translations.total;
      renderSubtitleFiles(subtitles.files);
      renderTranslations(folders);
    }
    if (selectedJobId && $<HTMLDialogElement>('jobModal').open) {
      const selectedId = selectedJobId;
      const selected = await request(`/api/jobs/${encodeURIComponent(selectedId)}`);
      if (selectedJobId === selectedId) updateJobLive(selected);
    }
    $('connectionStatus').textContent = '';
  } catch (error) {
    $('connectionStatus').textContent = `Connection: ${error.message}`;
  } finally {
    refreshing = false;
  }
}

async function upload(file: File) {
  if ($('dropZone').classList.contains('uploading')) return;
  const title = $<HTMLInputElement>('uploadTitle').value.trim();
  if (!title) {
    notice('Enter the film title before choosing a file.');
    return;
  }
  if (!file.size || file.size > window.APP_MAX_UPLOAD_BYTES) {
    notice('File is empty or exceeds the upload size limit.');
    return;
  }
  const zone = $('dropZone');
  zone.classList.add('uploading');
  $('uploadProgress').classList.remove('hidden');
  try {
    const query = new URLSearchParams({ title, ...languages() });
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/api/upload-audio?${query}`);
      xhr.timeout = 31 * 60 * 1000;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Yesilcam-Request', '1');
      xhr.upload.onprogress = (event) => {
        const progress = event.lengthComputable
          ? Math.round((event.loaded / event.total) * 100)
          : 0;
        $('uploadProgressFill').style.width = `${progress}%`;
        $('uploadProgressText').textContent = `Uploading ${progress}%`;
      };
      xhr.onload = () => {
        try {
          const result = JSON.parse(xhr.responseText);
          xhr.status < 300 ? resolve(result) : reject(new Error(result.error || 'Upload failed'));
        } catch {
          reject(new Error('Invalid upload response'));
        }
      };
      xhr.onerror = () =>
        reject(
          new Error('Upload disconnected or rejected; no job was queued unless it appears below.'),
        );
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.onabort = () => reject(new Error('Upload cancelled'));
      xhr.send(file);
    });
    $<HTMLInputElement>('uploadTitle').value = '';
    $<HTMLInputElement>('audioFileInput').value = '';
    await refresh();
  } catch (error) {
    notice(error.message);
  } finally {
    zone.classList.remove('uploading');
    $('uploadProgress').classList.add('hidden');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $<HTMLSelectElement>('transcriptionProvider').addEventListener('change', () =>
    showProviderDetails(true),
  );
  $<HTMLInputElement>('transcriptionModel').addEventListener('input', () => showProviderDetails());
  $<HTMLSelectElement>('transcriptionMode').addEventListener('change', () => showProviderDetails());
  void loadProviders().catch((error) => {
    $('providerDetails').textContent = error.message;
  });
  $<HTMLInputElement>('sourceLanguage').value = window.APP_DEFAULT_LANGUAGE || 'tr';
  $<HTMLInputElement>('targetLanguage').value = window.APP_TARGET_LANGUAGE || 'en';
  $<HTMLInputElement>('keepIntermediates').checked = window.APP_KEEP_INTERMEDIATES !== false;
  $<HTMLInputElement>('translateWithCodex').checked = window.APP_TRANSLATION_ENABLED === true;
  document
    .querySelectorAll('[data-close-modal]')
    .forEach((node) => node.addEventListener('click', closeModal));
  $<HTMLDialogElement>('jobModal').addEventListener('click', (event) => {
    if (event.target === $<HTMLDialogElement>('jobModal')) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((node) =>
    node.addEventListener('click', () => {
      document
        .querySelectorAll<HTMLButtonElement>('.tab-btn')
        .forEach((tab) => tab.classList.toggle('active', tab === node));
      $('uploadTab').classList.toggle('active', node.dataset.tab === 'upload');
      $('youtubeTab').classList.toggle('active', node.dataset.tab === 'youtube');
      $('uploadTab').hidden = node.dataset.tab !== 'upload';
      $('youtubeTab').hidden = node.dataset.tab !== 'youtube';
      document
        .querySelectorAll('.tab-btn')
        .forEach((tab) => tab.setAttribute('aria-selected', String(tab === node)));
    }),
  );
  for (const id of ['refreshBtn', 'refreshTranslationsBtn', 'refreshPausedBtn'])
    $(id).addEventListener('click', refresh);
  for (const [toggle, list] of [
    ['toggleSkipped', 'skippedList'],
    ['toggleFound', 'foundList'],
  ])
    $(toggle).addEventListener('click', () => {
      $(list).classList.toggle('hidden');
      $(toggle).textContent = $(list).classList.contains('hidden') ? 'Show' : 'Hide';
    });
  $('submitForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
    submit.disabled = true;
    try {
      await post('/api/jobs', {
        youtubeUrl: $<HTMLInputElement>('youtubeUrl').value,
        imdbId: $<HTMLInputElement>('imdbId').value,
        title: $<HTMLInputElement>('title').value,
        ...languages(),
      });
      form.reset();
      await refresh();
    } catch (error) {
      notice(error.message);
    } finally {
      submit.disabled = false;
    }
  });
  const actions = {
    queueControlBtn: () => post('/api/queue/control', { paused: !queuePaused }),
    scannerControlBtn: () => post('/api/queue/control', { scannerEnabled: !scannerEnabled }),
    newerJobsBtn: () => {
      jobOffset = Math.max(0, jobOffset - jobPageSize);
    },
    olderJobsBtn: () => {
      jobOffset += jobPageSize;
    },
    scanNowBtn: () => post('/api/movies/scan'),
    resetAllBtn: () =>
      confirm('Allow completed or failed films to be queued again on the next scan?') &&
      post('/api/movies/reset-all'),
    clearQueueBtn: () =>
      confirm('Cancel waiting jobs? Active and paused jobs will remain.') &&
      post('/api/jobs/clear'),
    deleteJobBtn: async () => {
      if (
        selectedJobId &&
        confirm(
          'Delete this job from history? Remove its intermediates first using the cleanup button. Exported outputs will remain.',
        )
      ) {
        await request(`/api/jobs/${encodeURIComponent(selectedJobId)}`, { method: 'DELETE' });
        closeModal();
      }
    },
  };
  for (const [id, action] of Object.entries(actions))
    $(id).addEventListener('click', async () => {
      $<HTMLButtonElement>(id).disabled = true;
      try {
        await action();
        await refresh();
      } catch (error) {
        notice(error.message);
      } finally {
        $<HTMLButtonElement>(id).disabled = false;
      }
    });
  $('dropZone').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $<HTMLInputElement>('audioFileInput').click();
    }
  });
  $('dropZone').addEventListener('click', (event) => {
    if (
      event.target !== $<HTMLInputElement>('audioFileInput') &&
      !$('dropZone').classList.contains('uploading')
    )
      $<HTMLInputElement>('audioFileInput').click();
  });
  $<HTMLInputElement>('audioFileInput').addEventListener('change', () => {
    const file = $<HTMLInputElement>('audioFileInput').files?.[0];
    if (file) void upload(file);
  });
  $('dropZone').addEventListener('dragover', (event) => {
    event.preventDefault();
    $('dropZone').classList.add('drag-over');
  });
  $('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('drag-over'));
  $('dropZone').addEventListener('drop', (event) => {
    event.preventDefault();
    $('dropZone').classList.remove('drag-over');
    if (event.dataTransfer?.files[0]) void upload(event.dataTransfer?.files[0]);
  });
  $('newerTranslationsBtn').onclick = () => {
    translationOffset = Math.max(0, translationOffset - jobPageSize);
    void refresh();
  };
  $('olderTranslationsBtn').onclick = () => {
    translationOffset += jobPageSize;
    void refresh();
  };
  $('pruneHistoryBtn').onclick = () => {
    if (
      confirm(
        'Archive finished history entries whose temporary media has been removed? Saved subtitles and corrections remain available on disk.',
      )
    )
      void post('/api/jobs/archive')
        .then(refresh)
        .catch((error) => notice(error.message));
  };
  initializeWorkspace();
  initializeCodexTranslations();
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 5000);
});

function notice(message: string, success = false) {
  const modal = $<HTMLDialogElement>('jobModal');
  if (modal.open) {
    modal.querySelector('.modal-notice')?.remove();
    const text = element('p', message, 'modal-notice error-message');
    text.setAttribute('role', 'alert');
    text.append(button('Dismiss', () => text.remove()));
    $('jobDetails').prepend(text);
    return;
  }
  const banner = $('notice');
  banner.replaceChildren(
    element('span', message),
    button('Dismiss', () => banner.classList.add('hidden')),
  );
  banner.classList.remove('hidden');
  banner.classList.toggle('success', success);
  banner.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
interface ConnectionField {
  name: string;
  label: string;
  secret: boolean;
  configured: boolean;
  source: string;
  value?: string;
}
async function loadConnections() {
  const { fields }: { fields: ConnectionField[] } = await request('/api/connections');
  const list = $('connectionsList');
  list.replaceChildren();
  for (const field of fields) {
    const cookies = field.name === 'YOUTUBE_COOKIES';
    const card = element('form', undefined, `connection-card${cookies ? ' wide' : ''}`);
    const heading = element('div', undefined, 'section-header');
    const badge = element(
      'span',
      field.configured
        ? `Saved${field.source === 'environment' ? ' in environment' : ''}`
        : 'Not connected',
      `connection-badge${field.configured ? '' : ' missing'}`,
    );
    heading.append(element('h3', field.label), badge);
    card.append(heading);
    const input = cookies ? element('textarea') : element('input');
    input.id = `connection-${field.name}`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (input instanceof HTMLInputElement) input.type = field.secret ? 'password' : 'text';
    input.value = field.secret ? '' : (field.value ?? '');
    input.placeholder = cookies
      ? '# Netscape HTTP Cookie File\nPaste your exported cookies here'
      : field.secret && field.configured
        ? 'Saved · enter a new key to replace'
        : field.secret
          ? 'Paste API key'
          : 'Enter setting';
    const label = element(
      'label',
      cookies ? 'Cookies export' : field.secret ? 'API key / secret' : 'Setting',
    );
    label.htmlFor = input.id;
    card.append(label, input);
    if (cookies)
      card.append(
        element(
          'p',
          'Use an export from an account that can access the video. Cookies grant access to that account; clear them when finished. Some server IPs are blocked by YouTube even with cookies.',
          'field-note',
        ),
      );
    const save = element('button', 'Save connection', 'btn-small');
    save.type = 'submit';
    save.disabled = !input.value.trim();
    const feedback = element('p', undefined, 'connection-feedback');
    feedback.setAttribute('role', 'status');
    input.addEventListener('input', () => {
      save.disabled = !input.value.trim();
      feedback.textContent = '';
    });
    const clear = button('Clear', async () => {
      if (
        !confirm(
          `Remove ${field.label} from this workspace? This also disables any environment fallback.`,
        )
      )
        return;
      await request(`/api/connections/${encodeURIComponent(field.name)}`, { method: 'DELETE' });
      input.value = '';
      save.disabled = true;
      badge.textContent = 'Not connected';
      badge.classList.add('missing');
      feedback.textContent = 'Removed. Future requests will use the updated connection.';
      await loadProviders(false);
    });
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      clear.disabled = true;
      try {
        await request(`/api/connections/${encodeURIComponent(field.name)}`, {
          method: 'PUT',
          body: JSON.stringify({ value: input.value }),
        });
        if (field.secret) input.value = '';
        input.placeholder = field.secret
          ? 'Saved · enter a new value to replace'
          : input.placeholder;
        badge.textContent = 'Saved';
        badge.classList.remove('missing');
        feedback.textContent =
          'Saved. Available immediately for the next request; no restart needed.';
        await loadProviders(false);
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        save.disabled = !input.value.trim();
        clear.disabled = false;
      }
    });
    card.append(save, clear, feedback);
    list.append(card);
  }
}
function initializeWorkspace() {
  const views = new Set(['studio', 'library', 'translations', 'connections']);
  let connectionsLoaded = false;
  const show = (view: string) => {
    if (!views.has(view)) view = 'studio';
    document.querySelectorAll<HTMLElement>('[data-screen]').forEach((screen) => {
      screen.hidden = screen.dataset.screen !== view;
    });
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (view === 'connections' && !connectionsLoaded) {
      connectionsLoaded = true;
      void loadConnections().catch((error) => {
        connectionsLoaded = false;
        notice(error.message);
      });
    }
    void refresh();
  };
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) =>
    button.addEventListener('click', () => {
      window.location.hash = button.dataset.view!;
    }),
  );
  window.addEventListener('hashchange', () => show(window.location.hash.slice(1)));
  show(window.location.hash.slice(1));
  $('logoutBtn').addEventListener('click', async () => {
    try {
      await post('/api/auth/logout');
      window.location.assign(`${BASE}/login`);
    } catch (error) {
      notice(error.message);
    }
  });
  $('passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = (event.currentTarget as HTMLFormElement).querySelector<HTMLButtonElement>(
      'button',
    )!;
    submit.disabled = true;
    try {
      await request('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({
          currentPassword: $<HTMLInputElement>('currentPassword').value,
          newPassword: $<HTMLInputElement>('newPassword').value,
        }),
      });
      window.location.assign(`${BASE}/login`);
    } catch (error) {
      $('passwordStatus').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  $<HTMLDialogElement>('jobModal').addEventListener('close', () => {
    selectedJobId = null;
  });
}

interface JobView {
  id: string;
  title: string;
  status: string;
  progress: number;
  error?: string;
  intermediatesRemoved?: boolean;
  type?: string;
  logs?: { message: string; time?: string }[];
  stages?: StageView[];
  settings?: { PAUSE_BEFORE_TRANSCRIPTION?: boolean; PAUSE_AFTER_DEMUCS?: boolean };
  result?: {
    englishSubtitleFile?: string;
    translatedAssFile?: string;
    subtitleFile?: string;
    subtitleAssFile?: string;
    reviewUrl?: string;
    reviewStatus?: string;
    reviewError?: string | null;
    currentSubtitleFile?: string;
    currentAssFile?: string;
    reviewLanguages?: string[];
  };
}
interface TranslationView {
  name: string;
  error?: string;
  translatedEntries: number;
  totalEntries: number;
  progress: number;
}
interface StatusView {
  scanner: {
    error?: string;
    active: boolean;
    totalFiles: number;
    processedCount: number;
    pendingInDir: number;
  };
  queue: {
    paused: boolean;
    reason?: string;
    maxQueuedJobs: number;
    pendingJobs: number;
    isProcessing: boolean;
    currentTitle?: string;
    pendingTitles: string[];
  };
  storage: {
    screeningBytes?: number;
    transcriptBytes?: number;
    temporaryBytes: number;
    availableBytes: number;
    maxTemporaryBytes: number;
  };
  skippedFiles: { filename: string; reason: string }[];
}
