import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';
import type { Segment } from '../../types/pipeline.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-editorial-'));
process.env.DATA_DIR = root;
after(() => fs.rm(root, { recursive: true, force: true }));
const { editorialSource, editorialPrompt, validateEditorialTranslation } =
  await import('../lib/editorial-subtitles.js');
const { parseSrt, segmentsToSrt } = await import('../lib/srt.js');
const { subtitlesToAss } = await import('../lib/subtitle-style.js');
const { createSubtitleReview, editSubtitleReview, reviewExport } =
  await import('../lib/subtitle-review.js');
const { prepareSubtitleReview } = await import('../lib/review-preparation.js');
const { at, writeJson } = await import('../lib/files.js');
const { config } = await import('../../config.js');
const { shotBoundaries } = await import('../lib/shot-boundaries.js');
const { run } = await import('../lib/process.js');
const { subtitleHash } = await import('../lib/speakers.js');

const words = [
  ['Merhaba.', 1, 1.4, 'A'],
  ['Gel', 1.5, 1.8, 'A'],
  ['buraya.', 1.9, 2.4, 'A'],
  ['Tamam.', 2.6, 3.3, 'B'],
  ['Bahar', 4, 4.5, 'singer'],
  ['geldi', 4.6, 5, 'singer'],
  ['Gitme!', 5.2, 6.1, 'A'],
  ['Kalbimde', 6.4, 6.9, 'singer'],
  ['umut', 7, 7.5, 'singer'],
] as const;
const segments: Segment[] = words.map(([text, start, end, speaker], i) => ({
  id: String(i + 1),
  text,
  start,
  end,
  speaker,
  speakerScope: 'movie',
  _timing: 'native_word',
  words: [{ start, end, word: text, speaker, speakerScope: 'movie' }],
}));
const source = segmentsToSrt(segments);
const data = editorialSource(source, segments, [
  { start: 4, end: 5, text: '(singing)', speaker: 'singer', speakerScope: 'movie' },
  { start: 6.4, end: 7.5, text: 'singing', speaker: 'singer', speakerScope: 'movie' },
]);
data.frameRate = 25;
data.duration = 10;
const part = (from: number, to: number, text: string) => ({ from, to, text });
const dialogue = (from: number, to: number, text: string) => ({
  parts: [part(from, to, text)],
  kind: 'dialogue',
  action: 'keep',
});
const plan = () => ({
  version: 1,
  cues: [
    dialogue(1, 3, 'Hello. Come here.'),
    dialogue(4, 4, 'Okay.'),
    {
      parts: [part(5, 6, 'Spring has come.')],
      kind: 'lyric',
      songUse: 'background',
      action: 'omit',
      reason: 'Incidental background refrain between dialogue turns.',
    },
    dialogue(7, 7, "Don't go!"),
    { parts: [part(8, 9, 'Hope in my heart')], kind: 'lyric', songUse: 'story', action: 'keep' },
  ],
});
const validate = (candidate: unknown, evidence = data) =>
  validateEditorialTranslation(source, JSON.stringify(candidate), evidence);

test('regroups native words into meaningful dialogue without punctuation cuts or invented dashes', () => {
  const result = validate(plan());
  assert.equal(result.editorial.coveredAnchors, 9);
  assert.equal(result.editorial.cues[0].source, 'Merhaba. Gel buraya.');
  assert.equal(result.cues[0].text, 'Hello. Come here.');
  assert.ok(result.cues[0].start <= 1 && result.cues[0].start >= 0.96);
  assert.ok(result.cues[0].end <= result.cues[1].start - 0.08 + 0.001);
  assert.ok(result.editorial.cues.every((c) => !c.text.startsWith('-')));
  assert.equal(result.editorial.cues[3].parts[0].from, 7);
});

test('selective lyrics stay italic across SRT and ASS; omitted lyrics remain in paired review', () => {
  const result = validate(plan());
  assert.doesNotMatch(result.srt, /Spring/);
  assert.match(result.srt, /<i>Hope in my heart<\/i>/);
  assert.match(subtitlesToAss(result.cues), /\{\\i1\}Hope in my heart\{\\i0\}/);
  assert.match(result.reviewTarget, /<i>Spring has come<\/i>/);
  assert.equal(result.editorial.cues[2].omitted, true);
  assert.deepEqual(
    parseSrt(result.reviewSource).map((c) => [c.id, c.start, c.end]),
    parseSrt(result.reviewTarget).map((c) => [c.id, c.start, c.end]),
  );
});

test('music and remembered song titles cannot authorize deletion, and dialogue cannot be omitted', () => {
  const unproven = editorialSource(source, segments, [{ start: 0, end: 10, text: '(music)' }]);
  const result = validate(plan(), unproven);
  assert.match(result.srt, /Spring has come/);
  assert.equal(result.editorial.cues[2].omitted, false);
  assert.ok(result.editorial.cues[2].warnings.includes('song_omission_withheld_unverified'));
  const unscoped = editorialSource(source, segments, [{ start: 0, end: 10, text: '(singing)' }]);
  assert.ok(
    unscoped.anchors.every((a) => !a.singing),
    'generic singing cannot identify which overlapping words were sung',
  );
  const bad = plan();
  bad.cues[0].action = 'omit';
  assert.throws(() => validate(bad), /Only incidental background lyrics/);
});

test('strict range coverage rejects missing, repeated, reordered, invented and placeholder output', () => {
  const missing = plan();
  missing.cues.splice(1, 1);
  const duplicate = plan();
  duplicate.cues.splice(1, 0, duplicate.cues[0]);
  const reordered = plan();
  reordered.cues.reverse();
  const invented = plan();
  invented.cues.at(-1)!.parts[0].to = 10;
  const trailing = plan();
  trailing.cues.pop();
  const placeholder = plan();
  placeholder.cues[0].parts[0].text = '[translation]';
  const markup = plan();
  markup.cues[0].parts[0].text = '<script>text</script>';
  for (const candidate of [missing, duplicate, reordered, invented, trailing, placeholder, markup])
    assert.throws(() => validate(candidate));
  assert.throws(() => validateEditorialTranslation(source, '```json\n{}\n```', data), /valid JSON/);
  assert.throws(() => validate(plan(), { ...data, sourceHash: 'changed' }), /does not match/);
});

test('natural pauses and long ASR intervals are review warnings without discarding completed translation', () => {
  const input = '1\n00:00:01,000 --> 00:00:12,000\nNo, we have not.\n';
  const segment = {
    start: 1,
    end: 12,
    text: 'No, we have not.',
    speaker: 'A',
    speakerScope: 'movie',
    _timing: 'native_word',
    words: [
      { start: 1, end: 1.4, word: 'No,' },
      { start: 2.8, end: 3, word: 'we' },
      { start: 3.1, end: 3.4, word: 'have' },
      { start: 3.5, end: 12, word: 'not.' },
    ],
  };
  const evidence = editorialSource(input, [segment]);
  const candidate = JSON.stringify({ version: 1, cues: [dialogue(1, 4, 'No, we have not.')] });
  const result = validateEditorialTranslation(input, candidate, evidence);
  assert.equal(result.editorial.coveredAnchors, 4);
  assert.equal(result.cues[0].end, 12, 'retain native timing instead of inventing word alignment');
  assert.equal(result.cues[0].text, 'No, we have not.');
  assert.ok(result.editorial.cues[0].warnings.includes('pause_within_cue_check_timing'));
  assert.ok(result.editorial.cues[0].warnings.includes('long_cue_check_source_timing_and_split'));
  assert.match(result.reviewSource, /No, we have not/);
  const missing = JSON.stringify({ version: 1, cues: [dialogue(1, 3, 'No, we have')] });
  assert.throws(() => validateEditorialTranslation(input, missing, evidence), /untranslated/);
});

test('speaker turns, singing transitions and unscoped voices cannot be silently combined', () => {
  const voices = plan();
  voices.cues[0].parts[0].to = 4;
  voices.cues.splice(1, 1);
  assert.throws(() => validate(voices), /speaker turn/);
  const mixture = structuredClone(data);
  mixture.anchors[2].singing = true;
  assert.throws(() => validate(plan(), mixture), /mixes singing/);
  const unknown = structuredClone(data);
  for (const a of unknown.anchors) a.speaker = null;
  assert.throws(() => validate(plan(), unknown), /speaker turn/);
});

test('two-speaker cues require distinct scoped voices and complete short sentences', () => {
  const dual = plan();
  dual.cues[0].parts.push(dual.cues[1].parts[0]);
  dual.cues.splice(1, 1);
  assert.match(validate(dual).srt, /-Hello\. Come here\.\n-Okay\./);
  const fragment = structuredClone(dual);
  fragment.cues[0].parts[1].text = 'And then';
  assert.throws(() => validate(fragment), /Dual-speaker/);
  const crossChunk = structuredClone(data);
  crossChunk.anchors[3].scope = 'chunk_2';
  assert.throws(() => validate(dual, crossChunk), /Dual-speaker/);
});

test('song hypotheses and ASR repairs are actionable notes without altering source words', () => {
  const candidate = plan();
  Object.assign(candidate.cues[4], {
    song: 'Possible song title',
    sourceCorrection: 'Check whether umut was umudum in this performance.',
    review: ['Listen to the final word.'],
  });
  const result = validate(candidate);
  const cue = result.editorial.cues[4];
  assert.equal(cue.source, 'Kalbimde umut');
  assert.ok(cue.warnings.includes('song_match_unverified'));
  assert.ok(cue.warnings.some((w) => w.startsWith('check_source_correction:')));
  const prompt = editorialPrompt(
    source,
    {
      sourceLanguage: 'tr',
      targetLanguage: 'en',
      songReferences: 'A possible title; this performance changes the verse.',
    },
    data,
  );
  assert.match(prompt, /remembered lyrics as a hypothesis/);
  assert.match(prompt, /web access is disabled/);
  const payload = JSON.parse(prompt.split('\n').at(-1)!);
  assert.equal(payload.runs.flatMap((r: any) => r.anchors).length, 9);
  assert.match(payload.songReferences, /performance changes/);
  assert.equal(
    payload.source_srt,
    undefined,
    'do not duplicate whole-film text and bloat the prompt',
  );
});

test('SRT-only and estimated input never invent word-level timing', () => {
  const fallback = editorialSource(source);
  assert.ok(fallback.anchors.every((a) => a.unit === 'cue'));
  const estimated = editorialSource(
    source,
    segments.map((s) => ({ ...s, _timing: 'estimated_speech_distribution' })),
  );
  assert.ok(estimated.anchors.every((a) => a.unit === 'cue'));
  assert.equal(estimated.anchors[0].start, segments[0].start);
  const partial = editorialSource(source, [{ ...segments[0], text: 'Merhaba. Gel buraya.' }]);
  assert.equal(partial.anchors[0].unit, 'cue');
  assert.equal(
    partial.anchors[0].text,
    'Merhaba. Gel buraya.',
    'incomplete word timing must not discard untimed words',
  );
});

test('timing extends into free space, stops at cuts and flags real overlap without moving words', () => {
  const oneSource = '1\n00:00:01,000 --> 00:00:01,500\nMerhaba.\n';
  const evidence = editorialSource(oneSource);
  evidence.frameRate = 25;
  evidence.cuts = [1.76];
  evidence.duration = 2;
  const result = validateEditorialTranslation(
    oneSource,
    JSON.stringify({ version: 1, cues: [dialogue(1, 1, 'Hello, my friend.')] }),
    evidence,
  );
  assert.equal(result.cues[0].start, 1);
  assert.equal(result.cues[0].end, 1.76);
  assert.ok(result.warnings.some((w) => w.code === 'short_duration'));
  const overlap = structuredClone(data);
  overlap.anchors[3].start = 2.3;
  const kept = validate(plan(), overlap);
  assert.ok(kept.editorial.cues[0].warnings.includes('overlapping_speech_review'));
  assert.ok(kept.editorial.cues[0].end >= 2.4);
});

test('automatically omitted lyrics can be restored without losing original exports or corrections', async () => {
  const result = validate(plan());
  const document = await createSubtitleReview({
    id: 'restore-song',
    title: 'Fixture',
    source: result.reviewSource,
    target: result.reviewTarget,
    sourceLanguage: 'tr',
    targetLanguage: 'en',
    media: null,
    duration: 10,
    omissions: Object.fromEntries(result.editorial.cues.map((c) => [c.id, c.omitted])),
  });
  assert.doesNotMatch(reviewExport(document, 'en', 'srt'), /Spring/);
  const edited = await editSubtitleReview(document.id, {
    revision: 0,
    edits: [{ id: '3', omitted: false, texts: { en: '<i>Spring is here</i>' } }],
  });
  assert.match(reviewExport(edited, 'en', 'srt'), /Spring is here/);
  assert.doesNotMatch(reviewExport(edited, 'en', 'srt', true), /Spring/);
});

test('review preparation uses mapped bilingual cues and verifies their hashes', async () => {
  const result = validate(plan());
  const write = async (name: string, content: string) => {
    const file = at('output', 'reviews', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return `/output/reviews/${name}`;
  };
  const reviewSourceFile = await write('paired-source.srt', result.reviewSource);
  const reviewTargetFile = await write('paired-target.srt', result.reviewTarget);
  const original = await write('original.srt', source);
  const report = {
    editorial: {
      ...result.editorial,
      reviewSourceHash: subtitleHash(result.reviewSource),
      reviewTargetHash: subtitleHash(result.reviewTarget),
    },
  };
  await writeJson(at('output', 'reviews', 'translation.json'), report);
  const job = {
    id: 'prepare-editorial',
    type: 'translation',
    title: 'Fixture',
    settings: config,
  } as any;
  const files = {
    subtitleFile: original,
    reviewSourceFile,
    reviewTargetFile,
    translationReviewFile: '/output/reviews/translation.json',
    sourceLanguage: 'tr',
    targetLanguage: 'en',
  };
  const links = await prepareSubtitleReview(job, files);
  assert.ok(links.reviewUrl);
  const saved = JSON.parse(
    await fs.readFile(at('data', 'subtitle-reviews', `${job.id}.json`), 'utf8'),
  );
  assert.equal(saved.cues.length, 5);
  assert.equal(saved.cues[2].omitted, true);
  assert.equal(saved.cues[0].texts.tr, 'Merhaba. Gel buraya.');
  await fs.appendFile(at('output', 'reviews', 'paired-target.srt'), '\n');
  await assert.rejects(
    prepareSubtitleReview({ ...job, id: 'tampered-editorial' }, files),
    /no longer matches/,
  );
});

test(
  'scene-cut evidence uses actual video frame times in a short local fixture',
  { timeout: 10000 },
  async () => {
    const video = path.join(root, 'cuts.mp4');
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=160x90:r=24:d=1',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:s=160x90:r=24:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map',
        '[v]',
        '-map',
        '2:a',
        '-threads',
        '1',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        video,
      ],
      { timeout: 5000 },
    );
    const result = await shotBoundaries(video);
    assert.equal(result.frameRate, 24);
    assert.equal(result.shotDetection, 'complete');
    assert.ok(result.cuts.some((cut) => Math.abs(cut - 1) < 1 / 24));
    assert.equal(
      (await shotBoundaries(video, { settings: { EDITORIAL_SHOT_DETECTION: false } }))
        .shotDetection,
      'not-run',
    );
  },
);
