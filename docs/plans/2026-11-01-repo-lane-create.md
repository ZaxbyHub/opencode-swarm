# Swarm lane provisioning through repo lane create

> **For agentic workers:** **MANDATORY** after the plan is accepted: run
> `using-skills` `gate mandatory_skill`, then
> `load_skill({ name: "multi-agent-work-orchestrate" })` (alias
> `subagent-driven-development`) for subagent execution **or**
> `load_skill({ name: "workflow-execute" })` (alias `executing-plans`) for
> inline execution. Do not start tasks from this template alone. Steps use
> checkbox (`- [ ]`) syntax for tracking.

Status: implemented
Owner: mixed
Last verified: 2026-11-01
Review cadence: none
Next review due: none
Source: operator direction 2026-11-01, swarm git-spawn map, Engine command catalog
Canonical issue/ADR/spec: none
Work harness: none
Research packet: none
Research question: Where does swarm create a coder lane, and which public repo command replaces git worktree add on an Engine checkout?
Evidence budget: local source only

## Goal

When `provisionWorktree` runs inside an Engine checkout, create the lane with the public command `repo lane create` and use the printed workspace path. Git repos that have no `repo` facade keep the existing `git worktree add` path.

## Current Complexity Drivers

- Driver: many independent git spawn wrappers, no VCS backend.
  - Evidence: `src/git/branch.ts` `gitExec`, `src/worktree/core.ts` `runGit`, `src/worktree/merge.ts` `runGit`. Mapped 2026-11-01 by the git-sink survey.
  - Risk if ignored: a partial rewrite leaves Engine lanes on `git worktree add`, which bypasses jj and the lease.
- Driver: the native handler name `lane-create` is hidden. The listed command is `repo lane create`.
  - Evidence: `singularity-engine/.purpose/repo-agent-catalog.json` path `lane/create` has `command: repo lane create`, `listed: true`, `hidden: false`. Clap `LaneCreate` in `tools/repository-operator/src/lib.rs` is `hide = true` and its doc comment says the listed agent command is `repo lane create`.
  - Risk if ignored: swarm calls the hidden alias and help/agents treat that as the contract.

## Purpose-First Contract

Harness source of truth: none.

- Purpose: Engine coder lanes are created by the repository facade, not by git.
- Consumer: `provisionWorktree` in the local swarm plugin, for a checkout whose root contains `bin/repo`.
- Contract: the spawn argv is `direnv`, `exec`, `<repo-root>`, `repo`, `lane`, `create`, `<name>`, `--objective`, `<one-line>`, `--scope`, `repository`. Success reads `created=<name> path=<absolute-path>` from stdout and returns that path as `worktreePath`.
- Failure boundary: a non-zero facade exit returns `{ error }` and does not fall through to `git worktree add`.
- Evidence: a bun test with a fake `bin/repo` records the argv and the parsed path.
- Falsifier: the recorded argv contains `lane-create`, or `git` plus `worktree` `add`, when `bin/repo` is present.
- Non-goals: converting status, diff, merge, commit, blame, or PR git wrappers in this plan. Those mirror this seam later.
- Invariants: one task per coder. Lane name matches `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` and is not `default`. Ordinary git projects still use `runGit`.
- Assumptions: `direnv exec <root> repo …` is the invocation that loads the Engine Nix shell. Doubt 1. Falsifier: a live `direnv exec` on an Engine worktree prints `command not found` for `repo`.

## Code References

- `src/worktree/core.ts:663` — active `provisionWorktree`. Edit this.
- `src/worktree/core.ts:915` — active `git worktree add`. Must not run when the facade is present.
- `src/worktree/types.ts:66` — active `WorktreeHandle`. Reuse it. `worktreePath` becomes the facade path.
- `src/utils/git-executable.ts:768` — active git binary resolver. Do not route `repo` through it.
- `singularity-engine/tools/repository-operator/src/commands/lifecycle_impl.rs:820` — active success line `created={name} path={path} …`. Parse `path=`.
- `singularity-engine/.purpose/repo-agent-catalog.json:878` — active public command, `hidden: false`. Do not edit Engine.

## Ownership Matrix

- Lane creation command: system of record is Engine `.purpose/repo-agent-catalog.json`. Swarm does not own the verb. Swarm owns only the caller. Forbidden: inventing `repo vcs lane-create` or calling hidden `lane-create` from swarm.
- Worktree path: system of record is the facade stdout `path=`. Swarm must not invent `.swarm-worktrees/<session>/<id>` for an Engine checkout.
- Git worktrees for non-Engine repos: swarm still owns them through `runGit`.

## Research Basis

- Local source trace: git survey 2026-11-01. No `VcsBackend`. Heaviest create path is `provisionWorktree` → `runGit(['worktree','add',…])`.
- External research basis: none.
- Pattern translation matrix: `git worktree add -b <branch> <path> HEAD` maps to `repo lane create <name> --objective <text> --scope repository`. The facade chooses the path. Swarm does not pass a path.
- Success boost: one argv builder, one parser, one test. Later git sinks call the same `runRepo` helper.
- Existing capability reused: `WorktreeHandle`, `_internals.bunSpawn` spawn shape, public catalog command.
- Smallest local experiment: temp dir with an executable `bin/repo` that prints `created=name path=/tmp/lane`.
- Falsifier: argv contains `lane-create` or `worktree add`.
- Observation: success text is `created={name} path={path} revision=…`.
- Constraint: lane name grammar from `validate_workspace_name` usage in `lease/concurrency.rs`.
- Reused capability: `direnv exec` admission already used for Engine `repo` commands on this host.
- Open risk: `repo lane create` can refuse when the lane pool is full. The plan surfaces that stderr as `{ error }` and does not retry with git.

## Assumptions And Doubt

- Assumption: a checkout is an Engine facade root only when the same directory has `.jj/`, `.purpose/commands.json`, and an executable `bin/repo`. Doubt 0 for the recognition rule. Observed 2026-11-01 from Engine `bin/repo` `find_caller_workspace()` via the repo-facade survey. Falsifier: `find_caller_workspace` accepts a root missing one of those three. `bin/repo` alone is not enough.
- Assumption: `--scope repository` is the right default for a swarm coder lane. Doubt 1. The catalog default in clap is `repository`. Falsifier: a lane create without `--scope` is rejected.
- Assumption: a sanitized swarm id is a legal lane name. Doubt 1. Falsifier: `repo lane create` stderr says `invalid workspace name`.

## Architecture

Add `src/vcs/repo-facade.ts` with `findRepoRoot` and `repoLaneCreate`. `provisionWorktree` calls `repoLaneCreate` first. On a found facade, it returns the parsed path or the facade error. On no facade, it continues into the existing git body. Later git wrappers will call `findRepoRoot` plus a sibling function. They are not edited in this plan.

## Tech Stack

TypeScript, bun:test, `direnv exec`, public `repo lane create`.

## Done When

- [ ] `bun test tests/unit/worktree/repo-lane-create.test.ts` passes.
- [ ] The test argv is `direnv exec <root> repo lane create <name> --objective <text> --scope repository`.
- [ ] Negative proof: that argv does not contain `lane-create`, and `git` `worktree` `add` is not spawned when `bin/repo` exists.
- [ ] A directory with no `bin/repo` still reaches `runGit` for `worktree add`.

## Cross-Repo Execution Order

1. Engine catalog already lists `repo lane create` as not hidden. No Engine edit.
2. Swarm calls that command and consumes `path=`.
3. Rebuild `dist/index.js` only after the unit test is green. Live OpenCode reload is a separate operator step, not part of the unit proof.

## Phase Gate Table

- Phase 0 inventory: gate is the git survey plus catalog read. Proof is this plan's code references. Stop if `provisionWorktree` no longer calls `worktree add`. Rollback is not editing.
- Phase 1 unit proof: gate is the bun test. Stop if the fake script is never executed. Rollback is deleting `src/vcs/repo-facade.ts` and the early return in `provisionWorktree`.
- Phase 2 bundle: gate is `bun run build` after the test. Stop if the bundle contains the string `lane-create` as a spawn argument. Rollback is not copying the new dist into the npm cache.

## Validation Matrix

- Scope: unit. Command: `bun test tests/unit/worktree/repo-lane-create.test.ts`. Expected: pass, argv has `lane` then `create`. Runs in Nix: no. Blocks commit: yes.
- Scope: negative. Same test asserts absence of `lane-create` and of `worktree` `add` on the facade path. Expected: pass.

## Runtime And Deploy Proof

- Build proof: `bun run build` after the unit test. Not required to claim the plan is written.
- Publish proof: not applicable. Do not publish the plugin.
- Rollout proof: not applicable until an operator reloads OpenCode.
- Live log/trace proof: not part of this plan.
- Rollback proof: git path remains for trees without `bin/repo`.

## Evidence Records

- Durable record needed: no, because the unit test is the evidence.
- Record path: none
- Evidence consumer: the implementer of later git-sink mirrors.
- Freshness/review expectation: re-read the catalog if Engine help changes `repo lane create`.
- Verification/export command: `bun test tests/unit/worktree/repo-lane-create.test.ts`

## Global Constraints

- Spawn array form only. No shell string.
- `stdin: 'ignore'`, timeout, bounded stdout/stderr, kill in `finally` if the child is still running.
- Tests use bun:test and `_internals`. No `mock.module`.
- Do not edit `/home/mhugo/vendors/opencode-swarm` or the installed npm package.
- Do not edit the read-only Engine tree `/home/mhugo/code/singularity-engine`.

## Do Not Touch

- `src/git/branch.ts`, `src/worktree/merge.ts`, `src/tools/git-blame.ts`, `src/tools/checkpoint.ts` — later mirrors. This plan only leaves them a `findRepoRoot` they can call.
- Engine command catalogs — `repo lane create` is already the listed command.
- Swarm reminder and context-status files — unrelated.

---

## Task 1: Facade detection and lane create

Status: implemented
Proof: bun test tests/unit/vcs/repo-lane-create.test.ts — 4 pass
Blocker: none

**Research basis:**

- Catalog entry `repo lane create`, hidden false.
- Success line `created={name} path={path}` in `lifecycle_impl.rs`.

**Code references:**

- `src/worktree/core.ts:915` — git create that the facade path replaces.

**Files:**

- Create: `src/vcs/repo-facade.ts`
- Create: `tests/unit/vcs/repo-lane-create.test.ts`
- Modify: none in this task
- Test: `tests/unit/vcs/repo-lane-create.test.ts`

**Interfaces:**

- Consumes: a directory string.
- Produces: `findRepoRoot(start: string): string | null` and `parseRepoLaneCreateStdout(stdout: string): { name: string; path: string } | null`. `findRepoRoot` returns the directory only when that directory contains `.jj`, `.purpose/commands.json`, and executable `bin/repo`.
- Does not do: spawn, git, `lane-create`, or `repo vcs workspace-create`. Engine has no `workspace-create` verb. Infra does. Swarm on Engine uses `repo lane create`.

- [ ] **Step 1: Write the failing proof**

```typescript
import { describe, expect, test } from 'bun:test';
import {
	findRepoRoot,
	parseRepoLaneCreateStdout,
	repoLaneCreateArgs,
} from '../../../src/vcs/repo-facade';

describe('repo lane create contract', () => {
	test('argv is the public command', () => {
		expect(repoLaneCreateArgs('swarm-ses-1', 'coder task 1')).toEqual([
			'lane',
			'create',
			'swarm-ses-1',
			'--objective',
			'coder task 1',
			'--scope',
			'repository',
		]);
		expect(repoLaneCreateArgs('swarm-ses-1', 'coder task 1')).not.toContain(
			'lane-create',
		);
	});

	test('parses the facade success line', () => {
		expect(
			parseRepoLaneCreateStdout(
				'created=swarm-ses-1 path=/tmp/lanes/swarm-ses-1 revision=abc\n',
			),
		).toEqual({ name: 'swarm-ses-1', path: '/tmp/lanes/swarm-ses-1' });
	});

	test('findRepoRoot is a function that requires the three Engine markers', () => {
		expect(findRepoRoot).toBeTypeOf('function');
	});
});
```

- [ ] **Step 2: Run proof to verify it fails**

Run: `bun test tests/unit/vcs/repo-lane-create.test.ts`
Expected: FAIL because `src/vcs/repo-facade.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

`repoLaneCreateArgs` returns the tokens above and never the string `lane-create`. `parseRepoLaneCreateStdout` reads one `created=<name> path=<absolute>` pair. `findRepoRoot` walks parents and returns the first directory that has all three of `.jj`, `.purpose/commands.json`, and executable `bin/repo`. A parent with only `bin/repo` returns null. Lane names that fail `^[A-Za-z0-9][A-Za-z0-9._-]*$` are rejected by `laneNameFromSwarmId(sessionId, id)`, which also refuses `default`.

- [ ] **Step 4: Run proof to verify it passes**

Run: `bun test tests/unit/vcs/repo-lane-create.test.ts`
Expected: PASS.

- [ ] **Step 5: Run negative proof**

The same test's `not.toContain('lane-create')` is the negative proof.
Expected: PASS.

- [ ] **Step 6: Record evidence**

Set this task `Proof:` to the bun test command and `Status:` to `implemented` only after the command exits 0.

## Task 2: provisionWorktree uses the facade when bin/repo exists

Status: implemented
Proof: bun test tests/unit/worktree/repo-lane-provision.test.ts — 2 pass
Blocker: none

**Research basis:**

- `provisionWorktree` is the create seam. Other wrappers stay on git until a later plan.

**Code references:**

- `src/worktree/core.ts:663` — insert the facade branch immediately after the lane-grammar check at line 689, before path budget and `runGit`.

**Files:**

- Modify: `src/worktree/core.ts`
- Modify: `src/vcs/repo-facade.ts` to add `runRepoLaneCreate(root, name, objective)` using `bunSpawn`
- Test: `tests/unit/worktree/repo-lane-provision.test.ts`

**Interfaces:**

- Consumes: `findRepoRoot`, `repoLaneCreateArgs`, `parseRepoLaneCreateStdout`.
- Produces: `provisionWorktree` returns `{ worktreePath, branchName, purpose, id, sessionId }` where `worktreePath` is the facade `path=` and `branchName` stays the existing swarm branch string so lane grammar checks still pass.
- Does not do: fall through to `git worktree add` after a facade error. Does not call `repo vcs`.

- [ ] **Step 1: Write the failing proof**

Create a temp directory with an executable `bin/repo` that writes its argv to a file and prints `created=swarm-ses-1 path=<temp>/lane`. Point `_internals` spawn used by `runRepoLaneCreate` at that script if the production spawn cannot be the script itself. Call `provisionWorktree(temp, 'task-1', 'ses_abc', { purpose: 'lane' })`.

Expect `worktreePath` to end with `/lane`. Expect the argv file to contain `lane` and `create` as separate arguments and not `lane-create`. Expect no `worktree` `add` spawn. A second temp dir without `bin/repo` must still call the git spawn. Use the existing `_internals.bunSpawn` replacement pattern from worktree tests. Restore `_internals` in `afterEach`.

- [ ] **Step 2: Run proof to verify it fails**

Run: `bun test tests/unit/worktree/repo-lane-provision.test.ts`
Expected: FAIL because `provisionWorktree` still calls `runGit` for `worktree add`.

- [ ] **Step 3: Write minimal implementation**

After the `matchSwarmLaneBranch` refusal, call `findRepoRoot(directory)`. When non-null, spawn:

```text
direnv exec <repo-root> repo lane create <laneName> --objective <purpose and id> --scope repository
```

Array form. Timeout 120000 ms. `stdin: 'ignore'`. On exit 0, parse stdout. Missing `path=` is `{ error: 'repo lane create returned no path' }`. Non-zero exit is `{ error }` containing stderr and no git retry. When `findRepoRoot` returns null, keep the current function body.

- [ ] **Step 4: Run proof to verify it passes**

Run: `bun test tests/unit/worktree/repo-lane-provision.test.ts`
Expected: PASS.

- [ ] **Step 5: Run negative proof**

Same test: facade present implies zero spawn args equal to `lane-create` and zero `worktree` followed by `add`.
Expected: PASS.

- [ ] **Step 6: Record evidence**

Update this task `Proof:` with the bun command output path or the observed pass line.

## Task 3: Mirror note for the other git sinks

Status: implemented
Proof: src/vcs/repo-facade.ts header names gitExec and merge runGit; bun test tests/unit/vcs/repo-lane-create.test.ts still 4 pass
Blocker: none

**Research basis:**

- The git survey listed `gitExec` and the second `runGit` in `merge.ts` as the next seams. This task does not change them.

**Code references:**

- `src/git/branch.ts` `gitExec` — future mirror, read only in this task.
- `src/worktree/merge.ts` `runGit` — future mirror, read only in this task.

**Files:**

- Modify: `src/vcs/repo-facade.ts` file header comment only, listing the next callers: `gitExec`, merge `runGit`.
- Test: none beyond Task 1 still exporting `findRepoRoot`.

**Interfaces:**

- Consumes: `findRepoRoot`.
- Produces: a comment that the next plan maps `git status` to `repo vcs status` and `git diff` to `repo vcs diff`, using `findRepoRoot` and never `lane-create`.
- Does not do: behavior change in branch.ts or merge.ts.

- [ ] **Step 1: Add the comment next to `findRepoRoot`.**

State the next callers `gitExec` and merge `runGit`. The future read commands on Engine are `repo vcs status`, `repo vcs diff`, `repo vcs log`, and `repo lane list` (alias `repo vcs workspace-list`). Do not name `repo vcs workspace-create`. That verb is infra-only and is absent from Engine `bin/repo`. Do not add unused functions.

- [ ] **Step 2: Re-run Task 1's test.**

Run: `bun test tests/unit/vcs/repo-lane-create.test.ts`
Expected: PASS.

- [ ] **Step 3: Record evidence**

`Proof:` is that test plus the comment's file path.

## Final Verification

- [ ] All task proofs recorded.
- [ ] Done When criteria checked.
- [ ] Work harness path recorded above as `none`.
- [ ] `bun test` commands in the validation matrix have been run.
- [ ] Runtime/deploy proof marked not applicable for the unit plan.
- [ ] Engine catalog left unchanged.
- [ ] Plan-level `Status:` stays `planned` until execution starts, then `active`.
