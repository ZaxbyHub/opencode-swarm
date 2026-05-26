# Memory recall evaluation harness

## What changed

- Added golden recall fixtures for repository conventions, test patterns, stale memory, adversarial same-scope noise, and cross-repo isolation.
- Added a provider/mode recall evaluation harness that reports precision@k, recall@k, injection count, same-scope noise, noisy injections, cross-scope leaks, and stale-memory returns.
- Added `/swarm memory evaluate --json` to generate the evaluation report.

## Why

Memory recall needs measurable regressions for whether retrieved context is useful, scoped, current, and quiet enough for automatic injection.

## Migration

No migration is required.

## Breaking changes

None.
