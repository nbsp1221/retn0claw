import { describe, expect, it } from 'vitest';

import { buildTranscript } from '../../support/transcript-builders.js';

describe('semantic transcript builders', () => {
  it('produces semantic delivery events from compact fixture input', () => {
    const transcript = buildTranscript([
      { type: 'meta', sessionId: 'thread-1' },
      { type: 'progress', text: 'draft' },
      { type: 'final', text: 'done' },
    ]);

    expect(transcript).toEqual([
      { type: 'meta', sessionId: 'thread-1' },
      { type: 'progress', text: 'draft' },
      { type: 'final', text: 'done' },
    ]);
  });
});
