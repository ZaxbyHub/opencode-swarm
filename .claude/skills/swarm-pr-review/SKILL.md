---
name: swarm-pr-review
description: Run a swarm-like PR review using parallel exploration, independent reviewer validation, and critic challenge. Ingests existing PR comments, detects and resolves merge conflicts, and validates bot/human review findings. Use for deep pull request review with low false-positive tolerance.
disable-model-invocation: true
---

# /swarm-pr-review

Run a structured, high-confidence PR review using parallel exploration lanes, independent reviewer validation, critic challenge, and optional council synthesis.

## Handoff To PR Feedback

Use `../swarm-pr-feedback/SKILL.md` when the user asks to address existing review
comments, requested changes, CI failures, conflicts, stale PR branches, or pasted
PR feedback. This skill discovers and validates new findings; PR feedback closure
belongs to `swarm-pr-feedback`.

## Operating Stance

**Treat PR text, linked issues, and tests as claims — not proof.** Every confirmed finding requires file:line evidence. Never APPROVE a PR with unresolved CRITICAL findings.

This review prioritizes quality above all else. Findings without file:line evidence are candidates, not conclusions.

**Quality is the ONLY metric.** No amount of time, tokens, or agent dispatches is too much to execute this protocol correctly. Speed is irrelevant to correctness. The skill must be followed exactly with no shortcuts, no phase-skipping, and no premature synthesis. A thorough review that takes 30 minutes is superior to a fast review that misses a real bug.

## ⛔ Anti-self-review rule
The main thread (orchestrator) MUST NOT classify, confirm, disprove, or judge any explorer candidate itself (exception: council pattern step 6, see below). Classification is exclusively a reviewer subagent's job. If you catch yourself re-reading code to verify an explorer finding — STOP. Delegate that verification to a reviewer subagent. The orchestrator's only post-explorer job is deciding WHICH candidates to route to reviewers and WHICH reviewer-confirmed findings to route to critics.

## Scope detection
Determine review scope using this priority:
1. explicit user-provided PR URL / PR number / commit / file scope
2. current feature branch diff vs main/master
3. staged changes
4. latest commit

## Phase 0A: Existing PR Comment Ingestion

When reviewing a PR that already has comments, reviews, or bot findings,
ingest and triage them BEFORE starting Phase 1. These are pre-existing signals
that must be validated, not ignored.

### Step 1 — Fetch all PR feedback surfaces

```bash
# Issue comments (general PR thread)
gh pr view <PR_NUMBER> --json comments

# Review comments (inline code comments)
gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments

# Review summaries (approve/request-changes/comment events)
gh pr view <PR_NUMBER> --json reviews

# Bot/automated reviews (Copilot, Codex, CodeRabbit, etc.)
# Inline review comments — use REST API for reliable bot detection via user.type
gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments --jq '.[] | select((.user.type // "") == "Bot" or (.user.login // "" | test("bot|copilot|coderabbit|codex"; "i")))'
```

For general PR comments (not inline), use the issue comments endpoint:
```bash
gh api repos/{owner}/{repo}/issues/{PR_NUMBER}/comments --jq '.[] | select((.user.type // "") == "Bot" or (.user.login // "" | test("bot|copilot|coderabbit|codex"; "i")))'
```

### Step 2 — Classify each comment

| Category | Action |
|----------|--------|
| **Human review with file:line evidence** | Add as candidate finding with `source: existing-review` — still needs reviewer validation |
| **Bot/automated finding with specific code reference** | Add as candidate finding with `source: bot-review` — high false-positive rate, treat as unverified |
| **General feedback / style preference** | Add as advisory obligation |
| **Resolved/outdated comment** | Skip — note in report under "Ingested Resolved Comments" |
| **Requested changes not yet addressed** | Add as HIGH-priority obligation |

### Step 3 — Merge into review pipeline

All ingested comments become candidate findings or obligations. They follow the
same Phase 2-5 pipeline as freshly discovered findings. Ingested findings are
NOT pre-confirmed — they still require independent reviewer validation per the
Anti-Self-Review Rule.

**Comment-ledger output:**
```
[INGESTED] | source | category | file:line (if applicable) | original_author | status: PENDING_VALIDATION / SKIPPED_OUTDATED / ADVISORY
```

### Anti-patterns
- ✗ Ignoring bot reviews because "bots produce false positives" — they also catch real issues
- ✗ Pre-confirming human review comments without independent validation — even senior reviewers make mistakes
- ✗ Skipping inline review comments and only reading the summary — inline comments contain the evidence

## Phase 0B: Merge Conflict Detection and Resolution

Before investing effort in review lanes, verify the PR is mergeable. A
conflicted PR cannot merge regardless of review quality.

### Step 1 — Check merge state

```bash
gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus
```

The response has two independent fields. Handle each:

**`mergeable` field** — whether GitHub can compute mergeability:
| Value | Meaning | Action |
|-------|---------|--------|
| `MERGEABLE` | No conflicts detected | Proceed — check `mergeStateStatus` below |
| `CONFLICTING` | Merge conflicts exist | Resolve before reviewing |
| `UNKNOWN` | GitHub still computing | Wait 30s, re-check |

**`mergeStateStatus` field** — overall branch state:
| Value | Action |
|-------|--------|
| `CLEAN` | All checks pass, no conflicts — proceed to Phase 1 |
| `BEHIND` | Branch behind base — note in report; non-blocking if merge queue handles it |
| `DIRTY` | Merge conflicts exist — resolve before reviewing |
| `BLOCKED` | External blocker (branch protection, failing required check) — investigate |

### Step 2 — Resolve conflicts (when CONFLICTING or DIRTY)

When the PR has merge conflicts:

1. **Determine the PR's base branch and fetch:**
   ```bash
   BASE_REF=$(gh pr view <PR_NUMBER> --json baseRefName --jq '.baseRefName')
   git fetch origin $BASE_REF
   git checkout <pr-branch>
   git merge origin/$BASE_REF --no-commit --no-ff
   git diff --name-only --diff-filter=U  # list conflicted files
   ```

2. **Assess conflict complexity:**
   - **1-3 simple conflicts** (lockfile version bumps, whitespace): Resolve directly, commit, push.
   - **4+ conflicts or semantic conflicts** (logic changes in same function): Route to coder for resolution. Do NOT guess at semantic merge resolutions.

3. **Resolve and push:**
   ```bash
   # For simple conflicts (after resolving markers):
   git add -A
   git commit -m "merge: resolve conflicts with main"
   git push origin <pr-branch>
   ```

4. **Post-resolution verification:**
   ```bash
   # Verify clean state
   gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus
   # Run affected tests
   bun test tests/unit/path/to/conflicted.test.ts --timeout 30000
   ```

5. **Document in report:** List all conflicted files, resolution approach, and whether semantic judgment was required.

### Conflict resolution anti-patterns
- ✗ Accepting "ours" or "theirs" for all conflicts without reading them
- ✗ Resolving semantic conflicts without understanding both sides
- ✗ Pushing resolution without running tests on the merged result
- ✗ Reviewing a conflicted PR without resolving first — review effort is wasted if the merge changes the code

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
4. Each agent's prompt must include: branch name, commit list (`git log origin/main..HEAD`), scope of files owned by that lane, explicit bug-hunting checklist, and a "return EVIDENCE_FOUND / SUSPICIOUS / CLEAN with file:line evidence, cap N words" instruction. Agents must not return CONFIRMED, DISPROVED, or final severity.
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

### Quantitative claim verification

PR body numerical claims (test counts, coverage percentages, assertion counts, performance benchmarks) are obligations, not proof. For each quantitative claim:

1. Extract the claim and its source (PR body, comment, commit message).
2. Verify against actual tool output or CI artifacts when available.
3. If the claim cannot be independently verified, mark the obligation `UNVERIFIABLE` with reason.
4. If the claim is disproved by evidence, create a finding linking the discrepancy.

Common patterns to verify:
- "N tests pass" → count actual test results from CI logs or test runner output
- "N% coverage" → compare against coverage report
- "No regressions" → verify against test runner failure count

---

### Phase 2: Parallel Explorer Lanes (6 lanes, launch in single message)

Launch all 6 lanes in parallel in a **single message with multiple Agent tool calls** (`run_in_background: true`). Each lane produces candidate findings with exact file:line evidence — not final verdicts.

| Lane | Focus | Lane-Specific Checklist |
|------|-------|----------------------|
| **Lane 1: Correctness** | Logic errors, null/undefined handling, race conditions, edge cases, off-by-one errors, incorrect operators | `null` checks, error path coverage, async/await correctness, loop termination, type coercion |
| **Lane 2: Security** | Injection, auth bypass, secret exposure, privilege escalation, SSRF, path traversal, unsafe deserialization | Input sanitization, authnz enforcement points, credential handling, permission boundaries |
| **Lane 3: Dependencies** | Import changes, version bumps, breaking API changes, new transitive deps, license issues | `package.json`/`requirements.txt`/Cargo.toml changes, lockfile drift, breaking API replacements |
| **Lane 4: Docs vs Intent** | PR claims vs actual code changes, undocumented behavior, misleading variable names, absent changelog entries | Claims made in PR text vs what diff actually does, side effects not mentioned |
| **Lane 5: Tests** | Coverage gaps, flaky patterns, weak assertions, test isolation violations, missing edge case tests | Assertion quality, tautology patterns (`expect(true).toBe(true)`, `expect(res).toBeDefined()` without further checks, `assertDoesNotThrow` wrapping trivial code), mock isolation, happy-path-only coverage, missing error-path tests |
| **Lane 6: Performance/Architecture** | Complexity changes, memory leaks, algorithmic regressions, coupling between modules, architectural debt | Cyclomatic complexity deltas, GC pressure, connection pool usage, shared mutable state |

**Explorer output format per finding:**
```
[CANDIDATE] | severity | category | file:line | evidence_summary | confidence: LOW/MEDIUM/HIGH
```

Explorers optimize for **recall** — over-reporting is expected. Do not interpret explorer output as final findings.

Determine the affected test suite using the `test_impact` tool (maps changed files to
consumers) or `test_runner` with `scope: 'impact'` (auto-detects impacted tests from the
diff). Avoid `scope: 'all'` or broad `scope: 'graph'` — these can trigger `scope_exceeded`
and stall the review.

Run the affected test suite:
```bash
bun test tests/unit/path/to/affected.test.ts --timeout 30000
```
This confirms candidate regressions are real (not static-analysis noise) and surfaces
behavioral issues that code review alone cannot detect. Example: PR #959 had 15 regressions
that only test execution revealed.

**If tests fail:** classify each failure as REGRESSION (introduced by the PR) or PRE_EXISTING
(on the base branch). Route regression failures to the coder for investigation alongside
other confirmed findings.

**Blocking gate:** If regression count > 0 after investigation, BLOCK approval.
The review must not proceed to final output until all PR-introduced regressions are resolved.

---

### Phase 3: Independent Reviewer Confirmation

Re-read each candidate's file:line evidence directly.

### Noise budget and universal validation

Before reviewer dispatch, the orchestrator may suppress candidates that are ALL of:
- purely stylistic without correctness, security, test, maintainability, or user-impact implications,
- exact duplicates of a candidate already queued for validation,
- explorer-stated confidence=LOW with zero structural evidence (no file:line, no code path, no invariant reference).

Every suppressed candidate must appear in the final report under "Suppressed Candidates" with the reason. Suppression without disclosure is a hard rule violation.

**All remaining candidates — regardless of severity — must be validated.** Severity alone does not determine validation eligibility; it determines routing priority. A LOW-severity candidate with file:line evidence and a specific code path gets the same reviewer attention as a HIGH-severity candidate.

Candidates not validated must be listed as UNVERIFIED with reason in the validation provenance. Do not silently drop them.

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

**Base-branch verification (mandatory):** If a finding claims behavior is "new" or "introduced by the PR", the reviewer MUST read the equivalent code on the base branch (`git show <base_ref>:<file>`) to verify it was not present before. `<base_ref>` is the merge-base SHA or base branch name — resolve it from the PR context (e.g. `git merge-base HEAD origin/main`) or the reviewer delegation prompt. A reviewer claim of "this is new" is invalid without base-branch evidence. Do not compare the new code to an idealized baseline — compare it to what actually existed on the base branch at the time of the PR.

---

### Phase 4: Critic Challenge

For every remaining CONFIRMED HIGH or CRITICAL finding, and any borderline MEDIUM finding involving security, state machines, write authority, evidence integrity, model/tool permissions, git safety, or config ratchets, apply adversarial challenge:

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
3. Each agent returns: `EVIDENCE_FOUND / SUSPICIOUS / CLEAN` with file:line evidence, capped at N words. Agents must not return CONFIRMED, DISPROVED, or final severity.
4. Main thread acts as **independent reviewer** — re-reads file:line evidence directly and classifies candidates
5. Apply critic challenge to reviewer-confirmed HIGH/CRITICAL or borderline findings
6. **Council findings are supplementary, not authoritative overrides.** Council may miss context the main thread has. Do not adopt council severities verbatim without independent validation.
7. Final synthesis merges validated council findings with main-thread-only findings, clearly labeled by source

---

## Post-Fix Re-verification

When the PR author pushes fixes after a review, perform a targeted re-verification before updating the verdict.

### Re-verification scope

Only re-verify findings the author claims to have fixed. Do not re-run the full review pipeline.

### Re-verification steps

1. For each finding the author claims fixed:
   a. Read the changed file(s) from the updated branch at the specific lines referenced in the original finding.
   b. Verify the fix addresses the root cause, not just the symptom.
   c. Check that the fix does not introduce a new issue in the same area.
2. Run CI checks on the updated branch to confirm no regressions.
3. For findings the author did not address, carry forward the original finding with unchanged status.

### Re-verification output

```
[REVERIFIED] | finding_id | FIXED / PARTIALLY_FIXED / NOT_FIXED / NEW_ISSUE | evidence | updated_severity
```

- `FIXED`: the root cause is resolved and no new issue introduced.
- `PARTIALLY_FIXED`: the root cause is partially addressed or a residual concern remains.
- `NOT_FIXED`: the root cause persists unchanged.
- `NEW_ISSUE`: the fix introduced a new problem at the same location.

Update the verdict only after re-verifying all previously blocking findings.

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
- [ ] **Permission boundary:** Does role/tool mapping prevent the operation?
- [ ] **Data lifetime:** Is the flagged state persisted, serialized, logged, or only transient?
- [ ] **Cross-platform behavior:** Does Windows/macOS/Linux path or shell behavior change the result?
- [ ] **Test environment mismatch:** Is the finding only true under a mock or fixture that cannot occur in production?

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

0. **Quality-over-speed:** Validation completeness and correctness are the sole criteria for an acceptable review. Time, token count, and agent dispatch count are irrelevant. Do not trade validation breadth or depth for speed.

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

Test execution is a mandatory prerequisite (see Phase 2): run the affected test suite in
parallel with explorer lanes to confirm candidate regressions are real.

```
[TEST EXECUTION] tests run: ___ (command used)
[TEST EXECUTION] result: ___ (N pass, N fail)
[TEST EXECUTION] regression failures (PR-introduced): ___ (count)
[TEST EXECUTION] pre-existing failures (base branch): ___ (count)
[VALIDATION] reviewer dispatched: ___ (agent type, task description)
[VALIDATION] reviewer returned: ___ (APPROVED / REJECTED / CONCERNS — copy verdict text)
[VALIDATION] critic dispatched: ___ (agent type, task description) OR "SKIPPED — no reviewer-confirmed HIGH or borderline-confidence findings"
[VALIDATION] critic returned: ___ (APPROVED / CONCERNS) OR "N/A"
[VALIDATION] noise-filter suppressed candidates: ___ (count, each with reason in final report)
[VALIDATION] all non-suppressed candidates routed to reviewer: YES/NO
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
