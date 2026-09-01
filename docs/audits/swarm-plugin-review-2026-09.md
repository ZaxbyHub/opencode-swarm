# opencode-swarm — first-class plugin review (v7.160.2, 2026-09-01)

> **Status: INTERIM.** This document is the synthesis of a swarm-mode audit whose explorer stage completed and whose independent reviewer and critic gates were interrupted by an API budget limit before they could run. Every finding in section 3 is therefore a **candidate** with explorer evidence; the "Pre-verification" column records what the orchestrating thread independently confirmed at source or against host code. Nothing here should be treated as a confirmed defect until the reviewer/critic pass is recorded in a later revision of this file. Explorer artifacts, probe scripts, reproduction harnesses and the raw GitHub inventory live outside the repository and are referenced by path in the appendix.

## 0. Executive synthesis

### Verdict

opencode-swarm v7.160.2 is an unusually ambitious OpenCode plugin: 450k lines of TypeScript, 130 tools, roughly 20 agents, 91 distinct gate denial codes, and a test corpus 2.4 times the size of the source. Its engineering contract (`AGENTS.md`) is stricter than most commercial plugins, and the historical failure map behind it is honest. The plugin nevertheless does not yet work end to end without friction, and the reasons are structural rather than incidental.

Five structural problems account for most of the 180 candidate findings below.

First, the plugin's most important behaviours rest on host-contract assumptions that were never verified against OpenCode's source. The strongest example is MAIN-10: every guardrail advisory, hard stop, partial-gate warning, knowledge recall and memory injection is delivered as a synthetic `role: 'system'` message through `experimental.chat.messages.transform`, yet the host's message converter only renders `user` and `assistant` roles and silently drops anything else. If this holds on the released host, a large fraction of the plugin's runtime steering has been invisible to the model while telemetry records it as injected. The same class covers HOOKS-2 and HOOKS-3, where two gates compare the tool name against `'Task'` although the host's id is `task`, so the delegation loop breaker and the per-role model fallback on the Task path cannot fire. The plugin already paid for this class once (v6.85.1, issue #1619) and has no contract test that pins host behaviour.

Second, the plugin is written as if it were the only instance in the process, while OpenCode instantiates plugins per directory (worktree lanes, Desktop tabs). The init lane proved with a three-instance harness that the second project skips the `.swarm/` git exclusion, loses its telemetry stream, and has its deferred warnings wiped; `swarmState` agent registries are overwritten by the last directory; there is no `dispose` hook, so pollers and exit listeners accumulate across instances (INIT-1, INIT-2, INIT-5, INIT-6, MAIN-1).

Third, the gate layer over-denies and under-explains. The single external-user thread with real depth (#1896, Windows, 30 comments, still open) shows the pattern end to end: scope, ACCEPTANCE, shell-write, PRM-escalation and circuit denials stack into 20 to 30 dispatch loops because no denial tells the model what to send next, until the architect self-codes and the QA pipeline is silently bypassed. The code corroborates the mechanism: a transient-error regex without digit boundaries turns a context-window overflow into a retryable provider error (OBSERVABILITY-1); the documented bounded transient retry has no producer (OBSERVABILITY-2); the partial-gate latch is consumed before any gate can run (HOOKS-4); an `includes('error')` classifier records passing gate tools as failures (HOOKS-5); and this repository's own `src/security`, `src/sandbox`, `src/evaluation` and nested `package.json` paths are hard-coded as write-protected prefixes in every consumer repository (SECURITY-1).

Fourth, the first-run path is broken in several independent places. The installer replaces an unparseable `opencode.json` with a minimal file, destroying provider keys and MCP config (CONFIG-1). The Docker and operator runbooks install a package that does not exist on npm (DOCS-1). The README promises the architect is auto-selected while the default is manual and the installer never sets it, so the first task runs in OpenCode's `build` agent with the plugin bypassed (DOCS-3). The documented npm-only path still needs Bun (CONFIG-5). Default subagent models point at a Zen model marked legacy and at a paid one under a "free tier" claim, and the only warning is a post-init `console.warn` retrievable via `/swarm diagnose` (MAIN-5).

Fifth, the maintenance process amplifies regressions. Seven months produced 695 releases (about three a day) of a 50 MB `@latest` package, 211 bug-fix sections against 81 feature sections in the last 247 releases, and fix-of-fix chains that span five to nine versions (delegation-gate evidence resolution, plan.md write hardening, Windows CI hangs, PR-review lane output contracts, non-transient retry loops). Of 126 PRs flagged for deep reading, 34 were merged or closed with no independent reviewer, with LLM verdicts self-posted from the maintainer account and counted as approval; 13 tolerated large baselines of pre-existing failing tests. The stale bot closes labelled defects after 37 days of inactivity, including Windows-specific bugs nobody else can reproduce. Merge-group CI takes 31 to 65 minutes, and the PR tier never runs Windows or macOS for `src/utils`, `src/db`, `src/git`, `src/cli`, `src/hooks` or `src/config`.

### What "first class" requires, in order

Phase 0 stops the bleeding and needs no design work: verify MAIN-10 against the released host tag and, if confirmed, move every injection to a rendered channel (`output.system` for per-turn directives, user-role parts for advisories); route every tool-name comparison through one case-insensitive normaliser and add a contract test that loads the host's tool ids; add `satisfies Hooks` to the returned hook object; put word boundaries on the transient regex; make the compaction wrapper honour the disabled state; make `install` refuse to overwrite a config it cannot parse; fix the two documentation defects that break installation.

Phase 1 makes the plugin a well-behaved host citizen: register `dispose`; replace module-level singletons with a per-instance container keyed by directory; use `tool.definition` to trim the 130-tool schema per agent; move sandbox environment injection to `shell.env`; use `permission.ask` for full-auto instead of a parallel classifier; evaluate the host's workspace adapters and native background Task execution before extending the plugin's own worktree and lane machinery.

Phase 2 makes denials model-actionable: one structured denial envelope for all 91 codes that states what failed, what was observed, and the exact next call; the prose dispatch protocol (`TASK:`, `FILE:`, `ACCEPTANCE:`, `SKILLS:`, `CONSTRAINT:`) parsed from a fenced JSON block with a published schema; and a recurring benchmark that drives three weak models through dispatch so loops are measured rather than reported by users.

Phase 3 fixes defaults and surfaces: defaults that resolve without a Zen account, a preflight that blocks with a visible message rather than warning into a buffer, a doctor that reads the user-level config, consumer-neutral protected paths, a visible telemetry-disabled state, and bounded retention for the sixteen streams currently deferred to issue #2309.

Phase 4 fixes the process: independent review by a different model family plus a human for HIGH findings, a stale bot that exempts `bug`, pruning of the 595 pending release fragments, Windows and macOS coverage for the portability-sensitive prefixes on every PR, a blocking timeout invariant check, and type-checking for the one million lines of tests and the CI gate scripts.

## 1. Method and evidence base

The audit ran under the repository's own swarm-mode contract (`.claude/session/swarm-mode.md`): parallel explorers per disjoint subsystem, a separate main-thread pass for cross-cutting host-contract questions, and a GitHub-history sweep over the complete issue and pull-request record. Explorers were required to cite `file:line` with verbatim quotes, to state a verification recipe per candidate, and to write structured findings; several also built runtime harnesses (three-instance plugin init under Node, isolated-XDG CLI installs, classifier probes, tool-schema generation through the host's zod path, SDK type diffs against the latest published package).

| Input | Coverage |
|---|---|
| Source (src/, scripts/, tests/, skills, docs, CI) | 19 explorer lanes; 872 non-test TS files, 450,523 source lines, ~1.1M test lines |
| GitHub issues | 750 total (97 open); 230 not authored by the maintainer account (includes CI bots); one deep-read thread (#1896) |
| GitHub pull requests | 1710 total; 726 release PRs; 126 flagged PRs deep-read (reviews, threads, outcomes) |
| CHANGELOG / release notes | 690 releases analysed for churn and fix-of-fix chains |
| Host contract | @opencode-ai/plugin 1.18.3 types (installed) and 1.18.25 (npm latest); anomalyco/opencode `dev` source for plugin loading, task tool, permission evaluation, message conversion |
| Build and runtime | dist built; repro-704 (init deadline) run; init traced under Node; CLI exercised in isolated XDG dirs |

Not covered: the OpenCode host binary itself was not run (no TUI/Desktop in the container); Windows and macOS behaviour is inferred from source and CI history; the knowledge graph tool (`graphify`) is not installed here; issue bodies were read only for #1896, #1914 and the issues named by lanes.

## 2. What the history says

Issues per month: 2026-02: 9, 2026-03: 34, 2026-04: 135, 2026-05: 93, 2026-06: 135, 2026-07: 169, 2026-08: 175. Title keyword incidence (of 750): gate 109, knowledge 82, prreview 50, plan 47, flaky 46, docs 27, install 20, regression 19, windows 16, node 7.

Pull requests: pages 6: 600 (merged 548, closed unmerged 52, release PRs 289); pages 7-12: 600 (merged 583, closed unmerged 17, release PRs 242); pages 13-18: 510 (merged 483, closed unmerged 15, release PRs 195). Deep-read outcomes for the 126 flagged PRs: closed-unmerged-superseded 41, merged 57, closed-unmerged-abandoned 12, closed-unmerged-rejected 5, open 11.

### 2.1 Churn by subsystem (CHANGELOG fix counts)

**v6.0.0 (earliest detailed entry ~v6.9.0) through v7.79.2 (v7.80.0 excluded)** (443 releases)

| Fixes | Subsystem | Examples |
|---:|---|---|
| 189 | Tests / flakes / CI hangs | ci: per-file wall-clock timeout wrapper for Windows merge-queue shard hangs (v7.79.2); tests: resolve CI test failures on macOS, ubuntu, and Windows (v6.44.3) |
| 150 | Gate / evidence / quality-debt / mutation-gate | delegation-gate: resolve evidence task IDs correctly for parallel Stage B dispatches (v7.28.2); gate warn() behind DEBUG and block direct plan.md writes (v6.20. |
| 103 | Agent prompts (architect/coder/reviewer) | Architect prompt hardening: 11 new enforcement blocks (v6.12.0); AUTHOR BLINDNESS WARNING added to coder prompt (v6.11.0) |
| 62 | Delegation gate / self-coding guardrails | detect and reset stale coder_delegated state from prior sessions (v6.40.8); fail-closed guard for OpenCode background subagents (v7.54.0) reworked to opt-in dur |
| 49 | Learning / curator / memory / skill-propagation | curator background analysis system introduced (v6.30.0) |
| 43 | Session handling | abort in-flight prompt before session.delete() to prevent FK crashes |
| 41 | PR review workflow / pr-monitor / council | pr-monitor: start worker unconditionally and add startup scan (v1381/1384); treat advisory final council concerns as non-blocking (v7.56.3) |
| 38 | Knowledge system | make JSONL persistence transactional, race-safe, and crash-atomic (v7.51.3); TOCTOU race in bumpCountersBatch and knowledge_archive (v7.77.3) |
| 38 | Lint / formatting / Biome | collapse multi-line existsSync call to satisfy Biome formatter (v7.65.2) |
| 33 | Commands / TUI | wire gap commands into TUI and establish tool-policy SSOT |
| 24 | dist / build / packaging | Remove postinstall hook to avoid Bun dependency during npm global install (v6.11.1) |
| 23 | Windows / Node portability | unblock OpenCode Desktop plugin init across macOS/Linux/Windows (v7.0.3); retry rename on EPERM/EBUSY in saveGraph |

**7.80.0-7.160.2** (247 releases)

| Fixes | Subsystem | Examples |
|---:|---|---|
| 90 | CI / test infrastructure | 7.107.5: 5 Windows/macOS CI fixes in one release; 7.109.2: tolerate EBUSY/ENOTEMPTY in Windows afterAll cleanup |
| 89 | PR review workflow (swarm-pr-review pipeline) | 7.137.1: surface previously-silent lane contract failures; 7.146.4: unify severity dialects, close severity-omission bypass (5 commits) |
| 45 | Knowledge system (curator/promotion/dedup/governance) | 7.120.0: 7 commits closing PR #1862 curator CAS/purge/dedup findings; 7.131.0: dedupe knowledge array fields, harden dedup guardrail |
| 34 | Guardrails / quality gates | 7.122.1: 4 commits stopping non-transient command retry loops; 7.132.2: close advisory injections firing on healthy sessions |
| 28 | Skills (loading, activation, retirement) | 7.114.9: wire 7 unreachable bundled skills into consumer runtimes; 7.109.3: close TOCTOU race in clearSkillLinks |
| 18 | Background orchestration / workflow engine | 7.127.1: prepend workflow banner instead of replacing architect text; 7.132.1: stop lane output being destroyed and re-sent every poll |
| 17 | Delegation / dispatch lanes | 7.143.0: flag omitted ACCEPTANCE text as missing; 7.143.1: stop flagging shifted-but-present bodies as missing (next-day overcorrection) |
| 16 | Windows/Node cross-platform portability (cross-cutting) | 7.117.0: normalize cohort-id path separators for Windows worktree convergence; 7.140.4: use realpathSync.native + case-insensitive paths on Windows |
| 13 | SAST / security scanning | 7.159.2: reflow-match moved baseline findings behind audited triage; 7.148.5: bind JavaScript security calls to their callees |
| 12 | Plan durability (PRM) | 7.153.1: bound session trajectories and reads; 7.139.4: count escalation strikes per occurrence not per detection |
| 12 | Repo/symbol graph (KG) | 7.160.0: KG-15 route/data/security/test graph packs; 7.159.0: close swarm-pr-review + owner review findings on KG-14 actions |
| 10 | Telemetry / observability | 7.160.0: expose model-limit provenance, wire learning-health alarms; 7.159.1: preserve provider cost provenance |

### 2.2 Fix-of-fix chains (same symptom fixed in three or more versions)

| Topic | Versions | Note |
|---|---|---|
| Delegation-gate evidence/task-ID resolution | v6.40.8, v6.72.1, v7.27.4, v7.28.2, v7.52.1 | Each release claims to finally fix task/evidence-ID resolution for parallel dispatches; narrowed further each time, implying earlier fixes were incomplete. |
| Delegation-gate leaking internal state / background subagent tracking (issue #1151) | v7.5.4, v7.54.0, v7.55.0 | Fail-closed guard in 7.54.0 reworked into opt-in durable tracking one release later under the same issue number. |
| plan.md / plan-state write-path hardening | v6.20.2, v6.21.1, v6.27.0, v6.30.0, v6.82.1, v6.86.3 | Block direct writes -> gate-state hardening (hotfix-78, duplicated across 3 headers) -> stale bypass permission found and removed 2 months later -> discovered in-memory/on-disk state had diverged, needed a bridge fix. |
| Knowledge counters / batch writes / concurrency | v7.51.3, v7.77.3, v7.78.1 | 'Transactional, race-safe, crash-atomic' fix in 7.51.3 still left a TOCTOU race found 26 releases later; next release had to route more call sites through the same transaction wrapper. |
| Windows/cross-platform CI hangs and native-dependency breakage | v6.19.6, v6.25.8, v6.27.0, v6.30.0, v6.31.2, v6.44.3, v7.3.4, v7.13.2, v7.79.2 | Longest-running recurring pain point across the whole range: native tree-sitter deps, device-path guard, OOM hang, cross-platform plugin-init hang, doc-scan event-loop hang, merge-queue shard hangs. |
| Council mode / final-council gating semantics | v6.72.1, v7.56.3 | Wiring gaps fixed in council mode, then blocking-vs-advisory gating semantics corrected releases later; 16 total council-scoped fix commits in range. |
| Named hotfix-78 chain (summarization verification, gate-state wiring, plan-state guard) | v6.21.1, v6.27.0, v6.30.0 | Identical commit pair listed under 3 separate version headers; either genuine re-application or a changelog-duplication artifact from that era. |
| Named issue-124 chain (checkReviewerGate skips corrupt sessions) | v6.22.12, v6.27.0, v6.30.0 | Same commit hash listed under 3 headers, same duplication pattern as hotfix-78. |
| Post-merge PR review findings addressed after ship (F-001/F-002/F-003 pattern) | v7.46.5, v7.51.4, v7.52.0, v7.52.3, v7.66.1, v7.66.3 | Recurring pattern of fix releases immediately following a feature release to address reviewer findings discovered only after merge. |
| Internal/system output leaking into chat UI | v7.1.1, v7.3.1, v7.5.4, v7.76.1 | Different subsystems (knowledge-injector, telemetry, delegation-gate, background sessions) each separately leaked internal warnings/noise into the user-visible chat stream over time. |
| Windows/Node path & filesystem portability | 7.89.0, 7.107.3, 7.107.5, 7.109.2, 7.117.0, 7.129.1, 7.129.4, 7.131.0, 7.140.4, 7.143.3 | Never durably closed: reserved device names, containment assertions, 8.3 short-path comparison, EBUSY/ENOTEMPTY cleanup, worktree convergence via git-common-dir, AV file locks, .cmd/.bat shims, AbortSignal hangs, realpat |
| PR-review lane/discovery output-contract failures | 7.136.1, 7.137.1, 7.138.2, 7.140.6, 7.144.7, 7.148.0, 7.148.2, 7.149.1, 7.160.1 | Worker output from review lanes kept failing to parse or being silently discarded; each release narrows one failure mode (transcript framing, row shape, checkpoint liveness, temp-root identity) without the class fully cl |
| PR-review trigger evidence / receipt integrity | 7.126.6, 7.138.3, 7.139.2, 7.144.7, 7.146.4 | Trigger evidence going stale and receipts being re-derivable/mutable; 7.146.4 alone shipped 5 commits unifying severity dialects and closing 2 tracked issues. |
| Guardrails non-transient invocation retry loops | 7.122.1, 7.132.2, 7.136.3, 7.147.1, 7.151.0 | A gate meant to stop unsafe command retries kept letting agents spin (7.122.1: 4 commits same release); 7.132.2 and 7.136.3 restate near-identical 'endless self-loop' headline; 7.147.1 finally consolidates divergent reco |
| Delegation-gate ACCEPTANCE/acceptance-body detection | 7.126.2, 7.143.0, 7.143.1 | 7.143.0 made the gate flag missing acceptance text as completely missing; the very next patch 7.143.1 had to stop it flagging shifted-but-present bodies as missing — a same-day fix/overcorrection pair. |
| Coder write-scope binding/authority | 7.110.2, 7.125.4, 7.135.1, 7.138.4 | Scope authority rebuilt piecemeal: TTL=0 boundary off-by-one, event-shape binding, workspace-root resolution, durability — four distinct passes rather than one specification. |
| Knowledge governance mega-remediation (PR #1856/#1862) | 7.117.0, 7.118.0, 7.120.0, 7.124.0, 7.131.0, 7.141.0, 7.153.2 | 7.120.0 alone shipped 7 knowledge commits (curator CAS, purge-via-ownership-policy, dedup-merge audit trail); dedup/source-taxonomy correctness resurfaced through 7.131.0 and 7.141.0. |
| Memory learning-loop correctness (provenance, scope leak) | 7.87.1, 7.88.1, 7.104.0, 7.146.0 | 7.104.0 closed a cross-scope propagation leak found by adversarial review; 7.146.0's two 'final-critic delta' commits show the provenance-column bug being iterated on live during its own review. |
| Worktree provisioning / scope recovery | 7.107.5, 7.108.0, 7.135.3, 7.139.1, 7.143.2, 7.153.1 | Reliability work still explicitly tagged 'Guardrail remediation 10/12' as late as 7.153.1, near the end of the range. |
| pr-workflow checkout/bootstrap/interrupt recovery | 7.126.1, 7.126.2, 7.126.3, 7.129.3 | Four consecutive point releases reworking the same checkout/bootstrap controller path; 7.126.2 and 7.126.3 each shipped duplicate same-headline commits within the release. |
| Flaky-test detection and quarantine (not root-cause fix) | 7.107.4, 7.143.4, 7.143.5, 7.146.5 | 21 total 'quarantine' mentions across the range; 7.143.4/7.143.5 are automated bot-generated 'Auto-detected flaky tests' commits — quarantine is the standing mitigation, not elimination. |

### 2.3 Themes the release history supports

- Windows/cross-platform CI stability is the longest-running, most frequently re-touched problem area across the entire 6.x-7.79 history
- Delegation gate and QA-gate/evidence machinery are both the core safety mechanism and the largest source of ongoing bugs
- Knowledge system underwent continuous version-over-version rework and never reached a stable steady state in this range
- Agent prompt hardening against self-coding/rationalization failure modes needed runtime detection hooks layered on top, then further iteration
- plan.md/plan-state durability had a multi-month arc from write-blocking to bypass-permission removal to a state-bridge fix
- Named/tracked hotfix chains (hotfix-78, issue-124, dark-matter) recur verbatim across multiple release headers, suggesting changelog-generation reliability issues during 6.19-6.30
- Internal machinery output (warnings, reasoning parts, telemetry) repeatedly leaked into user-visible chat/TUI surfaces across unrelated subsystems
- PR review workflow and council-mode gating semantics required repeated correctness passes long after initial ship
- Recurring pattern of addressing PR review findings (F-001/F-002/F-003) in same-day or next-day follow-up releases rather than before merge
- Test-suite health was periodically degraded enough to need bulk remediation (106 pre-existing failures fixed in one release) alongside near-constant flaky/hanging-test fixes
- Windows/Node cross-platform portability is the most persistent, never-fully-closed defect class, recurring independently at the filesystem, worktree, knowledge, CI, and session-snapshot layers
- The PR-review pipeline is both the project's primary quality gate and its most heavily self-patched subsystem; ~5.5% of all bug-fix commits in the window exist only to close findings the pipeline raised against its own immediately-preceding commit
- The knowledge/curator governance system absorbed the single largest remediation event in the range (7 commits in 7.120.0 against PR #1862) and its dedup/source-taxonomy bug kept resurfacing for 20+ releases
- Guardrails/quality-gates suffered both under- and over-triggering in the same window: loops it should stop kept looping (7.122.1/7.136.3/7.147.1) while it also fired advisories on healthy sessions (7.132.2)
- Coder write-scope authority was rebuilt in at least four distinct, uncoordinated passes (TTL boundary, event-shape binding, workspace-root resolution, durability)
- Delegation-gate acceptance-detection shows a concrete same-day fix/overcorrection pair (7.143.0 to 7.143.1), evidence fixes themselves regressed the opposite failure mode
- Test flakiness was managed primarily via quarantine (21 mentions, including bot-automated flaky-test commits) rather than root-cause elimination
- At least one tool-schema break disabled a core tool for an entire provider class (knowledge_recall boolean enum breaking all Gemini-API providers, 7.148.3), and one release had to wire up 7 bundled-but-unreachable skills that shipped unwired (7.114.9)
- The formal docs/releases/vX.Y.Z.md narrative-notes practice stopped before v7.80.0 (last file is v7.22.0.md) and was never resumed across this 80-version, 247-release window
- Release cadence is fix-heavy: 211 Bug Fixes sections vs 81 Features sections across 247 releases, i.e. roughly 7 in 10 releases in this window were pure patch releases

### 2.4 What reviewers keep finding in pull requests

| Pattern | PRs |
|---|---:|
| Merged/closed with no independent reviewer: reviews are absent, or LLM verdicts are self-posted from the author account (auto-fix-easy kimi/GLM, dual-model Qwen/Gemma pipeline) and counted as approval | 34 |
| Large baseline of pre-existing failing tests on main tolerated in PR bodies (dozens to hundreds of failures), masking regressions | 13 |
| Large hotfix/feature bundles self-merged within minutes with zero human or bot review (Codex over usage quota on many) | 10 |
| Unwired or dead code: tool added to map but not registered, exported helper never consumed, enum/allowlist/type-union drift between producer and consumer (VALID_CATEGORIES, agent-name lists, 'violated' vs 'violation', ArgsSchema vs tool args) | 10 |
| Review findings deferred to post-merge follow-up PRs/issues instead of fixed pre-merge (title contains follow-up / post-merge) | 9 |
| Codex bot review findings (P1/P2) left unresolved and PR merged or closed anyway; in #220 the ignored P1 became the 6.29.4 startup regression fixed by #223 | 8 |
| Duplicate or superseded PRs from Copilot-agent / auto-fix cron that did not check main; same fix landed 2-3 times (verdict vocabulary fixed in #1342, #1325, #1385) | 8 |
| PR description overstates evidence: test counts, 'all N recommendations', unchecked test-plan checkboxes at merge, 'Closes #' on test-only PR | 8 |
| Release-please misconfiguration producing wrong versions, hand-edited manifests, or a broken npm publish | 7 |
| Tests that pass for the wrong reason or are loosened to pass: sleep increased, precision relaxed, mode-labelled test never enables mode, symlink test hits fallback path, weak toBeDefined placeholder | 7 |
| Unwired code: commands missing from dispatch tables/help, tools never registered in plugin tool block, prompt lists drifting from registries, feature flags accepted but non-functional | 6 |
| Cross-platform/mock-leakage test failures accepted as 'pre-existing baseline' or resolved by deleting tests / splitting CI jobs | 6 |
| Duplicate/parallel PRs for the same problem (maintainer vs external contributor, or two AI agents) closed as superseded | 6 |
| Symlink/path-containment checks in .swarm writers incomplete: no realpath, TOCTOU, or ENOENT fail-open that lets new files under symlinked dirs escape | 6 |
| QA-gate bypass via evidence/verdict scoping errors: cross-task or cross-phase contamination, verdict enum collapsed, fail-open on missing plan, turbo bypass | 6 |
| Hand-edited release-please manifest / stale dist version string causing wrong release calc; dist/ rebuild churn in unrelated PRs | 6 |
| Windows-specific failures (EPERM/EISDIR, LOCALAPPDATA, symlink privileges, path case) repeatedly deferred as pre-existing or unverifiable | 6 |
| Silent failure/observability gaps: swallowed catch, silent truncation, silent Zod key stripping, silent under-count | 6 |
| Session/state corruption from async ordering: hook-chain timeouts, early Task handoff, debounced snapshot writes, cachedInjectionText mutation order | 5 |
| Concurrency on shared .swarm state files (read-modify-write without lock, TOCTOU, non-atomic rewrite) fixed piecemeal per file | 5 |
| Root path resolution against process.cwd()/ctx.directory instead of correct root (project root vs plugin root, cwd vs dir cache key) | 4 |
| Concurrent-write races on .swarm files with no locking or atomic rename (curator-briefing.md, ledger events, plan.json, state.json) | 4 |
| Guardrail/authority matching fragile on tool-name namespacing, key casing, and agent-name prefixes | 4 |
| Bugs discovered only in post-merge review of the previous release rather than pre-merge | 4 |
| Same branch or fix churned through multiple PR numbers to reset CI or rebase (three 'port PR #1244' PRs) | 4 |
| Direct push to main bypassing PR/CI/branch protection, followed by a revert or a placeholder PR | 3 |
| PR scope violates CONTRIBUTING (manual CHANGELOG/version edits, hotfix bundled with feature, test files misplaced) | 3 |
| Stacked PRs on stale bot branches yield unreviewable diffs (183 files) and bot findings dismissed wholesale as 'not in my diff' | 3 |
| Copilot coding-agent noise PRs with no meaningful diff | 2 |
| Prefixed multi-swarm agent names break exact-match lookups and allowlists | 2 |
| Prompt-injection sanitization applied to one injection path and missed siblings; risk noted then deferred before being fixed | 2 |
| Architect self-coding bypass patched by adding prompt text and raising prompt-size budget rather than runtime enforcement | 2 |

### 2.5 The one deep external-user thread (#1896)

Issue #1896 (Windows 11, external author, 30 comments, reopened, stale-warned on 2026-08-24) is the most complete record of the plugin failing for a real user. The sequence was: an ACCEPTANCE verbatim-match loop caused by section-symbol mojibake with a non-actionable error; the UI-selected model silently diverging from the configured role model; quota exhaustion with no failover; a sandbox-wrapper circuit that survived session resets because it was invocation-scoped; the shell-write classifier blocking `python -m ... 2>&1`; a PRM "pattern escalation" hard stop cascading from that single root cause; the host Task tool's `task_id` (a session id) colliding with the plugin's plan task id (#1914, fixed in #1917); the designer agent silently not registered without `ui_review.enabled`; and, after three rejected dispatches, the architect self-coding and skipping the reviewer and test engineer. The maintainer's AI-generated "fully resolved" comment arrived within five hours; the user was still blocked the next day; on 2026-08-24 the maintainer recorded that three of the four closure-matrix rows remain open. The thread is the best available specification of what "works end to end" must mean for this plugin.

## 3. Candidate findings

211 candidates after de-duplication (CRITICAL 2, HIGH 39, MEDIUM 94, LOW 63, INFO 3, high 1, medium 2, low 7). Sorted by severity, then lane. "Pre-verification" is the orchestrating thread's own check; blank means explorer evidence only.

### 3.1 Index

| ID | Sev | Lane | Kind | Title | Pre-verification |
|---|---|---|---|---|---|
| PARALLEL-1 | CRITICAL | parallel | unwired | Lean Turbo phase gate needs a critic verdict nothing in production produces |  |
| PRREVIEW-1 | CRITICAL | prreview | unwired | Default settlement path is unsatisfiable: child lanes are never told the batchId/laneId that submit_pr_review_result requires |  |
| COMMANDS-1 | HIGH | commands | bug | Architect delegation template cites SKILLS paths that exist only in this repo; the mandatory reference gate throws and bundled fallbacks are undiscoverable |  |
| COMMANDS-2 | HIGH | commands | design | opencode-swarm-internal skills (bun:test, AGENTS.md, biome, package-check) are bundled into every consumer project and the prompt mandates injecting them |  |
| CONFIG-1 | HIGH | config | bug | install() silently replaces an unparseable opencode.json, destroying the user's providers/MCP/plugin config | yes |
| DOCS-1 | HIGH | docs | bug | Docker/LLM-operator install docs install non-existent npm package `opencode` | yes |
| DOCS-3 | HIGH | docs | drift | README says architect is auto-selected on first run; default is manual, so first task silently bypasses the… | yes |
| EVIDENCE-1 | HIGH | evidence | bug | requirements_reconstruction sentinel from repair_gate_evidence is never consumed; repaired task can never complete |  |
| EVIDENCE-2 | HIGH | evidence | unwired | req_coverage reads 'diff' evidence with files_changed that nothing writes; every FR 'missing', #2242 preflight gate always fails |  |
| EVIDENCE-4 | HIGH | evidence | drift | incremental_verify hook only runs when execution_mode==='strict' (default balanced); docs/README present it as on by default |  |
| HOOKS-1 | HIGH | hooks | bug | experimental.session.compacting wrapper calls undefined when hooks.compaction=false | yes |
| HOOKS-2 | HIGH | hooks | unwired | Loop detector compares raw tool name to 'Task' while the host id is lowercase 'task' -> LOOP DETECTED / CIRCUIT BREAKER never fire | yes |
| HOOKS-3 | HIGH | hooks | unwired | registerPendingTaskModelRoute gated on tool === 'Task' -> child model override/fallback chain unreachable | yes |
| HOOKS-4 | HIGH | hooks | bug | PARTIAL GATE VIOLATION one-shot latch is consumed before any gate can run (turn 1 and right after coder dispatch) |  |
| INIT-1 | HIGH | init | bug | ensureSwarmGitExcluded latch is process-global: 2nd directory in one OpenCode process is never git-excluded | yes |
| INIT-2 | HIGH | init | bug | initTelemetry latches on the first directory; later instances write telemetry to the wrong project | yes |
| INIT-4 | HIGH | init | portability | node:sqlite adapter run(sql) returns undefined but callers read .changes — /swarm link migration throws on the Node sidecar |  |
| KNOWLEDGE-1 | HIGH | knowledge | perf | Hive promoter runs a full promotion transaction on every tool call (git x2, receipt-ledger lock, hive lock) |  |
| KNOWLEDGE-2 | HIGH | knowledge | unwired | Knowledge-curator write trigger reads input.args the host never supplies: plan.md retro / evidence curation dead in prod |  |
| KNOWLEDGE-4 | HIGH | knowledge | bug | Run-memory summary (#2115) only injected when knowledge search returns entries; coder never receives it |  |
| MAIN-1 | HIGH | main | bug | No `dispose` hook: interval workers, automation manager and a per-load process.on('exit') listener survive OpenCode instance disposal/reload; module-level swarmState is shared across instances | yes |
| MAIN-5 | HIGH | main | friction | Default subagent models are Zen ids that are legacy (minimax-m2.5-free) or paid (gpt-5-nano) while README claims a free tier; preflight only warns post-resolution and is silent when the catalog is unavailable | yes |
| OBSERVABILITY-1 | HIGH | observability | bug | Transient regex matches bare digit substrings: permanent errors become retry_same and advance model fallback | yes |
| PARALLEL-2 | HIGH | parallel | unwired | Windows native sandbox runner unreachable from the published package |  |
| PARALLEL-3 | HIGH | parallel | bug | Init orphan recovery from a second OpenCode process can delete a live Lean lane with uncommitted work |  |
| PARALLEL-4 | HIGH | parallel | design | v8 parallel-first (#1674) degrades to serial under default prompts (just-in-time scope declaration) |  |
| PLAN-1 | HIGH | plan | bug | loadPlan rebuilds from lossy plan.md BEFORE the ledger when plan.json is absent, then adopts the lossy plan into the ledger |  |
| PLAN-2 | HIGH | plan | bug | A literal U+FFFD in any task text makes plan.json permanently 'invalid encoding' -> lossy plan.md migration on every load |  |
| PLAN-3 | HIGH | plan | bug | get_approved_plan reports drift_detected=true for an unchanged plan after plan-critic-gate approval (full hash vs structure hash) |  |
| PLAN-4 | HIGH | plan | bug | plan.current_phase is pinned to phase 1: save_plan resets it on every revision and phase_complete never advances it |  |
| PROMPTS-1 | HIGH | prompts | perf | Architect prompt ~34.5K tokens/turn (~40K with features); prefixed+all-features render exceeds the CI ceiling |  |
| PROMPTS-4 | HIGH | prompts | portability | Per-language constraints inject only when the task DESCRIPTION contains 'src/…'; files_touched and non-src layouts never trigger while coder prompt hard-codes TypeScript rules |  |
| PRREVIEW-2 | HIGH | prreview | drift | Architect MODE stub, wake banner and a pinned test still order abort_pr_workflow on retry_exhausted/circuit_open, contradicting the N-of-6 rule |  |
| PRREVIEW-3 | HIGH | prreview | drift | .claude and .agents swarm-pr-review adapters say 'report BLOCKED merely because the controller is unavailable' (lost 'Never'); untested |  |
| REPOGRAPH-1 | HIGH | repograph | perf | Startup graph build blocks every tool result: toolAfter awaits init before its write-tool filter; scan phase has no time budget (265 s measured here) |  |
| REPOGRAPH-2 | HIGH | repograph | design | Fingerprint stamp includes package.json version: every release (3-6/day) forces a full startup rebuild; docs say only schema bumps do and that the old graph is served |  |
| SECURITY-1 | HIGH | security | bug | Plugin-repo paths hardcoded as universal protected prefixes block coder writes in consumer repos | yes |
| TESTSCI-1 | HIGH | testsci | perf | Merge-group wall 31-65 min: runner-queue contention, 16-23 min Windows cells, serialized unit->integration->smoke; shard comments stale (2988/498 vs 1666/278) |  |
| TOOLS-1 | HIGH | tools | design | Per-agent tool allow-list is additive-only under OpenCode: architect-only/read-only restrictions unenforced; every agent likely receives all 129 tool schemas |  |
| TOOLS-2 | HIGH | tools | drift | tool_filter.overrides '[] denies all tools' is documented but yields tools:{} which denies nothing |  |
| TOOLS-3 | HIGH | tools | unwired | knowledge.enabled=false unregisters 6 knowledge tools but AGENT_TOOL_MAP, the architect Available Tools block and a mandatory per-phase instruction still grant/require them |  |
| COMMANDS-3 | MEDIUM | commands | portability | /swarm ci-simulate hardcodes this repo's bun scripts, ships to all users, and is agent-invocable (worktree + subprocess) despite the stated no-subprocess policy |  |
| COMMANDS-4 | MEDIUM | commands | unwired | /swarm analyze emits [MODE: ANALYZE] that only the critic subagent's prompt consumes; the architect has no section and falls through |  |
| COMMANDS-5 | MEDIUM | commands | unwired | Seven bundled skills are materialized into every project but unreachable in OpenCode (no MODE stub, not in discovery roots, no file: reference) |  |
| COMMANDS-6 | MEDIUM | commands | drift | Help text and tool-policy describe swarm_command as read-only/no-subprocess, but 'agent' policy includes mutating and subprocess commands |  |
| CONFIG-2 | MEDIUM | config | bug | install() does not evict version-pinned cache dirs (opencode-swarm@<semver>) though documented as the upgrade path — AGENTS.md invariant 12 |  |
| CONFIG-3 | MEDIUM | config | drift | Documented config samples fail schema/JSON validation and trigger the guardrails-default recovery ladder when copied |  |
| CONFIG-4 | MEDIUM | config | bug | /swarm diagnose 'Config Parseability' and config-doctor inspect only the project (or a single) config; a corrupt user-level config is reported green |  |
| CONFIG-5 | MEDIUM | config | portability | Docs advertise an npm-only install path but the CLI bundle is Bun-only and crashes under Node |  |
| DOCS-10 | MEDIUM | docs | design | 595 pending release fragments accumulate forever while docs/index.md and the drift checker call them… |  |
| DOCS-2 | MEDIUM | docs | bug | docs/commands.md is mojibake-corrupted (94 double-encoded UTF-8 sequences) |  |
| DOCS-4 | MEDIUM | docs | portability | Documented npm-only install path still requires Bun (bin is a Bun-target bundle) |  |
| DOCS-5 | MEDIUM | docs | drift | README summaries.threshold_bytes default 102400; schema default 16384 |  |
| DOCS-6 | MEDIUM | docs | drift | README 'What This Does NOT Do' for the Context Budget Guard is contradicted by the hook (prunes, masks… |  |
| DOCS-7 | MEDIUM | docs | drift | README 'Default (reference)' context_budget block pins model_limits.default=128000 (not the default; caps 1M… |  |
| DOCS-8 | MEDIUM | docs | drift | README File Authority table does not match default rules (coder blocklist-based; architect blocked from… |  |
| EVIDENCE-10 | MEDIUM | evidence | drift | Recovery guide and evidence docs omit the evidence-gate recovery paths the code emits |  |
| EVIDENCE-3 | MEDIUM | evidence | security | req_coverage creates .swarm/evidence under caller-supplied `directory` with no root resolution (invariant 4) |  |
| EVIDENCE-5 | MEDIUM | evidence | unwired | phase_complete.regression_sweep.enforce: no producer, and the bundle schema strips the field the reader checks |  |
| EVIDENCE-6 | MEDIUM | evidence | unwired | Dead surfaces: todo_gate.* and check_gate_status.todo_scan have no producer; evidence.auto_archive has no consumer |  |
| EVIDENCE-7 | MEDIUM | evidence | bug | check_gate_status hand-parses the flat file and reports all_passed on evidence the zod readers reject (#2199 class) |  |
| EVIDENCE-8 | MEDIUM | evidence | design | phase_complete.enabled:false returns success but skips plan transition, phase_complete event and session reset |  |
| EVIDENCE-9 | MEDIUM | evidence | friction | Plan-free sessions cannot pass phase_complete under defaults (require_docs needs a loadable plan); plan-free branches unreachable |  |
| HOOKS-5 | MEDIUM | hooks | bug | Gate-output substring classifier includes('error') records passing gate tools as failures |  |
| HOOKS-6 | MEDIUM | hooks | design | Scope-guard denial advisory goes to the first architect session in map order, not the coder's parent |  |
| HOOKS-7 | MEDIUM | hooks | drift | Guardrails/knowledge/memory message-chain injections depend on host rendering of synthetic info.role:'system' entries the SDK type does not define |  |
| HOOKS-8 | MEDIUM | hooks | drift | docs/architecture.md hook table + stale-delegation text and the index.ts Full-Auto ordering comment describe a different chain |  |
| INIT-5 | MEDIUM | init | bug | clearDeferredWarnings() on every server() call wipes the only diagnostics channel for all instances |  |
| INIT-6 | MEDIUM | init | design | swarmState agent registries and other singletons are overwritten by the last-initialised directory |  |
| INIT-7 | MEDIUM | init | portability | bunSpawn Node fallback defaults stdin to 'pipe' where Bun defaults to 'ignore'; three tools spawn without stdin |  |
| INIT-8 | MEDIUM | init | unwired | No dispose hook: workers/streams cannot be stopped on instance teardown; process 'exit' listeners accumulate per init |  |
| INIT-9 | MEDIUM | init | perf | Each worktree-lane plugin instance replays the full post-init queue (repo-graph scan, orphan reaper, HTTP preflight) inside the worktree |  |
| KNOWLEDGE-10 | MEDIUM | knowledge | design | Fire-and-forget queueMicrotask audit writes (rewrite history, curation proposals) violate 'never defer work' |  |
| KNOWLEDGE-3 | MEDIUM | knowledge | unwired | Memory Task-output memoryProposals/curatorMemoryDecisions capture parses input.args: dead in prod |  |
| KNOWLEDGE-5 | MEDIUM | knowledge | bug | Memory disabled (default) still appends a run-log line + mkdir per LLM turn to .swarm/runs/<session>/memory.jsonl |  |
| KNOWLEDGE-6 | MEDIUM | knowledge | friction | Injector writes a not_architect skip event per non-swarm-agent turn (mkdir .swarm + append + full 5000-line re-read of knowledge-events.jsonl) |  |
| KNOWLEDGE-7 | MEDIUM | knowledge | unwired | Delegate directive injection allowlist omits explorer, researcher, docs_design, spec_writer, skill_improver, critic_* roles that hold knowledge_recall/receipt |  |
| KNOWLEDGE-8 | MEDIUM | knowledge | deadcode | Evergreen / low-utility quality signals have no producer: utility_score never written, thresholds unused |  |
| KNOWLEDGE-9 | MEDIUM | knowledge | drift | Dead config keys: curator.compliance_report, skill_generation_mode, min_skill_confirmations, summaries.retention_days (docs say they work) |  |
| MAIN-2 | MEDIUM | main | design | Five host hooks that map to open problems are never registered: permission.ask, tool.definition, shell.env, experimental_workspace.register, chat.params |  |
| MAIN-3 | MEDIUM | main | design | Post-resolution queue runs up to 11 detached tasks concurrently from one setTimeout(0) with no ordering, completion tracking, or surfacing beyond debug logs |  |
| MAIN-4 | MEDIUM | main | friction | config hook overwrites user-defined opencode.json agent blocks with Object.assign | yes |
| MAIN-6 | MEDIUM | main | unwired | package.json ships an empty binaries/ tree (only .gitkeep) as the Windows sandbox runner location; release workflow never builds runners/swarm-sandbox-runner | yes |
| MAIN-8 | MEDIUM | main | design | Stale bot auto-closes real defect issues (30d stale, 7d close; only pinned/security exempt) |  |
| MAIN-9 | MEDIUM | main | drift | `bun run build` rewrites the tracked opencode-swarm.schema.json under the locked zod 4.3.6 (anyOf vs type arrays, optional seconds, tuple constraint dropped); committed artifact drifts from generator output | yes |
| OBSERVABILITY-2 | MEDIUM | observability | unwired | Invariant-9 transient retry has no producer; guardrails max_transient_retries and legacy model_fallback_index are dead |  |
| OBSERVABILITY-3 | MEDIUM | observability | bug | Retry of a failed Task can resolve its model route as 'ambiguous' and run on the primary model |  |
| OBSERVABILITY-4 | MEDIUM | observability | friction | Task-path model fallback advances with no model_fallback telemetry or advisory |  |
| OBSERVABILITY-5 | MEDIUM | observability | bug | learning-health rehydrate regex excludes '-': fixture-share and hyphenated model scopes vanish after restart |  |
| OBSERVABILITY-6 | MEDIUM | observability | friction | Telemetry disable latch is permanent, invisible, and also kills heartbeat/'Last activity' |  |
| OBSERVABILITY-7 | MEDIUM | observability | drift | Three emit call sites use the 'kind as Parameters<typeof emit>[0]' force-cast #2029 outlawed; catalog cites them as producers |  |
| OBSERVABILITY-8 | MEDIUM | observability | design | Retention registry admits 16 unbounded .swarm streams as fix-in-issue #2309, open with no PR |  |
| OBSERVABILITY-9 | MEDIUM | observability | bug | #2409 unfixed: PR-monitor breaker set after awaited snapshot write, never trips when the store throws (cross-scope src/background) |  |
| PARALLEL-10 | MEDIUM | parallel | design | lean_turbo_acquire_locks has no release path and poisons lean_turbo_run_phase |  |
| PARALLEL-5 | MEDIUM | parallel | drift | `/swarm turbo lean on` with no `turbo` config: banner names an un-granted tool and the phase gate arms |  |
| PARALLEL-6 | MEDIUM | parallel | portability | Windows worktree-removal retry keys on errno names git never prints |  |
| PARALLEL-7 | MEDIUM | parallel | drift | lean_turbo_plan_lanes and lean_turbo_status ignore user turbo.lean config |  |
| PARALLEL-8 | MEDIUM | parallel | design | Epic promoted waves run in the shared primary tree with no worktree isolation or locks |  |
| PARALLEL-9 | MEDIUM | parallel | unwired | runtime_isolation lane env profile never reaches coder shell/test processes |  |
| PLAN-10 | MEDIUM | plan | perf | Every status update appends a full-plan snapshot (replay never derives phase.status); every loadPlan (each turn) re-parses the whole ledger; no compaction |  |
| PLAN-11 | MEDIUM | plan | design | save_plan identity, locked-profile and task-removal guards are keyed on plan.json readability; an unreadable projection disables all three |  |
| PLAN-5 | MEDIUM | plan | bug | manager.updateTaskStatus is an unlocked read-modify-write: concurrent callers revert each other's completions and the ledger records the reverts |  |
| PLAN-6 | MEDIUM | plan | bug | M1 silent-rollback guard missing from loadPlan's validation-failure and no-plan.json paths |  |
| PLAN-7 | MEDIUM | plan | bug | Snapshot payloads are replayed unvalidated; a parseable malformed snapshot makes rebuildPlan overwrite a valid plan.json with garbage |  |
| PLAN-8 | MEDIUM | plan | unwired | importCheckpoint has no production caller; docs and phase_complete guidance promise a recovery from .swarm/plan-export/ that nothing performs |  |
| PLAN-9 | MEDIUM | plan | drift | 'closed' task status is invisible in plan.md, reverts to pending on md->json migration, and phase derivation has no closed branch |  |
| PROMPTS-3 | MEDIUM | prompts | bug | issue-trace [MODE: X] tail system message is relocated to index 0 by consolidation; rule S only fires on 'the latest message' |  |
| PROMPTS-5 | MEDIUM | prompts | drift | Coder/architect prompts and bundled skills bake this plugin's own repo conventions into every user project |  |
| PROMPTS-6 | MEDIUM | prompts | unwired | Prompts mandate 'Emit JSONL event …' but no agent has an event tool; two named events are absent from the event contract |  |
| PROMPTS-7 | MEDIUM | prompts | unwired | Explorer told to write doc-manifest.json and knowledge/doc-constraints.jsonl while write:false and without knowledge_add; doc-constraints.jsonl has no producer |  |
| PRREVIEW-4 | MEDIUM | prreview | deadcode | Dead legacy circuit message still says 'stop without partial findings'; legacy shape kept in the state union |  |
| PRREVIEW-5 | MEDIUM | prreview | friction | pr_workflow_status never surfaces circuit state or wake suspension |  |
| PRREVIEW-6 | MEDIUM | prreview | drift | Tier-L micro guidance (one lane per family on every batch, 11 families) is unsatisfiable under MAX_LANES = 8 |  |
| REPOGRAPH-10 | MEDIUM | repograph | unwired | context_map post-agent update is called with files_touched: [] and task_goal: '' by its only caller, so file summaries are never populated and capsules always fall back to read_original |  |
| REPOGRAPH-3 | MEDIUM | repograph | perf | Every write tool re-serializes the whole graph (37 MB pretty JSON) plus a full fingerprint walk inside the awaited hook; the next turn re-parses and re-validates it synchronously |  |
| REPOGRAPH-4 | MEDIUM | repograph | portability | Workspaces past max_files (10k) or the 5 s walk budget are permanently 'inconclusive': startup never refreshes; a stale BFS-prefix graph is served until a manual build; Windows stat latency makes this common |  |
| REPOGRAPH-5 | MEDIUM | repograph | perf | Freshness probe (full readdir+stat walk, up to 5 s) runs inside the awaited system-prompt transform whenever its 30 s cache expires |  |
| SDK-1 | MEDIUM | sdk | bug | System enhancer injects swarm directives into host prompts with no sessionID (Agent.generate path) |  |
| SDK-2 | MEDIUM | sdk | test | Returned hooks literal never type-checked against Hooks; dead keys; a misspelled hook would ship silently |  |
| SDK-3 | MEDIUM | sdk | drift | #1899 freshness advisory is blind to patch skew: 1.18.3 vs 1.18.25 reports 0 behind |  |
| SDK-5 | MEDIUM | sdk | unwired | Automation framework ships as an admitted scaffold: user config keys and a started manager with no behavior |  |
| SECURITY-2 | MEDIUM | security | security | #2263 lane-env denylist leaves HOME/PATH/XDG_CONFIG_HOME open; commitAndPush spawns bare 'git' with lane env; chain unwired; CI guard misses it |  |
| SECURITY-3 | MEDIUM | security | perf | search fallback runs model-supplied regex synchronously with no timeout; packaged ripgrep is not a dependency |  |
| SECURITY-4 | MEDIUM | security | bug | Delegation sanitizer flattens whole gate-agent prompts and never fires for multi-swarm prefixed agents |  |
| TESTSCI-2 | MEDIUM | testsci | test | Quarantined tests never return: excluded on their OS while the exit criterion is a green streak on that OS; audit doc understates active quarantines |  |
| TESTSCI-3 | MEDIUM | testsci | test | Coverage gate counts only files some test imported and includes tests/helpers + tests/preload; never-imported src is invisible to the 65% floor |  |
| TESTSCI-4 | MEDIUM | testsci | test | 163 gated assertions bound live wall-clock elapsed time with literal ms values (down to 50 ms) on shared runners |  |
| TESTSCI-5 | MEDIUM | testsci | bug | check-test-clock / check-test-tmpdir lint raw lines: a comment with Date.now() blocks, a comment with 'freezeClock(' passes, contradicting the gate's own text |  |
| TESTSCI-6 | MEDIUM | testsci | drift | pr-standards.yml and check-pending-fragment.ts disagree on which paths need a release fragment (tests/,scripts/ vs .github/workflows/) |  |
| TESTSCI-7 | MEDIUM | testsci | portability | PR-tier blind spots: integration/coverage/smoke(Node repro-704/1873)/PHP/Rust are merge_group-only; 3-OS matrix skips src/utils, src/db, src/git, src/cli, src/hooks, src/config |  |
| TESTSCI-8 | MEDIUM | testsci | bug | Integration and coverage loops run bun test without the Bun #32056 keepalive or kill wrapper: an idle-loop hang bypasses --timeout and burns the job timeout |  |
| TESTSCI-9 | MEDIUM | testsci | unwired | AGENTS invariant 3 timeout requirement has no blocking gate: check-invariants Check 1 is advisory with violations hard-coded to 0 |  |
| TOOLS-4 | MEDIUM | tools | bug | getAgentConfigs fire-and-forget writes a new .swarm/evidence/agent-tools-init-<ts>.json on every plugin init: unvalidated root, unregistered retention, unbounded growth |  |
| TOOLS-5 | MEDIUM | tools | perf | Architect carries ~133 KB (~33k tokens) of tool description+schema per turn by default; repo_map alone 9.5 KB |  |
| TOOLS-6 | MEDIUM | tools | design | /swarm doctor tools is a tautology (two projections of TOOL_METADATA, config ignored) and cannot detect config-dependent gaps such as TOOLS-3 |  |
| COMMANDS-7 | LOW | commands | drift | docs/commands.md claims to list all subcommands but omits 29 registry commands; the drift command detector cannot see docs coverage |  |
| COMMANDS-8 | LOW | commands | drift | Init comment misstates bundled-sync bounds (per-directory, not total); per-directory rollback can leave cross-skill version skew |  |
| CONFIG-10 | LOW | config | design | Init writes .swarm/config.example.json (sync fs) into any directory OpenCode opens, with no project-root guard |  |
| CONFIG-6 | LOW | config | portability | OPENCODE_CONFIG_DIR honoured by the host but ignored by plugin config/prompt lookup, doctor, /swarm config and the CLI |  |
| CONFIG-7 | LOW | config | friction | install() rewrites opencode.json every run (JSONC comments stripped) and evicts caches unconditionally — open issue #2437 item 2 |  |
| CONFIG-8 | LOW | config | drift | Environment-variable reference table omits variables the code reads |  |
| CONFIG-9 | LOW | config | design | When only one of user/project config is corrupt, secure() wipes the valid file's guardrails section and mislabels recovery 'guardrails_defaults' |  |
| DOCS-11 | LOW | docs | drift | README: automation `manual` = no background automation, but plan_sync (default true)… |  |
| DOCS-12 | LOW | docs | drift | README first-run note says installer creates a project override; installer only prints an… |  |
| DOCS-13 | LOW | docs | drift | README says prm.max_trajectory_lines / escalation_enabled are unenforced; both are… |  |
| DOCS-14 | LOW | docs | drift | README guardrail table understates built-in per-agent profiles (architect uncapped… |  |
| DOCS-15 | LOW | docs | drift | sast_scan advertised as 68 rules / 8 languages; registry has 74 rules over 10 language ids |  |
| DOCS-16 | LOW | docs | drift | design-rationale.md asserts serial-only execution and a .swarm/history/ dir; v8… |  |
| DOCS-17 | LOW | docs | drift | modes.md cites update-task-status.ts:98-109 for the Tier-3 list; those lines are… |  |
| DOCS-18 | LOW | docs | friction | getting-started Step 2 runs /swarm diagnose inside a session before Step 3 opens OpenCode |  |
| DOCS-9 | LOW | docs | drift | README 'All Slash Commands' table omits ~40 non-deprecated registry commands |  |
| EVIDENCE-11 | LOW | evidence | drift | Phase status alias 'completed' accepted by schema but post-mortem checks only 'complete'; isPhaseComplete unused |  |
| EVIDENCE-12 | LOW | evidence | design | completion_verify gate is trivially satisfiable by the gated model (any 3+ letter word from an LLM-authored description, includes() match) |  |
| EVIDENCE-13 | LOW | evidence | friction | record_directive_override compares against optional plan.current_phase instead of getCurrentPhase; recovery path can dead-end |  |
| HOOKS-11 | LOW | hooks | security | 2h stale-session sweep re-bootstraps a live subagent as architect, bypassing scope-guard |  |
| HOOKS-12 | LOW | hooks | friction | Test-suite block regex misfires on directory args and is bypassed by `cd x && bun test` |  |
| HOOKS-9 | LOW | hooks | bug | agent-activity flush lock releases while a queued flush is still running |  |
| INIT-10 | LOW | init | friction | Unconditional stderr banner per server() call contradicts the repo's own TUI-corruption rule |  |
| INIT-11 | LOW | init | drift | Stale comments/docs about init and portability contracts |  |
| KNOWLEDGE-11 | LOW | knowledge | design | Knowledge/memory blocks inserted 'before the last user message' are hoisted to system index 0 by consolidation |  |
| KNOWLEDGE-12 | LOW | knowledge | drift | docs/knowledge.md drift: stale schema line and headroom regimes |  |
| KNOWLEDGE-13 | LOW | knowledge | portability | @xenova/transformers resolved from the plugin bundle location; user-side install location undocumented |  |
| MAIN-7 | LOW | main | friction | Installer edits the user's global OpenCode config to disable built-in explore/general agents for all sessions |  |
| OBSERVABILITY-10 | LOW | observability | drift | Contract drift the gates cannot catch: 4 kinds missing from KNOWN_TELEMETRY_KEYS, stale paths/counts/citations |  |
| OBSERVABILITY-11 | LOW | observability | bug | agent-activity: activeToolCalls has no eviction and the flush chain guard is dropped early |  |
| PARALLEL-11 | LOW | parallel | drift | Architect prompt says turbo.lean.worktree_isolation defaults to false; schema/constants/tests say true |  |
| PARALLEL-12 | LOW | parallel | design | Full-Auto unreadable-state marker is process-global; fullAutoEnabledInConfig is a dead field |  |
| PLAN-12 | LOW | plan | portability | Ledger append bypasses atomicWriteSwarmFile: no rename retry and the temp file leaks when rename throws (Windows EPERM/EBUSY) |  |
| PLAN-13 | LOW | plan | drift | docs/plan-durability.md and code headers describe behaviour the code lacks (close writes checkpoint; single quarantine file; event JSON shape; 50-event cadence) |  |
| PROMPTS-10 | LOW | prompts | drift | COMMAND NAMESPACE blocks in four prompts describe Claude Code ('CC') built-ins although the plugin runs inside OpenCode |  |
| PROMPTS-11 | LOW | prompts | design | Intra-prompt contradictions: reviewer 800-token budget vs mandatory multi-section output; coder forbidden from build/lint/tests yet granted build_check/lint/syntax_check |  |
| PROMPTS-12 | LOW | prompts | design | Researcher registered by default with web_search, which is config-gated on council.general.enabled (off); prompt misstates its tool set |  |
| PROMPTS-8 | LOW | prompts | drift | Bundled swarm skill tells OpenCode hosts to write .zcode/session/swarm-mode.md, a path nothing reads |  |
| PROMPTS-9 | LOW | prompts | drift | PROJECT CONTEXT checks for '{{...}}' but the fail-open sentinel is 'unresolved (run /swarm preflight)' |  |
| PRREVIEW-7 | LOW | prreview | drift | Child lanes must emit transcript rows only if their lane enables legacy compat, but the snapped flag is never shown to them |  |
| PRREVIEW-8 | LOW | prreview | test | No test covers prompt -> child learns ids -> submit accepted -> coverage credited; native adapter unsupplied in production |  |
| PRREVIEW-9 | LOW | prreview | friction | collect_lane_results wait:true defaults to a 30-minute blocking call with the default undisclosed |  |
| REPOGRAPH-12 | LOW | repograph | perf | test-impact map build is a fully synchronous, unbounded recursive walk plus readFileSync of every test file at tool time; isCacheStale statSyncs every map key on each load |  |
| REPOGRAPH-6 | LOW | repograph | drift | Docs say the repo graph is regex-only (TS/JS/Python) with no tree-sitter on the startup path, backed by a stub benchmark; the startup scan runs tree-sitter on every file |  |
| REPOGRAPH-7 | LOW | repograph | perf | safeMatches compiles a new tree-sitter Query per file per pattern (4/file, ~9 ms each) and never deletes it; WASM memory is retained |  |
| REPOGRAPH-8 | LOW | repograph | deadcode | Dead parallel stack and dead exports: sync buildWorkspaceGraph (+findSourceFiles/walkSyncInto), loadOrCreateGraph, saveIfDirty, markDirty, isGraphFresh, getSupportedLanguages/getInitializedLanguages/isGrammarAvailable have no production caller |  |
| REPOGRAPH-9 | LOW | repograph | portability | Core tree-sitter.wasm is copy-pinned in dist/lang/grammars while the --external web-tree-sitter runtime floats on ^0.25.0; the locateFile redirect exposes the LinkError the build script warns about |  |
| SDK-10 | LOW | sdk | friction | chat.message throws by design; host runs hooks via Effect.promise so the block surfaces as a defect, not a session error |  |
| SDK-6 | LOW | sdk | perf | Two zod runtimes bundled (4.1.8+4.3.6) crossing into host zod 4.1.8; descriptions survive only via the host's registry rebuild |  |
| SDK-7 | LOW | sdk | friction | 27 of 131 tools expose arguments with no description to the LLM |  |
| SDK-8 | LOW | sdk | drift | Stale '#1849 toolAfter has NO args': host-provided input.args ignored in favor of a bounded snapshot |  |
| SDK-9 | LOW | sdk | design | messages.transform chain also runs on the host's compaction pass, right after the turn generation is advanced |  |
| SECURITY-5 | LOW | security | deadcode | sanitizeInput is a dead export whose adversarial tests assert a defense production never applies |  |
| SECURITY-6 | LOW | security | security | deepMerge honors JSON "__proto__"; merged config keeps a hostile prototype for everything except git.binary |  |
| SECURITY-7 | LOW | security | drift | Docs claim macOS lanes run under sandbox-exec, but the executor is off by default and lane isolation never invokes it |  |
| SECURITY-8 | LOW | security | portability | Invariant-3 stragglers: spawns without timeout, stdin ignore, or explicit cwd |  |
| TESTSCI-10 | LOW | testsci | drift | Test docs drift: TESTING.md pipeline table and six cited test paths, delegation-gate split path, 'x4' shards, local coverage command, undocumented test:unit:ci |  |
| TESTSCI-11 | LOW | testsci | test | Neither ~1.09M lines of tests nor 17K lines of scripts/ gate code are type-checked; scripts/ is not linted |  |
| TESTSCI-12 | LOW | testsci | drift | Committed opencode-swarm.schema.json regenerates differently at HEAD; the byte-match detector only soft-warns (cross-scope: config lane) |  |
| TESTSCI-13 | LOW | testsci | bug | detect-release skips all CI for any merge-group HEAD message containing 'release-please--' or a 'chore(main): release' line |  |
| TESTSCI-14 | LOW | testsci | unwired | check-skill-assertions.ts (FR-002 pre-push check) has no package.json script, CI step or doc mention; only a soft-warn drift-check import |  |
| TOOLS-8 | LOW | tools | test | rebind_pr_feedback_head and lean_turbo_status tool bindings have no test coverage (invariant 11e) |  |
| TOOLS-9 | LOW | tools | drift | working_directory policy divergence: run_pr_feedback_stage_a reuses the arg name for a repo-relative subdirectory; declare_scope re-implements the validator with the path.sep-only traversal split the shared helper fixed |  |
| KNOWLEDGE-14 | INFO | knowledge | design | Opt-in defaults make src/memory (~21k lines), reflection, embeddings, PII and the enforce gate dead for every default user |  |
| OBSERVABILITY-12 | INFO | observability | design | Sequence half-landed: 50/55 kinds have no consumer, envelope computed then discarded per emit, no /swarm report |  |
| REPOGRAPH-11 | INFO | repograph | friction | 12 of 22 repo_map actions have no prompt/skill/command consumer while the 3,370-char, 19-arg schema is sent to 11 agents on every request |  |
| PORT-001 | high | portability | portability | Windows .cmd/.bat shims (and bare npm) are spawned without a shell in 6 code paths; Node>=20.12 rejects with EINVAL and Bun.spawn cannot execute them |  |
| PORT-002 | medium | portability | portability | Windows containment checks compare JS-realpathSync outputs case-sensitively; a caller path with different drive-letter/segment case is rejected fail-closed |  |
| PORT-003 | low | portability | portability | realpath API split (192 JS realpathSync vs 3 realpathSync.native): host-facing and identity paths derive from different canonicalisers (issue #2018 class), 8.3/junction forms can disagree |  |
| PORT-004 | low | portability | portability | build-check runs discovered commands through `cmd /c <string>` with default CRT quoting (no windowsVerbatimArguments, no /d /s, no token validation) |  |
| PORT-006 | medium | portability | portability | Direct node:child_process call sites bypassing bunSpawn/spawn-helper lack invariant-3 bounds (no timeout / stdin pipe / no cwd) |  |
| PORT-007 | low | portability | portability | CRLF-naive parsers: $-anchored (.+)/(.*) regexes over split('\n') lines of user-editable markdown stop matching on Windows CRLF input |  |
| PORT-008 | low | portability | portability | Recursive rmSync without maxRetries (0 of 21 sites) — Windows EBUSY/EPERM from AV/indexer aborts init-path orphan-worktree cleanup and reset-session on first try |  |
| PORT-009 | low | portability | portability | Mixed-separator path building: metrics.ts relative-path strip never matches on Windows (glob include/exclude diverges by platform); loop.ts and partition-common.ts build non-canonical paths |  |
| PORT-010 | low | portability | bug | Prefix containment without a separator (.swarm-evil passes) in evidence-check, req-coverage, check-gate-status — out of lane, route to security |  |
| PORT-011 | low | portability | portability | Directive predicate child env scrub omits Windows-essential variables (USERPROFILE, APPDATA, LOCALAPPDATA, PATHEXT, COMSPEC, ProgramFiles) |  |

### 3.2 Detail

#### PARALLEL-1 · CRITICAL · Lean Turbo phase gate needs a critic verdict nothing in production produces

Lane: parallel. Kind: unwired.

Evidence:

- `src/turbo/lean/phase-ready.ts:682` — `reason: 'Integrated critic approval missing or rejected',`
- `src/config/constants.ts:726` — `phase_critic: true,`
- `src/turbo/lean/index.ts:102` — `export { dispatchPhaseCritic } from './integration';`
- `docs/modes.md:518` — `Dispatch phase critic at `phase_complete` (read-only boundary review)`

Hypothesis: dispatchPhaseCritic (integration.ts:689) is the only writer of lean-turbo-critic.json and runState.lastCriticVerdict has no writer; the symbol exists only in the barrel export and a release fragment; phase-complete.ts:90 imports only verifyLeanTurboPhaseReady. Default phase_critic:true blocks every Lean Turbo phase_complete unless the flag is off or the file is hand-written (what the test does).

Verify: grep -rn dispatchPhaseCritic src .opencode .claude \| grep -v test → only integration.ts:689 + lean/index.ts:102; grep -rn lastCriticVerdict src → reads only; e2e: lean on → lean_turbo_run_phase → lean_turbo_review APPROVED → phase_complete blocked.

User impact: Lean Turbo on default config can never complete a phase; the error names a critic dispatch with no tool, command, or hook.

#### PRREVIEW-1 · CRITICAL · Default settlement path is unsatisfiable: child lanes are never told the batchId/laneId that submit_pr_review_result requires

Lane: prreview. Kind: unwired.

Evidence:

- `src/tools/submit-pr-review-result.ts:9` — `batchId: z.string().trim().min(1).max(120),`
- `src/hooks/pr-workflow-gate.ts:1937` — `record.batchId === input.batchId &&`
- `src/hooks/pr-workflow-gate.ts:1943` — `reason: `expected one exact child delegation, found ${preliminary.length}`,`
- `src/tools/dispatch-lanes.ts:5011` — `revision_digest: ${revisionDigest.token}`
- `src/tools/dispatch-lanes.ts:1215` — `const requestedBatchId = parsed.data.batch_id ?? makeBatchId();`
- `src/hooks/pr-workflow-gate.ts:16447` — `'missing structured receipt (legacy transcript adapter disabled)',`
- `src/background/pr-review-contract.ts:134` — `return value === true;`

Hypothesis: Injected contract block (dispatch-lanes.ts:5007-5019) carries mode, workflow_lane, pr_head_sha, revision_digest, declared_scope, caller_focus, assigned_item_ids, checklist - no batch id, no lane id. applyPrWorkflowPromptContract options (4884-4892) lack them; buildPrReviewContractCard() is zero-arg; the OUTPUT IDENTITY line (4766) names workflow_lane not lane.id; explorer.ts has no submit section; SKILL.md only says record the returned batch_id (911); omitted batch ids are generated (1215). submitPrReviewResult matches (subagentSessionId,batchId,laneId) exactly (1934-1943); tool args carry no describe hints. With the legacy flag unset a receipt-less lane fails closed at gate:16437-16448.

Verify: grep -n 'batch_id: \${\\|lane_id: \${' src/tools/dispatch-lanes.ts (none); grep -n submit_pr_review_result src/agents/explorer.ts (none); run executeDispatchLanesAsync mode swarm-pr-review:base with mocked promptAsync and dump body.parts[0].text (no batch id / lane.id); call executeSubmitPrReviewResult with laneId=workflow_lane -> 'expected one exact child delegation, found 0'. Check session title/system for an alternate injection path.

User impact: On a default install every base/micro lane settles 'missing structured receipt', coverage is NO_COVERAGE, the review ends INCOMPLETE with zero findings after spending all lane tokens.

#### COMMANDS-1 · HIGH · Architect delegation template cites SKILLS paths that exist only in this repo; the mandatory reference gate throws and bundled fallbacks are undiscoverable

Lane: commands. Kind: bug.

Evidence:

- `src/agents/architect.ts:641` — `SKILLS: file:.claude/skills/engineering-conventions/SKILL.md`
- `src/agents/architect.ts:530` — `Always provide `writing-tests` to test_engineer and `engineering-conventions` to coder + reviewer when those skills are present in the project.`
- `src/hooks/skill-propagation-gate.ts:629` — `return { valid: false, reason: 'skill file does not exist' };`
- `src/hooks/skill-propagation-gate.ts:680` — `from optional recommendation/scoring behavior and must run even when`
- `src/index.ts:3770` — `throw new Error(`
- `src/hooks/skill-propagation-gate.ts:239` — `export const SKILL_SEARCH_ROOTS = [`

Hypothesis: Three compounding causes: the prompt's only SKILLS examples (:641,649,651,659,674,681) point at .claude/skills/* which package.json#files never ships; validateExplicitSkillReferencesBefore blocks any nonexistent file: ref even with skillPropagation.enabled=false; and .swarm/bundled-skills is outside SKILL_SEARCH_ROOTS so the '## Available Skills' index never offers substitutes. :526 also tells consumers routing lives in .opencode/skill-routing.yaml (repo-only). A model copying its own template in a consumer project has the coder Task thrown; the SKILL_LOAD_FAILED recovery (:528) does not cover this gate-side throw.

Verify: In a tmp project without .claude/skills call validateExplicitSkillReferencesBefore(dir,{tool:'Task',agent:'architect',args:{prompt:'coder\nTASK: x\nSKILLS: file:.claude/skills/engineering-conventions/SKILL.md'}},{enabled:false}) -> blocked:true; grep '\.claude' package.json -> none.

User impact: Outside opencode-swarm, the first delegation that follows the prompt's example is rejected by the plugin itself.

#### COMMANDS-2 · HIGH · opencode-swarm-internal skills (bun:test, AGENTS.md, biome, package-check) are bundled into every consumer project and the prompt mandates injecting them

Lane: commands. Kind: design.

Evidence:

- `.opencode/skills/writing-tests/SKILL.md:11` — `# Writing Tests for opencode-swarm`
- `.opencode/skills/engineering-conventions/SKILL.md:14` — `**Authoritative source:** [`AGENTS.md`](../../../AGENTS.md) at the repo root and`
- `.opencode/skills/merge-queue-readiness/SKILL.md:18` — `The command runs fixed local gates: `bun run typecheck`, `bun run lint`, `bun run build`, then a full-batch `bun test`.`
- `src/config/skill-mirrors.ts:288` — `it must NOT carry this repo's internal references (AGENTS.md, bun/biome, docs/releases/pending, ZaxbyHub)`

Hypothesis: The repo states the portability rule for commit-pr (skill-mirrors.ts:288) but writing-tests (29 'bun' hits, bun:test-only), engineering-conventions (4 AGENTS.md, 5 biome), running-tests, ci-fix-monitor (4 package-check), merge-queue-readiness, test-file-split violate it and ship via BUNDLED_PROJECT_SKILLS (bundled-skills.ts:32-34,40,42,45). ../../../AGENTS.md resolves to <project>/AGENTS.md (absent). After sync they are 'present in the project', architect.ts:530 mandates injecting them, and audience swarm-plugin always matches: a Go project's test_engineer can be told 'All tests use bun:test only'.

Verify: for s in writing-tests engineering-conventions running-tests ci-fix-monitor merge-queue-readiness test-file-split; do grep -c 'opencode-swarm\\|\bbun\b\\|AGENTS.md\\|biome\\|package-check' .opencode/skills/$s/SKILL.md; done; then follow ../../../AGENTS.md from a consumer's .swarm/bundled-skills/engineering-conventions/.

User impact: Consumers receive ~140KB of another repository's CI/invariant rules; subagents may apply the wrong test framework; links dangle.

#### CONFIG-1 · HIGH · install() silently replaces an unparseable opencode.json, destroying the user's providers/MCP/plugin config

Lane: config. Kind: bug.

Evidence:

- `src/cli/index.ts:269` — `function loadJson<T>(filepath: string): T \| null {`
- `src/cli/index.ts:281` — `return null;`
- `src/cli/index.ts:308` — `opencodeConfig = {};`
- `src/cli/index.ts:350` — `saveJson(OPENCODE_CONFIG_PATH, opencodeConfig);`
- `docs/getting-started.md:130` — `the installer may have failed. Retry `bunx opencode-swarm install`.`

Hypothesis: loadJson() collapses every parse failure to null (catch at 280-282); install() treats null as 'no file' and unconditionally saveJson()s a fresh object. A UTF-8 BOM (Windows editors/PowerShell 5), UTF-16, or any syntax error wipes the whole OpenCode config (provider API keys, mcp, other plugins) with no backup. uninstall() distinguishes malformed vs missing (631-645); install() does not; uninstall.test.ts:149 covers malformed input, install.test.ts has no such test.

Verify: printf '\xEF\xBB\xBF{"provider":{"a":{"options":{"apiKey":"S"}}},"plugin":["other"]}' > $X/opencode/opencode.json; XDG_CONFIG_HOME=$X XDG_CACHE_HOME=$Y bun src/cli/index.ts install; cat $X/opencode/opencode.json → only plugin+agent keys remain (reproduced).

User impact: Following the docs' 'retry install' advice with a BOM/typo in opencode.json loses all provider credentials, MCP servers and other plugins, with no warning.

Pre-verification (main thread): Explorer reproduced in isolated XDG dirs; main thread has not re-run it.

#### DOCS-1 · HIGH · Docker/LLM-operator install docs install non-existent npm package `opencode`

Lane: docs. Kind: bug.

Evidence:

- `docs/installation-linux-docker.md:220` — `npm i -g bun opencode opencode-swarm`
- `docs/installation-linux-docker.md:254` — `RUN npm i -g bun opencode opencode-swarm`
- `docs/installation-llm-operator.md:225` — `npm i -g bun opencode opencode-swarm`

Hypothesis: OpenCode CLI is published as `opencode-ai`; `opencode` is E404, so the Windows-via-Docker path, the Dockerfile and runbook Procedure C fail at step one.

Verify: npm view opencode -> 404; npm view opencode-ai version -> 1.18.25 (checked this session).

User impact: Docker/Windows users and any LLM running the runbook stop at `npm error 404`.

Pre-verification (main thread): Explorer checked npm: `opencode` 404, `opencode-ai` exists.

#### DOCS-3 · HIGH · README says architect is auto-selected on first run; default is manual, so first task silently bypasses the…

Lane: docs. Kind: drift.

Evidence:

- `README.md:162` — `First-run auto-configuration (architect selected automatically)`
- `README.md:207` — `[Swarm] Welcome! Architect auto-selected.`
- `README.md:51` — `If the active OpenCode agent is not a Swarm architect, the plugin workflow is bypassed.`

Hypothesis: auto_select_architect defaults false; installer never writes it (no hit in src/cli/index.ts); no 'auto-selected' string in src. Quick Start + demo storyboard describe a nonexistent default…

Verify: grep -n auto_select_architect src/cli/index.ts (none); grep -rn 'auto-selected' src (none); fresh install -> active…

User impact: First prompt runs in OpenCode's default agent: no gates, no reviewers, no explanation.

Pre-verification (main thread): grep confirms no auto_select reference in src/cli/index.ts; schema default not yet read.

#### EVIDENCE-1 · HIGH · requirements_reconstruction sentinel from repair_gate_evidence is never consumed; repaired task can never complete

Lane: evidence. Kind: bug.

Evidence:

- `src/evidence/task-gate-repair.ts:557` — `required_gates: [TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL],`
- `src/gate-evidence.ts:818` — `const combined = [...new Set([...(existingGates ?? []), ...newGates])];`
- `src/gate-evidence.ts:485` — `requiredGates.every((gate) => gates[gate] != null)`
- `docs/architecture.md:582` — `otherwise the reconstruction sentinel requires all gates to run again`

Hypothesis: Gates only union; only a gate literally named requirements_reconstruction could satisfy it and grep finds no producer/consumer outside gate-evidence.ts:108/316 and the repair module. A second repair is refused (task-gate-repair.ts:754 REPAIR_NOT_REQUIRED).

Verify: grep -rn requirements_reconstruction src --include=*.ts \| grep -v test; scratchpad/verify/evidence-lane.ts section A: after coder+stage_a+reviewer+test_engineer, hasPassedAllGates=false, state reviewer_run, task_completed throws TASK_WORKFLOW_QA_REQUIRED.

User impact: After repairing evidence with no receipt, every gate passes yet update_task_status(completed) is refused forever; only /swarm close forced completion or forbidden hand-edits exit.

#### EVIDENCE-2 · HIGH · req_coverage reads 'diff' evidence with files_changed that nothing writes; every FR 'missing', #2242 preflight gate always fails

Lane: evidence. Kind: unwired.

Evidence:

- `src/tools/req-coverage.ts:242` — `(entryItem as Record<string, unknown>).type === 'diff'`
- `src/tools/req-coverage.ts:396` — `if (searchedFiles.length === 0) {`
- `src/services/preflight-service.ts:930` — `if (missingCount > 0) {`
- `src/agents/critic.ts:425` — `if status is "missing" → CRITICAL severity (hard blocker)`

Hypothesis: grep -rn "files_changed\\|type: 'diff'" src --include=*.ts \| grep -v test hits only the schema and req-coverage. No touched files => all FRs missing; docs/releases/pending/2242-req-coverage-gate-hardening.md makes missingCount>0 a preflight failure.

Verify: Scratch section E (real review bundle -> readTouchedFiles []). Write .swarm/spec.md 'FR-001: MUST retry', run req_coverage -> coveredCount 0.

User impact: Any spec with FR-### yields an always-red report, failing preflight, and critics escalating every MUST to CRITICAL.

#### EVIDENCE-4 · HIGH · incremental_verify hook only runs when execution_mode==='strict' (default balanced); docs/README present it as on by default

Lane: evidence. Kind: drift.

Evidence:

- `src/index.ts:4403` — `if (execMode === 'strict') {`
- `src/index.ts:4406` — `await incrementalVerifyHook.toolAfter(input, output);`
- `src/config/schema.ts:3492` — `.default('balanced')`
- `docs/configuration.md:337` — `\| `enabled` \| boolean \| `true` \| Enable/disable the hook \|`
- `src/hooks/incremental-verify.ts:171` — `if (input.tool !== 'Task') return;`

Hypothesis: Hook is built whenever enabled!==false (index.ts:2181) but invoked only in strict mode; configuration.md:333-341 and README.md:828 never mention execution_mode; no test covers the gating. Secondary: case-sensitive 'Task' where index.ts:4063-4064 hedges for 'task'; module Set emittedSkipAdvisories (L31) has no eviction (invariant 8).

Verify: Scratch section D (default balanced). grep -n incrementalVerifyHook src/index.ts -> only inside the strict branch. grep -rl incremental_verify tests/unit \| xargs grep -l execution_mode -> none.

User impact: Users configuring incremental_verify.command never see POST-CODER CHECK advisories.

#### HOOKS-1 · HIGH · experimental.session.compacting wrapper calls undefined when hooks.compaction=false

Lane: hooks. Kind: bug.

Evidence:

- `src/index.ts:3595` — `compactionHook['experimental.session.compacting'] as (`
- `src/hooks/compaction-customizer.ts:181` — `const enabled = config.hooks?.compaction !== false;`
- `src/hooks/compaction-customizer.ts:184` — `return {};`
- `src/config/schema.ts:246` — `compaction: z.boolean().default(true),`

Hypothesis: Factory returns {} when disabled; the index.ts wrapper is a raw async (no safeHook, no guard) that always invokes the key -> TypeError on every compaction. No test drives the composed key with compaction:false.

Verify: initializeOpenCodeSwarm with hooks.compaction=false; await hooks['experimental.session.compacting']({sessionID:'s'},{context:[]}) -> rejects 'is not a function'.

User impact: Disabling compaction facts makes the plugin throw at every compaction; compaction may fail or the session wedge at the limit.

Pre-verification (main thread): Source-confirmed: compaction-customizer.ts:181-184 returns {} when disabled; index.ts:3586-3600 invokes the key unconditionally.

#### HOOKS-2 · HIGH · Loop detector compares raw tool name to 'Task' while the host id is lowercase 'task' -> LOOP DETECTED / CIRCUIT BREAKER never fire

Lane: hooks. Kind: unwired.

Evidence:

- `src/hooks/guardrails/tool-before.ts:1719` — `if (tool !== 'Task') return;`
- `src/hooks/loop-detector.ts:28` — `if (toolName !== 'Task') {`
- `src/config/constants.ts:403` — `'task',`
- `src/hooks/delegation-gate.ts:3381` — `(normalized !== 'Task' && normalized !== 'task') \|\|`

Hypothesis: The plugin elsewhere assumes lowercase `task` (SUMMARIZER_EXEMPT_TOOL_NAMES, event-stream `partTool === 'task'` at index.ts:2599, delegation-gate dual check) but handleLoopDetection/detectLoop match only 'Task', so the loop window is never populated and the 3x warning / 5x breaker are dead; tests only send 'Task'. Secondary: messages-transform.ts:575 passes _input.sessionID (input is {}) to telemetry.loopDetected.

Verify: Confirm host id (opencode Tool.define('task'); tests/unit/index-delegation-telemetry-restart-recovery.test.ts drives index.ts with tool:'task'). createGuardrailsHooks(dir,cfg).toolBefore({tool:'task',...},{args:{subagent_type:'coder',prompt:'x'}}) x5 -> no CIRCUIT BREAKER.

User impact: Identical re-delegation loops run with no brake; docs/configuration.md loop-containment claims partly dead.

Pre-verification (main thread): Host tool id confirmed lowercase "task" (packages/opencode/src/tool/task.ts); normalizeToolName never changes case; tool-before.ts:2288 passes raw input.tool.

#### HOOKS-3 · HIGH · registerPendingTaskModelRoute gated on tool === 'Task' -> child model override/fallback chain unreachable

Lane: hooks. Kind: unwired.

Evidence:

- `src/index.ts:3906` — `(normalizeToolName(input.tool) ?? input.tool) === 'Task' &&`
- `src/index.ts:4091` — `const isTaskTool = normalizedTool === 'Task' \|\| normalizedTool === 'task';`
- `src/models/task-model-routing.ts:280` — `if (!route) return { status: 'missing' };`

Hypothesis: Only production caller (index.ts:3914) sits behind an exact 'Task' compare while toolAfter accepts both casings. With a lowercase host id no route is registered, so resolveTaskChatModelOverride returns 'missing' for every child: no per-role override, no fallback advance on session.error, MODEL_FALLBACK_EXHAUSTED unreachable. Routing is only unit-tested in isolation.

Verify: Drive index.ts tool.execute.before with {tool:'task'} + args {subagent_type:'coder',prompt:'x'}; getPendingTaskModelRouteSnapshot() -> []. With 'Task' -> 1 entry.

User impact: Configured fallback_models for subagents never engage on provider 429/503.

Pre-verification (main thread): Same host-id evidence as HOOKS-2; src/index.ts:3906 compares === 'Task'.

#### HOOKS-4 · HIGH · PARTIAL GATE VIOLATION one-shot latch is consumed before any gate can run (turn 1 and right after coder dispatch)

Lane: hooks. Kind: bug.

Evidence:

- `src/hooks/guardrails/messages-transform.ts:893` — `const taskId = getCurrentTaskId(sessionId);`
- `src/hooks/guardrails/messages-transform.ts:952` — `session.partialGateWarningsIssuedForTask.add(taskId);`
- `src/hooks/guardrails/messages-transform.ts:1113` — `return session?.currentTaskId ?? `${sessionId}:unknown`;`
- `tests/unit/hooks/guardrails.test.ts:2054` — `// Populate gateLog so PARTIAL GATE VIOLATION check does not fire`

Hypothesis: No completion signal is checked: on turn 1 taskId is `<sid>:unknown`, gateLog empty, reviewerCallCount 0, so the warning fires and latches; at coder dispatch it fires again for the real task and latches before any gate ran, so it can never fire when the task is actually closed without gates. Tests pre-populate gateLog under '<sid>:unknown' to silence it.

Verify: startAgentSession('s','architect'); activeAgent.set('s','architect'); messagesTransform({},{messages:[{info:{role:'assistant',sessionID:'s'},parts:[{type:'text',text:'hi'}]}]}) -> contains 'PARTIAL GATE VIOLATION'; set currentTaskId='T1' -> fires again; later gates -> never again.

User impact: Spurious 'missing gates' injection every session and after every dispatch; the intended late detection is structurally defeated.

#### INIT-1 · HIGH · ensureSwarmGitExcluded latch is process-global: 2nd directory in one OpenCode process is never git-excluded

Lane: init. Kind: bug.

Evidence:

- `src/utils/gitignore-warning.ts:45` — `export let _swarmGitExcludedChecked = false;`
- `src/utils/gitignore-warning.ts:232` — `if (_swarmGitExcludedChecked) return;`
- `src/config/lane-permissions.ts:15` — `The plugin `config` hook runs once per OpenCode instance (`Plugin.state` is`

Hypothesis: Flag keyed by process, not directory (index.ts:873 relies on it as dedup): every instance after the first (worktree lane, second tab) skips the exclude while init still creates .swarm/ there — invariant 4.

Verify: node --trace-sync-io scratchpad/init-trace.mjs (server() for two `git init` dirs in one process) prints 'A exclude has .swarm: true' then 'B exclude has .swarm: false; .swarm: advisories,bundled-skills,config.example.json,...'; no 'at ensureSwarmGitExcluded' frame after the server(B) marker.

User impact: git status shows .swarm/ in the second project/lane; it can be committed.

Pre-verification (main thread): Explorer reproduced with a three-instance Node harness (init-trace.out); main thread has not re-run it.

#### INIT-2 · HIGH · initTelemetry latches on the first directory; later instances write telemetry to the wrong project

Lane: init. Kind: bug.

Evidence:

- `src/telemetry.ts:298` — `if (_writeStream !== null \|\| _disabled) {`
- `src/telemetry.ts:303` — `_projectDirectory = projectDirectory;`
- `src/index.ts:1096` — `initTelemetry(ctx.directory);`

Hypothesis: Stream and _projectDirectory are singletons set by the first init only; a second project's delegation/cost events append to the first project's .swarm/telemetry.jsonl; one stream error disables telemetry process-wide.

Verify: Same harness: A lists telemetry.jsonl, B does not. Delegate in B, grep B's session id in A/.swarm/telemetry.jsonl; /swarm costs in B is empty.

User impact: Cost/delegation records misattributed or missing in every project opened after the first.

Pre-verification (main thread): Explorer reproduced (no telemetry.jsonl in second workspace); main thread has not re-run it.

#### INIT-4 · HIGH · node:sqlite adapter run(sql) returns undefined but callers read .changes — /swarm link migration throws on the Node sidecar

Lane: init. Kind: portability.

Evidence:

- `src/db/sqlite-loader.ts:117` — `return undefined;`
- `src/memory/memory-family-migration.ts:320` — `merged += result.changes ?? 0;`
- `src/memory/memory-family-migration.ts:325` — `if (table === 'memory_outcomes') throw err;`
- `src/commands/memory-link.ts:179` — `const result = await migrateMemoryFamily(cohortRoot, localRoot);`

Hypothesis: bun:sqlite run() returns {changes}; the adapter's no-param path (sqlite-loader.ts:115-117; comment :110 'Callers ignore the return value') returns undefined, so migrateMemoryFamily (uses loadDatabaseCtor at :232) throws per table and memory_outcomes rethrows — /swarm link\|unlink fail under Node. sqlite-provider.ts:2277 silently logs 0. repro-1873-entry.ts does not export migrateMemoryFamily.

Verify: With the fake DatabaseSync from src/db/sqlite-loader.test.ts: new (createNodeDatabaseCtor(Fake))(':memory:').run('CREATE TABLE t(x)') === undefined; or bundle an entry exporting migrateMemoryFamily --target node and run under node 22 with a non-empty destination DB.

User impact: Desktop (Node) users: /swarm link fails with 'Cannot read properties of undefined (reading changes)'.

#### KNOWLEDGE-1 · HIGH · Hive promoter runs a full promotion transaction on every tool call (git x2, receipt-ledger lock, hive lock)

Lane: knowledge. Kind: perf.

Evidence:

- `src/index.ts:4385` — `if (hivePromoterHook) await safeHook(hivePromoterHook)(input, output);`
- `src/hooks/hive-promoter.ts:816` — `The hook fires unconditionally - the caller decides when to invoke it.`
- `src/hooks/hive-promoter.ts:282` — `const sourceCohort = await _internals.resolveCohortId(directory);`
- `src/hooks/hive-transaction.ts:191` — `release = await _internals.lockfile.lock(dataDir, {`

Hypothesis: No tool-name or cadence gate in the hook or its caller. Each read/grep/bash by any agent pays resolveCohortId (uncached execFile git x2, 1.5s timeout each; cohort-identity.ts:43,283), loadPromotionEvidence -> queryHistoricalOutcomes -> runLocked (receipt lock + full journal replay + archive parse; knowledge-receipt-ledger.ts:1557,3566), then transactHiveStore (mkdir + platform-dir lock + read shared-learnings.jsonl) even on noop. Injector uses ensureCohortIdCached; promoter does not.

Verify: Count _internals.resolveCohortId/transactHiveStore calls while driving src/index.ts tool.execute.after with tool:'read' N times (harness: tests/integration/knowledge-real-host-boundary.test.ts); expect N each. grep -n 'cooldown\\|lastRun' src/hooks/hive-promoter.ts (none).

User impact: Two git spawns, three file parses and two cross-process locks per tool call; worst on Windows cold FS; parallel delegates contend on the global hive and receipt locks.

#### KNOWLEDGE-2 · HIGH · Knowledge-curator write trigger reads input.args the host never supplies: plan.md retro / evidence curation dead in prod

Lane: knowledge. Kind: unwired.

Evidence:

- `src/hooks/knowledge-curator.ts:306` — `const inputArgs = isRecord(input.args) ? input.args : null;`
- `src/hooks/host-boundary.ts:152` — `SDK `tool.execute.after` input has no `args` field and the output carries only `title`/`output`/`metadata``
- `src/index.ts:4383` — `if (knowledgeCuratorHook) await safeHook(knowledgeCuratorHook)(input, output);`
- `tests/unit/hooks/knowledge-curator.test.ts:103` — `args: {`

Hypothesis: normalizeWriteTrigger derives filePath only from input.path/input.args/output.args; index.ts passes the raw SDK input/output and knowledge-curator.ts never calls getStoredInputArgs(callID) as #1849 did for the ack/verdict collectors (index.ts:4132). Every real write returns null: '### Lessons Learned' extraction, RETRACT:/BAD RULE: processing and the evidence-file trigger never fire. phase_complete/close still call curateAndStoreSwarm, so loss is partial, but the hook is unwired code (CLAUDE.md directive 2).

Verify: grep -n getStoredInputArgs src/hooks/knowledge-curator.ts (none). Drive index.ts tool.execute.after with {tool:'write',sessionID,callID} + output {title,output,metadata} after a plan.md write with a Lessons Learned section; assert knowledge.jsonl unchanged.

User impact: Retro lessons and RETRACT: lines in plan.md are silently never curated.

#### KNOWLEDGE-4 · HIGH · Run-memory summary (#2115) only injected when knowledge search returns entries; coder never receives it

Lane: knowledge. Kind: bug.

Evidence:

- `src/hooks/knowledge-injector.ts:1260` — `if (filteredEntries.length === 0) {`
- `src/hooks/knowledge-injector.ts:1341` — `runMemory = await getRunMemorySummary(directory);`
- `src/services/run-memory.ts:365` — `'[FOR: architect, coder]\n## RUN MEMORY — Previous Task Outcomes\n';`

Hypothesis: The empty-retrieval branch returns before getRunMemorySummary runs, so a project with an empty or fully-filtered knowledge store never gets its failure history, which is the cold-start case run memory exists for. The block is only built on the architect path, so the coder addressee is never honored.

Verify: Seed .swarm/run-memory.jsonl with a fail entry and empty knowledge.jsonl; run createKnowledgeInjectorHook with searchKnowledge mocked to []; assert no 'RUN MEMORY' text. grep getRunMemorySummary in injectForDelegate (none).

User impact: Architect repeats known failures on fresh projects.

#### MAIN-1 · HIGH · No `dispose` hook: interval workers, automation manager and a per-load process.on('exit') listener survive OpenCode instance disposal/reload; module-level swarmState is shared across instances

Lane: main. Kind: bug. Duplicates merged: SDK-4.

Evidence:

- `src/index.ts:2424` — `process.on('exit', cleanupAutomation);`
- `src/background/pr-monitor-worker.ts:201` — `this.pollTimer = setInterval(() => {`
- `src/background/plan-sync-worker.ts:265` — `this.pollTimer = setInterval(() => {`
- `src/state.ts:896` — `export const swarmState = {`
- `node_modules/@opencode-ai/plugin/dist/index.d.ts:171` — `dispose?: () => Promise<void>;`

Hypothesis: The host (anomalyco/opencode packages/opencode/src/plugin/index.ts) loads plugins per Instance and calls hooks.dispose?.() in a finalizer when the instance is disposed; the plugin never registers dispose (grep count 0 in src/index.ts), so on instance reload or multi-project Desktop the pollers, automation manager and exit listeners accumulate and module-level state (activeAgent, agentSessions, opencodeClient) is shared/overwritten across projects.

Verify: grep -n "dispose" src/index.ts (expect 0); write a script that calls the default export server() twice with different directories in one process and count process.listenerCount('exit') and running intervals (process.getActiveResourcesInfo()); read src/state.ts:896-1000 for directory-scoping.

User impact: Desktop users with two projects or a plugin reload get duplicated PR-monitor/plan-sync polling, cross-project state bleed, and a process that cannot exit cleanly.

Pre-verification (main thread): Source-confirmed: no dispose registration; process.on('exit') at index.ts:2424; two setInterval workers; host calls hooks.dispose in an instance finalizer (plugin/index.ts).

#### MAIN-5 · HIGH · Default subagent models are Zen ids that are legacy (minimax-m2.5-free) or paid (gpt-5-nano) while README claims a free tier; preflight only warns post-resolution and is silent when the catalog is unavailable

Lane: main. Kind: friction.

Evidence:

- `src/config/constants.ts:418` — `coder: 'opencode/minimax-m2.5-free',`
- `src/config/constants.ts:420` — `test_engineer: 'opencode/gpt-5-nano',`
- `README.md:48` — `Free tier — works with OpenCode Zen's free model roster`
- `src/index.ts:1141` — `if (!result.catalogAvailable) return;`
- `src/services/diagnose-service.ts:1284` — `if (getDeferredWarnings().length > 0) {`

Hypothesis: models.dev (anomalyco/models.dev dev branch providers/opencode/models) marks minimax-m2.5-free.toml 'Legacy model retained for compatibility with older integrations' and prices gpt-5-nano at $0.05/$0.40 per 1M. A fresh install with no agents config dispatches coder/test_engineer/critic variants/curators to these ids; if the user has no Zen provider auth every delegation fails 'Model not found'/'Forbidden' and the only warning is a post-init console.warn or /swarm diagnose.

Verify: Read src/config/constants.ts:410-460; fetch the two toml files; read src/services/model-preflight.ts and src/index.ts:1138-1170; check whether the TUI surfaces console.warn from plugin init (journey lane).

User impact: Out-of-the-box delegation fails or bills the user despite the free-tier claim; the diagnosis is hidden.

Pre-verification (main thread): models.dev toml files confirm minimax-m2.5-free is marked legacy and gpt-5-nano is priced; preflight is warn-only (index.ts:1138-1170).

#### OBSERVABILITY-1 · HIGH · Transient regex matches bare digit substrings: permanent errors become retry_same and advance model fallback

Lane: observability. Kind: bug.

Evidence:

- `src/utils/provider-error-classification.ts:43` — `/rate.?limit\|429\|500\|502\|503\|504\|529\|timeout\|overloaded\|model.?not.?found\|`
- `src/utils/provider-error-classification.ts:28` — `const match = errorMsg.match(/\b(408\|429\|500\|502\|503\|504\|529)\b/);`
- `src/failures/invocation-failure.ts:409` — `TRANSIENT_MODEL_ERROR_PATTERN.test(signal)`

Hypothesis: extractStatusCode uses \b but the shared pattern does not, so any digit run containing 429/50x/529 (token counts, request ids) is transient, and this branch (:409) precedes the context_window branch (:422). 'prompt is too long: 215037 tokens > 200000 maximum' -> provider.unavailable/retry_same; '210037 tokens' -> provider.unknown/do_not_retry. dispatchWithModelFallback then retries with backoff and walks every fallback; index.ts:2684 advances the Task-route chain.

Verify: bun script importing classifyProviderFailure with the 215037 string and {message:'Invalid request (req_5031abc)',status:400}: both provider.unavailable/retry_same (scratchpad/probe2.ts); provider-error-classification.test.ts has no digit-boundary case.

User impact: Context overflow on a long run burns retries, cycles every fallback model, and silently switches the role's next Task to a fallback although the primary was healthy.

Pre-verification (main thread): Explorer reproduced with a probe script against the classifier (215037 tokens -> retry_same); main thread has not re-run it.

#### PARALLEL-2 · HIGH · Windows native sandbox runner unreachable from the published package

Lane: parallel. Kind: unwired.

Evidence:

- `src/sandbox/win32/runner-client.ts:137` — `path.resolve(_runtimeDir, '..', '..', '..', 'binaries',`
- `src/sandbox/win32/runner-client.ts:23` — `const _runtimeDir = fileURLToPath(new URL('.', import.meta.url));`
- `.github/workflows/ci.yml:967` — `- name: Build release binary`

Hypothesis: binaries/win32-* hold only .gitkeep (package.json:40 ships the dir); the merge-queue-only rust job builds the exe but never copies/uploads it; release-and-publish.yml has no cargo step; no doc mentions the binary. Runtime JS is the single dist/index.js (dist/sandbox/win32/ has only .d.ts), so the lookup resolves to <pkg>/../../binaries; only a PATH `where` hit works. Latent: _wrapWithRunner cmd /c quoting and scopePaths[0] (a file) as workspace root.

Verify: ls binaries/*/; grep -rn binaries .github/workflows/; ls dist/sandbox/win32/; path.resolve('<pkg>/dist','..','..','..','binaries'); on Windows probe() from the installed package → 'runner binary not found'.

User impact: Windows never gets the advertised native sandbox; strict Full-Auto sandbox binding and sandbox.mode:required are unattainable.

#### PARALLEL-3 · HIGH · Init orphan recovery from a second OpenCode process can delete a live Lean lane with uncommitted work

Lane: parallel. Kind: bug.

Evidence:

- `src/hooks/init-orphan-recovery.ts:422` — `const activeSessionIds = Array.from(swarmState.agentSessions.keys());`
- `src/hooks/init-orphan-recovery.ts:331` — `_internals.rmSync(worktreePath, { recursive: true, force: true });`
- `src/turbo/lean/runner.ts:1580` — `// Release locks for the completed lane`
- `src/index.ts:1196` — `void runInitOrphanRecovery(ctx.directory).catch(`

Hypothesis: Lean lanes use shared provisionWorktree (turbo/lean/worktree.ts:98) without a durable owner, so the protected set (init-orphan-recovery.ts:686-706) never includes them; the only cross-process guard is listActiveLocks, but lane locks are released at lane completion while merge-back waits for Promise.all of all lanes (runner.ts:677). A second process initialising in that window treats the lane as orphan; non-force `git worktree remove` refuses the dirty tree and rmSync deletes it.

Verify: Unit: dirty registered lane under <parent>/.swarm-worktrees/<sid>/lane-1, empty swarmState, no locks/owners → runInitOrphanRecovery(dir) → assert rmSync. Manual: 2-lane Lean phase; after lane-1 finishes start a second `opencode` → lane-1 gone.

User impact: Silent loss of finished coder work and a failed phase when a second OpenCode instance opens the project mid-phase.

#### PARALLEL-4 · HIGH · v8 parallel-first (#1674) degrades to serial under default prompts (just-in-time scope declaration)

Lane: parallel. Kind: design.

Evidence:

- `src/plan/parallel-verdict.ts:25` — `Fail-closed: a missing/malformed scope → `unknown_scope`, which conflicts`
- `src/hooks/delegation-gate.ts:2696` — `if (pendingTaskIds.length < 2) return false; // nothing to parallelize`
- `src/agents/architect.ts:221` — `3a. PRE-DELEGATION SCOPE CALL (required): BEFORE every {{AGENT_PREFIX}}coder delegation`
- `src/hooks/delegation-gate.concurrency.test.ts:26` — `#1674 v8: write disjoint declared scope files so the gate's inline verdict`

Hypothesis: The gate needs a live scope file for EVERY pending task of the active phase at each coder dispatch, but Rules 1a/3a declare one task's scope right before its delegation and no default prompt, execute skill, or doc instructs up-front declaration (only EPIC_MODE_BANNER does). The fallback advisory (delegation-gate.ts:2611) says run plan_conflict_check or proceed serially; docs/modes.md:256 promises concurrent-by-default; tests pre-write every scope file.

Verify: Plan with 3 pending tasks, only scope-1.1.json present → buildParallelExecutionGuidance via _internals → 'SERIAL fallback active'; grep -n -iE 'up front\|all pending\|every pending' src/agents/architect.ts .opencode/skills/execute/SKILL.md → nothing for parallel mode.

User impact: New plans advertise parallel-first but run serially with a repeated fallback advisory; worktree isolation never activates.

#### PLAN-1 · HIGH · loadPlan rebuilds from lossy plan.md BEFORE the ledger when plan.json is absent, then adopts the lossy plan into the ledger

Lane: plan. Kind: bug.

Evidence:

- `src/plan/manager.ts:1027` — `// Step 3: Try to migrate from legacy plan.md (no plan.json exists)`
- `src/plan/manager.ts:1036` — `// Step 4: Neither exists — try to rebuild from ledger.`

Hypothesis: Step 3 precedes Step 4; migrateLegacyPlan drops files_touched/depends suffixes, acceptance, fr_refs, execution_profile, specHash; savePlan then appends a structural snapshot (:1743) embedding the lossy plan, so the ledger itself becomes lossy. Violates AGENTS.md:70.

Verify: bun scratchpad/plan-lane-verify/v2-md-before-ledger.ts: unlink(plan.json) -> migration_status=migrated, files_touched=[], locked execution_profile undefined, ledger tail=savePlan_structural_projection.

User impact: Deleting plan.json (docs: 'Derived — can be rebuilt from ledger') silently loses scopes, acceptance, deps, the LOCKED serial profile (next save_plan applies v8 parallel default) and spec-drift detection.

#### PLAN-2 · HIGH · A literal U+FFFD in any task text makes plan.json permanently 'invalid encoding' -> lossy plan.md migration on every load

Lane: plan. Kind: bug.

Evidence:

- `src/plan/manager.ts:669` — `planJsonContent.includes('\uFFFD')) {`
- `src/plan/manager.ts:673` — `// Skip to plan.md migration path - don't parse tainted content`

Hypothesis: Guard (also :487) cannot distinguish invalid UTF-8 from a legitimate replacement char that save_plan accepts and writes verbatim; loadPlanJsonOnly -> null and loadPlan takes the PLAN-1 path on the same save_plan call and on every later load.

Verify: bun scratchpad/plan-lane-verify/v1-fffd.ts: description with '\uFFFD' -> loadPlan returns migration_status=migrated, files_touched [], locked profile undefined; repeats each load.

User impact: Pasting a log/CSV sample containing '�' silently degrades the whole plan while save_plan reports success.

#### PLAN-3 · HIGH · get_approved_plan reports drift_detected=true for an unchanged plan after plan-critic-gate approval (full hash vs structure hash)

Lane: plan. Kind: bug.

Evidence:

- `src/tools/get-approved-plan.ts:234` — `const driftDetected = currentHash !== approved.payloadHash;`
- `src/hooks/delegation-gate.ts:1835` — `payloadHashOverride: computePlanStructureHash(plan),`

Hypothesis: loadLastApprovedPlan (ledger.ts:1999) returns the newest critic_approved snapshot regardless of approval.source; the gate snapshot stores a status-excluded hash while the tool compares the status-inclusive one; critic.ts:384 then mandates a CRITICAL plan-mutated finding.

Verify: bun scratchpad/plan-lane-verify/v4-drift.ts -> identical plan: drift_detected=true; grep plan_critic_gate tests/unit/tools/get-approved-plan.test.ts -> none.

User impact: First phase critic review after PLAN approval (and any approve_plan_critic override) raises spurious BASELINE DRIFT / NEEDS_REVISION.

#### PLAN-4 · HIGH · plan.current_phase is pinned to phase 1: save_plan resets it on every revision and phase_complete never advances it

Lane: plan. Kind: bug.

Evidence:

- `src/tools/save-plan.ts:1134` — `: args.phases[0]?.id,`
- `src/hooks/delegation-gate.ts:2696` — `if (pendingTaskIds.length < 2) return false; // nothing to parallelize`
- `src/hooks/phase-monitor.ts:127` — `if (currentPhase !== lastKnownPhase) {`

Hypothesis: No production writer advances it (only save-plan.ts:1132, close.ts:1196, migrateLegacyPlan; phase-complete.ts:1325 sets status only). delegation-gate :2677, phase-monitor, system-enhancer, knowledge-injector, preflight, handoff and plan.md header key on it; after phase 1 the active pending set is [] -> serial forever, no phase transitions.

Verify: bun scratchpad/plan-lane-verify/v3-current-phase.ts -> current_phase 2 becomes 1 after a revision; grep -rn current_phase src/tools/phase-complete.ts src/tools/phase-complete/ -> read-only at :614.

User impact: From phase 2 on: 'SERIAL fallback active' on every dispatch, no phase preflight/summary triggers, plan.md header always 'Phase: 1'.

#### PROMPTS-1 · HIGH · Architect prompt ~34.5K tokens/turn (~40K with features); prefixed+all-features render exceeds the CI ceiling

Lane: prompts. Kind: perf.

Evidence:

- `src/agents/architect.ts:86` — `default render ≈ 129K chars; all opt-in features enabled ≈ 149K chars. The ceiling intentionally leaves only ~7% headroom`
- `src/agents/architect.ts:102` — `export const ARCHITECT_PROMPT_BUDGET_CHARS = 160_000;`
- `tests/unit/agents/architect-prompt-budget.test.ts:160` — `it('prefixed non-default swarm render stays under the ceiling', () => {`

Hypothesis: Measured: default 137,152 chars; all opt-in 159,325 (0.4% headroom, not ~7%); swarms.mega + all opt-in 160,338 > 160,000, a combination no test renders. {{SLASH_COMMANDS}} = 14,122 chars of user-command help, {{AVAILABLE_TOOLS}} = 15,902, MODE sections = 45K, resent every turn; a 32K-context local model cannot fit it.

Verify: bun <scratchpad>/maps/measure-prompts.ts (mega_architect=160338). Add a swarms+all-features case to the budget test; it fails.

User impact: 35-40K fixed tokens per architect turn; failure or truncation on small local models.

#### PROMPTS-4 · HIGH · Per-language constraints inject only when the task DESCRIPTION contains 'src/…'; files_touched and non-src layouts never trigger while coder prompt hard-codes TypeScript rules

Lane: prompts. Kind: portability.

Evidence:

- `src/hooks/system-enhancer.ts:574` — `const filePaths = currentTaskText.match(/\bsrc\/\S+\.[a-zA-Z0-9]+\b/g) ?? [];`
- `src/hooks/extractors.ts:245` — `return `- [ ] ${inProgress.id}: ${inProgress.description} [${inProgress.size.toUpperCase()}]${deps} ← CURRENT`;`
- `src/agents/coder.ts:147` — `- Import from 'bun:test', NOT from 'vitest'.`

Hypothesis: Same regex at L574/611/647; input (L1501) is the plan task line only, never files_touched. Go cmd/internal, Rust crates, Python packages, or any task not spelling a literal src/x.ext path get no [LANGUAGE-SPECIFIC CONSTRAINTS], while the static coder prompt imposes bun:test, no-any, path-alias rules unconditionally.

Verify: Plan task 'Add handler in internal/api/server.go' with files_touched set; dispatch coder; grep output.system for '[LANGUAGE-SPECIFIC'; compare with 'Edit src/api/server.go'.

User impact: Non-TypeScript / non-src projects lose promised per-language rules and get bun:test instructions.

#### PRREVIEW-2 · HIGH · Architect MODE stub, wake banner and a pinned test still order abort_pr_workflow on retry_exhausted/circuit_open, contradicting the N-of-6 rule

Lane: prreview. Kind: drift.

Evidence:

- `src/agents/architect.ts:977` — `collect every lane to settlement, do not probe downstream writers or micro lanes, call`
- `src/agents/architect.ts:983` — `or the bounded lane retries above are exhausted, call`
- `src/agents/architect.ts:972` — `settle N-of-6 truthfully (issue #2383): PARTIAL coverage completes with verdict REQUEST_CHANGES or INCOMPLETE`
- `.opencode/skills/swarm-pr-review/SKILL.md:2010` — `is the truthful exit — not abort.`
- `src/hooks/pr-workflow-response-gate.ts:365` — `settled discovery lanes cannot satisfy their contract — call`
- `tests/unit/skills/swarm-pr-review-runtime-friction-guidance.test.ts:92` — `'do not probe downstream writers or micro lanes',`

Hypothesis: Lines 972/978 say settle N-of-6 via partial_base_coverage; 977 ('If the runtime returns typed retry_exhausted or circuit_open, or if the second retry still cannot close coverage ... call abort_pr_workflow') and 983 say abort. The banner injected on every assistant turn (365) repeats it. circuit_open recovers after 60s (#2382), so abort discards validated work as #2380 decision 5 forbids; the friction test pins the stale text.

Verify: sed -n 972p;977p;983p src/agents/architect.ts; sed -n 365p src/hooks/pr-workflow-response-gate.ts; sed -n 2005,2012p .opencode/skills/swarm-pr-review/SKILL.md; bun test tests/unit/skills/swarm-pr-review-runtime-friction-guidance.test.ts (green today only because the stale text exists).

User impact: A tier-M/L review that loses one dimension is aborted with no verdict (the #2375 shape) whenever the model follows the stub/banner rather than the skill.

#### PRREVIEW-3 · HIGH · .claude and .agents swarm-pr-review adapters say 'report BLOCKED merely because the controller is unavailable' (lost 'Never'); untested

Lane: prreview. Kind: drift.

Evidence:

- `.claude/skills/swarm-pr-review/SKILL.md:16` — `and report BLOCKED merely because the controller is unavailable.`
- `.agents/skills/swarm-pr-review/SKILL.md:16` — `and report BLOCKED merely because the controller is absent or the only alternative would be a degraded review.`
- `.claude/skills/swarm-pr-feedback/SKILL.md:17` — `Never report BLOCKED merely because controller tools are absent`
- `.opencode/skills/swarm-pr-review/SKILL.md:127` — `NOT a BLOCKED condition — Profiles B and C are legitimate execution paths whose`
- `tests/unit/skills/swarm-pr-feedback-mechanical-gates.test.ts:67` — `expect(source).toContain('Never report BLOCKED merely because');`

Hypothesis: #1965 residual: the sentence opens 'treat that as Profile B, not an error' and closes by ordering BLOCKED; opposite of the canonical skill (127-131) and of the feedback adapters, which are test-pinned while the review adapters are not.

Verify: grep -n 'report BLOCKED merely' .claude/skills/*/SKILL.md .agents/skills/*/SKILL.md; grep -rn 'BLOCKED merely' tests/unit/skills/swarm-pr-review-*.test.ts (none); bun run drift:check does not check wording.

User impact: A Claude Code/Codex session reading its adapter stops with BLOCKED instead of running Profile B, or improvises.

#### REPOGRAPH-1 · HIGH · Startup graph build blocks every tool result: toolAfter awaits init before its write-tool filter; scan phase has no time budget (265 s measured here)

Lane: repograph. Kind: perf.

Evidence:

- `src/hooks/repo-graph-builder.ts:411` — `await initPromise.catch(() => {`
- `src/hooks/repo-graph-builder.ts:415` — `if (!(WRITE_TOOL_NAMES as readonly string[]).includes(input.tool)) {`
- `src/index.ts:4416` — `await safeHook(repoGraphHook.toolAfter)(input, output);`
- `src/tools/repo-graph/builder.ts:3493` — `for (const filePath of sourceFiles) {`

Hypothesis: walk_budget_ms bounds only the directory walk; the per-file extractFileSymbols loop (yield every 16 files, builder.ts:186) is unbounded. Measured buildWorkspaceGraphAsync twice: 265/266 s (64 ms/file; pr-workflow-gate.ts alone 1,581 ms synchronous). toolAfter awaits initPromise before the WRITE_TOOL_NAMES check, so the host's awaited tool.execute.after for read/grep/glob/bash waits for the whole build; safeHook (src/hooks/utils.ts:55) adds no timeout.

Verify: Unit: hook whose buildWorkspaceGraph dep never settles; init(); toolAfter({tool:'read'}) raced against a 100 ms timer must not settle. Runtime: delete .swarm/repo-graph.json in a 4k-file repo, start OpenCode, time the first read tool. Cost: bun -e time buildWorkspaceGraphAsync(cwd) (lane map s.5).

User impact: First session without a certified graph (fresh clone, after each release, corrupt file): every tool call hangs for minutes with no message.

#### REPOGRAPH-2 · HIGH · Fingerprint stamp includes package.json version: every release (3-6/day) forces a full startup rebuild; docs say only schema bumps do and that the old graph is served

Lane: repograph. Kind: design.

Evidence:

- `src/tools/repo-graph/freshness.ts:35` — `export const EXTRACTOR_STAMP = createHash('sha256')`
- `src/tools/repo-graph/freshness.ts:282` — `record.extractorStamp !== EXTRACTOR_STAMP \|\|`
- `src/hooks/repo-graph-builder.ts:341` — `if (probe.state === 'no-fingerprint') {`
- `docs/repo-graph-symbol-graph.md:753` — `The schema bump invalidates freshness fingerprints (EXTRACTOR_STAMP includes GRAPH_SCHEMA_VERSION), so the first probe after upgrade reports drift until a rebuild.`

Hypothesis: Line 36 hashes packageJson.version + GRAPH_SCHEMA_VERSION. @latest users pick up a new version almost daily; the next probe is no-fingerprint and doInit does a FULL rebuild (REPOGRAPH-1 cost), not the 'serve old graph with a note' the docs describe. No test references the stamp (grep tests/ for EXTRACTOR_STAMP\|extractorStamp is empty).

Verify: Write a fingerprint, change EXTRACTOR_STAMP via a seam or mocked package.json version, probeFreshness -> 'no-fingerprint'; hook.init() with spies asserts buildWorkspaceGraph is called. Cadence: git log --format=%ad --date=short -- CHANGELOG.md \| uniq -c.

User impact: After nearly every update the first session per project silently rebuilds the whole graph and stalls all tools meanwhile.

#### SECURITY-1 · HIGH · Plugin-repo paths hardcoded as universal protected prefixes block coder writes in consumer repos

Lane: security. Kind: bug.

Evidence:

- `src/security/protected-path-policy.ts:21` — `const DEFAULT_PREFIXES = [ '.github/workflows', '.github/CODEOWNERS', 'src/sandbox', 'src/hooks/guardrails', 'src/security', 'src/evaluation', 'docs/releases', 'tests/fixtures/evaluation',`
- `src/hooks/scope-guard.ts:365` — `const protectedPrefix = DEFAULT_PROTECTED_PATH_PREFIXES.find((candidate) => isPolicyProtectedPath(normalizedPath, { includeDefaults: false, additional: [candidate],`
- `src/tools/apply-patch.ts:145` — `return isPolicyProtectedPath(filePath);`
- `docs/configuration.md:371` — `\| `protected_paths` \| string[] \| `['.git', '.github/workflows', '.opencode', '.swarm', 'package.json', 'package-lock.json']` \|`

Hypothesis: DEFAULT_PREFIXES mirrors THIS repo but runs in every user project: scope-guard.ts:250 calls enforceProtectedPathAuthority for every coder write target (denial at 379: "target is under central protected prefix"), apply-patch.ts:145 and full-auto/policy.ts:296 use the same defaults, and DEFAULT_SEGMENTS (line 8) matches package.json/CHANGELOG.md/bun.lock at ANY depth. No schema key removes the list (only additive protected_paths/extra_protected_paths); docs state a different default; .env.local is unprotected while .env is. tests/unit/hooks/scope-guard-protected-paths.test.ts:72-78 enshrines src/security/example.ts as "central security source".

Verify: bun -e "import {isPolicyProtectedPath as p} from './src/security/protected-path-policy.ts'; console.log(p('src/security/auth.ts'), p('packages/api/package.json'), p('.env.local'))" -> true true false. grep -n 'DEFAULT_PROTECTED\\|protected_prefix' src/config/schema.ts -> none. In a consumer repo with src/security/, declare scope for src/security/x.ts and dispatch a coder write -> WRITE BLOCKED ... central protected prefix src/security.

User impact: Projects containing src/security, src/sandbox, src/evaluation, src/hooks/guardrails, docs/releases or nested package.json cannot be edited by swarm coders there; the denial cites a prefix the docs never mention and no config can lift.

Pre-verification (main thread): Source-confirmed: protected-path-policy.ts DEFAULT_PREFIXES/DEFAULT_SEGMENTS mirror this repository's own layout.

#### TESTSCI-1 · HIGH · Merge-group wall 31-65 min: runner-queue contention, 16-23 min Windows cells, serialized unit->integration->smoke; shard comments stale (2988/498 vs 1666/278)

Lane: testsci. Kind: perf.

Evidence:

- `.github/workflows/ci.yml:360` — `so shards went 4→6 to keep per-shard file counts (~278)`
- `.github/workflows/ci.yml:978` — `needs: [detect-release, unit, integration, package-check, php-validation, rust-sandbox-runner]`

Hypothesis: Run 33326207183 (PR #2434): unit(win-5) queued 21.5 min, test step 22.1 min; unit-passed 18:38; integration 18:42; smoke(macos) queued 8.8 min; total 65 min. Recent MG runs 31-65 min; suite +80% since the 6-shard comment; hosted macOS/Windows concurrency caps serialize non-Linux cells.

Verify: gh run view 33326207183 --json jobs -q '.jobs[]\|[.name,.created_at,.started_at,.completed_at]'; count gated set per ci.yml:401-408 (2988)

User impact: 30-65 min per queue attempt; runs near check_response_timeout are evicted (PR #2313 precedent).

#### TOOLS-1 · HIGH · Per-agent tool allow-list is additive-only under OpenCode: architect-only/read-only restrictions unenforced; every agent likely receives all 129 tool schemas

Lane: tools. Kind: design.

Evidence:

- `src/agents/index.ts:1431` — `for (const tool of allowedTools) { if (filteredTools[tool] === false) continue; filteredTools[tool] = true;`
- `src/tools/dispatch-lanes.ts:4417` — `function buildReadOnlyTools(mode?: string): ReadOnlyToolPermissions { ... for (const toolName of READ_ONLY_TOOL_DENYLIST) { tools[toolName] = false;`
- `README.md:832` — `\| run_phase_review \| Architect-only: runs the bounded final-review engine`

Hypothesis: getAgentConfigs emits only true entries (probe: coder 17 true/0 false; explorer false only for write/edit/patch). OpenCode includes every registered tool unless denied (v1.18.3 tool/registry.ts tools() ends `return true`; docs: true≡{'*':'allow'}, false≡{'*':'deny'}). So coder/explorer/sme can call save_plan, set_qa_gates, knowledge_remove, skill_retire, complete_pr_workflow; only 12/129 executors check ctx.agent (none of those). The repo's lane code denies explicitly, so the semantics are known but not applied to agent configs; every agent's request then carries ~171 KB (~43k tokens) of swarm tool schemas.

Verify: 1) OpenCode v1.18.3 packages/opencode/src/tool/registry.ts tools() and session/tools.ts resolve: confirm no allow-list filter beyond permission deny. 2) bun -e: getAgentConfigs({}).coder.tools has zero false entries. 3) Delegate to coder in a session and have it call save_plan. 4) Inspect the provider request tool list for a coder turn.

User impact: Subagents (incl. small local models) can mutate plan/QA/knowledge/skill state documented as architect-only; per-turn token cost and tool-selection failures for every agent.

#### TOOLS-2 · HIGH · tool_filter.overrides '[] denies all tools' is documented but yields tools:{} which denies nothing

Lane: tools. Kind: drift.

Evidence:

- `src/config/schema.ts:1273` — `// Empty array denies all tools for that agent`
- `src/agents/index.ts:1307` — `if (override !== undefined) { // Override exists - use it (even if empty array) allowedTools = override;`
- `src/agents/index.ts:1428` — `const filteredTools: Record<string, boolean> = { ...disabledTools };`

Hypothesis: Probe getAgentConfigs({tool_filter:{overrides:{coder:[]}}}).coder.tools === {}; under host semantics an empty map is unrestricted. tests/unit/agents/tool-filter-council-hardening.test.ts:285 only asserts council tools are re-added, never that anything is denied.

Verify: bun -e "import{getAgentConfigs}from'./src/agents/index';console.log(JSON.stringify(getAgentConfigs({tool_filter:{overrides:{coder:[]}}} as any).coder.tools))" → {}; confirm host treats {} as unrestricted.

User impact: An operator narrowing an agent via overrides gets a silent no-op.

#### TOOLS-3 · HIGH · knowledge.enabled=false unregisters 6 knowledge tools but AGENT_TOOL_MAP, the architect Available Tools block and a mandatory per-phase instruction still grant/require them

Lane: tools. Kind: unwired.

Evidence:

- `src/tools/plugin-registration.ts:56` — `// Skip knowledge tools if knowledge is disabled  if (!knowledgeEnabled && knowledgeTools.has(name)) { continue;`
- `src/agents/index.ts:1311` — `// No override - use default AGENT_TOOL_MAP  allowedTools = AGENT_TOOL_MAP[baseAgentName as keyof typeof AGENT_TOOL_MAP];`
- `src/agents/architect.ts:313` — `4. Before starting each phase, call knowledge_recall with query "doc-constraints"`

Hypothesis: getAgentConfigs gates memory/external_skills/council/general/turbo/skills but not knowledge; buildYourToolsList/buildAvailableToolsList (architect.ts:1477/1567) take no knowledge flag. Probe with knowledge:{enabled:false}: 123 tools registered (knowledge_recall absent) while architect.tools.knowledge_recall===true and the prompt still mandates knowledge_recall and lists knowledge_receipt. knowledge_recall is granted to 20 agents, knowledge_receipt to 18.

Verify: bun -e "import{getAgentConfigs}from'./src/agents/index';import{buildPluginToolObject}from'./src/tools/plugin-registration';const cfg={knowledge:{enabled:false}} as any;const a=getAgentConfigs(cfg);console.log('knowledge_recall'in buildPluginToolObject({},cfg),a.architect.tools?.knowledge_recall,/call knowledge_recall/.test(a.architect.prompt))" → false true true.

User impact: Disabling knowledge yields an architect instructed every phase to call a tool the host rejects as unknown; invariant 11 and 'never ship unwired' violated for a documented config.

#### COMMANDS-3 · MEDIUM · /swarm ci-simulate hardcodes this repo's bun scripts, ships to all users, and is agent-invocable (worktree + subprocess) despite the stated no-subprocess policy

Lane: commands. Kind: portability.

Evidence:

- `src/commands/ci-simulate.ts:308` — `{ step: 'typecheck', cmd: ['bun', 'run', 'typecheck'] },`
- `src/commands/registry.ts:1481` — `toolPolicy: 'agent',`
- `src/commands/tool-policy.ts:142` — `Commands with state changes, auto-heal behavior, or subprocesses need confirmation gates before chat-tool support.`
- `.opencode/skills/merge-queue-readiness/SKILL.md:16` — `/swarm ci-simulate [<pr-ref>]`

Hypothesis: Steps :308-311 are fixed to bun run typecheck/lint/build + bun test with no package.json script probe (grep finds only the fs seam), so in a consumer repo it creates a temp worktree, merges, then fails all four steps; the bundled merge-queue-readiness skill tells consumers to run it. toolPolicy 'agent' (registry.ts:1473-1482) contradicts tool-policy.ts:142 and the help-text read-only claim.

Verify: In a repo without those scripts: bunx opencode-swarm run ci-simulate -> 4 failing steps. bun -e "import {SWARM_COMMAND_TOOL_ALLOWLIST as A} from './src/commands/tool-policy.ts'; console.log(A.has('ci-simulate'))" -> true.

User impact: A broken command is promoted by a bundled skill; agents can spawn a worktree plus four subprocesses via the chat tool with no confirmation gate.

#### COMMANDS-4 · MEDIUM · /swarm analyze emits [MODE: ANALYZE] that only the critic subagent's prompt consumes; the architect has no section and falls through

Lane: commands. Kind: unwired. Duplicates merged: PROMPTS-2.

Evidence:

- `src/commands/analyze.ts:13` — `return '[MODE: ANALYZE] Please analyze the spec against the plan using MODE: ANALYZE.';`
- `src/agents/architect.ts:714` — `If no matching "### MODE: X" section exists, fall through to the rules below.`
- `src/agents/critic.ts:223` — `### MODE: ANALYZE`
- `tests/unit/skills/mode-command-wiring.test.ts:74` — `const KNOWN_SIGNAL_MODES_WITHOUT_ARCHITECT_SECTION = new Set(['ANALYZE']);`

Hypothesis: Registered (registry.ts:1276), shortcut 'swarm-analyze' (index.ts:3052) and documented (docs/commands.md:190), but the signal targets a subagent users never chat with; architect.ts has no instruction to delegate ANALYZE to the critic (grep -i analyze: only rule S). The wiring test allowlists the gap instead of closing it.

Verify: grep -n '### MODE: ANALYZE' src/agents/*.ts (critic only); grep -n -i analyze src/agents/architect.ts; run /swarm analyze in an architect session, observe no critic dispatch.

User impact: The documented spec-vs-plan coverage report is produced by no wired path.

#### COMMANDS-5 · MEDIUM · Seven bundled skills are materialized into every project but unreachable in OpenCode (no MODE stub, not in discovery roots, no file: reference)

Lane: commands. Kind: unwired.

Evidence:

- `docs/skills.md:13` — `so a skill placed there is unreachable unless one of these two explicit mechanisms references it`
- `src/config/bundled-skills.ts:46` — `'issue-tracer',`
- `src/background/pr-event-delivery.ts:403` — `'swarm-pr-subscribe skill protocol: triage each event`
- `.opencode/skills/issue-ingest/SKILL.md:79` — `(it does not load the `issue-tracer` skill;`

Hypothesis: For swarm, swarm-pr-subscribe, engineering-conventions, fork-pr-operations, issue-tracer (85KB incl. two .sh scripts), orchestrating-subagents, durable-session-state: zero bundledProjectSkillFileReference in src and zero file:.swarm/bundled-skills/<slug> refs in any skill. The PR wake text names a protocol with no path. mode-command-wiring.test.ts:39 NON_COMMAND_SKILLS calls them 'injected into delegations', but the hook only scans SKILL_SEARCH_ROOTS, so nothing injects them.

Verify: for s in swarm swarm-pr-subscribe engineering-conventions fork-pr-operations issue-tracer orchestrating-subagents durable-session-state; do grep -rl "bundledProjectSkillFileReference('$s')" src\|grep -v test\|wc -l; grep -rl "bundled-skills/$s/SKILL.md" .opencode/skills .claude/skills .agents/skills\|wc -l; done -> all 0.

User impact: ~150KB copied per project per init with no runtime effect; a PR wake demands a protocol the architect cannot locate.

#### COMMANDS-6 · MEDIUM · Help text and tool-policy describe swarm_command as read-only/no-subprocess, but 'agent' policy includes mutating and subprocess commands

Lane: commands. Kind: drift.

Evidence:

- `src/commands/index.ts:149` — `supported read-only `/swarm` commands are routed through the `swarm_command` tool when the active agent has that tool.`
- `src/commands/sync-plan.ts:22` — `// loadPlan triggers auto-heal which regenerates plan.md if stale`
- `src/commands/registry.ts:840` — `toolPolicy: 'agent',`
- `src/commands/registry.ts:862` — `writes versioned results below .swarm/evidence/gate-audit/.`

Hypothesis: The runtime ALLOWLIST (54) contains sync-plan (auto-heal write, exactly what tool-policy.ts:142 says is excluded), gate-audit (model dispatch + evidence writes), post-mortem (LLM delegate + report, registry.ts:1178), ci-simulate, memory link/unlink, pr subscribe/unsubscribe, guardrail reset. registration-parity-baselines.test.ts only snapshots membership, so statement and set drifted apart unnoticed.

Verify: bun -e "import {SWARM_COMMAND_TOOL_ALLOWLIST as A} from './src/commands/tool-policy.ts'; console.log(['sync-plan','gate-audit','post-mortem','ci-simulate','memory link','pr subscribe','guardrail reset'].map(k=>[k,A.has(k)]))" -> all true.

User impact: Agents can trigger writes, model spend and subprocesses via a tool that help describes as read-only.

#### CONFIG-2 · MEDIUM · install() does not evict version-pinned cache dirs (opencode-swarm@<semver>) though documented as the upgrade path — AGENTS.md invariant 12

Lane: config. Kind: bug.

Evidence:

- `src/cli/index.ts:359` — `const evicted = evictPluginCaches();`
- `src/cli/index.ts:452` — `const discoveredCachePaths = discoverVersionPinnedCachePaths();`
- `src/cli/index.ts:512` — `Defaults to `[]` so existing callers (`install()`) are unaffected.`
- `AGENTS.md:138` — `Install / update / cache changes must cover **all known cache layouts**`

Hypothesis: Issue #2236 RC3 added pinned-cache discovery only to update(); install() (default command; comment at 357-358 claims it 'actually upgrades the running version') passes no extra paths, so a host that cached opencode-swarm@7.143.1 keeps loading it. Docs never say to run `update` after `install`.

Verify: mkdir -p $Y/opencode/packages/opencode-swarm@7.143.1 (+package.json); XDG_CONFIG_HOME=$X XDG_CACHE_HOME=$Y bun src/cli/index.ts install → dir survives (reproduced); `update` removes it. grep -n '@7\.\\|VERSION_PINNED' tests/unit/cli/install.test.ts → none.

User impact: Users on version-pinning hosts keep a stale plugin after re-installing.

#### CONFIG-3 · MEDIUM · Documented config samples fail schema/JSON validation and trigger the guardrails-default recovery ladder when copied

Lane: config. Kind: drift.

Evidence:

- `docs/configuration.md:1317` — `"max_bundles": 5`
- `src/config/schema.ts:377` — `max_bundles: z.number().min(10).max(10000).default(1000),`
- `docs/configuration.md:2003` — `"strategy": "lean",`
- `src/config/schema.ts:3079` — `lean: LeanTurboConfigSchema,`
- `docs/installation.md:475` — `"knowledge": {`

Hypothesis: evidence.max_bundles=5 violates min(10); the Epic Mode example sets turbo.strategy='lean' without the required `lean` object; the Hooks example in installation.md is not a JSON document (second top-level block after the closing brace). Pasting yields CONFIG LOAD FAILURE (file ignored) or value-recovery that drops the section and forces guardrails.enabled=true (loader.ts:769-810). drift-check validates numeric claims only.

Verify: Run scratchpad/work/validate-samples.ts (safeParses every ```json/jsonc block in the five docs): configuration.md:1313 SCHEMA FAIL, configuration.md:2000 SCHEMA FAIL turbo.lean expected object, installation.md:466 JSON.parse FAIL.

User impact: Copying the official example silently disables the feature (or whole config) and re-enables guardrails; only a deferred warning hints why.

#### CONFIG-4 · MEDIUM · /swarm diagnose 'Config Parseability' and config-doctor inspect only the project (or a single) config; a corrupt user-level config is reported green

Lane: config. Kind: bug.

Evidence:

- `src/services/diagnose-service.ts:474` — `const configPath = path.join(directory, '.opencode/opencode-swarm.json');`
- `src/services/diagnose-service.ts:480` — `detail: 'No project config file present (using defaults)',`
- `src/services/config-doctor.ts:926` — `if (fs.existsSync(projectConfigPath)) {`
- `src/services/config-doctor.ts:929` — `} else if (fs.existsSync(userConfigPath)) {`

Hypothesis: The installer creates and docs (getting-started.md:72) tell users to edit ~/.config/opencode/opencode-swarm.json (issue #2's file), yet the named check never reads it, and config-doctor raw-file collectors read project OR user, never merged. Loader failure (loader.ts:119) surfaces only as a generic deferred-warning count.

Verify: echo '{ bad' > $X/opencode/opencode-swarm.json (XDG_CONFIG_HOME=$X), no project config; `bun src/cli/index.ts run diagnose` → Config Parseability ✅. grep -n userConfigPath src/services/diagnose-service.ts → none.

User impact: A user whose global config is broken (models ignored, guardrails-only defaults — the issue #2 symptom) is told config is fine.

#### CONFIG-5 · MEDIUM · Docs advertise an npm-only install path but the CLI bundle is Bun-only and crashes under Node

Lane: config. Kind: portability.

Evidence:

- `docs/getting-started.md:54` — `if you only have npm available: `npm install -g opencode-swarm && opencode-swarm install`.`
- `src/cli/index.ts:1` — `#!/usr/bin/env bun`
- `package.json:93` — `bun build src/cli/index.ts --outdir dist/cli --target bun --format esm --external bash-parser --splitting`

Hypothesis: npm ignores engines.bun; the bin shim (Unix shebang / Windows cmd-shim honouring env bun) needs bun on PATH; run via node the bundle throws at module init, and on Node <24.2 `if (import.meta.main)` (cli/index.ts:825) is falsy so main() would silently never run. README.md:25 says bun is required — the two docs disagree.

Verify: node dist/cli/index.js --version → TypeError: __require is not a function (reproduced, Node v22.22.2); bun dist/cli/index.js --version → opencode-swarm 7.160.2.

User impact: Users without bun follow the documented fallback and get 'env: bun: No such file' or a TypeError (issue #6 class).

#### DOCS-10 · MEDIUM · 595 pending release fragments accumulate forever while docs/index.md and the drift checker call them…

Lane: docs. Kind: design.

Evidence:

- `contributing.md:338` — `**Pending fragments are not deleted automatically.**`
- `docs/index.md:86` — `live in `/docs/releases/pending/` until release aggregation.`
- `scripts/drift-check-docs-claims.ts:129` — `Fragments are transient (deleted when release-please consumes`

Hypothesis: Aggregation works (GitHub Release v7.160.2 body starts with the marker block). Nothing prunes: 595 fragments span ~391 versions since v7.22.0 (CHANGELOG.md:3608, 2026-05-18).…

Verify: ls docs/releases/pending \| wc -l; gh release view v7.160.2 --json body; sed -n '199,244p'…

User impact: Browsers see 595 'pending' notes for shipped changes and a months-old release index…

#### DOCS-2 · MEDIUM · docs/commands.md is mojibake-corrupted (94 double-encoded UTF-8 sequences)

Lane: docs. Kind: bug.

Evidence:

- `docs/commands.md:14` — `known source of model confusion â€” AI agents`
- `docs/commands.md:22` — `\| `/plan` \| ðŸ”´ CRITICAL \| Enters plan mode â€” Claude`

Hypothesis: CP1252 round-trip; em-dashes/emoji stored as `â€”`/`ðŸ”´`. Only this file. The commands drift check compares names, not bytes.

Verify: grep -c -P '\xC3\xA2\xE2\x82\xAC' docs/commands.md -> 94; README.md/docs/modes.md -> 0.

User impact: Primary command reference renders garbage in every dash/severity cell on GitHub.

#### DOCS-4 · MEDIUM · Documented npm-only install path still requires Bun (bin is a Bun-target bundle)

Lane: docs. Kind: portability.

Evidence:

- `README.md:25` — `If you must use npm: `npm install -g opencode-swarm && opencode-swarm install`.`
- `docs/getting-started.md:54` — `if you only have npm available: `npm install -g opencode-swarm && opencode-swarm install``
- `src/cli/index.ts:1` — `#!/usr/bin/env bun`

Hypothesis: The npm bin runs via the bun shebang; without Bun it fails `env: 'bun': No such file`. linux-docker lists Node 20 while engines declares only bun>=1.3.13 (Node sqlite fallback needs >=22.5…

Verify: head -1 dist/cli/index.js; container with node, no bun: npm i -g opencode-swarm && opencode-swarm install.

User impact: Users told npm suffices hit an opaque `bun: not found`.

#### DOCS-5 · MEDIUM · README summaries.threshold_bytes default 102400; schema default 16384

Lane: docs. Kind: drift.

Evidence:

- `README.md:1103` — `(default 102400 = 100KB)`
- `src/config/schema.ts:540` — `threshold_bytes: z.number().min(1024).max(1048576).default(16384),`
- `src/hooks/tool-summarizer.ts:69` — `shouldSummarize(output.output, config.threshold_bytes)`

Hypothesis: Summarization fires at 16 KB, 6x sooner than documented; the generated key reference omits the sub-keys so README is the only (wrong) source.

Verify: grep -n threshold_bytes README.md docs/configuration.md src/config/schema.ts

User impact: Tool outputs get replaced by summaries far earlier than users expect.

#### DOCS-6 · MEDIUM · README 'What This Does NOT Do' for the Context Budget Guard is contradicted by the hook (prunes, masks…

Lane: docs. Kind: drift.

Evidence:

- `README.md:808` — `**Does NOT prune chat history**`
- `README.md:810` — `**Does NOT block execution** — The guard is advisory only`
- `README.md:812` — `**Only measures swarm's injected context**`

Hypothesis: With enforce=true (default) the hook removes/masks messages at 90% of the window; README:563 in the same section already says it measures all messages, so :806-812 is a stale block.

Verify: sed -n '255,300p' src/hooks/context-budget.ts; diff README.md:563 vs :812.

User impact: Users told history is untouched silently lose tool outputs and older turns.

#### DOCS-7 · MEDIUM · README 'Default (reference)' context_budget block pins model_limits.default=128000 (not the default; caps 1M…

Lane: docs. Kind: drift.

Evidence:

- `README.md:766` — `"model_limits": { "default": 128000 },`
- `README.md:727` — `Empty by default so the live model's own context window is used`
- `src/config/schema.ts:357` — `model_limits: z.record(z.string(), z.number().min(1000)).default({}),`

Hypothesis: Copying the block labelled Default (also Aggressive at :793) reintroduces the exact 128k-vs-1M bug the code comment describes, triggering hard pruning at ~115k tokens.

Verify: Copy README.md:753-777 into config on a 1M-context model; guard fires at ~115k tokens.

User impact: Silent context pruning far below the model's real window.

#### DOCS-8 · MEDIUM · README File Authority table does not match default rules (coder blocklist-based; architect blocked from…

Lane: docs. Kind: drift.

Evidence:

- `README.md:537` — `- **coder** — `src/`, `tests/`, `docs/`, `scripts/``
- `README.md:536` — `- **architect** — Everything (except `.swarm/plan.md`, `.swarm/plan.json`)`
- `src/hooks/guardrails/file-authority.ts:360` — `blockedPrefix: ['.swarm/'],`

Hypothesis: Coder has no allowedPrefix (writes anywhere except .swarm/, generated, config zones); architect is blocked from config/verifier files (v7.21.4); reviewer may write .swarm/outputs/. README…

Verify: sed -n '341,380p' src/hooks/guardrails/file-authority.ts

User impact: Users believe the coder cannot touch infra/CI files; it can.

#### EVIDENCE-10 · MEDIUM · Recovery guide and evidence docs omit the evidence-gate recovery paths the code emits

Lane: evidence. Kind: drift.

Evidence:

- `src/gate-evidence.ts:176` — ``TASK_TERMINAL_PREPARED: transition ${String(terminalWal.transitionId)} owns evidence for task ${taskId}``
- `src/gate-evidence.ts:151` — `or run /swarm recover ${taskId} (or /swarm reset-session), then retry`
- `src/evidence/phase-participation.ts:458` — `operator action is required before docs can be re-dispatched`
- `docs/evidence-and-telemetry.md:38` — `Thirteen types, each with type-specific fields.`

Hypothesis: recovery-guide.md sections 1-11 never mention repair_gate_evidence, TASK_WORKFLOW_STAGE_A_REQUIRED, TASK_TERMINAL/REPAIR_PREPARED (no guidance in message though update-task-status.ts:1795 self-settles on retry), PHASE_PARTICIPATION_* or quarantine-full. evidence-and-telemetry.md documents only bundles, not the flat <taskId>.json, receipts or quarantine dirs, and says 13 types vs 16 in EvidenceSchema (evidence-schema.ts:415-432).

Verify: grep -n -i 'repair_gate_evidence\\|STAGE_A_REQUIRED\\|TERMINAL_PREPARED\\|PHASE_PARTICIPATION' docs/troubleshooting/recovery-guide.md docs/evidence-and-telemetry.md -> no hits.

User impact: Stuck users get error codes with no documented next step.

#### EVIDENCE-3 · MEDIUM · req_coverage creates .swarm/evidence under caller-supplied `directory` with no root resolution (invariant 4)

Lane: evidence. Kind: security.

Evidence:

- `src/tools/req-coverage.ts:467` — `const cwd = inputDirectory \|\| directory;`
- `src/tools/req-coverage.ts:547` — `fs.mkdirSync(evidenceDir, { recursive: true });`
- `AGENTS.md:62` — `No tool may create `.swarm/` under `src/`, `tests/`, `packages/*`, or any arbitrary `cwd`.`

Hypothesis: Unlike check_gate_status (resolveWorkingDirectory at L148), req_coverage never resolves a project root; it writes wherever readEffectiveSpecSync finds a spec (nested stale .swarm or OpenSpec dir) and critic.ts:423 tells the critic to pass directory explicitly.

Verify: grep -n resolveWorkingDirectory src/tools/req-coverage.ts (none); create <repo>/nested/openspec/specs/x.md with 'FR-001 MUST x', call req_coverage with directory '<repo>/nested', observe nested/.swarm/evidence/req-coverage-phase-1.json.

User impact: A model-chosen directory silently creates a second .swarm tree (#577/#2127 class).

#### EVIDENCE-5 · MEDIUM · phase_complete.regression_sweep.enforce: no producer, and the bundle schema strips the field the reader checks

Lane: evidence. Kind: unwired.

Evidence:

- `src/tools/phase-complete.ts:1901` — `(entry as Record<string, unknown>).regression_sweep !==`
- `src/config/evidence-schema.ts:42` — `export const BaseEvidenceSchema = z.object({`
- `docs/configuration.md:1149` — `If `true`, phase_complete warns when no regression-sweep result is found`

Hypothesis: Only qa-gate-pipeline.ts:43 (prompt label) and this reader mention regression_sweep; loadEvidence's EvidenceBundleSchema.parse drops unknown entry keys, so enforce:true always warns.

Verify: Scratch section B: entry saved with regression_sweep is on disk, absent after loadEvidence. grep -rn regression_sweep src --include=*.ts \| grep -v test.

User impact: Documented knob yields a permanent false warning.

#### EVIDENCE-6 · MEDIUM · Dead surfaces: todo_gate.* and check_gate_status.todo_scan have no producer; evidence.auto_archive has no consumer

Lane: evidence. Kind: unwired.

Evidence:

- `src/config/schema.ts:3746` — `todo_gate: z`
- `src/tools/check-gate-status.ts:337` — `const todoScan = evidenceData.todo_scan as`
- `docs/configuration.md:829` — `The count is included in the `todo_scan` field returned by the `check_gate_status` tool.`
- `src/config/schema.ts:378` — `auto_archive: z.boolean().default(false),`

Hypothesis: Outside schema, todo_gate appears only in config-doctor type checks; nothing writes todo_scan and TaskEvidenceSchema (gate-evidence.ts:311) would strip it; auto_archive has zero consumers. CLAUDE.md counts these as unwired code.

Verify: grep -rn 'todo_gate\\|max_high_priority\\|todo_scan\\|auto_archive' src --include=*.ts \| grep -v test \| grep -v config/schema.ts

User impact: todo_gate.block_on_threshold:true and auto_archive:true silently do nothing; todo_scan is always null.

#### EVIDENCE-7 · MEDIUM · check_gate_status hand-parses the flat file and reports all_passed on evidence the zod readers reject (#2199 class)

Lane: evidence. Kind: bug.

Evidence:

- `src/tools/check-gate-status.ts:99` — `Array.isArray((parsed as Record<string, unknown>).required_gates) &&`
- `src/gate-evidence.ts:1094` — `return null;`
- `src/gate-evidence.ts:1134` — `if (!evidence) return false;`

Hypothesis: Three readers disagree: the tool ignores workflow schema; readTaskEvidence/hasPassedAllGates treat a schema-invalid file as absent; readTaskEvidenceRaw throws. An unrecognised workflow.state shows all_passed while phase_complete inference and update_task_status see no evidence.

Verify: Scratch section C: workflow.state 'council_run' -> check_gate_status all_passed, hasPassedAllGates false, readTaskEvidence null.

User impact: Architect is told gates passed, then completion is refused with no pointer to the corrupt file.

#### EVIDENCE-8 · MEDIUM · phase_complete.enabled:false returns success but skips plan transition, phase_complete event and session reset

Lane: evidence. Kind: design.

Evidence:

- `src/tools/phase-complete.ts:561` — `if (phaseCompleteConfig.enabled === false) {`
- `src/tools/phase-complete.ts:597` — `message: `Phase ${phase} complete (enforcement disabled)`,`
- `docs/configuration.md:1145` — `\| `enabled` \| boolean \| `true` \| Enable/disable phase completion validation \|`

Hypothesis: Early return precedes plan lock, savePlan (L1325), events.jsonl append (L1938), lastPhaseCompleteTimestamp reset (L2044), sweep and post-mortem; docs describe the flag as validation-only.

Verify: executePhaseComplete with {phase_complete:{enabled:false}} and a plan.json: phase status unchanged, no phase_complete line in .swarm/events.jsonl.

User impact: User sees 'Phase N complete' but plan.json never advances and post-mortem never fires.

#### EVIDENCE-9 · MEDIUM · Plan-free sessions cannot pass phase_complete under defaults (require_docs needs a loadable plan); plan-free branches unreachable

Lane: evidence. Kind: friction.

Evidence:

- `src/tools/phase-complete.ts:972` — `crossSessionResult.agents.delete('docs');`
- `src/evidence/phase-participation.ts:629` — `if (!plan) return;`
- `src/tools/phase-complete.ts:208` — `A readable plan is required to bind durable docs participation. Restore or rebuild .swarm/plan.json`
- `tests/unit/tools/phase-complete-plan-free-warning.test.ts:58` — `require_docs: false,`

Hypothesis: require_docs defaults true (L966), the dispatched docs marker is deleted, proof binds only with a plan (L973), and task-gate inference needs plan.json; plan-free therefore always blocks REQUIRED_AGENTS_MISSING: docs with guidance to restore a plan that never existed. Plan-free warnings (L1848-1863) run only with require_docs:false, which every plan-free test sets.

Verify: executePhaseComplete, default config, no plan.json, all roles dispatched -> blocked listing docs. Intent: phase-complete-docs-participation-recovery.test.ts:191.

User impact: Ad-hoc users hit an unrecoverable block with misleading recovery text.

#### HOOKS-5 · MEDIUM · Gate-output substring classifier includes('error') records passing gate tools as failures

Lane: hooks. Kind: bug.

Evidence:

- `src/hooks/guardrails/index.ts:1145` — `outputStr.includes('FAIL') \|\|`
- `src/hooks/guardrails/index.ts:1146` — `outputStr.includes('error') \|\|`
- `src/tools/diff.ts:250` — `return JSON.stringify(result, null, 2);`
- `src/hooks/guardrails/tool-before.ts:2121` — `session.selfFixAttempted = true;`

Hypothesis: For every gate tool except pre_check_batch, any output containing 'error'/'FAIL' (a diff with `catch (error)`, JSON with an `errors` key) sets session.lastGateFailure, feeding the SELF-FIX DETECTED injection, handoff-service pending-QA and snapshots.

Verify: guardrails toolAfter with a pending gate task for tool 'diff' and output '{"patch":"+ catch (error) {}"}' -> session.lastGateFailure.tool === 'diff'.

User impact: False SELF-FIX guidance and false pending-QA after ordinary diffs.

#### HOOKS-6 · MEDIUM · Scope-guard denial advisory goes to the first architect session in map order, not the coder's parent

Lane: hooks. Kind: design.

Evidence:

- `src/hooks/scope-guard.ts:419` — `for (const [architectSessionId, architectSession] of state.agentSessions) {`
- `src/hooks/scope-guard.ts:428` — `break;`
- `src/hooks/guardrails/tool-before.ts:1147` — `writeBinding.parentOwnerSessionId &&`

Hypothesis: denyWithArchitectAdvisory picks whichever architect session was inserted first although the active binding carries parentOwnerSessionId. With two OpenCode sessions on one project the 'ACTION[architect]' advisory lands in an unrelated session.

Verify: ensureAgentSession('A','architect'); ensureAgentSession('B','architect'); coder child of B writes out of scope with an injectAdvisory spy -> pushed to 'A'.

User impact: Coder is told to ask the architect; the real parent never sees why it stopped.

#### HOOKS-7 · MEDIUM · Guardrails/knowledge/memory message-chain injections depend on host rendering of synthetic info.role:'system' entries the SDK type does not define

Lane: hooks. Kind: drift.

Evidence:

- `src/hooks/host-boundary.ts:25` — ``Message = UserMessage \| AssistantMessage` — there is NO `role:'system'``
- `src/hooks/guardrails/messages-transform.ts:603` — `info: { role: 'system' as const },`
- `src/hooks/knowledge-injector.ts:880` — `info: { role: 'system' },`
- `src/memory/injector.ts:163` — `role: 'system',`

Hypothesis: #1849 stopped *searching* for a system message, but every advisory/hard-stop/self-coding/partial-gate injection still creates one via messages.unshift and consolidation merges them to index 0. No in-repo test or doc cites host evidence that toModelMessages renders info.role 'system'; if the host switches on user/assistant only, all of these are dark.

Verify: Locate the host's toModelMessages (binary-offset technique from engineering-invariants v6.85.1) and check for a role === 'system' branch; or capture a real provider request with DEBUG_SWARM and look for '[ADVISORIES]'.

User impact: If unrendered: no guardrails advisories, hard stops or knowledge/memory recall reach the model despite telemetry saying they were injected.

#### HOOKS-8 · MEDIUM · docs/architecture.md hook table + stale-delegation text and the index.ts Full-Auto ordering comment describe a different chain

Lane: hooks. Kind: drift.

Evidence:

- `docs/architecture.md:1239` — `\| `tool.execute.before` \| `safeHook(activityHooks.toolBefore)` \|`
- `docs/architecture.md:1848` — `If `lastToolCallTime` is >10 seconds old`
- `src/index.ts:3638` — `Date.now() - session.lastAgentEventTime > 10000;`
- `src/index.ts:1999` — `//   3. delegation-gate (existing)`

Hypothesis: Docs call tool.execute.before one safeHook observer (it is a 7-step fail-closed chain), messages.transform 3 handlers (16), readSwarmFileAsync returns '' (docs:1228; code returns null), stale detection on lastToolCallTime (code: lastAgentEventTime). The index.ts comment orders permission before delegation and omits the PR-workflow gate; code runs delegation (3704) before permission (3710).

Verify: Diff docs/architecture.md:1225-1245,1846-1850 vs src/index.ts:3609-3720; diff comment index.ts:1993-2004 vs code.

User impact: Operators assume fail-open where gates are fail-closed; contributors mis-order new gates.

#### INIT-5 · MEDIUM · clearDeferredWarnings() on every server() call wipes the only diagnostics channel for all instances

Lane: init. Kind: bug.

Evidence:

- `src/index.ts:856` — `clearDeferredWarnings();`
- `src/services/warning-buffer.ts:11` — `const deferredWarnings: string[] = [];`
- `src/config/schema.ts:3820` — `.default(true)`

Hypothesis: quiet defaults to true, so config-load timeout (index.ts:900 advisoryWarn 'running with default configuration'), unresolved-model and missing-fallback warnings exist only in this buffer until /swarm diagnose; any later instance init clears it first.

Verify: Init A with an invalid .opencode/opencode-swarm.json, then init B; getDeferredWarnings() is empty; /swarm diagnose in A shows nothing.

User impact: A session silently on default config loses its only warning once lanes start.

#### INIT-6 · MEDIUM · swarmState agent registries and other singletons are overwritten by the last-initialised directory

Lane: init. Kind: design.

Evidence:

- `src/index.ts:1415` — `swarmState.generatedAgentNames = [...instanceGeneratedAgentNames];`
- `src/hooks/full-auto-delegation.ts:307` — `const generatedAgentRegistry = swarmState.generatedAgentNames;`
- `src/hooks/curator-llm-factory.ts:65` — `init: swarmState.curatorInitAgentNames,`

Hypothesis: Per-directory data (agent names :1388-1415, PR-subscription callback :2342, recovery evaluator :1596, opencodeClient :1051) lives in process globals; two projects with different `swarms:` make project A's full-auto guard and curator delegate resolve against B's names.

Verify: Init A with swarms:{local:{}} and B with defaults in one process; inspect swarmState.generatedAgentNames; delegate in A under full-auto → FULL_AUTO_DELEGATION_DENY / unknown curator agent.

User impact: Multi-project Desktop sessions: full-auto denials and curator failures in the earlier project.

#### INIT-7 · MEDIUM · bunSpawn Node fallback defaults stdin to 'pipe' where Bun defaults to 'ignore'; three tools spawn without stdin

Lane: init. Kind: portability. Duplicates merged: PORT-005.

Evidence:

- `src/utils/bun-compat.ts:698` — `return v ?? 'pipe';`
- `node_modules/bun-types/bun.d.ts:6522` — `@default "ignore"`
- `src/tools/pkg-audit.ts:287` — `const proc = _internals.bunSpawn(command, {`
- `AGENTS.md:51` — ``stdin: 'ignore'` unless the spawn is intentionally interactive.`

Hypothesis: mapStdio (bun-compat.ts:1010) makes Node children get a never-closed stdin pipe while Bun gives none. pkg-audit.ts:287, build-check.ts:167, complexity-hotspots.ts:165 omit stdin and hit the v7.3.3 hang class only on the Desktop Node sidecar.

Verify: bun build src/utils/bun-compat.ts --target node; under node bunSpawn(['cat'],{stdout:'pipe'}).exited never resolves, under bun it does. grep -L 'stdin:' $(grep -rl 'bunSpawn(' src --include=*.ts).

User impact: pkg_audit / build_check / complexity_hotspots may stall until timeout on OpenCode Desktop (Node).

#### INIT-8 · MEDIUM · No dispose hook: workers/streams cannot be stopped on instance teardown; process 'exit' listeners accumulate per init

Lane: init. Kind: unwired.

Evidence:

- `node_modules/@opencode-ai/plugin/dist/index.d.ts:174` — `dispose?: () => Promise<void>;`
- `src/index.ts:2424` — `process.on('exit', cleanupAutomation);`
- `src/index.ts:2299` — `planSyncWorker.start();`

Hypothesis: SDK offers dispose but cleanup is wired only to process exit; a disposed lane instance keeps PlanSyncWorker/PR monitor/event subscribers/telemetry stream alive against a deleted worktree, and each server() adds an exit listener (Node warns at 11).

Verify: grep -n dispose src/index.ts → none; harness prints 'exit listeners: 3' after three server() calls; check upstream packages/opencode/src/plugin for dispose on instance eviction.

User impact: Timers polling deleted lane dirs; MaxListenersExceededWarning after ~11 lanes/tabs.

#### INIT-9 · MEDIUM · Each worktree-lane plugin instance replays the full post-init queue (repo-graph scan, orphan reaper, HTTP preflight) inside the worktree

Lane: init. Kind: perf.

Evidence:

- `src/config/lane-permissions.ts:17` — ``Permission.state`), so in a lane instance it runs with `ctx.directory` set to`
- `src/index.ts:1196` — `void runInitOrphanRecovery(ctx.directory).catch((err: unknown) => {`
- `src/worktree/merge.ts:1971` — `['branch', options.preserveUnmerged ? '-d' : '-D', branch],`

Hypothesis: Nothing detects that ctx.directory is a swarm lane. N lanes → N workspace scans (index.ts:1113), N catalog HTTP calls, N bundled-skill copies, N orphan reapers running git worktree prune (merge.ts:1948) / branch -d on shared refs while checking only the lane's own .swarm/locks (init-orphan-recovery.ts:270, worktree-provisioning-owner.ts:22).

Verify: Harness: workspace B received repo-graph.json, repo-graph.fingerprint.json, bundled-skills, locks. Run a plan with 4 lanes; observe .swarm-worktrees/*/*/.swarm/ and concurrent scans; audit whether lane-instance recovery can see the primary's lifecycle lock.

User impact: IO/CPU spikes proportional to lane count; .swarm residue in every worktree; reaper race window during provisioning.

#### KNOWLEDGE-10 · MEDIUM · Fire-and-forget queueMicrotask audit writes (rewrite history, curation proposals) violate 'never defer work'

Lane: knowledge. Kind: design.

Evidence:

- `src/hooks/knowledge-store.ts:743` — `queueMicrotask(() => { 				appendRewriteHistory(directory, result.rewriteHistory!).catch(() => {});`
- `src/knowledge/curation-policy.ts:137` — `queueMicrotask(async () => {`
- `CLAUDE.md:33` — `onto a fire-and-forget microtask, a "later" todo, or an untracked follow-up.`

Hypothesis: transactKnowledgeWithCas reports committed:true before the #1848 immutable audit record is appended (errors swallowed); authorizeCuration returns before the proposal is persisted. knowledge-rewrites.jsonl also has no production reader (only family-migration copies it): a write path nothing reads.

Verify: grep -n queueMicrotask src/hooks/knowledge-store.ts src/knowledge/curation-policy.ts; grep -rn readRewriteHistory src \| grep -v test \| grep -v knowledge-store.ts (none). Make appendRewriteHistory reject; assert CAS still reports committed with no warning.

User impact: Promised audit trails can silently go missing; no command exposes rewrite history.

#### KNOWLEDGE-3 · MEDIUM · Memory Task-output memoryProposals/curatorMemoryDecisions capture parses input.args: dead in prod

Lane: knowledge. Kind: unwired.

Evidence:

- `src/memory/injector.ts:547` — `if (!record.args \|\| typeof record.args !== 'object') return null;`
- `src/index.ts:4286` — `await safeHook(memoryLifecycleHooks.toolAfter)(input, output);`
- `docs/memory.md:339` — `Agents may also return an optional JSON `memoryProposals` array in Task output.`

Hypothesis: captureTaskOutputProposals -> parseTaskToolInput requires input.args.prompt; the SDK toolAfter input has no args (host-boundary.ts:152) and index.ts does not pass afterCtx.args here, so the documented Task-output proposal/decision channel never runs. Opt-in feature, so MEDIUM.

Verify: Enable memory; drive index.ts tool.execute.after with tool:'Task', output.output containing valid memoryProposals JSON, no input.args; expect no pending proposal and no proposal_created run-log line. tests/unit/memory/recall-injection.test.ts:473-520 passes args inline.

User impact: Memory users following docs get nothing stored, no error.

#### KNOWLEDGE-5 · MEDIUM · Memory disabled (default) still appends a run-log line + mkdir per LLM turn to .swarm/runs/<session>/memory.jsonl

Lane: knowledge. Kind: bug.

Evidence:

- `src/memory/injector.ts:372` — `if (!gateway.isEnabled()) { 			await logInjectionSkipped(input, 'disabled');`
- `src/memory/run-log.ts:51` — `await mkdir(path.dirname(filePath), { recursive: true }); 	await appendFile(`
- `docs/memory.md:11` — `When disabled ... existing Swarm behavior is unchanged.`

Hypothesis: createMemoryLifecycleHooks is registered unconditionally (index.ts:1763); injectIntoMessages builds a gateway, claims injection budget, then logs prompt_injection_skipped/disabled to an uncapped per-session file. Registry row memory-run-logs (retention-registry.data.ts:2338-2356, #2309) records 'NO cap; runs/ in no close clean list'; the default-off case makes it hit every user every turn.

Verify: Fresh project, memory unset, N architect turns; wc -l .swarm/runs/<sid>/memory.jsonl == N. tests/unit/memory/recall-injection.test.ts:376 asserts the 'disabled' line.

User impact: One dir per session and one line per turn accumulate forever for a feature never enabled.

#### KNOWLEDGE-6 · MEDIUM · Injector writes a not_architect skip event per non-swarm-agent turn (mkdir .swarm + append + full 5000-line re-read of knowledge-events.jsonl)

Lane: knowledge. Kind: friction.

Evidence:

- `src/hooks/knowledge-injector.ts:1117` — `recordInjectionSkip(directory, 'not_architect', {`
- `src/hooks/knowledge-events.ts:406` — `await mkdir(dirPath, { recursive: true });`
- `src/hooks/knowledge-events.ts:413` — `const content = await readFile(filePath, 'utf-8');`

Hypothesis: OpenCode build/plan agents and any role outside isOrchestratorAgent/isDelegatedAgent hit this branch each turn; recordKnowledgeEvent mkdirs .swarm/, appends and re-reads up to 5000 lines under a lock, creating and growing knowledge-events.jsonl in repos where swarm was never used. Separately, appendKnowledgeEventsBatch re-reads the whole log under lock on EVERY event (knowledge-events.ts:413; MAX_EVENT_LOG_ENTRIES=5000 at :57), so each retrieved/ack event costs up to ~1.5 MB of I/O.

Verify: Repo with no .swarm/; one turn with info.agent='build' through the messages.transform chain; expect .swarm/knowledge-events.jsonl with reason 'not_architect'.

User impact: Unexpected .swarm/ in non-swarm projects; per-turn I/O proportional to the log.

#### KNOWLEDGE-7 · MEDIUM · Delegate directive injection allowlist omits explorer, researcher, docs_design, spec_writer, skill_improver, critic_* roles that hold knowledge_recall/receipt

Lane: knowledge. Kind: unwired.

Evidence:

- `src/hooks/knowledge-injector.ts:776` — `const DELEGATED_AGENTS: ReadonlySet<string> = new Set([ 	'coder', 	'reviewer', 	'test_engineer', 	'sme', 	'docs', 	'designer', 	'critic', 	'curator',`
- `src/tools/tool-metadata.ts:590` — `'critic_drift_verifier',`

Hypothesis: isDelegatedAgent matches eight roles only; stripKnownSwarmPrefix('critic_drift_verifier')/'explorer' are not in the set, so those subagents (granted knowledge_recall/receipt at tool-metadata.ts:581-604) get no <delegate_knowledge_directives> and emit a not_architect skip each turn; entries with applies_to_agents:['explorer'] can never be auto-surfaced.

Verify: messages.transform with activeAgent 'explorer' and a matching applies_to_agents entry; expect no delegate block and an injection_skip:not_architect event.

User impact: Directives targeted at explorer/critic/spec_writer roles are never auto-delivered.

#### KNOWLEDGE-8 · MEDIUM · Evergreen / low-utility quality signals have no producer: utility_score never written, thresholds unused

Lane: knowledge. Kind: deadcode.

Evidence:

- `src/hooks/knowledge-validator.ts:848` — `if (shownCount >= 5 && utilityScore !== undefined && utilityScore <= 0) {`
- `src/knowledge/curation-policy.ts:311` — `evergreen_confidence: config.evergreen_confidence,`
- `docs/knowledge.md:318` — `Entries at or below `low_utility_threshold` (default 0.3) with `shown_count ≥ 5` are flagged for removal.`

Hypothesis: utility_score is only read (validator:840), never assigned, so the branch is unreachable and hardcodes <=0 instead of low_utility_threshold; min_retrievals_for_utility has zero consumers; evergreen_*/low_utility_threshold only feed the cohort config fingerprint. docs/knowledge.md:312-318 documents non-existent behavior.

Verify: grep -rn 'utility_score\\|evergreen' src --include=*.ts \| grep -v test (validator read + fingerprint only); grep -rn min_retrievals_for_utility src (schema/types only).

User impact: Tuning these keys has no effect; documented pruning never happens.

#### KNOWLEDGE-9 · MEDIUM · Dead config keys: curator.compliance_report, skill_generation_mode, min_skill_confirmations, summaries.retention_days (docs say they work)

Lane: knowledge. Kind: drift.

Evidence:

- `src/hooks/curator.ts:1995` — `mode: 'draft',`
- `src/services/skill-improver.ts:776` — `minConfirmations: DEFAULT_SKILL_MIN_CONFIRMATIONS,`
- `docs/configuration.md:511` — `\| `skill_generation_mode` \| `draft` \\| `active` \| `draft` \| Controls whether skill candidates are drafted or promoted as active skills \|`
- `docs/knowledge.md:763` — ``min_skill_confirmations`: Minimum distinct phases required for non-strong entries (default `2`). Configurable via config schema.`
- `scripts/retention-registry.data.ts:1828` — `NO production retention — cleanupSummaries is unwired; summaries/ in no close clean list`

Hypothesis: grep over src (excluding schema/curator-types) finds zero references to the three keys; curator hardcodes mode:'draft' and skill-improver/deterministic-seed use the DEFAULT constant, so the keys are accepted, documented and ignored. summaries.retention_days (schema.ts:543) likewise has no reader and cleanupSummaries (summaries/manager.ts:239) no caller (registry #2309).

Verify: for k in compliance_report skill_generation_mode min_skill_confirmations; do grep -rn "\b$k\b" src --include=*.ts \| grep -v test \| grep -v schema.ts \| grep -v curator-types.ts; done (empty).

User impact: Setting skill_generation_mode:'active' or min_skill_confirmations:1 silently does nothing.

#### MAIN-2 · MEDIUM · Five host hooks that map to open problems are never registered: permission.ask, tool.definition, shell.env, experimental_workspace.register, chat.params

Lane: main. Kind: design.

Evidence:

- `node_modules/@opencode-ai/plugin/dist/index.d.ts:224` — `"permission.ask"?: (input: Permission, output: {`
- `node_modules/@opencode-ai/plugin/dist/index.d.ts:300` — `"tool.definition"?: (input: {`
- `node_modules/@opencode-ai/plugin/dist/index.d.ts:239` — `"shell.env"?: (input: {`
- `node_modules/@opencode-ai/plugin/dist/index.d.ts:44` — `experimental_workspace: {`

Hypothesis: grep counts in src/index.ts are 0 for all five. tool.definition would let the plugin trim the 130-tool schema per agent per turn; shell.env is the host-native path for issue #2259 (sandbox env overrides); permission.ask is the host-native way to make full-auto suppress native prompts; experimental_workspace.register is the host's worktree adapter API duplicated by src/worktree; chat.params would let per-role temperature/maxOutputTokens apply to primary agents whose model the plugin deletes.

Verify: grep -c 'permission.ask\\|shell.env\\|tool.definition\\|experimental_workspace\\|chat.params' src/index.ts; confirm each hook exists in the installed SDK d.ts; check issue #2259 body for the sandbox env mechanism.

User impact: Missed host capabilities mean heavier per-turn tool payloads, duplicated worktree logic, and sandbox env wiring still open.

#### MAIN-3 · MEDIUM · Post-resolution queue runs up to 11 detached tasks concurrently from one setTimeout(0) with no ordering, completion tracking, or surfacing beyond debug logs

Lane: main. Kind: design.

Evidence:

- `src/index.ts:420` — `const timer = setTimeout(() => {`
- `src/index.ts:1298` — `postResolutionTasks.push(() => {`
- `src/index.ts:1138` — `postResolutionTasks.push(() => {`

Hypothesis: Tasks pushed: repo-graph init, model preflight, orphan recovery, trajectory cleanup, background maintenance (opt-in), bundled-skill sync (timeout-bounded, fail-open with a 'command-path backstop'), version check, memory reflection, skill consolidation (opt-in), pr-monitor resume, config doctor. Failures are log()-only; CLAUDE.md's 'never defer work' directive requires consumed deferred outputs to be observable/verifiable. On a cold Windows FS all run simultaneously with the user's first turn.

Verify: Read src/index.ts:408-438 and every postResolutionTasks.push site (1113,1138,1195,1212,1241,1298,1319,1806,2100,2401,2435); check whether any first-turn hook awaits or reads state produced by these tasks (bundled-skills dir, repo graph, advisories).

User impact: First-turn features (bundled MODE skills, repo graph context, orphan-recovery advisories) may be absent or late with no user-visible explanation.

#### MAIN-4 · MEDIUM · config hook overwrites user-defined opencode.json agent blocks with Object.assign

Lane: main. Kind: friction.

Evidence:

- `src/index.ts:2790` — `Object.assign(agentConfig, agents);`

Hypothesis: Any `agent.architect` / `agent.coder` block a user writes in opencode.json (the host-native place to set model/prompt/permission/tools) is replaced wholesale by the generated definition; only opencode-swarm.json `agents.<name>` overrides are honoured. docs/configuration.md does not state that host-level agent blocks are ignored.

Verify: Read src/index.ts:2774-2795; grep docs/configuration.md and README.md for 'opencode.json' near 'agent'; write a test calling the config hook with agent.architect.model preset and observe it is lost.

User impact: Users familiar with OpenCode agent config set a model/permission for a swarm agent and it silently has no effect.

Pre-verification (main thread): Source-confirmed: Object.assign(agentConfig, agents) at index.ts:2790.

#### MAIN-6 · MEDIUM · package.json ships an empty binaries/ tree (only .gitkeep) as the Windows sandbox runner location; release workflow never builds runners/swarm-sandbox-runner

Lane: main. Kind: unwired.

Evidence:

- `src/sandbox/win32/runner-client.ts:125` — ` * 1. binaries/<platform>-<arch>/ in the package`
- `package.json:37` — `"binaries",`

Hypothesis: binaries/win32-x64 and win32-arm64 contain only .gitkeep; .github/workflows/release-and-publish.yml has no cargo step; findRunnerBinary falls back to PATH. With sandbox.mode default 'advisory' this degrades silently; with mode 'required' Windows shell execution is unsatisfiable unless the user builds the Rust crate themselves.

Verify: ls -la binaries/*; grep -n cargo .github/workflows/*.yml; read src/sandbox/win32/runner-client.ts:118-200 and the caller that decides required vs advisory; check docs for instructions to build/install the runner.

User impact: Windows users get advisory-only sandboxing by default and an unsatisfiable requirement if they opt into required mode.

Pre-verification (main thread): binaries/win32-* contain only .gitkeep; no cargo step in release-and-publish.yml.

#### MAIN-8 · MEDIUM · Stale bot auto-closes real defect issues (30d stale, 7d close; only pinned/security exempt)

Lane: main. Kind: design.

Evidence:

- `.github/workflows/stale.yml:16` — `days-before-stale: 30`
- `.github/workflows/stale.yml:22` — `exempt-issue-labels: 'pinned,security'`

Hypothesis: Open defects already labelled Stale include #1964 (Windows AbortSignal.timeout never fires, 5 call sites), #1965 (swarm-pr-review unexecutable from Claude Code), #1655 (quality_budget deltas are absolute totals), #1653, #1990, #1577, #1223, #1070; #1896 received the stale warning on 2026-08-24 while still reproducing.

Verify: Read .github/workflows/stale.yml; list open issues with label Stale via the GitHub MCP and confirm they describe defects.

User impact: Known bugs disappear from the tracker without a fix, so users re-report and maintainers lose the root-cause history.

#### MAIN-9 · MEDIUM · `bun run build` rewrites the tracked opencode-swarm.schema.json under the locked zod 4.3.6 (anyOf vs type arrays, optional seconds, tuple constraint dropped); committed artifact drifts from generator output

Lane: main. Kind: drift.

Evidence:

- `scripts/drift-check.ts:1356` — ` * The checked-in `opencode-swarm.schema.json` must byte-match regeneration`
- `bun.lock:207` — `"zod": ["zod@4.3.6",`
- `bun.lock:209` — `"@opencode-ai/plugin/zod": ["zod@4.1.8",`

Hypothesis: Two zod copies are locked (root 4.3.6; nested 4.1.8 under @opencode-ai/plugin). Regeneration with the root copy produced a 23+/14- diff against HEAD (saved at scratchpad/schema-drift.diff), including removal of items:false/minItems:2/maxItems:2 on a tuple (looser validation) and a relaxed date-time regex. Drift-check category 7 is soft-warn unless DRIFT_CHECK_ENFORCE=1, so CI tolerates it.

Verify: git stash -u nothing; run `bun run scripts/generate-config-schema.ts` then `git diff --stat opencode-swarm.schema.json` (expect non-empty) and `git checkout -- opencode-swarm.schema.json` afterwards; inspect scratchpad/schema-drift.diff; check .github/workflows/drift-check.yml for DRIFT_CHECK_ENFORCE.

User impact: Editor validation (the shipped schema) and runtime validation diverge; a CI-built package can ship a schema different from the committed one depending on which zod resolves.

Pre-verification (main thread): Reproduced: bun run build rewrote opencode-swarm.schema.json (23+/14-) under zod 4.3.6; diff saved in the scratchpad; file reverted before commit.

#### OBSERVABILITY-2 · MEDIUM · Invariant-9 transient retry has no producer; guardrails max_transient_retries and legacy model_fallback_index are dead

Lane: observability. Kind: unwired.

Evidence:

- `src/config/schema.ts:1057` — `max_transient_retries: z.number().min(0).max(20).default(5),`
- `src/hooks/guardrails/index.ts:1572` — `window.transientRetryCount = 0;`
- `AGENTS.md:111` — `Transient errors use bounded retry (`max_transient_retries`, default 5) **before** counting toward `consecutiveErrors``
- `src/agents/index.ts:182` — `// modifies the swarmAgents config in _swarmAgentsMap directly when session.model_fallback_index > 0.`

Hypothesis: grep transientRetryCount src finds only the reset, snapshot migration and two telemetry reads (index.ts:4549,4616, always 0); max_transient_retries in src/hooks is a comment only. session.error (index.ts:2684) advances the model chain on the first retry_same failure, so retry and fallback are not independent. Nothing sets model_fallback_index > 0, so guardrails/index.ts:1576 and messages-transform.ts:346/365 guards are constant and the agents/index.ts note describes removed code.

Verify: grep -rn 'transientRetryCount\\|model_fallback_index' src --include=*.ts \| grep -v test (no ++ or >0 assignment); grep -rn max_transient_retries src/hooks; set the key to 0 vs 20, no difference.

User impact: Documented config does nothing; one 529/503 on a Task child moves that role to a fallback model for the rest of the architect turn.

#### OBSERVABILITY-3 · MEDIUM · Retry of a failed Task can resolve its model route as 'ambiguous' and run on the primary model

Lane: observability. Kind: bug.

Evidence:

- `src/models/task-model-routing.ts:175` — `if (match) return 'ambiguous';`
- `src/index.ts:3914` — `registerPendingTaskModelRoute({`
- `src/index.ts:2635` — `bindPendingTaskModelRouteChild({`

Hypothesis: Action identity excludes attempt number, so the retry registers a second route with the same parent/role/digest while the failed route (bound to child A) survives until the next beginInvocation. If child B's chat.message (index.ts:4739) runs before the part-metadata binding (:2635 awaits taskMetadata first), matchingRouteForParent, which does not skip routes bound to another child, returns 'ambiguous' -> no override and the exhausted preflight is bypassed. task-model-routing.test.ts:116 only covers different digests.

Verify: Unit: two routes with identical parent/role/actionDigest, bind the first to 'child-a', resolveTaskChatModelOverride({childSessionID:'child-b', lookupParentSessionID: async()=>'parent'}) -> 'ambiguous'. Runtime: fallback_models on coder, force 429 on the child, re-dispatch, inspect diagnose routing snapshot.

User impact: The #1896 quota-failover scenario can still fail: the retry meant to use the fallback runs on the exhausted primary with no advisory.

#### OBSERVABILITY-4 · MEDIUM · Task-path model fallback advances with no model_fallback telemetry or advisory

Lane: observability. Kind: friction.

Evidence:

- `src/index.ts:2686` — `advancePendingTaskModelRoute({`
- `src/index.ts:4702` — ``MODEL_FALLBACK_EXHAUSTED: no configured model remains for ${routeModel.role}`,`

Hypothesis: All 8 telemetry.modelFallback emitters are direct-dispatch paths (oversight, intercept, review, lean, curator, skill-improver); the architect->Task path advances the chain in the session.error handler with no emit, no pushAdvisory, no core event, so only exhaustion is visible.

Verify: grep -n 'modelFallback\\|pushAdvisory' src/index.ts near 2660-2700 (none); trigger a retryable session.error on a Task child and grep .swarm/telemetry.jsonl for model_fallback.

User impact: Users cannot see that a role moved to another model; cost/status attribution misleads until MODEL_FALLBACK_EXHAUSTED.

#### OBSERVABILITY-5 · MEDIUM · learning-health rehydrate regex excludes '-': fixture-share and hyphenated model scopes vanish after restart

Lane: observability. Kind: bug.

Evidence:

- `src/health/learning-health.ts:851` — `return /^[0-9a-zA-Z:_.-/]+$/.test(key);`
- `src/health/learning-health.ts:1335` — `const scopeKey = `${projectRef(input.directory)}/fixture-share`;`
- `src/health/learning-health.ts:806` — `if (!isAdoptableScopeKey(key)) continue;`

Hypothesis: '.-/' inside the class is the range 0x2E-0x2F, so a literal hyphen is rejected. Every promoted_fixture_share scope and every model_limit_fallback identity scope (:959, e.g. claude-sonnet-4) fails adoption; the persist that status/diagnose trigger on read then rewrites the artifact without them.

Verify: bun -e "console.log(/^[0-9a-zA-Z:_.-/]+$/.test('abc/fixture-share'))" -> false; persist an active promoted_fixture_share scope, resetLearningHealthForTest(), readLearningHealth(dir) -> no active alarms. learning-health-feeds.test.ts:402-437 covers hex session scopes only.

User impact: After any plugin restart /swarm status and diagnose report no active alarms for these families although they were raised.

#### OBSERVABILITY-6 · MEDIUM · Telemetry disable latch is permanent, invisible, and also kills heartbeat/'Last activity'

Lane: observability. Kind: friction.

Evidence:

- `src/telemetry.ts:298` — `if (_writeStream !== null \|\| _disabled) {`
- `src/telemetry.ts:343` — `if (_disabled \|\| _writeStream === null) {`

Hypothesis: One write/stream error sets _disabled (:319,:370,:464) for the life of the server-scoped process; initTelemetry never reopens; emit returns before listener fan-out so heartbeat tracking stops. No getter exists and status/diagnose/doctor never report it.

Verify: make .swarm/telemetry.jsonl unwritable mid-session; /swarm status shows 'Last activity: never' and /swarm costs stops growing with no warning; grep -rn 'isTelemetryDisabled\\|telemetryDisabled' src (none).

User impact: Silent loss of cost/gate/health telemetry for every later session until OpenCode restarts.

#### OBSERVABILITY-7 · MEDIUM · Three emit call sites use the 'kind as Parameters<typeof emit>[0]' force-cast #2029 outlawed; catalog cites them as producers

Lane: observability. Kind: drift.

Evidence:

- `src/index.ts:636` — `'delegation_cost_correction' as Parameters<typeof emitTelemetry>[0],`
- `src/index.ts:1561` — `'delegation_cost_binding' as Parameters<typeof emitTelemetry>[0],`
- `docs/engineering-invariants.md:233` — `that bypasses `TelemetryEvent` (or, going forward, `EVENT_CATALOG`) to`

Hypothesis: Same construct at index.ts:1581. The kinds are in the union so the casts are dead weight, but they are exactly what let agent_conflict_detected enter unregistered; check-event-contract.ts only requires the cited line to contain the kind, so dropping a kind from the union leaves these sites compiling and emitting.

Verify: grep -rn "as Parameters<typeof emit" src --include=*.ts (3 live sites); remove 'delegation_cost_join' from TelemetryEvent and run bun run typecheck (still passes).

User impact: No direct symptom; the CI contract gate is blind to a re-introduced bypass class.

#### OBSERVABILITY-8 · MEDIUM · Retention registry admits 16 unbounded .swarm streams as fix-in-issue #2309, open with no PR

Lane: observability. Kind: design.

Evidence:

- `scripts/retention-registry.data.ts:2029` — `writeLimits: { bound: 'NONE', scope: 'none', citation: 'src/hooks/knowledge-store.ts:312-317 (no trim; plan-critic-verified)' },`
- `scripts/retention-registry.data.ts:2865` — `writeLimits: { bound: 'NONE', scope: 'none', citation: 'src/knowledge/curation-policy.ts:136-150 (no cap; best-effort append)' },`

Hypothesis: check:retention passes because fix-in-issue is allowed, so knowledge-retractions.jsonl, unacknowledged-criticals.jsonl (:2838, no reader), consolidation-log.jsonl (:2324, no lock, full-file reader), curation-proposals.jsonl (full-file read per health check), context-snapshot.md, summaries (cleanupSummaries unwired) and capsules (deleteCapsule dead) grow forever. CLAUDE.md forbids deferred work; the gate institutionalizes it.

Verify: grep -c 'issue: 2309' scripts/retention-registry.data.ts (16); gh issue view 2309 (open since 2026-08-23, 0 linked PRs); bun run check:retention (green).

User impact: Long-lived projects accumulate unbounded files under .swarm; knowledge health re-parses a growing file on every check.

#### OBSERVABILITY-9 · MEDIUM · #2409 unfixed: PR-monitor breaker set after awaited snapshot write, never trips when the store throws (cross-scope src/background)

Lane: observability. Kind: bug.

Evidence:

- `src/background/pr-monitor-worker.ts:935` — `await _internals.updateSnapshot(this.directory, correlationId, {`
- `src/background/pr-monitor-worker.ts:948` — `this.circuitBreakerMap.set(correlationId, cb);`

Hypothesis: handlePollError increments a local cb, awaits updateSnapshot without try/catch, then sets the map; a deterministic write failure escapes first, so failure_threshold is never reached and the worker logs every interval.

Verify: Stub _internals.updateSnapshot to throw, call handlePollError > failure_threshold times, assert circuitBreakerMap is empty.

User impact: Per-poll error spam and no backoff when the subscription store refuses writes.

#### PARALLEL-10 · MEDIUM · lean_turbo_acquire_locks has no release path and poisons lean_turbo_run_phase

Lane: parallel. Kind: design.

Evidence:

- `src/parallel/file-locks.ts:209` — `export async function releaseLock(`
- `src/tools/lean-turbo-acquire-locks.ts:44` — `const result = await acquireLaneLocks(`
- `src/turbo/lean/runner.ts:1302` — `laneInState.error = 'lock conflict - tasks routed to serial fallback';`

Hypothesis: releaseLock is a documented no-op; the tool's _release closures are dropped at JSON serialization; no release tool exists; proper-lockfile refreshes mtime so the 5-minute stale window never expires while the process lives, and cleanupExpiredLocks unlinks only sentinels. A later lean_turbo_run_phase on the same files fails acquireLaneLocks and serializes the lane.

Verify: executeLeanTurboAcquireLocks for src/a.ts, then LeanTurboRunner.runPhase with a lane on src/a.ts → lane 'failed' with 'lock conflict'; grep tool-metadata for a release tool (none).

User impact: An advertised tool whose output nothing consumes and whose use silently serializes the phase.

#### PARALLEL-5 · MEDIUM · `/swarm turbo lean on` with no `turbo` config: banner names an un-granted tool and the phase gate arms

Lane: parallel. Kind: drift.

Evidence:

- `src/agents/index.ts:1368` — `if (config?.turbo !== undefined) {`
- `docs/commands.md:497` — `explicitly controls Lean Turbo regardless of the config `turbo.strategy`.`
- `src/commands/turbo.ts:292` — `state.status = 'running';`
- `src/tools/phase-complete.ts:921` — `applicable: hasActiveLeanTurbo(sessionID) && !epicActiveForProject,`

Hypothesis: Activation is session-scoped, but lean tools (tool-metadata.ts:921-949, all agents:[]) join the architect's tools only when config.turbo exists (tool-filter-council-hardening.test.ts:165 asserts absence). LEAN_TURBO_BANNER says use lean_turbo_run_phase; run state has no phase so phase_complete fails 'No active Lean Turbo session'. Callability of the un-granted tool depends on OpenCode treating an absent tools key as enabled (agents/index.ts:1422-1436 writes only trues); docs/modes.md:238 says lanes plan 'when turbo.lean is configured in config'.

Verify: getAgentConfigs({}) → architect.tools.lean_turbo_run_phase undefined; /swarm turbo lean on without config, then phase_complete → LEAN_TURBO_PHASE_NOT_READY; check OpenCode semantics for absent tools keys.

User impact: Documented command path yields an unfulfillable instruction and a blocked phase; recovery is /swarm turbo lean off.

#### PARALLEL-6 · MEDIUM · Windows worktree-removal retry keys on errno names git never prints

Lane: parallel. Kind: portability.

Evidence:

- `src/worktree/core.ts:1085` — `(lastError.includes('EBUSY') \|\| lastError.includes('EPERM')) &&`
- `tests/unit/turbo/lean/worktree.test.ts:264` — `return mockProc(1, '', 'EBUSY: resource busy');`
- `tests/unit/worktree/core.test.ts:83` — `// Non-retryable, non-EBUSY "use --force" error → hits give-up on attempt 0.`

Hypothesis: lastError is git stderr; git emits strerror text ('Permission denied', 'Directory not empty'), never EBUSY/EPERM identifiers, so the DD-10 retry never fires on real Windows file locks; one --force attempt follows, then the lane is abandoned. Fixtures encode Node-style strings git does not produce.

Verify: On Windows hold a file open in a lane, run `git worktree remove <lane>`, compare stderr with the substring check; or inspect git builtin/worktree.c error strings.

User impact: Lane cleanup fails whenever an editor/AV/node process holds a handle; stale worktrees accumulate and the next provision collides.

#### PARALLEL-7 · MEDIUM · lean_turbo_plan_lanes and lean_turbo_status ignore user turbo.lean config

Lane: parallel. Kind: drift.

Evidence:

- `src/tools/lean-turbo-plan-lanes.ts:72` — `const defaultConfig = { ...DEFAULT_LEAN_TURBO_CONFIG };`
- `src/tools/lean-turbo-status.ts:59` — `const defaultConfig: LeanTurboStatusConfig = {`
- `src/tools/lean-turbo-run-phase.ts:81` — `config.turbo?.strategy === 'lean' ? config.turbo.lean : undefined;`

Hypothesis: Runner and epic_plan_waves (epic-plan-waves.ts:245) honor user max_parallel_coders/conflict_policy/degrade_on_risk; the preview tool always plans with defaults and the status tool reports defaults as `config`; run-phase drops turbo.lean when strategy is 'standard' while epic_plan_waves reads it regardless.

Verify: Config turbo:{strategy:'lean',lean:{max_parallel_coders:1}}; executeLeanTurboPlanLanes on 3 disjoint tasks → 3 lanes; executeLeanTurboStatus → max_parallel_coders 4.

User impact: Previews/status contradict execution; configuration appears ignored.

#### PARALLEL-8 · MEDIUM · Epic promoted waves run in the shared primary tree with no worktree isolation or locks

Lane: parallel. Kind: design.

Evidence:

- `src/hooks/delegation-gate.ts:4130` — `const standardWorktreeIsolationActive =`
- `src/commands/turbo.ts:199` — `const leanMsg = enableLeanTurbo(session, directory, sessionID);`
- `src/config/constants.ts:842` — `This is the only sanctioned dispatch path. Don't use `lean_turbo_run_phase``
- `docs/modes.md:668` — `when Epic dispatches coders into isolated git worktrees`

Hypothesis: standardWorktreeIsolationActive requires !hasActiveLeanTurbo (delegation-gate.ts:4130-4133); Epic forces Lean Turbo active and dispatches Task-per-wave rather than LeanTurboRunner (owner of locks/worktrees). Concurrent Epic coders share the primary tree, protected only by scope-guard disjointness, while docs and the epic-worktree-merge-guard test assume isolation.

Verify: /swarm epic on, promote a 2-task wave, dispatch two coder Tasks; `git worktree list` shows no lanes; trace standardWorktreeIsolationActive with hasActiveLeanTurbo=true.

User impact: Concurrent coders can collide on shared artifacts; the documented merge-back safety net does not exist for Epic waves.

#### PARALLEL-9 · MEDIUM · runtime_isolation lane env profile never reaches coder shell/test processes

Lane: parallel. Kind: unwired.

Evidence:

- `src/worktree/types.ts:10` — `written as `.swarm/lanes/{laneIndex}.env``
- `src/git/branch.ts:241` — `? readLaneEnvFileFromDiskSync(cwd, laneIndex)`
- `src/hooks/delegation-gate/worktree-isolation.ts:3256` — `export async function readLaneEnvFileFromDisk(`
- `src/hooks/guardrails/tool-before.ts:1408` — `const envOverrides =`

Hypothesis: Only the plugin's own git spawns (git/branch.ts:241, git/pr.ts:464) read the file; the async reader has zero callers; guardrails injects env only for macOS sandbox-exec (tool-before.ts:1408-1411); lane prompt (runner.ts:2114-2126) and coder prompt never mention the file. Lanes running tests/dev servers still collide on PORT and caches.

Verify: grep -rn readLaneEnvFileFromDisk src \| grep -v test; set runtime_isolation {enabled:true, port_base:4000}; coder runs `echo $PORT` → empty.

User impact: A documented isolation feature is a no-op for the processes it exists for.

#### PLAN-10 · MEDIUM · Every status update appends a full-plan snapshot (replay never derives phase.status); every loadPlan (each turn) re-parses the whole ledger; no compaction

Lane: plan. Kind: perf.

Evidence:

- `src/plan/manager.ts:1737` — `computePlanHash(replayedBeforeProjection) !==`
- `src/plan/ledger.ts:1612` — `task.status = parseResult.data;`
- `src/plan/ledger.ts:1029` — `writeFileFsyncedThenRename(tempPath, ledgerPath, existingContent + line);`

Hypothesis: applyEventToPlan updates task.status only while savePlan derives phase.status, so hashes differ on nearly every status change and a whole-plan snapshot is appended (docs: every 50 events); appends rewrite the file (O(N^2)); getLatestLedgerHash (:703) parses every line per loadPlan, which phase-monitor.ts:62 calls every turn.

Verify: v9-snapshot-cause.ts: one status update = task_status_changed + savePlan_structural_projection; v7-perf.ts: 40-task plan, 60 save_plan = 752 KB, +40 status updates = 1.25 MB.

User impact: 100+ task plans reach multi-MB ledgers; each update and each turn pays full-file I/O + parse.

#### PLAN-11 · MEDIUM · save_plan identity, locked-profile and task-removal guards are keyed on plan.json readability; an unreadable projection disables all three

Lane: plan. Kind: design.

Evidence:

- `src/tools/save-plan.ts:615` — `// First plan write or unreadable — proceed with defaults`
- `src/tools/save-plan.ts:956` — `parallelization_enabled: true,`

Hypothesis: Tool (:612-632, :661, :876) and manager (:1563) derive the prior plan from loadPlanJsonOnly; with an invalid plan.json and intact ledger, identity/locked-profile/removal checks are skipped and the v8 parallel default replaces a locked serial profile.

Verify: Corrupt plan.json (task size 'gigantic'), executeSavePlan with a different title, no confirm_identity_change, no execution_profile -> success with parallelization_enabled=true.

User impact: Protections vanish exactly when the projection is damaged; a locked serial plan flips to parallel without re-approval.

#### PLAN-5 · MEDIUM · manager.updateTaskStatus is an unlocked read-modify-write: concurrent callers revert each other's completions and the ledger records the reverts

Lane: plan. Kind: bug.

Evidence:

- `src/plan/manager.ts:2332` — `const plan = await _internals.loadPlan(directory);`
- `src/plan/manager.ts:2364` — `//   2. We only mutate the single targeted task — no other task status can`

Hypothesis: Load precedes savePlan lock (:1244); a stale whole-plan write downgrades siblings and the diff loop emits completed->in_progress with valid CAS. Shipped callers (tool :1705, task-terminal.ts:205, task-repair.ts:107, close-terminal) hold the lock across load+save; the cited fast-path advanceTaskStateAndPersist (state.ts:3113) has no caller; :2322 returns the unchanged plan silently on refused backward moves. HIGH if any caller skips the lock.

Verify: bun scratchpad/plan-lane-verify/v8b-ledger-trace.ts: 4 concurrent completions -> 0 rejected, 1/4 persisted, ledger '1.2:in_progress->completed' then '1.2:completed->in_progress'.

User impact: Silent loss of completions plus falsified audit trail for any concurrent programmatic caller.

#### PLAN-6 · MEDIUM · M1 silent-rollback guard missing from loadPlan's validation-failure and no-plan.json paths

Lane: plan. Kind: bug.

Evidence:

- `src/plan/manager.ts:985` — `const rebuilt = await replayFromLedger(directory);`
- `src/plan/ledger.ts:1406` — `react to ledger truncation (to avoid the M1 silent-rollback) should use`

Hypothesis: Only Step 1 (:725-756) uses replayFromLedgerWithStatus; Steps 2 (:985) and 4 (:1056) rebuild plan.json from the prefix-only projection with no _ledgerReplayStale, dropping every durable event after a poison line.

Verify: bun scratchpad/plan-lane-verify/v6-m1-step2.ts (a): poison line mid-ledger + schema-invalid plan.json -> plan.json rewritten with 1.2=pending though ledger recorded completed; no stale flag.

User impact: Schema-invalid plan.json plus one corrupt ledger line silently reverts completed work.

#### PLAN-7 · MEDIUM · Snapshot payloads are replayed unvalidated; a parseable malformed snapshot makes rebuildPlan overwrite a valid plan.json with garbage

Lane: plan. Kind: bug.

Evidence:

- `src/plan/ledger.ts:1500` — `let plan: Plan \| null = snapshotPayload.plan;`
- `src/plan/manager.ts:1976` — `writeFileSync(fd, JSON.stringify(targetPlan, null, 2), 'utf8');`

Hypothesis: plan_created embeds are schema-validated (ledger.ts:1529) but snapshot embeds are not, and rebuildPlan writes whatever replay returns; version skew or a tampered line turns a valid projection invalid (then PLAN-6/PLAN-1).

Verify: v6-m1-step2.ts (b): append snapshot with payload.plan={bogus:true} -> plan.json becomes {"bogus": true}; loadPlanJsonOnly null afterwards.

User impact: One bad ledger line destroys the projection instead of being isolated.

#### PLAN-8 · MEDIUM · importCheckpoint has no production caller; docs and phase_complete guidance promise a recovery from .swarm/plan-export/ that nothing performs

Lane: plan. Kind: unwired.

Evidence:

- `src/plan/checkpoint.ts:90` — `export async function importCheckpoint(`
- `src/tools/phase-complete.ts:208` — `(or recover from .swarm/plan-export/) before re-dispatching docs`

Hypothesis: Never wired since v6.44 (docs/releases/v6.44.0.md:56 'programmatic only'; docs/plan-durability.md:470 lists it); /swarm close deletes the export (close.ts:2626). Violates 'never ship unwired code'.

Verify: grep -rn importCheckpoint src --include=*.ts \| grep -v test -> only src/plan/checkpoint.ts; grep -rn plan-export src/commands src/tools -> cleanup + advisory text only.

User impact: Operators following docs/phase_complete text cannot recover; the checkpoint is write-only.

#### PLAN-9 · MEDIUM · 'closed' task status is invisible in plan.md, reverts to pending on md->json migration, and phase derivation has no closed branch

Lane: plan. Kind: drift.

Evidence:

- `src/plan/manager.ts:2577` — `taskLine = `- [ ] ${task.id}: ${task.description}`;`
- `src/plan/manager.ts:213` — `phase.status = 'pending';`

Hypothesis: closed exists in TaskStatusSchema/ledger/docs but not in derivePlanMarkdown, migrateLegacyPlan (:2747), derivePhaseStatusesInPlace, or epic_plan_waves' pending filter (epic-plan-waves.ts:158) — six-surface rule.

Verify: bun scratchpad/plan-lane-verify/v5-closed-and-settled.ts -> closed renders '- [ ]', round-trip gives pending, all-closed phase -> 'pending' after savePlan.

User impact: After /swarm close plan.md shows closed work as unchecked; a later save flips the phase to PENDING; epic_plan_waves offers closed tasks.

#### PROMPTS-3 · MEDIUM · issue-trace [MODE: X] tail system message is relocated to index 0 by consolidation; rule S only fires on 'the latest message'

Lane: prompts. Kind: bug.

Evidence:

- `src/hooks/issue-trace.ts:294` — `out.messages.push(...messagesToAdd);`
- `src/index.ts:3483` — `consolidateSystemMessagesInPlace(output.messages);`
- `tests/unit/hooks/system-message-consolidation-in-place.test.ts:298` — `// The tail directive is RELOCATED, not dropped: it no longer sits last.`
- `src/agents/architect.ts:714` — `If the latest message contains a bracket header of the form [MODE: X ...]`

Hypothesis: issueTraceHook.messagesTransform precedes the final consolidation handler; every role:'system' entry moves to index 0 (pinned by the test). The one-shot transition (state advances after delivery, issue-trace.ts:262-294) lands at the top of history, not where the prompt looks; if missed it is lost.

Verify: Read the test L270-300; with an active issue trace dump output.messages after the last messages handler: '[MODE: EXECUTE]' at index 0, user turn last.

User impact: Issue-tracer mode transitions silently missed.

#### PROMPTS-5 · MEDIUM · Coder/architect prompts and bundled skills bake this plugin's own repo conventions into every user project

Lane: prompts. Kind: drift.

Evidence:

- `src/agents/coder.ts:96` — `   - src/utils/`
- `src/agents/architect.ts:340` — `Match: architect*.ts, delegation*.ts, guardrails*.ts, adversarial*.ts, sanitiz*.ts, auth*, permission*`
- `src/agents/architect.ts:530` — `Always provide `writing-tests` to test_engineer and `engineering-conventions` to coder + reviewer when those skills are present in the project.`
- `.opencode/skills/writing-tests/SKILL.md:5` — `Guidelines for writing, organizing, and maintaining tests in the opencode-swarm repository.`

Hypothesis: REUSE SCAN dirs, the TIER 3 matcher (this plugin's file names) and TS-only rules are this repo's layout. writing-tests/engineering-conventions (audience swarm-plugin) are in BUNDLED_PROJECT_SKILLS, materialized into every project (index.ts:1300), always audience-eligible (skill-propagation-gate.ts:574), and the architect is told to always pass them: a Python test_engineer gets 'MUST import from bun:test'.

Verify: In a non-TS project: ls .swarm/bundled-skills \| grep -E 'writing-tests\|engineering-conventions'; render coder prompt via createAgents() and grep bun:test.

User impact: Wrong conventions in non-TypeScript projects; tier-3 escalation keyed to file names users lack.

#### PROMPTS-6 · MEDIUM · Prompts mandate 'Emit JSONL event …' but no agent has an event tool; two named events are absent from the event contract

Lane: prompts. Kind: unwired.

Evidence:

- `src/agents/coder.ts:252` — `Emit JSONL event 'coder_self_audit' at end of every task, before TASK_COMPLETE.`
- `src/agents/reviewer.ts:191` — `Emit event: 'reviewer_substance_check' with fields: { function_name: string, issue_type: string }`
- `src/agents/architect.ts:274` — `Emit JSONL event 'sounding_board_consulted'. Emit JSONL event 'architect_loop_detected' on 3rd impasse.`

Hypothesis: TOOL_METADATA (129 tools) has no emit-event tool (measure-tools.ts); no hook parses these markers; coder_presubmit_results (coder.ts:236) and reviewer_substance_check are not in src/types/events.ts. Only delegation-gate.ts:2374 emits coder_retry_circuit_breaker itself.

Verify: grep -rn "coder_self_audit\\|coder_presubmit_results\\|reviewer_substance_check" src --include=*.ts \| grep -v test \| grep -v src/agents/ — only type/listing hits.

User impact: Dead instructions; promised analytics never exist.

#### PROMPTS-7 · MEDIUM · Explorer told to write doc-manifest.json and knowledge/doc-constraints.jsonl while write:false and without knowledge_add; doc-constraints.jsonl has no producer

Lane: prompts. Kind: unwired.

Evidence:

- `src/agents/explorer.ts:181` — `- Write constraints to .swarm/knowledge/doc-constraints.jsonl as knowledge entries with source: "doc-scan"`
- `src/agents/explorer.ts:421` — `write: false,`
- `src/agents/architect.ts:313` — `call knowledge_recall with query "doc-constraints"`

Hypothesis: Explorer map lacks doc_extract/knowledge_add (measure-tools.ts); doc_scan writes only the manifest; the knowledge append is in extractDocConstraints (doc-scan.ts:573) behind architect-only doc_extract; grep 'doc-constraints' in src hits only the two prompts.

Verify: grep -rn 'doc-constraints' src --include=*.ts; delegate explorer in DOCUMENTATION DISCOVERY MODE; observe no file / WRITE BLOCKED.

User impact: Rule 6f-1 documentation awareness silently produces nothing on the explorer path.

#### PRREVIEW-4 · MEDIUM · Dead legacy circuit message still says 'stop without partial findings'; legacy shape kept in the state union

Lane: prreview. Kind: deadcode.

Evidence:

- `src/hooks/pr-workflow-gate.ts:4450` — `collect every launched lane, abort_pr_workflow, and stop without partial findings`;`
- `src/hooks/pr-workflow-gate.ts:429` — `type PrReviewResilienceCircuitRecord =`
- `src/hooks/pr-workflow-gate.ts:4486` — `const adoption = adoptPrReviewCircuit(snapshot.circuit, nowMs);`
- `src/hooks/pr-review-resilience-circuit.ts:326` — `if (asLegacy.success) {`

Hypothesis: Both callers (4584, 4989) pass outcome.snapshot.circuit after adoption migrated legacy->v2 or dropped malformed, so the non-'version' branch is unreachable; it is the exact string #2375 Step 4a removed. Unwired branch per CLAUDE.md directive 2.

Verify: grep -n 'formatPrReviewResilienceCircuitOpenMessage(' src/hooks/pr-workflow-gate.ts and confirm each argument is post-adoption; grep -n 'circuit.count\\|circuit.signature' (only 4450).

User impact: None today; a refactor passing the raw persisted record silently revives forbidden abort guidance.

#### PRREVIEW-5 · MEDIUM · pr_workflow_status never surfaces circuit state or wake suspension

Lane: prreview. Kind: friction.

Evidence:

- `src/tools/pr-workflow-status.ts:274` — `function describeNextStep(`
- `src/tools/pr-workflow-status.ts:299` — `Continue read-only review using the admitted observe/validate tools (diff, gh_evidence, repo_map, lint check, etc.).`;`
- `src/hooks/pr-workflow-response-gate.ts:981` — `type: 'pr_workflow_wake_suspended',`

Hypothesis: summarizeGate (302) exposes tier/batches/revision but not prReviewResilience.circuit.{state,openUntil} nor the wake budget; grep -i 'circuit\|suspend' on the file is empty. Operators asking why a review stopped get the generic continue text while the session is suspended or the circuit is OPEN.

Verify: grep -n -i 'circuit\\|resilience\\|suspend\\|wake' src/tools/pr-workflow-status.ts (empty); seed a gate state with circuit.state='OPEN' and run executePrWorkflowStatus.

User impact: Only the banner and .swarm/events.jsonl explain a stopped review.

#### PRREVIEW-6 · MEDIUM · Tier-L micro guidance (one lane per family on every batch, 11 families) is unsatisfiable under MAX_LANES = 8

Lane: prreview. Kind: drift.

Evidence:

- `src/tools/dispatch-lanes.ts:109` — `export const MAX_LANES = 8;`
- `src/hooks/pr-workflow-gate.ts:340` — `L: PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length,`
- `.opencode/skills/swarm-pr-review/SKILL.md:883` — `floor (one micro-lane per family on every micro batch, not only the first),`
- `src/tools/dispatch-lanes.ts:719` — `const coversAllFamilies =`

Hypothesis: The per-batch floor binds only when one batch covers all matched families (719-731); the aggregate check is in write_pr_review_trigger_eval, so an 8+3 split passes, but the skill never says to split and demands one lane per family on every micro batch (883) while stating the 8-lane cap (974). Tier L also forbids consolidation.

Verify: sed -n 880,886p;974p .opencode/skills/swarm-pr-review/SKILL.md; sed -n 700,731p src/tools/dispatch-lanes.ts; attempt an 11-lane micro dispatch -> zod max(8).

User impact: Large PRs with many risk triggers stall at Phase 4 with contradictory instructions.

#### REPOGRAPH-10 · MEDIUM · context_map post-agent update is called with files_touched: [] and task_goal: '' by its only caller, so file summaries are never populated and capsules always fall back to read_original

Lane: repograph. Kind: unwired.

Evidence:

- `src/index.ts:4437` — `files_touched: [],`
- `src/context-map/post-agent-update.ts:439` — `for (const filePath of params.files_touched) {`
- `src/context-map/capsule-builder.ts:202` — `const entry = map.files[filePath];`

Hypothesis: updateContextMapAfterAgent is the only producer of map.files (refreshFileEntry); capsule-builder imports extractFileSummary into _internals but never calls it. With context_map.enabled=true (opt-in) every task-history record has an empty goal/file list and every read policy is 'file not in context map'.

Verify: grep -rn 'updateContextMapAfterAgent(' src \| grep -v test (one caller); grep -n 'extractFileSummary(' src/context-map/capsule-builder.ts (none). Enable context_map, run a Task, inspect the persisted map: files == {} and task_history[].files_touched == [].

User impact: Users who enable context_map get capsules that never summarize files; the map accumulates empty task entries.

#### REPOGRAPH-3 · MEDIUM · Every write tool re-serializes the whole graph (37 MB pretty JSON) plus a full fingerprint walk inside the awaited hook; the next turn re-parses and re-validates it synchronously

Lane: repograph. Kind: perf.

Evidence:

- `src/tools/repo-graph/incremental.ts:757` — `await _internals.saveGraph(workspaceRoot, graph);`
- `src/tools/repo-graph/storage.ts:530` — `JSON.stringify(graph, null, 2),`
- `src/tools/repo-graph/freshness.ts:525` — `const walk = await _internals.walkRepoGraphInputs(root, {`
- `src/hooks/repo-graph-injection.ts:238` — `graph = loadGraphSync(directory);`

Hypothesis: Measured per Edit: stringify 507 ms + write 291 ms + fingerprint walk 340 ms, awaited in tool.execute.after; the save changes mtime so the injection LRU misses and the next system.transform pays readFileSync 94 + JSON.parse 182 + validation 205 ms synchronously (storage.ts:332). Pretty-printing adds 42% (26.3 MB compact); RSS after build 616 MB.

Verify: Time an edit round-trip with repo_graph.enabled true vs false on a 4k-file repo, or spy _internals.saveGraph/writeFingerprint around updateGraphForFiles(ws,[file]); time loadGraphSync on scratchpad/repo-graph.sample.json.

User impact: ~1-1.5 s per edit (more on Windows/AV) plus ~0.5 s event-loop block on the following turn; memory grows over long sessions.

#### REPOGRAPH-4 · MEDIUM · Workspaces past max_files (10k) or the 5 s walk budget are permanently 'inconclusive': startup never refreshes; a stale BFS-prefix graph is served until a manual build; Windows stat latency makes this common

Lane: repograph. Kind: portability.

Evidence:

- `src/tools/repo-graph/builder.ts:2243` — `incomplete:`
- `src/tools/repo-graph/freshness.ts:532` — `// A cap/budget-truncated walk can safely certify its positively witnessed`
- `src/hooks/repo-graph-builder.ts:335` — `if (probe.state === 'clean' \|\| probe.state === 'inconclusive') {`
- `src/tools/repo-graph/builder.ts:2215` — `const fileStats = await fsPromises.stat(fullPath);`

Hypothesis: The walk stats every source file sequentially (340 ms for 4,156 files here); dispatch.ts:91-93 documents 5-20 ms per stat on Windows with AV, so 250-1,000 files exhaust walk_budget_ms=5000 -> truncated -> incomplete -> inconclusive on every probe. doInit takes the no-refresh branch, repo_map only adds a freshnessNote, injection treats inconclusive as usable; nothing ever rebuilds automatically.

Verify: Test: advance freshness _internals.now past walkBudgetMs during the walk (or walkBudgetMs:1000 on a repo needing more); writeFingerprint then probeFreshness -> 'inconclusive'; hook.init() with spies asserts no updateGraphForFiles/buildWorkspaceGraph. Windows runner: time walkRepoGraphInputs(captureMetadata:true) on a 3k-file checkout.

User impact: On large repos or Windows, git pull/branch switches never reach the graph; agents get confidently wrong importer/blast-radius data marked only 'freshness unknown'.

#### REPOGRAPH-5 · MEDIUM · Freshness probe (full readdir+stat walk, up to 5 s) runs inside the awaited system-prompt transform whenever its 30 s cache expires

Lane: repograph. Kind: perf.

Evidence:

- `src/hooks/repo-graph-injection.ts:203` — `const probe = await _internals.probeFreshness(directory, options);`
- `src/tools/repo-graph/freshness.ts:41` — `const CACHE_TTL_MS = 30_000;`
- `src/hooks/system-enhancer.ts:1485` — `const localizationBlock = await buildCoderLocalizationBlock(`

Hypothesis: evaluateGraphGates probes before consulting the LRU, so a coder/reviewer turn with a declared scope pays a whole-workspace stat walk before the LLM request whenever the cache expired (index.ts:3517 chain); bounded only by walk_budget_ms, the REPOGRAPH-4 pathological case, to gate a ~300-char block.

Verify: Spy repoGraphInjection._internals.probeFreshness across system.transform calls >30 s apart; time buildCoderLocalizationBlock with a cold probe cache on a large repo.

User impact: Periodic 0.3-5 s added latency on agent turns for large or slow-FS workspaces with no visible cause.

#### SDK-1 · MEDIUM · System enhancer injects swarm directives into host prompts with no sessionID (Agent.generate path)

Lane: sdk. Kind: bug.

Evidence:

- `src/hooks/system-enhancer.ts:715` — `_input: { sessionID?: string; model?: unknown },`
- `src/hooks/system-enhancer.ts:1078` — `const activePlanningAgent = _input.sessionID`
- `node_modules/@opencode-ai/plugin/dist/index.d.ts:266` — `sessionID?: string;`
- `maps/sdk/host-agent.ts (opencode dev packages/opencode/src/agent/agent.ts):381` — `yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })`

Hypothesis: SDK types sessionID optional and the host calls the hook without one from Agent.generate (system=[PROMPT_GENERATE]). Only session-bound branches are guarded, so a non-swarm call receives '[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY]', '[SWARM CONFIG] You must NEVER run the full test suite', '[PRE-FLIGHT ADVISORY]...' (4 entries, 2318 chars, default config). Same gap on native agents' first turn (activeAgent is set by chat.message, after system.transform).

Verify: bun run maps/sdk/enhancer-nosession.ts -> 'system entries after = 5'; read system-enhancer.ts:761-1110 for any early return when _input.sessionID is undefined.

User impact: OpenCode's agent-generation prompt and native agents' first turn get swarm planning/test-policy directives and a binaries-missing advisory the user never asked for.

#### SDK-2 · MEDIUM · Returned hooks literal never type-checked against Hooks; dead keys; a misspelled hook would ship silently

Lane: sdk. Kind: test.

Evidence:

- `src/index.ts:826` — `async function initializeOpenCodeSwarm(`
- `src/index.ts:2542` — `agent: agents,`
- `src/index.ts:3605` — `'command.execute.before': safeHook(commandHandler) as any,`

Hypothesis: No return annotation and returning a variable (546-551) defeats excess-property checks; handlers are `as any` (3501,3579,3601,3605,4077,4681,4810). Hooks (index.d.ts:173-322) has no name/agent/automation and the host reads only typed names, so name (2539), agent (2542, comment '// Register all agents' is false — registration is the config hook) and automation are dead. A typo in any hook key compiles and never fires; no test compares Object.keys(hooks) to keyof Hooks.

Verify: Add `satisfies Hooks` to the return at src/index.ts:2537 and run `bun run typecheck` -> errors on name/agent/automation. grep -rn 'keyof Hooks' tests/ -> none.

User impact: Latent v6.85.1-class failure: a future hook rename ships as a no-op with green CI; today three dead properties and a misleading comment.

#### SDK-3 · MEDIUM · #1899 freshness advisory is blind to patch skew: 1.18.3 vs 1.18.25 reports 0 behind

Lane: sdk. Kind: drift.

Evidence:

- `scripts/drift-check.ts:1204` — `return b.minor - a.minor;`
- `scripts/drift-check.ts:1152` — `const DEP_FRESHNESS_DEFAULT_THRESHOLD = 5;`
- `tests/unit/scripts/drift-check-dep-freshness.test.ts:88` — `expect(minorSeriesBehind('1.1.53', '1.18.3')).toBe(17);`

Hypothesis: OpenCode ships patches (25 in the 1.18 series) and sdk/v2 types + peer ranges changed 1.18.3->1.18.25, yet minorSeriesBehind ignores the patch component, so the CI notice never fires within a minor series — the check built for #1899 cannot see the current skew. bun.lock:67 pins 1.18.3.

Verify: bun run maps/sdk/minor-behind.ts -> 0; npm view @opencode-ai/plugin version -> 1.18.25; diff -rq node_modules/@opencode-ai/sdk/dist maps/sdk/sdk-latest/package/dist.

User impact: Maintainers get no signal while the lockfile ages 22 releases behind what users run; runtime-shape assumptions go un-re-audited.

#### SDK-5 · MEDIUM · Automation framework ships as an admitted scaffold: user config keys and a started manager with no behavior

Lane: sdk. Kind: unwired.

Evidence:

- `src/index.ts:2227` — `// Initialize background automation framework (scaffold only - no business features yet)`
- `src/index.ts:2531` — `// v6.7 automation flags (scaffold only - not yet active)`
- `src/background/manager.ts:104` — `log('[Automation] Starting framework...');`

Hypothesis: Directive 2 forbids unwired code paths: automation.mode/capabilities are user-facing config that create+start (2236-2237) a manager whose start() only flips a flag and publishes 'automation.started' (manager.ts:95-109); the instance is exported on a non-Hooks key (4814) nobody reads.

Verify: grep -rn automation opencode-swarm.schema.json README.md docs/; trace manager.ts start()/capabilities for any consumer; confirm no test asserts a behavioral effect of automation.mode.

User impact: Users set automation.mode/capabilities and nothing happens.

#### SECURITY-2 · MEDIUM · #2263 lane-env denylist leaves HOME/PATH/XDG_CONFIG_HOME open; commitAndPush spawns bare 'git' with lane env; chain unwired; CI guard misses it

Lane: security. Kind: security.

Evidence:

- `src/sandbox/executor.ts:68` — `const UNTRUSTED_ENV_KEY_PREFIXES = ['GIT_', 'LD_', 'DYLD_'] as const;`
- `src/git/pr.ts:495` — `const _pushResult = spawnSyncWithTransientRetry( 'git', ['push', '-u', 'origin', branch],`
- `src/git/pr.ts:481` — `envOverrides: resolvedLaneEnv,`
- `docs/releases/pending/2263-lane-env-denylist.md:30` — `only reachable today through `runPRWorkflow` / `commitAndPush`, which have no production callers`

Hypothesis: PoC (scratchpad/homeprobe/probe.mjs): a lane env with only HOME=<attacker dir> passes isValidEnvKey+isUntrustedEnvKey (branch.ts:175-176) and makes ABSOLUTE-path git status execute core.fsmonitor from $HOME/.gitconfig - gitExec (branch.ts:264) is exploitable, not only bare spawns. PATH also passes; libuv and Bun resolve a bare name against the CHILD env PATH (probe: bare git -> HIJACKED-GIT on node and bun), which pr.ts:472/496 rely on. Reach today: runPRWorkflow (src/git/index.ts:30) and readLaneEnvFileFromDisk (worktree-isolation.ts:3256) have zero callers - unwired code holding a latent repo-to-RCE primitive. bun run check:bare-spawn passes because the literals pass through a local wrapper.

Verify: bun -e "import {isUntrustedEnvKey as u} from './src/sandbox/executor.ts'; console.log(u('HOME'),u('PATH'),u('XDG_CONFIG_HOME'))" -> false x3. Re-run scratchpad/homeprobe/probe.mjs -> marker FSMONITOR-HOOK-EXECUTED. grep -rn 'runPRWorkflow(\\|readLaneEnvFileFromDisk\b' src \| grep -v test -> definitions only. bun run check:bare-spawn -> passes despite pr.ts:472,496.

User impact: Latent: once runPRWorkflow/commitAndPush is wired or any caller passes laneIndex, cloning a repo that commits .swarm/lanes/0.env with HOME= or PATH= runs attacker code during git status/commit/push. Today: dead exports and a false-green CI guard.

#### SECURITY-3 · MEDIUM · search fallback runs model-supplied regex synchronously with no timeout; packaged ripgrep is not a dependency

Lane: security. Kind: perf.

Evidence:

- `src/tools/search.ts:629` — `regex = new RegExp(opts.query);`
- `src/tools/search.ts:683` — `if (regex.test(line)) {`
- `src/tools/search.ts:249` — `const mod = require('@vscode/ripgrep') as { rgPath?: unknown };`
- `src/tools/search.adversarial.test.ts:396` — `// Should either timeout gracefully or complete without hanging`

Hypothesis: REGEX_TIMEOUT_MS only bounds the ripgrep subprocess (search.ts:361). package.json dependencies (132-143) lack @vscode/ripgrep, so resolvePackagedRipgrep is dead on a normal install; any host without rg on PATH uses fallbackSearch: up to 64 MiB walked, regex.test per line on the host event loop, unbounded; createSwarmTool adds no timeout. Measured scratchpad/redos/raw.mjs: (x+x+)+y on 28 chars = 13.5 s node / 1.0 s bun, doubling per char. Tests accept completes as pass.

Verify: grep -n ripgrep package.json -> none. Run scratchpad/redos/raw.mjs under node and bun. With rg off PATH: bun -e "const {_internals}=await import('./src/tools/search.ts'); await _internals.fallbackSearch({query:'(x+x+)+y',mode:'regex',maxResults:10,maxLines:200,workspace:'<dir with one 34-x line>'})" -> minutes-long block, never 'regex-timeout'.

User impact: On any host without ripgrep one regex search (model-chosen or induced by injected content) freezes the whole OpenCode process with no timeout or error.

#### SECURITY-4 · MEDIUM · Delegation sanitizer flattens whole gate-agent prompts and never fires for multi-swarm prefixed agents

Lane: security. Kind: bug.

Evidence:

- `src/hooks/delegation-sanitizer.ts:72` — `sanitized = sanitized.replace(/\s+/g, ' ').trim();`
- `src/hooks/delegation-sanitizer.ts:85` — `const gateAgents = ['reviewer', 'test_engineer', 'critic', 'test-engineer'];`
- `src/agents/index.ts:547` — `- @${swarmId}_reviewer (not @reviewer)`

Hypothesis: sanitizeMessage collapses ALL whitespace in a text part whenever any pattern matches, so a reviewer/critic delegation containing '2nd attempt' loses every newline (probe: '```ts const a = 1; const b = 2; ```'). isGateAgentMessage does not strip swarm prefixes (host-boundary.ts uses stripKnownSwarmPrefix), so with prefixed agents the hook (index.ts:1762, 3420) silently never fires; tests cover unprefixed names only (tests/unit/hooks/delegation-sanitizer.test.ts:67-87).

Verify: bun -e "import {isGateAgentMessage as g, sanitizeMessage as s} from './src/hooks/delegation-sanitizer.ts'; console.log(g('local_reviewer')); console.log(JSON.stringify(s('Review (2nd attempt)\n```ts\nx\n```').sanitized))" -> false; one-line string.

User impact: Reviewers/critics get garbled prompts (fences, diffs, lists flattened) after any urgency phrase; multi-swarm users get no manipulation stripping and no warning.

#### TESTSCI-2 · MEDIUM · Quarantined tests never return: excluded on their OS while the exit criterion is a green streak on that OS; audit doc understates active quarantines

Lane: testsci. Kind: test.

Evidence:

- `scripts/ci/quarantined-tests-windows.txt:58` — `retained until the fix proves out across merge-group windows-latest runs`
- `docs/audits/test-stability-audit.md:12` — `- Active integration quarantines: **0**.`

Hypothesis: ci.yml:423 only subtracts; no continue-on-error soak job; detect-and-quarantine-flakes.sh rule A drops already-quarantined files, so quarantine is one-way. pr-monitor-status.test.ts:10 already imports freezeClock (PR #2190) yet stays listed; quarantined-integration-tests.txt:12 is active while the audit says 0.

Verify: grep -n quarantined .github/workflows/ci.yml; git log -- scripts/ci/quarantined-tests-windows.txt; confirm recent MG windows jobs never ran pr-monitor-status.test.ts

User impact: /pr-monitor-status and the Windows sandbox wrapper have no Windows CI coverage indefinitely.

#### TESTSCI-3 · MEDIUM · Coverage gate counts only files some test imported and includes tests/helpers + tests/preload; never-imported src is invisible to the 65% floor

Lane: testsci. Kind: test.

Evidence:

- `scripts/ci/merge-lcov.mjs:45` — `if (line.startsWith('SF:')) {`
- `scripts/ci/merge-lcov.mjs:95` — `const coverage = total === 0 ? 0 : (covered * 100) / total;`

Hypothesis: Bun emits SF only for loaded modules; merge-lcov unions them, so deleting a module's tests raises coverage. Probe on errors.test.ts: 36 SF = 33 src files (of 880) + tests/helpers/prod-store-tripwire.ts + both tests/preload files at 100%.

Verify: bun test --coverage tests/unit/utils/errors.test.ts; grep -c '^SF:' coverage/lcov.info; grep '^SF:tests/' coverage/lcov.info; compare a MG coverage-report SF count with 880

User impact: The 65% floor (#2344) does not bound untested source; modules ship at 0% with the gate green.

#### TESTSCI-4 · MEDIUM · 163 gated assertions bound live wall-clock elapsed time with literal ms values (down to 50 ms) on shared runners

Lane: testsci. Kind: test.

Evidence:

- `tests/adversarial/parallel-dispatcher-gated.test.ts:84` — `expect(elapsed).toBeLessThan(50);`
- `tests/unit/evaluation/model-dispatcher.test.ts:246` — `expect(performance.now() - startedAt).toBeLessThan(250);`

Hypothesis: freezeClock spies only Date.now/toISOString (test-stability.md:193-199); elapsed deltas stay live (#2362 class). 163 such lines + 179 real sleeps >=100 ms; the 2-retry loop masks them into notices that detection sees only on failed runs. Also init-fail-open.test.ts:53 (<800 ms).

Verify: grep -rnE 'expect\([^)]*(elapsed\|duration\|Date\.now\(\) - \|performance\.now\(\) - )[^)]*\)\.toBeLessThan\([0-9_]+\)' tests src --include='*.test.ts' \| wc -l; run under CPU stress

User impact: Windows/macOS cells fail under load; retries double shard time; regressions blur into noise.

#### TESTSCI-5 · MEDIUM · check-test-clock / check-test-tmpdir lint raw lines: a comment with Date.now() blocks, a comment with 'freezeClock(' passes, contradicting the gate's own text

Lane: testsci. Kind: bug.

Evidence:

- `scripts/check-test-clock.ts:107` — `return addedLines.some((line) => RAW_CLOCK_PATTERN.test(line));`
- `scripts/check-test-clock.ts:130` — `(A comment mentioning the helper does NOT satisfy this check`

Hypothesis: fileHasClockHelper() (lines 96-100) runs HELPER_CALL_PATTERN (line 38) over whole content incl. comments; added lines are not comment-stripped; check-test-tmpdir.ts:111 same shape (#2391/#2267 class).

Verify: Branch: append '// note: Date.now() unused' to a helper-less test file, bun run check:test-clock (ERROR); add '// freezeClock()' (passes)

User impact: Comment edits block PRs; contributors paste helper names into comments, hollowing the gate.

#### TESTSCI-6 · MEDIUM · pr-standards.yml and check-pending-fragment.ts disagree on which paths need a release fragment (tests/,scripts/ vs .github/workflows/)

Lane: testsci. Kind: drift.

Evidence:

- `.github/workflows/pr-standards.yml:147` — `grep -Eq '^(src/\|bin/\|scripts/\|tests/\|test/\|runners/\|examples/\|binaries/\|package\.json`
- `scripts/check-pending-fragment.ts:60` — `'tests/',`

Hypothesis: Both run on every pull_request (ci.yml:246-248; pr-standards job). check-pending-fragment.ts:59-64 NEVER list = tests/, scripts/; line 46 makes .github/workflows/ user-visible. Tests-only PR: quality passes, pr-standards fails; workflow-only PR: reverse.

Verify: Open a PR touching only tests/unit/foo.test.ts without a fragment; compare both checks

User impact: Contradictory 'single source of truth' gates; release notes fill with no-op fragments.

#### TESTSCI-7 · MEDIUM · PR-tier blind spots: integration/coverage/smoke(Node repro-704/1873)/PHP/Rust are merge_group-only; 3-OS matrix skips src/utils, src/db, src/git, src/cli, src/hooks, src/config

Lane: testsci. Kind: portability.

Evidence:

- `.github/workflows/ci.yml:144` — `grep -E '^(src/worktree/\|src/turbo/\|src/sandbox/\|src/plan/\|src/parallel/\|src/knowledge/\|src/memory/\|src/tools/\|scripts/`
- `.github/workflows/ci.yml:1030` — `run: bun run repro:1873`

Hypothesis: Most Windows/Node-sensitive files sit outside the list: src/utils/git-executable.ts (#2236), src/utils/path-security.ts, src/db/sqlite-loader.ts (#1873), src/index.ts (#704), src/cli. ci.yml:781 gates integration to merge_group; first contact with other hosts is the 30-65 min queue.

Verify: Edit src/utils/path-security.ts on a branch, open a PR: unit matrix ubuntu-only; integration/smoke/coverage succeed with all steps skipped

User impact: Desktop (Node sidecar) and Windows regressions surface at merge time or after release (#1729 class).

#### TESTSCI-8 · MEDIUM · Integration and coverage loops run bun test without the Bun #32056 keepalive or kill wrapper: an idle-loop hang bypasses --timeout and burns the job timeout

Lane: testsci. Kind: bug.

Evidence:

- `.github/workflows/ci.yml:797` — `bun --smol test "$f" --timeout 120000 > "$tmp" 2>&1 \|\| exit_code=$?`
- `scripts/ci/run-coverage-gate.sh:151` — `bun test --isolate --coverage --timeout 60000 "$test_file" > "$tmpout" 2>&1`

Hypothesis: bun-32056-keepalive.ts:5: --timeout cannot fire on an idle loop; the unit job wraps every file for that reason, these loops do not. One hung file (integration step ~2.8 of a 10-min budget, ci.yml:762) hangs until GitHub kills the job: no retry, no annotation, no flake artifact (run-coverage-gate.sh:58-60).

Verify: Add tests/integration/hang.test.ts: test('h',()=>new Promise(()=>{})); compare bun --smol test <f> --timeout 5000 vs bun scripts/ci/run-test-with-timeout.ts <f> --timeout 5000 --kill-timeout 10

User impact: A hang in any of 78 integration files stalls the queue for the full timeout with no diagnostics.

#### TESTSCI-9 · MEDIUM · AGENTS invariant 3 timeout requirement has no blocking gate: check-invariants Check 1 is advisory with violations hard-coded to 0

Lane: testsci. Kind: unwired.

Evidence:

- `scripts/check-invariants.ts:209` — `const messages = ['=== Check 1: Subprocess timeout required (advisory) ==='];`
- `scripts/check-invariants.ts:240` — `return { messages, violations: 0 };`

Hypothesis: Line 230 accepts any 'timeout:' token anywhere in the file; check-bare-executable-spawn.ts has no timeout logic; AGENTS.md:57 says timeout is required. The invariant behind v7.3.3/#732 is review-only.

Verify: Add spawnSync('git',['status']) without timeout to a src file already containing 'timeout:'; bun run check:invariants exits 0

User impact: An unbounded init-path spawn can merge green and hang Desktop/TUI startup on Windows.

#### TOOLS-4 · MEDIUM · getAgentConfigs fire-and-forget writes a new .swarm/evidence/agent-tools-init-<ts>.json on every plugin init: unvalidated root, unregistered retention, unbounded growth

Lane: tools. Kind: bug.

Evidence:

- `src/agents/index.ts:1452` — `const sid = sessionId ?? `init-${Date.now()}`; const evidenceDir = path.join(directory, '.swarm', 'evidence');`
- `src/agents/index.ts:1467` — `void mkdir(evidenceDir, { recursive: true }).then(() => writeFile(snapshotPath, snapshotData))`
- `src/index.ts:1352` — `const agents = getAgentConfigs(configWithResolvedAutoReview, ctx.directory, undefined,`

Hypothesis: Init passes sessionId=undefined so every load creates a uniquely named file; nothing prunes them (scripts/retention-registry.data.ts has no agent-tools entry; only /swarm close wipes evidence/). Un-awaited promise on the init path (CLAUDE.md directive 1, AGENTS.md #1); .swarm/evidence created under ctx.directory without assertProjectRoot (invariant 4); errors swallowed at line 1472.

Verify: Call getAgentConfigs({}, tmpGitDir) twice → two agent-tools-init-*.json files; grep -n agent-tools scripts/retention-registry.data.ts → none; trace src/index.ts:1352 for root validation (none).

User impact: One JSON per launch accumulates; .swarm/ appears wherever OpenCode was opened; cold-FS work races init on Windows.

#### TOOLS-5 · MEDIUM · Architect carries ~133 KB (~33k tokens) of tool description+schema per turn by default; repo_map alone 9.5 KB

Lane: tools. Kind: perf.

Evidence:

- `src/tools/tool-metadata.ts:1054` — `export const AGENT_TOOL_MAP: Record<AgentName, ToolName[]> = (() => {`
- `tests/unit/config/agent-tool-map.test.ts:39` — `it('subagent tool counts are <= 23', () => {`

Hypothesis: Measured via zod toJSONSchema over TOOL_MANIFEST: architect 93 tools = 133,264 B; all 129 = 171,411 B; repo_map 9,469 B, dispatch_lanes_async 8,692, save_plan 5,961. Tests cap counts; nothing budgets bytes or exposes tools lazily. With TOOLS-1, subagents carry the full 171 KB.

Verify: For each TOOL_MANIFEST thunk sum description.length + JSON.stringify(z.toJSONSchema(z.object(t.args),{io:'input'})).length, grouped by AGENT_TOOL_MAP (script: scratchpad/tools-bytes.ts); cross-check a captured provider request.

User impact: ~33k tokens of tool definitions before any context each architect turn; default Zen/local models mis-select tools.

#### TOOLS-6 · MEDIUM · /swarm doctor tools is a tautology (two projections of TOOL_METADATA, config ignored) and cannot detect config-dependent gaps such as TOOLS-3

Lane: tools. Kind: design.

Evidence:

- `src/services/tool-doctor.ts:144` — `export function runToolDoctor( _directory: string, _pluginRoot?: string,`
- `src/services/tool-doctor.ts:50` — `function getRegisteredToolKeys(): Set<string> { return new Set<string>(TOOL_NAME_SET);`
- `AGENTS.md:128` — `(c) entry in `TOOL_NAMES` (`src/tools/tool-names.ts`) and the relevant agent tool map (`AGENT_TOOL_MAP` or an opt-in map in `src/config/constants.ts`)`

Hypothesis: TOOL_NAMES, TOOL_NAME_SET and AGENT_TOOL_MAP all derive from TOOL_METADATA, so both doctor checks hold by construction and buildPluginToolObject(config) is never consulted. Docstring at tool-doctor.ts:122 cites a src/index.ts tool block that no longer exists; AGENTS.md #11(c) points at re-export facades (real edit site: TOOL_METADATA.agents).

Verify: Set knowledge.enabled=false, run /swarm doctor tools → 'No issues found' despite 6 granted-but-unregistered tools; read tool-doctor.ts:140-176.

User impact: The documented diagnostic for tool-registration drift gives false assurance.

#### COMMANDS-7 · LOW · docs/commands.md claims to list all subcommands but omits 29 registry commands; the drift command detector cannot see docs coverage

Lane: commands. Kind: drift.

Evidence:

- `docs/commands.md:3` — `All `/swarm` subcommands available in the current OpenCode Swarm source tree.`
- `scripts/drift-check.ts:899` — `// COMMAND_NAME_SET must mirror COMMAND_NAMES exactly.`
- `src/commands/registry.ts:1502` — `'deep-research': {`

Hypothesis: 29 non-alias keys have no '/swarm <key>' mention (deep-research, ci-simulate, abort-pr-workflow, approve-plan-critic, guardrail reset, context-map stats, help, coupling, epic, link, link status, unlink, skill-opt +8, knowledge hive-quarantine/unactionable/retry-hardening, memory audit-verify/consolidation-log/link/link status/unlink); the first four appear in no docs/*.md. Invariant 11(d) requires doc surfaces; the detector only checks set parity and subcommandOf.

Verify: Dump VALID_COMMANDS with aliasOf==null; for each k: grep -q "/swarm $k\b" docs/commands.md \|\| echo UNDOCUMENTED; grep -rl '/swarm deep-research' docs README.md -> none.

User impact: Major features (deep research, CI simulation, escape hatches) are undiscoverable from the reference doc.

#### COMMANDS-8 · LOW · Init comment misstates bundled-sync bounds (per-directory, not total); per-directory rollback can leave cross-skill version skew

Lane: commands. Kind: drift.

Evidence:

- `src/index.ts:330` — `The copy is content-aware and bounded to ≤64 small files`
- `src/config/bundled-skills.ts:268` — `const files = await collectBundledSkillFilesBoundedAsync(sourceDir, {`
- `src/config/bundled-skills.ts:298` — `await rollbackCopiedFilesAsync(copiedFiles, destDir, overwrittenFiles);`

Hypothesis: MAX_SKILL_FILES/MAX_SKILL_BYTES apply per copyBundledDirectoryBoundedAsync call (fresh CopyState); real inventory is 41 dirs / 68 files / 893,493 bytes. A failure in dir N rolls back only dir N, so after an interrupted upgrade sync execute may reference a not-yet-updated gate-attribution until the next successful init; withTimeout races but does not cancel the copy.

Verify: find .opencode/skills -path '*/generated' -prune -o -type f -print \| xargs cat \| wc -c (893493); read bundled-skills.ts:264-301.

User impact: Misleading init-latency reasoning; rare mixed-version skill set after an interrupted upgrade.

#### CONFIG-10 · LOW · Init writes .swarm/config.example.json (sync fs) into any directory OpenCode opens, with no project-root guard

Lane: config. Kind: design. Duplicates merged: INIT-3.

Evidence:

- `src/index.ts:1277` — `writeSwarmConfigExampleIfNew(ctx.directory);`
- `src/config/project-init.ts:31` — `fs.mkdirSync(swarmDir, { recursive: true });`
- `AGENTS.md:62` — `No tool may create `.swarm/` under `src/`, `tests/`, `packages/*`, or any arbitrary `cwd`.`

Hypothesis: Unlike snapshot/git-hygiene steps gated by hasSwarmState/hasGitMarkerAncestor, this write runs unconditionally with existsSync/mkdirSync/writeFileSync on the server()-resolution path; opening OpenCode in $HOME creates ~/.swarm/. Cross-scope (index lane) but the producer is src/config.

Verify: cd /tmp/empty && opencode (or call initializeOpenCodeSwarm with ctx.directory=/tmp/empty) → .swarm/config.example.json appears; grep -n 'homedir\\|validateProjectRoot' src/index.ts → none.

User impact: Stray .swarm/ directories in home/non-project folders; minor cold-FS init cost on Windows.

#### CONFIG-6 · LOW · OPENCODE_CONFIG_DIR honoured by the host but ignored by plugin config/prompt lookup, doctor, /swarm config and the CLI

Lane: config. Kind: portability.

Evidence:

- `src/config/loader.ts:43` — `return process.env.XDG_CONFIG_HOME \|\| path.join(os.homedir(), '.config');`
- `src/config/cache-paths.ts:60` — `const override = process.env.OPENCODE_CONFIG_DIR;`
- `src/config/lane-permissions.ts:326` — ``getPluginConfigDir` deliberately does not.`

Hypothesis: Only the lane allowlist uses getHostConfigDir(); loader.ts:852/1056, config-doctor.ts:654, commands/config.ts:9, cli/index.ts:43 use the XDG dir. docs/configuration.md:10 documents only ~/.config; a user who relocated OpenCode config via OPENCODE_CONFIG_DIR gets defaults silently.

Verify: OPENCODE_CONFIG_DIR=/tmp/oc with /tmp/oc/opencode-swarm.json setting agents.coder.model; /swarm config shows default model and 'User: ~/.config/opencode/opencode-swarm.json'.

User impact: Custom models/prompts ignored with no error for users of the host's config-dir override.

#### CONFIG-7 · LOW · install() rewrites opencode.json every run (JSONC comments stripped) and evicts caches unconditionally — open issue #2437 item 2

Lane: config. Kind: friction.

Evidence:

- `src/cli/index.ts:273` — `const stripped = content`
- `src/cli/index.ts:286` — `fs.writeFileSync(filepath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');`

Hypothesis: No 'already installed' early return; comments in a JSONC-style opencode.json are dropped and formatting changed; every re-run deletes caches/lock files. uninstall() reads only opencode.json, so a plugin registered in opencode.jsonc is 'not installed'.

Verify: printf '{\n // keep\n "plugin":["opencode-swarm"]}' > $X/opencode/opencode.json; run install; grep keep → gone. Issue #2437 lists the same.

User impact: Re-running install as troubleshooting mutates a hand-maintained config and forces a fresh download.

#### CONFIG-8 · LOW · Environment-variable reference table omits variables the code reads

Lane: config. Kind: drift.

Evidence:

- `docs/configuration.md:38` — `## Environment variables`
- `src/cli/index.ts:879` — `process.env.SWARM_ALLOW_HUMAN_ONLY_CLI !== '1'`
- `src/memory/injector.ts:506` — `if (process.env.OPENCODE_SWARM_MEMORY_UNITID_PROBE !== '1') return;`

Hypothesis: Table lists 9 vars; OPENCODE_SWARM_GIT_BINARY only in the Git section, SWARM_ALLOW_HUMAN_ONLY_CLI only in a CLI error string, OPENCODE_CONFIG_DIR only in a lane note, SWARM_OBSERVABILITY_LINEAGE_SALT (observability/ids.ts:60) only in observability docs, OPENCODE_SWARM_MEMORY_UNITID_PROBE nowhere.

Verify: grep -rnoE 'process\.env\.(SWARM_\|OPENCODE_)[A-Z0-9_]+' src --include=*.ts \| grep -v test; compare docs/configuration.md:40-52.

User impact: Operators cannot discover the CLI automation bypass or salt/probe knobs from the reference.

#### CONFIG-9 · LOW · When only one of user/project config is corrupt, secure() wipes the valid file's guardrails section and mislabels recovery 'guardrails_defaults'

Lane: config. Kind: design.

Evidence:

- `src/config/loader.ts:657` — `guardrails: { enabled: true },`
- `src/config/loader.ts:671` — `recovery: 'guardrails_defaults',`

Hypothesis: Step 5 succeeds on the surviving file (agents/models applied) but secure() replaces the whole guardrails object (profiles, max_tool_calls, sandbox) with {enabled:true} and warns 'Falling back to conservative defaults' (667) — inaccurate for doctor consumers and not what the user configured.

Verify: Valid user config with guardrails.profiles.architect.max_tool_calls=500 + agents.coder.model=X; project config '{'; loadPluginConfigWithMeta(dir) → agents.coder.model===X, guardrails.profiles undefined, recovery==='guardrails_defaults'.

User impact: A broken project file silently discards global guardrail tuning while keeping models; the label implies everything was discarded.

#### DOCS-11 · LOW · README: automation `manual` = no background automation, but plan_sync (default true)…

Lane: docs. Kind: drift.

Evidence:

- `README.md:1016` — `Default mode: `manual`. No background automation`
- `src/index.ts:2293` — `if (automationConfig.capabilities?.plan_sync === true) {`

Hypothesis: Only phase_preflight is mode-gated (trigger.ts:280); PlanSyncWorker starts on the capability flag alone. Two docs contradict each other…

Verify: sed -n '2284,2300p' src/index.ts; grep -n 'plan_sync: z.boolean().default' src/config/schema.ts

User impact: Users expecting nothing in the background still get a file watcher…

#### DOCS-12 · LOW · README first-run note says installer creates a project override; installer only prints an…

Lane: docs. Kind: drift.

Evidence:

- `README.md:27` — `creates a project override when missing`
- `README.md:170` — `It does **not** create a project config.`

Hypothesis: 7.159.0 removed auto-creation (grep -n 'stop auto-creating empty project override' CHANGELOG.md); README:27 not reconciled.

Verify: grep -n 'opencode-swarm.json' src/cli/index.ts; install into a temp project; no…

User impact: Contradictory README; users look for a file never created.

#### DOCS-13 · LOW · README says prm.max_trajectory_lines / escalation_enabled are unenforced; both are…

Lane: docs. Kind: drift.

Evidence:

- `README.md:503` — `(`max_trajectory_lines`, `escalation_enabled`) are defined in schema but not…`
- `src/index.ts:1690` — `max_lines: prmConfig.max_trajectory_lines,`

Hypothesis: Stale caveat; #2041 wired max_trajectory_lines as the trajectory budget.

Verify: grep -rn 'max_trajectory_lines\\|escalation_enabled' src --include='*.ts' \| grep -v test

User impact: Users skip knobs that work or distrust ones that do.

#### DOCS-14 · LOW · README guardrail table understates built-in per-agent profiles (architect uncapped…

Lane: docs. Kind: drift.

Evidence:

- `README.md:523` — `\| Tool calls \| 200 \|`
- `README.md:530` — `profiles override the global `max_consecutive_errors` to **8**`

Hypothesis: DEFAULT_AGENT_PROFILES (:994-1044) also override max_tool_calls and max_duration_minutes and apply without user config; README mentions…

Verify: sed -n '994,1044p;1209,1240p' src/config/schema.ts

User impact: Users believe every agent is capped at 200 calls/30 min; the…

#### DOCS-15 · LOW · sast_scan advertised as 68 rules / 8 languages; registry has 74 rules over 10 language ids

Lane: docs. Kind: drift.

Evidence:

- `README.md:550` — `**sast_scan** — 68 security rules across 8 languages (offline)`
- `README.md:825` — `\| sast_scan \| Offline security analysis, 68 rules, 8 languages \|`

Hypothesis: Rules added (e.g. #1002 audit) without updating README; not in DOCS_NUMERIC_CLAIMS.

Verify: bun -e "const r=await import('./src/sast/rules/index.ts');console.log(r.getRuleStats())" ->…

User impact: Cosmetic; shows numeric claims are unmaintained.

#### DOCS-16 · LOW · design-rationale.md asserts serial-only execution and a .swarm/history/ dir; v8…

Lane: docs. Kind: drift.

Evidence:

- `docs/design-rationale.md:29` — `**Swarm's approach**: One agent at a time. Always.`
- `docs/design-rationale.md:88` — `└── history/     # Archived phase summaries`

Hypothesis: #1619 class: the rationale and index blurb describe removed behaviour; grep finds no `.swarm/history` producer.

Verify: grep -rn "'history'" src --include='*.ts' \| grep -v test (only CC command lists); sed -n…

User impact: Readers of the rationale get the opposite of the shipped default.

#### DOCS-17 · LOW · modes.md cites update-task-status.ts:98-109 for the Tier-3 list; those lines are…

Lane: docs. Kind: drift.

Evidence:

- `docs/modes.md:27` — `This list is enforced at `src/tools/update-task-status.ts:98-109`.`
- `src/tools/update-task-status.ts:99` — `async function recordRunMemoryOutcome(`

Hypothesis: Stale citation; the patterns still match src/parallel/tier3-classifier.ts:2-29.

Verify: sed -n '95,110p' src/tools/update-task-status.ts; sed -n '1,30p'…

User impact: Auditors of the Turbo safety claim are pointed at unrelated code.

#### DOCS-18 · LOW · getting-started Step 2 runs /swarm diagnose inside a session before Step 3 opens OpenCode

Lane: docs. Kind: friction.

Evidence:

- `docs/getting-started.md:61` — `Before proceeding, confirm Swarm is loaded. Inside an OpenCode session, run:`
- `docs/getting-started.md:91` — `## Step 3 — Open Your Project`

Hypothesis: Steps inverted; the sample labels are real (diagnose-service.ts:300/392/478/565).

Verify: Read docs/getting-started.md:59-98 in order.

User impact: First-run confusion at the exact 'if errors, go back' checkpoint.

#### DOCS-9 · LOW · README 'All Slash Commands' table omits ~40 non-deprecated registry commands

Lane: docs. Kind: drift.

Evidence:

- `README.md:1123` — `<summary><strong>All Slash Commands</strong></summary>`
- `src/commands/registry.ts:981` — `learning: {`

Hypothesis: 154 registry keys vs 67 rows. Missing: learning, loop, codebase-review, deep-research, qa-gates, lanes, recover, rollback, curate…

Verify: grep -o -P "^\t(?:'[a-z][a-z0-9 -]*'\|[a-z][a-zA-Z0-9-]*): \{" src/commands/registry.ts \| wc -l…

User impact: Recovery commands (`recover`, `rollback`) invisible in the…

#### EVIDENCE-11 · LOW · Phase status alias 'completed' accepted by schema but post-mortem checks only 'complete'; isPhaseComplete unused

Lane: evidence. Kind: drift.

Evidence:

- `src/config/plan-schema.ts:37` — `'completed', // Alias for 'complete' - both accepted`
- `src/tools/phase-complete.ts:2116` — `(p: { status?: string }) => p.status === 'complete',`
- `src/tools/phase-complete.ts:1323` — `!['complete', 'completed', 'closed'].includes(phaseObject.status)`

Hypothesis: A phase saved as 'completed' is left as-is at commit and never counts for the all-phases post-mortem; isPhaseComplete/normalizePhaseStatus have no callers in src.

Verify: grep -rn 'isPhaseComplete(\\|normalizePhaseStatus(' src --include=*.ts \| grep -v 'test\\|plan-schema.ts' -> none.

User impact: Post-mortem silently never runs for plans using the documented alias.

#### EVIDENCE-12 · LOW · completion_verify gate is trivially satisfiable by the gated model (any 3+ letter word from an LLM-authored description, includes() match)

Lane: evidence. Kind: design.

Evidence:

- `src/tools/completion-verify.ts:135` — `const camelCaseRegex = /\b([a-z][a-zA-Z0-9]{2,})\b/g;`
- `src/tools/completion-verify.ts:421` — `if (fileContent.includes(identifier)) {`
- `src/tools/phase-complete.ts:833` — `id: 'completion_verify',`

Hypothesis: Identifiers and files_touched both come from the architect-written plan; one common word in one file passes. Code (L347-351) admits best-effort yet it is surfaced as a blocking phase gate with actor test_engineer.

Verify: Task {description:'Implement retry logic', files_touched:['README.md'], status:'completed'} with README containing 'retry' -> passed.

User impact: False assurance; real incompleteness is not caught.

#### EVIDENCE-13 · LOW · record_directive_override compares against optional plan.current_phase instead of getCurrentPhase; recovery path can dead-end

Lane: evidence. Kind: friction.

Evidence:

- `src/tools/record-directive-override.ts:44` — `if (!plan \|\| !requestedPhase \|\| plan.current_phase !== args.phase) {`
- `src/config/plan-schema.ts:109` — `current_phase: z.number().int().min(1).optional(),`

Hypothesis: save-plan.ts:233 copies current_phase verbatim; when absent the only recovery phase_complete offers (L702) always returns DIRECTIVE_OVERRIDE_PHASE_MISMATCH.

Verify: plan.json without current_phase; executeRecordDirectiveOverride({directive_ids:['x'],justification:'ten chars ok',phase:1},dir,{sessionID:'s',agent:'architect'}) -> PHASE_MISMATCH.

User impact: Architect cannot record an audited override; phase stays blocked.

#### HOOKS-11 · LOW · 2h stale-session sweep re-bootstraps a live subagent as architect, bypassing scope-guard

Lane: hooks. Kind: security.

Evidence:

- `src/state.ts:1977` — `// re-bootstraps the entry to ORCHESTRATOR_NAME (src/index.ts`
- `src/index.ts:3618` — `swarmState.activeAgent.set(input.sessionID, ORCHESTRATOR_NAME);`
- `src/hooks/scope-guard.ts:106` — `if (isArchitect) return; // Architect writes are always allowed`

Hypothesis: sweepStaleSessions drops activeAgent for a session idle >2h; a sibling lane's ensureAgentSession can evict a coder blocked on a long tool call, whose next write is then treated as architect. Documented as an edge, but it is fail-open on the write gate.

Verify: Coder session with lastToolCallTime=now-3h; ensureAgentSession for another session (sweep); scopeGuard.toolBefore for the coder's write -> no throw.

User impact: Rare unscoped coder writes under parallel lanes.

#### HOOKS-12 · LOW · Test-suite block regex misfires on directory args and is bypassed by `cd x && bun test`

Lane: hooks. Kind: friction.

Evidence:

- `src/hooks/guardrails/tool-before.ts:1781` — `const testRunnerPrefixPattern =`
- `src/hooks/guardrails/tool-before.ts:1803` — `'BLOCKED: Full test suite execution is not allowed in-session. Run a specific test file instead: bun test path/to/file.test.ts',`

Hypothesis: hasFileArg requires a slash or JS/TS extension, so `bun test tests` is blocked with a misleading message, while the ^-anchored regex lets `cd sub && bun test` run the whole suite.

Verify: toolBefore({tool:'bash'},{args:{command:'bun test tests'}}) throws; 'cd a && bun test' passes.

User impact: Coders blocked on legitimate scoped runs; trivial evasion.

#### HOOKS-9 · LOW · agent-activity flush lock releases while a queued flush is still running

Lane: hooks. Kind: bug.

Evidence:

- `src/hooks/agent-activity.ts:196` — `flushPromise = flushPromise`
- `src/hooks/agent-activity.ts:208` — `flushPromise = null;`

Hypothesis: Call 1's finally nulls flushPromise when its doFlush ends while call 2's chained doFlush is starting; call 3 then runs concurrently -> overlapping read-modify-write of .swarm/context.md and double pendingEvents subtraction.

Verify: Stub reads/writes with deferred promises; call _flushForTesting 3x while the first is pending; observe two overlapping writes.

User impact: Occasional lost updates to other context.md sections.

#### INIT-10 · LOW · Unconditional stderr banner per server() call contradicts the repo's own TUI-corruption rule

Lane: init. Kind: friction.

Evidence:

- `src/index.ts:846` — `console.warn(`[opencode-swarm] running v${packageJson.version}`);`
- `src/services/warning-buffer.ts:140` — ``console.warn` calls that corrupt the bubbletea TUI (issue #1249 class, and`
- `src/config/schema.ts:3816` — `// console output does not bleed into the OpenCode TUI as overlay notifications.`

Hypothesis: Emitted before config loads so it cannot honour quiet, once per instance (3 times for 3 dirs in the harness) — the raw-stderr class the quiet default was introduced to stop.

Verify: grep -c '\[opencode-swarm\] running v' scratchpad/init-trace.out = 3; start the TUI with parallel lanes and watch overlays.

User impact: One overlay/stderr line per lane start.

#### INIT-11 · LOW · Stale comments/docs about init and portability contracts

Lane: init. Kind: drift.

Evidence:

- `tests/unit/build/bundle-node-load.test.ts:10` — `We don't test that the plugin function actually executes under Node — it`
- `docs/engineering-invariants.md:168` — ``ensureSwarmGitExcluded` (`src/index.ts:356`)`
- `docs/engineering-invariants.md:380` — `ensureSwarmGitExcluded(ctx.directory, { quiet: config.quiet }),`

Hypothesis: repro-704 does run server() under Node; the doc's required pattern still passes {quiet} (index.ts:923 no longer does; gitignore-warning.ts:236 void-discards it) and cites a dead line; init-orphan-recovery.ts:6 header contradicts :422; sqlite-loader.ts:29 'three former call sites' is now five.

Verify: Read cited lines; grep -n loadDatabaseCtor src --include=*.ts \| grep -v test.

User impact: Contributors following the doc reintroduce {quiet} and misjudge Node coverage.

#### KNOWLEDGE-11 · LOW · Knowledge/memory blocks inserted 'before the last user message' are hoisted to system index 0 by consolidation

Lane: knowledge. Kind: design.

Evidence:

- `src/hooks/knowledge-injector.ts:869` — `// Insert just before the last user message (recency position).`
- `src/hooks/messages-transform.ts:189` — `// Consolidated system message at index 0, preserving the first system`
- `docs/memory.md:339` — `The block is inserted before the current user/task message and after the agent's fixed system/developer instructions.`

Hypothesis: Both injectors emit role:'system'; the final handler (index.ts:3466-3486) merges all system messages into index 0, so the recency rationale and the docs claim are false.

Verify: Drive the full messages.transform chain; locate INJECTION_SENTINEL in final output.messages (index 0).

User impact: Directives less salient than designed on long contexts; docs mislead.

#### KNOWLEDGE-12 · LOW · docs/knowledge.md drift: stale schema line and headroom regimes

Lane: knowledge. Kind: drift.

Evidence:

- `docs/knowledge.md:246` — `(see `src/config/schema.ts:1043`)`
- `docs/knowledge.md:233` — `\| <5% \| Skipped \|`
- `src/hooks/knowledge-injector.ts:1021` — `const MIN_INJECT_CHARS = config.context_budget_threshold ?? 300;`

Hypothesis: KnowledgeConfigSchema is at schema.ts:1500; injection is skipped only when headroom < 300 chars, and the quarter regime covers all <20% (injector:1050-1053).

Verify: sed -n 1021,1053p src/hooks/knowledge-injector.ts vs docs/knowledge.md:226-246.

User impact: Operators misjudge when injection is suppressed.

#### KNOWLEDGE-13 · LOW · @xenova/transformers resolved from the plugin bundle location; user-side install location undocumented

Lane: knowledge. Kind: portability.

Evidence:

- `src/memory/embeddings/local-provider.ts:123` — `const req = createRequire(import.meta.url);`
- `package.json:156` — `"optional": true`
- `src/memory/pii.ts:289` — `Install it (e.g. `bun add @xenova/transformers`) or set memory.redaction.piiDetector back to 'regex'.`

Hypothesis: createRequire(import.meta.url) resolves from dist/index.js inside the OpenCode plugin cache (invariant 12 layouts), not the user's project; optional peers are not auto-installed; docs never say where to install. Embeddings/rerank then stay available=false silently and piiDetector:'ner' fails closed even after the documented step.

Verify: node -e "require('module').createRequire('<cacheDir>/dist/index.js')('@xenova/transformers')" after a project-level bun add (expect MODULE_NOT_FOUND); grep createRequire src/memory for any ctx.directory resolution root (none).

User impact: Opt-in dense retrieval/NER never activates for cache-installed plugins.

#### MAIN-7 · LOW · Installer edits the user's global OpenCode config to disable built-in explore/general agents for all sessions

Lane: main. Kind: friction.

Evidence:

- `src/cli/index.ts:289` — `(agent.explore/general.disable=true per config lane map cli/index.ts:289-352)`
- `docs/getting-started.md:37` — `✓ Disabled default OpenCode agents (explore, general)`

Hypothesis: Disabling host subagents globally affects non-swarm sessions and other plugins that delegate to explore/general; uninstall should restore them — verify it does.

Verify: Read src/cli/index.ts install() and uninstall() agent handling; check whether other host features depend on explore/general.

User impact: Non-swarm workflows lose the host's built-in subagents after installing the plugin.

#### OBSERVABILITY-10 · LOW · Contract drift the gates cannot catch: 4 kinds missing from KNOWN_TELEMETRY_KEYS, stale paths/counts/citations

Lane: observability. Kind: drift.

Evidence:

- `src/observability/observe.ts:292` — `: EMPTY_KNOWN_KEYS;`
- `src/telemetry.ts:143` — `// (`src/observability/learning-health.ts`) for the eight PR-16 alarm`
- `docs/observability-event-contract.md:781` — ``scripts/check-event-contract.ts` mechanically validates the 47-entry`
- `docs/evidence-and-telemetry.md:136` — `Line-delimited JSON. Auto-rotated at 10 MB (`src/telemetry.ts:161`).`

Hypothesis: close_archive_result, shell_audit_health, trajectory_health, pr_subscription_health have no KNOWN_TELEMETRY_KEYS entry (legacy.ts:61), so legacy.unknown is vacuous for them and no script imports the table. learning-health lives in src/health (telemetry.ts:143,:1132 cite a missing path); the doc says 47 and 55 entries; catalog.ts:4-27 skips '45th'; legacy.ts:472 says 39 kinds; telemetry.ts:161 is heartbeat code, rotation is at :427.

Verify: scratchpad/probe1.ts (4 missing kinds); ls src/observability/learning-health.ts (missing); sed -n 161p src/telemetry.ts; grep -n '47-entry\\|55-entry' docs/observability-event-contract.md.

User impact: Maintainers land on wrong code; a data-quality gap once a sink lands.

#### OBSERVABILITY-11 · LOW · agent-activity: activeToolCalls has no eviction and the flush chain guard is dropped early

Lane: observability. Kind: bug.

Evidence:

- `src/hooks/agent-activity.ts:115` — `swarmState.activeToolCalls.set(input.callID, {`
- `src/hooks/agent-activity.ts:208` — `flushPromise = null;`

Hypothesis: Entries are removed only in toolAfter, so aborted calls leak for the process lifetime (invariant 8); the first caller's finally nulls flushPromise while a doFlush chained at :196 is pending, so a third trigger starts a concurrent read-modify-write of context.md.

Verify: grep -rn activeToolCalls src (set/get/delete/clear, no cap); race three flushes with a slow readSwarmFileAsync stub.

User impact: Slow memory growth on long hosts; occasional lost Agent Activity updates.

#### PARALLEL-11 · LOW · Architect prompt says turbo.lean.worktree_isolation defaults to false; schema/constants/tests say true

Lane: parallel. Kind: drift.

Evidence:

- `src/agents/architect.ts:218` — `Lean-Turbo-internal flag (default `false`)`
- `src/config/schema.ts:2925` — `worktree_isolation: z.boolean().default(true),`

Hypothesis: Prompt drifted from SC-121 (constants.ts:729 and tests/unit/config/lean-worktree-default-alignment.test.ts say true); the architect misdescribes Lean Turbo behaviour.

Verify: grep -n 'default `false`' src/agents/architect.ts; bun test tests/unit/config/lean-worktree-default-alignment.test.ts.

User impact: Incorrect guidance in the planning dialogue.

#### PARALLEL-12 · LOW · Full-Auto unreadable-state marker is process-global; fullAutoEnabledInConfig is a dead field

Lane: parallel. Kind: design.

Evidence:

- `src/full-auto/state.ts:283` — `let stateUnreadable = false;`
- `src/hooks/full-auto-permission.ts:110` — `const stateHealth = isFullAutoStateUnreadable();`
- `src/index.ts:1048` — `swarmState.fullAutoEnabledInConfig = config.full_auto?.enabled === true;`

Hypothesis: A corrupt full-auto-state.json in one project (or lane worktree .swarm) marks the whole process unreadable and blocks non-read-only tools in every directory instance the server hosts (invariant 8). fullAutoEnabledInConfig is written and preserved (state.ts:1128-1142) but never read.

Verify: grep -rn fullAutoEnabledInConfig src \| grep -v test (writes only); corrupt state in project A, run a write tool in project B on the same server → FULL_AUTO_STATE_UNREADABLE.

User impact: Cross-project fail-closed blocking; dead config surface.

#### PLAN-12 · LOW · Ledger append bypasses atomicWriteSwarmFile: no rename retry and the temp file leaks when rename throws (Windows EPERM/EBUSY)

Lane: plan. Kind: portability.

Evidence:

- `src/plan/ledger.ts:364` — `fs.renameSync(tempPath, targetPath);`
- `src/utils/atomic-write.ts:419` — `'src/plan/ledger.ts': 'registered-bespoke',`

Hypothesis: writeFileFsyncedThenRename renames outside try/finally without bounded retry; an AV/indexer holding plan-ledger.jsonl makes save_plan/update_task_status hard-fail and leaves plan-ledger.jsonl.tmp.* (:1016) residue.

Verify: Windows: hold .swarm/plan-ledger.jsonl open (FileShare.None), run save_plan -> EPERM + leftover .tmp; Linux: stub fs.renameSync to throw once, assert temp remains.

User impact: Transient Windows file locks become user-visible plan-save failures plus residue.

#### PLAN-13 · LOW · docs/plan-durability.md and code headers describe behaviour the code lacks (close writes checkpoint; single quarantine file; event JSON shape; 50-event cadence)

Lane: plan. Kind: drift.

Evidence:

- `docs/plan-durability.md:210` — `- `/swarm close` command`
- `src/commands/close.ts:2626` — `// NOTE: writeCheckpoint is intentionally NOT called here.`

Hypothesis: Event grammar (docs:51 type/taskId/ts vs seq/event_type/task_id/timestamp), quarantine path (ledger.ts:1874 unique file), 'replay continues' claim, checkpoint triggers (checkpoint.ts:5) and cadence are stale (invariant 5 six-surface docs).

Verify: Diff docs sections 'Ledger Event Types', 'Export', 'Corruption Handling', 'Snapshot System' against LedgerEvent, quarantineLedgerSuffix, loadPlan truncated branch, PLAN-10.

User impact: Operators debugging a broken ledger are pointed at wrong file names and recovery semantics.

#### PROMPTS-10 · LOW · COMMAND NAMESPACE blocks in four prompts describe Claude Code ('CC') built-ins although the plugin runs inside OpenCode

Lane: prompts. Kind: drift.

Evidence:

- `src/agents/architect.ts:121` — `/doctor (CC)  → CC installation diag.     /swarm config doctor → Swarm health. USE THIS.`
- `src/agents/architect.ts:127` — `ANTI-RATIONALIZATION: Context does not clarify. Models revert to CC training.`

Hypothesis: ~1.4KB in the architect plus copies in coder/reviewer/test-engineer warn about Claude Code /plan, /reset, /checkpoint, /doctor, /memory 'edits CLAUDE.md' — semantics that do not apply to OpenCode.

Verify: grep -n '(CC)' src/agents/*.ts

User impact: Host-mismatched guidance; wasted tokens every turn for four agents.

#### PROMPTS-11 · LOW · Intra-prompt contradictions: reviewer 800-token budget vs mandatory multi-section output; coder forbidden from build/lint/tests yet granted build_check/lint/syntax_check

Lane: prompts. Kind: design.

Evidence:

- `src/agents/reviewer.ts:223` — `VERBOSITY CONTROL: Token budget ≤800 tokens.`
- `src/agents/reviewer.ts:263` — `ACCEPTANCE_SATISFACTION: SATISFIED \| PARTIAL \| NOT_SATISFIED — one line per item`
- `src/agents/coder.ts:243` — `[ ] I did not run tests, build commands, or validation tools — that is the reviewer's job`

Hypothesis: Reviewer must emit ~12 mandatory sections (per-item ACCEPTANCE, per-directive DIRECTIVE_COMPLIANCE, REUSE_RE_VERIFICATION with 3+ searches, calibration paragraph, [REVIEWED] line); coder map includes build_check/lint/syntax_check; reviewer prompt has no test-running step (test_engineer does).

Verify: bun <scratchpad>/maps/measure-tools.ts; read reviewer.ts:223-300.

User impact: Models pick which rule to break; verdicts truncated or audit misreported.

#### PROMPTS-12 · LOW · Researcher registered by default with web_search, which is config-gated on council.general.enabled (off); prompt misstates its tool set

Lane: prompts. Kind: design. Duplicates merged: TOOLS-7.

Evidence:

- `src/tools/tool-metadata.ts:760` — `Config-gated on council.general.enabled in the resolved config`
- `src/agents/researcher.ts:85` — `your tool set does not include a file-read tool.`
- `src/agents/index.ts:409` — `{ name: 'researcher' as const, factory: createResearcherAgent },`

Hypothesis: AGENT_TOOL_MAP.researcher includes web_search; with default config every call returns council_general_disabled, so the always-registered agent has no research capability. Only write-family tools are disabled, so the 'no file-read tool' claim is false.

Verify: bun <scratchpad>/maps/measure-tools.ts; dispatch researcher with default config; observe FALLBACK path.

User impact: Listed agent inert by default; users must find a council setting to enable it.

#### PROMPTS-8 · LOW · Bundled swarm skill tells OpenCode hosts to write .zcode/session/swarm-mode.md, a path nothing reads

Lane: prompts. Kind: drift.

Evidence:

- `.opencode/skills/swarm/SKILL.md:89` — `\| OpenCode \| `.zcode/session/swarm-mode.md` \|`
- `AGENTS.md:13` — `\| Swarm-mode Claude work \| this file → `CLAUDE.md` → `.claude/session/swarm-mode.md` (when present) \|`
- `.gitignore:77` — `.zcode/`

Hypothesis: grep 'zcode' in src finds only comments about .zcode/issue-traces (gitignored scratch); no src, AGENTS.md, CLAUDE.md or skill reads .zcode/session.

Verify: grep -rn 'zcode/session\\|swarm-mode.md' src AGENTS.md CLAUDE.md .opencode/skills .claude/skills

User impact: Swarm-mode enablement inside OpenCode is a no-op.

#### PROMPTS-9 · LOW · PROJECT CONTEXT checks for '{{...}}' but the fail-open sentinel is 'unresolved (run /swarm preflight)'

Lane: prompts. Kind: drift.

Evidence:

- `src/agents/architect.ts:143` — `If any field is `{{...}}` (unresolved): run MODE: DISCOVER to populate it`
- `src/agents/template.ts:60` — `export const UNRESOLVED = 'unresolved (run /swarm preflight)';`

Hypothesis: Default render: 6 sentinel occurrences, zero {{KEY}} leftovers; detection text never matches and the sentinel points at a diagnostics command, not DISCOVER.

Verify: bun <scratchpad>/maps/measure-prompts.ts ('unresolved sentinel occurrences: 6').

User impact: Unresolved project context ignored or preflight run instead of discovery.

#### PRREVIEW-7 · LOW · Child lanes must emit transcript rows only if their lane enables legacy compat, but the snapped flag is never shown to them

Lane: prreview. Kind: drift.

Evidence:

- `src/tools/dispatch-lanes.ts:357` — `compatibility.`;`
- `src/tools/dispatch-lanes.ts:2451` — `prReviewLegacyTranscriptCompatibility: legacyTranscriptCompatibility,`
- `src/tools/dispatch-lanes.ts:4998` — `Transcript machine rows are deprecated legacy compatibility only for lanes whose snapped contract explicitly enables them`

Hypothesis: The flag lives only on the delegation record; the contract block (5007-5019) has no compat line while the prompt still ships worked [CANDIDATE]/[CLEAN] examples (350-357). The child cannot evaluate the condition.

Verify: sed -n 4940,5030p src/tools/dispatch-lanes.ts \| grep -i legacy (prose only, no value).

User impact: Duplicate or missing rows; compounds PRREVIEW-1.

#### PRREVIEW-8 · LOW · No test covers prompt -> child learns ids -> submit accepted -> coverage credited; native adapter unsupplied in production

Lane: prreview. Kind: test.

Evidence:

- `tests/unit/tools/submit-pr-review-result.test.ts:8` — `batchId: 'batch-2384',`
- `tests/unit/tools/dispatch-lanes-structured-adapter.test.ts:48` — `expect(promptJsonSchema.mock.calls[0]?.[0].schema).toBeDefined();`
- `src/tools/dispatch-lanes.ts:2501` — `structuredAdapter: args.context.prReviewStructuredPromptAdapter,`

Hypothesis: Submit tests seed ids out of band; the adapter test checks call shape only and nothing sets context.prReviewStructuredPromptAdapter on the host, so the baseline transport has no registered-path evidence (#2380 requirement).

Verify: grep -rn prReviewStructuredPromptAdapter src/ (dispatch-lanes.ts only); grep -n batch tests/unit/tools/submit-pr-review-result.test.ts.

User impact: PRREVIEW-1 shipped green.

#### PRREVIEW-9 · LOW · collect_lane_results wait:true defaults to a 30-minute blocking call with the default undisclosed

Lane: prreview. Kind: friction.

Evidence:

- `src/tools/dispatch-lanes.ts:124` — `const DEFAULT_COLLECT_TIMEOUT_MS = DEFAULT_ASYNC_STALE_TIMEOUT_MS;`
- `src/background/pending-delegations.ts:195` — `export const DEFAULT_STALE_DELEGATION_TIMEOUT_MS = 30 * 60_000;`
- `src/tools/dispatch-lanes.ts:641` — `.describe('Total wait budget when wait=true'),`

Hypothesis: A join with omitted timeout_ms blocks the architect up to 30 min (poll backoff to 10 s); the skill tells it to use wait:true as the final join; schema and skill omit the default.

Verify: sed -n 1933p src/tools/dispatch-lanes.ts; check host tool-call timeout for a 30-min call.

User impact: Apparent hang at the final join; possible host-side tool timeout.

#### REPOGRAPH-12 · LOW · test-impact map build is a fully synchronous, unbounded recursive walk plus readFileSync of every test file at tool time; isCacheStale statSyncs every map key on each load

Lane: repograph. Kind: perf.

Evidence:

- `src/test-impact/analyzer.ts:260` — `entries = fs.readdirSync(dir, { withFileTypes: true });`
- `src/test-impact/analyzer.ts:85` — `content = fs.readFileSync(testFile, 'utf-8');`
- `src/test-impact/analyzer.ts:55` — `const stat = fs.statSync(sourcePath);`

Hypothesis: findTestFilesSync has no file cap or wall-clock budget and blocks the single-threaded host for the whole walk on large repos (the #704 class at tool time); the bounded async walker in builder.ts is not reused.

Verify: Run test_impact (or test_runner scope:'impact') on a 50k+ file checkout without .swarm/cache/impact-map.json and measure event-loop lag (setInterval drift) / TUI freeze.

User impact: Whole-host freeze during impact analysis on large monorepos.

#### REPOGRAPH-6 · LOW · Docs say the repo graph is regex-only (TS/JS/Python) with no tree-sitter on the startup path, backed by a stub benchmark; the startup scan runs tree-sitter on every file

Lane: repograph. Kind: drift.

Evidence:

- `docs/tree-sitter-evaluation.md:22` — `The extractor does not load tree-sitter grammars during plugin`
- `docs/repo-graph-call-graph.md:81` — `- TS/JS/Python only, regex-based — no AST/tree-sitter (AGENTS.md invariant 1).`
- `docs/repo-graph-symbol-graph.md:73` — `tree-sitter runtime** — init is triggered only by query-time tools, so this work`
- `src/tools/repo-graph/builder.ts:2562` — `const facts = await _internals.extractFileSymbols(grammarId, content);`

Hypothesis: The hook defaults to buildWorkspaceGraphAsync (repo-graph-builder.ts:177) -> scanFileAsync -> extractFileSymbols -> loadGrammar for 14 grammars on the startup task; 'DEFERRED' (tree-sitter-evaluation.md:67) is stale. scripts/tree-sitter-benchmark.ts:34 is a TODO stub, so the doc's cost table (line 51) is unsourced and ~5x below measured.

Verify: grep -n extractFileSymbols src/tools/repo-graph/builder.ts; grep -n DEFERRED docs/tree-sitter-evaluation.md; cat scripts/tree-sitter-benchmark.ts.

User impact: Contributors reason from a wrong cost model (see REPOGRAPH-1); users expect a cheap startup.

#### REPOGRAPH-7 · LOW · safeMatches compiles a new tree-sitter Query per file per pattern (4/file, ~9 ms each) and never deletes it; WASM memory is retained

Lane: repograph. Kind: perf.

Evidence:

- `src/lang/symbol-graph.ts:1668` — `const q = new _QueryCtor(lang, pattern);`
- `src/lang/symbol-graph.ts:625` — `const defMatches = safeMatches(lang, qs.defs, root);`

Hypothesis: 16.6k Query compilations per full build (4,152 files x 4), none .delete()d: 4,000 undeleted queries retain +9 MB RSS after Bun.gc(true) versus deleted; caching one compiled Query per (grammar,pattern) removes ~15 ms/file and the leak.

Verify: bun -e: loop new Query(lang, QUERIES.typescript.defs) 4000x with/without .delete(), compare rss after Bun.gc(true); time 50 compiles (measured 471 ms).

User impact: Slower builds and incremental updates; slow memory growth over long sessions.

#### REPOGRAPH-8 · LOW · Dead parallel stack and dead exports: sync buildWorkspaceGraph (+findSourceFiles/walkSyncInto), loadOrCreateGraph, saveIfDirty, markDirty, isGraphFresh, getSupportedLanguages/getInitializedLanguages/isGrammarAvailable have no production caller

Lane: repograph. Kind: deadcode.

Evidence:

- `src/tools/index.ts:100` — `buildWorkspaceGraph,`
- `src/tools/repo-graph/builder.ts:3119` — `export function buildWorkspaceGraph(`
- `src/tools/repo-graph/query.ts:195` — `export function isGraphFresh(`
- `docs/repo-graph-call-graph.md:49` — `(sync builder) — the two paths are kept byte-for-byte`

Hypothesis: The only builder caller is the hook default buildWorkspaceGraphAsync; ~300 lines of sync builder plus a sync walker exist to satisfy the #1144 equivalence suite. loadOrCreateGraph is re-exported at src/tools/index.ts:104 with no consumer. CLAUDE.md 'never ship unwired code' treats dead exports as blockers; isGraphFresh is a wall-clock 5-min TTL contradicting the fingerprint model.

Verify: grep -rn 'buildWorkspaceGraph(\\|loadOrCreateGraph(\\|saveIfDirty(\\|markDirty(\\|isGraphFresh(\\|getSupportedLanguages(\\|isGrammarAvailable(' src --include=*.ts \| grep -v test \| grep -v 'function '

User impact: No direct impact; a second scan implementation that can drift from the live one.

#### REPOGRAPH-9 · LOW · Core tree-sitter.wasm is copy-pinned in dist/lang/grammars while the --external web-tree-sitter runtime floats on ^0.25.0; the locateFile redirect exposes the LinkError the build script warns about

Lane: repograph. Kind: portability.

Evidence:

- `scripts/copy-grammars.ts:66` — `// The core WASM must match the web-tree-sitter JS runtime ABI — using the`
- `src/lang/runtime.ts:81` — `// In bundle, import.meta.url points to dist/index.js so web-tree-sitter`
- `package.json:93` — `--target node --format esm --external web-tree-sitter`
- `package.json:141` — `"web-tree-sitter": "^0.25.0",`

Hypothesis: web-tree-sitter is not bundled, so its own import.meta.url (node_modules/web-tree-sitter/tree-sitter.js:2300) would find a matching tree-sitter.wasm; the redirect loads the copy from the publisher's lockfile (0.25.10) against whatever 0.25.x the user's cache layout installs. Safe today (0.25.10 is the newest 0.25.x), breaks on the next ABI-changing 0.25.x or a layout holding an older runtime.

Verify: npm view web-tree-sitter versions; in a scratch install swap node_modules/web-tree-sitter to 0.25.0, import dist/index.js and loadGrammar('typescript') -> LinkError; confirm Parser.init without locateFile resolves the runtime's own wasm.

User impact: Latent: a future drift turns syntax_check and every graph build into 'Failed to load grammar' with a misleading 'run opencode-swarm update' hint.

#### SDK-10 · LOW · chat.message throws by design; host runs hooks via Effect.promise so the block surfaces as a defect, not a session error

Lane: sdk. Kind: friction.

Evidence:

- `src/index.ts:4701` — `if (resolution.status === 'exhausted') {`
- `maps/sdk/host-index.ts (packages/opencode/src/plugin/index.ts):294` — `yield* Effect.promise(async () => fn(input, output))`
- `maps/sdk/host-prompt.ts (packages/opencode/src/session/prompt.ts):1000` — `"chat.message",`

Hypothesis: Effect.promise treats rejection as a defect and prompt.ts has no catch around the trigger, so MODEL_FALLBACK_EXHAUSTED propagates as an internal request error rather than a rendered session.error (tool.execute.before throws are caught by the tool wrapper, tools.ts:103-110).

Verify: Exhaust a role's model chain and send a message; inspect host log/HTTP response for an Effect defect vs a session.error event. Not reproduced on a running host.

User impact: User may see a raw internal error instead of the readable 'no configured model remains' message.

#### SDK-6 · LOW · Two zod runtimes bundled (4.1.8+4.3.6) crossing into host zod 4.1.8; descriptions survive only via the host's registry rebuild

Lane: sdk. Kind: perf.

Evidence:

- `bun.lock:209` — `"@opencode-ai/plugin/zod": ["zod@4.1.8"`
- `bun.lock:207` — `"zod": ["zod@4.3.6"`
- `src/tools/batch-symbols.ts:261` — `files: tool.schema`

Hypothesis: dist/index.js carries both `major:4,minor:1,patch:8` and `major:4,minor:3,patch:6`; 2 files use tool.schema (4.1.8), 129 use root z (4.3.6). Host (zod catalog 4.1.8) runs z.object(args)+z.toJSONSchema with a registry rebuilt from value.description (registry.ts:374-401). All 131 tools pass empirically, but with plain globalRegistry every description vanishes, so hosts predating zodMetadataRegistry lose them; create-tool.ts:89's double cast also lets a non-zod arg compile, flipping the tool to the host's unvalidated legacy path.

Verify: grep -oE 'major:4,minor:[0-9]+,patch:[0-9]+' dist/index.js \| sort -u; bun run maps/sdk/zod-real-tools.ts (131 ok) and maps/sdk/zod-cross.ts (last line: description dropped without registry).

User impact: Larger bundle; on older OpenCode hosts tool args reach the LLM undescribed.

#### SDK-7 · LOW · 27 of 131 tools expose arguments with no description to the LLM

Lane: sdk. Kind: friction.

Evidence:

- `src/tools/index.ts:1` — `(all createSwarmTool exports; probe maps/sdk/zod-real-tools.ts)`

Hypothesis: Host-equivalent toJSONSchema yields bare {type} for e.g. abort_pr_workflow{mode,kind,reason,cancel_publication,armed_recovery}, knowledge_receipt{task_id,phase,applied,contradicted,new_lessons,no_relevant_knowledge}, complete_pr_workflow{mode,pr_head_sha,report_verdict}, record_recurrence_sweep{...}.

Verify: bun run maps/sdk/zod-real-tools.ts -> UNDESCRIBED list.

User impact: Agents guess argument semantics for PR-workflow/knowledge tools -> validation failures and retries.

#### SDK-8 · LOW · Stale '#1849 toolAfter has NO args': host-provided input.args ignored in favor of a bounded snapshot

Lane: sdk. Kind: drift.

Evidence:

- `src/index.ts:4093` — `// (the SDK toolAfter input has NO args). Reused by the knowledge ack/`
- `node_modules/@opencode-ai/plugin/dist/index.d.ts:253` — `args: any;`
- `src/hooks/host-boundary.ts:168` — `args: toArgs(getStoredInputArgs(input.callID)),`

Hypothesis: Installed type and host (tools.ts:121-125, prompt.ts:389-393) send args in tool.execute.after; the plugin never reads input.args (none in 4081-4682). If the FIFO snapshot (MAX_STORED_INPUT_ARGS=2000, stored-input-args.ts:27) is evicted or toolBefore threw before storing (3848), afterCtx.args is null although the host supplied them.

Verify: grep -n 'input.args' src/index.ts (none in toolAfter); unit test: call toolAfter with input.args and no prior toolBefore -> resolveToolAfterContext().args === null.

User impact: Knowledge ack/verdict/receipt collectors and git-push observation lose delegation prompt/subagent_type under load or after a hook error.

#### SDK-9 · LOW · messages.transform chain also runs on the host's compaction pass, right after the turn generation is advanced

Lane: sdk. Kind: design.

Evidence:

- `node_modules/@opencode-ai/plugin/dist/index.d.ts:259` — `"experimental.chat.messages.transform"?: (input: {}, output: {`
- `src/index.ts:3586` — `'experimental.session.compacting': (async (`
- `maps/sdk/host-compaction.ts (packages/opencode/src/session/compaction.ts):379` — `yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })`

Hypothesis: compaction.ts triggers session.compacting (373) then messages.transform on a structuredClone of the head (378-379). Input is {} on both paths, so the full injection chain (delegation-ledger resume 3388-3406, reminders, advisories, full-auto intercept) runs against the compaction input right after advanceTurnGeneration (3590-3593) reset the per-turn ledger.

Verify: Unit test: call the compacting hook then the messages transform with cloned messages for an active architect session; assert injected parts appear and inspect dedup state for the next turn.

User impact: Compaction summaries carry swarm reminders as if conversation; the next real turn may have its injections deduped away.

#### SECURITY-5 · LOW · sanitizeInput is a dead export whose adversarial tests assert a defense production never applies

Lane: security. Kind: deadcode.

Evidence:

- `src/git/pr.ts:415` — `// Note: sanitizeInput removed - spawnSync with array args is already safe from injection`
- `tests/unit/git/pr.adversarial.test.ts:16` — `* command injection. All user inputs are sanitized via sanitizeInput() which:`

Hypothesis: pr.ts:51 exports sanitizeInput with no production caller; it backslash-escapes $ ` " (wrong for array-form spawn) and the test file's stated security model describes a control that does not exist. Dead export violates CLAUDE.md directive 2.

Verify: grep -rn sanitizeInput src \| grep -v test -> src/git/pr.ts:51 only.

User impact: None at runtime; misleading test/spec surface.

#### SECURITY-6 · LOW · deepMerge honors JSON "__proto__"; merged config keeps a hostile prototype for everything except git.binary

Lane: security. Kind: security.

Evidence:

- `src/utils/merge.ts:17` — `for (const key of Object.keys(override) as (keyof T)[]) {`
- `src/config/loader.ts:523` — `if (Object.is(exposedBinary, userBinary)) return mergedRaw;`

Hypothesis: JSON.parse makes "__proto__" an own key; merge.ts:35 result[key]=... reparents the merged object. loader.ts rebuilds only when git.binary differs, so a project config {"__proto__":{...}} yields values Zod reads via the prototype chain that Object.keys/JSON.stringify and the unknown-key drop recovery cannot see (probe: merged.memory readable, absent from JSON). Object.prototype is not polluted. Fix: skip __proto__/constructor/prototype or use Object.create(null).

Verify: Run scratchpad/proto-probe.mjs (imports src/utils/merge.ts). grep -rln __proto__ tests/unit/utils -> no merge test.

User impact: Project config can carry hidden settings invisible to the raw-config view; no privilege escalation.

#### SECURITY-7 · LOW · Docs claim macOS lanes run under sandbox-exec, but the executor is off by default and lane isolation never invokes it

Lane: security. Kind: drift.

Evidence:

- `docs/configuration.md:1775` — `\| macOS \| `sandbox-exec` \| Falls back to env+port only if `sandbox-exec` is unavailable \|`
- `src/sandbox/executor.ts:338` — `let _macosSandboxEnabled = false;`
- `docs/configuration.md:1032` — ``sandbox_macos_enabled` therefore defaults to `false`.`

Hypothesis: The runtime_isolation tables (1772-1778, 1921-1927) contradict 1007-1039 and executor.ts:362-372. worktree-isolation.ts has no getExecutor/sandbox reference beyond the env-key import (line 18), so the lane table describes wrapping that module does not perform.

Verify: grep -n 'getExecutor\\|sandbox-exec' src/hooks/delegation-gate/worktree-isolation.ts -> none; macOS default config /swarm diagnose -> executor not available.

User impact: macOS users believe parallel lanes are sandboxed while every shell runs unsandboxed with a single warning.

#### SECURITY-8 · LOW · Invariant-3 stragglers: spawns without timeout, stdin ignore, or explicit cwd

Lane: security. Kind: portability.

Evidence:

- `src/services/diagnose-service.ts:398` — `child_process.execFileSync(gitExecutable, ['rev-parse', '--git-dir'], { cwd: directory, stdio: 'pipe', });`
- `src/parallel/review-router.ts:173` — `oldContent = execFileSync(gitExecutable, ['show', `HEAD:${file}`], { cwd: directory, encoding: 'utf-8', timeout: 2000, });`
- `src/sandbox/win32/runner-client.ts:171` — `const result = spawnSync('where', ['swarm-sandbox-runner.exe'], { windowsHide: true, encoding: 'utf-8', timeout: 2000,`

Hypothesis: AGENTS.md invariant 3: cwd + stdin:'ignore' + timeout + bounded stdio. diagnose-service.ts:398 has no timeout and a piped stdin with no withTimeout at the call site (1218), so /swarm diagnose can hang; review-router:173 and mutation/engine.ts:209 pipe stdin; bubblewrap-executor.ts:63, sandbox-exec-executor.ts:114, runner-client.ts:171, capability-probe.ts:701 omit cwd.

Verify: grep -n 'timeout\\|withTimeout' src/services/diagnose-service.ts -> none near 388-412; grep -n cwd at the four probe sites -> absent.

User impact: Occasional hangs of /swarm diagnose and background reviewers on Windows/Bun or slow filesystems.

#### TESTSCI-10 · LOW · Test docs drift: TESTING.md pipeline table and six cited test paths, delegation-gate split path, 'x4' shards, local coverage command, undocumented test:unit:ci

Lane: testsci. Kind: drift.

Evidence:

- `TESTING.md:121` — `\| `tests/unit/config/get-qa-gate-profile.test.ts` \| 9 \| FR-009 (QA gate profile) \|`
- `docs/engineering-invariants.md:686` — `tests/unit/agents/delegation-gate/`

Hypothesis: TESTING.md:92 describes batch steps 1a-6 (CI is a per-file 6-shard round-robin); get-qa-gate-profile/set-qa-gates/4x lean-turbo/curator-types paths do not exist (moved or split); delegation-gate/ dir and _fixtures.ts absent (AGENTS.md:88 repeats it); test-stability.md:4 says x4; TESTING.md:154 measures tests/unit only.

Verify: ls tests/unit/config/get-qa-gate-profile.test.ts tests/unit/parallel/lean-turbo-review.test.ts tests/unit/hooks/curator-types.test.ts tests/unit/agents/delegation-gate (all missing)

User impact: Agents following mandatory reading run wrong local validation and cite non-existent files.

#### TESTSCI-11 · LOW · Neither ~1.09M lines of tests nor 17K lines of scripts/ gate code are type-checked; scripts/ is not linted

Lane: testsci. Kind: test.

Evidence:

- `tsconfig.json:18` — `"include": ["src/**/*"],`
- `tsconfig.json:19` — `"exclude": ["node_modules", "dist", "src/**/__tests__/**", "src/**/*.test.ts"]`

Hypothesis: biome.json:4-12 includes only src/tests/test; Bun strips types, so wrong-typed fixture/API calls keep passing and _internals seam mismatches never surface; the gates themselves get neither tsc nor biome.

Verify: Add `const x: number = 'a';` to tests/unit/utils/errors.test.ts and scripts/check-test-clock.ts; typecheck + biome ci pass; the test passes

User impact: Type-level regressions in fixtures and CI gates go unnoticed.

#### TESTSCI-12 · LOW · Committed opencode-swarm.schema.json regenerates differently at HEAD; the byte-match detector only soft-warns (cross-scope: config lane)

Lane: testsci. Kind: drift.

Evidence:

- `scripts/drift-check.ts:1356` — `The checked-in `opencode-swarm.schema.json` must byte-match regeneration`
- `scripts/drift-check.ts:35` — `Exit code: 0 by default (soft-warn). When DRIFT_CHECK_ENFORCE is truthy`

Hypothesis: After the build-owning agent's `bun run build` (generate-config-schema.ts, lockfile zod@4.3.6) this checkout shows 23+/14- (type:[boolean,string] -> anyOf; date-time pattern). drift-check.yml:55 reads an unset repo var, so only a sticky comment signals it.

Verify: Fresh clone: bun install --frozen-lockfile && bun run schema:generate && git diff --stat opencode-swarm.schema.json; bun run drift:check exit code

User impact: Editor validation of swarm config diverges from the runtime schema.

#### TESTSCI-13 · LOW · detect-release skips all CI for any merge-group HEAD message containing 'release-please--' or a 'chore(main): release' line

Lane: testsci. Kind: bug.

Evidence:

- `.github/workflows/ci.yml:56` — `git log -1 --format='%B' \| grep -qE 'release-please--\|^chore\(main\): release'; then`
- `.github/workflows/ci.yml:155` — `if: needs.detect-release.outputs.is-release != 'true'`

Hypothesis: The MG commit message embeds the PR branch/title; a PR named e.g. fix/release-please--notes makes every job succeed with all steps skipped (skipped steps count as success for unit-passed/coverage).

Verify: Enqueue a PR titled 'ci: harden release-please--branches detection'; observe is-release=true, all steps skipped

User impact: A non-release PR can merge with zero tests executed.

#### TESTSCI-14 · LOW · check-skill-assertions.ts (FR-002 pre-push check) has no package.json script, CI step or doc mention; only a soft-warn drift-check import

Lane: testsci. Kind: unwired.

Evidence:

- `scripts/check-skill-assertions.ts:20` — ` * Usage: bun run scripts/check-skill-assertions.ts`
- `scripts/drift-check.ts:50` — `import { checkSkillAssertions, formatBrokenAssertions } from './check-skill-assertions';`

Hypothesis: package.json:91-131 lists every other check:* but not this; ci.yml, commit-pr SKILL.md, TESTING.md never mention it, so the 'surfaces it locally before push' promise (line 6) for 98 prose-asserting test files is unwired (CLAUDE.md directive 2).

Verify: grep -n skill-assertions package.json .github/workflows/*.yml .claude/skills/*/SKILL.md TESTING.md (no hits)

User impact: Skill edits break prose assertions only in CI, one round-trip per change.

#### TOOLS-8 · LOW · rebind_pr_feedback_head and lean_turbo_status tool bindings have no test coverage (invariant 11e)

Lane: tools. Kind: test.

Evidence:

- `src/tools/rebind-pr-feedback-head.ts:68` — `export const rebind_pr_feedback_head: ReturnType<typeof createSwarmTool> = createSwarmTool({`
- `src/tools/lean-turbo-status.ts:101` — `export const lean_turbo_status: ToolDefinition = createSwarmTool({`

Hypothesis: Repo-wide grep of *.test.ts for the tool names or executeRebindPrFeedbackHead/executeLeanTurboStatus finds nothing; only the hook helper rebindPrFeedbackHead is tested (tests/unit/hooks/pr-workflow-gate-no-change-rebind.test.ts:334).

Verify: grep -rln 'rebind_pr_feedback_head\\|executeRebindPrFeedbackHead\\|lean_turbo_status\\|executeLeanTurboStatus' tests src --include=*.test.ts → empty.

User impact: Regressions in these tools ship undetected.

#### TOOLS-9 · LOW · working_directory policy divergence: run_pr_feedback_stage_a reuses the arg name for a repo-relative subdirectory; declare_scope re-implements the validator with the path.sep-only traversal split the shared helper fixed

Lane: tools. Kind: drift.

Evidence:

- `src/tools/run-pr-feedback-stage-a.ts:143` — `'Repository-relative workspace directory for this concrete validation obligation; defaults to the repository root',`
- `src/tools/declare-scope.ts:199` — `const pathParts = normalizedDir.split(path.sep); if (pathParts.includes('..')) {`
- `src/tools/resolve-working-directory.ts:107` — `// Split on BOTH separators (`/` and `\`) so a forward-slash input is detected on Windows too.`

Hypothesis: AGENTS.md #4 requires every duplicate root guard to apply the same policy. Stage A's owned arg (create-tool.ts:74) means 'validator cwd inside the repo'; declare_scope's private validator lacks assertProjectRoot and uses the pre-fix split. Mitigated: scope-persistence.ts:568 asserts at the sink.

Verify: Diff declare-scope.ts:166-240 vs resolveWorkingDirectory; on Windows pass 'C:/proj/sub/../../other' to declare_scope and see which check rejects.

User impact: One arg name with two meanings; inconsistent errors. Defense-in-depth holds.

#### KNOWLEDGE-14 · INFO · Opt-in defaults make src/memory (~21k lines), reflection, embeddings, PII and the enforce gate dead for every default user

Lane: knowledge. Kind: design.

Evidence:

- `src/config/schema.ts:1771` — `enabled: z.boolean().default(false),`
- `src/config/schema.ts:2198` — `mode: z.enum(['warn', 'enforce']).default('warn'),`
- `src/config/constants.ts:599` — `export const KNOWLEDGE_UNIFIED_INJECTION_TOKENS_DEFAULT: number \| null = null;`

Hypothesis: Defaults off: memory.enabled (:1771), memory.reflection.enabled (:1830), memory.link.enabled (:1791), memory.consolidation.enabled (:2001), memory.embeddings.enabled (:2066), memory.retrieval.rerank.enabled (:2101), memory.redaction.detectPii (:1871), knowledge_application.mode=warn, architectural_supervision.enabled (:2170), skill_improver.enabled, unified injection budget null; swarm_memory_* tools have agents:[] until memory.enabled. Not a defect alone; weigh maintained surface vs zero default reach.

Verify: awk 'NR>=1769&&NR<=2124&&/default\(false\)/' src/config/schema.ts; grep -n 'agents: \[\]' src/tools/tool-metadata.ts.

User impact: None by default; large surface with no default beneficiaries.

#### OBSERVABILITY-12 · INFO · Sequence half-landed: 50/55 kinds have no consumer, envelope computed then discarded per emit, no /swarm report

Lane: observability. Kind: design.

Evidence:

- `src/observability/catalog.ts:37` — `live reader declares `consumers: []` AND a `futureOwnerIssue` — an empty`
- `docs/observability-event-contract.md:59` — `currently DISCARDED. Nothing in this PR consumes them; their consumer lands in`

Hypothesis: grep -c 'consumers: NO_CONSUMERS' = 50, all owned by #2047 (open); #2046, #2048-#2051 open. Visible today: /swarm costs, /swarm status (heartbeat, learning health), /swarm diagnose (learning health, blocking circuits, routing snapshot). Every emit pays trace/span ids, relationship validation and sampling (rate 1) for fields nobody reads.

Verify: grep -c 'consumers: NO_CONSUMERS' src/observability/catalog.ts; grep -n "'report'" src/commands/registry.ts (absent); gh issue view 2047 2048.

User impact: Docs describe traces, lineage and sampling that are not observable anywhere.

#### REPOGRAPH-11 · INFO · 12 of 22 repo_map actions have no prompt/skill/command consumer while the 3,370-char, 19-arg schema is sent to 11 agents on every request

Lane: repograph. Kind: friction.

Evidence:

- `src/tools/repo-map.ts:69` — `const VALID_ACTIONS = [`
- `src/tools/tool-metadata.ts:730` — `agents: [`

Hypothesis: grep over src/agents, src/prompts, .opencode/skills, .claude/skills, src/commands finds no reference to route_trace, data_trace, test_pack, symbol_search, symbol_context, impact_cone, diff_context, graph_explain, package_boundaries, preflight_packet, dead_exports, ontology; they are documented only in the tool description.

Verify: for a in route_trace data_trace test_pack symbol_search symbol_context impact_cone diff_context graph_explain package_boundaries preflight_packet dead_exports ontology; do grep -rl "$a" src/agents src/prompts .opencode/skills .claude/skills src/commands \| grep -v repo-map.ts \| grep -v test; done

User impact: Prompt bloat; advanced actions are discoverable only by models reading the schema.

#### PORT-001 · high · Windows .cmd/.bat shims (and bare npm) are spawned without a shell in 6 code paths; Node>=20.12 rejects with EINVAL and Bun.spawn cannot execute them

Lane: portability. Kind: portability.

Evidence:

- `src/hooks/spawn-helper.ts:29` — `? `${rawCmd}.cmd``
- `src/hooks/spawn-helper.ts:31` — `const proc = _internals.spawn(cmd, args, {`
- `src/hooks/incremental-verify.ts:76` — `return { command: [pm, 'run', 'typecheck'], language: 'typescript' };`
- `src/hooks/incremental-verify.ts:104` — `command: resolveLocalNodeTool('tsc', ['--noEmit'], projectDir),`
- `src/hooks/incremental-verify.ts:248` — `// Timeout or spawn error — silently skip`
- `src/build/command-resolution.ts:19` — `{ suffix: '.cmd', requiresNode: true },`
- `src/build/command-resolution.ts:184` — `if (local) return [local.absolute, ...args];`
- `src/tools/test-runner.ts:1354` — `const args = _internals.resolveLocalNodeTool(`
- `src/tools/test-runner.ts:2297` — `proc = _internals.bunSpawn(command, {`
- `src/tools/test-runner.ts:1587` — `process.platform === 'win32' ? `${name}.bat` : name,`
- `src/services/directive-predicate-runner.ts:121` — `? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, binary]`
- `src/services/directive-predicate-runner.ts:156` — `const proc = bunSpawn(argv, {`
- `src/tools/pkg-audit.ts:284` — `const command = ['npm', 'audit', '--json'];`
- `src/sast/semgrep.ts:86` — `// The Node subprocess API cannot directly launch Windows command shims.`
- `src/utils/git-executable.ts:364` — `* still fail this probe (the Node subprocess API cannot directly launch a`
- `scripts/ci/quarantined-tests-windows.txt:14` — `#     `bun.cmd` (which Bun.spawn cannot execute without shell:true) with`
- `src/tools/lint.ts:876` — `return [interpreter, '/d', '/s', '/v:off', '/c', command];`
- `src/hooks/spawn-helper.test.ts:19` — `* `npm.cmd` to spawn, so the original "resolves non-null" assertions were`

Hypothesis: spawn-helper rewrites npm/npx/pnpm/yarn to <name>.cmd and spawns it via node:child_process without shell; command-resolution returns node_modules/.bin/<tool>.cmd\|.bat\|.ps1 as argv[0] which test_runner (vitest/jest/mocha) and incremental-verify (tsc) hand straight to bunSpawn/spawnAsync; findBinaryInPath returns .cmd/.bat for directive `tool:` predicates; phpVendorBin returns vendor/bin/<name>.bat; pkg-audit spawns bare 'npm'. Node's child_process throws EINVAL for .bat/.cmd without `shell` since v18.20.2/20.12.2 (CVE-2024-27980) and Bun.spawn cannot run them (repo's own #1729 note), so on Windows these paths fail at spawn time. Because spawnAsync resolves null and incremental-verify returns silently on null, and test_runner surfaces a spawn error, the QA signal degrades silently. lint.ts already ships the correct cmd.exe-wrapped pattern; semgrep.ts and git-executable.ts document the constraint, so the code base is internally inconsistent about it.

Verify: On a Windows host with Node 22: `node -e "require('child_process').spawnSync('npm.cmd',['--version'])"` → error.code === 'EINVAL'; then in a vitest project run the plugin's test_runner (or `bun -e` calling buildTestCommand + bunSpawn on the returned argv) and observe spawnError; run incremental-verify against a package.json with a typecheck script and package-lock.json and confirm no POST-CODER CHECK message is injected. Static check: grep -n "resolveLocalNodeTool\\|spawnAsync(" src \| confirm none route through buildWindowsBatchCommand-style cmd.exe wrapping.

User impact: On Windows: test_runner cannot run vitest/jest/mocha projects (spawn failure), the post-coder incremental typecheck never reports (silent skip), directive `tool:` predicates using npm-distributed tools error, PHP pest/phpunit runs fail, and npm audit reports 'npm not installed'. QA gates that depend on these degrade silently rather than failing closed.

#### PORT-002 · medium · Windows containment checks compare JS-realpathSync outputs case-sensitively; a caller path with different drive-letter/segment case is rejected fail-closed

Lane: portability. Kind: portability.

Evidence:

- `src/utils/path-security.ts:418` — `_internals.realpathSync,`
- `src/utils/path-security.ts:429` — `!normalizedTarget.startsWith(normalizedRoot + path.sep) &&`
- `src/tools/secretscan.ts:845` — `resolvedRealPath.startsWith(resolvedScanDir + path.sep) \|\|`
- `src/tools/placeholder-scan.ts:1085` — `!fullPath.startsWith(resolvedDirectory + path.sep) &&`
- `src/tools/sast-scan.ts:446` — `!resolvedPath.startsWith(resolvedDirectory + path.sep) &&`
- `src/hooks/skill-scoring.ts:532` — `if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {`
- `src/services/skill-evaluator.ts:164` — `resolvedTarget.startsWith(resolvedRoot + path.sep)`
- `src/services/config-doctor.ts:2652` — `if (!canonicalStray.startsWith(canonicalRoot + path.sep)) {`
- `src/tools/repo-graph/builder.ts:771` — `!normalizedResolved.startsWith(normalizedRoot + path.sep) &&`
- `src/turbo/lean/evidence.ts:157` — `!resolvedPath.startsWith(resolvedDir + path.sep) &&`
- `src/turbo/lean/task-completion.ts:222` — `!resolvedPath.startsWith(resolvedDir + path.sep) &&`
- `src/tools/schema-drift.ts:80` — `if (!resolvedPath.startsWith(normalizedCwd) && resolvedPath !== cwd) {`
- `src/hooks/utils.ts:188` — `!resolved.toLowerCase().startsWith((baseDir + path.sep).toLowerCase())`
- `src/parallel/file-locks.ts:65` — `? normalized.toLowerCase().startsWith(baseDir.toLowerCase())`
- `src/scope/path-identity.ts:42` — `return flavor === 'win32' ? normalized.toLowerCase() : normalized;`
- `src/config/host-path.ts:99` — `return _internals.realpathSyncNative(resolved);`

Hypothesis: Node's JS fs.realpathSync rebuilds the path from the caller's own component strings and only substitutes symlink targets, so it preserves input case and 8.3 forms on Windows; only realpathSync.native canonicalises case. The host hands the plugin ctx.directory in one case (via .native), while LLM/user-supplied file paths frequently carry a lowercase drive letter (VS Code terminals) or differently-cased segments. The 12+ sites listed compare the two with === / startsWith(root + path.sep) without folding, unlike the repo's own folded helpers (hooks/utils.ts, parallel/file-locks.ts, scope/path-identity.ts, hive-transaction.ts fold, *-council-gate.ts). Sites using path.relative + '..' checks are NOT affected (path.win32.relative is case-insensitive).

Verify: On Windows: `node -e "const {validateSymlinkBoundary}=require('./dist/index.js')..."` or directly `bun -e "import('./src/utils/path-security.ts').then(m=>m.validateSymlinkBoundary('c:\\proj\\src\\a.ts','C:\\proj'))"` in an existing C:\proj → throws 'Symlink resolution escaped boundary'. Same input through scope/path-identity isPathIdentityWithin → true.

User impact: On Windows, tools (secretscan, placeholder-scan, sast-scan, repo-graph indexing, lean-turbo evidence/task-completion, skill scoring, config-doctor stray cleanup) reject or skip files whose supplied path differs only in case from ctx.directory, producing spurious 'outside workspace'/'escaped boundary' errors and silently dropped scan targets.

#### PORT-003 · low · realpath API split (192 JS realpathSync vs 3 realpathSync.native): host-facing and identity paths derive from different canonicalisers (issue #2018 class), 8.3/junction forms can disagree

Lane: portability. Kind: portability.

Evidence:

- `src/config/host-path.ts:99` — `return _internals.realpathSyncNative(resolved);`
- `src/hooks/knowledge-store.ts:1307` — `const canonicalDirectory = realpathSync.native(directory);`
- `src/worktree/core.ts:478` — `tmp = fs.realpathSync(tmp);`
- `src/memory/provider-pool.ts:452` — `const canonical = realpathSync(directory);`
- `tests/helpers/safe-test-dir.ts:29` — `const dir = fs.realpathSync(rawDir);`

Hypothesis: Only 3 production sites use .native (the form the OpenCode host uses); 192 use the JS implementation, which on Windows keeps 8.3 short names and input case. Where a value from one family is compared with, hashed alongside, or displayed next to a value from the other (worktree shortening vs lane permission patterns; knowledge feedbackScope hash vs provider-pool/cohort keys), Windows hosts whose TMP/cwd is an 8.3 short name get two spellings of one directory. No concrete cross-family equality bug was found in this pass; the shortened-worktree/lane-permission pair is reconciled because both sides feed hostNormalizePathPattern. Test helper still uses the non-native form (issue #2018 open).

Verify: On windows-latest: `node -e "const fs=require('fs');console.log(fs.realpathSync(process.env.TEMP), fs.realpathSync.native(process.env.TEMP))"` shows RUNNER~1 vs runneradmin; then grep each site that feeds a comparison/hash and confirm the other side uses the same family. Close #2018 by switching tests/helpers/safe-test-dir.ts:29 to .native with fallback.

User impact: Latent: identity/hash keys or displayed paths can differ for the same directory on Windows hosts with 8.3 tmp/cwd paths; today this surfaces mainly as Windows-only CI failures (PR #2015) rather than a user-visible defect.

#### PORT-004 · low · build-check runs discovered commands through `cmd /c <string>` with default CRT quoting (no windowsVerbatimArguments, no /d /s, no token validation)

Lane: portability. Kind: portability.

Evidence:

- `src/tools/build-check.ts:159` — `cmd = ['cmd', '/c', command.command];`
- `src/tools/build-check.ts:163` — `cmd = ['/bin/sh'];`
- `src/tools/build-check.ts:167` — `const result = bunSpawn([...cmd, ...args], {`
- `src/tools/lint.ts:876` — `return [interpreter, '/d', '/s', '/v:off', '/c', command];`

Hypothesis: bunSpawn passes windowsVerbatimArguments only when requested (bun-compat.ts:1006), so Node/Bun CRT-escape the single string argument (" → \" and wrap in quotes). cmd.exe does not understand \" escapes, so any shellCommand containing quotes, %, ^, & or \| (repository package scripts are honoured first per #2303) is mangled or interpreted. lint.ts already validates tokens and uses /d /s /v:off. stdin is also not ignored here (Node fallback → pipe).

Verify: On Windows, create package.json with `"build": "echo \"a b\""` (or a tsc -p "path with space") and run build_check; compare with a direct `cmd /d /s /c` invocation. Static: confirm build-check.ts passes neither windowsVerbatimArguments nor validates WINDOWS_CMD_UNSAFE_TOKEN.

User impact: Windows build/typecheck checks fail or run a different command than intended for repositories whose build script contains quotes or cmd metacharacters.

#### PORT-006 · medium · Direct node:child_process call sites bypassing bunSpawn/spawn-helper lack invariant-3 bounds (no timeout / stdin pipe / no cwd)

Lane: portability. Kind: portability.

Evidence:

- `src/knowledge/identity.ts:134` — `.execFileSync(gitExecutable, ['remote', 'get-url', 'origin'], {`
- `src/knowledge/identity.ts:137` — `stdio: ['pipe', 'pipe', 'ignore'],`
- `src/knowledge/identity.ts:188` — `const repoUrl = getGitRemoteUrl(directory);`
- `src/services/diagnose-service.ts:398` — `child_process.execFileSync(gitExecutable, ['rev-parse', '--git-dir'], {`
- `src/services/diagnose-service.ts:400` — `stdio: 'pipe',`
- `src/turbo/epic/cochange-source.ts:86` — `const { stdout } = await _internals.execFile(`
- `src/sandbox/win32/runner-client.ts:171` — `const result = spawnSync('where', ['swarm-sandbox-runner.exe'], {`

Hypothesis: 28 runtime files import node:child_process directly; most sites satisfy invariant 3, but four do not: identity.ts:134-140 (no timeout, stdin 'pipe'; note `writeProjectIdentity` has no caller in src outside identity.ts — likely unwired), diagnose-service.ts:398-401 (no timeout, `stdio: 'pipe'` opens stdin; reachable via /swarm diagnose line 1218), cochange-source.ts:86-93 (execFile default stdin pipe, comment relies on git not reading stdin), runner-client.ts:171-176 (`where` inherits process.cwd(), which may have been deleted). The bare-executable-spawn ratchet (scripts/check-bare-executable-spawn.ts) only checks argv[0] literals, not options.

Verify: grep -n "stdio: 'pipe'\\|stdio: \['pipe'" src/knowledge/identity.ts src/services/diagnose-service.ts; confirm no `timeout:` in those option objects; grep -rn writeProjectIdentity src \| grep -v identity.ts (expect none). On Windows/Bun, wrap git with a script that blocks on stdin and run /swarm diagnose to observe the hang.

User impact: /swarm diagnose can hang on a slow/blocked git on Windows under Bun (never-closed stdin pipe, no timeout); identity.ts is dead-but-shipped code violating invariant 3 and the 'never ship unwired code' directive.

#### PORT-007 · low · CRLF-naive parsers: $-anchored (.+)/(.*) regexes over split('\n') lines of user-editable markdown stop matching on Windows CRLF input

Lane: portability. Kind: portability.

Evidence:

- `src/hooks/knowledge-curator.ts:376` — `const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);`
- `src/hooks/knowledge-curator.ts:1809` — `const projectNameMatch = /^#\s+(.+)$/m.exec(planContent);`
- `src/services/handoff-service.ts:387` — `const phaseMatch = planMdContent.match(/^## Phase (\d+):?\s*(.+)?$/m);`
- `src/services/diagnose-service.ts:441` — `const titleMatch = specContent.match(/^#\s+(.+)$/m);`
- `src/plan/manager.ts:2783` — `/^(\d+)\.\s+(.+?)(?:\s*\[(\w+)\])?$/,`
- `src/tools/placeholder-scan.ts:472` — `const lineCommentMatch = line.match(/(?:\/\/\|#\|<!--)\s*(.*)$/);`
- `src/hooks/write-target-resolver.ts:167` — `// Split on CRLF *or* LF. This is the single choke point feeding every`

Hypothesis: 68 runtime files split file content on '\n' and never reference '\r' (crlf.ts). Most trim each line first and are safe; 16 $-anchored capture regexes remain in those files (crlf-regex.ts), of which the ones over user/editor-touched inputs matter: spec.md title (diagnose-service.ts:441 → false 'spec stale'), plan.md phase/title/task parsing in the /m multiline form (knowledge-curator.ts:1809, handoff-service.ts:387, plan/manager.ts:2727,2783,2824 — plan.md is plugin-written LF but is a common hand-edit target on Windows), knowledge bullets (knowledge-curator.ts:376 is over `trimmed` and therefore safe), and source-file comment extraction (placeholder-scan.ts:472). JS `.` and `$` (without /m) do not match/skip `\r`, so `(.+)$` fails on a CRLF line. The repo has fixed exactly this class before (write-target-resolver.ts F-011; #2097 CRLF in check-invariants).

Verify: bun -e "console.log(/^#\s+(.+)$/m.exec('# Title\r\nbody')?.[1])" → 'Title\r' (title carries \r; spec-staleness compare then fails) and "console.log(/^-\s+\[\s*\]\s*(.+)$/.exec('- [ ] item\r'))" → null. Then write a CRLF spec.md into .swarm/ and run /swarm diagnose.

User impact: On Windows checkouts where spec.md/plan.md are edited with CRLF editors or core.autocrlf, diagnose reports spurious spec staleness, plan phase/task extraction silently returns nothing, and placeholder-scan misses line comments.

#### PORT-008 · low · Recursive rmSync without maxRetries (0 of 21 sites) — Windows EBUSY/EPERM from AV/indexer aborts init-path orphan-worktree cleanup and reset-session on first try

Lane: portability. Kind: portability.

Evidence:

- `src/hooks/init-orphan-recovery.ts:310` — `_internals.rmSync(worktreePath, { recursive: true, force: true });`
- `src/hooks/init-orphan-recovery.ts:331` — `_internals.rmSync(worktreePath, { recursive: true, force: true });`
- `src/commands/reset-session.ts:429` — `fs.rmSync(worktreesDir, { recursive: true, force: true });`
- `src/worktree/core.ts:1085` — `(lastError.includes('EBUSY') \|\| lastError.includes('EPERM')) &&`

Hypothesis: Node's rmSync retries EBUSY/ENOTEMPTY/EPERM only when maxRetries > 0 (default 0). worktree/core.ts retries git worktree remove on EBUSY/EPERM and bun-compat retries rename, but the 21 rmSync and 5 fsp.rm recursive sites (init-orphan-recovery, reset-session, cli cache purge, swarm-residue, config-doctor, evaluation, harness store, scope-persistence, evidence manager) pass no maxRetries, so a transient Windows handle lock fails the whole removal. init-orphan-recovery runs from the post-init queue (index.ts:1196) and swallows the error into an advisory, so orphan dirs persist and are re-reported each init.

Verify: On Windows, hold a handle open inside a stale .swarm-worktrees/<lane> directory (e.g. `powershell -c "$f=[IO.File]::Open('...\x.txt','Open','Read','None'); Start-Sleep 30"`) and start the plugin: advisory shows removal failure; with `maxRetries: 5, retryDelay: 100` the removal succeeds after the handle closes. Static: grep -rn "rmSync(" src \| grep recursive \| grep -c maxRetries → 0.

User impact: Windows users see repeated 'orphaned worktree could not be removed' advisories and leftover lane directories; /swarm reset-session and cache purge fail transiently.

#### PORT-009 · low · Mixed-separator path building: metrics.ts relative-path strip never matches on Windows (glob include/exclude diverges by platform); loop.ts and partition-common.ts build non-canonical paths

Lane: portability. Kind: portability.

Evidence:

- `src/quality/metrics.ts:939` — `const relativePath = fullPath.replace(`${dirPath}/`, '');`
- `src/quality/metrics.ts:981` — `if (globMatches(relativePath, glob)) {`
- `src/commands/loop.ts:38` — `const loopDir = `${directory}/.swarm/loop`;`
- `src/turbo/lean/partition-common.ts:91` — `pathToCheck = `${directory}/${file}`;`

Hypothesis: fullPath comes from path.join (backslashes on Windows) so the `${dirPath}/` prefix never matches; relativePath stays absolute and include/exclude glob matching (lines 968-985) evaluates against an absolute Windows path, unlike POSIX. loop.ts and partition-common.ts produce mixed-separator paths that work for fs calls but not for later string comparisons.

Verify: bun -e with process.platform patched to win32 is insufficient (path module is posix); on Windows run the quality metrics tool with include globs and compare counted files vs Linux for the same repo.

User impact: Quality metrics (LOC / test-ratio) differ on Windows for the same repository when include/exclude globs are configured.

#### PORT-010 · low · Prefix containment without a separator (.swarm-evil passes) in evidence-check, req-coverage, check-gate-status — out of lane, route to security

Lane: portability. Kind: bug.

Evidence:

- `src/tools/evidence-check.ts:90` — `return normalizedPath.startsWith(swarmPath);`
- `src/tools/evidence-check.ts:148` — `if (!resolvedPath.startsWith(evidenceDirResolved)) {`
- `src/tools/req-coverage.ts:276` — `if (!resolvedPath.startsWith(cwdResolved)) {`
- `src/tools/check-gate-status.ts:70` — `return normalizedPath.startsWith(swarmPath);`

Hypothesis: startsWith(root) without `+ path.sep` accepts sibling directories sharing the prefix (`<cwd>/.swarm-x`, `<cwd>2/...`). Found while auditing class 8; not a portability defect.

Verify: bun -e "const p=require('path');console.log(p.resolve('/proj/.swarm-evil/x').startsWith(p.join(p.resolve('/proj'),'.swarm')))" → true.

User impact: Containment checks in three tools can be satisfied by a sibling path outside the intended directory.

#### PORT-011 · low · Directive predicate child env scrub omits Windows-essential variables (USERPROFILE, APPDATA, LOCALAPPDATA, PATHEXT, COMSPEC, ProgramFiles)

Lane: portability. Kind: portability.

Evidence:

- `src/services/directive-predicate-runner.ts:141` — `function safeChildEnv(): NodeJS.ProcessEnv {`
- `src/services/directive-predicate-runner.ts:145` — `if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;`

Hypothesis: Only PATH/HOME/SystemRoot/TEMP/TMP are forwarded. HOME is usually unset on Windows, so children (git, node/npm tooling, dotnet) see no USERPROFILE/APPDATA/LOCALAPPDATA and no PATHEXT/COMSPEC; npm config resolution and git credential/global-config lookups degrade or fail.

Verify: On Windows run a `tool: git config --global user.name` predicate and observe failure vs full env; static: read safeChildEnv.

User impact: Allowlisted `tool:` predicates behave differently on Windows than on POSIX and can fail for environment reasons unrelated to the predicate.

## 4. Subsystem summaries and coverage gaps

### Commands, skills, bundled-skill sync (`commands`)

Registry (154 keys), tool-policy derivation, 93 OpenCode shortcuts, CLI run(), bundled-skill sync and mirror contracts are internally coherent: drift-check is clean and the four skill wiring tests pass (69/69). Defects sit at cross-file seams: (1) the architect prompt's own delegation template names SKILLS paths that exist only in this repo while a MANDATORY reference gate throws on a missing file and bundled fallbacks are excluded from discovery; (2) opencode-swarm-internal skills (bun:test, AGENTS.md, biome/package-check) are bundled into every consumer project and the prompt mandates injecting them; (3) /swarm ci-simulate hardcodes this repo's bun scripts yet is agent-invocable; (4) /swarm analyze emits a MODE signal no architect section consumes; (5) seven bundled skills (~150KB) are unreachable in OpenCode per the repo's own doc; (6) help/tool-policy text claims read-only routing while 'agent' policy covers mutating/subprocess commands; (7) docs/commands.md omits 29 registry commands; (8) init comment misstates sync bounds.

Contracts observed:

- COMMAND_REGISTRY is SSOT; toolPolicy derives z.enum/ALLOWLIST/HUMAN_ONLY (tool-policy.ts); 93 swarm-<cmd> shortcuts hand-maintained at src/index.ts:2921-3377 (parity test, only 'help' exempt)
- BUNDLED_PROJECT_SKILLS (41) == .opencode/skills/* minus generated == package.json#files; materialized to .swarm/bundled-skills/<slug> at init (deferred, 2s withTimeout) and on the MODE command path
- Architect MODE stubs load only file:.swarm/bundled-skills/<slug>/SKILL.md; a [MODE: X] signal needs a matching '### MODE: X' section (architect.ts:714) else falls through
- SKILLS: file: refs in architect->coder/reviewer/test_engineer/sme/docs/designer Task calls are validated unconditionally (gate.ts:683-746) and throw in tool.execute.before (index.ts:3769-3773); audience ctx always includes swarm-plugin+runner:opencode
- SKILL_SEARCH_ROOTS = .opencode/skills, .opencode/skills/generated, .claude/skills; .swarm/bundled-skills and .agents/skills never scanned; .opencode/skill-routing.yaml not shipped

Coverage gaps:

- Not read beyond registry wiring: close.ts (2852), harness, memory, sdd, benchmark, epic, skill-opt, knowledge, review, reset-session, archive-sqlite handlers.
- Not read in full: swarm-pr-review (125KB), swarm-pr-feedback, issue-tracer, codebase-review-swarm, loop, council, deep-dive, deep-research SKILL.md; only frontmatter, sizes, cross-refs checked.
- Cross-scope (init): init-time bundled sync has no project-root check on ctx.directory (invariant 4 wording).
- Cross-scope (hooks): skill-routing.yaml routes coder to swarm-implement on keyword 'code' and to the 630-byte .claude writing-tests adapter; injection of thin adapters not traced.
- Cross-scope (guardrails): 'guardrail reset' is toolPolicy 'agent' and circuit-exempt (nontransient-circuit.ts:266) vs AGENTS.md invariant 9 'external repair'; guardrail-log exposes no digests, exploitability unverified.
- Known/tracked, not re-reported: 'plan' slug in both native trees while 'plan' is in CLAUDE_CODE_NATIVE_COMMANDS (constants.ts:165; #2388 allowlisted in claude-slug-collision-guard.test.ts:84).
- Not verified against the host: whether OpenCode exposes .opencode/skills/<slug> as /<slug> (asserted by the collision test); if so this repo's .opencode/skills/swarm shadows the plugin /swarm during dogfooding.

### Config, schema, CLI (`config`)

Mapped config loading (loader.ts recovery ladder), schema/docs generation (verified byte-identical to regeneration) and the Bun-only CLI. Reproduced in isolated XDG dirs: (1) `install` replaces an unparseable ~/.config/opencode/opencode.json (BOM/UTF-16/typo) with a minimal file, destroying providers/MCP/other plugins — the path docs recommend for 'architect not visible'; (2) `install` leaves version-pinned packages/opencode-swarm@<semver> caches (invariant 12) while `update` clears them. Three documented config samples fail schema/JSON validation and push users into the guardrails-default ladder. `/swarm diagnose` and config-doctor read only the project (or one) config, so a corrupt user-level config is reported green. The CLI bundle crashes under Node (verified) although getting-started advertises an npm-only path. Smaller: OPENCODE_CONFIG_DIR ignored by plugin lookups; env-var table incomplete; secure() wipes/mislabels guardrails when one file is corrupt; init writes .swarm/ into any opened directory.

Contracts observed:

- User config <XDG_CONFIG_HOME\|~/.config>/opencode/opencode-swarm.json; project <dir>/.opencode/opencode-swarm.json; strict JSON.parse, 100KB cap, BOM stripped (loader.ts:51-129); prompts <config>/opencode/opencode-swarm/{agent}[_append].md
- CLI writes <config>/opencode/opencode.json: plugin entry literal 'opencode-swarm', agent.explore/general.disable=true (cli/index.ts:289-352); first init writes <project>/.swarm/config.example.json (index.ts:1277)
- Cache layouts: <cache>/opencode/{node_modules,packages}/opencode-swarm[@latest\|@<semver>], <config>/node_modules/opencode-swarm, darwin ~/Library/Caches, win32 %LOCALAPPDATA%/%APPDATA% (cache-paths.ts:129-268); lock files bun.lock/bun.lockb/package-lock.json
- Env read in src: XDG_*, HOME, LOCALAPPDATA, APPDATA, OPENCODE_CONFIG_DIR (lane allowlist only), OPENCODE_SWARM_DEBUG, DEBUG_SWARM, OPENCODE_SWARM_ID, OPENCODE_SWARM_GIT_BINARY, OPENCODE_SWARM_MEMORY_UNITID_PROBE, SWARM_ALLOW_HUMAN_ONLY_CLI, SWARM_ALLOW_FULL_SUITE, SWARM_LANG_BACKEND, SWARM_SKIP_SPEC_GATE, SWARM_SKIP_GATE_SELECTION, SWARM_OBSERVABILITY_LINEAGE_SALT, TAVILY_API_KEY, BRAVE_SEARCH_API_KEY
- opencode-swarm.schema.json + docs/configuration.md marker table generated from PluginConfigSchema (scripts/generate-config-schema.ts) — in sync; DEFAULT_MODELS (constants.ts:414) opencode/* Zen models, architect has no default; DEFAULT_AGENT_CONFIGS keys all in ALL_AGENT_NAMES
- CLI bin dist/cli/index.js: '#!/usr/bin/env bun', --target bun, main() gated by import.meta.main; `run` refuses human-only commands when !isTTY unless SWARM_ALLOW_HUMAN_ONLY_CLI=1

Coverage gaps:

- src/config/schema.ts: only top-level shape and ~6 nested sections read (of 4086 lines)
- lane-permissions.ts, lane-context.ts, bundled-skills.ts, skill-mirrors.ts, context-window.ts, sanitize-malformed-values.ts, evidence/plan/spec schemas not read in depth
- config-doctor.ts auto-fix/backup paths and diagnose-service.ts checks beyond config/cache/version only indexed
- docs/configuration.md prose beyond the JSON samples; docs/installation.md 507-1176 headings only
- No Windows host: npm cmd-shim + bun shebang and %LOCALAPPDATA% layouts reasoned from source only
- Cross-scope: model preflight is fail-open when the provider catalog is unreachable — no-config users on opencode/* defaults without auth may only fail at dispatch (agents lane)
- Cross-scope: cli loadJson JSONC regex may mis-handle escaped backslashes/commas inside strings (not verified)

### User-facing documentation (`docs`)

Read README fully, docs/index, getting-started, 3 install docs, commands/modes/configuration (outline + key sections), recovery guide, contributing, design-rationale, CHANGELOG head, 4 latest release files, 20+3 pending fragments, the fragment aggregator, release workflow and drift checker. Verified 26 README claims: 20 hold, 6 drifted. Every /swarm command and tool name in the docs exists; all relative links resolve; `bun scripts/drift-check.ts` passes (it pins 11 skill/prose numbers, none in README). Live GitHub Release v7.160.2 body does carry the aggregated fragment block. Top defects: Docker/LLM docs `npm i -g ... opencode` (package absent on npm, real one is opencode-ai); README…

Contracts observed:

- Bin dist/cli/index.js: `#!/usr/bin/env bun`, built --target bun (package.json:24); subcommands…
- Global config ~/.config/opencode/opencode-swarm.json (XDG-aware, loader.ts:43); .opencode/opencode-swarm.json opt-in…
- schema.ts defaults -> generated opencode-swarm.schema.json (packaged) -> docs/configuration.md; README config prose…
- src/commands/registry.ts 154 keys, 9 clashesWithNativeCcCommand; src/tools/tool-metadata.ts 129 tools
- docs/releases/pending/<slug>.md (595) -> scripts/release-notes-fragments.mjs via release-and-publish.yml:75-124 ->…
- scripts/drift-check-docs-claims.ts pins 11 numeric claims (none README); passes today

Coverage gaps:

- docs/configuration.md (150 KB) via outline + targeted greps only; generated key table not…
- docs/commands.md, docs/modes.md, docs/installation.md bodies via outline and targeted sections only
- docs/releases: 4 of 5 latest files, 3 of 595 fragments read fully; CHANGELOG top 150 lines…
- Host UI claims (TUI Ctrl+K palette, Desktop dropdown) unverifiable here
- Cross-scope CLI: Bun-only bin vs npm shims on Windows not exercised
- Cross-scope runtime: node:sqlite needs Node >=22.5 (sqlite-loader.ts:20-21) vs docs 'Node.js 20+' /…
- Cross-scope hooks: context-budget hard pruning default (enforce=true) deserves UX review
- Cross-scope build: opencode-swarm.schema.json modified in working tree (git status), not inspected
- README numeric claims are outside DOCS_NUMERIC_CLAIMS; CI would not catch DOCS-5/7/14/15

### Evidence and QA gates (`evidence`)

Mapped flat task gate evidence (src/gate-evidence.ts zod state machine), bundle evidence (evidence/manager.ts), receipts/repair/quarantine, phase-participation, phase_complete's 14-check preflight + locked commit, the verification tools, and the gate-denial/incremental-verify hooks. All 11 scope tools are exported, in TOOL_METADATA, agent-mapped and tested. Runtime probes (scratchpad/verify/evidence-lane.ts, bun) confirmed: the repair sentinel requirements_reconstruction is never consumed so a repaired task can never complete; req_coverage reads 'diff' entries nothing writes so every FR is 'missing' and the #2242 preflight gate always fails; incremental_verify only runs under execution_mode 'strict' (default balanced) though docs say on; regression_sweep.enforce, todo_gate/todo_scan and auto_archive have no producer/consumer; check_gate_status reports all_passed on files the zod readers reject. Plus recovery-doc drift, disabled-mode skipping the plan transition, plan-free defaults, and two literal drifts.

Contracts observed:

- Flat .swarm/evidence/<taskId>.json: TaskEvidenceSchema strips unknown keys; required_gates only grow; tests_run needs every required gate present
- Bundle .swarm/evidence/<taskId>/evidence.json: saveEvidence appends raw object; loadEvidence re-parses with EvidenceBundleSchema (strips unknown entry keys)
- WAL fences coder-settlements/, task-terminals/, task-repairs/<taskId>.json gate evidence writers; /swarm recover covers coder-settlement + stage-a only
- phase_complete: preflight hash must reproduce under plan lock; savePlan preCommitCheck re-hashes computePhaseEvidenceSnapshot; writes phase status 'complete'
- Config: execution_mode (default balanced) gates incremental_verify; phase_complete.{enabled,require_docs=true,policy=enforce,regression_sweep.enforce}; guardrails.gate_denial_{warn=3,stop=5}_threshold; todo_gate.*; evidence.auto_archive
- Agents: phase_complete/repair_gate_evidence/record_* -> architect; check_gate_status/evidence_check/completion_verify -> architect+critic_oversight; req_coverage -> critic roles+spec_writer

Coverage gaps:

- src/evaluation/* only skimmed (gate-audit.ts to L140); src/quality/metrics.ts export-skimmed; documents-retention.ts skimmed
- Cross-scope: readTaskEvidence fail-open sites (delegation-gate.ts, guardrails/index.ts, stage-b-gates.ts) map null to idle/gen 0; not traced whether any grants dispatch on that basis
- Cross-scope: update_task_status handling of required_gates sentinel; preflight-service #2242 gate; /swarm evidence/archive/gate-audit commands; telemetry catalog for gate events
- gate-denial invocation-id keying assumed stable within a turn (beginInvocation on chat.message); not runtime-tested
- record_* receipts use registered constant-name temp + rename without fsync/Windows retry; not probed on Windows

### Hook chain (guardrails, delegation gate, chat transforms) (`hooks`)

src/index.ts wires: tool.execute.before = raw-await fail-closed chain (guardrails > scope-guard > PR-workflow > delegation-gate > full-auto x2 > knowledge/skill gates) with decorate-and-rethrow; tool.execute.after = safeHook chain + Task handoff; messages/system transforms = composeHandlers; compacting = raw wrapper; no `event` key. Invariant-10 in-place mutation holds in-lane. Top candidates: compacting wrapper TypeError when hooks.compaction=false; 'Task'-only checks (loop detector, model-route registration) vs lowercase `task` host id make loop containment and child model fallback dead; PARTIAL GATE VIOLATION latch consumed before gates can run; includes('error') gate classifier; scope-guard advisory to wrong architect; unverified host rendering of synthetic role:'system'; docs drift; flush-lock race; 2h-sweep fail-open; test-suite regex misfire.

Contracts observed:

- Hook keys (src/index.ts): messages.transform:3386, text.complete:3507, system.transform:3510, session.compacting:3586, command.execute.before:3607, tool.execute.before:3609, tool.execute.after:4081, chat.message:4685; no `event` hook
- SDK shapes (host-boundary.ts): messages.transform input {}; system.transform {sessionID?, model}; after has no args (setStoredInputArgs snapshot, FIFO 2000); Message=User\|Assistant; ToolPart.type==='tool'
- Config: hooks.{system_enhancer,compaction,agent_activity,delegation_tracker,delegation_gate,delegation_max_chars,background_subagents}; guardrails.{enabled,profiles,qa_gates.required_tools,require_reviewer_test_engineer,no_op_warning_threshold=15,runaway_output_max_turns=5,idle_timeout_minutes=60,gate_denial_warn/stop=3/5,sandbox}; watchdog.{scope_guard,delegation_ledger}=true; context_map.enabled; context_budget.*; env DEBUG_SWARM, OPENCODE_SWARM_DEBUG
- .swarm: context.md, plan.json/plan.md (write-blocked), spec-staleness.json, scopes/scope-<taskId>.json, curator-briefing.md, summaries/, coder-settlements/
- Denial codes: SCOPE_NOT_DECLARED, SCOPE_WORKSPACE_MISMATCH, SCOPE_ROOT_ESCAPE, SCOPE_VIOLATION, WRITE BLOCKED, WRITE TARGET UNVERIFIABLE, BLOCKED:*, [sandbox] BLOCKED, SPEC_DRIFT_BLOCK, PLAN STATE VIOLATION, LIMIT REACHED, CIRCUIT BREAKER, PRM HARD STOP, SWARM_INTERNALS_OFF_LIMITS, MODEL_FALLBACK_EXHAUSTED; order pins: tests/unit/hooks/hook-composition*.test.ts, chat-transform-rebind-guard.test.ts

Coverage gaps:

- delegation-gate.ts (6180 lines) read only at factory entry/return shape and Task checks; scope preflight, Stage B, background settlement and delegation-gate/* worktree files not read
- system-enhancer.ts read only to ~line 900; retro/handoff/spec-drift/budget-warning bodies not audited
- guardrails/file-authority, destructive-command, shell-audit-store, nontransient-circuit, audit-log, pre-check-result, shell-write-detect, write-target-resolver not read; execution-stall/internals-guard partial
- No OpenCode host binary/source in the sandbox: host rendering of role:'system' (HOOKS-7) and the exact host Task tool id (HOOKS-2/3) are inferred from repo evidence, not observed
- Cross-scope: PR-workflow session resolver awaits I/O on every tool call inside the fail-closed chain (index.ts:3681) — pr-* lane; index.ts re-parses KnowledgeApplicationConfigSchema per tool call (index.ts:3739) — knowledge lane perf
- Cross-scope: knowledge-injector.ts:880 and memory/injector.ts:163 share the synthetic system-role dependency (HOOKS-7); context-capsule reads plan.json/scope files synchronously on the system-prompt path (context-map lane)
- Minor (dropped for size): guardrails/messages-transform.ts:460 tests part.type === 'tool_use' but the SDK ToolPart type is 'tool' (types.gen.d.ts:267) — dead reset branch, masked by the toolBefore counter reset

### Plugin init and runtime portability (`init`)

The server() critical path is lean and bounded (repro-704 T1 62.7ms Node/Linux; 8 sync fs calls before resolution under node --trace-sync-io). Defects cluster around process-global state not keyed by directory although OpenCode instantiates the plugin per directory (lanes, tabs; lane-permissions.ts:15-17). A harness calling server() for two git workspaces plus a bare HOME in one Node process proves: the 2nd workspace is never git-excluded while .swarm/ is created there; the 2nd gets no telemetry.jsonl; HOME gains ~/.swarm/ with five entries. On the Node sidecar the sqlite adapter's run() returns undefined for parameterless SQL while /swarm link's migration reads .changes. bun-compat's Node stdin default diverges from Bun. No dispose hook; exit listeners accumulate; each lane instance replays the whole post-init queue.

Contracts observed:

- default export {id:'opencode-swarm', server}; hooks: name, agent, tool, event, config, experimental.chat.{messages,system}.transform, experimental.text.complete, experimental.session.compacting, command.execute.before, tool.execute.{before,after}, chat.message, automation; SDK 1.18.3 Hooks has dispose? but no agent/name keys (agents registered via config hook, src/index.ts:2790)
- timeouts: config 2000, snapshot 5000, git-exclude 3000/1500, project-context 300; post-init bundled-skills 2000, trajectory 10000, maintenance 10000, preflight 2000, version 5000; repro-704 T1 400ms; init subprocesses: 4x git -C <dir> with stdin ignore/timeout/kill
- env OPENCODE_SWARM_DEBUG, DEBUG_SWARM, OPENCODE_SWARM_GIT_BINARY, HOME/XDG_*; files <dir>/.opencode/opencode-swarm.json, ~/.config/opencode/opencode-swarm.json, .swarm/{session-snapshot.json,telemetry.jsonl,config.example.json,bundled-skills/,locks/,advisories/,repo-graph.json}, .git/info/exclude, ~/.cache/opencode-swarm/version-check.json
- config keys at init: quiet(default true), version_check, repo_graph, automation, pr_monitor, memory.reflection, hooks.background_subagents, skill_improver.trigger, full_auto, git.binary, auto_review, guardrails, worktree.lane_permissions

Coverage gaps:

- src/state.ts read at 860-1060 plus greps only; eviction loops (1943-2040) not audited
- src/services/* read only for warning-buffer, version-check, model-preflight; config-doctor, diagnose/status/cost-accounting not read
- Runtime trace is Linux+Node only; Bun and Windows init paths not executed
- OpenCode host behaviour (dispose, hooks.agent, per-directory instantiation) verified only via SDK d.ts and lane-permissions.ts claims
- node:sqlite strict binding (undefined/boolean params) not scanned; src/db/qa-gate-profile.ts and task-checkpoint-receipt.ts not read
- INFO dropped for size: returned hooks carry agent/name keys absent from SDK Hooks (index.d.ts:173-183); only config hook Object.assign (index.ts:2790) registers agents
- Cross-scope (hooks): createSwarmCommandSystemRuleHook rebinds output.system when non-array (src/index.ts:388-396)
- Cross-scope (tools): pkg-audit.ts Promise.race timeout without proc.kill in finally (:287-296)
- Cross-scope (worktree): init-orphan-recovery wraps sync owner scans in withTimeout that cannot interrupt them (:636,:673)
- Cross-scope (cli): dist/cli/index.js is --target bun while package.json#bin exposes it to npx/node users
- Cross-scope (harness): scripts/repro-704.mjs fake client lacks `provider`, so model preflight is never exercised under Node

### Knowledge, memory, learning (`knowledge`)

Tool/agent-map wiring for knowledge, receipts, curation, hive, learning and opt-in memory is complete, but several runtime paths are dead or costly. Top candidates: (1) hive promoter runs a full promotion transaction (2 uncached git spawns, receipt-ledger lock+replay, hive dir lock+read) on EVERY tool.execute.after; (2) knowledge-curator write trigger and (3) memory Task-output proposal capture both parse input.args, which the SDK never supplies on tool.execute.after (#1849) - dead in prod while unit tests pass args inline; (4) run-memory (#2115) is only injected when knowledge search returns >=1 entry. Also: memory-disabled turns still append an uncapped per-session run-log; non-swarm agent turns write skip events into .swarm/; delegate injection allowlist omits explorer/critic_*/spec_writer; evergreen/low-utility signals and several curator/summaries config keys have no consumer; queueMicrotask audit writes; injection recency position undone by consolidation; docs drift. src/memory (~21k lines) is dead by default.

Contracts observed:

- hooks: messages.transform (injector index.ts:3422, memory :3421, consolidation last); tool.execute.before gate :3727; tool.execute.after curator :4383, hive :4385, microReflector :4186, admission :4211, memory :4286
- tools (tool-metadata.ts): knowledge_add/query/recall/receipt/remove/archive, repair_knowledge_receipt_ledger, curator_analyze; swarm_memory_* via MEMORY_AGENT_TOOL_MAP (constants.ts:208) only when memory.enabled
- config: knowledge.* schema.ts:1500-1672; learning.* :1673-1738; memory.* :1769-2124; curator.* :2125-2159; knowledge_application.* :2194-2224; summaries.* :538-545
- .swarm: knowledge.jsonl(100) knowledge-rejected(20) knowledge-events(5000) knowledge-receipts-v2(+snapshot/archive/quarantine/lock) knowledge-rewrites curation-proposals .knowledge-shown.json insight-candidates(500) run-memory.jsonl curator-summary.json curator-briefing.md link.json memory/memory.db runs/<sid>/memory.jsonl reflections/ summaries/
- hive dir (hive-paths.ts:34-50): win %LOCALAPPDATA%\opencode-swarm\Data, darwin ~/Library/Application Support/opencode-swarm, linux $XDG_DATA_HOME/opencode-swarm; env HOME LOCALAPPDATA XDG_DATA_HOME XDG_CACHE_HOME
- prompt blocks: <swarm_knowledge_directives> <=900 chars, lessons <=600, RUN MEMORY <=~1500, briefing/drift <=500, <delegate_knowledge_directives>, ## Retrieved Swarm Memory <=1000 tok; all hoisted to system index 0 by consolidation
- optional peer @xenova/transformers via createRequire(import.meta.url); @sqlite/sqlite-vec undeclared; bun:sqlite via src/db/sqlite-loader.ts

Coverage gaps:

- Not read: curator.ts runCuratorPhase/applyCuratorKnowledgeUpdates internals; curator-postmortem.ts; knowledge-validator.ts semantic/contradiction layers; knowledge-receipt-ledger.ts validate/compaction/repair; knowledge-application-gate.ts; knowledge-link.ts; hive-quarantine.ts
- Not read: family-migration.ts / memory-family-migration.ts merge semantics under plugin version skew (only headers + callers traced)
- Not read: sqlite-provider.ts migrations v1-v13 and node:sqlite parameter strictness; consolidation.ts, reward-capture.ts, reflection-service.ts, evaluation.ts
- Not read: commands/knowledge.ts and commands/memory.ts CLI bodies; summaries store/aggregate; learning/prm-pattern-support.ts; curator-drift.ts
- Cross-scope: other raw-input tool.execute.after hooks may share the #1849 dead-args pattern (guardrails lane); .swarm/ creation in non-swarm sessions by other hooks (containment lane); KnowledgeApplicationConfigSchema.parse per tool call at src/index.ts:3737 (gate/perf lane)

### Cross-cutting main-thread checks (`main`)

Main-thread cross-cutting checks: host SDK hook conformance, init-path deferred queue, agent registration semantics, default models vs catalog, shipped binaries, process/CI hygiene, schema regeneration drift.

Coverage gaps:

- Host-side console.warn visibility in the TUI not verified
- OpenCode permission.ask trigger site not located in host source

### Observability, failure classification, retry (`observability`)

Read end-to-end: telemetry writer, envelope/catalog/legacy adapter, core-events seam, failure classifier + action circuits, PR-review circuit, learning-health, agent-activity, model routing, both CI gates, docs. Sequence: PRs 01-16 landed; #2045 (PR #2461 open), #2046-#2051 and amendment #2309 open, so 50/55 kinds have no consumer, envelope fields are discarded per emit, no /swarm report. Top candidates: (1) single-source transient regex matches bare digit substrings, so a context-window overflow ('215037 tokens') is retry_same and advances model fallback; (2) invariant-9 transient retry has no producer (transientRetryCount never incremented, guardrails max_transient_retries unread); (3) Task-path fallback can resolve 'ambiguous' on the retry and emits no model_fallback signal; (4) learning-health rehydrate regex drops hyphenated scopes so alarms vanish after restart; (5) telemetry disable latch is permanent and invisible; (6) three emit force-casts reintroduce the #2029 bypass; (7) 16 registry rows admit unbounded streams deferred to open #2309.

Contracts observed:

- .swarm/telemetry.jsonl (+.1, 10 MB rotation, os.EOL) by src/telemetry.ts emit; readers cost-accounting.ts:719/817, gate-stats.ts:75, status-service.ts:101, heartbeat listener
- .swarm/events.jsonl + events-authority-index.json only via appendCoreEventSync (check-core-events-usage.ts)
- .swarm/learning-health.json (schemaVersion 1) by src/health/learning-health.ts; read by /swarm status and diagnose
- TelemetryEvent union (55) == EVENT_CATALOG (55); KNOWN_TELEMETRY_KEYS covers 51; CI: check:events / check:retention (ci.yml:199-202)
- Config: guardrails.max_transient_retries (default 5, unread), agents.<role>.fallback_models, pr_review_resilience.correlated_failure_threshold (2)
- Env SWARM_OBSERVABILITY_LINEAGE_SALT; /swarm guardrail reset <digest> --invocation <id> (registry.ts:768); no /swarm report
- Action circuits keyed session+invocation+digest+kind, TTL 30 min, cap 500, process-local

Coverage gaps:

- core-events.ts fold internals (1130-1488) and pr-workflow-gate.ts beyond the circuit advance (4380-4530) not read; the PR circuit trusts only SDK names APIError/ProviderAuthError (dispatch-lanes.ts:3639-3645).
- nontransient-circuit.ts remediation text and gate-denial-tracker.ts circuit use not read; sandbox fail-closed claim unverified at runtime.
- Host event ordering for OBSERVABILITY-3 inferred from index.ts, not observed on a live OpenCode host.
- Cross-scope: pr-monitor-worker.ts (#2409), cost-accounting readers, close.ts telemetry archiving not audited.
- Suspicion: classifyProviderFailure auth regex runs before transient checks ('authentication timeout while connecting' -> operator_action); raw SDK envelope errors {name,data:{message,statusCode}} classify provider.unknown unless the caller flattens data.* (dispatch-lanes/index.ts do; oversight/intercept JSON.stringify into the message).
- Windows behavior of rotateTelemetryIfNeeded renameSync over an open stream not tested.

### Parallel execution, worktrees, turbo, full-auto, sandbox (`parallel`)

Traced Lean Turbo, Epic, v8 parallel-first, worktree lifecycle, init orphan recovery, Full-Auto hooks and the sandbox stack (grep/read; graph absent). Top candidates: (1) Lean Turbo's phase gate requires lean-turbo-critic.json APPROVED by default but nothing in production calls dispatchPhaseCritic (#2007 class); (2) the Windows native sandbox runner is unreachable from the npm package (binaries/ has only .gitkeep, CI never copies the exe, dist-relative lookup resolves above the package); (3) init orphan recovery from a second OpenCode process can rm -rf a live Lean lane between lane completion and merge-back; (4) v8 parallel-first needs every pending scope declared up front while default prompts declare just-in-time, so it degrades to serial. Also: lean tools ignore user config, dead Windows EBUSY retry, Epic waves unisolated, lane env profile never reaches coders, acquire-locks tool with no release, prompt/global-state drift.

Contracts observed:

- .swarm/turbo-state.json (sessions[sid].status; phase set only by LeanTurboRunner); .swarm/locks/<sha256>.lock+.meta (proper-lockfile, stale 5min); .swarm/locks/init-orphan-recovery.lock
- .swarm/evidence/{phase}/{lean-turbo/*.json,lean-turbo-phase.json,lean-turbo-reviewer.json,lean-turbo-critic.json,full-auto-*.json}; .swarm/full-auto-state.json; epic-state.json; epic/{divergence.jsonl,calibration.json}; evidence/epic-promotions.jsonl; recovery/; advisories/; scopes/scope-<taskId>.json
- <project-parent>/.swarm-worktrees/<sid>/<id> (or worktree_dir; <tmp>/swwt/<sid>/<lane>); branches swarm-lane/<sid>/<lane>, swarm/<purpose>/<sid>/<id>; <worktree>/.swarm/lanes/<N>.env
- binaries/win32-{x64,arm64}/swarm-sandbox-runner.exe or PATH `where`; %LOCALAPPDATA%/opencode-swarm/sandbox/<runId>/temp; <tmp>/swarm-sandbox-policies/<runId>.json
- config: turbo.strategy, turbo.lean.*, turbo.epic.*, worktree.*, full_auto.*, guardrails.sandbox.*, guardrails.sandbox_macos_enabled, plan execution_profile.{parallelization_enabled,max_concurrent_tasks}
- tools: lean_turbo_* (opt-in map iff config.turbo!==undefined), epic_{decide_phase,plan_waves,record_divergence}, plan_conflict_check; commands /swarm turbo\|epic\|full-auto\|coupling
- hooks: tool.execute.before guardrails→scope-guard→pr-workflow→delegation-gate→full-auto-delegation→full-auto-permission; messages.transform parallel guidance; chat.message cadence; config-hook lane permissions; postResolution runInitOrphanRecovery

Coverage gaps:

- Not read line-by-line: src/worktree/merge.ts:871-1850, src/full-auto/{oversight,cadence,severe-result,recovery,input-probe}.ts, src/hooks/full-auto-{intercept,delegation}.ts, src/turbo/epic/* internals, src/turbo/lean/{reviewer,evidence,task-completion,lane-scope,recovery,partition-common,conflicts}.ts, src/parallel/review-router.ts, src/sandbox/{capability-probe,linux,macos,win32/restricted-environment-executor,edge-cases}, runners/ Rust sources.
- Cross-scope (agents/tools): opt-in maps only add `true` entries to agent `tools`; if OpenCode enables absent keys, memory/council/turbo/skill gating is advisory only — decides PARALLEL-5 severity.
- Cross-scope (agents): Full-Auto classifies plugin tool calls only; whether OpenCode's own bash/edit permission prompts are pre-approved for generated agents (agents/index.ts:1226-1279) was not verified.
- Cross-scope (hooks): reviewer-gate bypass via hasActiveTurboMode combined with PARALLEL-8 not runtime-verified.
- Per-directory lane instances re-running plugin init inferred from src/index.ts:2792-2800 comments, not observed at runtime.
- hive-transaction.ts read fully; its callers (hive-promoter, hive-quarantine) belong to the knowledge lane.

### Plan durability (`plan`)

Plan-durability lane (src/plan, save_plan/get_approved_plan/checkpoint/approve_plan_critic/plan_conflict_check/epic_plan_waves, phase-* hooks, src/sdd). Tool wiring is complete (TOOL_METADATA-driven). Runtime probes (scratchpad/plan-lane-verify/v1..v9, `bun <file>`) reproduced 9 defects: loadPlan rebuilds from lossy plan.md BEFORE the authoritative ledger when plan.json is absent and adopts the lossy plan into the ledger (locked profile, files_touched, acceptance, specHash lost); a literal U+FFFD in task text makes plan.json permanently 'invalid encoding' and hits that path every turn; get_approved_plan reports drift for an identical plan after plan-critic approval; current_phase is reset to phase 1 by every save_plan and never advanced (v8 parallel guidance + phase-monitor stuck on phase 1); manager.updateTaskStatus is an unlocked read-modify-write losing concurrent completions; M1 rollback guard missing on the validation-failure path; unvalidated snapshots overwrite plan.json; 'closed' lossy in plan.md; full-plan snapshot per status update + full ledger parse per turn. Static: importCheckpoint unwired, guards keyed on plan.json readability, ledger rename no retry, docs drift.

Contracts observed:

- .swarm/plan-ledger.jsonl authoritative (schema 1.1.0, 13 event types; snapshot sources takeSnapshotEvent\|critic_approved(+approval.source=plan_critic_gate, STRUCTURE hash)\|savePlan_structural_projection\|savePlan_manager\|close_terminal\|recovery_from_approved_snapshot\|save_plan_stale_projection_reconcile\|plan_epoch_adopted); plan.json/plan.md derived; RuntimePlan overlays never persisted
- Side files plan-ledger.quarantine.<ts>.<hash12>, plan-ledger.reconcile-archive.*, plan-ledger.archived-* (max 5), .plan-write-marker, temps *.tmp.<ts>.<rand>; .swarm/plan-export/SWARM_PLAN.{json,md} written by save_plan+phase_complete, deleted by /swarm close
- Locks: tryAcquireLock (proper-lockfile .swarm/locks/<sha256>.lock, ~1s retries, stale 5min) for plan.json; withEvidenceLock (60s) for ledger. Tools wired src/tools/index.ts -> TOOL_METADATA.agents -> AGENT_TOOL_MAP -> buildPluginToolObject (src/index.ts:2545). Env SWARM_SKIP_SPEC_GATE, SWARM_SKIP_GATE_SELECTION. Task status pending\|in_progress\|completed\|blocked\|closed

Coverage gaps:

- src/tools/checkpoint.ts read for lock/retry shape only; receipt logic not traced
- src/plan/parallel-verdict.ts read to line 120; it reads only .swarm/scopes/ (never plan files_touched) so v8 parallel needs pre-declared scopes (delegation-gate/scope lanes)
- src/sdd/effective-spec.ts read, no defect isolated; suspicion: writeProjectedSpecSync temp grammar vs #2035 registry; balanced profile + ambiguous SDD sources saves a plan with no specHash
- knowledge receipt ledger, update-task-status tool internals, reset-session/reconcile UX not audited; Windows reasoned statically; state.ts advanceTaskStateAndPersist looks like a dead export; no tests found for PLAN-1..5

### Windows / Node portability census (`portability`)

878 runtime files censused (5927 raw hits, 33 rules); every high-signal class read at the hit. Bun-only API (class 10) and AbortSignal.timeout (class 5) are clean and statically guarded; import.meta.url-derived paths (class 9) hold under the npm plugin cache. Material findings: (1) six Windows sites hand a .cmd/.bat shim or bare npm to a shell-less spawn (test_runner vitest/jest/mocha, incremental-verify, directive predicates, PHP, pkg-audit) which Node>=20.12 (EINVAL) and Bun.spawn cannot execute; (2) 17 containment checks compare JS-realpathSync paths case-sensitively on Windows; (3) the bunSpawn Node fallback defaults stdin to pipe and 11 call sites omit stdin / 19 omit timeout (Desktop Node sidecar hang class); (4) four direct child_process sites lack timeout/stdin bounds; plus low-severity CRLF, rmSync-without-maxRetries, mixed-separator, cmd /c quoting, and env-scrub items. Coverage: PR CI is ubuntu-only unless the diff touches 8 whitelisted dirs; no test executes a .cmd shim; Node-sidecar smoke is merge-queue-only.

Coverage gaps:

- [object Object]
- [object Object]
- [object Object]
- [object Object]
- [object Object]
- [object Object]
- [object Object]
- [object Object]

### Agent system prompts (`prompts`)

Rendered every agent prompt via the real builders (scratchpad maps/measure-prompts.ts, measure-tools.ts). Default architect = 137,152 chars (~34.5K tokens) per turn; all opt-in = 159,325 (675 under the 160K CI ceiling); prefixed multi-swarm + all features = 160,338, over the ceiling and untested. Generated tool lists match AGENT_TOOL_MAP; opt-in tools hidden correctly. MODE ladder: /swarm analyze emits [MODE: ANALYZE] but only the critic prompt has that section; issue-trace pushes [MODE: PLAN\|EXECUTE] as a tail system message that consolidation relocates to index 0 while rule S keys on 'the latest message'. Per-language constraints inject only when the task DESCRIPTION contains a src/ path, while the coder prompt hard-codes this repo's TypeScript/bun:test conventions and repo-specific bundled skills ship to every project. Unwired: 'Emit JSONL event' with no tool, explorer told to write while write:false, .zcode/session/swarm-mode.md with no reader.

Contracts observed:

- ARCHITECT_PROMPT_BUDGET_CHARS=160000 test-only (architect.ts:102; tests/unit/agents/architect-prompt-budget.test.ts)
- Placeholders: Chain A architect.ts:1779-2000, Chain B index.ts:505-536; sentinel template.ts:60; fail-open assert index.ts:951
- [MODE: X ...] signals (src/commands/*.ts, hooks/issue-trace.ts) must match a '### MODE: X' section (rule S architect.ts:714)
- Skill loads: search include=<path>, mode regex, max 10000 (search.ts HARD_CAP=10000); .swarm/bundled-skills/<slug>/SKILL.md; all 22 referenced slugs in BUNDLED_PROJECT_SKILLS
- ACCEPTANCE: gate on coder+reviewer Task (delegation-gate.ts:3671-3690) == prompt architect.ts:453
- Tool lists generated from AGENT_TOOL_MAP + opt-in maps (constants.ts:208-340; architect.ts:1477-1600)
- System order: system-enhancer > capsule > heartbeat > phase-monitor > swarm-command banner > role-filter (index.ts:3510-3562); messages chain ends with consolidateSystemMessagesInPlace (index.ts:3483)

Coverage gaps:

- system-enhancer.ts L900-1490 and L1885-2850 not read; context-capsule-inject.ts, agent-output-schema.ts, project-context.ts not read
- Bundled mode SKILL.md bodies not cross-checked against each MODE section's HARD CONSTRAINTS
- Cross-scope (init): bundled-skill sync is a post-resolution background task (index.ts:1300); first-turn MODE skill load may race it
- Cross-scope (config): turbo tools gated on config.turbo !== undefined (index.ts:1368) not turbo.enabled
- Cross-scope (lang): README.md:44 claims 13 language profiles; src/lang/backends has only go/php/python/typescript
- Cross-scope (hooks): issue-trace pushes a flat {role,content:[…]} system shape unlike the host {info,parts} shape
- Cross-scope (config): read-only agents rely on tools-map omission to keep native read/glob/grep/bash; host semantics not verified

### PR review / PR feedback workflow (`prreview`)

Tree v7.160.2; repair PRs #2381-#2384 merged, #2385 (PR #2462) open. The #2375 chain is structurally closed: collect_lane_results is a pure observer, the circuit is typed/recoverable and inert by default (pr_review_resilience.enabled=false), N-of-6 settlement exists, critic routing is one predicate. New top risk is the #2384 default path: base/micro lanes settle ONLY via child-bound submit_pr_review_result, which requires the exact batchId+laneId of the delegation record, but the injected contract, contract card, explorer prompt and skill never hand those ids to the child; with legacy transcript compat off by default every discovery lane can fail closed -> NO_COVERAGE/INCOMPLETE. Second: the architect MODE stub, the wake banner and a pinned test still order abort_pr_workflow on retry_exhausted/circuit_open, contradicting the stub's own N-of-6 rule and #2380 decision 5. Third: .claude/.agents adapters say report BLOCKED when the controller is absent (#1965 residual). Also: dead legacy circuit text, tier-L micro floor 11 vs MAX_LANES 8, no circuit/suspension in pr_workflow_status, 30-min default blocking join.

Contracts observed:

- Tools (all architect-only except submit_pr_review_result, which is agents:[] and applied only via the child overlay for swarm-pr-review:base\|micro): dispatch_lanes(_async), collect_lane_results, retrieve_lane_output, parse_lane_candidates, write_pr_review_artifact, write_pr_review_trigger_eval, complete_pr_workflow, abort_pr_workflow, pr_workflow_status, prepare_pr_workflow_checkout, authorize_pr_review_reentry, prepare_pr_feedback_scope, run_pr_feedback_stage_a, rebind_pr_feedback_head, invalidate_pr_feedback_publication
- Modes: swarm-pr-review:{base,micro,council,reviewer,critic}; swarm-pr-feedback:{verification,stage-b-reviewer,stage-b-test,closeout-reviewer,closeout-critic}
- State: .swarm/pr-workflow-gates/<stem>.json, delegation ledger, .swarm/lane-results/<b>/<l>/<o>.json, .swarm/pr-review/<run_id>/{trigger-eval.json,findings.jsonl,feedback-handoff.json,feedback-consent.json,coverage-disclosure.json}, .swarm/pr-review/reentry-authorizations/, .swarm/pr-workflow-checkouts/, .swarm/events.jsonl
- Config: pr_review_resilience.{enabled=false,canary_probe_ms=300000,status_probe_timeout_ms=2000,correlated_failure_threshold=2,max_retry_attempts_after_initial=2,circuit_open_duration_ms=60000}; pr_review_legacy_transcript_compatibility (===true only); hooks.background_pending_timeout_minutes=30; pr_monitor.*
- Hooks: experimental.text.complete + event (response gate); tool.execute.before (session resolver -> enforcePrWorkflowToolBefore); tool.execute.after (pr-auto-subscribe); signal [MODE: PR_REVIEW pr=.. council=..]
- Timeouts: stale 30m (idle-confirmed), collect default 30m/max 60m, launch 30s, blocking dispatch 300s, wake 5s/quiet 120s/cooldown 30s/5 unproductive/ceilings S12 M54 L102, reentry TTL 10m, circuit open 60s
- Resilience/circuit (#2382) is inert by default: gate:4574 `if (!liveResilienceEnabled) {` early return; schema.ts:3320 `enabled: false,`

Coverage gaps:

- pr-workflow-gate.ts: ~1,500 of 18,478 lines read (admission, circuit, settlement, critic routing, submit, tool-before, handoff); PR_FEEDBACK publication, armed recovery, 
- dispatch-lanes.ts: collectOnce/settlement internals (2500-3700), model fallback, orientation block not read
- src/background pr-subscriptions/pr-event-*/pr-feedback-event-queue/pr-monitor-worker/stage-b-gates/completion-observer internals not read; src/git/pr.ts gh spawnSync show
- src/review/* is the auto_review phase engine, not PR_REVIEW; skimmed only
- run-pr-feedback-stage-a.ts / prepare-pr-workflow-checkout.ts checked only for spawn invariants (compliant)
- swarm-pr-feedback SKILL.md body not read; Windows paths spot-checked only (pr-feedback.ts and gate normalize backslashes)
- Cross-scope: Profile B cannot use '/swarm pr-feedback continue from .swarm/...' (B must not write under .swarm/); activatePrWorkflow caller not traced

### Repo graph and language backends (`repograph`)

Wiring is complete (export -> tool-metadata -> AGENT_TOOL_MAP incl. explorer/coder -> prompts -> docs/tests) and init honours invariant 1 via the post-resolution queue. The defects are cost and staleness contracts, measured on this checkout (4,152 nodes): (1) toolAfter awaits the startup build BEFORE its write-tool filter and the scan phase has no wall-clock budget - 265 s here - so every tool result stalls until the build ends; (2) the freshness stamp hashes package.json version, so every release (3-6/day) forces that full rebuild; (3) each write tool re-serializes a 37 MB pretty JSON graph plus a full fingerprint walk inside the awaited hook (~1.1 s) and the next turn re-parses/validates it synchronously (~0.5 s); (4) any workspace past max_files or the 5 s walk budget (easily hit on Windows) is permanently 'inconclusive' and never refreshed at startup. Also: docs still describe a regex-only, no-tree-sitter startup path; tree-sitter Query objects are recompiled per file and leaked; a sync builder stack and several exports have no caller; context_map's sole post-agent caller passes files_touched=[]; core tree-sitter.wasm is copy-pinned while web-tree-sitter floats on ^0.25.0.

Contracts observed:

- repo_graph config enabled/init_refresh/refresh_cap/walk_budget_ms/max_files/exclude_dirs/storage (src/config/schema.ts:1317-1360; docs/configuration.md:1168)
- .swarm/repo-graph.json (pretty JSON, schema 1.7.0); .swarm/repo-graph.fingerprint.json (EXTRACTOR_STAMP=sha256(version+schema)); .swarm/repo-memory.sqlite (indexed); .swarm/cache/impact-map.json
- Tools repo_map (22 actions, tool-metadata.ts:727) and test_impact (tool-metadata.ts:369); prompts use ask/context_pack/localization/blast_radius
- Hooks: post-resolution task 0 (index.ts:1113); tool.execute.after -> repoGraphHook.toolAfter for every tool (index.ts:4416); chat.system.transform -> system-enhancer graph blocks (system-enhancer.ts:1485,1532)
- Grammars: dist/lang/grammars/*.wasm via package.json#files, resolved from dirname(import.meta.url) (runtime.ts:164-176); web-tree-sitter is --external

Coverage gaps:

- Not read in depth: ontology.ts, pack-query.ts, symbol-query.ts, validation.ts, types.ts, indexed-storage.ts body (SQLite sync/lock), ast-diff.ts body, semantic-classifier.ts, summary-generator.ts, zone-classifier.ts, context-map telemetry/capsule-persistence/file-summary, test-impact history-store/flaky-detector/failure-classifier, profiles.ts/default-backend.ts bodies, backends/*.ts, framework-detector.ts, symbol-visibility.ts.
- No Windows or Node-sidecar execution possible; grammar-path logic verified from tests/unit/lang/grammar-dir.test.ts and web-tree-sitter's Node branch, not by loading dist under node.
- Host semantics (tool.execute.after awaited, no host-side hook timeout) assumed from src/index.ts wiring, not verified against OpenCode source.
- Cross-lane: memory reflection's 16 MB bounded read of repo-graph.json (docs/configuration.md) is exceeded by this repo's own 37 MB graph in json mode; indexed-storage lock path and DIAG toolAfter ordering ahead of repoGraphHook (index.ts:4400-4416) not audited.
- Colocated src/tools/repo-graph/*.test.ts and their inclusion in tsc --emitDeclarationOnly output not checked (build lane). src/graph/ (#1641) is absent.

### OpenCode SDK contract (`sdk`)

Installed @opencode-ai/plugin+sdk 1.18.3; npm latest 1.18.25. Plugin .d.ts and v1 SDK types are byte-identical across that range (only unused sdk/v2 gen types differ), tsc passes, no hook renamed/removed; every hook src registers exists in Hooks and has a live host trigger. Drift is plugin-side: the returned hooks literal is never checked against Hooks (no return annotation, handlers `as any`, dead keys name/agent/automation); the #1899 freshness advisory cannot see the 22-patch skew; no dispose hook so instance disposal leaks pollers/exit listeners; the system enhancer injects ~2.3KB of swarm directives into host prompts with no sessionID (Agent.generate). dist bundles zod 4.1.8+4.3.6; all 131 tools survive the host's zod-4.1.8 path empirically, but 27 have undescribed args and descriptions survive only via the host's registry rebuild. Probe scripts: maps/sdk/.

Contracts observed:

- default export { id:'opencode-swarm', server } (src/index.ts:4826-4829) matches host readV1Plugin (shared.ts:272-297)
- Registered hooks: event, config, tool, chat.message, command.execute.before, tool.execute.before/after, experimental.chat.{messages,system}.transform, experimental.session.compacting, experimental.text.complete; unused: dispose, permission.ask (no host trigger found), tool.definition, chat.params/headers, shell.env, experimental.compaction.autocontinue
- Agents registered by mutating host cfg.agent in the config hook (src/index.ts:2774-2790); host agent.ts:267 reads cfg.agent
- SDK client: session.prompt/create/abort, provider.list, app.agents — unchanged 1.18.3->1.18.25
- Env: SWARM_DEP_FRESHNESS_CHECK, SWARM_DEP_FRESHNESS_THRESHOLD (scripts/drift-check.ts:1163-1175); host sets PluginInput.$=undefined under Node (src never uses $)

Coverage gaps:

- 'session.removed' matched (src/index.ts:2698; pr-workflow-auto-wake.ts:69,187; pr-workflow-response-gate.ts:777) but not an SDK event (only session.deleted) — dead OR branch, INFO.
- buildPluginToolObject / AGENT_TOOL_MAP coherence not read — tools lane.
- Worktree-lane lifecycle not traced; host filters events by directory (plugin/index.ts:256) so parents never see lane-session events — worktree/state lanes.
- Module-level swarmState shared across instances in one host process — state lane.
- permission.ask: no trigger found in packages/opencode/src or packages/core/src (GitHub code search); not verified against a built host.
- SDK-10 not reproduced on a running host; tui.d.ts / v2 APIs only confirmed identical and unused; README/docs version claims not checked — docs lane.

### Security posture (`security`)

Posture is layered and mostly careful (array-form spawns, bounded runners, untrusted-markdown fencing, git.binary provenance, one-shot write approvals). Load-bearing defects: (1) plugin-repo paths (src/security, src/sandbox, src/evaluation, src/hooks/guardrails, docs/releases, any package.json/CHANGELOG.md) are hardcoded universal protected prefixes blocking coder writes in every consumer repo, no override, undocumented; (2) #2263 lane-env denylist leaves HOME/PATH/XDG_CONFIG_HOME open - PoC: HOME alone makes absolute git run an attacker core.fsmonitor hook; pr.ts still spawns bare git with lane env (latent: runPRWorkflow unwired; CI bare-spawn check still passes); (3) search fallback runs model regex with no timeout and ripgrep is not a dependency - measured exponential event-loop blocking; (4) delegation sanitizer flattens gate-agent prompts and is dead for prefixed multi-swarm agents. Plus macOS-sandbox/protected_paths doc drift, __proto__ residue in deepMerge, dead sanitizeInput with tests asserting a nonexistent defense, invariant-3 spawn stragglers.

Contracts observed:

- .swarm/authority/write-approvals.jsonl (write-authority.ts:60)
- .swarm/lanes/<N>.env repo-resident lane env (branch.ts:149; async twin worktree-isolation.ts:3256 has no callers)
- .swarm/session/shell-audit.jsonl redacted via redactShellCommand (audit-log.ts:15); .swarm/evidence/<phase>/full-auto-<seq>.json (oversight.ts:296)
- env OPENCODE_SWARM_GIT_BINARY; GIT_TERMINAL_PROMPT=0 on git spawns
- config git.binary (user-only), guardrails.sandbox.mode default advisory, guardrails.sandbox_macos_enabled default false, full_auto.permission_policy.protected_paths, extra_protected_paths
- tools search, gh_evidence, apply_patch; /swarm approve-write\|diagnose\|guardrail explain
- tool.execute.before: guardrails -> scope-guard -> delegation-gate -> full-auto-delegation -> applySandboxExecution (tool-before.ts:2461) -> full-auto-permission; messages.transform: delegationSanitizerHook (index.ts:3420)
- CI scripts/check-bare-executable-spawn.ts scans direct spawn callees only

Coverage gaps:

- Design-level: repo-committed .swarm/** (knowledge briefings/run-memory injected via sanitizeContextText, knowledge-injector.ts:1247) is trusted as user state; only the lane-env reader treats it as untrusted; context-sanitizer blocks just <system>/<tool_call>/closing tags.
- src/sast/rules/* and javascript-call-classifier.ts not read; destructive-command.ts unwrapping and file-authority.ts glob matcher not audited for bypasses; win32/macos edge-cases and native runner protocol only skimmed.
- Full-auto oversight: raw tool args reach the critic prompt (oversight.ts:150); persisted event composition (oversight.ts:349) not fully traced for secrets. Write-approval ledger throws on any bad line (write-authority.ts:130) with no repair command located.
- Cross-scope: other hooks hardcoding role names may share SECURITY-4; secretscan, web-search/gitingest scanners, memory/pii.ts are other lanes; search adds --hidden --no-ignore over "." when an include names a dot-dir (search.ts:337-342), exposing ignored .env* to the model.

### Tests and CI (`testsci`)

3,078 test files (~1.09M lines, 2.4:1 vs 450K src; 499 over the 500-line cap) run per-file in a 6-shard round-robin (498 files/cell; ci.yml comments say ~278). PR tier is ubuntu-only unless detect-paths matches a prefix list that omits src/utils, src/db, src/git, src/cli, src/hooks, src/config; integration, coverage, smoke (Node-sidecar repro-704/1873), PHP, Rust run only in merge_group. Live MG runs take 31-65 min (Windows cells 16-23 min + up to 21 min runner queue, then serialized unit->integration->smoke). Flake detection fires (verified live) but is advisory and sees only failed MG runs; quarantined files never execute on their OS so cannot 'prove out'. Coverage counts only loaded files and includes tests/helpers. Line-scoped lints ignore comments; invariant-3 timeout check is advisory-only; two release-fragment gates contradict; docs cite missing test paths; tests/ and scripts/ are never type-checked.

Contracts observed:

- bunfig.toml [test] preload: prod-store-tripwire.ts + executable-resolver-pin.ts; coverageDir ./coverage; no coverageSkipTestFiles
- scripts/ci/quarantined-tests{,-macos,-windows,-integration}.txt subtracted (comm -23) before sharding; per-OS lists on that OS only
- Unit set: find src tests/unit tests/adversarial tests/architect tests/cli tests/tools tests/helpers tests(maxdepth1) '*.test.ts'
- scripts/ci/run-test-with-timeout.ts: bun --smol --preload bun-32056-keepalive.ts, --kill-timeout 180, exit 124; local mirror bun run test:unit:ci
- Escape hatches: MOCK_ALLOWLIST_ENFORCE, TEST_CAP_ENFORCE, FRAGMENT_CHECK_ENFORCE, DRIFT_CHECK_ENFORCE(repo var), *_USAGE_ENFORCE, ERROR_CHANNEL_DISCARD_ENFORCE, SKILL_ASSERTIONS_STRICT, SWARM_ALLOW_FULL_SUITE
- COVERAGE_THRESHOLD 65.00, COVERAGE_SHARD_INDEX/COUNT 6 -> merge-lcov.mjs; flake-annotations-*-shard-N -> flake-detection.yml -> detect-and-quarantine-flakes.sh -> flake-suggestions + gh issue
- detect-paths 3-OS prefixes: src/worktree/ src/turbo/ src/sandbox/ src/plan/ src/parallel/ src/knowledge/ src/memory/ src/tools/ scripts/ .github/workflows/; Bun 1.3.13 in CI

Coverage gaps:

- Not read in full: check-event-contract/retention-registry/registry-citations/runtime-src-refs/skill-assertions bodies (~3.9K lines); ci-workflow-security.test.ts scans only ci.yml.
- 98 prompt-prose-asserting test files counted, not sampled; no integration/security/smoke file executed; run-test-with-timeout.ts not exercised on Windows/macOS (host Linux, Bun 1.3.11 vs CI 1.3.13).
- package.json 'prepare: bun run build' may double-build on every CI bun install (build lane); schema diff attributed to the build agent, clean-clone regeneration not performed.
- Cross-scope: security job runs tests/security batch without --smol; flake-detection.yml spawns a skipped run after every ci completion (1,790 runs); per-OS quarantine subtraction shifts non-ubuntu shard partitions; cross-contamination gate covers 2 pairs and tolerates a 'known_issue' leak; 170 files still use mock.module.

### Tool registry and agent tool maps (`tools`)

Registry mechanics are sound: 129 tools in TOOL_METADATA, compile-exhaustive TOOL_MANIFEST, single buildPluginToolObject, hard CI parity script, every tool exported/registered/mapped, multi-swarm prefixed tests exist, zod pairing OK on the current host. The load-bearing problems are semantic: (1) the per-agent allow-list is emitted as {tool:true} only, which under OpenCode's tools/permission semantics denies nothing — 'architect-only' is unenforced for ~117/129 tools and every agent likely carries all ~171 KB of tool schemas per turn; (2) tool_filter.overrides '[] denies all' is false; (3) knowledge.enabled=false unregisters 6 tools that agent maps and the architect prompt still grant and mandate; (4) getAgentConfigs fire-and-forget writes a new .swarm/evidence/agent-tools-init-<ts>.json per init with no root check or retention; (5) /swarm doctor tools is a tautology blind to config-dependent registration; (6) web_search is default-granted to sme/researcher but hard-fails without council.general; plus two untested bindings and working_directory policy divergence.

Contracts observed:

- TOOL_METADATA keys (src/tools/tool-metadata.ts) = TOOL_NAMES = plugin tool object keys (minus 6 knowledge_* when knowledge.enabled=false); AGENT_TOOL_MAP = exact inversion of TOOL_METADATA[*].agents; opt-in maps in constants.ts merged in getAgentConfigs by memory/external_skills/council/council.general/turbo/skills gates
- sdkConfig.tools = {allowed:true} + definition false flags only (agents/index.ts:1422-1441). Host: true≡{'*':'allow'}, false≡{'*':'deny'}, unlisted included; args converted via z.toJSONSchema({io:'input'}); plugin 1.18.3 tool() is identity; zod 4.3.6 inlined in dist
- createSwarmTool: directory = ctx.directory ?? process.cwd(); working_directory override only with allowWorkingDirectoryOverride → resolveWorkingDirectory + assertProjectRoot
- Writes .swarm/evidence/agent-tools-<sessionId\|init-<ts>>.json (agents/index.ts:1451-1472), read by src/services/diagnose-service.ts:1258; CI scripts/check-tool-registration.ts hard-fails (ci.yml:186)

Coverage gaps:

- OpenCode host semantics confirmed from docs (agents.mdx) and v1.18.3 tool/registry.ts; session/tools.ts resolve at the pinned tag was not fully quoted — reviewer should confirm no allow-list filter exists there.
- INFO (by design): 30/129 tools are reachable only via gates defaulting off — memory(3), council(4), general council(3 incl. web_fetch), turbo(6), skills(7), external skills(7); skill_generate/list/inspect/improve reach only skill_improver whose quota is gated by skill_improver.enabled (schema.ts:2309, default false). README lists lean_turbo_*/skill_* without the gate.
- INFO (verified OK): dist inlines zod 4.3.6, batch_symbols uses SDK's nested 4.1.8 via tool.schema, swarm_memory_outcome.anchors (line 62) holds a transform that fails z.toJSONSchema under default io:'output'; safe only because the host detects '_zod' structurally and converts with io:'input'.
- Caller-identity checks counted by grep (12/129 reference ctx.agent); per-tool audit outstanding. tests/unit/config: read agent-tool-map, constants, skill-tool-gating, tool-filter-council-hardening, memory-tool-gating only. Byte figures computed from schemas, not observed on the wire.
- Cross-scope: swarm_command default-granted to 12 agents incl. subagents (commands lane); extract_code_blocks in WRITE_TOOL_NAMES yet granted to docs/docs_design/designer/spec_writer (hooks lane); receipt-demanding hooks when knowledge disabled (hooks lane); council_*/curator_consolidation have zero swarm tools (agents lane); docs/configuration.md has a one-line tool_filter entry only (docs lane).

## 5. Gap analysis against a first-class OpenCode plugin

| Dimension | Observed | Gap |
|---|---|---|
| Host hook usage | 11 of 21 `Hooks` keys registered; no `dispose`, `permission.ask`, `tool.definition`, `shell.env`, `chat.params`; workspace adapters unused | Lifecycle, permission, schema-trimming and sandbox-env integration re-implemented in-plugin or missing |
| Host contract verification | No test loads host tool ids, role rendering, or the `Hooks` type against the returned object (`as any` on every handler) | A contract test suite pinned to the installed and latest host versions |
| Multi-instance behaviour | Module singletons for git-exclude, telemetry, warnings, agent registries, clients | Per-instance state container keyed by `ctx.directory` plus `dispose` |
| First-run path | Installer can destroy config; docs name a non-existent package; architect not auto-selected; npm path needs Bun; defaults need Zen | Idempotent, non-destructive installer; verified runbooks; safe defaults; blocking preflight with visible message |
| Denial ergonomics | 91 denial codes; prose protocol parsed by regex; errors do not say what to send next; weak models loop | One structured denial envelope; schema-validated dispatch block; weak-model dispatch benchmark |
| Portability | Windows sandbox binary absent from the package; Node sidecar sqlite adapter mismatch; PR-tier CI ubuntu-only for sensitive prefixes | Ship or build the runner; adapter parity tests; PR-tier Windows/macOS for portability prefixes |
| Per-turn cost | 130 tool schemas per agent per turn; multi-KB system injections including into non-swarm prompts | `tool.definition` trimming; session-guarded injections; measured budget per role |
| Observability for users | 50 of 55 telemetry kinds have no consumer; disable latch invisible; deferred warnings only via `/swarm diagnose` | `/swarm report`; visible degraded states; warnings surfaced in-session |
| Release and process hygiene | ~3 releases/day of a 50 MB `@latest` package; 595 pending fragments; self-posted LLM approvals; stale bot closes bugs; 31–65 min merge-group CI | Batched releases; fragment pruning; independent review policy; stale exemptions; PR-tier coverage |

## 6. Verification status and next steps

Reviewer batches were prepared for every candidate (grouped by lane, eight per batch) and critic batches for every CONFIRMED HIGH/CRITICAL finding; both stages were interrupted by the API budget limit before producing verdicts. The next revision of this document must add, per finding, the reviewer verdict (CONFIRMED / DISPROVED / UNVERIFIED / PRE_EXISTING), the critic decision for HIGH and CRITICAL items, and a section listing overturned candidates. Until then, the safest reading is: treat the pre-verified rows as very likely, treat explorer-reproduced rows as likely, and treat the remainder as leads with a concrete verification recipe.

## 7. Appendix: artifacts

Explorer maps, findings JSON, GitHub inventory (issues and PRs as JSONL), CHANGELOG analyses, probe scripts and harnesses were written under the session scratchpad (`scratchpad/maps`, `scratchpad/findings`, `scratchpad/gh`, `scratchpad/perf`, `scratchpad/portability`, `scratchpad/state-census`, `scratchpad/verify`). They are not committed. The reviewer and critic briefs used for the interrupted verification stage are `scratchpad/verify/REVIEWER_BRIEF.md` and `scratchpad/verify/CRITIC_BRIEF.md`.
