# retn0claw

`retn0claw` is a personal fork of NanoClaw and is operated as a personal coding operating system for software project work.

Use [README.md](README.md) as the primary identity document. Use the codebase as the source of truth for runtime behavior. Some repository docs are still inherited from NanoClaw and should be treated as reference material unless the current README or code says otherwise.

## Working Assumptions

- Do not assume this repo is trying to be a broad public feature marketplace.
- Do not assume inherited NanoClaw docs define the long-term direction of the fork.
- Prefer describing the system as a personal project-work runtime, not a generic assistant product.
- Keep NanoClaw attribution explicit when rewriting public-facing docs.

## Key Files

| File | Purpose |
|------|---------|
| `README.md` | Current public-facing identity and scope |
| `docs/README.md` | Guide to current vs inherited docs |
| `src/index.ts` | Main orchestrator loop |
| `src/group-queue.ts` | Per-group execution queue |
| `src/container-runner.ts` | Container-based agent execution |
| `src/task-scheduler.ts` | Scheduled task runner |
| `src/db.ts` | SQLite persistence layer |
| `groups/*/CLAUDE.md` | Per-group memory and instructions |

## Runtime Notes

- Single Node.js process orchestrator
- SQLite for persistent state
- Container-based isolated agent execution
- Discord and Telegram integrations are wired into the runtime today
- OneCLI handles credential routing and agent-vault integration

## Useful Commands

```bash
npm run dev
npm run build
npm test
./container/build.sh
```

Service management:

```bash
# macOS
launchctl load ~/Library/LaunchAgents/com.retn0claw.plist
launchctl unload ~/Library/LaunchAgents/com.retn0claw.plist
launchctl kickstart -k gui/$(id -u)/com.retn0claw

# Linux user service
systemctl --user start retn0claw
systemctl --user stop retn0claw
systemctl --user restart retn0claw

# WSL / Linux without user systemd
bash start-retn0claw.sh
```

If setup selected a different Linux service mode, follow the generated setup output instead of assuming the user-service path above.
