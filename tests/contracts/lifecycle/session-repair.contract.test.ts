import { describe, expect, it } from 'vitest';

import { runSemanticTranscript } from '../../support/semantic-delivery-boundary.js';
import { createRunnerSessionHarness } from '../../support/sqlite-harness.js';
import { buildTranscript } from '../../support/transcript-builders.js';

describe('lifecycle contract: session repair and isolation', () => {
  it('resume_failed clears stale session before replacement session is stored', () => {
    const result = runSemanticTranscript(
      buildTranscript([
        { type: 'meta', sessionId: 'thread-stale' },
        { type: 'resume_failed', sessionId: 'thread-stale' },
        { type: 'meta', sessionId: 'thread-fresh' },
        { type: 'final', text: 'done' },
      ]),
      { previewCapability: 'final-only' },
    );

    expect(result.stateTransitions).toContainEqual({
      type: 'session_clear',
      reason: 'resume_failed',
    });
    expect(result.stateTransitions).toContainEqual({
      type: 'session_store',
      sessionId: 'thread-fresh',
    });
    expect(result.state.sessionId).toBe('thread-fresh');
  });

  it('session updates during progress persist before final closure', () => {
    const result = runSemanticTranscript(
      buildTranscript([
        { type: 'progress', text: 'draft' },
        { type: 'meta', sessionId: 'thread-live' },
        { type: 'final', text: 'done' },
      ]),
      { previewCapability: 'preview-capable' },
    );

    expect(result.stateTransitions).toContainEqual({
      type: 'session_store',
      sessionId: 'thread-live',
    });
    expect(result.state.terminalReason).toBe('final');
  });

  it('keeps provider session namespaces isolated for the same group', () => {
    const harness = createRunnerSessionHarness();

    try {
      harness.set('claude', 'shared-group', 'claude-session');
      harness.set('codex', 'shared-group', 'codex-session');

      expect(harness.get('claude', 'shared-group')).toBe('claude-session');
      expect(harness.get('codex', 'shared-group')).toBe('codex-session');

      harness.clear('codex', 'shared-group');

      expect(harness.get('claude', 'shared-group')).toBe('claude-session');
      expect(harness.get('codex', 'shared-group')).toBeUndefined();
    } finally {
      harness.close();
    }
  });
});
