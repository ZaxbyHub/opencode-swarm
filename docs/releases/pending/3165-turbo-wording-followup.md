# Docs: Turbo gate lists, completion-verify evidence, Tier 3 pointer and #3172 dates made exact

## What

- `phase_complete`'s Turbo warning, the architect's Turbo banner, the
  `turbo_mode` config description (and the generated schema and
  `docs/configuration.md`), the README, `docs/getting-started.md`,
  `docs/modes.md` and `docs/architecture.md` now name the todo gate, which
  Turbo already skipped along with Gates 1-5. `docs/architecture.md` also
  gets a todo-gate row and no longer gives a fixed gate count.
- Not changed: the `/swarm turbo` enable message (and the generated
  `docs/commands.md`) still lists only Gates 1-5. That text is part of the
  architect prompt, and naming the todo gate there takes the prompt past its
  size budget.
- The phase-wrap skill no longer tells the architect that
  `.swarm/evidence/{phase}/completion-verify.json` must exist before
  `phase_complete`. The completion-verify gate inside `phase_complete` runs
  the check itself and does not write that file or use it as evidence; only a
  direct `completion_verify` tool call writes it. `docs/architecture.md` made
  the same claim and is corrected too.
- `docs/modes.md` now says `src/parallel/tier3-classifier.ts` is the
  authoritative Tier 3 list for the coder re-dispatch block only. The
  architect's QA tiers use their own Tier 3 pattern list.
- The pending notes for #3172 now date the `content-filter` handling, and the
  Lean lane runner's exemption for content-filtered replies, to v7.192.4,
  where they shipped.

## Why

Each sentence described behavior the code does not have. No runtime behavior
changes; the only `src/` changes are the Turbo warning, the architect Turbo
banner, the `turbo_mode` config description and one code comment.

## Migration

None.
