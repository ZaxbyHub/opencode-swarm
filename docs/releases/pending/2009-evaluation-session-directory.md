# Bind evaluation sessions to the project root, not the isolated fixture directory (#2009)

The evaluation subsystem (gate-audit model gates and the evaluation runner's
model executor) created OpenCode sessions bound to a foreign directory under
`os.tmpdir()`. OpenCode keys ALL permission state — both the pending-prompt map
and the "allow always" list — by directory (`InstanceState` is a `ScopedCache`
keyed on `$.directory`). A session created against a foreign directory gets a
fresh, empty permission partition. If a permission request (e.g.
`external_directory`) fired in one of those sessions, the user's TUI replied
with its OWN directory, so the reply resolved the wrong instance's pending map
and 404'd, and `Permission.ask` awaited an untimed deferred — the prompt
reappeared forever and Allow never satisfied it, permanently hanging the agent.

## Changes

- **`src/evaluation/model-dispatcher.ts`**: renamed
  `EvaluationModelDispatchRequest.directory` → `.sessionDirectory` to express
  its actual meaning — the directory that determines BOTH the permission
  partition AND agent registration. It is no longer the fixture/working
  directory. The runtime logic is unchanged: it forwards `sessionDirectory` to
  both `client.app.agents` and `dispatchEphemeralAgent` (which passes it to
  `session.create`).
- **`src/evaluation/gate-audit.ts`** (`runCell`): the model-gate dispatcher
  call now passes `sessionDirectory: args.options.projectRoot` (the invoking
  instance's directory) instead of the isolated `tempRoot`. The
  `modelPrompt` builder now takes the absolute fixture directory and
  instructs the agent to inspect ONLY files under that path, so the fixture
  is reachable even though the session's CWD is the project root.
- **`src/evaluation/runner.ts`** (`EvaluationExecutor` contract +
  `createModelEvaluationExecutor`): the `EvaluationExecutor` args contract
  gained a required `projectRoot: string` field, threaded unconditionally by
  `runExecutorWithinBudget` from `RunEvaluationOptions.projectRoot` (already
  required). `createModelEvaluationExecutor` now passes
  `sessionDirectory: args.projectRoot` instead of `args.isolatedRoot`, and
  prepends `Work ONLY in this directory: <isolatedRoot>` to the prompt so the
  agent finds the fixtures. Because `projectRoot` is threaded through the
  executor args contract — not an optional factory parameter — every executor
  invoked via `runEvaluation` / `evaluateCandidateV1` binds its session to the
  project root with no opt-out and no fallback.

## Isolation boundary

The evaluation agent's isolation remains filesystem-level: fixtures are copied
into the temp/worktree root, the agent's tools are restricted to read-only
(`DEFAULT_READ_ONLY_TOOLS` denies every canonical plugin mutation/dispatch tool
plus built-in mutation escape hatches), and the prompt directs the agent to the
fixture directory only. This is the same boundary as every other same-instance
read-only ephemeral session in the repo (auto-review, curator, skill-improver,
full-auto oversight).

## Migration

No migration required for executors invoked through `runEvaluation` /
`evaluateCandidateV1`: the runner threads `projectRoot` from
`RunEvaluationOptions.projectRoot` (already a required field) into the executor
args, so every executor receives it automatically.

The `EvaluationExecutor` args contract gained a required `projectRoot` field.
Pre-existing executor *functions* remain assignable (they simply ignore the new
field if they do not create OpenCode sessions). Only a hand-rolled executor
invoked *outside* `runEvaluation` that does not pass `projectRoot` in its args
would now fail to type-check — and such a call site would itself be a new
foreign-directory hazard this fix exists to prevent.

The `EvaluationModelDispatchRequest.directory` field was renamed to
`.sessionDirectory`. External consumers constructing this type directly (it is
re-exported from `src/evaluation/index.ts`) must update the field name; the
TypeScript compiler will flag the change.

## Acceptance criteria evidence

**Criterion 1** (permission request is answerable): Before this fix, the
evaluation session was created in a foreign temp directory, so an
`external_directory` permission request for the fixture path (which is under
`os.tmpdir()`, outside the session's temp dir) landed in the foreign
instance's private pending map — unreachable by the user's TUI, causing a
permanent hang. After this fix, the session is created in the project root
(the invoking instance's directory), so the same permission request lands in
the project-root instance the user's TUI IS attached to, and is answerable.
The SDK's `session.create` has no separate working-directory field, so the
session directory determines the permission partition. The on-disk tests prove
the session directory is now the project root, not the temp dir.

**Criterion 2** (guardrail inventory updated): The entry for
`src/evaluation/ephemeral-agent-dispatcher.ts` in
`tests/unit/config/session-create-directory-guardrail.test.ts` has been updated
from `classification: 'foreign'` + `disposition: 'foreign-non-lane-documented'`
to `classification: 'same-instance'`, with the note explaining the #2009 fix.
The guardrail test passes (12/12).

**Criterion 3** (no lane false-positive regression): No `swarm/`-grammar
branch or `ses_`-shaped id is introduced. The lane detection machinery is
untouched. Satisfied by construction.

**Criterion 4** (worktree-lane release note updated): The out-of-scope
paragraph in `docs/releases/pending/worktree-lane-permission-scoping.md` that
documented evaluation sessions as a known gap has been updated to note that
#2009 has closed it.
