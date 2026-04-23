import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { semanticFinalCount } from '../support/assertions.js';
import { runSemanticTranscript } from '../support/semantic-delivery-boundary.js';
import type { SemanticEvent } from '../support/semantic-events.js';

const EVENT_SEED = 424242;
const EVENT_RUNS = Number(process.env.PROPERTY_RUNS || '50');

const semanticEventArbitrary: fc.Arbitrary<SemanticEvent> = fc.oneof(
  fc.string().map((text) => ({ type: 'progress' as const, text })),
  fc.option(fc.string(), { nil: null }).map((text) => ({
    type: 'final' as const,
    text,
  })),
  fc.option(fc.string(), { nil: undefined }).map((sessionId) => ({
    type: 'meta' as const,
    sessionId,
  })),
  fc.constant({ type: 'resume_failed' as const }),
  fc.constant({ type: 'interrupt' as const }),
  fc.constant({ type: 'close' as const }),
);

describe('property: delivery invariants', () => {
  it('never produces more than one semantic final for any transcript', () => {
    fc.assert(
      fc.property(
        fc.array(semanticEventArbitrary, { maxLength: 25 }),
        fc.constantFrom<'preview-capable' | 'final-only'>(
          'preview-capable',
          'final-only',
        ),
        (events, previewCapability) => {
          const result = runSemanticTranscript(events, { previewCapability });

          expect(semanticFinalCount(result.visibleActions)).toBeLessThanOrEqual(
            1,
          );
        },
      ),
      { seed: EVENT_SEED, numRuns: EVENT_RUNS },
    );
  });
});
