---
name: unswarm
audience: swarm-plugin
description: Disable swarm mode for the current Claude Code session and return to normal behavior.
disable-model-invocation: true
---

# /unswarm

Disable swarm mode for the current session.

## Steps
1. If `.claude/session/swarm-mode.md` exists, delete it.
2. Confirm that swarm mode is now disabled.
3. Resume normal Claude Code behavior for future tasks.
