// Transcript quality is scored before hallucination filters or translation.
// Turkish casing keeps I/ı and İ/i distinct; diacritics are not stripped.
export function normalizedText(text: string, language = 'tr') {
  const locale = /^[a-z]{2,3}$/.test(language) && language !== 'und' ? language : undefined;
  return text
    .normalize('NFKC')
    .toLocaleLowerCase(locale)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
function distance(a: any, b: any) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}
export function score(reference: any, hypothesis: any, language: string) {
  if (
    typeof reference !== 'string' ||
    typeof hypothesis !== 'string' ||
    reference.length > 12000 ||
    hypothesis.length > 12000
  )
    throw new Error('Reference/transcript must be text, at most 12,000 characters per chunk');
  const ref = normalizedText(reference, language),
    hyp = normalizedText(hypothesis, language);
  const refWords = ref ? ref.split(' ') : [],
    hypWords = hyp ? hyp.split(' ') : [];
  const refChars = [...ref.replaceAll(' ', '')],
    hypChars = [...hyp.replaceAll(' ', '')];
  const wordErrors = distance(refWords, hypWords),
    charErrors = distance(refChars, hypChars);
  return {
    wordErrors,
    referenceWords: refWords.length,
    wordErrorRate: refWords.length ? wordErrors / refWords.length : null,
    charErrors,
    referenceCharacters: refChars.length,
    characterErrorRate: refChars.length ? charErrors / refChars.length : null,
    silenceInsertions: refWords.length === 0 ? hypWords.length : 0,
  };
}
export function aggregate(scores: any) {
  const sum = (key: string) => scores.reduce((n: any, s: any) => n + s[key], 0);
  const words = sum('referenceWords'),
    chars = sum('referenceCharacters');
  return {
    referenceWords: words,
    referenceCharacters: chars,
    wordErrors: sum('wordErrors'),
    charErrors: sum('charErrors'),
    wordErrorRate: words ? sum('wordErrors') / words : null,
    characterErrorRate: chars ? sum('charErrors') / chars : null,
    silenceInsertions: sum('silenceInsertions'),
  };
}
