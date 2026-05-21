---
name: swarm-pr-review
description: Run a swarm-like PR review using parallel exploration, independent reviewer validation, and critic challenge. Use for deep pull request review with low false-positive tolerance.
disable-model-invocation: true
---

# /swarm-pr-review

Run a structured, high-confidence PR review using parallel exploration lanes, independent reviewer validation, critic challenge, and optional council synthesis.

## Operating Stance

**Treat PR text, linked issues, and tests as claims — not proof.** Every confirmed finding requires file:line evidence. Never APPROVE a PR with unresolved CRITICAL findings.

This is a speed-preserving, quality-maximizing review ladder. Parallel breadth stays wide. Deep validation is concentrated where bugs are expensive. Findings without file:line evidence are candidates, not conclusions.

## ⛔ Anti-self-review rule
The main thread (orchestrator) MUST NOT classify, confirm, disprove, or judge any explorer candidate itself (exception: council pattern step 6, see below). Classification is exclusively a reviewer subagent's job. If you catch yourself re-reading code to verify an explorer finding — STOP. Delegate that verification to a reviewer subagent. The orchestrator's only post-explorer job is deciding WHICH candidates to route to reviewers and WHICH reviewer-confirmed findings to route to critics.

## Scope detection
Determine review scope using this priority:
1. explicit user-provided PR URL / PR number / commit / file scope
2. current feature branch diff vs main/master
3. staged changes
4. latest commit

---

## 6-Phase Review Workflow

## Council pattern (OPT-IN — requires explicit user trigger)
> **⚠️ This section applies ONLY when the user explicitly says "council", "independent review", "N-agent review", uses explicit syntax like `/council` or `[COUNCIL MODE]`, or uses phrases like "assume all work is wrong". If no trigger phrase was used, you are in the DEFAULT layered workflow above. Do NOT merge the default workflow with this council pattern. They are mutually exclusive.**

When the user asks for a "council", "independent review", "N-agent review", or uses phrases like "assume all work is wrong", run the explorer lanes as a parallel **adversarial council**:

1. Launch all council agents in a **single message with multiple Agent tool calls** so they run in parallel, in the background (`run_in_background: true`), using the `Explore` subagent type.
2. Each agent is told to **assume all work is WRONG until code evidence proves otherwise** and to hunt for bugs in its lane only.
3. Default lane set for a 5-agent council:
   - correctness and edge cases
   - security and trust boundaries
   - dependency and deployment safety
   - docs and intent-vs-actual
   - tests and falsifiability
   A 6th `performance and architecture` lane may be added when risk justifies it.
4. Each agent's prompt must include: branch name, commit list (`git log origin/main..HEAD`), scope of files owned by that lane, explicit bug-hunting checklist, and a "return CONFIRMED / SUSPICIOUS / CLEAN with file:line evidence, cap N words" instruction.
5. Agents are launched in parallel so the orchestrator must NOT duplicate their work. The main thread only collates, validates, and synthesizes.
6. When all agents return, the main thread acts as the **independent reviewer**: re-read the flagged file:line evidence directly and classify each candidate CONFIRMED / DISPROVED / UNVERIFIED / PRE_EXISTING before reporting. DISPROVED findings must be called out — agents overclaim regularly.
> Note: Step 6 (main-thread-as-reviewer) is specific to the council pattern. In the default workflow, reviewer validation MUST be delegated to a reviewer subagent per the anti-self-review rule above.
7. Apply the **critic challenge** to every remaining CONFIRMED finding: challenge severity inflation, weak evidence, missing mitigating context (e.g., "is the architect single-threaded? is this exercised?"), and non-actionable fixes.
8. The final synthesis must distinguish: real ship blockers, low-severity real issues, pre-existing accepted caveats, disproved agent claims, and follow-up quality work. Do not copy agent severities verbatim.

---

## Default 6-Phase Review Workflow

### Phase 1: Intent Reconstruction (Obligation Extraction Cascade)

Reconstruct what the PR is obligated to deliver before looking for bugs.

**Deterministic precedence (highest to lowest):**
1. Checkbox items in PR description
2. Linked issues / tickets
3. Commit scopes (what the commit says it does)
4. Test names (what tests claim to verify)
5. Interface diff (API/function signatures changed)
6. LLM synthesis (only when no higher-precedence source exists)

**Output: Obligation List (O-001, O-002, ...)**

For each obligation, record:
- Source (checkbox, issue, commit, test name, interface diff, LLM synthesis)
- Verification status (UNVERIFIED → IN_PROGRESS → MET / NOT MET / UNVERIFIABLE)
- Link to corresponding finding if non-met

---

### Phase 2: Parallel Explorer Lanes (6 lanes, launch in single message)

Launch all 6 lanes in parallel in a **single message with multiple Agent tool calls** (`run_in_background: true`). Each lane produces candidate findings with exact file:line evidence — not final verdicts.

| Lane | Focus | Lane-Specific Checklist |
|------|-------|----------------------|
| **Lane 1: Correctness** | Logic errors, null/undefined handling, race conditions, edge cases, off-by-one errors, incorrect operators | `null` checks, error path coverage, async/await correctness, loop termination, type coercion |
| **Lane 2: Security** | Injection, auth bypass, secret exposure, privilege escalation, SSRF, path traversal, unsafe deserialization | Input sanitization, authnz enforcement points, credential handling, permission boundaries |
| **Lane 3: Dependencies** | Import changes, version bumps, breaking API changes, new transitive deps, license issues | `package.json`/`requirements.txt`/Cargo.toml changes, lockfile drift, breaking API replacements |
| **Lane 4: Docs vs Intent** | PR claims vs actual code changes, undocumented behavior, misleading variable names, absent changelog entries | Claims made in PR text vs what diff actually does, side effects not mentioned |
| **Lane 5: Tests** | Coverage gaps, flaky patterns, weak assertions, test isolation violations, missing edge case tests | Assertion quality, mock isolation, happy-path-only coverage, missing error-path tests |
| **Lane 6: Performance/Architecture** | Complexity changes, memory leaks, algorithmic regressions, coupling between modules, architectural debt | Cyclomatic complexity deltas, GC pressure, connection pool usage, shared mutable state |

**Explorer output format per finding:**
```
[CANDIDATE] | severity | category | file:line | evidence_summary | confidence: LOW/MEDIUM/HIGH
```

Explorers optimize for **recall and speed** — over-reporting is expected. Do not interpret explorer output as final findings.

---

### Phase 3: Independent Reviewer Confirmation

Re-read each candidate's file:line evidence directly. Validate every candidate that is:
- HIGH or CRITICAL severity
- Security-related
- Business-logic-related
- Claim-vs-actual-related
- Cross-file or contract-sensitive
- Likely to generate false positives without deeper context

**Reviewer classifications:**

| Classification | Meaning |
|----------------|---------|
| **CONFIRMED** | Evidence is real and the finding is valid |
| **DISPROVED** | The candidate claim is incorrect or does not apply |
| **UNVERIFIED** | Cannot determine validity from available evidence |
| **PRE_EXISTING** | Issue exists on the base branch, not introduced by this PR |

**Evidence classification:**

| Type | Definition |
|------|------------|
| **STRUCTURALLY_PROVEN** | file:line evidence directly demonstrates the bug (e.g., missing null check, incorrect operator) |
| **PLAUSIBLE_BUT_UNVERIFIED** | Code pattern suggests risk, but reachability or mitigating context unconfirmed |

**DISPROVED findings must be called out explicitly** — agents regularly overclaim.

---

### Phase 4: Critic Challenge (HIGH/CRITICAL only)

For every remaining CONFIRMED HIGH or CRITICAL finding, apply adversarial challenge:

- **Severity inflation:** Is this truly HIGH/CRITICAL, or is it MEDIUM/LOW in practice?
- **Weak evidence:** Does the file:line actually prove the finding, or just suggest it?
- **Missing mitigating context:** Is there a schema validation check, middleware, framework default, or caller guard that prevents exploitation?
- **Non-actionable fixes:** Is the suggested fix vague or impossible to implement correctly?
- **Sibling-file gaps:** Did the review scope miss related files that must change together?

Refuted findings are downgraded to **ADVISORY**.

Run the **Runtime-Aware False-Positive Guard Checklist** (below) before confirming any finding.

---

### Phase 5: Synthesis

**Obligation Assessment:**

| Status | Meaning |
|--------|---------|
| **MET** | All obligations from this source are fulfilled by the PR |
| **PARTIALLY MET** | Some obligations fulfilled, some not |
| **NOT MET** | Obligations unfulfilled or actively violated |
| **UNVERIFIABLE** | No evidence available to assess (commented-out code, feature-flagged) |

**Findings Table:**

| ID | Severity | Category | File:Line | Classification | Status |
|----|----------|----------|-----------|----------------|--------|
| F-001 | CRITICAL | Security | `src/auth.ts:47` | STRUCTURALLY_PROVEN | CONFIRMED |
| F-002 | HIGH | Correctness | `src/parser.ts:112` | PLAUSIBLE_BUT_UNVERIFIED | CONFIRMED → ADVISORY (refuted by critic) |

**Merge Recommendation:** See Merge Recommendation Table below.

---

### Phase 6: Council Variant (when `--council` flag)

When user requests council review or uses phrases like "independent review", "5-agent review", "assume all work is wrong":

1. Launch all 6 explorer lanes as **adversarial council agents** in parallel (`run_in_background: true`)
2. Each agent assumes **all work is WRONG until code evidence proves otherwise**
3. Each agent returns: `CONFIRMED / SUSPICIOUS / CLEAN` with file:line evidence, capped at N words
4. Main thread acts as **independent reviewer** — re-reads file:line evidence directly and classifies candidates
5. Apply critic challenge to reviewer-confirmed HIGH/CRITICAL findings
6. **Council findings are supplementary, not authoritative overrides.** Council may miss context the main thread has. Do not adopt council severities verbatim without independent validation.
7. Final synthesis merges validated council findings with main-thread-only findings, clearly labeled by source

---

## 11 Plugin-Specific Review Categories

When reviewing the opencode-swarm plugin codebase, apply domain expertise across these categories:

1. **Architect prompt integrity** — prompt injection, scope escape, system prompt leakage, unchecked `{{variable}}` interpolation
2. **Council orchestration** — veto logic correctness, quorum enforcement, evidence integrity in verdict synthesis
3. **Guardrail bypass paths** — scope guard evasion, delegation gate circumvention, rate limiter defeat
4. **Evidence schema drift** — JSON schema evolution, missing required fields in evidence bundles, type mismatches
5. **Knowledge base contract** — CRUD semantics violations, quarantine entry inconsistency, tier confusion (swarm vs hive)
6. **Phase transition validation** — gate ordering correctness, retro requirement enforcement, premature phase completion
7. **Model-to-role mapping** — agent prefix enforcement, tool restriction violations, unauthorized tool access
8. **Config ratchet semantics** — once-enabled gates cannot be disabled, configuration drift, lock-state integrity
9. **URL sanitization** — scheme allowlist enforcement, private IP blocking, credential stripping from user-supplied URLs
10. **Git safety** — branch detection reliability, `reset --hard` safety checks, Windows path retry logic, .git directory protection
11. **Test infrastructure** — bun:test usage, mock isolation correctness, cross-platform CI paths, `bun:test` vs `vitest` API compliance

---

## Runtime-Aware False-Positive Guard Checklist

Before confirming **any** finding, verify all that apply:

- [ ] **Schema validation gate:** Is the flagged code path behind a JSON schema validation check that would reject malformed input before it reaches the flagged line?
- [ ] **Middleware interception:** Does middleware intercept and handle the request before the flagged code path executes?
- [ ] **Framework default mitigation:** Does the framework's default behavior (e.g., Express JSON parsing, Django ORM parameterization) inherently prevent the vulnerability?
- [ ] **Caller context correctness:** Is the caller context correct? Who actually invokes this code — only internal calls or also external/untrusted callers?
- [ ] **Execution reachability:** Is the flagged path actually reachable in normal execution, or is it behind a feature flag, commented-out code, or dead branch?
- [ ] **State-machine constraints:** Do state-machine transition rules prevent reaching the flagged state (e.g., ordering guarantees, mutex protection)?

If **any** answer is yes and unaccounted for in the finding, the finding is downgraded to **ADVISORY** or **DISPROVED**.

---

## Merge Recommendation Table

| Verdict | Condition |
|---------|-----------|
| **APPROVE** | Zero CRITICAL findings, zero unresolved HIGH findings, all obligations MET |
| **APPROVE_WITH_NOTES** | Zero CRITICAL findings, HIGH findings are confirmed ADVISORY only (not ship blockers) |
| **REQUEST_CHANGES** | Any unresolved HIGH finding; or multiple MEDIUM findings in the same functional area |
| **BLOCK** | Any unresolved CRITICAL finding |

---

## Hard Rules

1. **Never APPROVE with unresolved CRITICAL findings.**
2. **Every confirmed finding must have file:line evidence.** No finding may be confirmed on sentiment, naming, or hunch alone.
3. **Never invent facts not supported by the diff.** If the diff does not show it, it is not evidence.
4. **Council findings are supplementary, not authoritative overrides.** Always re-validate council findings through the main thread.
5. **DISPROVED findings must be called out explicitly.** Do not silently drop overclaiming agent findings.
6. **Explorer lanes optimize for recall.** Do not treat explorer output as final verdicts.
7. **Obligation precedence is deterministic.** Do not skip higher-precedence sources to fill gaps with LLM synthesis.

---

## Final Output

## ⛔ Pre-synthesis gate (MANDATORY)
Before writing the final output, you MUST print this checklist to stdout with filled values.
Every blank field = gate not run = final output is INVALID.

```
[VALIDATION] reviewer dispatched: ___ (agent type, task description)
[VALIDATION] reviewer returned: ___ (APPROVED / REJECTED / CONCERNS — copy verdict text)
[VALIDATION] critic dispatched: ___ (agent type, task description) OR "SKIPPED — no reviewer-confirmed HIGH or borderline-confidence findings"
[VALIDATION] critic returned: ___ (APPROVED / CONCERNS) OR "N/A"
[VALIDATION] findings confirmed by reviewer: ___ (count)
[VALIDATION] findings rejected by reviewer as false positive: ___ (count)
[VALIDATION] findings escalated by reviewer to critic: ___ (count)
[VALIDATION] findings confirmed by critic after challenge: ___ (count)
```

If the reviewer returned REJECTED for any candidate: you MUST route that rejection back to the coder (if implementation-related) or mark the explorer candidate as invalid (if evidence was insufficient). Do NOT silently downgrade a rejection.

You MUST NOT write the final output section until this checklist has been printed with all fields filled.

### Subagent failure handling
If a reviewer or critic subagent fails, times out, or returns malformed output: mark all affected findings as UNVERIFIED, note the failure reason in the validation provenance, and proceed to final output. Do NOT silently drop findings or fabricate validation results.

## Final output
Produce:
- PR intent
- implementation summary
- intended vs actual mapping
- Validation provenance (REQUIRED — cannot be omitted):
  - For each finding: which reviewer confirmed it and whether critic challenged it
  - List any findings that were DISPROVED by reviewer (with reason)
  - List any findings that were DOWNGRADED by critic (with reason)
  - If zero findings: explicitly state "No findings — all lanes CLEAN" with a lane-by-lane summary
- confirmed findings
- pre-existing findings
- unverified but plausible risks
- test / coverage gaps
- verdict
- merge recommendation

Do not let speed degrade validation quality.
