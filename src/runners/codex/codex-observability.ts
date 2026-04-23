import {
  applyCodexAppServerEvent,
  createInitialCodexAppServerState,
  type CodexAppServerEvent,
  type CodexAppServerState,
} from './codex-app-server-state.js';
import {
  createCodexDiagnostics,
  emitCodexDiagnostic,
  type CodexCorrelationContext,
  type CodexDiagnosticEvent,
} from './codex-diagnostics.js';
import {
  createCodexTranscriptSink,
  type CodexTranscriptSource,
} from './codex-transcript-sink.js';

interface ParsedNotification {
  method?: string;
  params?: Record<string, any>;
}

export interface CodexObservabilityOptions {
  groupFolder: string | null;
  chatJid: string | null;
  runnerKind: CodexCorrelationContext['runnerKind'];
  runId: string | null;
  threadId?: string | null;
  turnId?: string | null;
  traceRootDir?: string;
  traceEnabled?: boolean;
  log?: (message: string) => void;
  writeDiagnostic?: (event: CodexDiagnosticEvent) => void;
}

function parseTranscriptPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asEvent(message: ParsedNotification): CodexAppServerEvent | null {
  if (message.method === 'turn/completed') {
    return {
      type: 'turn.completed',
      threadId: String(message.params?.threadId || ''),
      turnId: String(message.params?.turn?.id || ''),
      status: String(message.params?.turn?.status || 'completed') as
        | 'completed'
        | 'failed'
        | 'interrupted',
      error: message.params?.turn?.error?.message || null,
    };
  }

  if (message.method === 'item/agentMessage/delta') {
    return {
      type: 'agent.delta',
      threadId: String(message.params?.threadId || ''),
      turnId: String(message.params?.turnId || ''),
      delta: String(message.params?.delta || ''),
    };
  }

  if (message.method === 'item/completed') {
    const item = message.params?.item;
    if (!item) return null;
    if (item.type === 'agentMessage') {
      return {
        type: 'item.completed',
        threadId: String(message.params?.threadId || ''),
        turnId: String(message.params?.turnId || ''),
        itemType: 'agentMessage',
        text: item.text || null,
        phase: item.phase || null,
      };
    }
    return {
      type: 'tool.activity',
      threadId: String(message.params?.threadId || ''),
      turnId: String(message.params?.turnId || ''),
      summary: `${String(item.type)}${item.title ? `: ${String(item.title)}` : ''}`,
    };
  }

  return null;
}

export function createCodexObservability(options: CodexObservabilityOptions) {
  const sink = createCodexTranscriptSink({
    enabled: options.traceEnabled,
    rootDir: options.traceRootDir,
    groupFolder: options.groupFolder || 'unknown',
    chatJid: options.chatJid,
    runnerKind: options.runnerKind,
    runId: options.runId || 'unknown',
    warn: options.log,
  });
  const writeDiagnostic = options.writeDiagnostic || emitCodexDiagnostic;
  const log = options.log || (() => {});
  let state: CodexAppServerState = createInitialCodexAppServerState();

  function currentContext(): CodexCorrelationContext {
    return {
      groupFolder: options.groupFolder,
      chatJid: options.chatJid,
      runnerKind: options.runnerKind,
      runId: options.runId,
      threadId: state.threadId ?? options.threadId ?? null,
      turnId: state.activeTurnId ?? options.turnId ?? null,
    };
  }

  function eventContext(event: CodexAppServerEvent): CodexCorrelationContext {
    return {
      groupFolder: options.groupFolder,
      chatJid: options.chatJid,
      runnerKind: options.runnerKind,
      runId: options.runId,
      threadId:
        'threadId' in event
          ? event.threadId || null
          : currentContext().threadId,
      turnId:
        'turnId' in event ? event.turnId || null : currentContext().turnId,
    };
  }

  function record(
    source: CodexTranscriptSource,
    payload: unknown,
    ids?: { threadId?: string | null; turnId?: string | null },
  ) {
    sink.record(source, payload, {
      threadId: ids?.threadId ?? state.threadId,
      turnId: ids?.turnId ?? state.activeTurnId,
    });
  }

  return {
    getState() {
      return state;
    },
    getTranscriptPath() {
      return sink.isEnabled() ? sink.getPath() : null;
    },
    observeRawStdoutLine(line: string) {
      record('app-server-stdout', parseTranscriptPayload(line));
    },
    observeRawStderrLine(line: string) {
      record('app-server-stderr', parseTranscriptPayload(line));
    },
    recordHostEvent(
      payload: unknown,
      ids?: { threadId?: string | null; turnId?: string | null },
    ) {
      record('host', payload, ids);
    },
    emitRunStarted(details?: Record<string, unknown>) {
      writeDiagnostic(createCodexDiagnostics(currentContext()).runStarted());
      if (details) {
        record('host', { type: 'run_started', ...details });
      }
    },
    emitSessionResumeAttempted(sessionId: string) {
      writeDiagnostic(
        createCodexDiagnostics(currentContext()).sessionResumeAttempted(
          sessionId,
        ),
      );
    },
    emitSessionResumeFailed(sessionId: string, error: string) {
      writeDiagnostic(
        createCodexDiagnostics(currentContext()).sessionResumeFailed(
          sessionId,
          error,
        ),
      );
      record('host', { type: 'resume_failed', sessionId, error });
    },
    emitSessionReplaced(
      previousSessionId: string | null,
      nextSessionId: string,
    ) {
      writeDiagnostic(
        createCodexDiagnostics(currentContext()).sessionReplaced(
          previousSessionId,
          nextSessionId,
        ),
      );
      record('host', {
        type: 'session_replaced',
        previousSessionId,
        nextSessionId,
      });
    },
    emitSessionStuck(details: {
      startedAt: string;
      observedAt: string;
      reason: string;
    }) {
      writeDiagnostic(
        createCodexDiagnostics(currentContext()).sessionStuck(details),
      );
      record('host', {
        type: 'session_stuck',
        ...details,
      });
    },
    onParseFailure(line: string, error: Error) {
      log(`Failed to parse app-server message: ${error.message}`);
      record('host', { type: 'parse_failure', line, error: error.message });
      writeDiagnostic(
        createCodexDiagnostics(currentContext()).runParseFailure(error.message),
      );
    },
    applyEvent(event: CodexAppServerEvent) {
      state = applyCodexAppServerEvent(state, event);
      return state;
    },
    applyParsedNotification(
      message: ParsedNotification,
    ): CodexAppServerEvent | null {
      const event = asEvent(message);
      if (!event) return null;
      state = applyCodexAppServerEvent(state, event);
      const diagnostics = createCodexDiagnostics(eventContext(event));

      if (event.type === 'tool.activity') {
        writeDiagnostic(diagnostics.runToolActivity(event.summary));
      } else if (event.type === 'agent.delta' && event.delta.trim()) {
        writeDiagnostic(
          diagnostics.runProgress({ deltaLength: event.delta.length }),
        );
      } else if (event.type === 'turn.completed') {
        writeDiagnostic(
          event.status === 'failed'
            ? diagnostics.runFailed(event.error || 'Turn failed')
            : event.status === 'interrupted'
              ? diagnostics.runInterrupted({ terminalReason: event.status })
              : diagnostics.runCompleted({ terminalReason: event.status }),
        );
      }

      return event;
    },
  };
}
