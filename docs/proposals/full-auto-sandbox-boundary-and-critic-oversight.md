# Full-Auto sandbox boundary and critic oversight

## Status

Implemented by issue #1824. This document defines the security boundary; it is not a claim that command matching is a sandbox.

## Boundary model

Shell text is normalized and classified once by the shared command classifier. The classifier is a bounded best-effort tripwire: catastrophic and destructive commands are blocked, ambiguity escalates, and every consumer must still enforce path, scope, authority, and sandbox policy. A critic may review an ambiguous action but cannot waive a catastrophic command block or manufacture human authority.

Sandbox capability is reported independently for filesystem, network, and process containment as `real`, `weak`, or `none`. Status is evidence-derived and conservative. Linux explicitly reports the absence of seccomp; the current macOS profile does not claim network or process containment; Windows fallbacks do not become trusted merely because a package-local executable exists. Advisory mode preserves compatibility. Explicit `guardrails.sandbox.mode: required` fails closed when any requested dimension is not `real`.

The original command digest and capability identity are bound at Full-Auto policy and shell wrapping. A mismatch or missing required capability denies execution before command mutation.

## Protected inputs and writes

Protected paths are defined centrally and include repository control state, evaluation inputs and scorers, sandbox and guardrail implementation, release ownership, secrets, and configured additions. Canonical containment checks remain mandatory at each filesystem sink.

Governed optimizer evaluation snapshots the complete protected input tree before execution and verifies it afterward, including on exceptions. Additions, removals, content or metadata changes, symlinks, hard links, special files, unreadable state, and budget exhaustion fail closed. This is tamper detection; OS sandboxing remains the primary prevention boundary.

Writes requiring user approval consume a one-shot fact bound to the target session, action, candidate identity, content hash, allowed-path digest, generation, and expiry. Only `/swarm approve-write` issues the fact. Prompt text, critic prose, tool arguments, and service calls cannot mint it. Consumed authority propagates through async work and is stamped into learning/consensus provenance as `human_approved`; absent authority remains `autonomous`.

## Current state ledger and durable artifacts

- Write approvals persist in `.swarm/authority/write-approvals.jsonl` as an issued/consumed ledger with exact session, action, candidate, hash, optional path digest, and generation binding.
- Guardrail decisions persist in the bounded `.swarm/session/shell-audit.jsonl` window. Typed security entries remain explicit rows; older legacy allowed-shell rows fold into the manifest aggregate instead of remaining inline indefinitely.
- Protected-input integrity snapshots are ephemeral verification artifacts, not a long-lived approval ledger. The durable proof is the guarded result path rejecting mutations or ambiguity when verification replays.

## Failure behavior

- Default/absent sandbox configuration: warn once, audit the skip, retain existing tool guardrails.
- Explicit required sandbox: block before unsandboxed execution.
- Protected-input ambiguity or mutation: reject the evaluation result.
- Missing, stale, foreign, replayed, or hash-mismatched approval: do not write; return the exact approval challenge.
- Turbo mode never disables scope enforcement.

## Verification

The implementation is pinned by shared-classifier/source-guard tests, cross-platform capability tests, strict/advisory hook tests, protected-path and manifest mutation tests, one-shot authority tests, optimizer integration tests, provenance schema tests, and the repository CI gates. Platform dimensions remain weak or none unless real-host behavioral evidence supports `real`.
