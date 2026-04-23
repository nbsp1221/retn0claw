import { describe, expect, it } from 'vitest';

import { runSemanticTranscript } from '../../support/semantic-delivery-boundary.js';
import { buildTranscript } from '../../support/transcript-builders.js';

describe('lifecycle contract: interrupt and close', () => {
  it('close before final suppresses any late final delivery', () => {
    const result = runSemanticTranscript(
      buildTranscript([
        { type: 'progress', text: 'draft' },
        { type: 'close' },
        { type: 'final', text: 'too late' },
      ]),
      { previewCapability: 'preview-capable' },
    );

    expect(result.state.terminal).toBe(true);
    expect(result.state.terminalReason).toBe('close');
    expect(
      result.visibleActions.filter(
        (action) =>
          action.type === 'final_send' ||
          action.type === 'final_replace_preview',
      ),
    ).toEqual([]);
  });

  it('interrupt closes delivery ownership before any late terminal event', () => {
    const result = runSemanticTranscript(
      buildTranscript([
        { type: 'progress', text: 'draft' },
        { type: 'interrupt' },
        { type: 'final', text: 'too late' },
      ]),
      { previewCapability: 'preview-capable' },
    );

    expect(result.state.terminal).toBe(true);
    expect(result.state.terminalReason).toBe('interrupt');
    expect(
      result.steps.slice(2).flatMap((step) => step.visibleActions),
    ).toEqual([]);
  });
});
