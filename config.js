/**
 * Pipeline Configuration
 * Supports both local Whisper and Groq API
 */

export const config = {
  // Transcription backend: 'local' (faster-whisper) or 'groq' (API)
  // Local is prioritized, Groq is used as fallback
  TRANSCRIBE_BACKEND: 'local',  // 'local' | 'groq' | 'auto'

  // Local Whisper settings (faster-whisper)
  LOCAL_WHISPER_MODEL: 'large-v3',  // tiny, base, small, medium, large-v2, large-v3
  LOCAL_WHISPER_DEVICE: 'cuda',     // cpu or cuda
  LOCAL_WHISPER_COMPUTE_TYPE: 'float16',  // int8 (CPU) or float16 (GPU)

  // Resource limits (0 = auto-detect all available cores)
  LOCAL_WHISPER_CPU_THREADS: 0,  // 0 = auto (all cores)
  LOCAL_WHISPER_WORKERS: 1,      // 1 worker using all threads for max realtime factor

  // Groq API settings (fallback)
  GROQ_MODEL: 'whisper-large-v3',
  GROQ_RATE_LIMIT_DELAY_MS: 3500,  // 20 RPM = 3s min, using 3.5s for safety

  // VAD-based audio chunking settings
  // Chunks audio at silence boundaries to avoid mid-sentence cuts
  // No longer size-based - we preserve original audio quality
  CHUNK_MIN_DURATION: 20,     // Start looking for silence after this (seconds)
  CHUNK_TARGET_DURATION: 25,  // Ideal chunk duration (seconds)
  CHUNK_MAX_DURATION: 30,     // Hard cut before this to prevent whisper auto-truncation

  // SRT chunking for translation (max entries per file)
  // Keeps chunks small to avoid LLM hallucination during translation
  SRT_CHUNK_SIZE: 50,

  // Merge settings - segments closer than this will be merged
  MERGE_THRESHOLD_MS: 300,

  // Hallucination filter - removes Whisper hallucinations using audio energy
  // Checks: seek position, no_speech_prob, compression_ratio, duration, energy
  FILTER_HALLUCINATIONS: true,
  HALLUCINATION_DROP_THRESHOLD: 4,  // Score >= this = drop segment
  HALLUCINATION_MARK_THRESHOLD: 2,  // Score >= this = mark suspicious

  // Speech boundary alignment - snaps timestamps to actual speech
  // 'silero' = Use Silero VAD neural network (recommended, detects speech not noise)
  // 'energy' = Use RMS energy analysis (faster but picks up music/noise)
  // false = Disable alignment
  ALIGN_TO_SPEECH: true,
  ALIGNMENT_METHOD: 'silero',  // 'silero' | 'energy'
  SILENCE_THRESHOLD_DB: -30,   // For energy method: audio below this is silence
  MIN_SILENCE_DURATION: 0.3,   // Minimum silence duration in seconds

  // === Silero VAD Filter ===
  // Secondary filter after FFT chunking to discard non-speech segments
  SILERO_VAD_ENABLED: true,
  SILERO_VAD_THRESHOLD: 0.5,      // Speech probability threshold (0.0-1.0)
  SILERO_MIN_SPEECH_MS: 250,      // Minimum speech duration to keep segment
  SILERO_MIN_SILENCE_MS: 100,     // Minimum silence for boundary detection

  // === Demucs Audio Cleaning ===
  // Uses htdemucs_ft model to extract vocals and remove background music/noise
  DEMUCS_ENABLED: true,
  DEMUCS_MODEL: 'htdemucs_ft',    // htdemucs, htdemucs_ft, htdemucs_6s, mdx_extra
  DEMUCS_DEVICE: 'cuda',          // 'cpu' or 'cuda'
  DEMUCS_SHIFTS: 0,               // Random shifts for quality (1-5, higher = slower but better)
  DEMUCS_OVERLAP: 0.25,           // Overlap ratio for segment processing

  // === Language Settings ===
  // Default language for transcription
  // Use ISO 639-1 codes: 'tr' (Turkish), 'uk' (Ukrainian), 'ru' (Russian), etc.
  // Use 'auto' for automatic language detection (recommended for mixed-language films)
  DEFAULT_LANGUAGE: 'uk',

  // === Whisper Prompt ===
  // Only use last sentence from previous chunk (simpler = fewer hallucinations)
  WHISPER_PROMPT_ENABLED: true,
  WHISPER_USE_PREVIOUS_SENTENCE: true,  // Include last sentence for context continuity

  // === Workflow Control ===
  // Split pipeline: run audio processing overnight, transcribe during day
  PAUSE_AFTER_DEMUCS: false,  // Stop after Demucs, save state for later transcription

  // === LLM Translation (Ollama) ===
  // Context-aware Turkish to English translation using local LLM
  TRANSLATION_ENABLED: false,
  OLLAMA_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'llama3.1:8b',    // Default model (user configurable)
  OLLAMA_FALLBACK_MODEL: null,    // Fallback model if primary fails (null = no fallback)
  TRANSLATION_CONTEXT_WINDOW: 5,  // Sentences before/after for context
  TRANSLATION_BATCH_SIZE: 10,     // Sentences per LLM request
  TRANSLATION_RETRY_ATTEMPTS: 3,  // Retry failed translations
  TRANSLATION_TIMEOUT_MS: 60000,  // 60 second timeout per request

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
    'Діліться відео'
  ]
};
