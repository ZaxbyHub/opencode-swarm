# Test Audit Failures — Baseline

Date: 2026-04-28
Suite: 891 test files
Platform: Windows 11 (hooks tests skipped per CI)

## Real Failures (non-zero exit code, actual test assertions)

1. tests/unit/state/telemetry-wiring.test.ts — 2 fail
   - "emits gate_passed with correct sessionId..." — Expected length 3, received 6 (events doubled)
   - "emits gate_passed with different gate names" — same root cause

2. src/__tests__/acknowledge-spec-drift.test.ts — 2 fail
   - "returns confirmation with warning message" — Expected "⚠️  Caution:" received "⚠️  Warning:"

3. src/__tests__/cli-version.test.ts — 1 fail (assertion TBD)

4. src/__tests__/convene-general-council.test.ts — 1 fail (assertion TBD)

5. src/__tests__/web-search-provider.test.ts — 1 fail
   - Expected reason "council_general_disabled", received "missing_api_key"

6. src/hooks/delegation-gate.evidence.test.ts — 1 fail
   - warn message "evidence write failed" + "1.11" not found in warnCalls

7. src/tools/barrel-export-check-gate-status.test.ts — 1 fail
   - Expected only ["check_gate_status"], received also ["get_qa_gate_profile","set_qa_gates"]

8. src/tools/check-gate-status.adversarial.test.ts — 2 fail
   - "rejects task_id with too many dots" — tool accepted "1.1.1.1" instead of rejecting it
   - "rejects decimal numbers in task_id" — same

9. src/tools/check-gate-status.prefix.test.ts — 13 fail
   - GATE prefix format completely broken — returns raw JSON instead of "[GATE:BLOCK ...]"

10. src/tools/curator-analyze.test.ts — 1 fail
    - "accepts valid recommendations with all action types" — parsed.applied is undefined

11. src/tools/suggest-patch.adversarial.test.ts — 2 fail
    - "handles targetFiles as number instead of array" — parsed.error is undefined
    - "handles targetFiles as object instead of array" — same

12. src/tools/update-task-status.adversarial.test.ts — 9 fail
    - fallbackDir guard behavior broken (multiple assertions)

13. src/tools/update-task-status.test.ts — 4 fail
    - fallbackDir guard not firing — warn not emitted

14. src/index.adversarial-bootstrap.test.ts — 1 fail
    - "Task handoff followed immediately by stale delegation reset" — delegationActive expected false, received true

15. src/scope/scope-persistence.test.ts — 1 fail
    - "rejects symlinked scope file (lstat guard)" — returned ["/etc/passwd"] instead of null
    - Note: Symlink creation succeeded on Windows (no privilege error)

16. tests/integration/phase-completion-e2e.test.ts — 1 fail (assertion TBD)

17. tests/architect/escalation-discipline.test.ts — 3 fail
    - Token count 314 > 150 limit

## Passing Directories (all green)
- tests/unit/cli/
- tests/unit/commands/ (warnings in output but all pass)
- tests/unit/config/ (warnings in output but all pass)
- tests/unit/tools/ (all pass)
- tests/unit/services/
- tests/unit/build/
- tests/unit/quality/
- tests/unit/sast/
- tests/unit/sbom/
- tests/unit/scripts/
- tests/unit/agents/
- tests/unit/background/
- tests/unit/context/
- tests/unit/diff/
- tests/unit/evidence/
- tests/unit/git/
- tests/unit/helpers/
- tests/unit/knowledge/
- tests/unit/lang/
- tests/unit/output/
- tests/unit/parallel/
- tests/unit/plan/
- tests/unit/session/
- tests/unit/skills/
- tests/unit/types/
- tests/unit/utils/
- tests/unit/adversarial/
- tests/unit/council/
- tests/unit/graph/
- tests/unit/mutation/
- tests/unit/state/ (except telemetry-wiring.test.ts)
- tests/integration/ (except phase-completion-e2e.test.ts)
- tests/security/
