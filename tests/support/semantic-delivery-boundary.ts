import { hasVisibleText, type SemanticEvent } from './semantic-events.js';
import type { StateTransition, VisibleAction } from './visible-actions.js';

export interface DeliveryBoundaryOptions {
  previewCapability: 'preview-capable' | 'final-only';
}

export interface DeliveryBoundaryState {
  previewText: string | null;
  sessionId: string | null;
  terminal: boolean;
  terminalReason: 'final' | 'interrupt' | 'close' | null;
}

export interface DeliveryBoundaryStep {
  state: DeliveryBoundaryState;
  visibleActions: VisibleAction[];
  stateTransitions: StateTransition[];
}

export interface DeliveryBoundaryResult extends DeliveryBoundaryStep {
  steps: DeliveryBoundaryStep[];
}

export function createInitialDeliveryState(): DeliveryBoundaryState {
  return {
    previewText: null,
    sessionId: null,
    terminal: false,
    terminalReason: null,
  };
}

export function applySemanticEvent(
  current: DeliveryBoundaryState,
  event: SemanticEvent,
  options: DeliveryBoundaryOptions,
): DeliveryBoundaryStep {
  const state: DeliveryBoundaryState = { ...current };
  const visibleActions: VisibleAction[] = [];
  const stateTransitions: StateTransition[] = [];

  switch (event.type) {
    case 'meta':
      if (event.sessionId) {
        state.sessionId = event.sessionId;
        stateTransitions.push({
          type: 'session_store',
          sessionId: event.sessionId,
        });
      }
      break;

    case 'resume_failed':
      state.sessionId = null;
      stateTransitions.push({ type: 'session_clear', reason: 'resume_failed' });
      break;

    case 'progress':
      if (state.terminal || !hasVisibleText(event.text)) {
        break;
      }
      state.previewText = event.text;
      if (options.previewCapability === 'preview-capable') {
        visibleActions.push({ type: 'preview_update', text: event.text });
      }
      break;

    case 'final': {
      if (state.terminal) {
        break;
      }
      const finalText = hasVisibleText(event.text) ? event.text : null;
      if (finalText) {
        if (
          options.previewCapability === 'preview-capable' &&
          state.previewText !== null
        ) {
          visibleActions.push({
            type: 'final_replace_preview',
            text: finalText,
          });
        } else {
          visibleActions.push({ type: 'final_send', text: finalText });
        }
      } else if (
        options.previewCapability === 'preview-capable' &&
        state.previewText !== null
      ) {
        visibleActions.push({
          type: 'preview_finalize',
          text: state.previewText,
        });
      }
      state.previewText = null;
      state.terminal = true;
      state.terminalReason = 'final';
      stateTransitions.push({ type: 'terminal_close', reason: 'final' });
      break;
    }

    case 'interrupt':
    case 'close':
      if (!state.terminal) {
        state.previewText = null;
        state.terminal = true;
        state.terminalReason = event.type;
        stateTransitions.push({ type: 'terminal_close', reason: event.type });
      }
      break;
  }

  return { state, visibleActions, stateTransitions };
}

export function runSemanticTranscript(
  events: readonly SemanticEvent[],
  options: DeliveryBoundaryOptions,
): DeliveryBoundaryResult {
  let state = createInitialDeliveryState();
  const steps: DeliveryBoundaryStep[] = [];
  const visibleActions: VisibleAction[] = [];
  const stateTransitions: StateTransition[] = [];

  for (const event of events) {
    const step = applySemanticEvent(state, event, options);
    state = step.state;
    steps.push(step);
    visibleActions.push(...step.visibleActions);
    stateTransitions.push(...step.stateTransitions);
  }

  return { state, steps, visibleActions, stateTransitions };
}
