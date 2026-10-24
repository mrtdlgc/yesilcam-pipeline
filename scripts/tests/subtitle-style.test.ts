import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-style-'));
process.env.DATA_DIR = root;
const {
  formatSubtitleDocument,
  subtitlesToAss,
  subtitleStyleReport,
  visibleLength,
  visibleText,
  wrapSubtitle,
} = await import('../lib/subtitle-style.js');
const { validateCodexTranslation, translateWithCodex, codexPrompt } =
  await import('../lib/codex-translation.js');
const { parseSrt } = await import('../lib/srt.js');
const { run } = await import('../lib/process.js');
after(() => fs.rm(root, { recursive: true, force: true }));
const text = 'Seni burada göreceğimi bilmiyordum ama geldiğine gerçekten çok sevindim.';
const words = (value: string) => visibleText(value).replace(/\s+/gu, ' ').trim();

test('wraps Turkish and English without losing words, markup or grapheme clusters', () => {
  for (const [language, source] of [
    ['tr', `<i>${text}</i>`],
    ['en', 'I thought you had gone home, but I am glad you stayed.'],
    ['en', '<font color="white">We met at the station, and then walked home together.</font>'],
  ]) {
    const result = wrapSubtitle(source, language);
    assert.equal(words(result), words(source));
    assert.equal(result.split('\n').length, 2);
    assert.ok(result.split('\n').every((line) => visibleLength(line) <= 42));
    assert.equal(wrapSubtitle(result, language), result);
  }
  assert.equal(visibleLength('<i>I\u0307 &amp; ş</i>'), 5);
  assert.equal(wrapSubtitle('Merhaba!'), 'Merhaba!');
});

test('does not collapse dual-speaker or lyric lines, even when they would fit one line', () => {
  assert.equal(
    wrapSubtitle('-Geliyor musun?\n-Bir dakika.', 'tr'),
    '-Geliyor musun?\n-Bir dakika.',
  );
  assert.equal(wrapSubtitle('♪ Bir gün ♪\n♪ Döneceğim ♪', 'tr'), '♪ Bir gün ♪\n♪ Döneceğim ♪');
});

test('oversize words and fixed cues retain all text and get actionable review notes', () => {
  const source = `001\n00:00:01,000 --> 00:00:01,400\n${'ş'.repeat(90)}\n\n7\n00:00:01,200 --> 00:00:09,200\nMerhaba.\n`;
  const formatted = formatSubtitleDocument(source, 'tr');
  assert.equal(formatted.cues[0].text, 'ş'.repeat(90));
  const codes = new Set(formatted.report.warnings.map((w) => w.code));
  for (const code of ['line_length', 'reading_speed', 'short_duration', 'long_duration', 'overlap'])
    assert.ok(codes.has(code), code);
  assert.deepEqual(
    formatted.cues.map((c) => [c.id, c.startTime, c.endTime]),
    parseSrt(source).map((c) => [c.id, c.startTime, c.endTime]),
  );
});

test('translation styling preserves exact headers, overlaps and meaningful markup', () => {
  const source = `\uFEFF001\r\n00:00:01.000  -->  00:00:05.000\r\n<i>${text}</i>\r\n\r\n7\r\n00:00:04,900 --> 00:00:06,000\r\n-Gel!\r\n-Tamam.\r\n`;
  const result = validateCodexTranslation(source, source, 'tr');
  assert.ok(result.srt.startsWith('\uFEFF001\r\n00:00:01.000  -->  00:00:05.000\r\n'));
  assert.match(result.srt, /\r\n7\r\n00:00:04,900 --> 00:00:06,000\r\n-Gel!\r\n-Tamam\./);
  assert.equal(words(result.cues[0].text), words(parseSrt(source)[0].text));
  assert.equal(result.cues[0].text.startsWith('<i>'), true);
  assert.equal(result.cues[0].text.endsWith('</i>'), true);
});

test('language-specific adult reading limits reach both the prompt and the report', () => {
  const cue = { id: '1', start: 0, end: 1, text: '123456789012345678' };
  assert.ok(subtitleStyleReport([cue], 'tr').warnings.some((w) => w.code === 'reading_speed'));
  assert.equal(subtitleStyleReport([cue], 'en').warnings.length, 0);
  const prompt = codexPrompt('1\n00:00:00,000 --> 00:00:01,000\nHello!\n', {
    sourceLanguage: 'en',
    targetLanguage: 'tr',
  });
  assert.match(prompt, /42 visible characters per line/);
  assert.match(prompt, /17 visible characters per second/);
  assert.match(prompt, /Never merge, split, drop, renumber or retime/);
});

test('ASS renders italic text and hard breaks while neutralizing literal override commands', async () => {
  const cues = [
    { id: '001', start: 1.234, end: 3.456, text: '<i>Merhaba!</i>\nNasılsın?' },
    { id: '2', start: 4, end: 4.001, text: '{\\pos(0,0)} literal \\N &lt;i&gt;text&lt;/i&gt;' },
  ];
  const ass = subtitlesToAss(cues);
  assert.match(ass, /\{\\i1\}Merhaba!\{\\i0\}\\NNasılsın\?/);
  assert.ok(!ass.includes('{\\pos(0,0)}'));
  assert.ok(!ass.includes('literal \\N'));
  const file = path.join(root, 'styled.ass');
  await fs.writeFile(file, ass);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_packets', '-of', 'json', file], {
    timeout: 5000,
  });
  const packets = JSON.parse(stdout).packets;
  assert.equal(packets.length, 2);
  assert.equal(Number(packets[0].pts_time), 1.23);
  assert.equal(Number(packets[0].duration_time), 2.23);
  assert.equal(Number(packets[1].duration_time), 0.01);
});

test('completed legacy translation receipts restyle without running Codex again', async () => {
  const workDir = path.join(root, 'legacy');
  await fs.mkdir(workDir);
  const source = `1\n00:00:01,000 --> 00:00:06,000\n${text}\n`;
  const context = { title: 'Legacy', sourceLanguage: 'tr', targetLanguage: 'en' };
  const input = path.join(workDir, 'input.srt'),
    output = path.join(workDir, 'output.srt');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  await fs.writeFile(input, source);
  await fs.writeFile(path.join(workDir, 'codex-result.srt'), source);
  await fs.writeFile(
    path.join(workDir, 'codex-receipt.json'),
    JSON.stringify({
      signature: hash(JSON.stringify({ source, context, model: '', promptVersion: 1 })),
      completed: true,
      outputHash: hash(source),
    }),
  );
  const result = await translateWithCodex(input, output, context, null, {
    workDir,
    settings: { CODEX_BIN: '/nonexistent-never-run', CODEX_MODEL: '' },
  });
  assert.equal(result.report.timestampsIdentical, true);
  assert.equal(result.segments[0].text.split('\n').length, 2);
  assert.equal(await fs.readFile(input, 'utf8'), source);
});
