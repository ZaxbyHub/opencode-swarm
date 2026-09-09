# Keep mandatory lifecycle bookkeeping active and record every Stage A attribution route

Issue: #2664

## Summary

Setting `guardrails.enabled: false` used to disable the guardrails hook factory
entirely, which silently suppressed MANDATORY lifecycle bookkeeping along with
the optional enforcement: Stage A pre-check receipts (task correlation plus the
durable `stage_a_passed`/`stage_a_failed` workflow transitions) and exact-bound
scope-lease maintenance both stopped running, so accepted and rejected work
became unobservable, tasks wedged at `coder_delegated`, and legitimately owned
scope leases expired unrenewed.

The factory is now split along that boundary. With guardrails disabled, the
policy denials inside `toolBefore` (deny rules, authority/scope checks,
destructive-command blocks, sandbox enforcement, budget limits, PRM stop,
prompt-directive advisories via `messagesTransform`) are skipped, while every
mandatory surface keeps running: Stage A correlation and transitions, a new
bounded Stage A route event per completed `pre_check_batch` outcome, and
success-only exact-bound lease renewal. One structural bound stays fail-closed
in both modes: patch payloads over 1 MiB are still rejected.

## Stage A route events

Every completed `pre_check_batch` call now records exactly one bounded event
(`type: "stage_a_gate_route"`) in the bounded core event store
(`.swarm/events.jsonl`) with a closed seven-route vocabulary — `valid_pass`,
`pre_check_failed`, `invalid_result`, `no_task_correlation`,
`attribution_ambiguous`, `late_result`, `duplicate_result` — carrying the
session, call, attributed task (nullable), and the guardrails mode. Duplicate
deliveries are idempotent by transition id; late results (stale generation)
never advance a task; undecodable results never transition. The vocabulary,
the mandatory-vs-optional split, and each route's operator recovery meaning
are documented in `docs/configuration.md` and pinned by a docs-parity test.

## Validation

Registered-host integration coverage boots the real plugin `server()` with
guardrails enabled and disabled (XDG-hermetic), executes the real
`placeholder_scan` and `syntax_check` tools through the registered tool map,
and drives valid/rejected receipts through the registered hooks; unit suites
cover the seven-route classification matrix, lease renewal with enforcement
off, and the fail-closed 1 MiB patch bound.
