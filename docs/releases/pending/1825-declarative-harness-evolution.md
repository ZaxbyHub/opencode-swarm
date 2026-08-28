## feat(harness): add a governed declarative mutation surface

Adds strict, versioned harness blueprint, tool, orchestration, patch, and
candidate contracts with canonical hashes and parity-preserving pure factories.
The new `/swarm blueprint validate|current|history|diff|export` and `/swarm
harness candidate validate|show|diff` commands are inspection-only.

Harness candidates are inert data: source patches are never applied or
executed, protected paths fail closed, and an empty source allowlist denies all
source candidates. Durable versions use an append-only, segmented,
hash-chained ledger under `.swarm/evolution/harness/`; `current.json` is a
derived projection. Older ledger history now compacts into an authenticated
snapshot, inactive candidate artifacts are physically pruned under bounded
retention, and version-linked candidates remain available for rollback.
Activation and rollback are available only through the explicit package API and
require exact, one-shot human write approvals.

The feature performs no plugin-initialization work and preserves the existing
static runtime definitions unless a package consumer explicitly materializes an
approved blueprint.

Closes #1825.
