# repo_map: connect the six remaining audit actions (issue #2540)

## What

Connects or retires every `repo_map` action that no workflow surface could
reach (issue #2540, audit finding REPOGRAPH-11), and adds the ratchet that
keeps the inventory honest:

- All six audit actions are **retained and wired** to real workflow consumers
  (each reference is repo_map-contextual — invocation form or backticked on a
  repo_map line — not bare prose):
  - `symbol_search` → explorer prompt ACTIONS block (locate symbols before reading)
  - `symbol_context` and `dead_exports` → reviewer GRAPH-FIRST REVIEW line
    (definition-first verification of symbol claims; advisory review candidates)
  - `graph_explain` → critic graph-first guidance (challenge graph-relevance claims)
  - `preflight_packet` and `ontology` → architect GRAPH-FIRST EVIDENCE section
    and the swarm-plan skill (planning preflight; both `.opencode` and `.claude`
    mirrors byte-identical)
- Two additional actions the new ratchet surfaced as contextually unreferenced
  are wired alongside: `callers` → coder prompt (before changing exported
  symbols), `retrieve` → deep-dive skill (bounded mixed retrieval; both mirrors).
- New disposition registry `src/tools/repo-map-action-dispositions.ts`
  records each audit action as retained with its consumer surfaces.
- New ratchet test `tests/unit/config/repo-map-action-consumer-ratchet.test.ts`
  fails when any `VALID_ACTIONS` entry has no repo_map-contextual reference in
  `src/agents`, `.opencode/skills`, or `src/commands`, with adversarial
  self-tests proving the matcher cannot be satisfied by prose (the
  ask/build/callers/dependencies collision class) and that a synthetic
  unreferenced action is flagged.
- Runtime wiring proof `tests/unit/tools/repo-map-action-dispositions.test.ts`
  drives each retained action through the registered `repo_map` tool path on a
  built fixture graph (useful bounded result) and against an empty directory
  (typed actionable fallback).

## Why

Under CLAUDE.md directive 2 ("we never ship unwired code"), a registered tool
action that no prompt, skill, or command can reach is unwired advertised
surface. Six such actions existed after #2516 wired only the other half of the
orphaned set, and no ratchet existed to catch the next one. The repo_map tool
itself is unchanged — zero behavioral edits to `src/tools/repo-map.ts`.

## Migration

No breaking changes. The repo_map tool, its schema, handlers, and help text are
untouched; the change adds prompt/skill wiring, a data-only disposition
registry, and tests.
