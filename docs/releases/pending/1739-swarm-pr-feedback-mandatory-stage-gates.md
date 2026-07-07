# docs(skills): make Stage A and Stage B gates mandatory in swarm-pr-feedback

The `swarm-pr-feedback` skill previously hedged its structural pre-checks as
"lint/format/typecheck/build where relevant" and never stated the swarm
reviewer + critic closeout gate as a named, mandatory gate. Both are now
promoted to mandatory contracts so every change made as part of the
PR-feedback process passes all three gates on the current diff before any fix
lands or any closure ledger row is marked FIXED.

## Three-layer gate model (now mandatory in the skill)

1. **Stage A — structural pre-checks** (`pre_check_batch`-equivalent):
   `bun run build`, typecheck, lint/format (`biome ci .`), `git diff --check`,
   and reproduction of the exact failing CI/test command. No "where relevant"
   hedge.
2. **Stage B — `reviewer` + `test_engineer`**: independent reviewer validates
   each fix on the Stage-A-green diff; `test_engineer` writes/runs the
   falsification probe or regression test. Uses the repository's established
   Stage A/B meaning (consistent with `execute`, `plan`, `specify`,
   `brainstorm`, `docs/swarm-briefing.md`, `docs/council/README.md`).
3. **Closeout gate — reviewer + critic**: a separate reviewer + critic pair on
   the Stage-B-approved diff, per the swarm closeout contract. Any edit after
   an approval invalidates it.

## Files changed

- `.opencode/skills/swarm-pr-feedback/SKILL.md` (canonical): front-matter
  `description`, intro paragraph, and the `## Validation` section reframed into
  `## Mandatory Gates` (Stage A / Stage B / closeout / post-publish). Every
  prior Validation checklist item is preserved and re-bucketed; post-push
  checks are correctly classified as post-publish verification, not Stage A.
- `.agents/skills/swarm-pr-feedback/SKILL.md` and
  `.claude/skills/swarm-pr-feedback/SKILL.md` (adapters): parallel "Mandatory
  Gates — Stage A and Stage B (+ closeout)" bullet groups added to the
  execution notes; existing async-lane output guidance preserved.
- `docs/commands.md` §pr-feedback and `docs/architecture.md` PR_FEEDBACK
  Protocol: parity sentences noting the mandatory gates.

This is a documentation-only change; no code, tool registration, command
wiring, or test behavior is affected.
