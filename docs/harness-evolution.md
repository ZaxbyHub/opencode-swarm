# Declarative Harness Evolution

Harness evolution is a governed data model for inspecting and versioning agent
definitions. Static repository definitions remain authoritative by default.
Nothing in this subsystem runs at plugin initialization, invokes an agent,
applies a source patch, or changes the live plugin manifest automatically.

## Contracts and parity

Versioned `PromptArtifact`, `ToolSpec`, `AgentBlueprint`,
`OrchestrationSpec`, `HarnessBlueprint`, `BlueprintPatch`, and candidate
contracts use strict schemas and canonical SHA-256 content hashes. The pure
agent and tool factories accept an explicit runtime-definition inventory; they
do not import the live agent constructor. A blueprint can materialize only when
its `definitionsHash` matches that supplied inventory, which makes drift fail
closed instead of silently changing prompts or tools.

## Candidate lifecycle

A blueprint candidate binds its base blueprint, atomic patch, and resulting
blueprint. Source candidates additionally bind a Git base commit, a canonical
file manifest, and a patch hash. Source patch bytes are stored only as inert
evidence: the runtime has no apply or execute primitive.

Candidate admission rejects stale Git bases, paths outside the project,
symlinks and repository indirection, binary data, unapproved or protected
paths, malformed diffs, and configured size/count limits. Git subprocesses are
bounded and non-interactive.

Recording a candidate does not activate it. Package consumers may request
activation or rollback only after a human creates an exact one-shot approval
with `/swarm approve-write`. Approval hashes bind the session, action, candidate
or target version, expected current hash, expected current generation, target
content hash, and allowed-path digest. Foreign sessions, stale current state,
wrong content/path bindings, and replayed approvals fail closed.

## Durability

State is contained under `.swarm/evolution/harness/`:

- `candidates/` contains immutable candidate records.
- `versions/` contains immutable activated blueprint versions.
- `ledger/` contains bounded append-only hash-chained JSONL segments and, after
  retention compaction, an authenticated active-generation snapshot.
- `current.json` is a replaceable projection of one verified ledger head.

The ledger is authoritative. A complete fsynced record is committed even if a
crash happens before projection replacement. A physically torn final line may
be quarantined and ignored; interior corruption, a broken hash chain, or replay
past the configured record bound fails closed. Read commands do not repair the
projection. Explicit reconciliation can recreate it from verified history.
Rollback creates a new version referencing its source version; it never rewrites
or deletes history required for rollback ancestry. When physical retention
compacts the ledger, older records collapse into a single authenticated
`compacted` snapshot and inactive candidate prompt bundles not named by that
snapshot are removed; candidates referenced by retained versions remain
available for rollback, and the newest inactive candidate remains available for
subsequent activation.

## Commands

The blueprint and harness-candidate command families are read-only. See
[Commands](commands.md#declarative-harness-inspection) for exact syntax. In
particular, candidate `show` and `diff` return metadata and hashes rather than
raw source patch content. The explicit package API is the frozen callable
`harnessMutationV1` namespace with `validateBlueprint`,
`projectStaticBlueprint`, `applyPatchSet`, `validateSourceCandidate`,
`saveCandidate`, `saveVersion`, `activate`, `rollback`, `current`, `history`,
`diff`, `auditLedger`, and `recoverCorruptTail`.

## Migration and compatibility

Existing configurations require no migration: omitting `harness_evolution`
keeps the surface disabled for source admission because the allowlist defaults
to empty. Existing static agent definitions and tool registration are unchanged.

Readers accept only migrations explicitly defined by the contract parser.
Unknown versions, unknown fields, malformed hashes, and ambiguous legacy state
are rejected. There is no implicit import from earlier ad-hoc files and no
startup scan. To adopt the feature, add a narrow `source_allowlist` only when
source-candidate inspection is needed, validate a canonical blueprint, and let
the package API record it as a new immutable candidate/version lineage.
