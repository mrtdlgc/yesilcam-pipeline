import './scripts/lib/environment.js';

/**
 * Pipeline Configuration
 * Original-audio transcription with interchangeable providers.
 */

export const DEFAULT_OPENROUTER_MODEL = 'elevenlabs/scribe-v2';

export const config = {
  // Provider IDs and model capabilities are in scripts/providers/catalog.ts.
  // Auto falls back to Groq only when ALLOW_CLOUD_FALLBACK is explicitly enabled.
  TRANSCRIBE_BACKEND: process.env.TRANSCRIBE_BACKEND || 'elevenlabs', // Direct Scribe streams the full film
  TRANSCRIPTION_MODEL: process.env.TRANSCRIPTION_MODEL || '', // Empty selects the provider's documented default
  PORTABLE_PATHS: true, // New checkpoints use DATA_DIR-relative identities
  TRANSCRIPTION_MODE: 'auto', // auto: full movie for direct ElevenLabs, chunks for other providers
  TRANSCRIPTION_DIARIZATION: true, // Scribe only; anonymous speakers remain scoped to each request
  TRANSCRIPTION_AUDIO_EVENTS: true, // Retain event evidence separately from spoken words
  MOVIE_TRANSCRIPTION_TIMEOUT_MS: 30 * 60 * 1000,
  MAX_MOVIE_AUDIO_BYTES: 512 * 1024 * 1024, // Streamed FLAC, never buffered as one upload in RAM
  CLOUD_MAX_ESTIMATED_COST: Number(process.env.CLOUD_MAX_ESTIMATED_COST || 5), // Per job; estimate, not an invoice cap
  CLOUD_PRICE_PER_MINUTE: process.env.CLOUD_PRICE_PER_MINUTE
    ? Number(process.env.CLOUD_PRICE_PER_MINUTE)
    : (null as number | null), // Override for your account's rate
  CLOUD_PRICE_CURRENCY: process.env.CLOUD_PRICE_CURRENCY || 'USD',
  CLOUD_POLL_INTERVAL_MS: 2000,
  CLOUD_JOB_TIMEOUT_MS: 20 * 60 * 1000,
  COMPATIBLE_RESPONSE_FORMAT: 'verbose_json', // For a custom OpenAI-compatible server

  // Local Whisper settings (faster-whisper)
  LOCAL_WHISPER_ENABLED: process.env.LOCAL_WHISPER_ENABLED === 'true',
  LOCAL_AUDIO_ENABLED: process.env.LOCAL_AUDIO_ENABLED === 'true', // Optional Silero/PyTorch image tools
  LOCAL_WHISPER_MODEL: 'large-v3', // tiny, base, small, medium, large-v2, large-v3
  LOCAL_WHISPER_DEVICE: process.env.LOCAL_WHISPER_DEVICE || 'cpu', // cpu or cuda
  LOCAL_WHISPER_COMPUTE_TYPE: process.env.LOCAL_WHISPER_COMPUTE_TYPE || 'int8', // int8 (CPU) or float16 (GPU)

  // Resource limits (0 = auto-detect all available cores)
  LOCAL_WHISPER_CPU_THREADS: Number(process.env.LOCAL_WHISPER_CPU_THREADS || 2), // Explicit host limit; 0 leaves one core free
  LOCAL_WHISPER_WORKERS: 1, // 1 worker using all threads for max realtime factor
  WORD_TIMESTAMPS: false, // Local Whisper default; cloud uses its model capabilities
  ALLOW_CLOUD_FALLBACK: false, // auto stays local unless explicitly enabled
  WORKER_START_TIMEOUT_MS: Number(process.env.WORKER_START_TIMEOUT_MS || 300000),
  TRANSCRIPTION_TIMEOUT_MS: 300000,
  SHUTDOWN_GRACE_MS: Number(process.env.SHUTDOWN_GRACE_MS || 30 * 60 * 1000),
  MEDIA_TIMEOUT_MS: Number(process.env.MEDIA_TIMEOUT_MS || 3600000),
  MAX_INPUT_DURATION_SEC: Number(process.env.MAX_INPUT_DURATION_SEC || 4 * 60 * 60),
  MAX_UPLOAD_BYTES: Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024),
  MAX_UPLOAD_TIME_MS: 30 * 60 * 1000,
  MAX_TEMP_BYTES: Number(process.env.MAX_TEMP_BYTES || 12 * 1024 * 1024 * 1024),
  MIN_FREE_DISK_BYTES: Number(process.env.MIN_FREE_DISK_BYTES || 1024 * 1024 * 1024),
  KEEP_INTERMEDIATES: process.env.KEEP_INTERMEDIATES !== 'false', // Docker defaults to cleanup after success
  PREPARE_REVIEW: process.env.PREPARE_REVIEW !== 'false', // Persistent screening and correction editor
  MAX_QUEUED_JOBS: Number(process.env.MAX_QUEUED_JOBS || 20),
  SCANNER_ENABLED: process.env.SCANNER_ENABLED === 'true', // First-start default; persisted controls override it
  PAUSE_ON_FAILURE: process.env.PAUSE_ON_FAILURE !== 'false',

  // Groq API settings (fallback)
  GROQ_MODEL: 'whisper-large-v3',
  GROQ_RATE_LIMIT_DELAY_MS: 3500, // 20 RPM = 3s min, using 3.5s for safety

  // VAD-based audio chunking settings
  // Chunks audio at silence boundaries to avoid mid-sentence cuts
  // No longer size-based - we preserve original audio quality
  CHUNK_MIN_DURATION: 20, // Start looking for silence after this (seconds)
  CHUNK_TARGET_DURATION: 25, // Ideal chunk duration (seconds)
  CHUNK_MAX_DURATION: 30, // Hard cut before this to prevent whisper auto-truncation
  AUDIO_STREAM_INDEX: 0, // Zero-based audio stream in multi-track films
  SKIP_LONG_SILENCE: false, // Do not discard quiet dialogue before transcription

  // Optional legacy export; local Codex receives the complete film.
  EXPORT_TRANSLATION_CHUNKS: false,
  SRT_CHUNK_SIZE: 50,

  // Merge settings - segments closer than this will be merged
  MERGE_THRESHOLD_MS: 300,
  SUBTITLE_MAX_DURATION_SEC: 7,
  SUBTITLE_MAX_CHARS: 84, // Netflix-inspired export wraps at 42 characters, two lines
  SUBTITLE_MAX_CHARS_PER_SEC: 20, // Export also applies the Turkish 17 CPS review limit

  // Hallucination filter - removes Whisper hallucinations using audio energy
  // Checks: seek position, no_speech_prob, compression_ratio, duration, energy
  FILTER_HALLUCINATIONS: true,
  LOG_TRANSCRIPT_TEXT: process.env.LOG_TRANSCRIPT_TEXT === 'true',
  HALLUCINATION_DROP_THRESHOLD: 4, // Score >= this = drop segment
  HALLUCINATION_MARK_THRESHOLD: 2, // Score >= this = mark suspicious

  // Speech boundary alignment - snaps timestamps to actual speech
  // 'silero' = Use Silero VAD neural network (recommended, detects speech not noise)
  // 'energy' = Use RMS energy analysis (faster but picks up music/noise)
  // false = Disable alignment
  ALIGN_TO_SPEECH: process.env.LOCAL_AUDIO_ENABLED === 'true',
  ALIGNMENT_METHOD: process.env.LOCAL_AUDIO_ENABLED === 'true' ? 'silero' : 'native', // native | silero | energy
  SILENCE_THRESHOLD_DB: -30, // For energy method: audio below this is silence
  MIN_SILENCE_DURATION: 0.3, // Minimum silence duration in seconds

  // === Silero VAD Filter ===
  // Speech profiles are computed on source audio and reused for alignment.
  SILERO_VAD_ENABLED: process.env.LOCAL_AUDIO_ENABLED === 'true',
  SILERO_VAD_THRESHOLD: 0.5, // Speech probability threshold (0.0-1.0)
  SILERO_MIN_SPEECH_MS: 250, // Minimum speech duration to keep segment
  SILERO_MIN_SILENCE_MS: 100, // Minimum silence for boundary detection

  SILERO_MIN_SPEECH_RATIO: 0, // Any confirmed dialogue survives
  SILERO_DROP_NON_SPEECH: false, // Mark uncertain chunks; retain by default

  // Legacy settings retained for old manifests and archived vocal comparisons.
  // New jobs always use source audio; the pipeline no longer runs Demucs.
  DEMUCS_ENABLED: false,
  DEMUCS_MODEL: 'htdemucs_ft', // htdemucs, htdemucs_ft, htdemucs_6s, mdx_extra
  DEMUCS_DEVICE: process.env.DEMUCS_DEVICE || 'cpu', // 'cpu' or 'cuda'
  DEMUCS_SHIFTS: 0, // Random shifts for quality (1-5, higher = slower but better)
  DEMUCS_OVERLAP: 0.25, // Overlap ratio for segment processing

  // === Language Settings ===
  // Default language for transcription
  // Use ISO 639-1 codes: 'tr' (Turkish), 'uk' (Ukrainian), 'ru' (Russian), etc.
  // Use 'auto' for automatic language detection (recommended for mixed-language films)
  DEFAULT_LANGUAGE: 'tr',
  TARGET_LANGUAGE: 'en',
  ALIGNMENT_MAX_SHIFT_SEC: 0.5,
  ALIGNMENT_PADDING_SEC: 0.08,

  // === Whisper Prompt ===
  // Only use last sentence from previous chunk (simpler = fewer hallucinations)
  WHISPER_PROMPT_ENABLED: true,
  WHISPER_USE_PREVIOUS_SENTENCE: true, // Include last sentence for context continuity

  // === Workflow Control ===
  PAUSE_BEFORE_TRANSCRIPTION: false, // Review source chunks before VAD or paid ASR
  PAUSE_AFTER_DEMUCS: false, // Legacy manifest/request compatibility only

  // === Subtitle translation ===
  TRANSLATION_ENABLED: process.env.TRANSLATION_ENABLED === 'true',
  TRANSLATION_PROVIDER: process.env.APP_MODE === 'hosted' ? 'openai-api' : 'codex-local',
  TRANSLATION_MODE: 'editorial', // New media jobs; uploaded SRT defaults to fixed timings
  TRANSLATION_SONG_REFERENCES: '', // Optional titles, performance notes or supplied lyric references
  CODEX_BIN: process.env.CODEX_BIN || 'codex',
  CODEX_MODEL: process.env.CODEX_MODEL || (process.env.APP_MODE === 'hosted' ? 'gpt-5.4' : ''), // Empty uses the installed CLI default
  CODEX_TRANSLATION_TIMEOUT_MS: Number(process.env.CODEX_TRANSLATION_TIMEOUT_MS || 30 * 60 * 1000),
  TRANSLATION_CONTEXT_WINDOW: 5, // Sentences before/after for context
  TRANSLATION_BATCH_SIZE: 10, // Sentences per LLM request
  TRANSLATION_RETRY_ATTEMPTS: 3, // Retry failed translations
  TRANSLATION_TIMEOUT_MS: 60000, // 60 second timeout per request

  // === Extra Hallucination Patterns ===
  // Language-specific patterns to filter out (Turkish, Russian, Ukrainian)
  EXTRA_HALLUCINATION_PATTERNS: [
    // Turkish
    'Altyazı M.K.',
    'Altyazı çeviri',
    'Türkçe altyazı',
    'İyi seyirler',
    'Abone olun',
    'Beğenmeyi unutmayın',
    'Kanala abone ol',
    'Videoyu beğen',
    'Yorum yap',
    'Paylaşmayı unutma',
    // Russian
    'Подписывайтесь',
    'Подпишитесь на канал',
    'Ставьте лайк',
    'Спасибо за просмотр',
    'Приятного просмотра',
    'Субтитры',
    'Перевод субтитров',
    'Не забудьте подписаться',
    'Оставляйте комментарии',
    'Делитесь видео',
    // Ukrainian
    'Підписуйтесь',
    'Підпишіться на канал',
    'Ставте лайк',
    'Дякую за перегляд',
    'Приємного перегляду',
    'Субтитри',
    'Переклад субтитрів',
    'Не забудьте підписатися',
    'Залишайте коментарі',
    'Діліться відео',
  ],
};
