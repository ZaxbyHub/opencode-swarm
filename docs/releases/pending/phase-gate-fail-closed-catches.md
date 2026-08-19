## Fix: fail-closed catch blocks in phase completion gates

Three phase completion gates had outer catch blocks that silently swallowed
errors and returned `blocked: false`, allowing gate advancement without
positive evidence — the same defect class as the Stage B fallback fixed in
issue #2099.

### What changed

- **completion-verify-gate** (Gate 1): catch now returns `blocked: true` with
  reason `COMPLETION_VERIFY_ERROR` instead of silently passing.
- **hallucination-gate** (Gate 3): added `hallucinationGateEnabled` flag
  using the phase-council idiom — fail-closed when the gate is confirmed
  enabled, fail-open when enablement could not be determined.
- **mutation-gate** (Gate 4): same pattern with `mutationGateEnabled` flag.

### Correct patterns matched

- Unconditional: `architecture-supervisor-gate.ts` (catch always blocks)
- Conditional: `phase-council-gate.ts` (hoisted flag, checked in catch)

### Migration

No migration required. Behavior change: if `executeCompletionVerify`,
`resolveGatePreamble`, or evidence-reading code throws an unexpected error
while the respective gate is enabled, phase completion will now block instead
of silently advancing.

### Known caveats

None.
