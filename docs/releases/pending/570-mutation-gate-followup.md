# Mutation gate follow-up: security hardening, bug fix, and test coverage (issue #570)

## What changed

Follow-up items from the PR #569 mutation gate review, addressing security hardening,
a functional bug, test coverage gaps, and evidence schema unification.

### Security: allowlist validation for testCommand (item 1)

`src/mutation/engine.ts` — Added `ALLOWED_TEST_RUNNERS` set (bun, vitest, jest,
mocha, pytest, cargo, go, npx, bunx, node, deno) and exported `validateTestCommand()`
function. The check runs in `executeMutationSuite()` before any subprocess is spawned
and returns an empty failing report for disallowed executables.

`src/tools/mutation-test.ts` — Added early allowlist validation before calling
`executeMutationSuite`, returning a structured error if the test runner is not in the
allowlist.

### Security: prompt injection defense — sanitizeFilename (item 2)

`src/mutation/generator.ts` — Added `sanitizeFilename()` helper that strips control
characters (0x00–0x1F, 0x7F) and quote characters from filenames before they are
interpolated into the LLM prompt.

### Bug fix: testFiles parameter was silently ignored (item 6)

`src/mutation/engine.ts` — Renamed `_testFiles` to `testFiles` in `executeMutation`
and added logic to append specified test files to the test command arguments when
provided. This makes impacted-test scoping functional for the first time.

### Evidence schema unification (item 8)

`src/config/evidence-schema.ts` — Extended `EvidenceTypeSchema` with three gate
evidence types: `mutation-gate`, `drift-verification`, and `hallucination-verification`.
Extended `EvidenceVerdictSchema` with `warn` and `skip` variants. Added
`GateEvidenceBaseSchema` and three concrete gate evidence schemas
(`MutationGateEvidenceSchema`, `DriftVerificationEvidenceSchema`,
`HallucinationVerificationEvidenceSchema`) registered in the `EvidenceSchema`
discriminated union.

### Test improvements: mutationType assertion and tightened toContain (items 3 & 4)

`src/mutation/__tests__/generator.test.ts` — Added `expect(result[0].mutationType).toBe('off-by-one')` assertion to test 9.

`tests/unit/tools/phase-complete.mutation-gate.test.ts` — Changed `.toContain('fail')`
to `.toContain("returned verdict 'fail'")` for branch-specific validation.

### New test coverage: testFiles scoping and allowlist (items 1 & 6 tests)

`tests/unit/mutation/engine-test-files-scoping.test.ts` — New test file covering:
- `executeMutation` appends test files to the command when provided
- `executeMutation` runs the full suite when no test files are provided
- `executeMutationSuite` passes test files through to each mutation execution
- `validateTestCommand` accepts all allowed runners and rejects unknown executables

### New test coverage: E2E pipeline integration (item 5)

`tests/unit/tools/phase-complete.mutation-pipeline.e2e.test.ts` — End-to-end pipeline
integration test covering the full workflow from `evaluateMutationGate` through
`executeWriteMutationEvidence` to `phase_complete` Gate 4 enforcement:
- pass verdict (high kill rate) → phase completes
- warn verdict (medium kill rate) → phase completes (non-blocking)
- fail verdict (low kill rate) → phase blocked with `MUTATION_GATE_FAIL`
- skip verdict (no mutants) → phase completes
- missing evidence → blocked with `MUTATION_GATE_MISSING`
- corrupted evidence (malformed JSON) → blocked with `MUTATION_GATE_MISSING`
- evidence format contract: exact schema fields validated

### New test coverage: real path validation (item 7)

`src/tools/write-mutation-evidence.real-path.test.ts` — Tests that use the real
`validateSwarmPath` (not mocked) to verify:
- Evidence is written under `.swarm/evidence/N/` with the real validation
- Path traversal attempts (`../../../etc/passwd`) are rejected
- Windows-style traversal (`..\\..\\secret`) is rejected
- POSIX absolute paths (`/etc/passwd`) are rejected
- Windows absolute paths (`C:\Windows\secret`) are rejected
- Null bytes in filenames are rejected
- Normal relative paths are correctly confined to `.swarm/`

## Why

Issue #570 tracked follow-up items from the PR #569 review. Items 1 (security),
2 (security), 3 (test quality), 4 (test quality), 5 (critical coverage gap),
6 (functional bug — testFiles was entirely non-functional), 7 (path validation
coverage), and 8 (schema architecture) were all addressed.

Item 9 (parallel mutation execution) was deferred as a separate performance
optimization task.

## Migration steps

None. The evidence schema extension is backward compatible. The allowlist check
is additive — existing test commands using allowed runners are unaffected.

## Breaking changes

None.

## Known caveats

Item 9 (parallel execution for large mutation sets) was not addressed in this PR.
