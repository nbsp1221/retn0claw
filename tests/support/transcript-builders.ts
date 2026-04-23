import type { SemanticEvent, TranscriptInput } from './semantic-events.js';

export function buildTranscript(
  items: readonly TranscriptInput[],
): SemanticEvent[] {
  return items.map((item) => ({ ...item }));
}

export function namedTranscript(
  name: string,
  items: readonly TranscriptInput[],
): { name: string; events: SemanticEvent[] } {
  return { name, events: buildTranscript(items) };
}
