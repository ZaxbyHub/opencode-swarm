# PR-review controller gate diagnostics and Task precedence (#2075)

## What changed

- PR-review base and micro discovery output is validated when lane collection
  first observes completion. Malformed structured artifacts become explicit
  lane failures instead of appearing successful until a later aggregate gate.
- Aggregate base-coverage failures identify the first failed predicate for each
  missing lane with bounded expected/actual context and the canonical candidate
  and clean-row templates.
- The plugin-host fail-closed chain now runs the active PR workflow gate after
  guardrails and scope guard, but before the generic delegation gate. Direct
  reviewer Tasks in `PR_REVIEW` therefore receive the actionable
  `dispatch_lanes_async` requirement instead of the unrelated
  `ACCEPTANCE_FIELD_REQUIRED` error.
- The canonical PR-review workflow now explains how to isolate contract-layer
  failures without duplicating the controller-appended prompt contract,
  weakening acceptance, or treating a post-hoc fallback as proof the original
  path was correct.
- A packaged, content-addressed recovery evaluation now compares the canonical
  workflow against the exact pre-fix skill bytes and rejects blind retries,
  profile fallback, unsupported severity, parser-only reasoning, and premature
  systemic-defect claims.

## Why

A structurally completed lane could fail durable role, session, lane, head,
digest, or artifact checks while the controller reported only six missing
coverage dimensions. That hid the predicate an operator needed to repair. In
the same workflow, generic acceptance validation ran before the authoritative
PR mode check, so a forbidden direct reviewer Task produced a misleading prompt
error before the controller could explain that structured dispatch was
required.

## Migration

No configuration or data migration is required. Existing valid structured
lanes, retry-union behavior, read-only reviewer acceptance requirements outside
`PR_REVIEW`, and verified `PR_FEEDBACK` coder scope preflight remain unchanged.
