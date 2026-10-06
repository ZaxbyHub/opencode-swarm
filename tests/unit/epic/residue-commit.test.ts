/**
 * Epic v2 C3 (X1) — residue commits of non-coder writers
 * (`src/epic/residue-commit.ts`), on real git repositories:
 *   - only the agent's ATTRIBUTED dirty paths are committed (declared scope
 *     of the served task, write attribution, the agent's child session),
 *     with `swarm(task <id>): <agent> residue` + the plan trailer;
 *   - literal pathspecs (no glob), never `.swarm/` at any depth, `--only`
 *     (pre-staged entries stay staged and out of the commit), rename
 *     sources follow their destination;
 *   - coders, foreign branches and closed epics never commit; no epic costs
 *     one `existsSync`; a failing commit is fail-open (critical warning,
 *     index restored exactly) and never throws; only the CURRENT wave's
 *     declared scopes attribute writes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import type { EpicRecordV1 } from '../../../src/epic/lifecycle';
import {
	_internals,
	classifyDirtyBaseline,
	commitEpicResidueAfterDelegation,
} from '../../../src/epic/residue-commit';
import { runSerializedWithMergeBacks } from '../../../src/hooks/delegation-gate/worktree-isolation';
import { savePlan } from '../../../src/plan/manager';
import {
	ensureAgentSession,
	recordModifiedFileForTask,
	resetSwarmState,
} from '../../../src/state';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const realInternals = { ..._internals };
let dir: string;
let epic: EpicRecordV1;
let isolatedEnv: { cleanup: () => void } | undefined;

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

function write(file: string, content = `${file}\n`): void {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), content);
}

function plan(): Plan {
	const task = (id: string) => ({
		id,
		phase: 1,
		status: 'pending' as const,
		size: 'small' as const,
		description: `task ${id}`,
		depends: [],
		files_touched: [],
	});
	return {
		schema_version: '1.0.0',
		title: 'Residue',
		swarm: 'residue-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'P1',
				status: 'pending',
				tasks: [task('1.1'), task('1.2')],
			},
		],
	};
}

async function residue(
	agent: string,
	taskIds: string[],
	childSessionIds: string[] = [],
): Promise<void> {
	await commitEpicResidueAfterDelegation({
		directory: dir,
		agent,
		sessionID: 'ses_architect',
		resolveTaskIds: async () => taskIds,
		childSessionIds: async () => childSessionIds,
	});
}

const committedFiles = () =>
	git(['show', '--name-only', '--no-renames', '--format=', 'HEAD'])
		.trim()
		.split('\n');
const subject = () => git(['log', '-1', '--format=%s']).trim();

beforeEach(async () => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	dir = canonicalMkdtemp('epic-residue-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	write(
		'.opencode/opencode-swarm.json',
		JSON.stringify({
			epic: { mode: { enabled: true } },
		}),
	);
	write('.gitignore', '.swarm/\n');
	write('README.md', '# readme\n');
	write('tests/old.test.ts', 'old\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, plan());
	const head = git(['rev-parse', 'HEAD']).trim();
	epic = openEpicForTest(dir, {
		git: {
			isRepo: true,
			baseCommit: head,
			originalBranch: 'main',
			epicBranch: null,
		},
		waves: [
			{
				seq: 1,
				phase: 1,
				kind: 'parallel',
				taskIds: ['1.1', '1.2'],
				files: {
					'1.1': ['tests/a.test.ts', 'app/[id].tsx', 'pkg'],
					'1.2': ['tests/b.test.ts'],
				},
				cochange: null,
				baseHead: head,
				issuedAt: '2026-01-01T00:00:00.000Z',
				status: 'issued',
			},
		],
		activeWaveSeq: 1,
	});
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	resetSwarmState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('commitEpicResidueAfterDelegation (real git)', () => {
	test("commits only the served task's attributed paths with the residue subject + trailer", async () => {
		write('tests/a.test.ts');
		write('tests/b.test.ts'); // a sibling task's WIP
		await residue('test_engineer', ['1.1']);
		// Swept from the task's frozen scope, not recorded by the returning
		// agent: committed under the neutral label (no agent is claimed).
		expect(subject()).toBe('swarm(task 1.1): residue');
		expect(git(['log', '-1', '--format=%B'])).toContain(
			`Swarm-Plan: ${epic.planKey}`,
		);
		expect(committedFiles()).toEqual(['tests/a.test.ts']);
		expect(git(['status', '--porcelain', 'tests/b.test.ts'])).toStartWith('??');
	});

	test('pathspecs are literal: a declared `app/[id].tsx` never globs `app/i.tsx`', async () => {
		write('app/[id].tsx');
		write('app/i.tsx');
		await residue('test_engineer', ['1.1']);
		expect(committedFiles()).toEqual(['app/[id].tsx']);
		expect(git(['status', '--porcelain', 'app/i.tsx'])).toStartWith('??');
	});

	test('never .swarm/ at any depth, even when attributed or under a declared directory', async () => {
		write('pkg/index.ts');
		write('pkg/.swarm/leak.json');
		write('src/extra.ts');
		write('.swarm/notes.md');
		const child = ensureAgentSession('ses_te_child', 'test_engineer', dir);
		for (const file of [
			'.swarm/notes.md',
			'pkg/.swarm/leak.json',
			'src/extra.ts',
		]) {
			recordModifiedFileForTask(child, 'ses_te_child:unknown', file, dir);
		}
		await residue('mega_test_engineer', ['1.1'], ['ses_te_child']);
		// Two commits: the agent's own recorded write under its name, then the
		// rest of the frozen scope under the neutral label.
		expect(committedFiles()).toEqual(['pkg/index.ts']);
		expect(subject()).toBe('swarm(task 1.1): residue');
		expect(
			git(['show', '--name-only', '--format=%s', 'HEAD~1']).trim().split('\n'),
		).toEqual(['swarm(task 1.1): test_engineer residue', '', 'src/extra.ts']);
		expect(git(['log', '--all', '--name-only', '--format='])).not.toContain(
			'.swarm',
		);
	});

	test('a file a still-running delegation is writing is never swept into another agent residue', async () => {
		// Live run: Stage B reviewer and test_engineer run concurrently; the
		// reviewer returned first and its residue swept the test_engineer's
		// in-progress test file into "reviewer residue".
		write('tests/a.test.ts', '// half-written by the test engineer\n');
		const testEngineer = ensureAgentSession(
			'ses_te_running',
			'test_engineer',
			dir,
		);
		testEngineer.delegationActive = true;
		recordModifiedFileForTask(
			testEngineer,
			'ses_te_running:unknown',
			'tests/a.test.ts',
			dir,
		);
		const head = git(['rev-parse', 'HEAD']);
		await residue('reviewer', ['1.1'], ['ses_rev_child']);
		expect(git(['rev-parse', 'HEAD'])).toBe(head);
		expect(git(['status', '--porcelain', 'tests/a.test.ts'])).toStartWith('??');
		// Once the test engineer returns, its own write lands under its name.
		testEngineer.delegationActive = false;
		await residue('test_engineer', ['1.1'], ['ses_te_running']);
		expect(subject()).toBe('swarm(task 1.1): test_engineer residue');
		expect(committedFiles()).toEqual(['tests/a.test.ts']);
	});

	test('--only: a pre-staged unrelated change stays staged and out of the commit', async () => {
		write('README.md', '# changed\n');
		git(['add', 'README.md']);
		write('tests/a.test.ts');
		await residue('docs', ['1.1']);
		expect(subject()).toBe('swarm(task 1.1): residue');
		expect(committedFiles()).toEqual(['tests/a.test.ts']);
		expect(git(['diff', '--cached', '--name-only']).trim()).toBe('README.md');
	});

	test('a staged rename into the scope carries its source deletion', async () => {
		git(['mv', 'tests/old.test.ts', 'tests/a.test.ts']);
		await residue('test_engineer', ['1.1']);
		expect(committedFiles().sort()).toEqual([
			'tests/a.test.ts',
			'tests/old.test.ts',
		]);
		expect(git(['status', '--porcelain']).trim()).toBe('');
	});

	test('scopes of an earlier, closed wave never attribute a later edit', async () => {
		const closed = { ...epic.waves[0], status: 'closed' as const };
		const { updateEpicRecord } = await import('../../../src/epic/lifecycle');
		updateEpicRecord(
			dir,
			epic.epicKey,
			(record) => ({ ...record, waves: [closed], activeWaveSeq: null }),
			epic.token,
		);
		write('tests/a.test.ts');
		const head = git(['rev-parse', 'HEAD']);
		await residue('test_engineer', ['1.1']);
		expect(git(['rev-parse', 'HEAD'])).toBe(head);
	});

	test('coders, unknown tasks and a foreign branch never commit', async () => {
		write('tests/a.test.ts');
		const head = git(['rev-parse', 'HEAD']);
		await residue('coder', ['1.1']);
		await residue('test_engineer', ['9.9']);
		_internals.checkEpicBranch = (() => ({
			ok: false,
			code: 'EPIC_BRANCH_MISMATCH',
			expected: 'swarm/epic/x',
			actual: 'main',
			message: 'EPIC_BRANCH_MISMATCH: off branch',
		})) as never;
		await residue('test_engineer', ['1.1']);
		expect(git(['rev-parse', 'HEAD'])).toBe(head);
	});

	test('no open epic ⇒ one sentinel check and nothing else', async () => {
		let probes = 0;
		let reads = 0;
		_internals.epicSentinelExists = () => {
			probes += 1;
			return false;
		};
		_internals.getOpenEpic = (() => {
			reads += 1;
			return null;
		}) as never;
		let thunks = 0;
		await commitEpicResidueAfterDelegation({
			directory: dir,
			agent: 'test_engineer',
			sessionID: 's',
			resolveTaskIds: async () => {
				thunks += 1;
				return ['1.1'];
			},
			childSessionIds: async () => {
				thunks += 1;
				return [];
			},
		});
		expect([probes, reads, thunks]).toEqual([1, 0, 0]);
	});

	test('a large residue (argv budget exceeded) commits via a transient pathspec file', async () => {
		const files = Array.from(
			{ length: 400 },
			(_, i) =>
				`pkg/generated/module-${String(i).padStart(4, '0')}-${'x'.repeat(48)}.ts`,
		);
		for (const file of files) write(file);
		await residue('test_engineer', ['1.1']);
		expect(subject()).toBe('swarm(task 1.1): residue');
		expect(committedFiles()).toHaveLength(400);
		const gitDir = git(['rev-parse', '--git-dir']).trim();
		expect(
			fs
				.readdirSync(path.resolve(dir, gitDir))
				.filter((name) => name.startsWith('swarm-epic-residue-')),
		).toEqual([]);
	});

	test('waits for an in-flight worktree merge-back (one index writer at a time)', async () => {
		write('tests/a.test.ts');
		const head = git(['rev-parse', 'HEAD']);
		let release: () => void = () => {};
		const landing = runSerializedWithMergeBacks(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const pending = residue('test_engineer', ['1.1']);
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		expect(git(['rev-parse', 'HEAD'])).toBe(head);
		release();
		await landing;
		await pending;
		expect(subject()).toBe('swarm(task 1.1): residue');
	});

	test('a failing commit is fail-open and restores the index exactly (user-staged state kept)', async () => {
		write('tests/a.test.ts');
		// The user has a partially staged change inside the task's scope.
		write('pkg/index.ts', 'staged version\n');
		git(['add', 'pkg/index.ts']);
		write('pkg/index.ts', 'worktree version\n');
		// …and a staged deletion of a tracked file inside the scope.
		write('pkg/gone.ts', 'tracked\n');
		git(['add', 'pkg/gone.ts']);
		git(['commit', '-q', '-m', 'track gone']);
		git(['rm', '-q', '--cached', 'pkg/gone.ts']);
		const indexBefore = git(['ls-files', '-s']);
		const head = git(['rev-parse', 'HEAD']);
		_internals.gitExecOnce = ((args: string[], cwd: string) => {
			if (args.includes('commit')) throw new Error('index.lock exists');
			return realInternals.gitExecOnce(args, cwd);
		}) as never;
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		try {
			await residue('test_engineer', ['1.1']);
		} finally {
			console.warn = original;
		}
		expect(git(['rev-parse', 'HEAD'])).toBe(head);
		expect(git(['ls-files', '-s'])).toBe(indexBefore);
		expect(fs.readFileSync(path.join(dir, 'pkg/index.ts'), 'utf-8')).toBe(
			'worktree version\n',
		);
		expect(warnings.join('\n')).toContain('could not be committed');
	});
});

describe('classifyDirtyBaseline', () => {
	test('before a new wave nothing belongs to a task: tracked blocks, untracked is advisory', () => {
		expect(
			classifyDirtyBaseline([
				{ path: 'src/shared.ts', untracked: false },
				{ path: 'docs/guide.md', untracked: true },
				{ path: 'src/manual.ts', untracked: false },
			]),
		).toEqual({
			unattributedTracked: ['src/shared.ts', 'src/manual.ts'],
			unattributedUntracked: ['docs/guide.md'],
		});
	});
});
