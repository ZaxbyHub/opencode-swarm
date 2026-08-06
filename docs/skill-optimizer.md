# Governed Skill Optimizer (`/swarm skill-opt`)

> Issue #1822 — [SkillOpt 3/7]. A governed, manually-activated, single-skill
> optimizer that drives ONE allowlisted `SKILL.md` candidate at a time through
> deterministic draft → static smoke → PR1 validation → manual approval → atomic
> activation (or rollback). The loop is bounded, restartable, reversible, and
> unable to mutate harness/source/security surfaces.

## Why

The skill system had building blocks (an evaluation substrate, skill
generator/evaluator/improver) but no governed loop that optimizes a single
skill through a validated, auditable, reversible lifecycle. Stale or
under-performing skills had no disciplined retirement path, and there was no
serial controller preventing concurrent optimization runs.

## What it does

Optimizes one skill at a time:

1. **Plan** (`/swarm skill-opt plan <slug>`) — propose a round (dry-run; no mutation).
2. **Run** (`/swarm skill-opt run <slug> --confirm`) — execute a round (requires `skill_opt.enabled: true`).
3. **Status / Diff / History** — inspect a candidate's lifecycle.
4. **Approve** (`/swarm skill-opt approve <slug> <id> --expected-content-hash <hash>`) — activate a pending candidate.
5. **Reject / Rollback** — record a rejection (no mutation) or restore the pre-activation snapshot.

## Durable lifecycle

Append-only state machine stored under `.swarm/evolution/skills/<slug>/<candidateId>/lifecycle.jsonl`:

```
discovered → drafted → smoke_validated → validation_running
                                       → accepted_pending_approval | rejected | inconclusive
accepted_pending_approval → activated | expired | rolled_back
inconclusive → drafted (re-entry with a fresh candidate + task set; capped)
activated → rolled_back
```

Each transition records timestamp, actor/origin, content hashes, hash-chain
before/after, reason, and evidence refs. Partial/corrupt writes never count as
acceptance (replay-after-write verification). A corrupt ledger tail is
quarantined, never overwritten.

## Validation

Uses the existing evaluation substrate (`evaluateCandidateV1`, `split:'test'`)
— no duplicate runner. The skill-eval scorer is a `kind:'project'` wrapper
(`score-skill-eval.cjs`) around the same phrase-scoring arithmetic as the
shared `scoreSkillPhrases` function (factored out of `skill-evaluator.ts`).
The wrapper is a CommonJS subprocess (the substrate invokes project scorers
as isolated subprocesses) so it cannot import the TS module directly; an
execution-based parity test (`scorer-parity.test.ts`) spawns the wrapper over a
score matrix and asserts equality with `scoreSkillPhrases`, so the two cannot
silently drift. Held-out test sets are single-use (`claimHeldOutTest` throws
`TestAlreadyConsumedError` on reuse), so a single `run` performs at most one
validation; draft/smoke retries are the only looped steps.

## Security

- **No autonomous mutation.** `run` requires `enabled: true` + `--confirm`;
  `approve`/`activate`/`reject`/`rollback` are `toolPolicy: 'human-only'`.
- **Stale-base refusal.** `approve` requires `--expected-content-hash`; a
  mismatch (`STALE_BASE`) blocks activation.
- **Symlink/reparse denial.** The smoke validator rejects symlinked skill roots
  and roots that escape the project after `realpath`.
- **Leakage denial.** The generator's inputs are an explicit allowlist; any
  reference to a held-out task ID throws `LEAKAGE_DETECTED`.
- **Atomic + reversible.** Activation snapshots the incumbent first; rollback
  appends a new event and never deletes history.
- **Candidates cannot modify the evaluator/evidence/ledger/baseline/policy.**

## Configuration

`opencode.json`:

```json
{
  "skill_opt": {
    "enabled": false,
    "max_rounds": 5,
    "max_candidates_per_round": 3,
    "max_validations_per_round": 1,
    "max_inconclusive_rounds": 2,
    "max_transient_retries": 5,
    "deadband": 0,
    "retirement_min_age_days": 60
  }
}
```

Disabled by default. The config is consulted only inside command handlers —
never on the plugin init path (AGENTS.md invariant #1).

## Workstream A (lifecycle closure)

- Deterministic candidate seed from existing eligibility functions
  (`selectCandidateEntries` + `isSkillMaturityEligible`).
- Distinct `promoted_external` staleness policy — the curator now reconciles
  promoted-external skills using the real usage signal (#1770) with minimum-age
  and support safeguards and reversible archive.
- Wall-clock retirement gate with real usage + safeguards.
- Explicit `outcomeSignal === 0` (zero-evidence) boundary classification.
