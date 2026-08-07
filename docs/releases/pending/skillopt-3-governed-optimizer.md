## feat(skill-opt): governed single-skill optimizer with manual activation

Adds `/swarm skill-opt plan|run|status|diff|approve|reject|rollback|history`
(issue #1822 — SkillOpt 3/7): a governed, manually-activated optimizer that
drives one allowlisted `SKILL.md` candidate at a time through deterministic
draft → static smoke → evaluation-substrate validation (`split:'test'`) →
manual approval → atomic activation (or rollback).

- **Durable lifecycle**: append-only state machine under
  `.swarm/evolution/skills/<slug>/<candidateId>/lifecycle.jsonl` with hash-chain
  integrity, corrupt-tail quarantine, and replay-after-write verification.
- **Serial controller**: one project run + one target skill at a time via a
  cross-process lock with a stale-lock policy; caps on rounds, candidates,
  validations, time, tokens, rejections, and infra retries.
- **No autonomous mutation**: `run` requires `skill_opt.enabled: true` and
  `--confirm`; activation is human-only with `--expected-content-hash` stale-base
  refusal; rollback appends an event and never deletes history.
- **No duplicate scorer**: validation uses `evaluateCandidateV1`; the skill-eval
  scorer wraps the shared `scoreSkillPhrases` function factored out of
  `skill-evaluator.ts`.
- **Workstream A**: deterministic candidate seed, distinct `promoted_external`
  staleness policy (curator now reconciles promoted-external skills), wall-clock
  retirement with real usage + safeguards, explicit `outcomeSignal === 0`
  zero-evidence boundary.
- **Security**: symlink/reparse denial, leakage-denied generator inputs,
  held-out test single-use enforcement.

Disabled by default (`skill_opt.enabled: false`). New config block
`skill_opt` in `opencode.json`. See `docs/skill-optimizer.md`.

Closes #1822.
