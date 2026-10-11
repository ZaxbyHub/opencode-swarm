---
name: Verifiable issue (executable contract)
about: File an issue that can be frozen into acceptance checks and proven RED-at-base / GREEN-at-head. Read CONTRIBUTING.md "Filing issues" first — the notes below are the minimum shape, not the full contract.
title: ""
labels: []
assignees: []
---

_Provenance: generated from <source>; every claim re-checked at <repo>@<full SHA>. One issue = one PR. <Local-artifact disclaimer if needed>._

## Summary

<!-- What will be true after this PR that is not true today. Outcome-framed, not task-framed. -->

## Problem (claims to verify)

<!-- Numbered claims. Each: full-SHA permalink + code excerpt for load-bearing lines + VERIFIED/INFERENCE label. Add prior-art reconciliation where a claim overlaps an existing implementation. Preserve review corrections inline ("CORRECTED during review: ..."). -->

1. <Claim>. [VERIFIED by <how>] <permalink>

## Scope

**In:**
**Out:** <with owning-issue refs>

## Acceptance criteria

<!-- EARS grammar, sequential AC1..ACn, one AC per frozen check, exactly five sub-bullets each.
     class: DISCRIMINATING (genuinely red at base) | NEW-SURFACE (deterministic absence signature at base) | PRESERVING (green at base and head). -->

- [ ] AC1: WHEN <trigger>, THE SYSTEM SHALL <observable response>.
  - class: <DISCRIMINATING|NEW-SURFACE|PRESERVING>
  - argv: <one runnable command from the repository root>
  - expect: <the signature the BASE leg shows before the fix>
  - files: <files the check reads or creates>
  - why: <why red at base — or green at both ends for PRESERVING>

<!-- Program issue? Add: ## Sequence — [Workstream <letter>] PR n of m, the full chain, depends-on/blocks. -->
<!-- Design-heavy? Add any of: Why (evidence) / Current behaviour / Dependencies / Design / Files to change / Tests / Fixtures / Local verification recipe / Release rules / Definition of done. The ACs bind; these inform. -->
