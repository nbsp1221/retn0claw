import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  CHAT_CONTEXT_POLICY_CONFIG,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  resolveChatContextPolicy,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import { connectInstalledChannels } from './channels/connect.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  type AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './runners/shared/runner-artifacts.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './runners/claude/container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getChatInfo,
  getLastBotMessageTimestamp,
  getLastBotMessageSeq,
  getMaxMessageSeqAtOrBeforeTimestamp,
  getMessagesAfterSeq,
  getNewMessagesBySeq,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  storeChatMetadata,
  storeMessage,
  type StoredMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  createSyntheticTurnId,
  getSelectedRunnerKind,
  isTerminalRunnerOutput,
  type RunnerKind,
  runDefaultRunner,
  type RunnerOutput,
} from './runners/shared/runner.js';
import { createRunnerOutputAuditLoggerFactory } from './runners/shared/delivery-audit.js';
import { createDeliveryTurnManager } from './runners/shared/delivery-turn-manager.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import type { ChatPlatform, ChatType } from './types.js';
import { logger } from './logger.js';
import { assertCodexRunnerReadiness } from './runners/codex/codex-auth-store.js';
import {
  clearRunnerSession,
  getRunnerSessions,
  setRunnerSession,
} from './runners/shared/runner-session-store.js';
import {
  buildChatSurfacePrompt,
  type ChatSurfaceMessage,
  selectChatSurfaceMessages,
} from './prompt/chat-surface.js';
import {
  createChannelFeedbackController,
  type ChannelFeedbackController,
} from './feedback/channel-feedback-controller.js';
import type { FeedbackTarget } from './feedback/types.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let lastMessageSeq = 0;
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let lastAgentSeq: Record<string, number> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let feedbackController: ChannelFeedbackController =
  createChannelFeedbackController();
const activeRuntimeFeedbackTargets = new Map<string, FeedbackTarget>();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  lastMessageSeq = parseCursorSeq(getRouterState('last_message_seq'));
  if (lastMessageSeq === 0 && lastTimestamp) {
    lastMessageSeq =
      getMaxMessageSeqAtOrBeforeTimestamp(lastTimestamp) ?? lastMessageSeq;
  }

  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  lastAgentSeq = parseAgentSeqState(getRouterState('last_agent_seq'));
  for (const [chatJid, timestamp] of Object.entries(lastAgentTimestamp)) {
    if (lastAgentSeq[chatJid] !== undefined) continue;
    const seq = getMaxMessageSeqAtOrBeforeTimestamp(timestamp, chatJid);
    if (seq !== undefined) lastAgentSeq[chatJid] = seq;
  }
  const runnerKind = getSelectedRunnerKind();
  sessions = getRunnerSessions(runnerKind);
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length, runnerKind },
    'State loaded',
  );
}

function parseCursorSeq(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseAgentSeqState(
  value: string | null | undefined,
): Record<string, number> {
  if (!value) return {};
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    const parsed: Record<string, number> = {};
    for (const [chatJid, seq] of Object.entries(raw)) {
      if (typeof seq !== 'number') continue;
      if (Number.isSafeInteger(seq) && seq >= 0) parsed[chatJid] = seq;
    }
    return parsed;
  } catch {
    logger.warn('Corrupted last_agent_seq in DB, resetting');
    return {};
  }
}

function lastMessageTimestamp(messages: NewMessage[]): string | null {
  return messages.length > 0 ? messages[messages.length - 1].timestamp : null;
}

function advanceAgentCursor(
  chatJid: string,
  seq: number,
  timestamp: string,
): void {
  lastAgentSeq[chatJid] = seq;
  const previousTimestamp = lastAgentTimestamp[chatJid];
  lastAgentTimestamp[chatJid] =
    previousTimestamp && previousTimestamp > timestamp
      ? previousTimestamp
      : timestamp;
  saveState();
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverMessageSeq(chatJid: string): number {
  const existing = lastAgentSeq[chatJid];
  if (existing !== undefined) return existing;

  const legacyTimestamp = lastAgentTimestamp[chatJid];
  if (legacyTimestamp) {
    const seq = getMaxMessageSeqAtOrBeforeTimestamp(legacyTimestamp, chatJid);
    if (seq !== undefined) {
      lastAgentSeq[chatJid] = seq;
      saveState();
      return seq;
    }
  }

  const botSeq = getLastBotMessageSeq(chatJid, ASSISTANT_NAME);
  if (botSeq !== undefined) {
    const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
    logger.info(
      { chatJid, recoveredFromSeq: botSeq, recoveredFromTimestamp: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentSeq[chatJid] = botSeq;
    if (botTs) lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botSeq;
  }
  return 0;
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_message_seq', String(lastMessageSeq));
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState('last_agent_seq', JSON.stringify(lastAgentSeq));
}

/** @internal - exported for testing */
export function _resetRouterStateForTests(): void {
  lastTimestamp = '';
  lastMessageSeq = 0;
  lastAgentTimestamp = {};
  lastAgentSeq = {};
  saveState();
}

/** @internal - exported for testing */
export function _loadStateForTests(): void {
  loadState();
}

/** @internal - exported for testing */
export function _enqueueMessageCheckForTests(chatJid: string): void {
  queue.setProcessMessagesFn(processGroupMessages);
  queue.enqueueMessageCheck(chatJid);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** @internal - exported for testing */
export function _setSessionsForTests(
  nextSessions: Record<string, string>,
): void {
  sessions = { ...nextSessions };
}

/** @internal - exported for testing */
export function _setChannelsForTests(nextChannels: Channel[]): void {
  channels.length = 0;
  channels.push(...nextChannels);
}

/** @internal - exported for testing */
export function _setFeedbackControllerForTests(
  controller: ChannelFeedbackController,
): void {
  feedbackController.shutdown();
  feedbackController = controller;
}

/** @internal - exported for testing */
export function _resetFeedbackControllerForTests(): void {
  feedbackController.shutdown();
  feedbackController = createChannelFeedbackController();
  activeRuntimeFeedbackTargets.clear();
}

function normalizePlatform(value: string | null | undefined): ChatPlatform {
  return value === 'telegram' || value === 'discord' ? value : 'unknown';
}

function resolveChatType(chatJid: string): ChatType {
  const chatInfo = getChatInfo(chatJid);
  return chatInfo?.is_group === false ? 'dm' : 'group';
}

function toChatSurfaceMessage(message: NewMessage): ChatSurfaceMessage {
  return {
    id: message.id,
    sender: message.sender,
    senderName: message.sender_name,
    timestamp: message.timestamp,
    text: message.content,
    replyToMessageId: message.reply_to_message_id,
    replyToMessageContent: message.reply_to_message_content,
    replyToSenderName: message.reply_to_sender_name,
    replyToIsBot: message.reply_to_is_bot,
  };
}

function buildCodexChatPrompt(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
): { prompt: string | null; cursorTimestamp: string | null } {
  const chatInfo = getChatInfo(chatJid);
  const platform = normalizePlatform(chatInfo?.channel);
  const chatType = resolveChatType(chatJid);
  const channel = findChannel(channels, chatJid);
  const assistantAliases = channel?.getAssistantAliases?.(chatJid) ?? [];
  const contextPolicy = resolveChatContextPolicy({
    chatType,
    platform,
    registeredGroup: group,
    config: CHAT_CONTEXT_POLICY_CONFIG,
  });
  const allowlistCfg = loadSenderAllowlist();
  const selected = selectChatSurfaceMessages({
    messages,
    chatType,
    trigger: group.trigger,
    assistantAliases,
    contextPolicy,
    isGroupMessageAllowed: (message) =>
      message.is_from_me ||
      isTriggerAllowed(chatJid, message.sender, allowlistCfg),
  });

  if (!selected.latestMessage || !selected.addressedBy) {
    return {
      prompt: null,
      cursorTimestamp:
        contextPolicy === 'recent_all' ? null : selected.cursorTimestamp,
    };
  }

  return {
    prompt: buildChatSurfacePrompt({
      platform,
      chatType,
      chatName: chatInfo?.name ?? group.name,
      assistantName: ASSISTANT_NAME,
      trigger: group.trigger,
      assistantAliases,
      contextPolicy,
      addressedBy: selected.addressedBy,
      timezone: TIMEZONE,
      recentMessages: selected.recentMessages.map(toChatSurfaceMessage),
      latestMessage: toChatSurfaceMessage(selected.latestMessage),
    }),
    cursorTimestamp: selected.cursorTimestamp,
  };
}

function hasAllowedLegacyTrigger(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
): boolean {
  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  return messages.some(
    (message) =>
      triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
  );
}

function buildRunnerPrompt(input: {
  chatJid: string;
  group: RegisteredGroup;
  messages: NewMessage[];
  runnerKind: RunnerKind;
  legacyTriggerMessages?: NewMessage[];
}): { prompt: string | null; cursorTimestamp: string | null } {
  if (input.messages.length === 0) {
    return { prompt: null, cursorTimestamp: null };
  }

  if (input.runnerKind === 'codex') {
    return buildCodexChatPrompt(input.chatJid, input.group, input.messages);
  }

  if (
    input.group.isMain !== true &&
    input.group.requiresTrigger !== false &&
    !hasAllowedLegacyTrigger(
      input.chatJid,
      input.group,
      input.legacyTriggerMessages ?? input.messages,
    )
  ) {
    return { prompt: null, cursorTimestamp: null };
  }

  return {
    prompt: formatMessages(input.messages, TIMEZONE),
    cursorTimestamp: input.messages[input.messages.length - 1].timestamp,
  };
}

function feedbackTargetForRunnerOutput(
  output: RunnerOutput,
  fallback: FeedbackTarget,
): FeedbackTarget {
  return {
    ...fallback,
    turnId: output.turnId ?? fallback.turnId,
  };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const pending = getMessagesAfterSeq(
    chatJid,
    getOrRecoverMessageSeq(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );
  const missedMessages = pending.messages;

  if (missedMessages.length === 0) return true;
  const evaluatedSeq = missedMessages[missedMessages.length - 1].seq;
  const evaluatedTimestamp =
    missedMessages[missedMessages.length - 1].timestamp;

  const builtPrompt = buildRunnerPrompt({
    chatJid,
    group,
    messages: missedMessages,
    runnerKind: getSelectedRunnerKind(),
  });
  if (!builtPrompt.prompt) {
    advanceAgentCursor(
      chatJid,
      evaluatedSeq,
      builtPrompt.cursorTimestamp ?? evaluatedTimestamp,
    );
    if (pending.hasMore) queue.enqueueMessageCheck(chatJid);
    return true;
  }
  const prompt = builtPrompt.prompt;
  const cursorTimestamp = builtPrompt.cursorTimestamp ?? evaluatedTimestamp;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousSeq = lastAgentSeq[chatJid] ?? 0;
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  advanceAgentCursor(chatJid, evaluatedSeq, cursorTimestamp);

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let outputSentToUser = false;
  const runId = randomUUID();
  const runnerKind = getSelectedRunnerKind();
  const baseFeedbackTarget: FeedbackTarget = {
    chatJid,
    runId,
    turnId: createSyntheticTurnId(runnerKind, runId),
  };
  activeRuntimeFeedbackTargets.set(chatJid, baseFeedbackTarget);
  feedbackController.start({
    target: baseFeedbackTarget,
    feedback: channel.feedback,
  });
  let latestSessionId: string | null = null;
  const createAudit = createRunnerOutputAuditLoggerFactory(
    {
      groupFolder: group.folder,
      chatJid,
      runnerKind,
      runId,
    },
    () => latestSessionId,
  );
  const deliveryTurnManager = createDeliveryTurnManager({
    createAuditLogger: createAudit,
  });

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      const feedbackTarget = feedbackTargetForRunnerOutput(
        result,
        baseFeedbackTarget,
      );
      if (
        result.eventKind === 'turn_started' ||
        result.eventKind === 'progress'
      ) {
        feedbackController.start({
          target: feedbackTarget,
          feedback: channel.feedback,
        });
      }
      const terminal = isTerminalRunnerOutput(result);
      if (terminal) {
        feedbackController.markRunComplete(feedbackTarget);
      }

      try {
        if (result.newSessionId) {
          latestSessionId = result.newSessionId;
        }
        const delivery = deliveryTurnManager.consume(result);

        if (delivery.sendText) {
          const raw =
            typeof delivery.sendText === 'string'
              ? delivery.sendText
              : JSON.stringify(delivery.sendText);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            try {
              await channel.sendMessage(chatJid, text);
              createAudit(result).finalSent(text);
            } catch (error) {
              createAudit(result).finalFailed(
                error instanceof Error ? error.message : String(error),
              );
              throw error;
            }
            outputSentToUser = true;
          }
          resetIdleTimer();
        }

        if (delivery.notifyIdle) {
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      } finally {
        if (terminal) {
          feedbackController.markDeliveryIdle(feedbackTarget);
        }
      }
    },
    runId,
  );

  feedbackController.stopActive(chatJid, 'run_returned');
  activeRuntimeFeedbackTargets.delete(chatJid);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      if (pending.hasMore) queue.enqueueMessageCheck(chatJid);
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentSeq[chatJid] = previousSeq;
    if (previousCursor) {
      lastAgentTimestamp[chatJid] = previousCursor;
    } else {
      delete lastAgentTimestamp[chatJid];
    }
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  if (pending.hasMore) queue.enqueueMessageCheck(chatJid);
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: RunnerOutput) => Promise<void>,
  runId = randomUUID(),
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const runnerKind = getSelectedRunnerKind();
  const tasks = getAllTasks();
  const availableGroups = getAvailableGroups();
  const sessionStore = {
    get: () => sessions[group.folder],
    set: (sessionId: string) => {
      sessions[group.folder] = sessionId;
      setRunnerSession(runnerKind, group.folder, sessionId);
    },
    clear: () => {
      delete sessions[group.folder];
      clearRunnerSession(runnerKind, group.folder);
    },
  };

  try {
    const output = await runDefaultRunner({
      group,
      input: {
        prompt,
        runId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      session: sessionStore,
      tasksSnapshot: tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
      groupsSnapshot: {
        availableGroups,
        registeredJids: new Set(Object.keys(registeredGroups)),
      },
      onProcess: (proc, runtimeHandle) =>
        queue.registerProcess(chatJid, proc, runtimeHandle, group.folder),
      onOutput,
    });

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/** @internal - exported for testing */
export { runAgent as _runAgentForTests };
/** @internal - exported for testing */
export { processGroupMessages as _processGroupMessagesForTests };

interface ActiveRuntimeFollowUpInput {
  chatJid: string;
  prompt: string;
  channel: Channel;
  sendMessage?: (chatJid: string, prompt: string) => boolean;
}

function pipeActiveRuntimeFollowUp({
  chatJid,
  prompt,
  channel,
  sendMessage = queue.sendMessage.bind(queue),
}: ActiveRuntimeFollowUpInput): boolean {
  if (!sendMessage(chatJid, prompt)) return false;

  feedbackController.touchActive({
    chatJid,
    feedback: channel.feedback,
    createFallbackTarget: () => {
      const activeRuntimeTarget = activeRuntimeFeedbackTargets.get(chatJid);
      if (activeRuntimeTarget) return activeRuntimeTarget;

      const runId = `ipc-${randomUUID()}`;
      return {
        chatJid,
        runId,
        turnId: `ipc:${runId}:synthetic-turn`,
      };
    },
  });
  return true;
}

/** @internal - exported for testing */
export { pipeActiveRuntimeFollowUp as _pipeActiveRuntimeFollowUpForTests };

interface MessageLoopGroupMessagesInput {
  chatJid: string;
  groupMessages: NewMessage[];
  sendActiveRuntimeMessage?: (chatJid: string, prompt: string) => boolean;
}

function processMessageLoopGroupMessages({
  chatJid,
  groupMessages: _groupMessages,
  sendActiveRuntimeMessage,
}: MessageLoopGroupMessagesInput): void {
  const group = registeredGroups[chatJid];
  if (!group) return;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return;
  }

  const isMainGroup = group.isMain === true;
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
  const runnerKindForPrompt = getSelectedRunnerKind();

  const pending = getMessagesAfterSeq(
    chatJid,
    getOrRecoverMessageSeq(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );
  const allPending = pending.messages;
  const messagesToSend = allPending;
  if (messagesToSend.length === 0) return;

  if (needsTrigger && runnerKindForPrompt !== 'codex') {
    if (!hasAllowedLegacyTrigger(chatJid, group, messagesToSend)) {
      if (allPending.length > 0) {
        const last = allPending[allPending.length - 1];
        advanceAgentCursor(chatJid, last.seq, last.timestamp);
        if (pending.hasMore) queue.enqueueMessageCheck(chatJid);
      }
      return;
    }
  }

  const builtPrompt = buildRunnerPrompt({
    chatJid,
    group,
    messages: messagesToSend,
    runnerKind: runnerKindForPrompt,
    legacyTriggerMessages: messagesToSend,
  });
  if (!builtPrompt.prompt) {
    if (allPending.length > 0) {
      const last = allPending[allPending.length - 1];
      advanceAgentCursor(
        chatJid,
        last.seq,
        builtPrompt.cursorTimestamp ?? last.timestamp,
      );
      if (pending.hasMore) queue.enqueueMessageCheck(chatJid);
    }
    return;
  }
  const formatted = builtPrompt.prompt;
  const evaluatedLast = allPending[allPending.length - 1] as
    | StoredMessage
    | undefined;
  const cursorTimestamp =
    builtPrompt.cursorTimestamp ??
    messagesToSend[messagesToSend.length - 1].timestamp;

  if (
    pipeActiveRuntimeFollowUp({
      chatJid,
      prompt: formatted,
      channel,
      sendMessage: sendActiveRuntimeMessage,
    })
  ) {
    logger.debug(
      { chatJid, count: messagesToSend.length },
      'Piped messages to active container',
    );
    if (evaluatedLast) {
      advanceAgentCursor(chatJid, evaluatedLast.seq, cursorTimestamp);
      if (pending.hasMore) queue.enqueueMessageCheck(chatJid);
    }
  } else {
    queue.enqueueMessageCheck(chatJid);
  }
}

/** @internal - exported for testing */
export { processMessageLoopGroupMessages as _processMessageLoopGroupMessagesForTests };

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`retn0claw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newSeq } = getNewMessagesBySeq(
        jids,
        lastMessageSeq,
        ASSISTANT_NAME,
      );
      const timestamp = lastMessageTimestamp(messages);

      if (newSeq > lastMessageSeq) {
        lastMessageSeq = newSeq;
        if (timestamp && timestamp > lastTimestamp) lastTimestamp = timestamp;
        saveState();
      }

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          processMessageLoopGroupMessages({ chatJid, groupMessages });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesAfterSeq(
      chatJid,
      getOrRecoverMessageSeq(chatJid),
      ASSISTANT_NAME,
      1,
    );
    if (pending.messages.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.messages.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

export function shouldBootstrapClaudeRuntime(runnerKind: RunnerKind): boolean {
  return runnerKind === 'claude';
}

function ensureContainerSystemRunning(runnerKind: RunnerKind): void {
  if (!shouldBootstrapClaudeRuntime(runnerKind)) {
    return;
  }
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  const runnerKind = getSelectedRunnerKind();
  ensureContainerSystemRunning(runnerKind);
  initDatabase();
  logger.info('Database initialized');
  assertCodexRunnerReadiness();
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  channels.push(
    ...(await connectInstalledChannels({
      channelNames: getRegisteredChannelNames(),
      getChannelFactory,
      channelOpts,
      warn: logger.warn,
    })),
  );
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start retn0claw');
    process.exit(1);
  });
}
