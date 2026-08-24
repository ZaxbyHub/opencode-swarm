# Invocation failures, retry, and recovery

opencode-swarm classifies failures once, at their structured source boundary, and carries that result through retry, circuit containment, telemetry, advisories, model fallback, and Full-Auto. Downstream consumers must not infer a new category from human-readable evidence.

## Failure record

The versioned record separates machine authority from display text. It records source, category, retry class, semantic action digest, risk, bounded evidence, and source-specific structured codes. Evidence is redacted and size-bounded; prompts, command text, raw output, secrets, environment values, and credential-bearing URLs are never circuit keys or telemetry payloads.

Retry classes are `retry_same`, `retry_fallback`, `repair_then_retry`, `operator_action`, and `do_not_retry`. Important distinctions remain explicit: `EBUSY` may be transient for an idempotent local operation; `EPERM`, `EROFS`, and `ENOSPC` require repair; Git conflicts belong to worktree recovery; provider quota is classified only on the provider channel; sandbox-wrapper failure never falls back to unsandboxed execution.

## Semantic action identity and circuits

A delegation action is identified by exact normalized role/swarm, plan task/phase where available, parent session/invocation, logical dispatch generation, bounded mode/background/scope identity, and a cryptographic digest of additional canonical arguments. Attempt number is excluded, so a true retry coalesces while another task or logical generation does not. Raw arguments are not retained.

Circuits are bounded and keyed by session, invocation, action digest, and category. An open circuit blocks only the matching action. Corrected success clears only that action. Conditions requiring external repair use an exact audited reset; stale, foreign-session, and foreign-invocation resets fail closed.

Read-only inspection and exact diagnose, repair/rescope, handoff, abort, and Full-Auto exit controls remain reachable. A sandbox-wrapper circuit still blocks its corresponding shell action. Circuit and model-override state is process-local, TTL/LRU-bounded, lifecycle-cleared, and never durable authorization under `.swarm/`.

## Model fallback lifetime

Fallback is scoped to the exact parent session, invocation, selected swarm, and canonical role. Primary/fallback chains come from immutable validated configuration; malformed entries, duplicates, and repeated primaries are removed. Only provider-dispatch failures advance the chain.

Direct SDK dispatchers pass the selection in the request body. Built-in Task retries apply it to the correlated child turn at OpenCode's mutable `chat.message` user-message boundary. If exact parent call/generation correlation fails, fallback is not guessed by role and primary remains in effect.

Success returns the next invocation to primary. Exhaustion is explicit and never wraps. Diagnostics expose bounded status without prompts or provider output.

## Full-Auto risk and oversight

Strict mode sends every delegation and plan/completion mutation to critic oversight even when the auxiliary permission policy is disabled. Assisted/supervised modes may lower only genuinely read-only bounded local exploration whose registered tool map agrees. Write, shell, network, publication, destructive, protected-state, privileged, external, unknown, or ambiguous capabilities remain escalated/denied. Caller labels and “read-only” prose are not evidence.

Oversight has one total deadline covering ephemeral session creation, prompt, retry/fallback, backoff, parse, and bounded cleanup. Timeout/infrastructure failure keeps the risky action denied and pauses the run.

Paused recovery controls are narrowly parsed: `/swarm diagnose`, `full-auto status`, `full-auto retry-oversight`, handoff, `full-auto abort`, `full-auto resume|on`, and `full-auto off|exit`. A health probe cannot clear policy, containment, sandbox, or action circuits. The original action must be explicitly reissued in a new generation and is reviewed again.

## Severe subagent results

Free-form output is advisory only. A durable severe pause requires a bounded versioned envelope correlated to the exact parent Task call/generation plus a deterministic corroborating scope/guardrail/evidence event. Negated prose, malformed/oversized envelopes, stale/duplicate/cross-session records, and unsupported claims cannot fabricate a violation.

Old paused/terminated state remains conservative after upgrade: unknown legacy reasons do not auto-resume. No migration rewrites user agent model configuration.
