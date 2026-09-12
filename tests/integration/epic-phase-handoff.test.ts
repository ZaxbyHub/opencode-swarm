/**
 * End-to-end integration test for the greenfield-smart parallelization
 * protocol.
 *
 * The adversarial review on 2026-06-03 flagged that the unit tests cover
 * each layer in isolation but never exercise the full handoff:
 *
 *   updateTaskStatus  →  commitTaskCompletion  →  real git commit
 *                                                 ↓
 *                                          formatTaskCommitMessage
 *                                                 ↓
 *                                          SWARM_TASK_SUBJECT_RE
 *                                                 ↓
 *                                          buildIsUpstreamCommitted
 *                                                 ↓
 *                                          planLeanTurboLanes
 *
 * If any contract between modules drifts (commit-message format change,
 * regex tightening, predicate signature, planner argument order), the
 * unit tests would still pass but the real protocol would silently
 * regress to the pre-Phase-6 "every cross-batch dep is implicitly
 * satisfied" behavior. This file is the round-trip backstop.
 *
 * Uses real git via child_process.spawnSync — no mocks, no DI seams.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { savePlan, updateTaskStatus } from '../../src/plan/manager';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { executeEpicPlanWaves } from '../../src/tools/epic-plan-waves';
import { executeEpicDecidePhase } from '../../src/tools/epic-run-phase';
import { enableEpicMode } from '../../src/turbo/epic/state';

function git(args: string[], cwd: string): { status: number; stdout: string } {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
	return { status: result.status ?? -1, stdout: result.stdout ?? '' };
}

function initGitRepo(dir: string): void {
	expect(git(['init', '-b', 'main'], dir).status).toBe(0);
	expect(git(['config', 'user.email', 'test@example.com'], dir).status).toBe(0);
	expect(git(['config', 'user.name', 'Test User'], dir).status).toBe(0);
	// Prevent GPG signing from blocking tests in environments where the
	// user's global ~/.gitconfig sets commit.gpgsign = true.
	expect(git(['config', 'commit.gpgsign', 'false'], dir).status).toBe(0);
	// Seed an initial commit so HEAD exists.
	fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
	expect(git(['add', 'README.md'], dir).status).toBe(0);
	expect(git(['commit', '-m', 'initial'], dir).status).toBe(0);
}

function makePlanWithCrossBatchDep(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Phase Handoff Integration',
		swarm: 'integration',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'set up package structure',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'implement thing depending on 1.1',
						depends: ['1.1'],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

function writeScopeFile(dir: string, taskId: string, files: string[]): void {
	const scopesDir = path.join(dir, '.swarm', 'scopes');
	fs.mkdirSync(scopesDir, { recursive: true });
	fs.writeFileSync(
		path.join(scopesDir, `scope-${taskId}.json`),
		JSON.stringify({
			taskId,
			files,
			declaredAt: '2026-06-03T00:00:00.000Z',
		}),
	);
}

/**
 * #2532 (PARALLEL-4): Rule 2's scope-bounded staging resolves the completing
 * task's scope from the authoritative v2 binding store (what `declare_scope`
 * writes), never from the legacy v1 `.swarm/scopes/scope-<id>.json`
 * projection. Declare through the registered tool so the completion commit
 * stages the declared files.
 */
async function declareScope(
	dir: string,
	taskId: string,
	files: string[],
): Promise<void> {
	const declared = await executeDeclareScope(
		{ taskId, files, working_directory: dir },
		dir,
		{ sessionID: 'epic-handoff-architect', messageID: `m-${taskId}` },
	);
	if (!declared.success) {
		throw new Error(`declare_scope failed for ${taskId}: ${declared.message}`);
	}
}

describe('Epic Mode end-to-end handoff — Rule 2 commit → Rule 3 predicate → planner', () => {
	let dir: string;

	beforeEach(async () => {
		// Do NOT use `realpathSync` here: on macOS it resolves
		// `/tmp/...` to `/private/tmp/...`, and the substring `private`
		// triggers the lean planner's protected-path detection
		// (see `src/turbo/lean/conflicts.ts:DEFAULT_PROTECTED_PATTERNS`)
		// which would degrade Phase 2 tasks unrelated to Rule 3.
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-handoff-'));
		initGitRepo(dir);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await savePlan(dir, makePlanWithCrossBatchDep());
		// Toggle Epic Mode for the project. The session id is irrelevant
		// because `isEpicModeActiveForProject` (the gate inside
		// plan/manager) only checks "any session active in this project".
		enableEpicMode(dir, 'test-session');
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	});

	test('completing task 1.1 produces a real swarm(task 1.1) commit; Phase 2 sees 2.1 as parallel-eligible', async () => {
		// Declare the scope and create the actual file so the
		// scope-bounded staging in Phase 4 has something to stage.
		const srcFile = path.join(dir, 'src', 'foo.ts');
		fs.mkdirSync(path.dirname(srcFile), { recursive: true });
		fs.writeFileSync(srcFile, 'export const FOO = 1;\n');
		await declareScope(dir, '1.1', ['src/foo.ts']);

		// Drive the centralized Rule 2 hook by completing the task
		// through the same plan/manager entry the real
		// `update_task_status` tool uses.
		await updateTaskStatus(dir, '1.1', 'completed');

		// Assert: git log has the marker subject in the exact format
		// `formatTaskCommitMessage` produces.
		const log = git(['log', '--pretty=%s'], dir).stdout;
		expect(log).toMatch(/^swarm\(task 1\.1\):/m);

		// And the staged file landed in the commit (proves scope-bounded
		// staging actually stages the file).
		const showLog = git(['log', '-1', '--name-only', '--pretty='], dir).stdout;
		expect(showLog).toContain('src/foo.ts');

		// Now plan Phase 2 via Epic's wave planner (the tool that owns
		// Rule 3 — `lean_turbo_plan_lanes` is the maintainer's tool and
		// deliberately carries NO Rule-3 predicate). Rule 3's predicate
		// should see 1.1 in git history → 2.1 lands in a wave.
		const result = await executeEpicPlanWaves({
			directory: dir,
			phase: 2,
			scopes: { '2.1': ['src/bar.ts'] },
		});
		expect(result.success).toBe(true);
		expect(result.degradedTasks ?? []).toEqual([]);
		expect((result.waves ?? []).length).toBeGreaterThan(0);
		// 2.1 must be in a wave.
		const allWaveTasks = (result.waves ?? []).flatMap((w) => w.taskIds);
		expect(allWaveTasks).toContain('2.1');
	});

	test('without a scope file: completing 1.1 produces a marker-only commit, no working-tree contamination', async () => {
		// Create some unrelated working-tree changes (simulates sibling
		// lanes' WIP that an earlier `git add -A` would have swept in).
		const wipFile = path.join(dir, 'src', 'other-lane-wip.ts');
		fs.mkdirSync(path.dirname(wipFile), { recursive: true });
		fs.writeFileSync(wipFile, 'export const WIP = "do not commit me";\n');

		const commitCountBefore = parseInt(
			git(['rev-list', '--count', 'HEAD'], dir).stdout.trim(),
			10,
		);

		// No scope file declared for 1.1.
		await updateTaskStatus(dir, '1.1', 'completed');

		// The swarm(task 1.1) commit exists.
		expect(git(['log', '--pretty=%s'], dir).stdout).toMatch(
			/^swarm\(task 1\.1\):/m,
		);
		// And it contains NO files (marker-only). The sibling lane's
		// WIP is NOT in git history — this is the headline fix from
		// the 2026-06-03 adversarial review.
		const showLog = git(['log', '-1', '--name-only', '--pretty='], dir).stdout;
		expect(showLog).not.toContain('other-lane-wip.ts');
		// Phase 9 strengthening: prove the commit is GENUINELY empty,
		// not just "WIP file absent from the listing". `diff-tree` against
		// HEAD reports every path changed in the tip commit; for an
		// `--allow-empty` marker the answer must be no paths at all.
		const diffTree = git(
			['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'],
			dir,
		).stdout.trim();
		expect(diffTree).toBe('');
		// And the head advanced by exactly one commit — proving a
		// commit DID happen (not a false positive where the empty diff
		// is just HEAD never moving).
		const commitCountAfter = parseInt(
			git(['rev-list', '--count', 'HEAD'], dir).stdout.trim(),
			10,
		);
		expect(commitCountAfter).toBe(commitCountBefore + 1);
		// The wip file is still in the working tree (we didn't lose it),
		// just untracked.
		expect(fs.existsSync(wipFile)).toBe(true);
		const status = git(
			['status', '--porcelain', 'src/other-lane-wip.ts'],
			dir,
		).stdout;
		expect(status).toMatch(/^\?\? /);
	});

	test('Phase 8 idempotency: re-completing 1.1 produces only ONE marker commit, not two', async () => {
		// No declaration: the completion is marker-only either way, which is
		// exactly what the idempotency guard is exercised against (#2532: the
		// legacy empty v1 scope file is no longer a scope source).
		await updateTaskStatus(dir, '1.1', 'completed');
		const after1 = parseInt(
			git(['rev-list', '--count', 'HEAD'], dir).stdout.trim(),
			10,
		);

		// Second completion call — the idempotency guard must skip the
		// second marker.
		await updateTaskStatus(dir, '1.1', 'completed');
		const after2 = parseInt(
			git(['rev-list', '--count', 'HEAD'], dir).stdout.trim(),
			10,
		);

		expect(after2).toBe(after1);
		// And only ONE `swarm(task 1.1):` subject exists.
		const swarmSubjects = git(['log', '--pretty=%s'], dir)
			.stdout.split('\n')
			.filter((s) => /^swarm\(task 1\.1\):/.test(s));
		expect(swarmSubjects).toHaveLength(1);
	});

	test('Phase 8 nested .swarm/ exclusion: a scope path pointing into a monorepo subtree does NOT leak its nested .swarm contents', async () => {
		// Simulate a monorepo: `packages/foo/` contains both real source
		// AND a nested `.swarm/` (the swarm package's own state when
		// opencode-swarm is dog-fed inside a monorepo). The previous
		// pathspec `:(exclude).swarm` only matched the repo root, so
		// completing a task scoped to `packages/foo/` would commit
		// `packages/foo/.swarm/leak.json`.
		fs.mkdirSync(path.join(dir, 'packages', 'foo', '.swarm'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, 'packages', 'foo', '.swarm', 'leak.json'),
			'{"sensitive":"do not commit"}',
		);
		fs.writeFileSync(
			path.join(dir, 'packages', 'foo', 'index.ts'),
			'export const FOO = 1;\n',
		);
		await declareScope(dir, '1.1', ['packages/foo']);

		await updateTaskStatus(dir, '1.1', 'completed');

		const committedFiles = git(
			['log', '-1', '--name-only', '--pretty='],
			dir,
		).stdout;
		// The real source file lands.
		expect(committedFiles).toContain('packages/foo/index.ts');
		// The nested .swarm content does NOT.
		expect(committedFiles).not.toContain('packages/foo/.swarm');
		expect(committedFiles).not.toContain('leak.json');
	});

	test('Phase 8 no-side-effect: non-Epic projects do NOT have .swarm/epic-state.json seeded by update_task_status', async () => {
		// Fresh dir, fresh git repo, NO enableEpicMode call.
		const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-no-seed-'));
		try {
			initGitRepo(freshDir);
			fs.mkdirSync(path.join(freshDir, '.swarm'), { recursive: true });
			await savePlan(freshDir, makePlanWithCrossBatchDep());
			// .swarm/epic-state.json must NOT exist before.
			expect(
				fs.existsSync(path.join(freshDir, '.swarm', 'epic-state.json')),
			).toBe(false);

			await updateTaskStatus(freshDir, '1.1', 'completed');

			// Phase 8 contract: still must NOT exist after. The previous
			// implementation called `readPersisted` which seeded an empty
			// file even on the non-Epic completion path.
			expect(
				fs.existsSync(path.join(freshDir, '.swarm', 'epic-state.json')),
			).toBe(false);
			// And no commit was produced, because Epic isn't on for this
			// project — Rule 2 must be skipped entirely.
			const swarmSubjects = git(['log', '--pretty=%s'], freshDir)
				.stdout.split('\n')
				.filter((s) => /^swarm\(task /.test(s));
			expect(swarmSubjects).toHaveLength(0);
		} finally {
			fs.rmSync(freshDir, { recursive: true, force: true });
		}
	});

	test('Rule 3 blocks Phase 2 when 1.1 is NOT yet committed (predicate returns false)', async () => {
		// Don't complete 1.1. Plan phase 2 via Epic's wave planner (the
		// tool that owns Rule 3). The predicate looks at git log, finds no
		// swarm(task 1.1) marker, returns false, the planner degrades 2.1.
		const result = await executeEpicPlanWaves({
			directory: dir,
			phase: 2,
			scopes: { '2.1': ['src/bar.ts'] },
		});
		expect(result.success).toBe(true);
		const degraded = (result.degradedTasks ?? []).map(
			(d: { taskId: string }) => d.taskId,
		);
		expect(degraded).toContain('2.1');
	});

	test('AGENTS.md #4: .swarm/ contents never enter git history across multiple completions', async () => {
		// Write evidence-like files into .swarm/ to simulate the kind of
		// noise that lives there normally (prompts, ledgers, telemetry).
		fs.writeFileSync(
			path.join(dir, '.swarm', 'evidence.txt'),
			'sensitive telemetry',
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'prompt.md'),
			'do not commit this',
		);

		// Declare scope + create file for 1.1.
		const srcFile = path.join(dir, 'src', 'foo.ts');
		fs.mkdirSync(path.dirname(srcFile), { recursive: true });
		fs.writeFileSync(srcFile, 'export const FOO = 1;\n');
		await declareScope(dir, '1.1', ['src/foo.ts']);

		await updateTaskStatus(dir, '1.1', 'completed');

		// Now inspect all commits ever made on this branch.
		const allFiles = git(
			['log', '--pretty=', '--name-only', '--all'],
			dir,
		).stdout;
		// AGENTS.md #4: nothing under `.swarm/` ever gets into git.
		expect(allFiles).not.toMatch(/^\.swarm\b/m);
		expect(allFiles).not.toContain('evidence.txt');
		expect(allFiles).not.toContain('prompt.md');
	});

	test('the swarm commit subject matches the SWARM_TASK_SUBJECT_RE regex exactly (contract round-trip)', async () => {
		// No declaration → marker-only commit; the subject format is what this
		// round-trip pins (#2532: the empty v1 scope file is no longer a source).
		await updateTaskStatus(dir, '1.1', 'completed');

		const subjects = git(['log', '--pretty=%s'], dir)
			.stdout.split('\n')
			.filter((s) => s.startsWith('swarm('));
		expect(subjects.length).toBe(1);

		// Re-implement the regex inline so this test catches a divergence
		// between `formatTaskCommitMessage` and `SWARM_TASK_SUBJECT_RE`
		// without one importing the other (the whole point of an
		// integration backstop).
		const SUBJECT_RE = /^swarm\(task ([^)]+)\):/;
		const match = SUBJECT_RE.exec(subjects[0]);
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe('1.1');
	});

	test('Phase 10 end-to-end: small project, 1 commit observed, Phase 1 dep committed → Phase 2 PROMOTES (the user-reported bug)', async () => {
		// The legacy `commitsObserved >= 20` floor would have demoted
		// every phase of this project forever. Phase 10 instead checks
		// that the cross-phase upstream (1.1) is in git. After Rule 2
		// commits 1.1 via update_task_status, executeEpicDecidePhase
		// for phase 2 must promote.
		writeScopeFile(dir, '1.1', []);
		writeScopeFile(dir, '2.1', ['src/thing.ts']); // preflight needs this
		await updateTaskStatus(dir, '1.1', 'completed');

		// At this point: 1 swarm commit observed (well under any
		// historical floor), 1.1 marker in git history.
		const verdict = await executeEpicDecidePhase({
			directory: dir,
			phase: 2,
			sessionID: 'test-session',
		});

		// Verdict shape: { success, verdict: { decision, rationale, ... } }
		expect(verdict.success).toBe(true);
		expect(verdict.verdict?.decision).toBe('promote');
		const greenfield = verdict.verdict?.rationale.greenfieldCheck;
		expect(greenfield?.passed).toBe(true);
		// Cross-phase upstreams for Phase 2 = { 1.1 } per the plan (2.1
		// depends on 1.1, declared in makePlanWithCrossBatchDep). The
		// predicate reports 1.1 as committed → missingUpstreams is empty.
		expect(greenfield?.crossPhaseUpstreams).toEqual(['1.1']);
		expect(greenfield?.missingUpstreams).toEqual([]);
	});

	test('Phase 10 negative: small project, Phase 1 NOT committed → Phase 2 DEMOTES with named missing upstream', async () => {
		// Symmetric to the above. Without Rule 2 firing, the predicate
		// reports 1.1 missing → predecessor evidence fails → demote.
		// The blocking reason must name 1.1 specifically so the architect
		// knows what to do to unblock.
		writeScopeFile(dir, '2.1', ['src/thing.ts']); // preflight needs this
		const verdict = await executeEpicDecidePhase({
			directory: dir,
			phase: 2,
			sessionID: 'test-session',
		});

		expect(verdict.success).toBe(true);
		expect(verdict.verdict?.decision).toBe('demote');
		const greenfield = verdict.verdict?.rationale.greenfieldCheck;
		expect(greenfield?.passed).toBe(false);
		expect(greenfield?.missingUpstreams).toEqual(['1.1']);
		const reason = verdict.verdict?.blockingReasons.find((r) =>
			r.includes('predecessor evidence'),
		);
		expect(reason).toContain('1.1');
	});
});
