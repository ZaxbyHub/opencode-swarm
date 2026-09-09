import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_closeGateInternals,
	handleCloseCommand,
} from '../../../src/commands/close/orchestrator';
import { closeProjectDb } from '../../../src/db/project-db';

const GIT_TIMEOUT_MS = 10_000;
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function extractToken(out: string): string | null {
	const match = out.match(/--confirm=([A-Za-z0-9][A-Za-z0-9_-]{7,})/);
	return match ? match[1] : null;
}

/**
 * Minimal drivable close fixture: git repo + bare origin (so align's default
 * branch detection works) + complete plan backed by the durable ledger.
 */
function createCloseFixture(name: string): { root: string; bare: string } {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `2508-close-${name}-`)),
	);
	tempRoots.push(root);
	const bare = `${root}-origin.git`;
	execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], {
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
	});
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	fs.writeFileSync(path.join(root, 'a.txt'), 'base-a\n');
	git(root, 'add', 'a.txt');
	git(root, 'commit', '-m', 'base');
	git(root, 'remote', 'add', 'origin', bare);
	git(root, 'push', '--quiet', '-u', 'origin', 'main');
	git(root, 'remote', 'set-head', 'origin', '-a');

	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	const plan = {
		title: name,
		swarm: name,
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'complete',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						name: 'Task A',
						status: 'completed',
						description: 'Task A',
						size: 'small',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(root, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	return { root, bare };
}

async function initLedgerFor(root: string): Promise<void> {
	const ledger = await import('../../../src/plan/ledger');
	const planUtils = await import('../../../src/plan/utils');
	const plan = JSON.parse(
		fs.readFileSync(path.join(root, '.swarm', 'plan.json'), 'utf8'),
	);
	await ledger.initLedger(root, planUtils.derivePlanId(plan), undefined, plan);
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		try {
			closeProjectDb(root);
		} catch {
			/* best-effort: Windows WAL lock release */
		}
		try {
			fs.rmSync(`${root}-lane`, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
		try {
			git(root, 'worktree', 'prune');
		} catch {
			/* best-effort */
		}
		fs.rmSync(`${root}-origin.git`, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('#2508 two-step destructive purge for /swarm close', () => {
	test('dirty tree: no-token call returns preview + real token and destroys nothing', async () => {
		const { root } = createCloseFixture('preview');
		await initLedgerFor(root);
		const userContent = 'user-uncommitted-a\n';
		fs.writeFileSync(path.join(root, 'a.txt'), userContent);
		const archiveBefore = fs.existsSync(path.join(root, '.swarm', 'archive'));

		const out = await handleCloseCommand(root, [], {});

		// Preview contract: counts, exact option label, substituted real token.
		expect(out).toMatch(/preview/i);
		expect(out).toMatch(/1 uncommitted tracked change/);
		const token = extractToken(out);
		expect(token).not.toBeNull();
		// The user's unconsumed work survived the preview byte-for-byte.
		expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(userContent);
		// Side-effect-free: no archive bundle was created by the preview.
		expect(fs.existsSync(path.join(root, '.swarm', 'archive'))).toBe(
			archiveBefore,
		);
	});

	test('dirty tree: confirmed call executes; replayed token is rejected', async () => {
		const { root } = createCloseFixture('confirm');
		await initLedgerFor(root);
		fs.writeFileSync(path.join(root, 'a.txt'), 'user-uncommitted-a\n');

		const preview = await handleCloseCommand(root, [], {});
		const token = extractToken(preview);
		expect(token).not.toBeNull();
		if (!token) return;

		const executed = await handleCloseCommand(root, [`--confirm=${token}`], {});
		// The confirmed close ran the destructive pipeline: alignment discarded
		// the user's edit (explicitly confirmed by the operator).
		expect(executed).not.toMatch(/confirmation rejected/i);
		expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).not.toBe(
			'user-uncommitted-a\n',
		);

		// Replay: the single-use token cannot execute a second time.
		fs.writeFileSync(path.join(root, 'a.txt'), 'regenerated-work\n');
		const replay = await handleCloseCommand(root, [`--confirm=${token}`], {});
		expect(replay).toMatch(/rejected/i);
		expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(
			'regenerated-work\n',
		);
	}, 120_000);

	test('dirty tree: wrong token is rejected without destruction', async () => {
		const { root } = createCloseFixture('wrong');
		await initLedgerFor(root);
		fs.writeFileSync(path.join(root, 'a.txt'), 'user-uncommitted-a\n');

		const out = await handleCloseCommand(
			root,
			['--confirm=not-a-real-token'],
			{},
		);

		expect(out).toMatch(/rejected/i);
		expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(
			'user-uncommitted-a\n',
		);
	});

	test('git status unreadable: close fails closed without destruction', async () => {
		const { root } = createCloseFixture('failclosed');
		await initLedgerFor(root);
		fs.writeFileSync(path.join(root, 'a.txt'), 'user-uncommitted-a\n');

		const realRunGit = _closeGateInternals.runGit;
		_closeGateInternals.runGit = () => null;
		try {
			const out = await handleCloseCommand(root, [], {});
			expect(out).toMatch(/fail-closed/);
			expect(out).toMatch(/Nothing was closed/);
			// The user's unconsumed work survived the unreadable gate.
			expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(
				'user-uncommitted-a\n',
			);
			expect(
				fs.existsSync(path.join(root, '.swarm', 'pending-purge.json')),
			).toBe(false);
		} finally {
			_closeGateInternals.runGit = realRunGit;
		}
	});

	test('clean tree: bare close keeps its single-call behavior', async () => {
		const { root } = createCloseFixture('clean');
		await initLedgerFor(root);
		git(root, 'status', '--porcelain'); // no-op; tree is clean

		const out = await handleCloseCommand(root, [], {});

		// No preview fired on a clean tree: the run executed the pipeline.
		expect(out).not.toMatch(/--confirm=[A-Za-z0-9][A-Za-z0-9_-]{7,}/);
	}, 120_000);
});
