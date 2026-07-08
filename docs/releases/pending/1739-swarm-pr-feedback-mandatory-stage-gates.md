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

## swarm skill promoted to canonical

The `swarm` skill (the cross-agent swarm-mode behavior model, including the
mandatory implementation closeout gate) now has a canonical home at
`.opencode/skills/swarm/SKILL.md`, with `.claude` (Claude Code `/swarm`
command wiring) and `.agents` (Codex adapter) as thin adapters that delegate
the behavior model to the canonical. Previously the full skill lived only in
`.claude` and was not bundled. References like `../swarm/SKILL.md` from
sibling skills now resolve.

This PR is primarily documentation, but it also promotes the `swarm` skill to
a canonical bundled skill under `.opencode/skills/swarm/` (previously it lived
only in `.claude`/`.agents`), which adds a bundled-skill registration
(BUNDLED_PROJECT_SKILLS, package.json#files, package-smoke allowlist) and a
`divergent` mirror-contract classification in src/config/skill-mirrors.ts. No
executable tool, command-handler, or test-behavior logic changed.
