# Architect prompt: full-auto never delegates — the architect does

## What changed

The architect system prompt no longer describes full-auto as "autonomous cross-phase oversight" — wording that made the model hallucinate an autonomous "full-auto controller" that would take over task delegation, announce a handoff, and stop making tool calls (issue #2207). The ambiguous phrase was removed from every surface that reaches the rendered prompt: the architect prompt's two full-auto mention sites (MODE: LOOP purpose line and the PHASE-WRAP auto-proceed rules), and the `/swarm loop` and `/swarm full-auto` command `details` in `src/commands/registry.ts`, which `buildSlashCommandsList()` substitutes into the prompt's `{{SLASH_COMMANDS}}` placeholder. The prompt now states explicitly:

- full-auto is a critic gate that intercepts phase completions and high-risk actions for review;
- it never plans, delegates, or executes — the architect retains ALL delegation duty in every mode;
- when told to proceed under full-auto (e.g. "Proceed with phase 4"), the architect MUST immediately dispatch that phase's tasks to coder itself;
- the `critic_oversight` agent gates quality; it never replaces architect delegation.

The `.opencode/skills/loop/SKILL.md` mirror of the LOOP purpose line carries the same correction (LOOP skill is opencode-only; no `.claude` mirror).

A prompt regression guard in `tests/unit/agents/architect-prompt-regression.test.ts` pins the new wording and asserts the ambiguous phrase is gone from both the architect prompt source AND the command registry that renders into the prompt.

## Why

With full-auto enabled, "Proceed with phase N" stalled the workflow: the architect believed an autonomous controller would execute the phase and issued no delegations. The fix removes the ambiguity that seeded the hallucination.

## Migration

No migration required.
