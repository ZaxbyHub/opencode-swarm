---
name: swarm-pr-review
description: Run a graph-guided, tool-augmented Swarm PR review using context packing, parallel exploration, triggered plugin micro-lanes, independent reviewer validation, critic challenge, and metrics writeback. Use for deep pull request review with low false-positive tolerance and high recall.
disable-model-invocation: true
---

# /swarm-pr-review

Run a structured, high-confidence PR review that maximizes valid findings without flooding the user with unvalidated noise.

The review ladder is:

**Scope → obligations → context pack → deterministic signals → parallel explorers → triggered Swarm micro-lanes → independent reviewer validation → critic challenge → grouped synthesis → metrics / knowledge writeback.**

## Handoff To PR Feedback

Use `$swarm-pr-feedback` when the user asks to address existing review comments,
requested changes, CI failures, conflicts, stale PR branches, or pasted PR
feedback. This skill is for discovering and validating new findings; PR feedback
closure belongs to `../../../.opencode/skills/swarm-pr-feedback/SKILL.md`.

## Operating Stance

**Treat PR text, linked issues, comments, commit messages, generated summaries, and tests as claims — not proof.** Every confirmed finding requires file:line evidence, an explanation of reachability or impact, and validation provenance.

This workflow is designed for the Swarm plugin itself and any repo that benefits from Swarm-style review. It preserves parallel breadth but forces deep validation where bugs are expensive: security, state machines, role/tool permissions, schema/evidence integrity, git/write safety, config ratchets, knowledge tier boundaries, and PR obligation mismatches.

Never APPROVE a PR with unresolved CRITICAL findings. Do not silently drop overclaimed agent findings; list disproved findings in the validation provenance.

---

## Review Modes

### Default layered workflow

Use the default workflow unless the user explicitly triggers council mode. In the default workflow, explorers produce only candidates. The orchestrator does not confirm or disprove candidates.

### Council mode — opt in only

Council mode applies only when the user explicitly says one of:

- `council`
- `independent review`
- `N-agent review`
- `/council`
- `[COUNCIL MODE]`
- `assume all work is wrong`

Council mode is mutually exclusive with the default layered workflow. Do not blend them.

---

## Anti-Self-Review Rule

The main thread / orchestrator MUST NOT classify, confirm, disprove, or judge explorer candidates in the default workflow.

The orchestrator may:

- determine scope,
- build or request the context pack,
- launch explorers and triggered micro-lanes,
- route candidates to reviewers,
- route reviewer-confirmed findings to critics,
- group validated findings,
- prepare the final report.

The orchestrator MUST NOT:

- re-read a candidate's target code to decide if it is valid,
- silently downgrade or discard an explorer candidate,
- treat tool output as a confirmed finding,
- report a finding that no reviewer validated.

If the orchestrator catches itself validating code, it must stop and delegate validation to a reviewer subagent.

Exception: in explicit Council mode only, the main thread may act as the independent reviewer as described in the Council Mode section. Prefer a reviewer subagent when available.

---

## Scope Detection

Determine review scope using this priority:

1. explicit user-provided PR URL, PR number, commit, branch, or file scope,
2. current feature branch diff vs `origin/main`, `main`, `origin/master`, or `master`,
3. staged changes,
4. latest commit,
5. user-specified files or directories.

Record:

- base ref,
- head ref,
- commit range,
- changed files,
- deleted files,
- generated files,
- lockfiles,
- test files,
- docs/config/schema files,
- whether the working tree is dirty.

If scope cannot be determined, review the narrowest safe scope available and state the limitation.

---

# Default Review Workflow

## Phase 0: Context Pack and Review Signal Collection

Before launching explorers, build a compact `swarm-pr-review-context` in scratch or as a local artifact if file writes are allowed.

The context pack must include, when available:

```json
{
  "scope": {
    "base_ref": "...",
    "head_ref": "...",
    "commit_range": "...",
    "changed_files": [],
    "changed_hunks": [],
    "public_api_changes": [],
    "deleted_or_renamed_files": [],
    "generated_files": []
  },
  "pr_metadata": {
    "title": "...",
    "body_claims": [],
    "checkboxes": [],
    "linked_issues": [],
    "review_comments": [],
    "commit_messages": []
  },
  "obligations": [],
  "repo_graph": {
    "source": ".swarm/repo-graph.json or fallback search",
    "changed_symbols": [],
    "callers": [],
    "callees": [],
    "imports": [],
    "exports": [],
    "sibling_implementations": []
  },
  "deterministic_signals": {
    "ci": [],
    "tests": [],
    "coverage_delta": [],
    "lint_typecheck_build": [],
    "security_scanners": [],
    "dependency_audit": [],
    "secrets_scan": [],
    "mutation_testing": []
  },
  "swarm_artifacts": {
    "evidence_bundles": [],
    "knowledge_hits": [],
    "phase_state": [],
    "metrics": []
  },
  "risk_triggers": []
}
```

### Context pack rules

- Diff-only review is allowed for quick orientation, but not enough to confirm nontrivial findings.
- For every changed production file, identify at least one caller, consumer, import path, route entrypoint, or reason none exists.
- If `.swarm/repo-graph.json` exists, use it to seed impact cones.
- If no repo graph exists, build a shallow impact cone using imports, exports, symbol search, route registration, CLI registration, or test references.
- Pull in relevant `.swarm/evidence/`, `.swarm/state`, `.swarm/knowledge`, or hive/project knowledge entries when present.
- Historical knowledge may guide candidate generation but cannot confirm a finding by itself.
- Mark stale, quarantined, or cross-project knowledge as advisory until independently verified in this repo.
- **CI built-artifact checks (package-check, lockfile diff, bundle-size, etc.) compare against the merge commit, not the PR branch head. The merge commit includes base-branch changes (version bumps, lockfile updates) that may not be in the PR branch, causing false-positive drift signals. When investigating a CI failure on a built artifact, verify the finding against the actual PR branch head artifacts before reporting as PR-introduced. If the drift is only a version mismatch or a lockfile staleness that rebuilding resolves, note in the deterministics signal log that it is a branch-hygiene artifact, not a PR-introduced issue.**

---

## Phase 1: Intent Reconstruction / Obligation Extraction

Reconstruct what the PR is obligated to deliver before looking for bugs.

Use deterministic precedence, highest to lowest:

1. PR checkboxes and acceptance criteria,
2. linked issues / tickets,
3. explicit user request in the current conversation,
4. commit scopes and commit messages,
5. test names and test assertions,
6. interface diff / exported API changes,
7. changelog, README, migration, or docs edits,
8. LLM synthesis only when no higher-precedence source exists.

Output an obligation list:

```text
O-001 | source | claim | affected files/symbols | status: UNVERIFIED | evidence refs: []
```

For each obligation, record:

- source,
- exact claim,
- affected files or symbols,
- verification status: `UNVERIFIED → IN_PROGRESS → MET / PARTIALLY_MET / NOT_MET / UNVERIFIABLE`,
- linked finding ID when unmet,
- reason if unverifiable.

Tests are claims. A passing or added test does not prove the obligation unless the reviewer inspects the assertion strength and relevant code path.

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

## Phase 2: Deterministic Signal Ingestion

Ingest deterministic signals as candidate generators. They are never final findings.

Use available local artifacts first. Run safe read-only or standard project validation commands only when appropriate for the environment.

Candidate signal sources include:

- CI failures and logs,
- test failures,
- coverage delta,
- lint/typecheck/build output,
- `git diff --check`,
- dependency audit output,
- lockfile diff,
- CodeQL alerts,
- Semgrep or SAST findings,
- secrets scan findings,
- license scan findings,
- mutation testing output,
- package manager warnings,
- generated schema diffs.

Record each signal as:

```text
[TOOL_CANDIDATE] | tool | severity | file:line | claim | raw_signal_summary | confidence
```

Tool candidate rules:

- Confirm reachability before reporting.
- Confirm PR-introducedness before reporting as a PR blocker.
- Confirm that a framework, schema, middleware, caller guard, or test isolation rule does not already mitigate it.
- Do not report scanner output verbatim without reviewer validation.
- Redact secrets; never paste raw credentials into the final output.

---

## Phase 3: Parallel Base Explorer Lanes

Launch all base lanes in parallel in a single message with multiple Agent tool calls when the environment supports it (`run_in_background: true`). Use `Explore` subagents for exploration.

If the Agent tool is unavailable, simulate isolated passes. Do not let one lane's conclusions bias another lane.

Explorers optimize for recall. Over-reporting is expected. Explorers produce candidates only.

| Lane | Focus | Required checks |
|---|---|---|
| Lane 1: Correctness and edge cases | Logic errors, null/undefined handling, incorrect operators, async ordering, races, off-by-one, error paths | input domain, nullability, async/await, loop termination, exception behavior, backward compatibility |
| Lane 2: Security and trust boundaries | Injection, authz/authn bypass, SSRF, path traversal, secret exposure, unsafe deserialization, prompt injection | untrusted input sources, sanitization, credential handling, permission boundary, private network access, output escaping |
| Lane 3: Dependencies and deployment safety | Import changes, version bumps, lockfile drift, breaking APIs, package scripts, runtime assumptions | lockfile consistency, new transitive deps, Node/Bun/runtime compatibility, platform assumptions, license red flags |
| Lane 4: Docs, intent, and drift | PR claims vs implementation, docs mismatch, migration/changelog gaps, stale examples | obligation mapping, changed behavior not documented, docs promising behavior not implemented |
| Lane 5: Tests and falsifiability | Weak assertions, missing edge tests, flaky patterns, mock leakage, fixture drift | assertion strength, tautology patterns (`expect(true).toBe(true)`, `expect(res).toBeDefined()` without further checks, `assertDoesNotThrow` wrapping trivial code), negative paths, isolation, deterministic timing, cross-platform path coverage |
| Lane 6: Performance and architecture | Complexity regressions, memory leaks, over-coupling, inefficient graph scans, global mutable state | algorithmic deltas, caching, resource lifecycle, state ownership, architectural boundary violations |

### Explorer context contract

Every explorer must inspect or explicitly mark unavailable:

1. the changed hunk,
2. at least one caller, consumer, or downstream impact-cone node,
3. at least one callee, dependency, or upstream assumption,
4. at least one sibling implementation or prior pattern,
5. the nearest relevant test or missing-test location,
6. deterministic signal entries mapped to its files/symbols,
7. relevant Swarm knowledge/evidence entries, if present.
8. **whether the candidate issue is introduced by this PR or pre-existing** — check whether the specific line(s) flagged in the candidate were added or modified by this PR (using `git blame` or `git log -p <file>`). If the lines predate the PR, mark `pr_introduced: NO`. If they were added by this PR, mark `pr_introduced: YES`. If the origin cannot be determined (e.g., the issue is behavioral, not line-specific), mark `pr_introduced: UNKNOWN`. This rule also applies to micro-lane agents.

Explorer output format:

```text
[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence: LOW/MEDIUM/HIGH | pr_introduced: YES/NO/UNKNOWN
```

Explorers must not use `CONFIRMED`, `DISPROVED`, or `PRE_EXISTING` as verdict labels. However, `pr_introduced: NO` is a **factual classification of origin**, not a verdict — it records whether the flagging code was added by this PR, not whether the finding is actionable. This is permitted and distinct from the banned verdict labels.

---

## Phase 4: Triggered Swarm Plugin Micro-Lanes

After base lanes start, inspect the context pack risk triggers. Launch focused micro-lanes for triggered categories only. Do not launch irrelevant micro-lanes.

Each micro-lane receives:

- exact files and hunks in scope,
- related obligations,
- impact cone entries,
- relevant deterministic signals,
- related historical knowledge with quarantine/staleness status,
- expected invariants,
- output format as `[CANDIDATE]` only.

### Swarm plugin risk trigger map

| Trigger in diff or context pack | Launch micro-lane | Invariants to check |
|---|---|---|
| `agents`, `prompts`, `templates`, prompt interpolation, role text | Architect prompt integrity | no scope escape, no system prompt leakage, safe `{{variable}}` interpolation, untrusted text isolated from instructions |
| `council`, `verdict`, `quorum`, `veto`, synthesis | Council orchestration | quorum math correct, veto enforced, evidence not lost, dissent preserved, no explorer result treated as final |
| `guardrail`, `gate`, `delegation`, `rate limit`, approval checks | Guardrail bypass paths | gates cannot be skipped, delegation cannot bypass policy, rate limits cannot be reset by user-controlled state |
| `schema`, `evidence`, JSONL, migrations, serializers | Evidence schema drift | backward compatibility, required fields preserved, version migration safe, malformed evidence rejected |
| `knowledge`, `curator`, `hive`, `quarantine`, memory | Knowledge base contract | project vs hive tiers not confused, quarantine honored, CRUD semantics stable, stale knowledge not injected as fact |
| `phase`, `state`, `plan`, `.swarm/state`, completion markers | Phase transition validation | ordering enforced, retro requirements handled, no premature completion, rollback safe |
| `model`, `role`, `prefix`, `tool`, agent config | Model-to-role mapping | role prefix enforced, tool permissions least-privilege, unauthorized tools impossible, model fallback safe |
| `config`, defaults, ratchet, locks, policy flags | Config ratchet semantics | once-enabled gates cannot silently disable, downgrade attempts detected, lock-state integrity preserved |
| `url`, `fetch`, `http`, GitHub PR/issue parsing, package fetch | URL sanitization and external fetch | scheme allowlist, credential stripping, private IP / localhost / metadata IP blocking, redirect handling, timeout safe |
| `git`, branch, checkout, reset, worktree, `.git` | Git safety | branch detection reliable, no unsafe `reset --hard`, .git protected, path normalization cross-platform, worktree state preserved |
| `shell`, `exec`, command parser, file writes, delete/move/copy | Shell/write authority and path containment | destructive commands gated, dry-run preferred, symlink/path escape blocked, writes scoped, command injection impossible |
| `test`, `bun`, mocks, fixtures, CI matrix | Test infrastructure | `bun:test` API correct, mock isolation, cross-platform paths, no hidden dependency on test order, fixtures reset |
| `metrics`, telemetry, logs, serialized traces | Metrics and evidence privacy | no secrets in logs, evidence reproducible, privacy preserved, counts cannot be gamed, metrics schema stable |

Micro-lane output format:

```text
[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | pr_introduced: YES/NO/UNKNOWN
```

---

## Phase 5: Swarm-Native Verifier Routing

Use Swarm-native agents and artifacts when available. If exact agent names are unavailable, route the same task to the closest equivalent reviewer/critic role.

| Swarm verifier / artifact | When to use | Purpose |
|---|---|---|
| `critic_drift_verifier` | obligation-vs-code, docs-vs-code, phase/gate changes, schema/config changes | detect drift between stated behavior and actual implementation |
| `critic_hallucination_verifier` | external APIs, package claims, URLs, CLI flags, GitHub behavior, model/tool names | verify claims against source or mark as unverified |
| `curator_phase` | before exploration and after synthesis | retrieve relevant lessons; write back confirmed true positives / false positives |
| `test_engineer` | confirmed/borderline correctness, security, state, schema, or config findings | propose or run falsification probes and regression tests |
| `prm_scorer` | long or contentious reviews | score whether review trajectory is drifting toward unsupported speculation |
| `.swarm/repo-graph.json` | all nontrivial code changes | build impact cones and sibling-pattern checks |
| `.swarm/evidence/` | schema, phase, state, council, and guardrail changes | verify evidence compatibility and serialized provenance |
| `/swarm metrics` or stored metrics | after synthesis | record review quality and recurring false positives |

Verifier output is advisory until incorporated by the independent reviewer or critic.

---

## Phase 6: Independent Reviewer Confirmation

Route candidates to reviewer subagents. The reviewer must re-read the candidate's file:line evidence and relevant context pack entries directly.

### Mandatory validation coverage

Validate every candidate that is:

- CRITICAL or HIGH severity,
- security-related,
- business-logic-related,
- claim-vs-actual-related,
- cross-file or contract-sensitive,
- in a triggered Swarm plugin micro-lane,
- MEDIUM severity touching changed production code,
- a repeated LOW cluster with the same root cause,
- related to persistence, write authority, git state, model permissions, tool permissions, phase gates, evidence integrity, config ratchets, or knowledge tiers,
- likely to generate false positives without deeper context.

Candidates not validated must be listed as unverified or suppressed as non-actionable noise, with a reason. Do not silently drop them.

### Reviewer required checks

For each candidate, the reviewer must determine:

- exact file:line evidence,
- whether the issue is introduced by this PR or pre-existing,
- reachability from realistic execution paths,
- whether caller guards, schema validation, middleware, framework defaults, feature flags, or state-machine constraints mitigate it,
- whether tests cover the negative path,
- whether sibling files or docs must change together,
- whether the severity is justified,
- the smallest falsification probe that would prove or disprove it.

### Reviewer classifications

| Classification | Meaning |
|---|---|
| `CONFIRMED` | Evidence is real, reachable or structurally proven, and introduced or exposed by this PR |
| `DISPROVED` | Candidate claim is incorrect, unreachable, mitigated, or based on a misunderstanding |
| `UNVERIFIED` | Available evidence is insufficient to determine validity |
| `PRE_EXISTING` | Issue exists on the base branch and is not materially worsened by this PR |

### Evidence classifications

| Type | Definition |
|---|---|
| `STRUCTURALLY_PROVEN` | File:line evidence directly demonstrates the bug or violated invariant |
| `EXECUTION_PROVEN` | A test, trace, reproduction, or command demonstrates failure |
| `STATIC_TRACE_PROVEN` | Static analysis plus reviewed path/context demonstrates reachability |
| `PLAUSIBLE_BUT_UNVERIFIED` | Pattern suggests risk, but reachability or mitigation is unresolved |

Reviewer output format:

```text
[REVIEWED] | candidate_id | classification | evidence_type | final_severity | introduced_by_pr: YES/NO/UNKNOWN | file:line | rationale | falsification_probe | reviewer_id
```

`DISPROVED` findings must include the reason. `PRE_EXISTING` findings must include the base-branch evidence if available.

---

## Phase 7: Falsification Probe Requirement

Each confirmed nontrivial finding must include at least one falsification artifact:

- runnable failing command,
- proposed regression test,
- mutation that current tests fail to kill,
- static-analysis trace,
- minimal execution path,
- exact reason no runtime probe is available.

Nontrivial means any finding that affects correctness, security, state transitions, write authority, git safety, config, schema/evidence integrity, model/tool permissions, external fetches, persistence, or user-visible behavior.

A finding may still be reported without a runnable command if it is structurally proven, but the report must state why a runtime probe was not available.

---

## Phase 8: Critic Challenge

Route every reviewer-confirmed HIGH or CRITICAL finding to a critic. Also route borderline MEDIUM findings when they involve security, state machines, write authority, evidence integrity, model/tool permissions, git safety, or config ratchets.

The critic must challenge:

- severity inflation,
- weak or incomplete evidence,
- missing mitigating context,
- false reachability assumptions,
- framework or middleware defaults,
- schema validation gates,
- state-machine constraints,
- feature flags or dead code,
- pre-existing status,
- non-actionable or unsafe fix recommendations,
- sibling-file gaps,
- whether multiple comments should be grouped into one root cause.

Critic output format:

```text
[CRITIC] | finding_id | UPHELD / DOWNGRADED / DISPROVED / NEEDS_MORE_EVIDENCE | final_severity | reason | required_report_change
```

Refuted findings become `DISPROVED` or `ADVISORY`, depending on critic rationale. Downgrades must be listed in the final validation provenance.

---

## Runtime-Aware False-Positive Guard Checklist

Before confirming any finding, the reviewer and critic must check all that apply:

- [ ] Schema validation gate: does schema validation reject malformed input before the flagged line?
- [ ] Middleware interception: does middleware handle the request or command before the flagged path?
- [ ] Framework default mitigation: does the framework inherently prevent this class of issue?
- [ ] Caller context correctness: who invokes this code, and can untrusted input reach it?
- [ ] Execution reachability: is the path reachable, or behind a feature flag, dead branch, build-only path, or commented-out code?
- [ ] State-machine constraints: do ordering rules, locks, mutexes, phase gates, or transition guards prevent the state?
- [ ] Permission boundary: does role/tool mapping prevent the operation?
- [ ] Data lifetime: is the flagged state persisted, serialized, logged, or only transient?
- [ ] Cross-platform behavior: does Windows/macOS/Linux path or shell behavior change the result?
- [ ] Test environment mismatch: is the finding only true under a mock or fixture that cannot occur in production?

If a mitigation applies and was not accounted for, downgrade to `ADVISORY`, `UNVERIFIED`, or `DISPROVED`.

---

## Phase 9: Synthesis, Grouping, and Noise Budget

Before final output:

- group duplicate candidates by root cause,
- report one finding per root cause,
- attach all affected file:line references under that finding,
- separate ship blockers from advisory notes,
- suppress pure style/nit findings unless they indicate correctness, security, test, maintainability, or user-impact risk,
- distinguish PR-introduced from pre-existing,
- distinguish confirmed from plausible-but-unverified,
- include disproved agent/tool claims,
- keep final comments actionable.

### Finding ID format

```text
F-001 | severity | category | root cause | affected file:line refs | reviewer | critic status
```

### Suggested final grouping

1. Ship blockers,
2. Important non-blockers,
3. Test / coverage gaps,
4. Pre-existing issues,
5. Unverified plausible risks,
6. Disproved candidates / false positives,
7. Clean lane summary.

---

## Phase 10: Metrics and Knowledge Writeback

At the end of the review, record review quality metrics when Swarm metrics or local evidence storage is available.

Record:

- raw candidates by base lane,
- raw candidates by micro-lane,
- deterministic tool candidates,
- reviewer-confirmed findings,
- reviewer-disproved findings,
- reviewer-unverified findings,
- critic-upheld findings,
- critic-downgraded findings,
- critic-disproved findings,
- final reported findings,
- suppressed non-actionable candidates,
- recurring false-positive patterns,
- commands or probes used,
- token/time cost if available,
- accepted/fixed findings when known.

Knowledge writeback rules:

- Write back only validated true positives or validated false-positive patterns.
- Include file patterns, invariant, evidence, and why it was confirmed/disproved.
- Mark repo-specific lessons as project-tier unless there is strong evidence they generalize.
- Never promote quarantined or unvalidated knowledge to hive-tier.
- Never store secrets, private tokens, or raw sensitive logs.

---

## Phase 11: Post-Fix Re-verification

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

# Council Mode Workflow

Council mode is opt-in only and adversarial.

When triggered:

1. Build the same context pack as default mode.
2. Launch all council agents in a single message with multiple Agent tool calls when supported (`run_in_background: true`).
3. Each council agent assumes all work is wrong until code evidence proves otherwise.
4. Each agent hunts within its lane only.
5. Agents return evidence states only: `EVIDENCE_FOUND`, `SUSPICIOUS`, or `CLEAN`.
6. Agents must not return `CONFIRMED`, `DISPROVED`, or final severity.
7. The independent reviewer then classifies every council candidate as `CONFIRMED`, `DISPROVED`, `UNVERIFIED`, or `PRE_EXISTING`.
8. Apply critic challenge to reviewer-confirmed HIGH/CRITICAL or borderline findings.
9. Final synthesis distinguishes real blockers, real low-severity issues, accepted caveats, disproved council claims, and follow-up quality work.

Default council lanes:

- correctness and edge cases,
- security and trust boundaries,
- dependency and deployment safety,
- docs and intent-vs-actual,
- tests and falsifiability,
- performance and architecture when risk justifies it.

Council prompt requirements:

- branch and commit range,
- context pack summary,
- files owned by that lane,
- relevant impact cone,
- explicit checklist,
- strict output cap,
- `EVIDENCE_FOUND / SUSPICIOUS / CLEAN` only,
- file:line evidence required for `EVIDENCE_FOUND`.

Council findings are supplementary, not authoritative overrides. Do not adopt council severities or claims without independent validation.

---

# Merge Recommendation Table

| Verdict | Condition |
|---|---|
| `APPROVE` | zero unresolved CRITICAL findings, zero unresolved HIGH findings, all blocking obligations MET, no required validation phase failed |
| `APPROVE_WITH_NOTES` | zero unresolved CRITICAL findings, HIGH findings are downgraded/advisory only, obligations MET or explicitly non-blocking |
| `REQUEST_CHANGES` | any unresolved HIGH finding, any NOT_MET blocking obligation, multiple MEDIUM findings with the same root cause, or validation/probe evidence indicates user-impacting risk |
| `BLOCK` | any unresolved CRITICAL finding, unsafe write/git/security issue, evidence integrity break, role/tool permission bypass, or config ratchet violation that can disable required protections |

---

# Hard Rules

1. Never APPROVE with unresolved CRITICAL findings.
2. Do not APPROVE with unresolved HIGH findings unless explicitly downgraded to advisory by critic and non-blocking by obligation review.
3. Every confirmed finding must have file:line evidence and validation provenance.
4. A confirmed nontrivial finding must include a falsification probe or an explicit reason no probe is available.
5. Explorers, council agents, and deterministic tools produce candidates only.
6. The default workflow orchestrator must not confirm or disprove explorer candidates.
7. Tool output is not proof. Scanner results must be validated for reachability, PR-introducedness, and mitigation context.
8. PR text, generated summaries, tests, and comments are claims, not proof.
9. Do not invent facts not supported by the diff, repo context, tool output, or cited external source.
10. Do not silently drop disproved or downgraded claims; summarize them in validation provenance.
11. Obligation precedence is deterministic. Do not skip higher-precedence sources to fill gaps with LLM synthesis.
12. Do not leak secrets from logs, evidence bundles, config files, URLs, or scanner output.
13. Do not recommend destructive git or filesystem actions as fixes unless they are clearly scoped, safe, and necessary.
14. If subagents fail, timeout, or return malformed output, mark affected candidates `UNVERIFIED`; do not fabricate validation results.
15. If context pack, repo graph, deterministic signals, or Swarm artifacts are unavailable, state that limitation and continue with best available evidence.

---

# Pre-Synthesis Gate — Mandatory

Before writing the final output, print this checklist with filled values. Every blank field means the final output is invalid.

```text
[VALIDATION] scope selected: ___
[VALIDATION] context pack built: YES/NO — ___
[VALIDATION] obligation count: ___
[VALIDATION] repo graph / impact cone source: ___
[VALIDATION] deterministic signals ingested: ___
[VALIDATION] base explorer lanes dispatched: ___ / 6
[VALIDATION] base explorer lanes returned: ___ / 6
[VALIDATION] triggered micro-lanes: ___
[VALIDATION] Swarm verifier routing used: ___
[VALIDATION] raw candidates: ___
[VALIDATION] tool candidates: ___
[VALIDATION] reviewer dispatched: ___ (agent type, task description)
[VALIDATION] reviewer returned: ___ (APPROVED / REJECTED / CONCERNS — copy verdict text)
[VALIDATION] findings confirmed by reviewer: ___
[VALIDATION] findings rejected by reviewer as false positive: ___
[VALIDATION] findings marked PRE_EXISTING: ___
[VALIDATION] findings left UNVERIFIED: ___
[VALIDATION] findings escalated to critic: ___
[VALIDATION] critic dispatched: ___ OR "SKIPPED — no reviewer-confirmed HIGH/CRITICAL or borderline findings"
[VALIDATION] critic returned: ___ OR "N/A"
[VALIDATION] findings upheld by critic: ___
[VALIDATION] findings downgraded by critic: ___
[VALIDATION] findings disproved by critic: ___
[VALIDATION] falsification probes included: ___
[VALIDATION] grouped root-cause findings: ___
[VALIDATION] metrics / knowledge writeback: ___
```

If the reviewer returned `REJECTED` or `CONCERNS`, route the issue back to implementation context or mark the candidate invalid with reason. Do not silently downgrade a rejection.

---

# Final Output Format

Produce the final review in this order:

## PR intent

Summarize the obligations and user-visible intent.

## Implementation summary

Summarize what changed, including major files, public APIs, schemas, configs, tests, and Swarm artifacts.

## Intended vs actual mapping

| Obligation | Source | Actual evidence | Status | Linked finding |
|---|---|---|---|---|

Use `MET`, `PARTIALLY_MET`, `NOT_MET`, or `UNVERIFIABLE`.

## Validation provenance

Include:

- context pack limitations,
- explorer lanes launched and returned,
- micro-lanes triggered,
- deterministic signals ingested,
- reviewer identity / role for each finding,
- critic result for each escalated finding,
- findings DISPROVED by reviewer with reason,
- findings DOWNGRADED by critic with reason,
- findings left UNVERIFIED with reason.

If zero findings, explicitly state:

```text
No confirmed findings — all validated lanes CLEAN.
```

Then provide a lane-by-lane clean summary.

## Confirmed findings

For each finding:

```text
F-001 — Severity — Category — Root cause
Files: path:line, path:line
Status: CONFIRMED / critic status
Evidence type: STRUCTURALLY_PROVEN / EXECUTION_PROVEN / STATIC_TRACE_PROVEN
Why it matters:
Validation:
Falsification probe:
Suggested fix:
```

## Pre-existing findings

List separately from PR-introduced findings.

## Unverified but plausible risks

Only include if useful and clearly labeled as unverified.

## Test / coverage gaps

Focus on missing tests that would catch real risks, not generic coverage requests.

## Disproved candidates and false positives

List concise reasons for notable false positives from explorers, tools, council agents, or reviewers.

## Verdict

Use one of:

- `APPROVE`
- `APPROVE_WITH_NOTES`
- `REQUEST_CHANGES`
- `BLOCK`

## Merge recommendation

Explain the recommendation in one short paragraph and list required actions before merge if applicable.

---

# Reviewer Prompt Template

Use this template when dispatching reviewer subagents:

```text
You are the independent reviewer. Validate only the candidates assigned below.
Do not search for new issues except where needed to validate reachability or mitigation.
Do not trust explorer severity.

Context pack summary:
- scope: ...
- obligations: ...
- impact cone: ...
- deterministic signals: ...
- relevant Swarm artifacts / knowledge: ...

Candidates:
- ...

For each candidate, return:
[REVIEWED] | candidate_id | CONFIRMED/DISPROVED/UNVERIFIED/PRE_EXISTING | evidence_type | final_severity | introduced_by_pr | file:line | rationale | falsification_probe | reviewer_id

You must check caller context, reachability, schema/middleware/framework mitigations, state-machine constraints, test coverage, PR-introducedness, and severity.
```

---

# Critic Prompt Template

Use this template when dispatching critic subagents:

```text
You are the adversarial critic. Challenge only reviewer-confirmed findings assigned below.
Your goal is to reduce false positives, severity inflation, and non-actionable reports.

For each finding, challenge:
- whether evidence proves the claim,
- whether the path is reachable,
- whether mitigations apply,
- whether severity is inflated,
- whether it is PR-introduced,
- whether suggested fixes are safe/actionable,
- whether related files were missed,
- whether multiple findings should be grouped.

Return:
[CRITIC] | finding_id | UPHELD/DOWNGRADED/DISPROVED/NEEDS_MORE_EVIDENCE | final_severity | reason | required_report_change
```

---

# Explorer Prompt Template

Use this template when dispatching base explorer or micro-lane agents:

```text
You are an explorer. Optimize for recall, not final judgment.
Return candidates only. Do not use CONFIRMED, DISPROVED, or PRE_EXISTING.

Lane:
Scope:
Obligations:
Changed files/hunks:
Impact cone:
Relevant deterministic signals:
Relevant Swarm artifacts / knowledge:
Checklist:

You must inspect or mark unavailable:
1. changed hunk,
2. caller/consumer,
3. callee/dependency,
4. sibling implementation or prior pattern,
5. nearest test or missing-test location,
6. deterministic signals,
7. Swarm artifacts/knowledge.

Return:
[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | pr_introduced: YES/NO/UNKNOWN

`pr_introduced` is a factual classification of origin (line added/modified by this PR?), not a verdict. Check using `git blame` or `git log -p <file>` on the flagged lines. Mark `YES` if the code was added by this PR, `NO` if it predates the PR, `UNKNOWN` if origin cannot be determined.
```

Do not let speed degrade validation quality.
