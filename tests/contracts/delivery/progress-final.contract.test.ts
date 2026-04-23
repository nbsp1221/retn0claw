import { describe, expect, it } from 'vitest';

import {
  expectNoVisibleDelivery,
  expectSingleSemanticFinal,
} from '../../support/assertions.js';
import { runSemanticTranscript } from '../../support/semantic-delivery-boundary.js';
import { deliveryScenarios } from '../fixtures/scenario-matrix.js';

describe('delivery contract: progress and final semantics', () => {
  for (const scenario of deliveryScenarios) {
    it(scenario.name, () => {
      const result = runSemanticTranscript(scenario.events, scenario.options);

      if (scenario.expectation === 'single-final') {
        expectSingleSemanticFinal(result.visibleActions);
      } else {
        expectNoVisibleDelivery(result.visibleActions);
      }

      if (scenario.expectedTerminalReason) {
        expect(result.state.terminalReason).toBe(
          scenario.expectedTerminalReason,
        );
      }
    });
  }
});
