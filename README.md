<p align="center">
  <img src="assets/retn0claw-logo.png" alt="retn0claw" width="400">
</p>

<p align="center">
  A personal coding operating system forked from NanoClaw.
</p>

<p align="center">
  <a href="https://github.com/nbsp1221/retn0claw">GitHub</a>&nbsp; • &nbsp;
  <a href="docs/README.md">docs</a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## What retn0claw Is

`retn0claw` is a personal fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) for software project work.

It is not a general-purpose AI assistant. It is a personal coding operating system: a small runtime I can understand, modify, and use to run project-room workflows with isolated agents.

## Why It Exists

I wanted something smaller and easier to reason about than large agent platforms, while still keeping real isolation between the host machine and the agent runtime.

NanoClaw was a good starting point because it already had a compact orchestrator, SQLite-backed state, and container-based execution. `retn0claw` keeps that lineage visible, but this fork is focused on coding-oriented workflows rather than a generic assistant product shape.

## Core Ideas

- **Project-room workflow**: work is organized around software projects and their rooms, not around a one-size-fits-all personal assistant.
- **Isolated execution**: agents run in Linux containers with explicit mounts instead of broad host access.
- **Owner-controlled behavior**: this is meant to be changed in code to match the operator's workflow.
- **Small enough to inspect**: the runtime should stay understandable enough that the owner can audit and reshape it.

## Current Scope

Right now the repository still contains a mix of active runtime code and inherited NanoClaw-era structure. The current codebase includes:

- a single Node.js orchestrator
- SQLite-backed message, session, and task state
- isolated container execution for agent work
- scheduled task support
- remote-control and IPC plumbing for active sessions
- Discord and Telegram transport adapters in the runtime today
- OneCLI-based credential routing and agent vault integration

Some older documents and skills remain in the repository as inherited reference material. They do not all describe the long-term direction of this fork.

## Non-Goals

- **Not a general consumer assistant**: this project is not trying to be a life-management bot or a polished end-user product.
- **Not a public feature marketplace**: this project is not being developed as a broad public extension ecosystem.
- **Not a promise to preserve NanoClaw unchanged**: upstream lineage matters, but this fork is free to diverge when the workflow demands it.

## Quick Start

```bash
git clone https://github.com/nbsp1221/retn0claw.git
cd retn0claw
claude
```

Then run `/setup`.

> **Note:** Commands prefixed with `/` such as `/setup` and `/debug` are Claude Code skills. Run them inside the `claude` CLI prompt, not in your regular shell.

## Example Uses

This repository is aimed at software-project tasks such as:

```text
Review this branch and tell me what is risky before I merge it.
Summarize the last week of commits and point out README drift.
Open a project room for this repo and keep its notes isolated from the others.
Run a scheduled project check-in every weekday morning and send the result back to me.
```

## Architecture Snapshot

```text
Channels -> SQLite -> message loop -> group queue -> container runner -> agent output
```

At a high level:

- `src/index.ts` runs the main orchestration loop
- `src/group-queue.ts` serializes per-group work
- `src/container-runner.ts` launches agent containers
- `src/task-scheduler.ts` runs scheduled jobs
- `src/db.ts` stores messages, sessions, groups, and task state
- `groups/*/CLAUDE.md` holds per-group memory and instructions

For a document map and the current status of inherited docs, see [docs/README.md](docs/README.md).

## Status

This is an active personal fork, not a finished product.

The runtime already exists and is usable, but the repository still contains inherited NanoClaw assumptions and documentation around it. The top-level docs now describe the current direction more directly, while older materials remain in the tree as reference.

## Requirements

- macOS, Linux, or Windows via WSL2
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Docker](https://docker.com/products/docker-desktop)

On macOS, [Apple Container](https://github.com/apple/container) is an optional conversion path rather than the default checked-in runtime.

## License

MIT

Upstream origin and prior work remain acknowledged: this project began as a personal fork of NanoClaw.
