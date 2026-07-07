# Mode skills are now effective-spec aware (issue #1685, task 3.2)

## What changed

Mode skills (SPECIFY, PLAN, CLARIFY-SPEC, PHASE-WRAP, critic-gate) and `save_plan` now resolve the effective spec via `/swarm sdd status` instead of checking only the literal `.swarm/spec.md` file. This means they now recognize three spec sources:

- **Native:** `.swarm/spec.md`
- **OpenSpec:** `openspec/specs/**/spec.md` and active `openspec/changes/*/specs/**/spec.md`
- **Spec-Kit:** `.specify/` with `specs/<feature-dir>/spec.md`

### Key fixes

1. **SPECIFY no longer shadows existing SDD sources.** When a project has only OpenSpec or Spec-Kit artifacts, SPECIFY now offers to project/ingest them via `/swarm sdd project` instead of silently creating a new `.swarm/spec.md` that diverges from the authoritative source.

2. **`/swarm sdd project` is now agent-invocable.** The command was previously human-only (`toolPolicy: 'human-only'`). It is now `'agent'`, so the Architect can invoke it after obtaining explicit user consent when SPECIFY detects an OpenSpec or Spec-Kit source. Overwriting an existing native `.swarm/spec.md` additionally requires the `--overwrite` flag, passed only after the user has consented.

3. **`--overwrite` flag for atomic write safety.** Projecting into an existing native `.swarm/spec.md` now requires `--overwrite` and enforces the flag atomically at the write boundary (TOCTOU-safe).

4. **`save_plan` rejection guidance is actionable.** The `SPEC_REQUIRED` rejection message now references the effective spec source and the `/swarm sdd project` recovery command instead of pointing at a human-only command.

5. **Projected specs include a `## Success Criteria` scaffold.** When `/swarm sdd project` projects an OpenSpec or Spec-Kit spec into `.swarm/spec.md`, the resulting file now contains `## Success Criteria` with `SC-###` placeholders and `[NEEDS CLARIFICATION]` markers — no synthesized obligations are injected. The `featureLabel` field is sanitized against bracket and control-character injection.

6. **`/swarm sdd status` is the canonical effective-spec resolver.** All mode skills and `save_plan` now call `/swarm sdd status` (or equivalent `resolveEffectiveSpec()` call) to determine what spec is in effect, rather than directly reading `.swarm/spec.md`.

## Why

An OpenSpec-only or Spec-Kit-only repository previously hit an unexplained first-attempt `DRIFT_VERIFICATION_MISSING` block at `phase_complete`: the spec was present (as OpenSpec/Spec-Kit artifacts) but the effective-spec pipeline had no way to surface it to the drift gate. Meanwhile, SPECIFY would silently overwrite the authoritative source with a new native spec. Both failure modes are now resolved.

## How to use

```
# Agent-invocable projection (requires explicit user consent first)
# When SPECIFY or CLARIFY-SPEC detects an OpenSpec source:
# The Architect must obtain user consent before invoking:
/swarm sdd project

# With Spec-Kit (when multiple features exist):
/swarm sdd project --source speckit --feature 001-my-feature

# Overwrite an existing native .swarm/spec.md (atomic, requires flag):
/swarm sdd project --overwrite

# Check effective spec status from any mode skill:
/swarm sdd status
```

## Migration steps

None required. Existing native `.swarm/spec.md` projects are unaffected. The `--overwrite` flag is only needed when projecting into a file that already exists.

## Known caveats and follow-ups

- Projected specs from OpenSpec/Spec-Kit carry a scaffold `## Success Criteria` section with `SC-###` placeholders. Filling those placeholders with real acceptance criteria remains the architect's responsibility; no obligations are synthesized.
- Multi-feature aggregation from Spec-Kit (when more than one `specs/<dir>` exists) requires `--feature <id>` — tracked in issue [#1577](https://github.com/ZaxbyHub/opencode-swarm/issues/1577).

Closes: #1685
