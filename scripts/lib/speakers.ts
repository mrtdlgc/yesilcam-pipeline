import type { Segment } from '../../types/pipeline.js';
import { createHash } from 'node:crypto';

export const subtitleHash = (source: string) => createHash('sha256').update(source).digest('hex');

export function speakerContext(segments: Segment[]) {
  const cues = segments
    .filter((s) => s.speaker !== undefined && s.speakerScope !== undefined)
    .map((s) => ({
      cueId: String(s.id),
      speaker: String(s.speaker),
      scope: String(s.speakerScope),
    }));
  if (!cues.length) return undefined;
  return {
    version: 1,
    note: 'Anonymous, tentative voice groups. Compare IDs only within the same scope. They are not character names or evidence of gender. Speaker changes help identify dialogue turns; uncertain attribution needs review.',
    cues,
  };
}
