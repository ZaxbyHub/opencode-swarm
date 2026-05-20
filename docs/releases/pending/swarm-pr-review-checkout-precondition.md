---
title: swarm-pr-review skill adds branch checkout pre-condition
labels: bug
---

## What changed

Added an explicit pre-condition note to the `swarm-pr-review` skill's Scope Detection section: the PR branch must be checked out locally **before** dispatching any parallel explorer agents in Phase 2.

## Why

During PR review of #932, the 6-lane parallel explorer agents read main branch code instead of the PR branch because the branch was not checked out. This produced invalid "function does not exist" findings requiring a full re-run of all lanes — wasting significant cycles.

The fix adds a mandatory pre-condition note to the skill with the specific checkout command.

## How to use

No behavior change — this is documentation only.

## Migration

No migration required.
