import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { config, DEFAULT_OPENROUTER_MODEL } from '../../config.js';
import type { Settings } from '../../types/pipeline.js';
import { at, contained, jobId, readJson, writeJson } from './files.js';
import { movieSettings } from './transcription-mode.js';

export async function configurePausedAudio(id: string, settings: Settings) {
  jobId(id);
  const file = at('temp', id, 'manifest.json');
  const manifest = await readJson(file, null);
  if (
    !manifest ||
    manifest.id !== id ||
    manifest.version !== 1 ||
    !['paused', 'new'].includes(manifest.stage)
  )
    throw Object.assign(new Error('Only audio paused before transcription can change providers'), {
      status: 409,
    });
  const requests = await fs.readdir(at('output', 'raw_transcriptions', id)).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (requests.some((name) => name.startsWith('chunk_')))
    throw Object.assign(
      new Error('This job has ASR checkpoints; create a new job to change transcription settings'),
      { status: 409 },
    );
  const backup = at('temp', id, `manifest.before-options-${Date.now()}.json`);
  await fs.copyFile(file, backup, constants.COPYFILE_EXCL);
  manifest.archivedOriginalChunks ??= manifest.originalChunks;
  manifest.settings = movieSettings({
    ...settings,
    DEMUCS_ENABLED: false,
    PAUSE_BEFORE_TRANSCRIPTION: true,
    PAUSE_AFTER_DEMUCS: false,
  });
  delete manifest.chunks;
  delete manifest.originalChunks;
  delete manifest.vadDiscarded;
  manifest.profilesPrepared = false;
  manifest.stage = 'new';
  manifest.audioInput = 'original';
  await writeJson(file, manifest);
  return manifest;
}

export function originalAudioSettings(settings: Partial<Settings>, paused = false): Settings {
  return {
    ...config,
    ...settings,
    DEMUCS_ENABLED: false,
    TRANSCRIBE_BACKEND: 'openrouter',
    TRANSCRIPTION_MODEL: DEFAULT_OPENROUTER_MODEL,
    CLOUD_PRICE_PER_MINUTE: null,
    CLOUD_PRICE_CURRENCY: 'USD',
    ALLOW_CLOUD_FALLBACK: false,
    PAUSE_BEFORE_TRANSCRIPTION: Boolean(
      paused || settings.PAUSE_BEFORE_TRANSCRIPTION || settings.PAUSE_AFTER_DEMUCS,
    ),
    PAUSE_AFTER_DEMUCS: false,
  };
}

// Only migrate before the job has any ASR checkpoint. Changing a paid request's
// input/model would break its recovery identity and could cause another charge.
export async function migratePreparedAudio(id: string) {
  jobId(id);
  const file = at('temp', id, 'manifest.json');
  const manifest = await readJson(file, null);
  if (!manifest) return null;
  if (manifest.version !== 1 || manifest.id !== id) throw new Error('Invalid recovery manifest');
  if (manifest.stage === 'completed') return null;
  // Also repairs the queue side if a previous startup stopped between writes.
  if (manifest.originalAudioMigration) return manifest;
  if (!manifest.settings?.DEMUCS_ENABLED) return null;
  const rawFiles = await fs.readdir(at('output', 'raw_transcriptions', id)).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (rawFiles.some((name) => name.startsWith('chunk_'))) return null;
  if (manifest.chunks?.length && !manifest.originalChunks?.length)
    throw new Error('Original audio is missing; restore it or submit a new job before migration');
  const workDir = await contained(at('temp'), id);
  const originals = [];
  for (const chunk of manifest.originalChunks ?? []) {
    const relative = path.relative(workDir, path.resolve(chunk.file));
    const source = await contained(workDir, ...relative.split(path.sep));
    const stat = await fs.stat(source);
    if (!stat.isFile() || !stat.size) throw new Error(`Original chunk ${chunk.id} is missing`);
    if (
      chunk.audioStat &&
      (chunk.audioStat.size !== stat.size || chunk.audioStat.mtimeMs !== stat.mtimeMs)
    )
      throw new Error(`Original chunk ${chunk.id} changed; restore it before migration`);
    originals.push({
      id: chunk.id,
      file: source,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      hasSpeech: null,
      audioStat: { size: stat.size, mtimeMs: stat.mtimeMs },
    });
  }
  const backup = path.join(workDir, 'manifest.before-scribe-original.json');
  await fs.copyFile(file, backup, constants.COPYFILE_EXCL).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const old = manifest.settings;
  manifest.legacySeparation = {
    DEMUCS_MODEL: old.DEMUCS_MODEL,
    DEMUCS_SHIFTS: old.DEMUCS_SHIFTS,
    DEMUCS_OVERLAP: old.DEMUCS_OVERLAP,
  };
  manifest.settings = originalAudioSettings(old, manifest.stage === 'paused');
  manifest.audioInput = 'original';
  manifest.originalAudioMigration = { version: 1, at: new Date().toISOString(), backup };
  manifest.profilesPrepared = false;
  delete manifest.vadDiscarded;
  if (originals.length) {
    manifest.originalChunks = originals;
    manifest.chunks = originals;
    if (manifest.stage !== 'paused') manifest.stage = 'prepared';
  } else {
    delete manifest.chunks;
    manifest.stage = 'new';
  }
  // Saved vocals, profiles, and comparison namespaces remain on disk for review.
  await writeJson(file, manifest);
  return manifest;
}
