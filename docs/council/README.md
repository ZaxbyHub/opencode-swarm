# Work Complete Council

Opt-in, architect-driven verification gate that runs before a task is allowed
to advance to `completed`. This guide covers what the council does, how to
enable it, every config knob, and the runtime contract between the architect,
the five members, and the existing gate pipeline.

## 1. What is the Work Complete Council?

The Work Complete Council is a four-phase verification gate
(pre-declare → parallel dispatch → synthesize → act) that runs between the
coder signaling "done" and the architect calling `update_task_status` with
`completed`. Five specialized members evaluate the candidate in parallel
from isolated role-specific contexts. Synthesis is veto-aware, not vote-based:
any single `REJECT` blocks advancement. The council exists to reduce
single-context self-approval on high-risk work, surface slop patterns that a
generalist reviewer tends to rationalize away, and enforce criteria that were
pre-declared at plan time rather than invented at review time.

## 2. Enabling the council

Minimum configuration to turn it on:

```json
{
  "council": {
    "enabled": true
  }
}
```

Place the file at one of:

- `.opencode/opencode-swarm.json` — project-scoped (preferred)
- `~/.config/opencode/opencode-swarm.json` — user-scoped

With only `enabled: true` set, all other fields fall back to the defaults
documented below.

## 3. Full config reference

| Field                  | Type     | Default   | Description                                                                                                                  |
| ---------------------- | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `enabled`              | boolean  | `false`   | Master switch. When `false` the council is completely inert and no gate is enforced.                                         |
| `maxRounds`            | number   | `3`       | Integer in `[1, 10]`. Maximum REJECT-retry rounds before the architect must escalate to the user.                            |
| `parallelTimeoutMs`    | number   | `30000`   | Integer in `[5000, 120000]`. Per-member dispatch timeout.                                                                    |
| `vetoPriority`         | boolean  | `true`    | When `true`, any single REJECT blocks advancement. When `false`, a lone REJECT downgrades to CONCERNS.                       |
| `requireAllMembers`    | boolean  | `false`   | When `true`, `submit_council_verdicts` rejects with a structured error if fewer than five member verdicts are supplied. Equivalent to `minimumMembers: 5`. |
| `minimumMembers`       | number   | `3`       | Integer in `[1, 5]`. Minimum distinct council members required for quorum. Default 3. Set to 1 to disable quorum enforcement. `requireAllMembers: true` overrides this to 5 (stricter constraint wins). |
| `escalateOnMaxRounds`  | string?  | undefined | Optional webhook URL or handler name invoked on max-rounds escalation. Reserved for a follow-up; no runtime behavior today.  |

Schema is strict — unknown keys under `council` are rejected at config load.

## 4. The five council members

All members run in parallel with isolated, role-scoped context. Each returns
a `CouncilMemberVerdict` with `verdict`, `confidence`, `findings[]`,
`criteriaAssessed[]`, and `criteriaUnmet[]`.

- **critic** — logic and correctness, spec compliance, edge cases, error
  handling, logic faults.
- **reviewer** — code quality, maintainability, architectural fit, security
  surface, style.
- **sme** — domain correctness; whether the implementation is sound against
  industry practice for the problem area.
- **test_engineer** — test completeness, mutation resistance, adversarial
  coverage, whether the test suite would actually catch a regression.
- **explorer** — anti-slop specialist. Detects lazy implementations,
  hallucinated APIs, cargo-cult patterns, spec drift, and lazy abstractions.
  Surfaces findings under `slop_pattern`, `hallucinated_api`,
  `lazy_abstraction`, `cargo_cult`, `spec_drift`.

## 5. The four-phase workflow

1. **Pre-declare.** At plan time (before the coder starts work), the
   architect calls `declare_council_criteria` with the task ID and the
   acceptance criteria. Criteria are persisted to `.swarm/council/{safeId}.json`.
2. **Parallel dispatch.** After the coder signals complete, the architect
   dispatches all five members simultaneously. Each receives a role-scoped
   context plus the pre-declared criteria.
3. **Synthesize.** The architect calls
   `submit_council_verdicts(taskId, swarmId, verdicts[], roundNumber)`. The tool
   computes veto, conflict reconciliation, required-fix vs advisory
   classification, mandatory-criteria assessment, and builds a single
   `unifiedFeedbackMd` — the coder never sees contradictory instructions
   from different members.
4. **Act.** The architect interprets `overallVerdict`:
   - `APPROVE` → advance via `update_task_status`.
   - `CONCERNS` → send `unifiedFeedbackMd` to the coder as a single
     non-blocking advisory (via `pushCouncilAdvisory`), then advance.
   - `REJECT` → block. Send `unifiedFeedbackMd` to the coder as a blocking
     advisory. Retry up to `maxRounds`.
   - `roundNumber >= maxRounds && overallVerdict === 'REJECT'` → escalate
     to the user. Do not auto-advance.

## 6. Verdict semantics

- **APPROVE** — no veto, no unmet mandatory criteria. The task may advance
  immediately. `update_task_status` with `completed` passes the council gate.
- **CONCERNS** — non-veto findings exist (severity LOW or from non-veto
  members) but nothing blocks. The architect forwards the unified feedback
  and advances. `update_task_status` treats CONCERNS as a pass.
- **REJECT** — at least one member vetoed (with `vetoPriority: true`) or a
  mandatory criterion is unmet. `update_task_status` blocks the transition
  to `completed`. The architect must either satisfy `requiredFixes` and
  re-convene, or escalate when `maxRounds` is exhausted.

`update_task_status` enforces these semantics by reading
`evidence.gates.council.verdict` on the `completed` transition. A missing
gate is treated the same as REJECT: the task cannot advance without the
council having run.

## 7. Pre-declared criteria

Minimal call:

```json
{
  "taskId": "1.1",
  "criteria": [
    {"id": "C1", "description": "All tests pass with zero regressions", "mandatory": true},
    {"id": "C2", "description": "No placeholder bodies or stub implementations", "mandatory": true},
    {"id": "C3", "description": "Style guide conformance (biome clean)", "mandatory": false}
  ]
}
```

Rules:

- `id` must match `^C\d+$` (e.g. `C1`, `C12`).
- `description` is 10–500 characters.
- Between 1 and 20 criteria per declaration.
- `taskId` must be in `N.M` or `N.M.P` form.
- Calls are idempotent — re-declaring for the same `taskId` replaces the
  previous file and the response reports `replaced: true`.

Criteria are stored under `.swarm/council/{safeId}.json` and read back by
the synthesis step so each member assesses the same pre-committed contract.
`mandatory: true` criteria that appear in any member's `criteriaUnmet` block
advance.

## 8. Evidence storage

Council outcomes stamp into `.swarm/evidence/{taskId}.json` under
`gates.council`. The shape follows the existing `GateInfo` contract that
`check_gate_status` and `update_task_status` already consume
(`evidence.gates[gateName]`, not a top-level `evidence.council`):

- Standard fields — `sessionId`, `timestamp`, `agent` (always `'architect'`
  because the architect is the caller of `submit_council_verdicts`).
- Council extras — `verdict`, `vetoedBy`, `roundNumber`, `allCriteriaMet`, `quorumSize`.

Pre-existing `gates[*]` entries and top-level keys are preserved across
writes. This is the only integration point with the gate pipeline: the
council does not introduce a parallel evidence format.

### Verdict persistence and session restart

Council verdicts (`APPROVE`, `REJECT`, `CONCERNS`) persisted in `gates.council`
are automatically rehydrated into the in-memory `taskCouncilApproved` Map when
a session starts up. All verdict types are recovered — the session retains the
correct round number and verdict for ongoing retry tracking.

Tasks with an `APPROVE` verdict are rehydrated into `taskCouncilApproved` so
the council gate does not need to re-run, but the task's workflow state is
derived from the highest non-council gate in the evidence file — the task does
not fast-path to `completed` on rehydration. This avoids a bypass of the
Stage-A (pre-check) guard, since gate evidence is recorded at delegation time
rather than after Stage A passes. The task will advance to `completed` through
the normal `advanceTaskState()` flow once pre-check succeeds.

In-memory state always wins over disk state: if a newer verdict exists
in memory it supersedes any older entry on disk, preventing accidental
downgrades after a restart.

## 9. Retry protocol and `maxRounds`

- `roundNumber` is 1-indexed and tracked by the architect across retries.
- The advisory queue dedups via `council:${taskId}:${roundNumber}` so that
  repeated pushes within the same round are no-ops. Different rounds push
  distinct entries, so the coder sees the latest feedback each retry.
- On REJECT, the architect sends the blocking advisory, waits for the coder
  to address `requiredFixes`, then re-dispatches and re-convenes with
  `roundNumber + 1`.
- When `roundNumber >= maxRounds` and the verdict is still REJECT, the
  architect must escalate to the user rather than auto-advancing. This is
  a hard rule — `update_task_status` will continue to block, and
  `escalateOnMaxRounds` (if set) is reserved for a future webhook hand-off.

## 10. Minimal working example

```json
{
  "council": {
    "enabled": true,
    "maxRounds": 3,
    "vetoPriority": true,
    "requireAllMembers": false,
    "minimumMembers": 3
  }
}
```

This is the recommended starting point: enable the gate, keep default
round budget, use strict veto semantics, allow partial councils (4-of-5
still synthesize). Turn `requireAllMembers: true` only if you want to
refuse synthesis when any member context fails to produce a verdict.

## 11. Troubleshooting

- **"Task won't advance to `completed`."** Inspect
  `.swarm/evidence/{taskId}.json` under `gates.council`. If the key is
  absent, the council never ran — the architect must call `submit_council_verdicts`
  before retrying the transition. If `verdict === 'REJECT'`, resolve every
  item in `requiredFixes` and re-convene with an incremented `roundNumber`.
- **"Council tool returns `council feature is disabled`."** Verify
  `council.enabled: true` in either `.opencode/opencode-swarm.json` or
  `~/.config/opencode/opencode-swarm.json`. Config is strict; an unknown
  key alongside `enabled` will cause the entire `council` block to fail
  validation and fall back to disabled.
- **"`submit_council_verdicts` rejects with `requireAllMembers is true but only N
  of 5 verdicts provided`."** You have `requireAllMembers: true` and one
  or more members failed to return a verdict. Either set
  `requireAllMembers: false` to synthesize on partial councils, or
  investigate why the missing member(s) did not dispatch — check
  `parallelTimeoutMs` and the member-specific context for dispatch errors.

---

## General Council Mode

Distinct from the Work Complete Council documented above. The two modes are
co-existing but separate features with different purposes, different config
keys, different evidence paths, and different runtime gates.

| | Work Complete Council | General Council Mode |
|-|-|-|
| Purpose | **Verdict-based QA gate** — blocks task completion until 5 specialist agents vote APPROVE / CONCERNS / REJECT | **Advisory deliberation** — multiple models independently search the web, deliberate on disagreements, and produce a synthesized answer for the user or for spec review |
| Config key | `council.*` | `council.general.*` |
| Trigger | Architect calls `submit_council_verdicts` after coder + tests are done | User runs `/swarm council <question>`, or the `council_general_review` QA gate fires during MODE: SPECIFY |
| Members | Fixed: critic, reviewer, sme, test_engineer, explorer | Fixed three-agent set: `council_generalist` (uses reviewer model), `council_skeptic` (uses critic model), `council_domain_expert` (uses SME model) |
| Verdict | APPROVE / CONCERNS / REJECT (REJECT vetoes by default) | No verdicts — produces consensus, persisting disagreements, and a structural synthesis the architect presents directly |
| Web access | None — judges existing code/tests | The **architect** runs 1–3 `web_search` calls upfront and passes a compiled `RESEARCH CONTEXT` block to all three agents; the agents themselves have no tools |
| Evidence path | `.swarm/evidence/{taskId}.json` (verdict) + `.swarm/council/{taskId}.json` (criteria) | `.swarm/council/general/{ISO-timestamp}-{mode}.json` |
| Blocking? | Yes — REJECT blocks task completion | No — output is advisory; spec_review mode folds council input into the draft spec but does not block |

### Setup

Add a `council.general` block to `opencode-swarm.json` and customize the three council agents' models via the regular `agents.reviewer` / `agents.critic` / `agents.sme` config entries:

```json
{
  "council": {
    "general": {
      "enabled": true,
      "searchProvider": "tavily",
      "searchApiKey": "tvly-xxxxxxxx",
      "deliberate": true,
      "maxSourcesPerMember": 5
    }
  },
  "agents": {
    "reviewer": { "model": "anthropic/claude-opus-4-7" },
    "critic":   { "model": "openai/gpt-5" },
    "sme":      { "model": "google/gemini-2.5-pro" }
  }
}
```

You can also supply API keys via env vars instead of inlining them: set
`TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` in your shell. Inline `searchApiKey`
takes precedence when both are set.

> 🛈 **Deprecated fields.** Older configs may carry `members`, `presets`,
> `moderator`, and `moderatorModel` under `council.general`. These are
> retained on the strict schema for backward compatibility but are ignored
> at runtime. Setting `moderatorModel` triggers a deferred deprecation
> warning at session start.

> ⚠️ See the [strict-validation warning in configuration.md](../configuration.md#councilgeneral--general-council-mode-advisory)
> — a typo in any `council.general.*` key fails Zod validation and silently
> falls back to guardrail-only defaults.

### Usage

**Ad-hoc deliberation:**

```
/swarm council What database should we use for a write-heavy multi-tenant SaaS?
```

The architect runs 1–3 targeted `web_search` calls, compiles a `RESEARCH
CONTEXT` block, dispatches the three council agents in parallel
(`council_generalist`, `council_skeptic`, `council_domain_expert`), routes
any Round 1 disagreements back for one Round 2 reconciliation round, and
presents a synthesized final answer directly using the inline output rules
(LEAD WITH CONSENSUS, ACKNOWLEDGE DISAGREEMENT, CITE THE STRONGEST SOURCES,
BE CONCISE).

**Spec review (single-pass advisory):**

```
/swarm council --spec-review review the auth-flow spec for clarity and missing requirements
```

This is the same mode the `council_general_review` QA gate triggers
automatically when enabled. Spec review uses a single advisory pass — no
Round 2 deliberation — and feeds the council's consensus and disagreements
back into the draft spec.

### Enabling via QA gate selection

When the user enables the `council_general_review` gate during MODE: SPECIFY
or MODE: BRAINSTORM gate selection (one of the nine gates presented), MODE:
SPECIFY runs `/swarm council --spec-review` automatically on the draft spec
before the critic-gate. Consensus claims are folded directly into the spec;
persisting disagreements are marked `[NEEDS CLARIFICATION]` or routed to an
SME consultation.

### Workflow stages (in plain language)

1. **Pre-flight.** The architect verifies `council.general.enabled: true` and
   that a search API key is reachable. Stops with a clear user-facing message
   if either is missing.
2. **Research Phase.** The architect formulates 1–3 targeted `web_search`
   queries and compiles the results into a `RESEARCH CONTEXT` block. If
   search returns no results or errors, the architect notes this in the
   dispatch message and proceeds — the council agents can still reason from
   their training knowledge.
3. **Round 1 — parallel independent analysis.** The architect dispatches
   `council_generalist`, `council_skeptic`, and `council_domain_expert` in
   parallel, passing the question, round number, and the full RESEARCH
   CONTEXT block. The agents do NOT see each other's responses. Each returns
   a fenced JSON block with: response, sources cited from the RESEARCH
   CONTEXT, self-reported confidence (0.0–1.0), and areas of uncertainty.
4. **Synthesis.** The architect calls `convene_general_council` with the
   Round 1 responses. The tool detects disagreements (linguistic markers
   plus a claim-divergence heuristic) and computes confidence-weighted
   consensus (Quadratic Voting from NSED arXiv:2601.16863).
5. **Round 2 — targeted deliberation** (only when `deliberate: true`). The
   architect re-delegates only to disputing agents, passing them the
   opposing position and the same RESEARCH CONTEXT block. Each declares
   their stance: **MAINTAIN** (with evidence), **CONCEDE** (state what was
   wrong), or **NUANCE** (boundary condition that distinguishes the
   positions). Sycophantic capitulation without evidence is forbidden.
6. **Output.** The architect synthesizes the final answer directly from the
   `synthesis` returned by `convene_general_council`, applying inline output
   rules: LEAD WITH CONSENSUS (confidence-weighted, evidence breaks ties),
   ACKNOWLEDGE DISAGREEMENT HONESTLY (`experts disagree on X because…`),
   CITE THE STRONGEST SOURCES (`[title](url)` from the source list), and BE
   CONCISE. The architect MUST NOT invent claims, MUST NOT add new web
   research, and MUST NOT favor a position based on confidence alone.
   Persisting disagreements are surfaced honestly — no silent
   winner-picking.

### Evidence and audit

Every `convene_general_council` invocation writes a JSON evidence file to
`.swarm/council/general/{ISO-timestamp}-{mode}.json` containing the full
council output (Round 1 + Round 2 responses, detected disagreements,
synthesis, sources). This is intentionally separate from the Work Complete
Council's evidence path so the two systems never collide.

### Limitations

- Requires a search API key (Tavily or Brave). Without it, members fail
  with a structured "missing_api_key" error.
- Each council agent needs runtime access to its underlying model
  (reviewer / critic / SME) — the council does not validate model
  availability at config-load time.
- The architect's synthesis pass does not perform fact-checking with new
  searches. If the RESEARCH CONTEXT block is wrong or incomplete, the
  synthesis will inherit those gaps.
- Disagreement detection is heuristic (explicit linguistic markers plus a
  claim-divergence pass). Subtle disagreements that members do not flag
  explicitly may slip through.
- Prompt size grows with member count and Round 2 deliberation. Practical
  ceiling depends on each member's context window.

---

## Phase Council Mode (Phase-Level Holistic Review)

When `council_mode` is enabled in the QA gate profile, the Work Complete Council operates at the **phase level** rather than per-task. This means:

1. **Stage B always runs per-task.** `reviewer` and `test_engineer` are dispatched in parallel for every Tier 1-3 task, regardless of `council_mode`. Council never replaces Stage B.

2. **Council convenes at phase completion.** After all tasks in a phase have passed their individual Stage A + Stage B gates, the architect assembles a Phase Dossier (executive summary, task matrix, diff summary, retro evidence, dependency map) and dispatches the same 5 council members (`critic`, `reviewer`, `sme`, `test_engineer`, `explorer`) with phase-scoped prompts.

3. **Evidence-file attestation.** Council verdicts are synthesized via `synthesizePhaseCouncilAdvisory()`, which writes `.swarm/evidence/{phase}/phase-council.json`. The `phase_complete` tool reads this evidence file and validates verdict, quorum (≥3), timestamp freshness, and phase number before allowing phase completion.

4. **Verdict enforcement.** REJECT verdict blocks phase completion with required fixes. CONCERNS blocks by default (configurable via `config.council.phaseConcernsAllowComplete` — planned feature). APPROVE allows the phase to complete.

### Example Phase Council Flow

```
Phase 1 tasks all complete → Phase Dossier assembled
  → 5 council members dispatched in parallel (phase-scoped prompts)
  → Verdicts collected → synthesizePhaseCouncilAdvisory() called
  → .swarm/evidence/1/phase-council.json written
  → phase_complete reads evidence → validates verdict/quorum/timestamp
  → APPROVE → Phase 1 complete
```

### Per-Task vs Phase-Level

| Aspect | Per-Task (Legacy) | Phase-Level (Current) |
|--------|-------------------|----------------------|
| Stage B | Replaced by council | Always runs per-task |
| Council scope | Single task | Entire phase |
| Trigger | Every coder delegation | phase_complete only |
| Evidence | .swarm/evidence/{taskId}.json | .swarm/evidence/{phase}/phase-council.json |
| Review focus | Task correctness | Cross-cutting concerns |
