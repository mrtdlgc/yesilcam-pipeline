import { atomicWrite, writeJson } from './files.js';
import { formatSubtitleDocument, subtitlesToAss } from './subtitle-style.js';

export async function writeSubtitleArtifacts(
  output: string,
  source: string,
  language: string,
  reviewFile: string,
) {
  const formatted = formatSubtitleDocument(source, language);
  const assFile = output.replace(/\.srt$/i, '.ass');
  if (assFile === output) throw new Error('Subtitle export requires an SRT filename');
  await atomicWrite(output, formatted.srt);
  await atomicWrite(assFile, subtitlesToAss(formatted.cues));
  await writeJson(reviewFile, formatted.report);
  return { ...formatted, assFile, reviewFile };
}
