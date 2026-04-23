import type { DeliveryBoundaryOptions } from '../../support/semantic-delivery-boundary.js';
import { semanticTranscripts } from './semantic-transcripts.js';

type Scenario = {
  name: string;
  events: typeof semanticTranscripts.finalOnly.events;
  options: DeliveryBoundaryOptions;
};

export const deliveryScenarios: Array<
  Scenario & {
    expectation: 'single-final' | 'no-visible-delivery';
    expectedTerminalReason: 'final' | null;
  }
> = [
  {
    name: 'final only produces one visible final',
    events: semanticTranscripts.finalOnly.events,
    options: { previewCapability: 'final-only' },
    expectation: 'single-final',
    expectedTerminalReason: 'final',
  },
  {
    name: 'meta only remains invisible',
    events: semanticTranscripts.metaOnly.events,
    options: { previewCapability: 'final-only' },
    expectation: 'no-visible-delivery',
    expectedTerminalReason: null,
  },
  {
    name: 'progress storm then final still yields one final in final-only mode',
    events: semanticTranscripts.progressStormThenFinal.events,
    options: { previewCapability: 'final-only' },
    expectation: 'single-final',
    expectedTerminalReason: 'final',
  },
  {
    name: 'empty final remains invisible but still closes the turn',
    events: semanticTranscripts.emptyFinal.events,
    options: { previewCapability: 'final-only' },
    expectation: 'no-visible-delivery',
    expectedTerminalReason: 'final',
  },
];

export const terminalSuppressionScenarios: Array<
  Scenario & { terminalIndex: number }
> = [
  {
    name: 'late progress after final is suppressed',
    events: semanticTranscripts.progressThenFinalThenLateProgress.events,
    options: { previewCapability: 'preview-capable' },
    terminalIndex: 1,
  },
  {
    name: 'duplicate final after terminal delivery is suppressed',
    events: semanticTranscripts.duplicateFinalAfterTerminal.events,
    options: { previewCapability: 'preview-capable' },
    terminalIndex: 1,
  },
];

export const previewCapabilityScenarios: Array<
  Scenario & { expectPreview: boolean; expectSemanticFinal: boolean }
> = [
  {
    name: 'preview-capable channels surface progress as preview',
    events: semanticTranscripts.progressOnly.events,
    options: { previewCapability: 'preview-capable' },
    expectPreview: true,
    expectSemanticFinal: false,
  },
  {
    name: 'final-only channels suppress progress preview',
    events: semanticTranscripts.progressOnly.events,
    options: { previewCapability: 'final-only' },
    expectPreview: false,
    expectSemanticFinal: false,
  },
  {
    name: 'preview-capable channels can finalize an existing preview without duplicate send',
    events: semanticTranscripts.progressThenEmptyFinal.events,
    options: { previewCapability: 'preview-capable' },
    expectPreview: true,
    expectSemanticFinal: true,
  },
  {
    name: 'whitespace-only progress does not create a preview',
    events: semanticTranscripts.whitespaceOnlyProgress.events,
    options: { previewCapability: 'preview-capable' },
    expectPreview: false,
    expectSemanticFinal: false,
  },
];
