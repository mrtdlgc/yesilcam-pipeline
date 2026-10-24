import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-waveform-'));
process.env.DATA_DIR = root;
after(() => fs.rm(root, { recursive: true, force: true }));
const { at } = await import('../lib/files.js');
const { run } = await import('../lib/process.js');
const { createSubtitleReview, editSubtitleReview, readSubtitleReview } =
  await import('../lib/subtitle-review.js');
const { prepareReviewWaveform } = await import('../lib/review-waveform.js');

test(
  'waveform aligns delayed audio and silence, streams compact energy, reuses cache and preserves corrections',
  { timeout: 15000 },
  async () => {
    const directory = at('review-sessions', 'delayed');
    await fs.mkdir(directory, { recursive: true });
    const media = path.join(directory, 'screening.mkv');
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:r=5:d=4',
      '-itsoffset',
      '1',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(between(t,0.2,0.6),0.6*sin(2*PI*440*t),0)':s=8000:d=2",
      '-c:v',
      'ffv1',
      '-threads',
      '1',
      '-c:a',
      'pcm_s16le',
      media,
    ]);
    const source = '1\n00:00:01,200 --> 00:00:01,600\nMerhaba.\n';
    await createSubtitleReview({
      id: 'delayed',
      title: 'Delayed audio fixture',
      source,
      sourceLanguage: 'tr',
      targetLanguage: 'en',
      duration: 4.003,
      media: 'screening.mkv',
    });
    const edited = await editSubtitleReview('delayed', {
      revision: 0,
      edits: [{ id: '1', texts: { tr: 'Merhaba dünya.' }, start: 1.21, end: 1.61 }],
    });
    const [waveform, concurrent] = await Promise.all([
      prepareReviewWaveform('delayed'),
      prepareReviewWaveform('delayed'),
    ]);
    assert.deepEqual(waveform, concurrent);
    assert.equal(waveform.binsPerSecond, 100);
    const peaks = Buffer.from(waveform.peaks, 'base64'),
      rms = Buffer.from(waveform.rms, 'base64');
    assert.equal(peaks.length, 401, 'partial final bin is retained');
    assert.equal(rms.length, peaks.length);
    assert.ok(
      peaks.subarray(0, 117).every((value) => value === 0),
      'late audio does not slide to time zero',
    );
    assert.ok(
      peaks.subarray(123, 157).every((value) => value >= 150 && value <= 155),
      'tone amplitude and timing match the source',
    );
    assert.ok(
      rms.subarray(123, 157).every((value) => value >= 104 && value <= 112),
      'energy distinguishes RMS from the peaks',
    );
    assert.ok(
      peaks.subarray(163).every((value) => value === 0),
      'trailing silence stays silent',
    );
    const cache = path.join(directory, 'waveform.json');
    const first = await fs.stat(cache);
    assert.deepEqual(await prepareReviewWaveform('delayed'), waveform);
    assert.equal(
      (await fs.stat(cache)).mtimeMs,
      first.mtimeMs,
      'opening another editor does not decode again',
    );
    assert.deepEqual(
      await readSubtitleReview('delayed'),
      edited,
      'waveform generation does not alter review state',
    );
    const oldIdentity = JSON.parse(await fs.readFile(cache, 'utf8')).identity;
    await fs.utimes(media, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(await prepareReviewWaveform('delayed'), waveform);
    assert.notEqual(
      JSON.parse(await fs.readFile(cache, 'utf8')).identity,
      oldIdentity,
      'changed media invalidates the cached waveform',
    );
  },
);

test(
  'missing or broken screening media fails without a partial cache and can be retried',
  { timeout: 10000 },
  async () => {
    const source = '1\n00:00:00,100 --> 00:00:00,800\nHello.\n';
    await createSubtitleReview({
      id: 'unavailable',
      title: 'Unavailable',
      source,
      sourceLanguage: 'en',
      targetLanguage: 'en',
      duration: 1,
      media: null,
    });
    await assert.rejects(prepareReviewWaveform('unavailable'), /Prepare screening media/);
    const directory = at('review-sessions', 'broken');
    await fs.mkdir(directory, { recursive: true });
    const media = path.join(directory, 'screening.mp4');
    await fs.writeFile(media, 'broken media');
    await createSubtitleReview({
      id: 'broken',
      title: 'Retry',
      source,
      sourceLanguage: 'en',
      targetLanguage: 'en',
      duration: 1,
      media: 'screening.mp4',
    });
    await assert.rejects(prepareReviewWaveform('broken'), /ffmpeg exited/);
    await assert.rejects(fs.stat(path.join(directory, 'waveform.json')), { code: 'ENOENT' });
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:a',
      'aac',
      media,
    ]);
    assert.ok(
      Buffer.from((await prepareReviewWaveform('broken')).peaks, 'base64').some(
        (value) => value > 0,
      ),
    );
  },
);
