---
name: council
description: >
  Full execution protocol for MODE: COUNCIL -- General Council research, parallel member dispatch, disagreement handling, and synthesis.
---

# Council Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: COUNCIL

Activates when: user invokes `/swarm council <question>` (optionally with `--preset <name>` and/or `--spec-review`).

Purpose: convene a fixed three-agent multi-model General Council (generalist / skeptic / domain expert) for an advisory deliberation. The architect runs a curated web research pass upfront, dispatches the three agents in parallel with the gathered RESEARCH CONTEXT, routes any disagreements back for one targeted reconciliation round, and synthesizes the final user-facing answer directly.

This mode is ADVISORY — it does NOT block any other workflow and does NOT modify code, plans, or specs. The output is for the user (general mode) or for the spec being drafted in MODE: SPECIFY (spec_review mode, gated by `council_general_review`).

#### Pre-flight (always run first)
1. Read `council.general` config. If `council.general.enabled` is not true OR no search API key is configured (neither `council.general.searchApiKey` nor the corresponding env var `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY`), surface to the user: "General Council is not enabled. Set council.general.enabled: true and configure a search API key in opencode-swarm.json." Then STOP.

#### Research Phase (always run — before dispatching council agents)
2. Formulate 1–3 targeted `web_search` queries that best capture the information needed to answer the question. Prefer specific, keyword-focused queries over broad ones. Call `web_search` for each query. Compile all results into a RESEARCH CONTEXT block in this format:
```
RESEARCH CONTEXT
================
[1] <title> — <url>
    <snippet>

[2] <title> — <url>
    <snippet>
...
```
If `web_search` returns no results or an error (check `result.success`), note this in the dispatch message and proceed without a context block. Do not stop — the council agents can still reason from their training knowledge.

#### Round 1 — Parallel Independent Analysis
3. Dispatch `the active swarm's council_generalist agent`, `the active swarm's council_skeptic agent`, and `the active swarm's council_domain_expert agent` in PARALLEL — one message per agent, then STOP and wait for all responses. Each dispatch message must include:
   - The question
   - Round number: 1
   - The full RESEARCH CONTEXT block from step 2
   - Instruction: "Cite from the RESEARCH CONTEXT for external evidence. Your memberId and role are hardcoded in your system prompt."
Do NOT share other agents' responses at this stage.
4. Collect all three JSON responses. The `round1Responses` array will contain entries with `memberId` of `council_generalist`, `council_skeptic`, and `council_domain_expert` and `role` of `generalist`, `skeptic`, and `domain_expert` respectively — these come from the agents' JSON output, no manual construction needed.

#### Synthesis and Deliberation (when council.general.deliberate is true; default true)
5. Call `convene_general_council` with mode set from the command (`general` or `spec_review`), `question`, and the collected `round1Responses` only (omit `round2Responses`). Inspect the returned `disagreementsCount`.
6. If `disagreementsCount > 0`:
   a. For each disagreement in the tool's response, identify the disputing agents (the agents listed in the disagreement's positions, identified by memberId: `council_generalist`, `council_skeptic`, or `council_domain_expert`).
   b. Re-delegate ONLY to the disputing agents — one message per agent — passing: their Round 1 response, the disagreement topic, the opposing position(s), round number 2, and the same RESEARCH CONTEXT block.
   c. Collect the Round 2 responses.
   d. Call `convene_general_council` AGAIN with both `round1Responses` AND `round2Responses` populated.

#### Output
7. Present the final answer to the user from the `synthesis` returned by `convene_general_council`. Apply these output rules directly:
   - LEAD WITH CONSENSUS: open with the strongest consensus position. Confidence-weighted: higher-confidence claims from multiple agents rank first, but evidence quality outranks raw confidence. Never elevate a single confident voice over a well-evidenced contrary majority.
   - ACKNOWLEDGE DISAGREEMENT HONESTLY: for each persisting disagreement, write "experts disagree on X because…" and present the strongest version of each side. Do NOT pretend disagreements are resolved. Do NOT silently pick a winner.
   - CITE THE STRONGEST SOURCES: link key claims with [title](url) format from the source list in the synthesis. Pick the most reputable source per claim; do not cite duplicates.
   - BE CONCISE: a few short paragraphs plus a bulleted summary. Expand only when the question genuinely requires it.
   - HARD CONSTRAINTS: You MUST NOT invent claims not present in the council's responses. You MUST NOT add new web research. You MUST NOT favor a position based on confidence alone.
    Preface the answer with one line listing the participating models (reviewer model as generalist, critic model as skeptic, SME model as domain expert). Do NOT present raw per-member JSON.
