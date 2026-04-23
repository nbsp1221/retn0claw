import {
  runSemanticTranscript,
  type DeliveryBoundaryOptions,
} from './semantic-delivery-boundary.js';
import type { SemanticEvent } from './semantic-events.js';
import type { VisibleAction } from './visible-actions.js';

export class FakeChannel {
  readonly mode: DeliveryBoundaryOptions['previewCapability'];
  readonly visibleActions: VisibleAction[] = [];

  constructor(
    mode: DeliveryBoundaryOptions['previewCapability'] = 'final-only',
  ) {
    this.mode = mode;
  }

  dispatch(events: readonly SemanticEvent[]): VisibleAction[] {
    const result = runSemanticTranscript(events, {
      previewCapability: this.mode,
    });
    this.visibleActions.push(...result.visibleActions);
    return result.visibleActions;
  }
}
