# Swarm Communication Attribution: Terminal-Settlement Stage A Wedge + Background Phase Participation

## What

Closes the swarm-internal communication failure patterns documented in a
consumer project's `.swarm/swarm_communication_debug.md` (2026-11-23,
Wirtschaftssimulation): a green `pre_check_batch` that could not be attributed
after a terminal coder settlement, `phase_complete` reporting
`REQUIRED_AGENTS_MISSING` with `agentsDispatched: []` although every Stage B
role had demonstrably run, the architect being unable to write the plugin's
own loop state file, and docs participation receipts being invalidated by the
delivery commits of their own closing window.

### 1. Terminal-settlement Stage A wedge (route `terminal_settlement_wedge`)

The durable Stage A attribution fallback
(`resolveDurableGateTaskId`) only recognized COMMITTED **accepted** settlements
whose task still sat at `coder_delegated`. A task whose settlement settled
terminal — the no-mutation shape (`dispatch_no_mutation`, e.g. a read-only
delivery) or the accepted-drift shape (#2828) — with its workflow at
`idle`/`blocked` was invisible: a green `pre_check_batch` on exactly the task's
declared files routed as `no_task_correlation`, whose advisory ends with "if
this was an ad-hoc gate run, no action is needed" — actively misleading while
the task wedged and the architect had to rediscover `recover_stage_a_task` by
hand.

- The fallback now recognizes this candidate class (authoritative
  idle/blocked + COMMITTED settlement, accepted or not) and reports it as
  `{ awaitingStageA }` — never as a mechanical write target (the
  `stage_a_passed` reducer is deliberately fail-closed from those states; the
  audited, architect-only `recover_stage_a_task` stays the sanctioned writer).
- Guardrails `toolBefore` and the tool-side self-report (the Code-Mode-nested
  path that produces receipts on OpenCode 2.3.1/2.3.2 hosts) emit a precise
  `STAGE A WEDGE (TERMINAL SETTLEMENT)` advisory naming the task, the
  no-mutation qualifier when applicable, and the `recover_stage_a_task`
  remediation, and record the new bounded `terminal_settlement_wedge` route
  event with the task id — the pattern becomes recognizable in
  `.swarm/events.jsonl` instead of indistinguishable from an ad-hoc run.
- `check_gate_status` surfaces the same wedge diagnosis read-only (idle/blocked
  behind a COMMITTED settlement with Stage A unrecorded), so the wedge is
  visible before the next gate run, not only after it.
- Ambiguity semantics are unchanged and widened conservatively: a wedge
  candidate plus any other durable candidate (eligible or in-flight at
  `coder_delegated`) still forces `attribution_ambiguous`; a file-scope
  mismatch or a truncated settlement scan never yields a wedge resolution.

### 2. Background dispatches now count toward phase required-agents

With `hooks.background_subagents: true`, every Task dispatch (coder, reviewer,
test_engineer, critic, docs) runs through the background delegation pipeline,
which never populated the in-memory phase-aggregation surface
(`phaseAgentsDispatched`/`delegationChains` — those are fed by the
`chat.message` delegation tracker that background children never trigger).
`phase_complete` therefore reported `REQUIRED_AGENTS_MISSING` with
`agentsDispatched: []` for roles whose gate receipts had demonstrably landed.

- The background completion observer's verified-success closeout now records
  the completed role (normalized from the swarm-prefixed agent name) on the
  dispatching parent session via `recordPhaseAgentDispatch` — the same surface
  foreground dispatches write. Idempotent on replay; a no-op when the parent
  session is not live in memory (post-restart shape).
- The `required_agents` gate's task-gate inference was all-or-nothing: because
  `docs` (not task-gate inferable) was also missing, the inference never fired
  for `coder`/`reviewer`/`test_engineer` even though every phase task carried
  full durable gate evidence — producing the confusing "all four missing"
  block. The inference is now per-role: task-gate-inferable roles are cleared
  independently, and a non-inferable missing role stays reported on its own
  (`docs` keeps its durable participation-store check). The inference
  disclosure warning now also surfaces on the blocked arm so the architect
  sees exactly which roles the durable evidence stood in for.

### 3. `.swarm/` runtime state is its own zone (architect loop-state writes)

The zone classifier sent every `.json` path to the `config` zone, and the
architect's default `blockedZones: ['generated', 'config']` (the #894
lint-bypass protection) therefore denied the write the plugin's own loop
skill instructs the architect to make after every gate transition
(`.swarm/loop/<run>/state.json`) — with no escape, because zone blocks cannot
be overridden by allow rules (`AUTHORITY_POLICY_DENY: path is in config
zone`).

- `.swarm/` runtime state (evidence, ledgers, loop state, lane results —
  everything except `.swarm/checkpoints/`, which stays `generated`) now
  classifies as a new `state` zone with a skip-QA policy: it is machine-written
  by the swarm itself, not project source.
- The architect can write it again; the pre-existing protections are
  unchanged and re-pinned by tests: `.swarm/plan.md`/`.swarm/plan.json` stay
  blocked via their exact-path rules, the coder's `.swarm/` prefix block
  holds, and real config files stay denied. Consumers can still lock runtime
  state down explicitly with `blockedZones: ["state"]` (schema enum extended).

### 4. Docs receipts survive the delivery commits of their own closing window

The docs participation freshness check pinned the exact `gitHead` recorded at
dispatch time. The delivery commits of the receipt's own closing window — the
docs agent's committed deliverable, or a sibling task's landing between the
docs dispatch and `phase_complete` — advance HEAD monotonically and staled the
receipt, so `phase_complete` lost the docs proof it had legitimately earned
(the exact Phase-1 docs wedge in the debug log: receipt at `6d37701`, HEAD
moved by the 2.21 and 2.19 delivery commits).

- Freshness is now ancestry-aware: a receipt stays fresh while its recorded
  head is an ANCESTOR of the current head (the workspace only moved forward).
  A divergent or rewound history (another branch checked out, an orphan head)
  is not an ancestor and stays stale, and any Git failure fails closed
  exactly like the strict check.
- Implemented through one bounded `git merge-base --is-ancestor` per drifted
  candidate (`isAncestorCommitAsync` in workspace-snapshot, reusing the
  six-property safe spawn apparatus); equal-head receipts never pay for a
  subprocess call, and the gate read short-circuits on the first fresh
  receipt.

### 5. Review routing falls back to the durable coder settlement when the in-memory attribution is gone

The dispatch-time review router (reviewer/test_engineer) read the reviewed
task's changed files ONLY from the parent session's in-memory per-task
attribution (`getModifiedFilesForTask`). A host restart wipes that map while
the durable state survives, so every post-restart Stage-B dispatch routed
`NO_CHANGED_FILES` and persisted the fail-open `review_route_router_error`
receipt — whose completion the enforcement boundary (rightly) refuses
terminally: the agent gate receipt never landed, the workflow rotated
`stage_b_failed`, and the loop hard-blocked because every task needs the
reviewer gate (the 2026-11-24 restart-era wedge: 6 lost reviewer receipts and
3 sounding-board receipts across three server instances including a clean
restart; the pre-restart 2.19 dispatch with a live in-memory map is the working
counterexample; the coder path stayed healthy because its settlements are
written at dispatch time).

- The router now falls back to the LATEST SETTLED coder delegation record's
  `coderSettlement.observedFiles` — the durable executed-contract artifact —
  exactly mirroring the in-memory semantics (`recordModifiedFilesForTask`
  replaces the list per coder leg, so the latest settled leg's files, empty
  after a settled no-mutation leg, are what a live map would hold).
- Fail-closed by construction: an uncertain delegation store or no settled
  coder leg keeps today's `NO_CHANGED_FILES` router error — files are never
  invented for the router, and the completion-side enforcement boundary is
  completely unchanged (a real route receipt at dispatch is what authorizes
  the publication, exactly as before).
- `findLatestSettledCoderFilesForTask` (bounded by the store's own read
  bounds, the same class as `findByCorrelationIdDetailed`) is routed through
  the delegation-gate `_internals` seam; the fallback is observable via a
  debug-gated warn line naming task and file count.

### 6. The tests_run catch-22: required-gate counting + the missing-gate dispatch exemption

With THREE required gates (sounding board + reviewer + test engineer, grown
from the escalation history), whichever Stage-B gate bound second used to
jump the workflow straight to `tests_run`: the `routeComplete === true`
shortcut in the `stage_b_completed` reducer case bypassed the required-gate
count, so a complete ROUTE receipt (an allocation statement, not a gate
statement) fabricated "tests can run" while a required gate was still
unbound. The completion guard then blocked the still-missing gate's dispatch
in every order (live: task 2.20 — SB→reviewer→TE and SB→TE→reviewer both
wedged; the task could neither complete honestly nor bind its last gate).

Two halves, one invariant — "tests_run means EVERY required gate has bound
evidence":

- **Reducer** (`src/gate-evidence.ts`): the `routeComplete === true` arm now
  counts `hasAllRequiredGatesPassed` like the plain arm — an incomplete
  required set keeps the task honestly at `reviewer_run`; a task already at
  `tests_run` never moves backwards. And a `gate_recorded` event that
  COMPLETES the required set performs the same transition from
  `pre_check_passed`/`reviewer_run`, so an advisory receipt binding LAST
  (after reviewer+TE) can still finish the sequence instead of wedging the
  task at `reviewer_run` forever — guarded by the presence of a Stage-B gate
  in the required set, so a lone advisory receipt on a settlement-recovered
  task keeps the state-preserving contract.
- **Guard** (`src/hooks/delegation-gate.ts`): a host Task dispatch that can
  still bind gate evidence for the awaiting task is finishing work on that
  task, not new work. `canRunWhileTaskAwaitsCompletion` now permits a gate
  agent dispatch (TASK_GATE_AGENTS) whose gate the awaiting task has NOT
  bound yet, in the task-less prose shape (the sounding-board consult, bound
  durably at settlement) or explicitly for the awaiting task. Already-bound
  gates' re-dispatches, non-gate agents, other tools, and unreadable
  evidence keep the block — the completion remedy stays first-class.

## Testing

- New: `tests/unit/hooks/guardrails-stage-a-terminal-settlement-wedge.test.ts`
  (wedge routing, no mechanical write, advisory contract, ambiguity widening,
  file-scope mismatch, WAL-less idle, eligible-flow regression pin),
  `tests/unit/tools/phase-complete-required-agents-inference.test.ts`
  (per-role inference, docs-only block, durable docs receipt completion,
  fail-closed incomplete evidence),
  `tests/unit/background/completion-observer-phase-agent-recording.test.ts`
  (verified-success recording, cancelled non-recording, no-parent no-op),
  `tests/unit/hooks/guardrails-swarm-state-zone-authority.test.ts`
  (architect loop-state write allowed; plan projections, coder prefix block,
  config and generated zones, and the explicit `blockedZones:["state"]`
  override),
  `tests/unit/evidence/phase-participation-workspace-ancestry.test.ts`
  (closing-window forward commits stay fresh, equal-head strict path, orphan
  divergence stales, repository-removal fails closed, trusted background
  completion under the allowance),
  `tests/unit/hooks/delegation-gate-review-route-durable-fallback.test.ts`
  (helper: latest settled leg selection, no-mutation replace semantics,
  non-coder/other-task skips; gate: post-restart shape routes a REAL receipt
  instead of the router error, live in-memory attribution wins, no-settlement
  and uncertain-store keep the pointed NO_CHANGED_FILES refusal),
  `tests/unit/gate-evidence/tests-run-required-gates-count.test.ts`
  (all three binding orders of a three-required-gate task: SB→reviewer→TE,
  SB→TE→reviewer, reviewer→TE→SB with the late advisory receipt; exempt
  single-gate regression pin; default-pair counting; advisory-only
  state-preserving pin; no-backward pin),
  `tests/unit/hooks/delegation-gate-completion-gate-missing-gate-dispatch.test.ts`
  (guard: task-less SB dispatch permitted, explicitly-awaiting-task unbound
  gate permitted, already-bound gate re-dispatch blocked, non-gate agents and
  other tools blocked, corrupt evidence fail-closes).
- Extended: `stage-a-self-report.test.ts` (uncorrelated wedge pass),
  `tests/unit/gate-evidence/rework-recovery-supervised.test.ts` (the
  tests_run seeding now binds the TE to earn the state the old
  route-complete shortcut fabricated),
  `guardrails-stage-a-route-events.test.ts` (closed vocabulary),
  `zone-classifier.test.ts` (state-zone rules, checkpoints rule order,
  skip-QA policy), `phase-participation-storage.adversarial.test.ts`
  (divergence stays rejected; forward movement documented as fresh),
  `recover.test.ts` (chain-verified accepted_mutation repair pin; proof-less
  idle refusal), `docs/configuration.md` route table (parity test).

## Invariant audit

- 1 (plugin init): not touched — no init-path changes.
- 2 (runtime portability): touched via rebuild — `bun run build` +
  `tests/unit/build/` (226 pass, incl. bundle-portability + plugin-shape);
  `dist/index.js` remains a self-contained Node-ESM bundle with no `bun:`
  runtime resolution; the Node smoke check runs in CI (`smoke` job) — no local
  Node binary on this host.
- 3 (subprocesses): touched — `isAncestorCommitAsync` reuses the existing
  `runGitAsync` apparatus (array-form `git -C`, `stdin: 'ignore'`, timeout,
  bounded output, kill in `finally`; revision tokens validated by
  `isSafeGitRevisionToken`); no new spawn call was written directly.
- 4 (.swarm containment): not touched — new reads/writes stay on existing
  `.swarm/` surfaces (settlement WAL read, events.jsonl route line,
  participation store).
- 5 (plan durability): not touched.
- 6 (test_runner safety): not used; validation via explicit-file `bun test`.
- 7 (test writing): touched — six new bun:test files (115–353 lines, under
  the FR-006 cap), no `mock.module`, temp dirs via the canonical helpers,
  real-git fixtures following the established spawnSync pattern; the
  route-fallback suite uses `createIsolatedTestEnv` for the
  platform-root-bound receipt secret (#2033) and restores the delegation-gate
  seam in `afterEach`.
- 8 (session state): touched — the recording uses the existing bounded
  `phaseAgentsDispatched` set (no new maps); the pending-route carry keeps its
  existing session/call caps with an extended value shape.
- 9 (guardrails/retry): not touched.
- 10 (chat/system msg): not touched — advisories ride the existing bounded
  advisory surfaces.
- 11 (tool registration): not touched — `scripts/check-tool-registration.ts`
  passes (142 tools, coherent).
- 12 (release/cache): touched — deployed into the host's active
  `~/.cache/opencode/npm/opencode-swarm@latest/<ts>/` install layout with a
  full pre-change `dist` backup retained for rollback.
