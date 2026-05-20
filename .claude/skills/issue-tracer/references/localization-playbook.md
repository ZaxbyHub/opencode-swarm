# Localization Playbook

Use this playbook during Phase 2. The goal is not to read the most code. The goal is to build the shortest evidence chain from symptom to root cause.

## Tier 1: Trace-Driven Localization

Use when the issue includes a stack trace, failing test output, panic, exception, compiler error, log line, request ID, or command output.

1. Extract file paths, symbols, line numbers, route names, command names, config keys, and exact error strings.
2. Start from the first project-owned frame, not framework/library frames.
3. Read the frame, its immediate caller, and any input validation or error-mapping code.
4. Confirm whether the visible crash site is the cause or only the symptom.
5. If the trace points to generic error handling, walk backward to the first domain-specific invariant break.

Common trace interpretations:

- Null/undefined/type errors often originate at a missing guard or wrong contract before the crash line.
- Index/bounds errors often originate in filtering, slicing, pagination, or off-by-one logic.
- Assertion failures often indicate an upstream invariant break.
- Timeout/deadlock symptoms require call-chain, lock, retry, cancellation, and external-service review.
- Serialization errors often require checking both producer and consumer schemas.

## Tier 2: Semantic and Structural Localization

Use when the stack trace is missing, generic, misleading, or incomplete.

1. Convert issue text into search terms:
   - user-visible strings
   - endpoint names
   - component labels
   - command flags
   - config names
   - domain nouns and verbs
2. Search broadly, then narrow:
   - `rg "<exact error>"`
   - `rg "<route-or-command>"`
   - `rg "<domain term>|<config key>|<flag>"`
   - `git grep "<tracked symbol>"`
3. Build a candidate file table:
   - file
   - relevant symbol
   - why it could cause the symptom
   - confidence
   - next evidence needed
4. Inspect dependency direction:
   - who calls this code
   - what this code calls
   - where state/config enters
   - where errors are transformed
5. Use git archaeology sparingly but deliberately:
   - `git log --oneline -- <path>`
   - `git show <commit> -- <path>`
   - `git blame -L <start>,<end> -- <path>`

## Tier 3: Hypothesis-Driven Localization

Use when multiple plausible locations remain.

1. Generate 2-5 competing hypotheses.
2. For each hypothesis, define the evidence that would confirm it and the evidence that would falsify it.
3. Test hypotheses in likelihood order.
4. Keep no more than three active hypotheses.
5. Do not preserve weak hypotheses once evidence contradicts them.

Hypothesis format:

```markdown
### H[N]: [short name]
The bug is in `path:symbol` because [specific condition] violates [specific contract], causing [reported symptom] when [triggering input/state].

- Confirm if:
- Falsify if:
- Evidence:
- Verdict:
```

## Granularity Rules

Localize at multiple levels before planning a patch:

1. File-level: which file owns the failing behavior.
2. Element-level: which function/class/config/test helper is responsible.
3. Line-level: which condition, call, assignment, invariant, or boundary check is wrong.

Function or element-level evidence is usually the most useful planning granularity. Line-level evidence is required before editing, but avoid overfitting the plan to one line if the issue is a broken contract across a whole function.

## Call-Chain Exploration

When the failure propagates across components:

1. Start at the failing entry point.
2. Follow calls one layer at a time.
3. At each layer, ask:
   - what data enters
   - what contract is assumed
   - what state changes
   - what errors are swallowed/transformed
   - what output leaves
4. Backtrack when evidence weakens.
5. Record pruned branches in `03-localization-log.md`.

## Stop Conditions

Stop localization and escalate if:

- the root cause requires unavailable production-only data
- two hypotheses remain equally supported
- the issue requires a product decision rather than a code correction
- the suspected fix crosses subsystem boundaries beyond the approved scope

