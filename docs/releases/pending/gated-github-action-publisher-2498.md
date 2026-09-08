# Gated GitHub Action publisher

## What changed

- Added a Linux-only, two-mode composite GitHub Action for bounded Swarm issue
  preparation and post-approval publication.
- Added a default-off two-job caller example with read-only prepare
  permissions, a protected publish Environment, non-persisting checkouts,
  bounded timeouts, non-cancelling concurrency, canonical issue/base
  bindings, live-base drift detection, and artifact handoff.
- Documented the trust boundary, immutable ref/toolchain pinning, gate and
  trace/evidence requirements, binary-content secret scanning, create-only
  branch claims, failure states, and duplicate-delivery idempotency.

## Why

Issue-driven automation must not let untrusted issue or repository content use a
write-capable GitHub credential before independent validation and human
oversight. The separate prepare and publish jobs make that boundary visible
and enforceable for consumers.

## Migration

There is no runtime migration. Consumers must copy the example workflow into
their repository, replace its non-runnable Action-ref sentinels with a
reviewed immutable commit SHA, set `SWARM_NODE_VERSION`,
`SWARM_BUN_VERSION`, `SWARM_OPENCODE_VERSION`, and `SWARM_PLUGIN_REF` for the
preinstalled pinned toolchain and Action/plugin ref, set `SWARM_ISSUE_TRACE` to
the expected trace identity, and configure a protected Environment
with required reviewers before enabling it. `SWARM_PLUGIN_REF` must be a
reviewed 40-character commit SHA; the caller's Action-ref sentinels must
likewise be replaced before the workflow can run.

The prepare Action step bootstraps its own dependencies from the committed
`bun.lock` with bounded `bun install --frozen-lockfile` and `bun run build`
commands, then requires a regular `dist/cli/index.js`. Consumers must allow
registry network access and writes to the extracted Action directory; failed,
offline, mutable-lockfile, or timed-out bootstrap fails closed. No floating
dependency or Action/plugin ref is accepted.

## Known caveats

The Action supports Linux GitHub-hosted runners. Fork or repository-mismatched
requests, failed or missing gates, stale artifacts, cancellations, timeouts,
and oversight denial fail closed without publication.
