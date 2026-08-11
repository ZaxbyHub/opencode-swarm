# MiniMax native context limits

## What changed

The native model limit registry now includes MiniMax-M3 and MiniMax-M2.7.

## Why

Without explicit entries, both models fell back to the conservative default
limit and prompt guardrails trimmed usable context too early.

## New tests

Focused tests cover MiniMax-M3, MiniMax-M2.7, and versioned MiniMax-M3 model
IDs resolved through prefix matching.

## Migration

No migration is required.
