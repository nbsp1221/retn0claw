export type SemanticEvent =
  | { type: 'progress'; text: string }
  | { type: 'final'; text: string | null }
  | { type: 'meta'; sessionId?: string }
  | { type: 'resume_failed'; sessionId?: string }
  | { type: 'interrupt' }
  | { type: 'close' };

export type TranscriptInput = SemanticEvent;

export function hasVisibleText(
  text: string | null | undefined,
): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}
