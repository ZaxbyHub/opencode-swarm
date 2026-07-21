---
title: Recursive malformed-value config recovery
issue: 1690
---

## What changed

The config loader now recursively recovers malformed config values instead of silently falling back to bare defaults. When a config has a value of the wrong type (e.g., `council.enabled: "yes"` instead of a boolean), the loader drops the smallest recoverable unit (leaf field → parent section) so valid sections survive.

## New recovery type

`loadPluginConfigWithMeta` / `loadPluginConfigWithMetaAsync` now return `recovery: 'sanitized_values'` when the recursive recovery succeeds. This sits between `'stripped_keys'` (unrecognized key removal) and `'guardrails_defaults'` (bare fallback) in the recovery order.

## Acceptance

A config file with one typo'd value (e.g., `max_iterations: 888`) still loads with that field defaulted rather than wiping the entire configuration. The `/swarm config doctor` command surfaces which fields were dropped via the existing `removedKeys` metadata.
