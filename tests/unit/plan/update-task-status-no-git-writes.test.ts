/**
 * Epic v2 C3 (MINOR 9) — `update_task_status` performs no git WRITE under
 * any configuration. Epic Rule 2 (a commit at task completion) is gone: an
 * epic task's work is committed when its worktree lands and non-coder
 * writes are residue commits, so the completion funnel (`updateTaskStatus`)
 * only reads git (the #2582 auto-checkpoint reads HEAD).
 *
 * Every git spawn of the funnel goes through `src/git/branch.ts` or the
 * auto-checkpoint's spawn seam; both are wrapped to record argv, and the
 * repository (HEAD, every ref, the index) is compared before/after.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { _internals as gitBranchInternals } from '../../../src/git/branch';
import { _internals as checkpointInternals } from '../../../src/plan/auto-checkpoint';
import { savePlan, updateTaskStatus } from '../../../src/plan/manager';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const WRITE_SUBCOMMANDS = new Set([
	'add',
	'branch',
	'checkout',
	'cherry-pick',
	'commit',
	'merge',
	'mv',
	'rebase',
	'reset',
	'rm',
	'stash',
	'switch',
	'tag',
	'update-ref',
	'worktree',
]);
const realBranchSpawn = gitBranchInternals.spawnSync;
const realCheckpointSpawn = checkpointInternals.spawnSync;
let dir: string;
let isolatedEnv: { cleanup: () => void } | undefined;
let argvs: string[][];

function git(args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function snapshot(): string {
	return [
		git(['rev-parse', 'HEAD']),
		git(['for-each-ref']),
		git(['diff', '--cached', '--name-only']),
		git(['status', '--porcelain=v1', '--untracked-files=all']),
	].join('\n--\n');
}

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'No Git Writes',
		swarm: 'no-writes',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'P1',
				status: 'pending',
				tasks: ['1.1', '1.2'].map((id) => ({
					id,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `task ${id}`,
					depends: [],
					files_touched: [`src/${id}.ts`],
				})),
			},
		],
	};
}

function subcommandOf(argv: readonly string[]): string {
	let i = 0;
	while (i < argv.length && (argv[i] === '-c' || argv[i] === '-C')) i += 2;
	return argv[i] ?? '';
}

async function setup(config: Record<string, unknown>): Promise<void> {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
	);
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n.opencode/\n');
	git(['add', '.gitignore']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, plan());
	// A coder's uncommitted output in the main tree must stay uncommitted.
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src', '1.1.ts'), 'export {};\n');
}

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	dir = canonicalMkdtemp('no-git-writes-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	argvs = [];
	gitBranchInternals.spawnSync = ((
		cmd: string,
		args: string[],
		opts: never,
	) => {
		argvs.push(args);
		return realBranchSpawn(cmd, args, opts);
	}) as typeof realBranchSpawn;
	checkpointInternals.spawnSync = ((
		cmd: string,
		args: string[],
		opts: never,
	) => {
		argvs.push(args);
		return realCheckpointSpawn(cmd, args, opts);
	}) as typeof realCheckpointSpawn;
});

afterEach(() => {
	gitBranchInternals.spawnSync = realBranchSpawn;
	checkpointInternals.spawnSync = realCheckpointSpawn;
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

const EPIC = {
	epic: { mode: { enabled: true } },
};

describe('update_task_status performs no git write', () => {
	test.each([
		['no Epic config', {}, false],
		['Epic enabled, no epic open', EPIC, false],
		['Epic open (current-branch)', EPIC, true],
		[
			'Epic open + auto-checkpoint every task',
			{ ...EPIC, checkpoint: { enabled: true, auto_checkpoint_threshold: 1 } },
			true,
		],
		[
			'Epic open + Turbo / Lean config',
			{
				turbo_mode: true,
				turbo: {
					strategy: 'lean',
					lean: {},
					epic: { mode: { enabled: true }, commit_policy: 'epic-branch' },
				},
			},
			true,
		],
	] as const)('%s', async (_label, config, openEpic) => {
		await setup(config as Record<string, unknown>);
		if (openEpic) {
			openEpicForTest(dir, {
				git: {
					isRepo: true,
					baseCommit: git(['rev-parse', 'HEAD']).trim(),
					originalBranch: 'main',
					epicBranch: null,
				},
			});
		}
		const before = snapshot();
		argvs = [];
		await updateTaskStatus(dir, '1.1', 'in_progress');
		await updateTaskStatus(dir, '1.1', 'completed');
		await updateTaskStatus(dir, '1.2', 'blocked');
		await updateTaskStatus(dir, '1.1', 'completed');
		const writes = argvs.filter((argv) =>
			WRITE_SUBCOMMANDS.has(subcommandOf(argv)),
		);
		expect(writes).toEqual([]);
		if ('checkpoint' in config) {
			// The spies are live: the checkpoint's HEAD read was observed.
			expect(argvs.some((argv) => subcommandOf(argv) === 'rev-parse')).toBe(
				true,
			);
		}
		// The auto-checkpoint's own .swarm/ bookkeeping aside, git is unchanged.
		expect(snapshot()).toBe(before);
	});
});
