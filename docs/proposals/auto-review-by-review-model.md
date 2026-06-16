# Proposal: Automatic review of execution by a dedicated review model

Status: proposal (research + design; no implementation in this document)
Date: 2026-06-12
Scope: how Claude Code and OpenAI Codex implement "a review model automatically reviews the main model's work," what opencode-swarm already has, the exact gaps, and a phased implementation design.

> Validation note: every codebase claim below was verified against source and then independently challenged by an adversarial review pass. Gaps are scoped precisely — most hold only for the **default execution path** (non-council, non-lean-turbo, non-full-auto), and the document says so explicitly where that is the case.

---

## 1. How the two reference products do it

### 1.1 Claude Code (Anthropic)

Verified against code.claude.com docs, the anthropics/claude-code repo (`plugins/code-review`), the claude-code-security-review action, and prompts extracted from the shipped CLI binary (v2.1.175).

| Mechanism | Trigger | Architecture |
| --- | --- | --- |
| `/code-review` (local skill) | manual | Reviews branch-ahead commits + uncommitted changes; effort level controls precision/recall ("lower effort returns fewer, higher-confidence findings") |
| `code-review` plugin (powers the official PR auto-review workflow) | manual or CI (`pull_request` events) | Haiku triage → Haiku CLAUDE.md discovery → Sonnet summary → **4 parallel reviewers** (2× Sonnet CLAUDE.md compliance, 2× Opus bug/security hunting) → **one parallel validation subagent per candidate finding** → score 0–100 → **filter < 80 confidence** |
| `/security-review` | manual or CI | Finder subtask → **parallel false-positive-filter subtasks per finding** (17 hard exclusion classes, 12 precedents) → validators score 1–10, **filter < 8**; finder itself drops < 0.7 confidence |
| Managed Code Review ("bughunter") | **automatic** per repo: on PR open / every push / manual `@claude review` | Multiple specialized agents in parallel on Anthropic infra; verification step filters false positives; dedup + severity ranking (Important/Nit/Pre-existing); posts a **neutral** (never-blocking) check run; `REVIEW.md` injected into every pipeline agent; 👍/👎 reactions feed a tuning loop |
| Ultrareview | manual (`/code-review ultra`) | Cloud fleet of reviewers; "every reported finding is independently reproduced and verified" |
| Stop / SubagentStop hooks | **automatic** on agent finish | Hook handlers of type `command`, `prompt` (single-turn judge with its own `model` field), or `agent` (subagent with Read/Grep/Glob); returning `{"decision":"block","reason":...}` forces the main agent to continue and address the reason |
| Advisor tool | **automatic-ish** (model-initiated) | A second, *at-least-as-capable* model (`advisorModel`) that the main model consults "before declaring a task complete"; receives the full conversation including tool calls |
| Subagents (`.claude/agents/*.md`) | automatic delegation by description ("Use proactively after code changes") | Per-agent `model:` frontmatter override; fresh context window; `CLAUDE_CODE_SUBAGENT_MODEL` global override |

Design principles: **generate-then-verify in separated contexts** (the context that invents a finding never approves it), **parallel specialized reviewers**, **numeric confidence thresholds** (80/100, 8/10, 0.7), **hard exclusion lists** for known false-positive classes, **model asymmetry by task value** (Haiku triage → Opus deep review), **advisory-not-blocking surfacing**, and **hook-enforced determinism** for the automatic trigger.

### 1.2 OpenAI Codex

Verified against the openai/codex source (Rust CLI), developers.openai.com docs, and OpenAI's alignment-blog publication on the trained reviewer.

| Mechanism | Trigger | Architecture |
| --- | --- | --- |
| `/review` / `codex review` | manual | **Fresh one-shot sub-thread with no parent history** (integration-tested); the normal system prompt is **replaced** with a review rubric; model swapped to `review_model` from `~/.codex/config.toml` (falls back to session model); approvals forced to Never; web-search/multi-agent disabled; reviewer keeps repo read + command execution; harness (not the model) computes the merge-base for `--base` |
| Review rubric output | — | **Mandatory JSON**: findings `{title, body, confidence_score: 0–1, priority: P0–P3, code_location {file, line_range}}` (location must overlap the diff) + `overall_correctness: "patch is correct"|"patch is incorrect"` + `overall_confidence_score`; tolerant parsing (strict JSON → first `{...}` substring → raw text fallback) |
| False-positive suppression | — | Rubric bans flagging pre-existing bugs, speculation ("must identify other parts of the code that are provably affected"), severity inflation, nitpicks; "if there is no finding that a person would definitely love to see and fix, prefer outputting no findings" |
| Handback | — | Findings re-enter the main thread as a synthetic `<user_action>` message; the user selects findings; the main agent fixes them. The reviewer itself never edits ("Do not generate a PR fix") |
| Guardian auto-review | **automatic, mid-execution** | `approvals_reviewer = "auto_review"`: command-approval prompts are routed to a guardian reviewer model (compact ~20k-token transcript reconstruction, strict JSON verdict, **fails closed** on timeout/parse failure, 90 s budget, consecutive-denial limits) |
| Cloud PR auto-review | **automatic** per-repo toggle, or `@codex review` | Runs in a cloud container with repo checkout; **only P0/P1 surfaced on GitHub by default**; `AGENTS.md ## Review guidelines` re-maps severities and steers focus |
| Trained reviewer model | — | gpt-5-codex / gpt-5.1-codex-max include dedicated code-review RL training. Published findings: diff-only review → high false-alarm rate; **repo access + execution improves both recall and precision**; verification exploits the generation–verification gap (falsifying a change is far cheaper than generating it); OpenAI deliberately traded recall for precision "because developers tend to ignore noisy tools" |

Design principles: **fresh isolated reviewer context with a replaced (not appended) system prompt**, **diff-scoped but repo-aware review**, **capability minimization** for the reviewer, **a dedicated review model selectable independently of the worker model**, **structured calibrated findings with diff-anchored locations**, **false-positive suppression as an explicit objective**, and **fail-closed second-model gating of risky actions**.

### 1.3 The convergent pattern

Both products converge on the same five-part shape:

1. **Separate context** — review never happens in the context that produced the work.
2. **Separate (often stronger or review-tuned) model** — configurable independently of the worker model.
3. **Deterministic, harness-constructed input** — the harness computes the diff/merge-base and builds the review prompt; the worker model cannot under-scope its own review.
4. **Structured, calibrated output** — machine-parseable findings with severity, confidence, and diff-anchored locations; numeric thresholds filter low-confidence noise; a verify pass distinct from the generate pass.
5. **Explicit feedback path** — findings are handed back to the worker (or human) through a defined channel; surfacing is advisory by default, gating is opt-in.

---

## 2. What opencode-swarm already has (verified file:line)

The plugin is *ahead* of both products on enforcement and *behind* both on calibration and harness-constructed raw-diff review — but only on the default path. Several opt-in modes already implement large parts of the pattern.

| Capability | Where | Status vs. CC/Codex |
| --- | --- | --- |
| Separate reviewer agent, read-only, temperature 0.1, three-tier review prompt, pressure immunity, severity calibration, ≤800-token output budget | `src/agents/reviewer.ts:19-305` | ✅ comparable (prompt-level FP suppression already includes "no pre-existing issues" at line 62, "only flag real issues, not theoretical" at line 258) |
| Per-agent model override: `agents.<role>.model`, `variant` (reasoning effort), `fallback_models` (max 3), `temperature` | `src/config/schema.ts:145-163` | ✅ equivalent to Codex `review_model` (per-role, more granular) |
| Different default models for coder vs reviewer | `src/config/constants.ts:273-291` | ✅ model asymmetry by default |
| Same-model coder/reviewer adversarial warning | `src/config/schema.ts:421-427` (`adversarial_detection.pairs`) | ✅ beyond CC/Codex (they only document the pairing constraint) |
| **Fail-closed reviewer gate**: coder cannot be re-delegated and tasks cannot complete without a reviewer *round*; per-task state machine `coder_delegated → reviewer_run → tests_run`. Note: the gate enforces that a reviewer ran, not that the verdict was APPROVED — verdict interpretation stays with the architect | `src/index.ts:1543-1546`, `src/hooks/delegation-gate.ts:1060-1230, 1513-1700` (violation throw at 1224-1228) | ✅ stronger than both (CC managed review is neutral/non-blocking; Codex `/review` is manual) |
| Complexity-based review routing (1 vs 2 reviewers, advisory) | `src/parallel/review-router.ts:75-117` | ✅ parallel-reviewer scaling exists |
| Harness-constructed semantic diff injected into reviewer context: AST change classes + blast radius, computed from `git show HEAD:<file>` against files **tracked from actual write-tool calls** (`modifiedFilesThisCoderTask`, guardrails), not from the architect's prose | `src/hooks/semantic-diff-injection.ts:149-172`, `src/hooks/guardrails.ts:2560-2624`, injected via `src/hooks/system-enhancer.ts:1147-1165` | ✅ substantial — the architect cannot under-scope this part of the reviewer's input; what's missing is raw diff hunks + merge-base (G3) |
| Durable review receipts with SHA-256 scope fingerprint + staleness invalidation | `src/hooks/review-receipt.ts` | ✅ storage exists — but see gap G2 for who writes them |
| Reviewer `DIRECTIVE_COMPLIANCE` verdicts parsed from Task output and durably persisted as knowledge events (with predicate execution on VIOLATED) | `src/hooks/reviewer-verdict-parser.ts:41-42, 138-149` | ⚠️ structured persistence exists for *directive* verdicts only, not findings |
| **Council mode** (replaces Stage B when enabled): N members independently judge the same work; per-member verdicts **require numeric `confidence` (0–1)** and are persisted to `.swarm/evidence/{taskId}.json`; General Council computes confidence-weighted consensus | `src/tools/convene-council.ts:44`, `src/council/types.ts:56`, `src/council/council-evidence-writer.ts:90`, `src/services/general-council-service.ts:65-98` | ✅ numeric confidence + structured persisted verdicts already exist on this opt-in path |
| **Lean-turbo phase reviewer**: harness-compiled phase review package (lane evidence, changed files, integrated diff summary) dispatched to the reviewer agent over an **ephemeral session with a replaced review-specific prompt**; fail-closed (dispatch failure or unparseable verdict → REJECTED); verdict persisted to `.swarm/evidence/{phase}/lean-turbo-reviewer.json`; hard-blocks phase advancement (`phase_reviewer: true` default) | `src/turbo/lean/reviewer.ts:266-579` (dispatch at 516), `src/config/schema.ts:1556`, `src/turbo/lean/phase-ready.ts:647-654` | ✅ ~80% of the "automatic final review" pattern already shipped — **for lean-turbo mode only** |
| Automatic second-model oversight (critic over ephemeral session, own `critic_model`, cadence triggers `on_task_completion` / `on_phase_boundary` / `every_tool_calls/turns/minutes`, fail-closed evidence persistence — an unpersisted verdict becomes BLOCKED/pause) | `src/full-auto/oversight.ts:481-554`, `src/config/schema.ts:2146-2168` | ✅ but **only inside `full_auto.enabled`** (G5) |
| Ephemeral-session LLM dispatch precedent (create → prompt → delete, abort-safe) | `src/hooks/curator-llm-factory.ts:110-203` | ✅ reusable mechanism |
| Phase-completion gates (drift, hallucination, architecture-supervisor, mutation, council, completion-verify, final-council) | `src/tools/phase-complete/gates/` | ✅ the `gates/` layer is uniformly **evidence-check-only** (no gate dispatches a model); model calls at phase boundaries exist in the `phase_complete` tool body (curator, 300 s timeout) and in lean turbo's reviewer module |
| `drift_check` QA gate (default ON): forces a per-phase `critic_drift_verifier` pass at PHASE-WRAP, hard-blocked by the drift gate | `src/agents/architect.ts:1328`, `src/tools/phase-complete/gates/drift-gate.ts` | ✅ fresh-context cumulative phase verification — spec-alignment-focused, architect-dispatched |
| Other automatic post-execution verification: incremental typecheck after each coder Task (30 s cap, advisory), slop detector, dual-pass security review (`review_passes.security_globs`), quality budget | `src/hooks/incremental-verify.ts`, `src/hooks/slop-detector.ts`, `src/config/schema.ts:402-416`, `src/quality/` | ✅ deterministic/heuristic complements to model review |

## 3. Gap analysis

All gaps below are stated for the **default execution path** (standard mode; council, lean turbo, and full-auto not enabled). Where an opt-in mode already closes a gap, that is noted — the design goal is to bring the pattern to the default path and unify the existing islands.

- **G1 — No generate→verify split for findings (all paths).** The Stage-B reviewer invents *and* judges its findings in one context. Claude Code validates **every candidate finding in a fresh parallel subagent** and filters below a numeric threshold; Codex requires per-finding `confidence_score` and trains/filters for precision. Council mode partially mitigates this (N independent judgments of the same work) but has no per-finding verification pass either; critic variants verify implementation-vs-spec, not reviewer findings. The repo's own swarm-mode contract ("Do not let the same context both invent and approve a finding") is implemented for audit workflows (deep-dive, codebase-review, pr-review modes) but not for the runtime Stage-B reviewer.
- **G2 — Default-path reviewer verdicts are not persisted as structured artifacts.** `persistReviewReceipt` is called only from `src/tools/phase-complete.ts:931-963`, `src/hooks/phase-monitor.ts:90-108`, and `src/tools/curator-analyze.ts:190-221`; gate evidence records only `{sessionId, timestamp, agent}` (`src/gate-evidence.ts:25-29`), not verdict content. The Stage-B reviewer's findings live only as Task-output text in the architect's context — no confidence, no diff-anchored findings, no receipt. Exceptions that prove the pattern is wanted: council evidence (structured, confidence-bearing), DIRECTIVE_COMPLIANCE knowledge events, and lean-turbo phase verdict files all persist structured verdicts on their respective opt-in paths.
- **G3 — No raw-diff, merge-base-anchored review input on the default path.** The harness already injects a semantic AST diff + blast radius derived from actually-written files (the architect cannot under-scope it), and the reviewer prompt's TASK/FILE/DIFF/AFFECTS fields (`src/agents/reviewer.ts:213-221`) are architect-authored on top of that. What is genuinely missing vs. Codex: the **raw diff hunks** and a **harness-computed merge base** seeded into the review. Lean turbo's review package is the closest existing analog.
- **G4 — No automatic final whole-diff review on the default path.** Lean turbo ships exactly this (harness-built package, ephemeral reviewer, fail-closed, hard gate) but only for `turbo.strategy: "lean"`. `drift_check` forces a per-phase critic pass but is spec-alignment-focused and architect-dispatched. The default path has no harness-run review of the cumulative raw git diff at phase/plan completion the way Codex cloud reviews every PR or CC managed review covers every push.
- **G5 — Second-model oversight is locked behind full-auto.** Verified: `tickAndEvaluate` returns undefined unless `config.full_auto?.enabled` (`src/full-auto/cadence.ts:141`); the oversight run can only start via `full_auto` (`src/commands/full-auto.ts:62`); the hooks are no-ops when disabled (`src/index.ts:543-544`). The cadence-triggered critic oversight is exactly the guardian/advisor pattern, but unavailable in normal interactive sessions.
- **G6 — No per-finding confidence calibration on the default path, and no confidence-threshold filtering of findings anywhere.** Council mode already requires per-*verdict* numeric confidence and computes confidence-weighted consensus. But the default Stage-B reviewer emits severity only (CRITICAL…INFO), and no path filters individual findings by confidence the way CC (≥80/100) and Codex (calibrated `confidence_score`) do.

## 4. Proposed design

Phased so each stage ships independently and respects AGENTS.md invariants. One new top-level config block, `auto_review`, owns all phases (single `min_confidence`, matching the single-block convention of `full_auto`/`council`). No key collision: `PluginConfigSchema` has no `review`/`auto_review` key today (existing siblings: `self_review`, `review_passes`, `ui_review`, `incremental_verify`).

```jsonc
"auto_review": {
  "enabled": false,                    // master switch (opt-in)
  "min_confidence": 0.7,               // finding-level filter threshold (0–1)
  "structured_findings": true,          // Phase 1
  "validate_findings": false,           // Phase 2 (flip after burn-in)
  "validation_model": null,             // null → critic model resolution
  "validation_timeout_ms": 120000,
  "final_review": {                     // Phase 3
    "on_phase_complete": true,
    "on_plan_complete": true,
    "model": null,                      // null → agents.reviewer.model resolution
    "mode": "advisory",                // "advisory" | "gate"
    "max_diff_bytes": 262144,
    "timeout_ms": 300000
  }
}
```

### Phase 1 — Structured findings + confidence (closes G2, G6 default-path)

1. **Extend `REVIEWER_PROMPT`** (`src/agents/reviewer.ts`) to emit a fenced ```json findings block modeled on Codex's schema:
   ```json
   {
     "findings": [{ "title": "...", "body": "...", "severity": "critical|high|medium|low|info",
       "confidence": 0.0, "file": "relative/path", "line_start": 0, "line_end": 0 }],
     "verdict": "APPROVED|REJECTED",
     "overall_confidence": 0.0
   }
   ```
   Two prompt sections must be amended together (adversarial finding C2): the **"Token budget ≤800 tokens"** rule (line 211) gets a carve-out — the JSON block *replaces* the prose ISSUES list rather than duplicating it — and the **"OUTPUT FORMAT (MANDATORY)"** section (line 240) is updated to include the block. The `VERDICT:`/`REUSE_RE_VERIFICATION:`/`DIRECTIVE_COMPLIANCE:` text lines stay — `reviewer-verdict-parser.ts` and the architect contract (`src/agents/architect.ts:298`) are untouched; the delegation gate never parses verdict text, so no parser collision exists.
2. **Parser**: reuse the existing tolerant fenced-JSON extraction in `src/agents/agent-output-schema.ts` (`candidateJsonBlocks`) rather than writing a new one; add a `ReviewFindingsSchema` next to `AgentOutputMemorySchema`. Must include a test proving coexistence with `extractMemoryProposalsFromAgentOutput` scanning the same Task output. Fail-open, never throws.
3. **Auto-persist receipts**: in the existing reviewer branch of `tool.execute.after` (`delegation-gate.ts` already detects reviewer Task returns), build a receipt from parsed findings, fingerprinting the `modifiedFilesThisCoderTask` diff content. **Requires a `BlockingFinding` schema change** (adversarial finding C2): `severity` is currently typed `'critical' | 'high' | 'medium'` (`src/hooks/review-receipt.ts:62`); widen to the 5-level scale (additive — existing receipts parse unchanged) or map low/info into receipt `caveats`. Non-fatal on failure (evidence is additive).
4. **Confidence filter**: findings below `auto_review.min_confidence` are recorded in the receipt but demoted to `info` in any gate-relevant interpretation — CC's 80/100 filter in the plugin's 0–1 scale.

### Phase 2 — Independent finding validation (closes G1)

1. **New critic variant** `critic_finding_validator` in `src/agents/critic.ts` (follows the existing variant pattern: read-only, temp 0.1, registered like `critic_drift_verifier`): input = one batch of HIGH/CRITICAL candidate findings + file refs; output = per-finding `CONFIRMED|DISPROVED|UNVERIFIED` with confidence and one-line evidence. Default posture DISPROVED (matches the swarm-mode reviewer contract). Registration must follow the full agent-registration checklist including multi-swarm prefixed-name tests (AGENTS.md §11).
2. **Dispatch discipline (mandatory, adversarial finding C3)**: the `tool.execute.after` chain is sequentially awaited with no overall timeout (`src/index.ts:1977`), so the validator dispatch MUST be **fire-and-forget** (`void dispatcher(...)`) with a **sessionID-keyed in-flight guard**, exactly like cadence oversight (`src/full-auto/cadence.ts:155, 194, 207`) — never an awaited 120 s call in the hook chain. Internally bounded by `AbortController` + timeout with abort-safe ephemeral-session cleanup (curator pattern). Validation outcome lands via `pendingAdvisoryMessages` on the architect's next prompt.
3. Disposition rules: a DISPROVED CRITICAL/HIGH finding downgrades the rejection pressure on the architect (prevents false-positive rejection loops — the documented CC rationale); a CONFIRMED finding hardens it. Validation never *approves* code — it only filters findings, exactly like CC's validators.

### Phase 3 — Automatic final-diff review on the default path (closes G3, G4)

**Generalize the lean-turbo engine, not green-field** (adversarial finding C1/C4). `dispatchPhaseReviewer` (`src/turbo/lean/reviewer.ts:516`) already implements ephemeral-session dispatch with a replaced review prompt, fail-closed verdict parsing, and evidence persistence. The work is:

1. **Extract the dispatch engine** from `src/turbo/lean/reviewer.ts` into a shared module (e.g. `src/review/final-review-dispatcher.ts`) consumed by both lean turbo and the new default-path trigger.
2. **Harness-constructed input**: a bounded `git -C <dir> diff <merge-base>` (array-form spawn, explicit cwd, `stdin: 'ignore'`, timeout, bounded stdout, `proc.kill()` in `finally` — invariant 3), merge base computed by the harness exactly like Codex. Diff truncated at `max_diff_bytes` with file-list fallback. Combine with the existing semantic-diff summary.
3. **Review prompt**: Codex-style rubric (introduced-in-this-diff only, anti-speculation, "prefer no findings", Phase-1 structured JSON output) — a *replaced* prompt, not the Stage-B task-review prompt.
4. **Where it runs (gate-layer contract, adversarial finding C4)**: the `gates/` layer is uniformly evidence-check-only — no gate dispatches a model. Follow the established split: the **dispatch** runs in the `phase_complete` tool body (precedent: the curator LLM call there, 300 s timeout) and **persists a receipt + evidence file**; a new thin `final-review-gate.ts` only **validates the persisted evidence** (presence, scope-hash freshness against the current diff, verdict) like every other gate.
5. **Disposition**: `advisory` (default) injects a ranked findings summary and persists the receipt — CC's "neutral check run" stance. `gate` blocks `phase_complete` on CONFIRMED ≥ HIGH findings above `min_confidence`, honoring fail-closed semantics like `oversight.ts` (a verdict that cannot be persisted is not a verdict). Standard turbo mode skips it unless `mode: "gate"`; lean turbo keeps its own phase reviewer (same engine).
6. No new user-visible tool (no invariant-11 tool surface). A manual `/swarm review` command wrapping the same engine is a natural follow-up, out of scope here.

### Phase 4 — Unlock oversight cadence outside full-auto (closes G5, optional)

Lift `full_auto.oversight` triggers into a standalone `oversight` block consumable without `full_auto.enabled` (same dispatcher, advisory-only disposition when not in full-auto). Lowest priority: Phase 3 covers the highest-value automatic checkpoint.

### Prompt upgrades (free-standing, any phase)

Port two Codex rubric rules into `REVIEWER_PROMPT`: the anti-speculation rule ("to flag an issue, identify the other parts of the code that are provably affected") and the calibration rule ("if there is no finding the author would definitely want to fix, prefer outputting no findings"). Both complement the existing anti-rubber-stamp rule (which targets the opposite failure, lazy approval).

## 5. Invariant audit of the design

- **1 (plugin init)**: nothing added to the init path; all new work runs inside tool-call/gate handlers. Every model dispatch added by Phases 2–3 sits inside paths that have **no outer timeout** (`tool.execute.after` chain, `phase_complete` body), so each dispatch carries its own `AbortController`/timeout bound and fire-and-forget semantics where the path must not stall (Phase 2).
- **3 (subprocesses)**: the only new subprocess is the Phase-3 `git diff`/`git merge-base` — array-form, explicit `-C`, `stdin: 'ignore'`, timeout, bounded stdout, `proc.kill()` in `finally`.
- **4 (.swarm containment)**: receipts and evidence stay under `.swarm/review-receipts/` and `.swarm/evidence/`; no new storage roots.
- **8 (session state)**: validator in-flight guard and auto-review state keyed by `sessionID` with eviction; ephemeral sessions deleted in `finally`.
- **9 (guardrails/retry)**: reviewer/validator model failures use the existing per-agent `fallback_models` chain; advisory mode logs non-fatally; gate mode follows the `oversight.ts` fail-closed precedent.
- **10 (chat/system msg)**: all surfacing via `pendingAdvisoryMessages` / debug-gated logger; no console noise.
- **11 (tool registration)**: no new tools in Phases 1–3; the `critic_finding_validator` agent registration follows the full checklist (export, registration, `TOOL_NAMES`/agent-map untouched or mirrored, docs, tests **including multi-swarm prefixed-name primary/subagent tests**).
- **12 (release/cache)**: each shipped phase carries a `docs/releases/pending/<slug>.md` fragment.

## 6. Sources

- code.claude.com: `/docs/en/code-review`, `/docs/en/ultrareview`, `/docs/en/hooks`, `/docs/en/sub-agents`, `/docs/en/model-config`, `/docs/en/advisor`
- github.com/anthropics/claude-code `plugins/code-review/commands/code-review.md`; github.com/anthropics/claude-code-security-review; github.com/anthropics/claude-code-action
- github.com/openai/codex: `codex-rs/prompts/templates/review/rubric.md`, `codex-rs/core/src/session/review.rs`, `codex-rs/core/src/tasks/review.rs`, `codex-rs/core/src/guardian/mod.rs`, `codex-rs/config/src/config_toml.rs`
- developers.openai.com: `/codex/cli/features`, `/codex/config-reference`, `/codex/integrations/github`; alignment.openai.com/scaling-code-verification; openai.com/index/harness-engineering
