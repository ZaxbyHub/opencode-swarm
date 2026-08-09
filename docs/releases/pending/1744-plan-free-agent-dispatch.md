---
title: Plan-free phase agent dispatch warning
issue: 1744
---

## What changed

Phase-complete gate now emits a prominent warning when a plan-free session (no `plan.json`) completes a phase without dispatching reviewer or test_engineer. Previously, plan-free phases could pass silently without independent review.

## Fix

Added a plan-free-aware check in `phase_complete` that verifies reviewer/test_engineer were dispatched via cross-session aggregation. When both are missing and no plan.json exists, a prominent `⚠️` warning is added to the phase-complete output and visible in curator compliance reports.

## Acceptance

A plan-free session that modifies code files without dispatching reviewer/test_engineer now produces a visible warning in the phase-complete result. Future curators and post-mortems can detect this gap.
