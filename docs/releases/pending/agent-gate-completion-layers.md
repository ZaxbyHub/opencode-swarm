# fix(swarm): agent-gate completions — event-text authority, durable SB task binding, visible binding-write failures

## What

Closes three completion-side layers of the restart-era agent-gate wedge
documented in a consumer project's `.swarm/swarm_communication_debug.md`
(2026-11-24/25, Wirtschaftssimulation). All three are evidence-backed from
the consumer's delegation store, session exports, mtime forensics and the
opencode v2.3.2 host source; the first two are additionally proven in
production (server pid 585451 running these fixes: the reviewer and
test_engineer dispatches bound naturally for the first time since the
restart era began — workflow reached `tests_run`).

1. **Body-less store results no longer shadow the event text.** The
   background completion observer fed the Stage-B ingestion
   `ingestion.record.result ?? result`. The store's result projection can be
   BODY-LESS — the checkpoint fold strips the text/error bodies from closed
   summaries, and a trustedTerminal replay or a duplicate claim surfaces that
   shape even for a live record (observed live: a coordination row with
   `result={chars,digest,truncated}` and NO text one second after a
   text-bearing terminal claim). A body-less object still wins under `??`, so
   `structuredStageBVerdict` saw `''`, matched nothing, and the verdict arm
   rotated `stage_b_failed` + `rejected` — the exact "dispatches fire,
   receipts never land" symptom. The event result — parsed from the
   host-rendered subagent envelope on THIS invocation (host-source verified:
   no host-side truncation) — is now the authority whenever the persisted
   result has no body at all; a body-ful record result (replay shape) still
   wins.

2. **Sounding-board dispatches bind their task durably.** A
   critic_sounding_board dispatch carries NO `task_id` argument — the task id
   rides only in free prompt prose, which the strict attribution policy
   correctly refuses. Before the restart era the in-memory session fallback
   (currentTaskId) supplied the binding; after a host restart that map is
   empty and the delegation record persisted task-less, making the
   completion ingestion a no-op BY DEFINITION (taskId null → no Stage-B
   evidence side effects), so the SB gate receipt could never land (live:
   `ses_defd94c65ffe`, planTaskId null, terminalResult present, ingestion
   null). The dispatch gate now binds the task via the LATEST coder
   delegation of the same parent session — the SB context is the retry
   escalation of exactly that coder chain — fail-closed on an uncertain
   store or no coder delegation. Production-verified: the post-fix SB
   dispatches created task-bound records (planTaskId/evidenceTaskId 2.20).

3. **Stage-B binding-store write failures leave a visible trace.** The
   store's `catch { return false }` discarded the write failure's cause
   entirely, and the gate's always-emitted criticalWarn goes to the host
   stderr, which `opencode serve --service` pipes into a supervisor socket
   (stdout to /dev/null) — zero diagnosable signal while every Stage-B
   dispatch in the consumer project left an EMPTY session dir (mkdir
   succeeded, the temp-write/rename phase failed; the same code+path writes
   perfectly from a plain process). The store now emits the always-visible
   warning WITH the errno code and appends a bounded `.write-errors.jsonl`
   (last 16 entries) inside the store root, so the next failing dispatch
   leaves a durable, project-visible trace.

4. **Task-less SB dispatches bind their workflow generation durably** (the
   `ingestion_error` loop). The in-memory generation map
   (`stageBDispatchGenerationsByCallID`) is filled in the dispatch-preparation
   path keyed by the RESOLVED task id — which was null for a task-less SB
   dispatch even after the layer-2 binding (that resolves the task only in
   toolAfter), so the record carried NO `workflowGeneration` and the
   completion ingestion refused with `TASK_WORKFLOW_GENERATION_REQUIRED`
   forever (live: `ses_ded837dfdffe`, status `ingestion_error`, retryable
   loop, "ingestion failed" advisory while the verdict itself was APPROVED).
   The SB arm now binds the workflow generation from the durable task
   evidence at dispatch time — the same fence input the in-memory map would
   hold; unreadable evidence keeps the refusal (fail closed).

5. **`tests_run` requires every required gate** (the three-gate catch-22).
   With three required gates (SB+reviewer+TE, grown from the escalation
   history), whichever Stage-B gate bound second used to jump the workflow
   straight to `tests_run`: the `routeComplete === true` shortcut in the
   `stage_b_completed` reducer bypassed the required-gate count, so a
   complete ROUTE receipt (an allocation statement, not a gate statement)
   fabricated "tests can run" while a required gate was still unbound — and
   the completion guard then blocked the still-missing gate's dispatch in
   every order (live: task 2.20, SB→reviewer→TE and SB→TE→reviewer both
   wedged). Two halves, one invariant — tests_run means EVERY required gate
   has bound evidence. Reducer: the route-complete arm counts
   `hasAllRequiredGatesPassed` like the plain arm (incomplete set stays
   honestly at `reviewer_run`; `tests_run` never moves backwards), and a
   `gate_recorded` event that completes the required set performs the same
   transition so an advisory receipt binding LAST can still finish the
   sequence — guarded by a Stage-B gate in the required set so a lone
   advisory receipt on a settlement-recovered task stays state-preserving.
   Guard: `canRunWhileTaskAwaitsCompletion` permits a Task dispatch of a
   gate agent whose gate the awaiting task has NOT bound (task-less SB prose
   shape or explicitly for the awaiting task); already-bound re-dispatches,
   non-gate agents, other tools, and unreadable evidence keep the block.

## Testing

- New: `tests/unit/background/completion-observer-stage-b-result-body-fallback.test.ts`
  (body-less store result does not shadow the event text — verdict parses,
  outcome accepted, gate receipt lands; body-ful duplicate-claim shape stays
  accepted), `tests/unit/hooks/delegation-gate-sb-durable-task-binding.test.ts`
  (helper: latest coder task of the session, non-coder/foreign fail-closed;
  gate: a task-less sounding-board dispatch in the post-restart shape binds
  the durable latest-coder task, driven through the real hook with the
  running-envelope output shape), `tests/unit/background/stage-b-binding-write-diagnostic.test.ts`
  (failing atomic write surfaces the errno in the bounded store-root
  `.write-errors.jsonl`; a healthy write leaves no diagnostic and persists
  the record).
- Related suites green per-file on this branch: `completion-observer-reviewer-receipt`,
  `completion-observer-coder`, `recover`.
- Gates: `bun run build` green; `biome check` clean; no new
  `mock.module` (seam-restored `_internals` mutations only).

## Invariant audit

- 1 (plugin init):       not touched — no init-path changes.
- 2 (runtime portability): touched via rebuild — `bun run build` green; no new `bun:` runtime resolution (the smoke job covers Node).
- 3 (subprocesses):      not touched — no new spawn calls (git fixtures in tests follow the established spawnSync pattern).
- 4 (.swarm containment): not touched — the new diagnostics file lives inside the store's own `.swarm/stage-b-dispatch-bindings/` root.
- 5 (plan durability):   not touched.
- 6 (test_runner safety): not used — validation via explicit-file `bun test`.
- 7 (test writing):      touched — five new bun:test files (under the FR-006 cap; layers 1-4 plus the catch-22 suites `tests-run-required-gates-count` and `delegation-gate-completion-gate-missing-gate-dispatch`), no `mock.module`, seams restored in `afterEach`.
- 8 (session state):     not touched — no new module-level maps.
- 9 (guardrails/retry):  not touched — no retry/classification/circuit changes; the ingestion input selection changes only which result text the verdict parser sees.
- 10 (chat/system msg):  not touched.
- 11 (tool registration): not touched.
- 12 (release/cache):    touched — this pending fragment.
