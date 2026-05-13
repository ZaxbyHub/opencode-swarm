# Test Taxonomy

This document defines the 7 test categories used in this repository, with criteria for when to use each, examples from the codebase, and file naming conventions.

---

## 1. `standard` — Normal Behavioral Tests

**Definition:** Tests that verify expected, nominal functionality. They confirm that features work as designed with valid inputs and correct code paths.

**Inclusion Criteria:**
- Testing happy-path behavior
- Verifying correct output for valid inputs
- Confirming normal error handling for expected failure cases
- Validating integration points work correctly under normal conditions

**Exclusion Criteria:**
- Do NOT use for malformed, malicious, or edge-case inputs
- Do NOT use for previously-fixed bugs (use `regression` instead)
- Do NOT use for type safety verification (use `type-safety` instead)

**Example from this repo:**
```typescript
// tests/unit/index.test.ts
test('plugin returns object with tool property when invoked with mock context', async () => {
  const result = await OpenCodeSwarm(mockPluginInput);
  expect(result).toHaveProperty('tool');
});
```

**File Naming:** No suffix — e.g., `index.test.ts`, `logger.test.ts`

---

## 2. `adversarial` — Tests Using Malicious/Attack Inputs

**Definition:** Tests that verify the system remains secure when an attacker provides malicious, malformed, or unexpected inputs through real code paths. These test that defensive code actually blocks attacks.

**Inclusion Criteria:**
- Testing with malformed data (binary, null bytes, control characters)
- Verifying that an attacker cannot bypass security checks via input manipulation
- Testing that malicious inputs are rejected or safely handled
- Checking that security-sensitive code paths are not exploitable

**Exclusion Criteria:**
- Do NOT use for simple null/undefined/empty handling (use `edge-case` instead)
- Do NOT use for specific documented attack vectors like SQL injection (use `attack` instead)
- Do NOT use for TypeScript type safety (use `type-safety` instead)
- Do NOT use for regression tests of previously fixed bugs (use `regression` instead)

**Example from this repo:**
```typescript
// tests/unit/turbo/lean/runtime-conformance.adversarial.test.ts
describe('ATTACK VECTOR 1: Malformed Context/Plan Inputs', () => {
  test('handles binary data in context.md without crashing', async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(tempDir, '.swarm', 'context.md'), binaryData);
    const result = await analyzeDecisionDrift(tempDir);
    expect(result).toBeDefined();
    expect(result.hasDrift).toBe(false);
  });
});
```

**File Naming:** `.adversarial.test.ts` suffix — e.g., `runtime-conformance.adversarial.test.ts`

---

## 3. `edge-case` — Boundary Conditions, Null/Undefined/Empty

**Definition:** Tests for the edges of valid input spaces — null, undefined, empty strings, zero values, empty arrays, and boundary values just inside valid ranges.

**Inclusion Criteria:**
- Testing null, undefined, empty string, empty array, zero
- Testing whitespace-only strings
- Testing single-element arrays, single-character strings
- Testing values at the boundary of valid ranges (but not AT the boundary — that's `boundary`)
- Verifying graceful handling of missing optional parameters

**Exclusion Criteria:**
- Do NOT use for malformed/malicious inputs (use `adversarial` instead)
- Do NOT use for specific documented attack vectors (use `attack` instead)
- Do NOT use for exact boundary values (use `boundary` instead)

**Example from this repo:**
```typescript
// tests/unit/utils/logger.edge-case.test.ts
describe('ATTACK VECTOR 2: undefined/null/empty message handling', () => {
  it('should NOT crash when message is undefined', () => {
    expect(() => warn(undefined as unknown as string)).not.toThrow();
  });

  it('should NOT crash when message is null', () => {
    expect(() => warn(null as unknown as string)).not.toThrow();
  });

  it('should NOT crash when message is empty string', () => {
    expect(() => warn('')).not.toThrow();
  });
});
```

**File Naming:** `.edge-case.test.ts` suffix — e.g., `logger.edge-case.test.ts`

---

## 4. `regression` — Preventing Previously-Fixed Bugs from Recurring

**Definition:** Tests written specifically to prevent bugs that were fixed in the past from being reintroduced. Each regression test corresponds to a specific bug that was fixed.

**Inclusion Criteria:**
- Testing a bug that was previously fixed and could regress
- Verifying that a specific issue number or bug report stays fixed
- Confirming that code changes don't break previously working functionality
- Validating backward compatibility fixes

**Exclusion Criteria:**
- Do NOT use for normal feature testing (use `standard` instead)
- Do NOT use for security attack vectors (use `adversarial` or `attack` instead)
- Do NOT use for type safety (use `type-safety` instead)

**Example from this repo:**
```typescript
// tests/unit/tools/diff.test.ts
describe('subprocess stdio options — regression: Windows stdin block (Invariant #3)', () => {
  test('numstat call passes stdio: ["ignore","pipe","pipe"] to prevent Windows stdin block', async () => {
    mockExecFileSync.mockReturnValueOnce('5\t2\tsrc/foo.ts');
    await diff.execute({ base: 'HEAD' }, '/fake/dir');
    const [, , numstatOpts] = mockExecFileSync.mock.calls[0];
    expect(numstatOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });
});
```

**File Naming:** No special suffix, but typically include "regression" or issue number in describe block — e.g., `diff.test.ts`, `update-task-status.test.ts`

---

## 5. `boundary` — Exact Edges of Valid Input Ranges

**Definition:** Tests at the exact boundaries of valid input — maximum values, minimum values, values just outside valid ranges, overflow/underflow conditions.

**Inclusion Criteria:**
- Testing maximum and minimum integer values
- Testing string length limits (empty vs 1 char vs max length)
- Testing array size limits (0, 1, max)
- Testing values just outside valid ranges (+/- 1 from boundary)
- Testing overflow, underflow, wraparound

**Exclusion Criteria:**
- Do NOT use for values inside the valid range (use `standard` or `edge-case` instead)
- Do NOT use for malformed/malicious inputs (use `adversarial` instead)
- Do NOT use for attack vectors (use `attack` instead)

**Example from this repo:**
```typescript
// tests/unit/turbo/lean/runtime-conformance.adversarial.test.ts
describe('Invalid phase numbers', () => {
  test('NaN phase number is rejected', () => { /* ... */ });
  test('Infinity phase number is rejected', () => { /* ... */ });
  test('Negative phase number is rejected', () => { /* ... */ });
  test('Zero phase number is rejected', () => { /* ... */ });
  test('MAX_SAFE_INTEGER phase number is handled', () => { /* ... */ });
  test('Floating point phase (1.5) is handled', () => { /* ... */ });
});
```

**File Naming:** Often combined with `.adversarial.test.ts` since boundary violations are a subset of adversarial inputs — e.g., `runtime-conformance.adversarial.test.ts`

---

## 6. `attack` — Specific Documented Attack Vectors

**Definition:** Tests for specific, named attack vectors such as SQL injection, XSS, path traversal, command injection, prototype pollution, etc. These target known security vulnerabilities.

**Inclusion Criteria:**
- Testing SQL injection attempts
- Testing XSS payloads
- Testing path traversal (`../`, null bytes in paths)
- Testing command injection in shell commands
- Testing prototype pollution (`__proto__`, `constructor`)
- Testing specific CVE patterns or known attack techniques

**Exclusion Criteria:**
- Do NOT use for general malformed input handling (use `adversarial` instead)
- Do NOT use for edge cases that aren't security-related (use `edge-case` instead)
- Do NOT use for type safety (use `type-safety` instead)

**Example from this repo:**
```typescript
// tests/adversarial/task-5.9-decision-drift-attack.test.ts
describe('ATTACK VECTOR 2: Contradiction-spam prompt bloat', () => {
  test('handles 1000+ contradictory decisions without crash or hang', async () => {
    // Generate many contradictory decisions to bloat context
    const content = generateContradictoryDecisions(1000);
    // Should complete without crashing
  });
});
```

**File Naming:** Either `.attack.test.ts` suffix or in `tests/adversarial/` directory — e.g., `task-5.9-decision-drift-attack.test.ts`

---

## 7. `type-safety` — TypeScript Type Constraint Verification

**Definition:** Tests that verify TypeScript types are correctly constrained at compile time and cannot be bypassed at runtime. Uses `@ts-expect-error` and `@ts-expect` annotations.

**Inclusion Criteria:**
- Testing that invalid types are rejected by TypeScript
- Verifying that union types are exhaustive
- Testing that extra fields cannot be injected
- Verifying required fields cannot be omitted
- Testing that type narrowing works correctly

**Exclusion Criteria:**
- Do NOT use for runtime behavior testing (use `standard` instead)
- Do NOT use for malicious inputs (use `adversarial` instead)
- Do NOT use for edge cases that aren't type-related (use `edge-case` instead)

**Example from this repo:**
```typescript
// tests/unit/types/events.type-safety.test.ts
describe('Attack Vector 4: Interface pollution', () => {
  test('Extra fields cannot be injected into SoundingBoardConsultedEvent', () => {
    // @ts-expect-error - Extra fields should be rejected by TypeScript
    const pollutedEvent: SoundingBoardConsultedEvent = {
      type: 'sounding_board_consulted',
      timestamp: '2024-01-01T00:00:00Z',
      architectQuery: 'test query',
      criticVerdict: 'APPROVED',
      phase: 1,
      maliciousField: 'should not be allowed', // TypeScript error expected here
      extraData: { malicious: true },
    };
  });
});
```

**File Naming:** `.type-safety.test.ts` suffix — e.g., `events.type-safety.test.ts`

---

## 8. `di-seam` — Dependency Injection for Testable Async I/O

**Definition:** Tests that use `_internals` DI seams to mock async I/O operations without cross-module mock leakage. This pattern was introduced in Phase 5 to address Bun's shared test-runner process issues with `mock.module(...)`.

**Inclusion Criteria:**
- Testing async I/O functions (file reads, evidence loading, plan loading)
- Using `_internals` object to replace specific functions for test isolation
- Verifying behavior when I/O returns different statuses (found, not_found, error)
- Testing service layers that wrap async operations

**Exclusion Criteria:**
- Do NOT use `mock.module(...)` for file-scoped I/O mocking (leaks across tests)
- Do NOT use for pure unit tests that don't involve async I/O
- Do NOT use for integration tests that actually hit the filesystem

**Example from this repo:**
```typescript
// tests/unit/services/evidence-service.test.ts
import {
  _internals,
  getTaskEvidenceData,
} from '../../../src/services/evidence-service';

describe('getTaskEvidenceData', () => {
  let origLoadEvidence: typeof _internals.loadEvidence;

  beforeEach(() => {
    origLoadEvidence = _internals.loadEvidence;
  });

  afterEach(() => {
    _internals.loadEvidence = origLoadEvidence;
  });

  test('returns hasEvidence false when loadEvidence returns not_found', async () => {
    _internals.loadEvidence = mock(() =>
      Promise.resolve({ status: 'not_found' as const }),
    );

    const result = await getTaskEvidenceData('/fake/dir', 'task-1');

    expect(result.hasEvidence).toBe(false);
  });
});
```

**File Naming:** No special suffix — standard `.test.ts` naming, but tests typically in `tests/unit/services/` or `tests/unit/tools/` directories

**Pattern Template:**
```typescript
describe('serviceName', () => {
  let origFunc: typeof _internals.someFunction;

  beforeEach(() => {
    origFunc = _internals.someFunction;
  });

  afterEach(() => {
    _internals.someFunction = origFunc;
  });

  test('handles various I/O outcomes', async () => {
    _internals.someFunction = mock(() => /* mock return */);
    // test implementation
  });
});
```

---

## Decision Tree: Which Category to Use?

```
Is the test about a SPECIFIC previously-fixed bug?
├── YES → Use `regression`
└── NO
    │
    ├── Is the test verifying TypeScript type constraints?
    │   ├── YES → Use `type-safety`
    │   └── NO
    │       │
    │       ├── Is the test using _internals DI seam to mock async I/O?
    │       │   ├── YES → Use `di-seam`
    │       │   └── NO
    │       │       │
    │       │       ├── Is the input a SPECIFIC NAMED attack vector?
    │       │       │   (SQL injection, XSS, path traversal, prototype pollution)
    │       │       │   ├── YES → Use `attack`
    │       │       │   └── NO
    │       │       │       │
    │       │       │       ├── Is the test at the EXACT boundary of valid input?
    │       │       │       │   (max value, min value, overflow, just outside range)
    │       │       │       │   ├── YES → Use `boundary`
    │       │       │       │   └── NO
    │       │       │       │       │
    │       │       │       │       ├── Is the input malformed, malicious, or binary data?
    │       │       │       │       │   ├── YES → Use `adversarial`
    │       │       │       │       │   └── NO
    │       │       │       │       │       │
    │       │       │       │       │       ├── Is the input null/undefined/empty/zero?
    │       │       │       │       │       │   ├── YES → Use `edge-case`
    │       │       │       │       │       │   └── NO
    │       │       │       │       │       │       │
    │       │       │       │       │       │       └── Use `standard`
```

---

## File Naming Convention Quick Reference

| Suffix | Category | Example Filename |
|--------|----------|------------------|
| *(no suffix)* | standard | `index.test.ts`, `logger.test.ts` |
| `.adversarial.test.ts` | adversarial | `runtime-conformance.adversarial.test.ts` |
| `.edge-case.test.ts` | edge-case | `logger.edge-case.test.ts` |
| `.type-safety.test.ts` | type-safety | `events.type-safety.test.ts` |
| `.attack.test.ts` | attack | `task-5.9-decision-drift-attack.test.ts` |
| *(in `tests/adversarial/`)* | attack | `tests/adversarial/task-5.6-preflight-service-attack.test.ts` |
| *(regression in describe)* | regression | `diff.test.ts` (contains "regression" in describe block) |
| *(no suffix, services/)* | di-seam | `evidence-service.test.ts`, `plan-service.test.ts` |

**Note:** Boundary tests are often combined with adversarial tests because boundary violations are a form of malformed input. If a file contains primarily boundary tests, prefer `.adversarial.test.ts`.

**Note:** `di-seam` tests typically live in `tests/unit/services/` or `tests/unit/tools/` directories and use the `_internals` pattern for I/O mocking.

---

## Quick Reference Table

| Category | Purpose | Input Type | File Suffix |
|----------|---------|------------|-------------|
| **standard** | Normal behavior verification | Valid inputs | *(none)* |
| **adversarial** | Malicious/malformed input handling | Binary, null bytes, control chars | `.adversarial.test.ts` |
| **edge-case** | Boundary-adjacent values | null, undefined, empty, zero | `.edge-case.test.ts` |
| **regression** | Prevent previously-fixed bugs | N/A (bug-specific) | *(describe block)* |
| **boundary** | Exact input range edges | max/min, overflow, +/- 1 | `.adversarial.test.ts` |
| **attack** | Named security attack vectors | SQL injection, XSS, path traversal | `.attack.test.ts` |
| **type-safety** | TypeScript type constraints | N/A (compile-time) | `.type-safety.test.ts` |
| **di-seam** | Async I/O testing with _internals | N/A (service layer) | *(none, services/ dir)* |

---

## Summary

- **`standard`**: Happy path, valid inputs
- **`adversarial`**: Malformed/malicious inputs through real code paths
- **`edge-case`**: null/undefined/empty/zero handling
- **`regression`**: Specific previously-fixed bugs
- **`boundary`**: Exact edges of valid ranges
- **`attack`**: Named security attack vectors
- **`type-safety`**: TypeScript compile-time safety
- **`di-seam`**: Async I/O testing using _internals DI pattern (Phase 5+)
