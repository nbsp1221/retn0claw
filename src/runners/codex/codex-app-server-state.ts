export type CodexTurnTerminalReason =
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'error';

export type CodexAppServerEvent =
  | { type: 'thread.started'; threadId: string }
  | { type: 'turn.started'; threadId: string; turnId: string }
  | { type: 'agent.delta'; threadId: string; turnId: string; delta: string }
  | {
      type: 'item.completed';
      threadId: string;
      turnId: string;
      itemType: string;
      text?: string | null;
      phase?: string | null;
    }
  | {
      type: 'tool.activity';
      threadId: string;
      turnId: string;
      summary: string;
    }
  | {
      type: 'turn.completed';
      threadId: string;
      turnId: string;
      status: 'completed' | 'failed' | 'interrupted';
      error?: string | null;
    }
  | {
      type: 'error';
      threadId?: string | null;
      turnId?: string | null;
      error: string;
    };

export interface CodexAppServerState {
  threadId: string | null;
  activeTurnId: string | null;
  latestIntermediate: string | null;
  latestAgentText: string | null;
  finalAnswer: string | null;
  observedToolActivity: string[];
  terminalReason: CodexTurnTerminalReason | null;
  terminalError: string | null;
  events: CodexAppServerEvent[];
}

export function createInitialCodexAppServerState(): CodexAppServerState {
  return {
    threadId: null,
    activeTurnId: null,
    latestIntermediate: null,
    latestAgentText: null,
    finalAnswer: null,
    observedToolActivity: [],
    terminalReason: null,
    terminalError: null,
    events: [],
  };
}

export function applyCodexAppServerEvent(
  state: CodexAppServerState,
  event: CodexAppServerEvent,
): CodexAppServerState {
  const next: CodexAppServerState = {
    ...state,
    observedToolActivity: [...state.observedToolActivity],
    events: [...state.events, event],
  };
  const isTerminal = next.terminalReason !== null;

  switch (event.type) {
    case 'thread.started':
      next.threadId = event.threadId;
      return next;

    case 'turn.started':
      next.threadId = event.threadId;
      next.activeTurnId = event.turnId;
      next.latestIntermediate = null;
      next.latestAgentText = null;
      next.finalAnswer = null;
      next.observedToolActivity = [];
      next.terminalReason = null;
      next.terminalError = null;
      return next;

    case 'agent.delta':
      if (state.activeTurnId && event.turnId !== state.activeTurnId)
        return next;
      if (isTerminal) return next;
      next.threadId = event.threadId;
      next.activeTurnId = event.turnId;
      next.latestIntermediate = `${next.latestIntermediate || ''}${event.delta}`;
      return next;

    case 'item.completed':
      if (state.activeTurnId && event.turnId !== state.activeTurnId)
        return next;
      if (isTerminal) return next;
      if (event.itemType === 'agentMessage' && typeof event.text === 'string') {
        next.threadId = event.threadId;
        next.activeTurnId = event.turnId;
        next.latestAgentText = event.text;
        if (event.phase === 'final_answer') {
          next.finalAnswer = event.text;
        }
      } else if (event.itemType !== 'agentMessage') {
        next.observedToolActivity.push(event.itemType);
      }
      return next;

    case 'tool.activity':
      if (state.activeTurnId && event.turnId !== state.activeTurnId)
        return next;
      if (isTerminal) return next;
      next.threadId = event.threadId;
      next.activeTurnId = event.turnId;
      next.observedToolActivity.push(event.summary);
      return next;

    case 'turn.completed':
      if (isTerminal) return next;
      if (state.activeTurnId && event.turnId !== state.activeTurnId)
        return next;
      next.threadId = event.threadId;
      next.activeTurnId = null;
      next.terminalReason = event.status;
      next.terminalError = event.error || null;
      return next;

    case 'error':
      if (isTerminal) return next;
      if (
        event.turnId &&
        state.activeTurnId &&
        event.turnId !== state.activeTurnId
      ) {
        return next;
      }
      next.threadId = event.threadId || next.threadId;
      next.activeTurnId = null;
      next.terminalReason = 'error';
      next.terminalError = event.error;
      return next;
  }
}

export function isTurnTerminal(state: CodexAppServerState): boolean {
  return state.terminalReason !== null;
}

export function getLatestIntermediate(
  state: CodexAppServerState,
): string | null {
  return state.latestIntermediate;
}

export function getFinalAnswer(state: CodexAppServerState): string | null {
  return state.finalAnswer;
}

export function getObservedToolActivity(state: CodexAppServerState): string[] {
  return [...state.observedToolActivity];
}

export function getTerminalReason(
  state: CodexAppServerState,
): CodexTurnTerminalReason | null {
  return state.terminalReason;
}
