---
name: editing-skills
description: >
  Contract for adding, editing, moving, or removing skills in this repository
  (.claude/skills, .opencode/skills, .agents/skills, any SKILL.md): mirror
  classifications in src/config/skill-mirrors.ts, dual-tree byte-identical
  edits, bun run drift:check, bundling via BUNDLED_PROJECT_SKILLS, frontmatter
  conventions, and how to write trigger descriptions. Load before touching any
  SKILL.md file.
---

# Editing Skills in opencode-swarm

Skills in this repo exist across parallel trees (`.opencode/skills/`,
`.claude/skills/`, `.agents/skills/`) governed by explicit mirror contracts.
Editing a SKILL.md without knowing its contract silently desynchronizes the
OpenCode and Claude Code surfaces. Classify first, then edit.

## Step 1 — Classify the skill

Look the slug up in `src/config/skill-mirrors.ts`:

- **MIRRORED_ARCHITECT_MODE_SKILLS** (brainstorm, specify, clarify-spec,
  resume, clarify, discover, consult, pre-phase-briefing, council, deep-dive,
  deep-research, issue-ingest, plan, critic-gate, execute, phase-wrap,
  design-docs): `.opencode` and `.claude` copies must stay **byte-identical**.
  Any edit is a dual-tree edit — apply the identical change to both files.
- **ADAPTER** (swarm-pr-review, swarm-pr-feedback): `.opencode` is canonical;
  `.claude` and `.agents` are thin shims that must keep the exact relative
  reference `../../../.opencode/skills/<slug>/SKILL.md` (drift-check verifies
  the string).
- **DIVERGENT**: both trees exist, content intentionally differs — a
  single-tree edit is fine. `codebase-review-swarm` is in
  `DIVERGENT_ARCHITECT_MODE_SKILLS`; `engineering-conventions` and
  `writing-tests` are `divergent` entries in
  `ADDITIONAL_SKILL_MIRROR_CONTRACTS`.
- **OPENCODE-ONLY**: `loop` (`OPENCODE_ONLY_ARCHITECT_MODE_SKILLS`) and
  `running-tests` (an `opencode-only` ADDITIONAL contract) — do **not**
  create `.claude` mirrors (a `.claude/skills/loop` would shadow Claude
  Code's built-in `/loop`).
- **ADDITIONAL contracts**: `commit-pr` is `identical` with `.claude`
  canonical (CI's pr-standards workflow declares it the source of truth —
  mirror any edit to `.opencode` byte-for-byte). It also has discovery shims
  in `.agents/skills/commit-pr/` and `.github/skills/commit-pr/` that point
  at the `.claude` file as canonical.
- **No skill-mirrors.ts entry** (qa-sweep, research-first, swarm,
  swarm-implement, unswarm, tech-debt-ci-review, issue-tracer,
  rust-crate-ci, orchestrating-subagents, durable-session-state,
  editing-skills, …): the `.claude` file is the source protocol and there is
  no `.opencode` copy, no CI gate, and no npm shipment. **But most are not
  single-file**: many have a Codex adapter shim in `.agents/skills/<slug>/`
  that reads "`.claude/skills/<slug>/SKILL.md` is the source protocol"
  (check `ls .agents/skills/`). Content edits to the `.claude` file are safe
  — shims delegate — but **renaming, moving, or removing** one of these
  skills silently orphans its `.agents` shim with zero drift-check coverage.
  Update or remove the shim in the same change.

## Step 2 — Know what ships where

- Only `.opencode/skills/` is published: `package.json#files` lists the
  bundled `.opencode/skills/<slug>` directories, and
  `BUNDLED_PROJECT_SKILLS` (`src/config/bundled-skills.ts`) drives the
  missing-only sync into user projects at plugin init.
- `.claude/skills/` is repo-internal — it configures Claude Code sessions in
  *this* repository only.
- A new skill that should reach npm users must be added to **all three**:
  `.opencode/skills/<slug>/`, `BUNDLED_PROJECT_SKILLS`, and
  `package.json#files` — the drift checker flags incomplete combinations.
- A new cross-tree pair (same slug in both trees) must be classified in
  `src/config/skill-mirrors.ts`, or drift-check reports it "unclassified".

## Step 3 — MODE skills are not triggered by descriptions

The mirrored architect skills carry descriptions like "Full execution
protocol for MODE: PLAN". These are loaded on demand by the architect stubs
in `src/agents/architect.ts` when a `[MODE: …]` signal fires — they are
**not** meant to match natural user language, and in a plain Claude Code
session (no swarm runtime tools) they are protocol documentation, not
executable workflows. Do not "fix" their descriptions to natural language,
and do not expect them to auto-trigger.

## Step 4 — Frontmatter and description conventions

- `description` is how Claude Code auto-selects skills: third person, the
  core use case and concrete trigger keywords first, under ~1024 chars.
  Vague descriptions ("helps with X") never trigger.
- `disable-model-invocation: true` for slash-command-style skills the model
  must not self-invoke (swarm, unswarm, tech-debt-ci-review).
- Supported optional fields used in this repo: `effort` (low…max),
  `context: fork` + `agent: Explore|Plan|general-purpose|<custom>` (runs the
  skill body in an isolated subagent — the body then cannot rely on
  conversation history or on spawning further subagents), `allowed-tools`
  (space- or comma-separated), `argument-hint`.
- Keep SKILL.md under ~500 lines; move deep material into `references/`
  files linked one level from the SKILL.md (see issue-tracer for the
  pattern).

## Step 5 — Validate and publish

1. `bun run drift:check` — must not introduce new warnings (soft-warn in CI,
   but treat a new warning as a failure).
2. If you touched a byte-identical pair, `diff` the two files to prove
   identity.
3. Skill-only diffs (no `src/`, `scripts/`, or test changes) count as
   docs/meta-only for PR gating — no release-notes fragment required. The
   moment you also touch `src/config/skill-mirrors.ts`,
   `bundled-skills.ts`, or `package.json`, a
   `docs/releases/pending/<slug>.md` fragment becomes mandatory
   (see commit-pr skill, Step 2).
4. Skill edits are still "changed work" under the swarm-mode contract:
   independent reviewer + critic gates apply before completion.
