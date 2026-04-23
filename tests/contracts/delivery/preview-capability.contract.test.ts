import { describe, expect, it } from 'vitest';

import {
  expectNoProgressPreview,
  expectSingleSemanticFinal,
} from '../../support/assertions.js';
import { runSemanticTranscript } from '../../support/semantic-delivery-boundary.js';
import { previewCapabilityScenarios } from '../fixtures/scenario-matrix.js';

describe('delivery contract: preview capability', () => {
  for (const scenario of previewCapabilityScenarios) {
    it(scenario.name, () => {
      const result = runSemanticTranscript(scenario.events, scenario.options);

      if (scenario.expectPreview) {
        expect(
          result.visibleActions.some(
            (action) => action.type === 'preview_update',
          ),
        ).toBe(true);
      } else {
        expectNoProgressPreview(result.visibleActions);
      }

      if (scenario.expectSemanticFinal) {
        expectSingleSemanticFinal(result.visibleActions);
      }
    });
  }
});
