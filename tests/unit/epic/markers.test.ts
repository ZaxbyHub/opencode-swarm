/**
 * Epic v2 C3 — epic refs (`src/epic/markers.ts`) on real git
 * repositories: create-only / idempotent / compare-and-swap writes, the
 * record → refs mirror, ancestry, deletion, the plan-scoped task-commit
 * query (merge commits included, foreign plans and forged bodies ignored),
 * and the `--repair-refs` plan. Git failures throw (callers fail closed).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EpicRecordV1 } from '../../../src/epic/lifecycle';
import {
	_internals,
	deleteEpicRefs,
	desiredEpicRefs,
	epicTaskRef,
	findTaskCommits,
	isCommitAncestorOfHead,
	planEpicTaskRefRepair,
	readEpicRefs,
	syncEpicRefs,
	taskRefComponent,
	writeEpicRef,
} from '../../../src/epic/markers';
import { formatEpicTaskCommitMessage } from '../../../src/epic/plan-key';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const KEY = '0123456789abcdef';
const realInternals = { ..._internals };
let dir: string;

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

function commit(message: string, file?: string): string {
	if (file) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), `${message}\n`);
		git(['add', file]);
	}
	git(['commit', '-q', '--allow-empty', '-m', message]);
	return git(['rev-parse', 'HEAD']).trim();
}

function record(overrides: Partial<EpicRecordV1> = {}): EpicRecordV1 {
	return stubEpicRecord({ planKey: KEY, ...overrides });
}

beforeEach(() => {
	dir = canonicalMkdtemp('epic-markers-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	commit('seed', 'README.md');
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('ref names', () => {
	test('strict ids verbatim; anything unsafe hex-encoded behind _x', () => {
		expect(taskRefComponent('1.2')).toBe('1.2');
		expect(taskRefComponent('setup-db')).toBe('setup-db');
		expect(taskRefComponent('a..b')).toBe(
			`_x${Buffer.from('a..b').toString('hex')}`,
		);
		expect(taskRefComponent('x.lock')).toStartWith('_x');
		expect(taskRefComponent('../etc')).toStartWith('_x');
		const epicKey = record().epicKey;
		expect(epicTaskRef(epicKey, '1.2')).toBe(
			`refs/swarm/epics/${epicKey}/tasks/1.2`,
		);
		expect(
			git(['check-ref-format', epicTaskRef(epicKey, 'a b/../c')]),
		).toBeDefined();
	});
});

describe('writeEpicRef / readEpicRefs', () => {
	test('create-only, idempotent, compare-and-swap; missing ref reads empty', () => {
		const a = git(['rev-parse', 'HEAD']).trim();
		const b = commit('second');
		const ref = epicTaskRef(record().epicKey, '1.1');
		expect(readEpicRefs(dir, record().epicKey).size).toBe(0);
		expect(writeEpicRef(dir, ref, a, null)).toBe('created');
		expect(writeEpicRef(dir, ref, a, a)).toBe('unchanged');
		// create-only: a stale "missing" belief cannot clobber the ref.
		expect(() => writeEpicRef(dir, ref, b, null)).toThrow();
		expect(readEpicRefs(dir, record().epicKey).get(ref)).toBe(a);
		expect(writeEpicRef(dir, ref, b, a)).toBe('updated');
		expect(git(['rev-parse', ref]).trim()).toBe(b);
	});

	test('a failed write that nevertheless landed (raced writer) succeeds', () => {
		const a = git(['rev-parse', 'HEAD']).trim();
		const ref = epicTaskRef(record().epicKey, '1.1');
		git(['update-ref', ref, a]);
		expect(writeEpicRef(dir, ref, a, null)).toBe('created');
	});

	test('the epic namespace never matches a longer sibling key', () => {
		const a = git(['rev-parse', 'HEAD']).trim();
		const epicKey = record().epicKey;
		git(['update-ref', `refs/swarm/epics/${epicKey}-other/base`, a]);
		expect(readEpicRefs(dir, epicKey).size).toBe(0);
	});

	test('git failure throws (callers fail closed)', () => {
		_internals.gitExec = () => {
			throw new Error('simulated timeout');
		};
		expect(() => readEpicRefs(dir, record().epicKey)).toThrow(
			'simulated timeout',
		);
	});
});

describe('syncEpicRefs (record → refs)', () => {
	test('creates base, closed waves and completed tasks; repairs a drifted ref; deletes all', () => {
		const base = git(['rev-parse', 'HEAD']).trim();
		const landed = commit(formatEpicTaskCommitMessage('1.1', KEY, 'x'));
		const epic = record({
			git: {
				isRepo: true,
				baseCommit: base,
				originalBranch: 'main',
				epicBranch: null,
			},
			waves: [
				{
					seq: 1,
					phase: 1,
					kind: 'parallel',
					taskIds: ['1.1', '1.2'],
					files: {},
					cochange: null,
					baseHead: base,
					issuedAt: 'x',
					status: 'closed',
					closeHead: landed,
				},
				{
					seq: 2,
					phase: 1,
					kind: 'parallel',
					taskIds: ['1.3'],
					files: {},
					cochange: null,
					baseHead: landed,
					issuedAt: 'y',
					status: 'issued',
				},
			],
			tasks: {
				'1.1': outcome('1.1', 'completed', landed),
				'1.2': outcome('1.2', 'closed', null),
			},
		});
		const prefix = `refs/swarm/epics/${epic.epicKey}`;
		expect([...desiredEpicRefs(epic).keys()].sort()).toEqual([
			`${prefix}/base`,
			`${prefix}/tasks/1.1`,
			`${prefix}/waves/1`,
		]);
		const refs = syncEpicRefs(dir, epic);
		expect(refs.get(`${prefix}/tasks/1.1`)).toBe(landed);
		expect(git(['rev-parse', `${prefix}/base`]).trim()).toBe(base);
		// A drifted ref (e.g. left by an earlier epic of the same key) is
		// compare-and-swapped back to the record.
		git(['update-ref', `${prefix}/tasks/1.1`, base]);
		syncEpicRefs(dir, epic);
		expect(git(['rev-parse', `${prefix}/tasks/1.1`]).trim()).toBe(landed);
		expect(deleteEpicRefs(dir, epic.epicKey)).toEqual({
			deleted: [`${prefix}/base`, `${prefix}/tasks/1.1`, `${prefix}/waves/1`],
			failed: [],
		});
		expect(git(['for-each-ref', 'refs/swarm']).trim()).toBe('');
		// Non-git epics mirror nothing.
		expect(
			desiredEpicRefs(
				record({
					git: {
						isRepo: false,
						baseCommit: null,
						originalBranch: null,
						epicBranch: null,
					},
				}),
			).size,
		).toBe(0);
	});
});

describe('isCommitAncestorOfHead', () => {
	test('reachable ⇒ true; dropped by a reset ⇒ false; git error throws', () => {
		const base = git(['rev-parse', 'HEAD']).trim();
		const tip = commit('tip');
		expect(isCommitAncestorOfHead(dir, base)).toBe(true);
		expect(isCommitAncestorOfHead(dir, tip)).toBe(true);
		git(['reset', '-q', '--hard', base]);
		expect(isCommitAncestorOfHead(dir, tip)).toBe(false);
		expect(isCommitAncestorOfHead(dir, 'not-a-sha')).toBe(false);
		expect(() => isCommitAncestorOfHead(dir, 'f'.repeat(40))).toThrow();
	});
});

describe('findTaskCommits (plan-scoped, bounded)', () => {
	test('newest current-plan commit per task, merges included, foreign plans and bodies ignored', () => {
		const base = git(['rev-parse', 'HEAD']).trim();
		commit(
			formatEpicTaskCommitMessage('1.1', 'feedfacefeedface', 'other plan'),
		);
		const first = commit(formatEpicTaskCommitMessage('1.1', KEY, 'landing'));
		commit(`docs: notes\n\nswarm(task 1.2): quoted\n\nSwarm-Plan: ${KEY}`);
		git(['checkout', '-q', '-b', 'lane']);
		commit('lane work', 'src/a.ts');
		git(['checkout', '-q', '-']);
		git([
			'merge',
			'--no-ff',
			'-q',
			'-m',
			formatEpicTaskCommitMessage('1.2', KEY, 'merged landing'),
			'lane',
		]);
		const merge = git(['rev-parse', 'HEAD']).trim();
		const found = findTaskCommits(dir, `${base}..HEAD`, KEY, [
			'1.1',
			'1.2',
			'1.3',
		]);
		expect(found).toEqual(
			new Map([
				['1.2', merge],
				['1.1', first],
			]),
		);
		expect(findTaskCommits(dir, `${merge}..HEAD`, KEY, ['1.1']).size).toBe(0);
	});
});

describe('planEpicTaskRefRepair', () => {
	test('ok / repaired via marker / repaired via declared files / needs-attention / unrecorded adoption', () => {
		const base = git(['rev-parse', 'HEAD']).trim();
		const lost = commit('lost');
		git(['reset', '-q', '--hard', base]);
		const viaMarker = commit(
			formatEpicTaskCommitMessage('1.2', KEY, 'rewritten'),
		);
		const viaFiles = commit('manual work', 'src/c.ts');
		const okSha = commit('ok');
		const unrecorded = commit(
			formatEpicTaskCommitMessage('2.1', KEY, 'outside'),
		);
		const epic = record({
			git: {
				isRepo: true,
				baseCommit: base,
				originalBranch: 'main',
				epicBranch: null,
			},
			tasks: {
				'1.1': outcome('1.1', 'completed', okSha),
				'1.2': outcome('1.2', 'completed', lost),
				'1.3': { ...outcome('1.3', 'completed', lost), declared: ['src/c.ts'] },
				'1.4': outcome('1.4', 'completed', lost),
			},
		});
		const plan = planEpicTaskRefRepair(dir, epic, ['2.1', '2.2']);
		const verdicts = Object.fromEntries(
			plan.repairs.map((r) => [r.taskId, r.status]),
		);
		expect(verdicts).toEqual({
			'1.1': 'ok',
			'1.2': 'repaired',
			'1.3': 'repaired',
			'1.4': 'needs-attention',
			'2.1': 'repaired',
			'2.2': 'needs-attention',
		});
		expect(plan.recorded).toEqual(
			new Map([
				['1.2', viaMarker],
				['1.3', viaFiles],
			]),
		);
		expect(plan.unrecorded).toEqual(new Map([['2.1', unrecorded]]));
	});
});

function outcome(
	taskId: string,
	resolution: 'completed' | 'closed',
	sha: string | null,
): EpicRecordV1['tasks'][string] {
	return {
		taskId,
		phase: 1,
		waveSeq: 1,
		resolution,
		resolvedAt: 'x',
		generation: 1,
		stageAFailures: 0,
		stageBFailures: 0,
		mergeFailure: null,
		declared: [],
		undeclared: [],
		attribution: 'session',
		reopened: 0,
		marker: sha ? { ref: null, sha, provenance: 'landing-commit' } : null,
	};
}
