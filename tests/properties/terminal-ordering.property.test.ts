import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { runSemanticTranscript } from '../support/semantic-delivery-boundary.js';
import type { SemanticEvent } from '../support/semantic-events.js';
import { createRunnerSessionHarness } from '../support/sqlite-harness.js';

const ORDERING_SEED = 31337;
const ORDERING_RUNS = Number(process.env.PROPERTY_RUNS || '50');

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

describe('property: terminal ordering and provider isolation', () => {
  it('never emits visible actions after terminal closure', () => {
    fc.assert(
      fc.property(
        fc.array(semanticEventArbitrary, { maxLength: 25 }),
        (events) => {
          const result = runSemanticTranscript(events, {
            previewCapability: 'preview-capable',
          });

          const terminalIndex = result.steps.findIndex(
            (step) => step.state.terminal,
          );
          if (terminalIndex === -1) {
            expect(result.state.terminal).toBe(false);
            return;
          }

          const lateVisibleActions = result.steps
            .slice(terminalIndex + 1)
            .flatMap((step) => step.visibleActions);
          expect(lateVisibleActions).toEqual([]);
        },
      ),
      { seed: ORDERING_SEED, numRuns: ORDERING_RUNS },
    );
  });

  it('keeps provider namespaces isolated under arbitrary set/clear sequences', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            runnerKind: fc.constantFrom<'claude' | 'codex'>('claude', 'codex'),
            groupFolder: fc.string({ minLength: 1, maxLength: 8 }),
            sessionId: fc.string({ minLength: 1, maxLength: 8 }),
            clear: fc.boolean(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (operations) => {
          const harness = createRunnerSessionHarness('retn0claw-property-');
          const expected = new Map<string, string>();

          try {
            for (const operation of operations) {
              const key = JSON.stringify([
                operation.runnerKind,
                operation.groupFolder,
              ]);
              if (operation.clear) {
                harness.clear(operation.runnerKind, operation.groupFolder);
                expected.delete(key);
              } else {
                harness.set(
                  operation.runnerKind,
                  operation.groupFolder,
                  operation.sessionId,
                );
                expected.set(key, operation.sessionId);
              }
            }

            for (const [key, sessionId] of expected) {
              const [runnerKind, groupFolder] = JSON.parse(key) as [
                'claude' | 'codex',
                string,
              ];
              expect(harness.get(runnerKind, groupFolder)).toBe(sessionId);
            }
          } finally {
            harness.close();
          }
        },
      ),
      { seed: ORDERING_SEED + 1, numRuns: ORDERING_RUNS },
    );
  });
});
