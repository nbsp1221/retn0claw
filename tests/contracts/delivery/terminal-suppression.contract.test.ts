import { describe, expect, it } from 'vitest';

import { expectSingleSemanticFinal } from '../../support/assertions.js';
import { runSemanticTranscript } from '../../support/semantic-delivery-boundary.js';
import { terminalSuppressionScenarios } from '../fixtures/scenario-matrix.js';

describe('delivery contract: terminal suppression', () => {
  for (const scenario of terminalSuppressionScenarios) {
    it(scenario.name, () => {
      const result = runSemanticTranscript(scenario.events, scenario.options);

      expectSingleSemanticFinal(result.visibleActions);
      expect(result.state.terminal).toBe(true);
      expect(result.state.terminalReason).toBe('final');
      expect(
        result.steps
          .slice(scenario.terminalIndex + 1)
          .flatMap((step) => step.visibleActions),
      ).toEqual([]);
    });
  }
});
