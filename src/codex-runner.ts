import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CONTAINER_MAX_OUTPUT_SIZE } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

export interface CodexInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface CodexOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---RETN0CLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---RETN0CLAW_OUTPUT_END---';

function getCodexRunnerScriptPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFile);
  return fileURLToPath(
    new URL(`./codex-runner-process${extension}`, import.meta.url),
  );
}

function getCodexRunnerCommand(): { command: string; args: string[] } {
  const scriptPath = getCodexRunnerScriptPath();
  if (scriptPath.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: [
        path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        scriptPath,
      ],
    };
  }
  return {
    command: process.execPath,
    args: [scriptPath],
  };
}

export async function runCodexAgent(
  group: RegisteredGroup,
  input: CodexInput,
  onProcess: (proc: ChildProcess, runtimeHandle: string) => void,
  onOutput?: (output: CodexOutput) => Promise<void>,
): Promise<CodexOutput> {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const runtimeHandle = `retn0claw-codex-${group.folder}-${Date.now()}`;

  return new Promise((resolve) => {
    const command = getCodexRunnerCommand();
    const proc = spawn(command.command, command.args, {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(proc, runtimeHandle);

    let stdout = '';
    let stdoutTruncated = false;
    let parseBuffer = '';
    let latestOutput: CodexOutput = {
      status: 'success',
      result: null,
    };
    let outputChain = Promise.resolve();

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;

        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          latestOutput = JSON.parse(jsonStr) as CodexOutput;
          if (onOutput) {
            outputChain = outputChain
              .then(() => onOutput(latestOutput))
              .catch((error) => {
                logger.error(
                  { error, group: group.folder },
                  'Codex runner output callback failed',
                );
              });
          }
        } catch (error) {
          logger.warn(
            { error, group: group.folder },
            'Failed to parse Codex runner output chunk',
          );
        }
      }
    });

    proc.stderr.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          logger.debug({ group: group.folder }, trimmed);
        }
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && latestOutput.result === null && !latestOutput.error) {
        latestOutput = {
          status: 'error',
          result: null,
          error: `Codex runner exited with code ${code}`,
        };
      }

      outputChain.finally(() => resolve(latestOutput));
    });
  });
}
