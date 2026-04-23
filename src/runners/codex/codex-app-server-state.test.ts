import { describe, expect, it } from 'vitest';

import {
  applyCodexAppServerEvent,
  createInitialCodexAppServerState,
  getFinalAnswer,
  getLatestIntermediate,
  getObservedToolActivity,
  getTerminalReason,
  isTurnTerminal,
  type CodexAppServerEvent,
} from './codex-app-server-state.js';

function run(events: CodexAppServerEvent[]) {
  return events.reduce(
    applyCodexAppServerEvent,
    createInitialCodexAppServerState(),
  );
}

describe('codex app-server state reducer', () => {
  it('tracks active turn lifecycle and terminal completion', () => {
    const state = run([
      { type: 'thread.started', threadId: 'thread-1' },
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'turn.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
      },
    ]);

    expect(state.threadId).toBe('thread-1');
    expect(state.activeTurnId).toBeNull();
    expect(isTurnTerminal(state)).toBe(true);
    expect(getTerminalReason(state)).toBe('completed');
  });

  it('resets turn-scoped final and tool state when a new turn starts', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'item.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemType: 'agentMessage',
        text: '첫 final',
        phase: 'final_answer',
      },
      {
        type: 'tool.activity',
        threadId: 'thread-1',
        turnId: 'turn-1',
        summary: 'command_execution: uname -a',
      },
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-2' },
    ]);

    expect(state.activeTurnId).toBe('turn-2');
    expect(state.finalAnswer).toBeNull();
    expect(state.latestAgentText).toBeNull();
    expect(state.observedToolActivity).toEqual([]);
  });

  it('accumulates intermediate delta text', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'agent.delta',
        threadId: 'thread-1',
        turnId: 'turn-1',
        delta: '안',
      },
      {
        type: 'agent.delta',
        threadId: 'thread-1',
        turnId: 'turn-1',
        delta: '녕',
      },
    ]);

    expect(getLatestIntermediate(state)).toBe('안녕');
  });

  it('updates latest agent text from completed agent messages', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'item.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemType: 'agentMessage',
        text: '중간 정리',
      },
    ]);

    expect(state.latestAgentText).toBe('중간 정리');
  });

  it('captures final answer phase separately from intermediate text', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'item.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemType: 'agentMessage',
        text: '최종 답변',
        phase: 'final_answer',
      },
    ]);

    expect(getFinalAnswer(state)).toBe('최종 답변');
    expect(state.latestAgentText).toBe('최종 답변');
  });

  it('records tool activity when tool items are observed', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'tool.activity',
        threadId: 'thread-1',
        turnId: 'turn-1',
        summary: 'command_execution: uname -a',
      },
    ]);

    expect(getObservedToolActivity(state)).toEqual([
      'command_execution: uname -a',
    ]);
  });

  it('marks terminal error state from explicit error events', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'error',
        threadId: 'thread-1',
        turnId: 'turn-1',
        error: 'broken',
      },
    ]);

    expect(isTurnTerminal(state)).toBe(true);
    expect(getTerminalReason(state)).toBe('error');
    expect(state.terminalError).toBe('broken');
  });

  it('retains late events in history but keeps terminal selectors stable', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'item.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemType: 'agentMessage',
        text: '첫 final',
        phase: 'final_answer',
      },
      {
        type: 'turn.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
      },
      {
        type: 'item.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemType: 'agentMessage',
        text: '너무 늦음',
      },
    ]);

    expect(getFinalAnswer(state)).toBe('첫 final');
    expect(state.latestAgentText).toBe('첫 final');
    expect(state.events).toHaveLength(4);
  });

  it('ignores non-matching turn events for live selectors while retaining history', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'agent.delta',
        threadId: 'thread-1',
        turnId: 'turn-2',
        delta: 'wrong',
      },
      {
        type: 'tool.activity',
        threadId: 'thread-1',
        turnId: 'turn-2',
        summary: 'command_execution: wrong',
      },
    ]);

    expect(getLatestIntermediate(state)).toBeNull();
    expect(getObservedToolActivity(state)).toEqual([]);
    expect(state.events).toHaveLength(3);
  });

  it('ignores late terminal events after a turn is already closed', () => {
    const state = run([
      { type: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        type: 'turn.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
      },
      {
        type: 'turn.completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'failed',
        error: 'late failure',
      },
      {
        type: 'error',
        threadId: 'thread-1',
        turnId: 'turn-1',
        error: 'late parse error',
      },
    ]);

    expect(getTerminalReason(state)).toBe('completed');
    expect(state.terminalError).toBeNull();
    expect(state.events).toHaveLength(4);
  });
});
