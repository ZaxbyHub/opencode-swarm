/**
 * attest-task boundary tests split out of attest-task.test.ts for the FR-006
 * 500-line cap (issue #3432 review fix batch): the DI-seam spawn properties
 * (producer prefix, mid-run plan-change refusal) and the attest→completion
 * declaration-digest staleness window. Grammar, refusals, and the positive
 * control stay in attest-task.test.ts.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as attestInternals,
	executeAttestTask,
} from '../../../src/tools/attest-task.js';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status.js';
import { resolveGitExecutable } from '../../../src/utils/git-executable.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TASK_ID = '1.1';
const PLAN_TITLE = 'Attest fixture plan';
const PLAN_SWARM = 'attest-fixture';

interface FixtureAnchor {
	command: string;
	expect?: string;
	expect_prefix?: string;
}

/** Minimal PlanSchema-valid `.swarm/plan.json` with one task (id 1.1). */
function writePlan(
	dir: string,
	options: {
		evidenceClass?: 'external_git';
		anchors?: FixtureAnchor[];
	} = {},
): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	const task: Record<string, unknown> = {
		id: TASK_ID,
		phase: 1,
		description: 'Git-external deliverable (commit/push)',
		// 'coder' keeps the reviewer/council precheck off the completion path so
		// digest-mismatch refusals surface from the completion transaction.
		...(options.evidenceClass ? { evidence_class: options.evidenceClass } : {}),
		...(options.anchors ? { evidence_anchors: options.anchors } : {}),
	};
	const plan = {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				required_agents: ['coder'],
				tasks: [task],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, '\t'),
	);
}

const tempDirs: string[] = [];

/** Non-git fixture: `.git` directory marker so assertProjectRoot accepts it. */
function plainFixture(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	tempDirs.push(dir);
	return dir;
}

/** Hermetic child env for git fixtures: whitelist only what git needs. */
function fixtureGitEnv(): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '',
		GIT_CONFIG_NOSYSTEM: '1',
	};
	for (const key of ['HOME', 'LANG'] as const) {
		if (process.env[key]) env[key] = process.env[key] as string;
	}
	if (process.platform === 'win32') {
		for (const key of [
			'SYSTEMROOT',
			'WINDIR',
			'COMSPEC',
			'USERPROFILE',
			'HOMEDRIVE',
			'HOMEPATH',
			'APPDATA',
			'LOCALAPPDATA',
			'PROGRAMFILES',
		] as const) {
			if (process.env[key]) env[key] = process.env[key] as string;
		}
	}
	return env;
}

function git(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
		env: fixtureGitEnv(),
	}).trim();
}

/** REAL git fixture: initialized repo, identity configured, exactly one commit. */
function gitFixture(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	git(dir, ['init', '-q']);
	git(dir, ['config', 'user.email', 'attest@example.com']);
	git(dir, ['config', 'user.name', 'Attest Fixture']);
	git(dir, ['config', 'core.autocrlf', 'false']);
	fs.writeFileSync(path.join(dir, 'delivered.txt'), 'deliverable\n');
	git(dir, ['add', 'delivered.txt']);
	git(dir, ['commit', '-q', '-m', 'deliver']);
	tempDirs.push(dir);
	return dir;
}

function evidencePath(dir: string): string {
	return path.join(dir, '.swarm', 'evidence', `${TASK_ID}.json`);
}

// The DI seam is reassigned per-test and restored in afterEach — no mock.module
// (AGENTS.md invariant 7).
const originalRunAnchor = attestInternals.runAnchor;
const originalLoadPlanTask = attestInternals.loadPlanTask;

afterEach(() => {
	attestInternals.runAnchor = originalRunAnchor;
	attestInternals.loadPlanTask = originalLoadPlanTask;
});

afterAll(() => {
	for (const dir of tempDirs) safeRmRecursive(dir);
});

describe('executeAttestTask — spawn properties via the DI seam', () => {
	test('argv is git binary + producer prefix + subcommand (no duplicated git token); cwd is the project root', async () => {
		const dir = plainFixture('attest-spawn-props-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD', expect: '1' }],
		});
		const captured: Array<{
			argv: string[];
			cwd: string;
			timeoutMs: number;
		}> = [];
		attestInternals.runAnchor = async (argv, cwd, timeoutMs) => {
			captured.push({ argv, cwd, timeoutMs });
			return { exitCode: 0, stdout: '1\n', refusal: null };
		};
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(true);
		expect(captured.length).toBe(1);
		const { argv, cwd, timeoutMs } = captured[0] as {
			argv: string[];
			cwd: string;
			timeoutMs: number;
		};
		const [gitBinary, ...rest] = argv;
		expect(gitBinary).toBe(resolveGitExecutable());
		// Producer's own safety prefix (plan §7; extended for issue #3432
		// review PRR-001): the grammar lets no anchor token reach this
		// position, so hostile globals (fsmonitor, gpg/credential helpers)
		// cannot be injected.
		expect(rest.slice(0, 11)).toEqual([
			'--no-pager',
			'-c',
			'diff.external=',
			'-c',
			'core.pager=cat',
			'-c',
			'core.fsmonitor=',
			'-c',
			'gpg.program=',
			'-c',
			'credential.helper=',
		]);
		// The anchor's leading `git` token is stripped: the next token is the
		// subcommand itself, never a duplicated 'git'.
		expect(rest[11]).toBe('rev-list');
		expect(argv.filter((token) => token === 'git').length).toBe(
			gitBinary === 'git' ? 1 : 0,
		);
		expect(cwd).toBe(dir);
		expect(timeoutMs).toBeGreaterThan(0);
		expect(timeoutMs).toBeLessThanOrEqual(10_000);
		// NOTE: env scrubbing, stdin-ignore, stream byte bounds, timeout, and
		// kill-in-finally live in bunSpawn (src/utils/bun-compat.ts) and its
		// call site — intentionally NOT re-tested here.
	});

	test('a plan edit landing mid-run refuses instead of publishing a stale bundle (PRR-003)', async () => {
		const dir = plainFixture('attest-midrun-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD', expect: '1' }],
		});
		attestInternals.runAnchor = async () => ({
			exitCode: 0,
			stdout: '1\n',
			refusal: null,
		});
		// The SECOND loadPlanTask call (the post-run freshness reload)
		// observes a renamed plan — the identity the anchor set was verified
		// against no longer exists. The first call still returns the real
		// plan so the pre-run gate passes.
		let loadCalls = 0;
		attestInternals.loadPlanTask = (d: string, t: string) => {
			loadCalls++;
			const found = originalLoadPlanTask(d, t);
			if (loadCalls >= 2 && found) {
				return { ...found, title: 'renamed mid-run' };
			}
			return found;
		};
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'the plan changed while anchors were running',
		);
		// Refusal happens before publication: no evidence bundle is written.
		expect(fs.existsSync(evidencePath(dir))).toBe(false);
	});
});

describe('executeAttestTask + completion — declaration-digest staleness (plan §3/§4c)', () => {
	test('editing the plan anchors after attest makes completion refuse until a fresh attest', async () => {
		const dir = gitFixture('attest-stale-digest-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD', expect: '1' }],
		});
		const attest = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(attest.success).toBe(true);

		// Re-plan: the same task now declares different anchors (B). The
		// recorded bundle still pins digest(A), so the recomputed digest no
		// longer matches the CURRENT declaration.
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [
				{
					command: 'git rev-list --count HEAD',
					expect: '1',
					expect_prefix: '1',
				},
			],
		});
		const completion = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: dir },
			dir,
		);
		expect(completion.success).toBe(false);
		expect(completion.errors?.[0]).toContain('TASK_COMPLETION_CAS_MISMATCH');
		expect(completion.errors?.[0]).toContain('no current matched attestation');
		expect(completion.errors?.[0]).toContain(`/swarm attest ${TASK_ID}`);
	});
});
