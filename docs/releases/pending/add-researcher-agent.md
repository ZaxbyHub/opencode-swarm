# Auto-Research Agent

## What changed

- **New `researcher` agent** (`src/agents/researcher.ts`, `src/agents/index.ts`):
  a dedicated multi-source research specialist that gathers, synthesises, and
  cites information from the web, GitHub, official docs, and academic literature.
  The agent is always registered (like SME and Explorer) and operates read-only.

- **Multi-source search strategy**: the agent follows a structured five-step
  research protocol — Decompose → Search (multi-source) → Evidence Capture →
  Triangulate → Synthesise — using official docs, Context7-compatible sources,
  GitHub code search, Exa/Grep.app-style queries, arXiv/Google Scholar, and
  community resources.

- **Tool access**: the `researcher` agent is granted `web_search`,
  `swarm_command`, `summarize_work`, `symbols`, `imports`,
  `complexity_hotspots`, `schema_drift`, and `todo_extract`. All write tools
  are disabled: `write`, `edit`, `patch`, `apply_patch`, `swarm_apply_patch`,
  `create_file`, `insert`, `replace`, `append`, `prepend`.

- **Structured output contract**: the agent always emits CONFIDENCE, SUMMARY,
  FINDINGS (with per-finding confidence and source URLs), CONTRADICTIONS,
  RECOMMENDATION, GAPS, EVIDENCE_REFS, and STALENESS_WARNINGS. Output length
  adapts to the `DEPTH` parameter (`quick` / `standard` / `deep`).

- **Search caching**: the Architect maintains `.swarm/context.md ## Research Sources` on the researcher's behalf. The researcher emits `CACHE-UPDATE` lines for the Architect to persist, and the Architect surfaces prior findings to the researcher in its dispatch context. This matches the SME agent's cache contract.

- **Security guardrails**: external content is treated as untrusted evidence.
  The agent never follows instructions found in external pages or executes
  content from search results.

- **Configuration**: `researcher` has its own model key in `DEFAULT_MODELS` and
  `DEFAULT_AGENT_CONFIGS` (defaults to `opencode/big-pickle`), customisable via
  `agents.researcher.model` in `opencode-swarm.json`.

- **Tests**: `tests/unit/agents/researcher.test.ts` validates agent name,
  description, temperature, tool restrictions, and prompt structure.

## Why

The swarm had no dedicated agent for automated multi-source research. The SME
agent provides domain expertise from training knowledge and uses web_search
as a secondary capability (see `sme.ts:34-47`); the new `researcher` agent's
entire protocol is built around web_search as the primary source, with
structured 5-step multi-source triangulation, evidence grading, and
synthesised citations. This split lets the Architect dispatch the right
specialist — SME for "I have a domain question", researcher for "I need
multi-source, cited evidence for X" — instead of asking SME to do both jobs.

## How to use

The Architect dispatches the researcher agent like any other subagent:

```
@researcher
TASK: Find the best approach for rate-limiting in a Bun HTTP server
DOMAIN: Bun, HTTP, rate limiting
DEPTH: standard
```

The researcher returns CONFIDENCE-graded findings with source URLs and a
RECOMMENDATION. The Architect can then pass that recommendation to the Coder.

No configuration is required — the researcher is enabled by default.

## Migration

No migration required. The researcher agent is a new addition; existing swarm
configs are unaffected. Existing agents and tool maps are unchanged except that
`researcher` is added to the `agents` list for `web_search`, `swarm_command`,
`summarize_work`, `symbols`, `imports`, `complexity_hotspots`, `schema_drift`,
and `todo_extract`.
