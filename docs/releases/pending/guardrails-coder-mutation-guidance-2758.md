# Correct Stage A coder-mutation guidance

## What

Stage A guardrails now distinguish a missing accepted coder mutation from a
genuine attribution-recovery failure.

## Why

When a task requires rework, `/swarm recover` cannot satisfy the reducer's
requirement for a new coder mutation. The architect now receives bounded
guidance to dispatch a coder for a real code change or mark the task blocked
when no valid change exists, while genuine attribution failures retain their
recovery guidance.

## Migration

No migration is required. This is an internal guardrail message correction;
workflow persistence and command behavior are unchanged.
