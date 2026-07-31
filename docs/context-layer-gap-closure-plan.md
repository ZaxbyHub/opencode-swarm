# Context-Layer Gap Closure Plan

Status: PLANNED — no implementation in this document's authoring session.
Owner intent: close every gap identified in the 2026-07 context-layer investigation
(Graft leverage report → repo-graph deep dive → graphify assessment) in the minimum
number of coherent, independently shippable PRs.

This plan is written to be executable by a implementing agent without access to the
original investigation session. Every claim carries a file:line anchor into this
repository (verify anchors before editing — line numbers drift; symbol names are the
stable reference). Where a defect was runtime-verified during the investigation, the
repro recipe is included so the implementer can reproduce before and after.

---

## 1. Background: verified findings being closed

### 1.1 Correctness defects (runtime-verified where noted)

| ID | Finding | Anchor |
|----|---------|--------|
| A1 | **[RUNTIME-VERIFIED]** Any edge whose target is not a graph node (e.g. `import data from './x.json'` — explicit-extension imports of existing non-code files resolve as edge targets but are never scanned as nodes) makes the whole-graph validation in `updateGraphForFiles` set `validationFailed`, silently falling back to a **full workspace rebuild on every incremental update, permanently**. Warning is `OPENCODE_SWARM_DEBUG`-gated. | `src/tools/repo-graph/incremental.ts` (validation loop over `graph.edges` checking both endpoints exist); `src/tools/repo-graph/builder.ts` `resolveModuleSpecifier` (extension candidate list includes `.json`; `existsSync(resolved)` accepts any file type) |
| A2 | Incremental write-hook only reacts to `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py`; the builder scans `.rs/.go/.pyw` too, so Rust/Go/`.pyw` edits never update the graph. | `src/hooks/repo-graph-builder.ts` local `SUPPORTED_EXTENSIONS` vs `LANGUAGE_REGISTRY`-derived set in `src/tools/repo-graph/builder.ts` |
| A3 | Only plugin write tools trigger updates (`WRITE_TOOL_NAMES`, `src/config/constants.ts`). Bash edits (`sed -i`), `git checkout`/`pull`/`merge`, and user IDE edits are invisible to the graph. Deletions effectively never processed (deletes happen via Bash). | `src/hooks/repo-graph-builder.ts` `toolAfter` |
| A4 | Concurrent-save detection falls back to a full rebuild (minutes) instead of reload-and-replay. | `src/tools/repo-graph/incremental.ts` optimistic-concurrency block |
| A5 | `toolAfter` boundary-checks with `safeRealpathSync` but passes the **non-realpath'd** `absoluteFilePath` into `updateGraphForFiles`; node keys come from the walk. On case-insensitive filesystems (Windows, default macOS) or via symlink aliases this can silently duplicate nodes / strand stale ones. | `src/hooks/repo-graph-builder.ts` (`_updateGraphForFiles(workspaceRoot, [absoluteFilePath])`) |
| A7 | Walk truncation (10k-file cap / 5s budget, `builder.ts` `DEFAULT_WALK_FILE_CAP` / `DEFAULT_WALK_BUDGET_MS`) is only a debug log. `RepoGraphDiagnostics` has no truncation field; `graph_health` cannot report an incomplete graph. Windows machines (Defender-slowed walks) truncate first. | `src/tools/repo-graph/types.ts` `RepoGraphDiagnostics`; `src/tools/repo-graph/query.ts` `getGraphHealth` |
| A8 | `boundaryForModule` hardcodes this repo's own layout (`src/tools/repo-graph`, `packages/`, `crates/`), degrading ontology boundaries on user repos. | `src/tools/repo-graph/ontology.ts` `boundaryForModule` |
| A6 | `exclude_dirs` matching is case-sensitive on case-insensitive filesystems. **WITHDRAWN from code scope** (documented behavior per the schema JSDoc); PR1's release fragment adds a docs note only. Listed here so the ID sequence has no silent hole. | `src/config/schema.ts` `RepoGraphConfigSchema` JSDoc |

Runtime repro for A1 (reproduce before fixing; convert into the regression test):

```
mkdir -p /tmp/rg-sandbox/src
printf '{ "a": 1 }' > /tmp/rg-sandbox/src/data.json
cat > /tmp/rg-sandbox/src/main.ts <<'TS'
import data from './data.json';
import { helper } from './helper';
export function main(): number { return helper() + (data as { a: number }).a; }
TS
printf 'export function helper(): number { return 41; }\n' > /tmp/rg-sandbox/src/helper.ts
# build graph, save, then updateGraphForFiles([…/helper.ts]) with OPENCODE_SWARM_DEBUG=1
# BEFORE FIX: logs "Incremental update failed, falling back to full rebuild"
# AFTER FIX: no fallback; only helper.ts rescanned
```

### 1.2 Freshness & build-economics defects

| ID | Finding | Anchor |
|----|---------|--------|
| B1 | **[MEASURED]** Session-start init does an unconditional from-scratch full build — measured ~57 ms/file → **~158 s on this 2,787-file repo** — never loading the previous graph. Runs exactly when lanes start dispatching. | `src/hooks/repo-graph-builder.ts` `doInit`; queued at `src/index.ts` (post-resolution task with 30s watchdog) |
| B2 | `isGraphFresh` is a pure 5-minute wall-clock TTL on `metadata.generatedAt`. False-stale after 5 idle minutes (agents nudged toward minutes-long rebuild); false-fresh within 5 minutes of git/Bash/IDE changes. | `src/tools/repo-graph/query.ts` `isGraphFresh` |
| B3 | `graph_health`'s `getStaleFiles` stats only files that are already nodes: newly added files are invisible; deleted files skipped. | `src/tools/repo-graph/query.ts` `getStaleFiles` |
| B4 | No `repo_graph.enabled` off-switch; heavy work cannot be disabled. Config only has `exclude_dirs`. | `src/config/schema.ts` `RepoGraphConfigSchema` |
| B5 | The hook-injection read path (`getCachedGraph` in `repo-graph-injection.ts`) serves arbitrarily old graphs with no staleness signal at all. | `src/hooks/repo-graph-injection.ts` |

### 1.3 Delivery gaps (why "the graph doesn't feel valuable")

| ID | Finding | Anchor |
|----|---------|--------|
| C1 | Zero agent prompts mention `repo_map`. Explorer prompt mandates blind rediscovery ("Scan structure (tree, ls, glob) / Read key files / Search patterns"). | `src/agents/explorer.ts` ACTIONS/ANALYSIS blocks; grep `repo_map` over `src/agents/*.ts` = 0 hits |
| C2 | Lane dispatch prompt assembly is pure concatenation (`common_prompt + '\n\n' + lane.prompt`); no structural orientation reaches lanes. | `src/tools/dispatch-lanes.ts` (`COMMON_PROMPT_SEPARATOR` assembly) |
| C3 | deep-dive skill Step 1 runs `repo_map action="build"` even though init already built the graph — re-paying the full build. | `.opencode/skills/deep-dive/SKILL.md` (and `.claude` mirror) |
| C4 | `context_pack` returns pointer spans with **no source text**, and only spans for **exported** symbols (`exportRanges`), silently dropping internal helpers reached by the BFS. | `src/tools/repo-graph/query.ts` `getContextPack` |
| C5 | No zero-cost ask/orient query: nothing ranks entry points for a natural-language question (Graft: BM25-ish + personalized PageRank + RRF; LocAgent-validated direction). | absent |
| C6 | Push-injection exists only for coder (first declared-scope file only) and reviewer, gated on `declaredCoderScope`; no gating policy (strength floor / novelty dedupe) exists for any broader push. | `src/hooks/system-enhancer.ts` (coder/reviewer branches); `src/hooks/repo-graph-injection.ts` |
| C7 | `collect_lane_results` re-delivery dedup (`deliveredLaneOutputs`) is in-memory only and falls open; named in-code as "the dominant controller-context driver behind PR-review compaction loops". | `src/tools/dispatch-lanes.ts` (comment near the `deliveredLaneOutputs` Set) |

### 1.4 Memory-loop gaps (graphify-informed)

| ID | Finding | Anchor |
|----|---------|--------|
| D1 | No per-query/task outcome capture: nothing records whether a recalled memory / graph answer was `useful` / `dead_end` / `corrected`, so the store cannot learn from use. Swarm memory already has Q-learning, decay, scoring, consolidation — the capture step is what's missing. | `src/memory/` (q-learning.ts, scoring.ts, decay.ts, consolidation.ts); `swarm_memory_propose` |
| D2 | No session-start lessons artifact: knowledge is injected on delegation, but nothing renders a deterministic "preferred sources / known dead ends / corrections" digest at session start (graphify `reflect` → `LESSONS.md` pattern). | `src/hooks/knowledge-injector.ts`; `src/memory/injector.ts` |
| D3 | Memory entries are not anchored to code structure: no pruning when the referenced file/symbol disappears, no grouping by subsystem. | `src/memory/` schema |

### 1.5 Measurement gaps

| ID | Finding | Anchor |
|----|---------|--------|
| E1 | Cost telemetry exists (per-agent tokens/cost, cache columns) but nothing attributes **savings** to a context source, so no injected block or graph answer can prove ROI. | `src/services/cost-accounting.ts`; `src/commands/costs.ts` |
| E2 | No A/B harness compares context variants (blind vs graph-push vs graph-pull) under the existing `--max-cost-usd` CI gate; external claims (Graft 42–46%, graphify n=6 code suite) are unverifiable and must not be assumed. | `src/commands/benchmark.ts` |

---

## 2. State-of-the-art findings that shaped this plan

Researched 2026-07-31. Full citations at the end of this section.

1. **Graph-guided localization is validated far beyond vendor claims.** LocAgent (ACL 2025)
   parses codebases into directed heterogeneous graphs (files/classes/functions;
   contain/import/invoke/inherit edges) with a sparse hierarchical index, and reaches
   ~92% file-level localization accuracy on SWE-Bench-Lite with a fine-tuned 32B model at
   ~86% lower cost than proprietary-model baselines. Aider's repo-map (tree-sitter +
   PageRank ranking of symbols, serialized compactly into the prompt) is the most-copied
   production pattern. Both validate PR3's ask/ranking design over our existing graph.
2. **Graph-first answering trades a little quality for a lot of cost — design for that.**
   The Codebase-Memory study (arXiv 2603.27277; tree-sitter KG over MCP, 66 languages)
   measured 10× fewer tokens and 2.1× fewer tool calls vs a file-exploration agent, but
   answer quality 0.83 vs 0.92 — graph-native queries (hub detection, caller ranking)
   matched or beat the explorer, open-ended ones did not. Consequence for us: graph
   output is **orientation** (where to look, what depends on what), never a substitute
   for reading the located code. Agent-prompt wording in PR4 must encode this split.
3. **Curated per-subagent context beats both extremes.** AOrchestra ablations: subagents
   with *no* orchestrator-curated context fail on missing execution traces; subagents
   inheriting *full* context degrade from irrelevant information. Anthropic's production
   multi-agent research system uses orchestrator-owned context with isolated workers.
   Consequence: PR4 pushes a *small, bounded, relevance-gated* orientation block into
   lanes — not the whole graph, not nothing.
4. **Outcome-scored, time-decayed memory is the production pattern.** Zep/Graphiti
   (temporal knowledge graphs; +15pts LongMemEval over flat vector memory), Letta, and
   graphify's deterministic reflect loop (signed time-decayed outcome scores, half-life
   ~30 days, promotion only after ≥2 corroborations, lessons pruned when their anchor
   node disappears) all converge on: capture outcomes per use, decay them, corroborate
   before trusting, anchor to entities. Swarm memory already has decay + Q-values;
   PR5 adds the missing capture step and structural anchoring.
5. **Cache-stable prefix ordering is a hard constraint on injection design.** Prompt-cache
   literature and the Claude prompt-caching docs agree: order content most-to-least
   stable (tools → system → reference/orientation → history → live task); any
   nondeterministic content (timestamps, per-call novelty) invalidates everything after
   it. Consequence: PR4's lane orientation block must be **deterministic for a given
   graph state** and placed in `common_prompt` (shared prefix), with per-lane novelty
   only in the per-lane suffix.

Sources: [LocAgent (GitHub)](https://github.com/gersteinlab/LocAgent) · [LocAgent paper](https://aclanthology.org/2025.acl-long.426.pdf) ·
[Codebase-Memory paper](https://arxiv.org/pdf/2603.27277) · [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) ·
[Aider deep-dive](https://www.digitalapplied.com/blog/aider-deep-dive-cli-agentic-coding-tutorial-2026) · [Code-intelligence tool comparison](https://rywalker.com/research/code-intelligence-tools) ·
[Anthropic multi-agent architecture](https://theaiengineer.substack.com/p/how-anthropic-built-multi-agent-deep) · [AOrchestra](https://arxiv.org/pdf/2602.03786) ·
[Agent-memory comparison 2026](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/) · [Zep/Graphiti temporal KG results](https://vectorize.io/articles/best-ai-agent-memory-systems) ·
[Prompt-caching agent economics](https://www.digitalapplied.com/blog/prompt-caching-economics-cache-first-agent-architecture-2026) · [Claude prompt-caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ·
[Don't Break the Cache](https://arxiv.org/pdf/2601.06007)

---

## 3. PR sequence

Tracking issues (each is self-contained for an implementing agent; this document is the
long-form reference they cite):

| PR | Issue | Scope |
|----|-------|-------|
| PR1 | [#1985](https://github.com/ZaxbyHub/opencode-swarm/issues/1985) | repo-graph lifecycle correctness (A1, A2, A4, A5, A7, A8) |
| PR2 | [#1986](https://github.com/ZaxbyHub/opencode-swarm/issues/1986) | content-based freshness + persist-and-refresh (B1–B5, A3) |
| PR3 | [#1987](https://github.com/ZaxbyHub/opencode-swarm/issues/1987) | ask/orient action + context_pack upgrades (C4, C5) |
| PR4 | [#1988](https://github.com/ZaxbyHub/opencode-swarm/issues/1988) | delivery wiring: prompts, lanes, skills (C1, C2, C3, C6, C7) |
| PR5 | [#1989](https://github.com/ZaxbyHub/opencode-swarm/issues/1989) | structure-anchored memory outcome loop (D1, D2, D3) |
| PR6 | [#1990](https://github.com/ZaxbyHub/opencode-swarm/issues/1990) | savings attribution + A/B benchmark (E1, E2) |


Six PRs. This is the minimum that keeps every change fully wired and tested inside its
own PR (AGENTS.md invariant: no unwired code, no untested branches) while keeping each
diff reviewable. Dependencies are strict where marked.

```
PR1 (correctness)  ──►  PR2 (freshness/economics)  ──►  PR4 (delivery wiring)
                              │                              ▲
                              ├──►  PR3 (ask/orient) ────────┘
                              └──►  PR5 (memory loop)
PR6 (measurement) — after PR4 (needs something to measure); instrumentation seams may land in PR2–PR5 behind no-op defaults
```

Explicit couplings the ordering encodes (do not reorder around them): PR4 §7.3
rewrites the deep-dive skill to trust `graph_health` — that is only sound because PR2
§5.3 rewires `getGraphHealth.fresh`/`staleFiles` from the deprecated 5-minute TTL to
probe data. PR6's blind variant toggles `repo_graph.enabled`, which PR2 introduces.

Explicitly deferred (documented decision, not silently dropped): LLM-synthesized prose
concept nodes (Graft Tier-2 / graphify semantic-pass analogue). It is an enhancement,
not a gap; it adds an LLM cost model and cache design of its own; revisit only after
PR6 produces baseline numbers that show the deterministic layer's ceiling.

Global rules for every PR below (repeat-checked in each PR's checklist):

- **G1** No graph construction/repair on the plugin init path beyond the existing
  post-resolution queue mechanism (AGENTS.md invariant 1; #704).
- **G2** Node-ESM-loadable bundle; no `bun:`-only APIs outside `src/utils/bun-compat.ts`
  (invariant 2).
- **G3** All runtime state stays under project-root `.swarm/` via `ctx.directory`
  (invariant 4); no new `process.cwd()` callers.
- **G4** Any new/changed tool follows the 5-point registration contract: export from
  `src/tools/index.ts` → plugin `tool:{}` block in `src/index.ts` → `TOOL_NAMES`
  (`src/tools/tool-names.ts`) → `AGENT_TOOL_MAP` (`src/tools/tool-metadata.ts`) →
  help/docs + tests. CI: `bun run drift:check`, `scripts/check-tool-registration.ts`.
- **G5** System-message injections compose before the single-system-message collapse in
  `src/index.ts` (invariant 10) and respect `src/hooks/context-budget.ts` ceilings.
- **G6** Skill edits follow the editing-skills contract: `.opencode` and `.claude` trees
  stay byte-identical where mirrored; update `src/config/skill-mirrors.ts`
  classifications; run `bun run drift:check`.
- **G7** Test files stay under the 500-line FR-006 cap (`scripts/check-test-file-cap.sh`);
  split per the test-file-split protocol.
- **G8** Every PR ships a release-note fragment under `docs/releases/pending/` following
  the existing naming pattern (`<issue-or-slug>-<topic>.md`).
- **G9** New config keys are optional with safe defaults (existing behavior preserved
  unless the key is set), documented in the config schema JSDoc, and covered by a
  schema test under `tests/unit/config/`.
- **G10** Windows/macOS/Linux: no new native dependencies; all path handling through
  `normalizeGraphPath`/`path` APIs; any new subprocess use follows invariant 3 (none is
  planned in this document).

---

## 4. PR1 — repo-graph lifecycle correctness

**Closes:** A1, A2, A4, A5, A7, A8. (A3 is closed structurally by PR2's probe.)
**Depends on:** nothing. **Blocks:** PR2.

### 4.1 Fix A1 — dangling-edge targets must not fail incremental validation

`src/tools/repo-graph/builder.ts`:

1. In both build loops (sync `buildWorkspaceGraph`, async `buildWorkspaceGraphAsync`)
   and in `scanFile`/`scanFileAsync` edge emission: when the resolved target's
   extension is not in the supported-extension set, still emit the edge but tag it —
   add optional field `targetKind?: 'node' | 'asset'` to `GraphEdge`
   (`src/tools/repo-graph/types.ts`), set `'asset'` for non-scannable targets.
   Schema: bump `GRAPH_SCHEMA_VERSION` to `1.3.0`; field optional so older graphs load
   (follow the existing 1.1.0/1.2.0 JSDoc pattern documenting the gate).
2. Derive one exported helper `isScannableSourcePath(p: string): boolean` from the same
   `LANGUAGE_REGISTRY`-based set the walker uses, and use it in both places (also fixes
   drift risk A2 shares).

`src/tools/repo-graph/incremental.ts`:

3. Validation loop: an edge whose `targetKind === 'asset'` (or, for pre-1.3.0 graphs,
   whose target path fails `isScannableSourcePath`) requires only the **source** node to
   exist. Only edges between two scannable files require both endpoints.
4. On `validationFailed`, log the **specific** offending edge (source, target, reason)
   before falling back — with `logger.warn`, plus increment a new counter in the graph
   `diagnostics` (see 4.4) so `graph_health` can surface repeated fallbacks.

Queries: `getImporters`/`getDependencies`/`getBlastRadius` operate on the reverse/forward
indexes built from edges; asset targets have no node and therefore already do not appear
as importers. Required behavior (single answer — do not arbitrate): **asset targets must
be excluded from `key_files` in-degree ranking and from importer/dependent lists**; add
one focused test pinning exactly that.

### 4.2 Fix A2 — one extension source of truth for the write hook

`src/hooks/repo-graph-builder.ts`: delete the local `SUPPORTED_EXTENSIONS` array;
import and use `isScannableSourcePath` (4.1.2). This adds `.rs`, `.go`, `.pyw`
automatically and prevents future drift.

### 4.3 Fix A4 — reload-and-replay instead of full rebuild on concurrent save

`src/tools/repo-graph/incremental.ts`: first **extract the existing per-file update
loop (the `for (const rawFilePath of filePaths)` body plus the validation/prune passes)
into a reusable internal function** `applyFileUpdates(graph, filePaths, absoluteRoot):
{ validationFailed: boolean }` — the normal path and the replay path below both call it.
Then, in the optimistic-concurrency branch (on-disk mtime differs from
`getCachedMtime`), instead of full rebuild:
`clearCache(...)` → `loadGraph(...)` (fresh copy) → `applyFileUpdates(freshGraph,
filePaths, ...)` → save. Guard with a single retry: if the mtime moved again during
replay, fall back to the existing full rebuild (bounded, never loops). Preserve the
existing log line for the terminal fallback only.

### 4.4 Fix A7 — surface truncation and fallback counts in diagnostics

`src/tools/repo-graph/types.ts`: add to `RepoGraphDiagnostics`:
`walkTruncated?: boolean; walkTruncationReason?: 'budget' | 'cap';
incrementalFallbacks?: number;` (all optional — additive, no schema gate needed per the
existing "diagnostics are additive" doc note).
`builder.ts`: populate from `ScanStats`/`WalkContext.abortReason` in both builders.
`query.ts` `getGraphHealth`: report them with explicit notes
("Graph is INCOMPLETE: walk hit the N-file/N-ms budget — results may be missing files.").
`repo-map.ts`: `build` action response includes `truncated: boolean`.

### 4.5 Fix A5 — realpath consistency for incremental keys

`src/hooks/repo-graph-builder.ts` `toolAfter`: pass `realFilePath` (already computed)
into `_updateGraphForFiles` instead of `absoluteFilePath`. Add a regression test with a
symlinked file path asserting node count does not grow on update-through-symlink
(POSIX-only test; skip on `process.platform === 'win32'` with a comment).

### 4.6 Fix A8 — genericize ontology boundaries

`src/tools/repo-graph/ontology.ts` `boundaryForModule`: remove the hardcoded
`src/tools/repo-graph` special case. Generic rule: boundary = first two path segments
when the first segment is one of `packages|crates|apps|libs|services` (workspace-style
layouts) or when a package-manifest marker (`package.json`, `Cargo.toml`,
`pyproject.toml`, `go.mod`) exists in that subdirectory of the workspace. Mechanics
(be precise — the current walkers never see manifests because they are not scannable
extensions): during directory enumeration in `walkSyncInto`/`findSourceFilesAsync`
(`builder.ts`), record directory-relative paths whose entries include one of the four
manifest basenames into a `Set<string>` on the walk context; the builders pass a
`hasManifest(relDir: string) => boolean` closure over that set into
`extractFileOntology` via a new optional field on `ExtractFileOntologyInput`
(`ontology.ts`). `boundaryForModule` is private — the public seam is
`extractFileOntology`'s input type, and the barrel re-export of that type in
`src/tools/repo-graph.ts` must be updated in the same commit. Ontology stays pure
(no fs I/O). Otherwise: first segment (or `src/<second>` for `src/` layouts). Pin
current outputs for this repo in a snapshot test so the refactor is provably
behavior-preserving here except for the removed special case.

### 4.7 Tests & acceptance

New/updated tests (respect G7; split files as needed):

- `tests/unit/tools/repo-graph-incremental-assets.test.ts`: the §1.1 A1 repro as a
  regression test — asset import present; `updateGraphForFiles` must **not** log the
  fallback and must rescan only the named file (assert via DI seam call counts on
  `buildWorkspaceGraphAsync`).
- Update `tests/unit/tools/repo-graph-incremental.test.ts`: concurrent-save replay path
  (mock mtime shift → assert reload+replay, no full rebuild; double-shift → one full
  rebuild).
- `tests/unit/hooks/repo-graph-builder.test.ts`: `.rs`/`.go`/`.pyw` writes trigger
  updates; symlink realpath case.
- `tests/unit/tools/repo-graph-health.test.ts`: truncation + fallback counters surface.
- Ontology snapshot test per 4.6.

Acceptance: A1 repro green; full test suite green; `bun run drift:check` green;
release-note fragment `docs/releases/pending/<n>-repo-graph-incremental-correctness.md`.

---

## 5. PR2 — content-based freshness and persist-and-refresh

**Closes:** B1, B2, B3, B4, B5, A3. **Depends on:** PR1 (incremental must actually be
incremental before the refresh path can rely on it). **Blocks:** PR3 usefulness, PR4.

### 5.1 New module: `src/tools/repo-graph/freshness.ts`

Graft-pattern stat probe (design source: Graft v0.8.2 `src/graph/fingerprint.ts` /
`refresh.ts` — pattern only, no code reuse):

```ts
export interface FreshnessProbe {
  state: 'clean' | 'drifted' | 'no-fingerprint' | 'inconclusive';
  changed: string[];   // absolute paths: mtime/size mismatch or new file
  removed: string[];   // fingerprinted paths no longer on disk — ONLY meaningful when the walk completed
  truncated: boolean;  // the probe walk hit its budget/cap before finishing
  probedFiles: number;
  elapsedMs: number;
}
export async function probeFreshness(workspaceRoot: string, opts?): Promise<FreshnessProbe>
export async function writeFingerprint(workspaceRoot: string, graph: RepoGraph): Promise<void>
```

**Truncation safety (MANDATORY — a truncated probe must never drive deletions).** The
probe walk uses the same budget/cap options as the builders; a file the walk never
reached is indistinguishable from a deleted file. Therefore: if the walk aborts on
budget or cap, the probe returns `state: 'inconclusive'` with `removed: []` (and
`changed` limited to positively-observed mismatches). Consumers treat `inconclusive`
exactly like `clean` for answering queries (serve the existing graph, flag
`stale: unknown`) and never trigger deletions or refreshes from it. Additionally,
every path in `removed` must be re-checked with a direct `stat` immediately before any
node deletion (belt-and-braces against races). Without this rule, a Defender-slowed
Windows walk would mass-delete nodes at init — this is the highest-risk regression the
naive implementation invites.

- Fingerprint sidecar `.swarm/repo-graph.fingerprint.json`:
  `{ schema_version, extractorStamp, files: { [relPath]: { size, mtimeMs } } }`.
- `extractorStamp`: content hash of the extractor implementation — hash the **package
  version string plus `GRAPH_SCHEMA_VERSION`** (not source files: the plugin ships
  bundled/minified, so hashing module text is unstable; version+schema is the honest
  proxy here). Stamp mismatch ⇒ treat as `no-fingerprint` (full rebuild).
- Probe = one bounded async walk (reuse `findSourceFilesAsync` walker options — same
  skip dirs, same caps, yielding) collecting `(relPath,size,mtimeMs)`; compare to the
  sidecar. New files (on disk, not in fingerprint) → `changed`. Missing (only when the
  walk completed) → `removed`. Honest cost statement: this is a **readdir+stat
  directory walk**, not a stat-of-known-files pass — cheap (no reads, no parsing;
  target well under 1 s on this repo) but bounded by the same walk budget as builds,
  hence the truncation rule above.
- Never throws (fail-open to `no-fingerprint`); never touches an LLM; no locks needed
  (writers already serialize through `saveGraph`'s atomic rename + the incremental
  mtime check from PR1/4.3).
- **Probe result cache** shared by all read-path consumers: a module-scope
  `Map<directory, { probe, at }>` (bounded 16 entries, LRU), TTL 30 s — keyed
  per-directory so multi-workspace hosts are correct (never a single-slot global).
  `repo-map.ts` query actions and `repo-graph-injection.ts` both read through this
  cache; a fresh probe runs at most once per directory per 30 s.

### 5.2 Session-start becomes probe-and-refresh

`src/hooks/repo-graph-builder.ts` `doInit`:

```
graph = loadGraph(root)                    // cached/validated, from prior session
if (!graph or probe.state === 'no-fingerprint'): full buildWorkspaceGraphAsync (current behavior)
else if probe.state === 'clean' or 'inconclusive': done (log state; inconclusive keeps graph AS-IS, no deletions)
else if (changed.length + removed.length) > max(refresh_cap * 4, nodeCount * 0.4):
    full buildWorkspaceGraphAsync            // cutover: per-file rescan beyond this exceeds rebuild cost
else: updateGraphForFiles(root, [...changed, ...removed])   // PR1 makes this truly incremental
then: writeFingerprint(root, graph)
```

Still runs on the post-resolution queue (G1 unchanged). `saveGraph` callers
(`incremental.ts`, `repo-map.ts` build action) also `writeFingerprint` after save so the
sidecar always matches the persisted graph. Expected effect: session start drops from
~158 s to sub-second on an unchanged repo; a `git pull` touching 30 files costs ~30
file-rescans. This also closes A3: out-of-band edits (git/Bash/IDE) are caught by the
next probe.

### 5.3 Read-path freshness: replace the TTL

`src/tools/repo-graph/query.ts`:

- **Complete `isGraphFresh` caller audit (do this first; there are exactly three
  surfaces today):** (1) `repo-map.ts` query actions — handled below; (2)
  `getGraphHealth` in `query.ts`, whose `fresh` field currently reports the 5-minute
  TTL — **rewire it to probe data in this PR**: `fresh = probe.state === 'clean'`,
  plus a `probeState` field, with `staleFiles` derived from `changed ∪ removed`
  (closes B3 here, and PR4's deep-dive rewrite depends on this field being
  probe-backed); (3) the public barrel re-export in `src/tools/repo-graph.ts` — keep
  the export, mark `@deprecated` in JSDoc, retain TTL semantics for any external
  caller, but no in-repo caller may remain on it (add a grep-based test or lint note).
- `repo-map.ts`: for query actions, read the probe through the 30 s per-directory
  cache (§5.1).
  Response `stale` field becomes `{ stale: boolean, changedFiles: number }` derived from
  the probe. When `changed.length > 0 && changed.length <= refresh_cap` (config, default
  50), auto-refresh via `updateGraphForFiles` before answering and report
  `refreshedFiles: n` — the "builds are explicit so the agent sees the cost" comment
  no longer applies when refresh is bounded and reported. Above the cap: answer from the
  stale graph with `stale: true` and a note naming the cap.
- `src/hooks/repo-graph-injection.ts` `getCachedGraph`: keep mtime-based file cache, but
  consult the latest probe result (module-scope, refreshed at most every 30 s) and
  **suppress injection blocks entirely when `changed.length > refresh_cap`** — a wrong
  blast radius is worse than none (B5).
- `getStaleFiles` (B3): derive from probe (`changed ∪ removed`), which includes new
  files; delete the per-node `statSync` loop.

### 5.4 Config gate (B4)

`src/config/schema.ts` `RepoGraphConfigSchema` additions (all optional, G9):

```ts
enabled: z.boolean().default(true),          // false: no init scan, no hooks, repo_map returns a disabled notice
init_refresh: z.boolean().default(true),     // false: restore legacy always-full-rebuild
refresh_cap: z.number().int().min(0).max(500).default(50),
walk_budget_ms: z.number().int().min(1000).max(60000).default(5000),
max_files: z.number().int().min(100).max(100000).default(10000),
```

Thread `walk_budget_ms`/`max_files` into `buildWorkspaceGraphAsync` options from the
hook and the `build` action (today the defaults are unconfigurable — closes the
"10k/5s silently wrong for big repos" half of A7). `enabled:false` must short-circuit
**every** consumer — enumerate and cover each with a test: (1) hook construction /
init scan in `src/index.ts`; (2) `toolAfter` incremental updates in
`repo-graph-builder.ts`; (3) `repo-map.ts` execute (clear disabled-notice string; tool
stays registered — G4 unaffected); (4) `repo-graph-injection.ts` `getCachedGraph`
returns null (which silently disables the coder/reviewer blocks in
`system-enhancer.ts` and PR4's lane orientation — both already fail-open on null).

### 5.5 Tests & acceptance

- `tests/unit/tools/repo-graph-freshness.test.ts`: probe clean/drifted/new-file/removed/
  no-fingerprint/stamp-mismatch; sidecar write-after-save; fail-open on unreadable dir;
  **truncation safety** — a probe whose walk aborts on budget/cap returns
  `inconclusive` with empty `removed`, and init performs zero node deletions from it
  (assert node count unchanged).
- Update `tests/unit/hooks/repo-graph-builder.test.ts`: init path chooses full vs
  refresh vs no-op correctly (DI-seam the probe).
- `tests/unit/tools/repo-map.test.ts`: query-action auto-refresh under cap; cap-exceeded
  behavior; disabled-config behavior.
- Schema test for new keys (`tests/unit/config/repo-graph-config-schema.test.ts`).
- Acceptance (manual, record in PR body): on this repo, second session start with no
  changes completes init in < 2 s (vs ~158 s); `git checkout` of a 30-file branch then
  one `repo_map` query auto-refreshes exactly those files.

---

## 6. PR3 — ask/orient query surface

**Closes:** C4, C5, C6 (query-side halves). **Depends on:** PR1 (edge tags), PR2
(trustworthy freshness). Parallel-safe with PR5.

### 6.1 `repo_map action="ask"` — ranked entry points for a question

New module `src/tools/repo-graph/ask.ts` (pattern sources: Aider repo-map ranking,
Graft `ask.ts`/`graphrank.ts`; LocAgent validates the direction — all pattern-only):

1. **Vocabulary expansion** (graphify-informed): tokenize the question; expand each
   token against the graph vocabulary (node moduleNames, export names, ontology role
   names) via case/casing-split matching (camelCase/snake_case splitting; no fuzzy dep —
   exact + split-token + lowercase only, deterministic).
2. **Lexical seeding**: idf-weighted term overlap over fields
   `{moduleName (weight 3), exports (2), imports (1)}`; test-path de-rank ×0.35
   (mirror Graft's constant; document it).
3. **Graph re-rank**: personalized PageRank over the *undirected* file-level edge graph
   (nodes = files; edge weight 1; asset edges excluded), restart vector = normalized
   lexical scores, alpha 0.25, 25 iterations, early-exit on L1 delta < 1e-6. Pure
   in-memory math over the loaded graph — no deps (G10).
4. **Output** (JSON via the existing `ok()` shape):
   `{ hits: [{ file, score, matchedTerms, topExports, role, community }], expandedTerms,
   budget: { requested, returned, dropped } }`, default `top_n` 8, max 25.
   Every hit cites real `moduleName` paths only.

Wire per G4: action enum in `repo-map.ts` args + `VALID_ACTIONS`, tool description
(explicitly: "orientation only — read the located files before asserting anything about
them"; encodes SOTA finding #2), help/docs surface, tests.

### 6.2 `context_pack` upgrades (C4)

`src/tools/repo-graph/query.ts` `getContextPack` + `repo-map.ts`:

1. Optional arg `include_source: boolean` (default **false** — preserves the existing
   response shape and token cost for every current consumer and pinned test; PR4's
   prompt directives instruct agents to pass `include_source: true` explicitly): when
   true, for each span read the file segment (bounded: ≤ 80 lines/span, existing
   `maxTokens` budget governs total; reuse the `TOKENS_PER_LINE` estimate) and return
   `text` alongside the span. Read failures → span without text plus a note
   (fail-open). Paths resolved under `ctx.directory` only (G3).
2. Close the exported-symbols-only hole: when a reached symbol has no `exportRanges`
   entry, fall back to a **signature-mode pointer at the file level** (`startLine 1`,
   `mode 'signature'`, note `'internal symbol — span unavailable'`) instead of silently
   dropping it, so the agent at least learns the file is involved.
3. Response includes `sourceIncluded: boolean` and per-span `text?`.

### 6.3 Ergonomics & community labels (C4/C5 polish — NOT part of C6; the gating policy is entirely PR4 §7.2)

- `key_files`/`package_boundaries`: add `community` labels — reuse `packageBoundary`
  as the community key (no new clustering algorithm; explicitly NOT Leiden — deferred
  with the prose-nodes item), plus `hubScore` (normalized in-degree). Rename nothing.
- All list-returning actions gain `budget: { returned, dropped }` counts (Graft `map`
  pattern) so truncation is always visible to the agent.

### 6.4 Tests & acceptance

- `tests/unit/tools/repo-graph-ask.test.ts`: determinism (same graph → byte-identical
  output), vocab expansion (camelCase/snake_case), idf weighting sanity (rare term
  outranks common), PageRank convergence + early exit, asset-edge exclusion, budget
  counts. Fixture: small synthetic graph (≤ 20 nodes), hand-built in the test — do NOT
  build a real graph in unit tests.
- `tests/unit/tools/repo-graph-context-pack-source.test.ts`: source inclusion bounds,
  fail-open on unreadable file, internal-symbol fallback pointer.
- Acceptance / integration: build the graph over **one bounded subtree only**
  (`src/tools/repo-graph/` — ~10 files, sub-second) and assert
  `ask question="where is the graph saved atomically"` ranks `storage.ts` in the top 3.
  Building the whole repo's graph takes minutes of tree-sitter work and is forbidden in
  CI tests (walk-budget options exist — pass the subtree as the workspace root).

---

## 7. PR4 — delivery wiring (prompts, lanes, skills)

**Closes:** C1, C2, C3, C6 (push-side), C7. **Depends on:** PR2 + PR3.

### 7.1 Agent prompt directives (C1)

Graph-query-first posture, encoding SOTA findings #2 and #3. Edit prompts (each is a
TS template string; keep existing tone/format; add one compact block, ~6 lines):

- `src/agents/explorer.ts`: replace the blind-scan ACTIONS opener with:
  "FIRST call `repo_map action="ask"` with your mission question, and
  `action="context_pack"` for your target symbols. Use the hits to decide what to read.
  Graph output is orientation — read the located files before reporting on them. Fall
  back to tree/glob/grep only where the graph has no coverage (`stale: true`, missing
  files, or non-code assets)."
- `src/agents/coder.ts`: before editing a shared file, `repo_map action="localization"`
  (already injected when scope declared; the directive covers the undeclared case).
- `src/agents/reviewer.ts`: verify blast radius via `repo_map action="blast_radius"`
  for changed files not covered by the injected block.
- Keep each addition under ~120 tokens; these prompts are in every lane's stable prefix
  (SOTA finding #5 — they are constant, so cache-safe).

Update the consumer-contract tests (`src/agents/explorer-consumer-contract.test.ts`,
`explorer-role-boundary.test.ts`, `reviewer.test.ts`, `coder.test.ts`) for the new text.

### 7.2 Lane orientation block (C2)

`src/tools/dispatch-lanes.ts`:

1. New optional dispatch arg `orientation` added to **both** tool schemas
   (`dispatch_lanes` and `dispatch_lanes_async` — they are registered separately in
   `dispatch-lanes.ts`): `z.boolean().optional()` with **no zod default** (a schema
   default cannot depend on graph state); resolved at execute time as "undefined ⇒
   true when a fresh graph exists, false otherwise". Assembled by a new helper
   `buildLaneOrientationBlock(directory, lanePrompts): string | null` in
   `src/hooks/repo-graph-injection.ts`:
   - Runs `ask` over the **concatenated lane mission texts** once (not per lane),
     takes top 6 files + `key_files` top 4 + a one-line freshness statement.
   - **Gating policy (C6 push-side, Graft-pattern):** emit only when the top ask score
     clears a floor (constant, start 0.35 — tune in PR6) and the block is ≤ 600 tokens
     (`estimateTokens` from `src/hooks/utils.ts`); dedupe against a
     per-session set of already-delivered file pointers (bounded 128, FIFO) — suppressed
     repeats emit nothing (no nudge text inside lane prompts).
   - Determinism contract (precise, because it interacts with dedupe): the block is a
     pure function of (graph state, mission texts, **empty dedupe state**) — no
     timestamps or randomness (SOTA #5). A second identical dispatch in the same
     session is expected to be **suppressed by dedupe**, which is correct behavior,
     not nondeterminism. Appended to `common_prompt` (shared prefix position) ahead of
     per-lane text.
2. Overflow rule: the combined-length check in dispatch **throws** on
   `MAX_PROMPT_CHARS` overrun, so compute `max over lanes of (common_prompt +
   orientation + separator + lane.prompt).length` **before** appending; if any lane
   would exceed the cap, drop the orientation block entirely (log at debug) rather
   than truncating or failing dispatch.

### 7.3 deep-dive skill reuse (C3) and skill-side posture (G6)

`.opencode/skills/deep-dive/SKILL.md` + `.claude` mirror: Step 1 becomes
"`repo_map action="graph_health"`; only if missing/incomplete run `action="build"`" —
init + PR2 keep it fresh otherwise. Scope-map step: prefer `ask`/`key_files` over
manual `symbols`/`imports` assembly. Byte-identical dual-tree edit; run drift check.
Also add one line to the swarm-mode explorer guidance in
`.opencode/skills/swarm/SKILL.md`-adjacent docs if they repeat the blind-scan protocol
(grep for "Scan structure" across skills; update every occurrence).

### 7.4 Lane-output redelivery persistence (C7 remainder)

`src/tools/dispatch-lanes.ts`: persist `deliveredLaneOutputs` keys to
`.swarm/lane-delivery-cache.json` (bounded 1024 entries, best-effort write, fail-open
load) so the dedup survives plugin restarts/compaction cycles within a session. Keyed
by sessionID; entries for other sessions pruned FIFO.

### 7.5 Tests & acceptance

- Prompt-contract tests updated (7.1) — assert the directive text is present and the
  blind-scan opener is gone from explorer.
- `tests/unit/tools/dispatch-lanes-orientation.test.ts`: block emitted when floor
  cleared; **suppressed on repeat dispatch (dedupe)** — separate test; determinism —
  two identical dispatches **each starting from a reset dedupe state** produce
  byte-identical blocks (reset via a test-only seam, mirroring the existing
  `deliveredLaneOutputs` handling); suppressed when graph stale-over-cap; dropped when
  the pre-computed combined length would exceed `MAX_PROMPT_CHARS`.
- Skill drift check green (G6). Registration drift green (G4 — dispatch arg change
  needs schema/docs update).
- Acceptance (manual, record in PR body): dispatch a 2-lane exploration on this repo;
  lane transcripts show `repo_map` calls preceding file reads.

---

## 8. PR5 — structure-anchored memory outcome loop

**Closes:** D1, D2, D3. **Depends on:** PR2. Parallel-safe with PR3/PR4.

Design sources: graphify `reflect.py` (deterministic scoring: signed outcomes,
time-decay half-life 30 days, ≥2 corroborations to promote, recency resolves contested,
prune on missing anchor) and Zep/Graphiti (temporal anchoring). All pattern-only.

### 8.1 Outcome capture (D1)

- Extend the shared memory entry type (in `src/memory/types.ts` — verify the exact
  file; it is the type both providers consume) with optional fields:
  `anchors?: { file: string; symbol?: string }[]` and
  `outcomes?: { outcome: 'useful' | 'dead_end' | 'corrected'; at: string;
  taskId?: string; correction?: string }[]`. There are **two providers** to update:
  `src/memory/sqlite-provider.ts` (additive migration following the existing
  `/swarm memory migrate` machinery — new nullable columns or a JSON column,
  matching whichever pattern the provider already uses for optional structures) and
  the JSONL provider (`src/memory/` — locate `local-jsonl-provider.ts` or equivalent;
  JSON storage makes additive fields automatic, but its parse/validate path must
  accept them). Run the existing provider round-trip and migration tests to prove
  older stores load unchanged.
- New tool `swarm_memory_outcome` (full G4 wiring): args
  `{ memory_id?: string, question?: string, outcome, anchors?, correction? }` —
  records an outcome against an existing memory (by id) or files a lightweight
  result-memory (question+answer digest) when no id given. Granted to: explorer,
  coder, reviewer, critic, architect (mirror `swarm_memory_propose`'s grant list).
- Prompt wiring (same files as 7.1, one line each): after a task in which recalled
  memory or graph answers were used, record `swarm_memory_outcome` with
  `useful|dead_end|corrected`. Reviewer/critic prompts: record `corrected` with the
  correction when they overturn a claim sourced from memory.

### 8.2 Deterministic reflection artifact (D2)

New module `src/memory/reflection.ts`:

```ts
export interface ReflectionDigest { preferred: …[]; tentative: …[]; contested: …[];
  deadEnds: …[]; corrections: …[]; generatedFrom: { entries: number; asOf: string } }
export function buildReflectionDigest(entries, now: Date, opts?): ReflectionDigest
export function renderReflectionMarkdown(d: ReflectionDigest): string   // byte-stable for given input+now
```

- Scoring: per anchor/memory, sum of signed outcome weights with exponential decay
  (half-life 30 days, constant); promote to `preferred` only with ≥ 2 distinct positive
  outcomes; both-signs → `contested`, resolved by most recent.
- Persistence: `.swarm/reflections/lessons.md` + `.json` sidecar (G3). Regenerated by a
  post-resolution-queue task at session start (bounded: read memory store + render;
  no LLM, no network — G1-compatible) and **synchronously (write-through) at the end of
  each `swarm_memory_outcome` execution** — the render is a cheap deterministic pass,
  so no debounce, no background timer, no deferred work (permanent directive #1: a
  test can observe the updated artifact immediately after the tool call returns).
- Injection: extend the existing session-start injection path — add a compact digest
  block (≤ 500 tokens: top 5 preferred, top 5 dead ends, top 3 corrections) through the
  system-enhancer composition (before the collapse — G5), gated on
  `memory.reflection.enabled` config (default **false** in this PR — G9: existing
  behavior preserved unless set; flip the default to true only in PR6 once the A/B
  numbers justify it, as a one-line follow-up recorded in PR6's fragment).

### 8.3 Structural anchoring & pruning (D3)

- `anchors[].file` validated against the repo graph at reflection time: anchors whose
  file has no node **and** fails `isScannableSourcePath` existence check are marked
  dead; a memory with all anchors dead is excluded from `preferred` and flagged for the
  existing consolidation/stale machinery (`/swarm memory stale`) rather than deleted
  (respect the store's quarantine conventions).
- Group digest sections by `packageBoundary` of the anchor file when available.

### 8.4 Tests & acceptance

- `tests/unit/memory/reflection.test.ts`: decay math (fresh dead_end outweighs
  months-old useful), corroboration threshold, contested-recency, byte-stable render,
  dead-anchor pruning, group-by-boundary. Fixed `now` injection throughout.
- Tool registration tests for `swarm_memory_outcome` (G4 suite picks this up; add the
  focused unit test alongside existing memory tool tests).
- Migration test: pre-existing store without new fields loads; entries gain fields on
  first outcome write.
- Config schema test for `memory.reflection.enabled`.
- Acceptance: seed 6 synthetic outcomes across 2 files, delete one file from the graph
  fixture → digest shows 1 preferred group, 1 dead-anchor exclusion, renders identically
  across two runs with the same `now`.

---

## 9. PR6 — attribution and A/B measurement

**Closes:** E1, E2. **Depends on:** PR4 (and benefits from PR3/PR5 being in).

### 9.1 Tokens-saved attribution (E1)

- New module `src/services/context-attribution.ts`: for each orientation block /
  `ask` / `context_pack` response, estimate `tokensReturned` (existing `estimateTokens`)
  and `tokensSavedEstimate` = baseline-read cost of the files the answer made
  unnecessary to open — computed honestly as `sum(fileSizeTokens of cited files) −
  tokensReturned`, floored at 0, and labeled `estimate` (graphify/Graft "omit rather
  than fake" rule: when file sizes are unknown, record nothing).
- Persist per-session aggregates into the existing telemetry directory consumed by
  `summarizeTelemetryCosts` (`src/services/cost-accounting.ts`) under a new
  `context_attribution` record type; `/swarm costs` gains a "Context" table
  (`src/commands/costs.ts`) with columns Source (ask / context_pack / lane-orientation /
  reflection), Calls, Tokens returned, Est. saved.

### 9.2 A/B harness mode (E2)

`src/commands/benchmark.ts`: new flag `--context-ab <blind|push|pull|all>` which runs
the existing benchmark task set under three lane configurations:
(a) **blind** — orientation disabled (`repo_graph.enabled=false` equivalent override),
(b) **push** — PR4 orientation block on, (c) **pull** — orientation off but prompts
directing `repo_map` use (PR4 prompts are constant, so this toggles only the block).
Report per-variant: total tokens (input/output/cache split — cache-aware per SOTA #5),
tool calls, wall time, and task success as already measured by the benchmark machinery;
emit JSON alongside the existing schema. Wire into the `--max-cost-usd` gate unchanged.
Document in the benchmark help output (G4 help surface).

### 9.3 Tuning loop

Use `--context-ab` output to tune PR4's gating floor (0.35 start) and PR5's injection
budget. Record chosen values + measurements in the PR body and in a follow-up edit to
this document's §10 table. External vendor numbers (Graft 42–46%, graphify code-suite)
must never be cited as expected outcomes — only our own A/B numbers.

### 9.4 Tests & acceptance

- `tests/unit/services/context-attribution.test.ts`: estimate math, omit-when-unknown,
  aggregate persistence shape.
- `tests/unit/commands/benchmark-context-ab.test.ts`: variant wiring (mock runner),
  JSON schema stability, cost-gate interaction.
- Acceptance: `bun run <cli> swarm benchmark --context-ab all --max-cost-usd 5` on a
  small fixture repo completes and emits three comparable variant rows.

---

## 10. Gap → PR traceability

| Gap | PR | Gap | PR | Gap | PR |
|-----|----|-----|----|-----|----|
| A1 | 1 | B1 | 2 | C5 | 3 |
| A2 | 1 | B2 | 2 | C6 | 4 |
| A3 | 2 | B3 | 2 | C7 | 4 |
| A4 | 1 | B4 | 2 | D1 | 5 |
| A5 | 1 | B5 | 2 | D2 | 5 |
| A7 | 1 | C1 | 4 | D3 | 5 |
| A8 | 1 | C2 | 4 | E1 | 6 |
| —  | — | C3 | 4 | E2 | 6 |
| —  | — | C4 | 3 | —  | — |

Deferred with rationale (§3): LLM prose concept nodes; Leiden-style clustering beyond
`packageBoundary` communities; graft/graphify artifact interop (critic-fenced as
low-value/risky); A6 exclude_dirs case-folding (withdrawn — documented behavior;
revisit only on a real user report — record as a docs note in PR1's fragment).

## 11. Execution notes for the implementing agent

- Work one PR per branch off the default branch; land in order (PR3/PR5 may go in
  parallel after PR2 merges). Never stack unmerged PRs unless asked.
- Before each PR: read `AGENTS.md`, the editing-skills and writing-tests skills, and
  re-verify every file:line anchor cited here (`grep` the symbol names — line numbers
  will have drifted).
- Reproduce A1 (§1.1) and the B1 timing (sample-scan of ~100 files) **before** PR1/PR2
  changes and again after, and paste both numbers into the PR bodies.
- Each PR body: gap IDs closed, invariant checklist G1–G10 with per-item evidence,
  before/after measurements where applicable.
- If any planned change conflicts with an invariant on the ground (e.g. an init-path
  cost that can't be bounded), stop and surface the conflict rather than adapting the
  invariant.
