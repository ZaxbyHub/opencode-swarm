# Restart Inventory (Profiles B/C) — full protocol

Entry-skill pointer: `../SKILL.md` (## Pre-flight: Restart Inventory).

## When

After a harness session restart mid-round (compaction recovery, crash
recovery, or an operator restart): the previous session's in-flight subagent
work is gone — its agent ids no longer resolve (`SendMessage` to them fails
with "No active local_agent task found") — even though the durable artifacts
on disk survive.

## The four-bucket inventory

Record one inventory row per bucket in the task-gates artifact
(`.zcode/session/tasks/<task-slug>/gates.md` or the harness equivalent)
BEFORE dispatching anything:

1. **Reusable artifacts** — findings ledgers, gate receipts, context packs,
   fetch receipts, replay logs: anything on disk that survives the restart.
   These are the recovery substrate; re-derive nothing that is already
   recorded.
2. **Stale approvals** — every reviewer/critic gate verdict recorded before
   the restart is bound to a content digest; treat it as stale until the
   digest is re-verified against the current tree. Do not trust the verdict
   prose alone.
3. **Dead agent ids** — `SendMessage` to a pre-restart agent id fails with
   "No active local_agent task found". Never retry a dead id and never wait
   on a notification that will never come.
4. **Fresh-dispatch work** — every lane that was in flight at the restart
   needs a NEW dispatch with a complete standalone context packet (task,
   commits, files, exact verification steps, and the verdict to return);
   the dead agent's accumulated context is unrecoverable.

Field evidence: two harness session restarts during one retrospective
session (ragappv3, 2026-11-13/14) orphaned 46 child sessions; recovery
worked only by fresh dispatch with full context packets.
