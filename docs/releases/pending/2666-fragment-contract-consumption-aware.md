---
issue: 2666
title: Consumption-aware release-fragment contract for the j07 journey test
---

# Consumption-aware release-fragment contract for the j07 journey test

## What changed

- `tests/unit/execute-journey/j07-report-and-docs.test.ts` no longer pins the
  bare existence of `docs/releases/pending/2666-execute-journey-registered-host.md`.
  The fragment contract now accepts the deliverable in either state: the pending
  fragment (pre-consumption, with the original `#2666` + length assertions), or
  the archived form — at least one `docs/releases/manifests/<tag>.json` entry
  referencing the fragment path, with its materialized `docs/releases/<tag>.md`
  containing the `#2666` content.

## Why

- Release v7.186.8 consumed the #2666 fragment; the release-and-publish cleanup
  train deletes consumed pending fragments by design and is contractually
  limited to `docs/releases` paths, so the pinning test failed deterministically
  (ENOENT) on any tree containing the v7.186.8 materialization. The test must
  evolve on main ahead of the cleanup PR, keeping the pinned deliverable
  verifiable in whichever form the tree holds.
