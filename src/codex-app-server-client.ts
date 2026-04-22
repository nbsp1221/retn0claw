import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import type { CodexOAuthTokens } from './codex-auth-store.js';

export interface CodexAppServerInputText {
  type: 'text';
  text: string;
  text_elements: [];
}

export interface CodexAppServerInputLocalImage {
  type: 'localImage';
  path: string;
}

export type CodexAppServerInput =
  | CodexAppServerInputText
  | CodexAppServerInputLocalImage;

export interface CodexAppServerClientOptions {
  cwd: string;
  getTokens: () => CodexOAuthTokens;
  log: (message: string) => void;
  spawnAppServer?: () => ChildProcessWithoutNullStreams;
}

export interface CodexAppServerThreadOptions {
  cwd: string;
  model?: string;
}

export interface CodexAppServerTurnOptions {
  cwd: string;
  model?: string;
  effort?: string;
  onProgress?: (message: string) => void;
}

export interface CodexAppServerTurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  result: string | null;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  onProgress?: (message: string) => void;
  result: string | null;
  resolve: (value: CodexAppServerTurnResult) => void;
  reject: (reason?: unknown) => void;
}

function createJsonRpcMessage(id: number, method: string, params?: unknown) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function createJsonRpcNotification(method: string, params?: unknown) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    ...(params === undefined ? {} : { params }),
  });
}

export class CodexAppServerClient {
  private readonly cwd: string;
  private readonly getTokens: () => CodexOAuthTokens;
  private readonly log: (message: string) => void;
  private readonly spawnAppServer: () => ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private loginWaiter:
    | {
        resolve: () => void;
        reject: (reason?: unknown) => void;
      }
    | undefined;
  private activeTurn: ActiveTurn | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.cwd = options.cwd;
    this.getTokens = options.getTokens;
    this.log = options.log;
    this.spawnAppServer =
      options.spawnAppServer ||
      (() =>
        spawn('codex', ['app-server'], {
          cwd: this.cwd,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        }));
  }

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = this.spawnAppServer();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleMessage(trimmed);
      }
    });

    this.proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          this.log(`[codex-app-server] ${trimmed}`);
        }
      }
    });

    this.proc.on('close', (code) => {
      const error = new Error(
        `codex app-server exited with code ${code ?? 'unknown'}`,
      );
      this.failAll(error);
    });
    this.proc.on('error', (error) => {
      this.failAll(error);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'retn0claw_codex_runner',
        title: 'retn0claw Codex Runner',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized');
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    const killProcess = (signal: NodeJS.Signals) => {
      if (proc.pid == null) {
        proc.kill(signal);
        return;
      }
      if (process.platform === 'win32') {
        proc.kill(signal);
        return;
      }
      process.kill(-proc.pid, signal);
    };
    let exited = false;
    proc.once('close', () => {
      exited = true;
    });
    try {
      killProcess('SIGTERM');
      setTimeout(() => {
        if (!exited) {
          try {
            killProcess('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }, 1000).unref();
    } catch {
      /* ignore */
    }
  }

  async login(): Promise<void> {
    const tokens = this.getTokens();
    const loginCompleted = new Promise<void>((resolve, reject) => {
      this.loginWaiter = { resolve, reject };
    });

    await this.request('account/login/start', {
      type: 'chatgptAuthTokens',
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    });

    await loginCompleted;
  }

  async startOrResumeThread(
    sessionId: string | undefined,
    options: CodexAppServerThreadOptions,
  ): Promise<string> {
    const params = {
      cwd: options.cwd,
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'retn0claw',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };

    const response = sessionId
      ? ((await this.request('thread/resume', {
          threadId: sessionId,
          ...params,
        })) as { thread?: { id?: string } })
      : ((await this.request('thread/start', params)) as {
          thread?: { id?: string };
        });

    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id.');
    }
    return threadId;
  }

  async startTurn(
    threadId: string,
    input: CodexAppServerInput[],
    options: CodexAppServerTurnOptions,
  ): Promise<{
    turnId: string;
    steer: (nextInput: CodexAppServerInput[]) => Promise<void>;
    interrupt: () => Promise<void>;
    wait: () => Promise<CodexAppServerTurnResult>;
  }> {
    if (this.activeTurn) {
      throw new Error('A Codex app-server turn is already active.');
    }

    const waitPromise = new Promise<CodexAppServerTurnResult>(
      (resolve, reject) => {
        this.activeTurn = {
          threadId,
          turnId: '',
          onProgress: options.onProgress,
          result: null,
          resolve,
          reject,
        };
      },
    );

    let response: { turn?: { id?: string } };
    try {
      response = (await this.request('turn/start', {
        threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'dangerFullAccess',
        },
        model: options.model,
        effort: options.effort,
        summary: 'concise',
      })) as { turn?: { id?: string } };
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    const turnId = response.turn?.id;
    if (!turnId) {
      const pendingTurn = this.activeTurn as ActiveTurn | null;
      if (pendingTurn) {
        pendingTurn.reject(
          new Error('Codex app-server did not return a turn id.'),
        );
      }
      this.activeTurn = null;
      throw new Error('Codex app-server did not return a turn id.');
    }

    this.activeTurn!.turnId = turnId;

    return {
      turnId,
      steer: async (nextInput) => {
        await this.request('turn/steer', {
          threadId,
          input: nextInput,
          expectedTurnId: turnId,
        });
      },
      interrupt: async () => {
        await this.request('turn/interrupt', {
          threadId,
          turnId,
        });
      },
      wait: async () => waitPromise,
    };
  }

  private async refreshTokens(id: number): Promise<void> {
    const tokens = this.getTokens();
    this.writeRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          chatgptAccountId: tokens.chatgptAccountId,
          chatgptPlanType: tokens.chatgptPlanType,
        },
      }),
    );
  }

  private handleMessage(line: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, any>;
      result?: unknown;
      error?: { message?: string };
    };

    try {
      message = JSON.parse(line);
    } catch (error) {
      this.log(
        `Failed to parse app-server message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    if (typeof message.id === 'number' && message.method) {
      if (message.method === 'account/chatgptAuthTokens/refresh') {
        void this.refreshTokens(message.id);
      }
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'JSON-RPC error'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;

    if (message.method === 'account/login/completed') {
      const success = message.params?.success === true;
      if (success) {
        this.loginWaiter?.resolve();
      } else {
        this.loginWaiter?.reject(
          new Error(message.params?.error || 'Codex login failed'),
        );
      }
      this.loginWaiter = undefined;
      return;
    }

    if (
      message.method === 'item/agentMessage/delta' &&
      this.activeTurn &&
      message.params?.turnId === this.activeTurn.turnId
    ) {
      this.activeTurn.onProgress?.(String(message.params?.delta || ''));
      return;
    }

    if (
      message.method === 'item/completed' &&
      this.activeTurn &&
      message.params?.turnId === this.activeTurn.turnId &&
      message.params?.item?.type === 'agentMessage'
    ) {
      this.activeTurn.result = message.params.item.text || null;
      return;
    }

    if (
      message.method === 'turn/completed' &&
      this.activeTurn &&
      message.params?.turn?.id === this.activeTurn.turnId
    ) {
      const activeTurn = this.activeTurn;
      this.activeTurn = null;
      const status = String(message.params?.turn?.status || 'completed');
      if (status === 'failed') {
        activeTurn.resolve({
          status: 'failed',
          result: activeTurn.result,
          error: message.params?.turn?.error?.message || 'Turn failed',
        });
      } else if (status === 'interrupted') {
        activeTurn.resolve({
          status: 'interrupted',
          result: activeTurn.result,
        });
      } else {
        activeTurn.resolve({
          status: 'completed',
          result: activeTurn.result,
        });
      }
    }
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.writeRaw(createJsonRpcMessage(id, method, params));
    return response;
  }

  private notify(method: string, params?: unknown): void {
    this.writeRaw(createJsonRpcNotification(method, params));
  }

  private writeRaw(line: string): void {
    if (!this.proc) {
      throw new Error('Codex app-server is not running.');
    }
    this.proc.stdin.write(`${line}\n`);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
    this.loginWaiter?.reject(error);
    this.loginWaiter = undefined;
    if (this.activeTurn) {
      this.activeTurn.reject(error);
      this.activeTurn = null;
    }
  }
}
