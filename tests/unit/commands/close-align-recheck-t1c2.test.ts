import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Facade first so wireCloseInternals() installs guardResetWithRecheck as the
// resetToMainAfterMerge seam value before any capture of that seam.
import '../../../src/commands/close';
import { _internals as closeInternals } from '../../../src/commands/close/internals';
import {
	_closeGateInternals,
	handleCloseCommand,
} from '../../../src/commands/close/orchestrator';
import {
	parseTrackedDirtyPaths,
	_internals as purgeInternals,
	recheckBeforeDestructive,
} from '../../../src/commands/destructive-purge';
import { closeProjectDb } from '../../../src/db/project-db';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
 * #2508/#2953 fixture: git repo + bare origin (align's default-branch
 * detection works offline) + complete plan backed by the ledger. `.swarm/` is
 * git-excluded via .git/info/exclude so post-reset porcelain reads clean and
 * a silent destruction cannot hide behind untracked leftovers.
 */
function createCloseFixture(name: string, fileCount = 2): string {
	const root = canonicalMkdtemp(`2953-${name}-`);
	tempRoots.push(root);
	const bare = `${root}-origin.git`;
	execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], {
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
	});
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	git(root, 'config', 'commit.gpgsign', 'false');
	for (let i = 1; i <= fileCount; i++) {
		fs.writeFileSync(
			path.join(root, `t${String(i).padStart(2, '0')}.txt`),
			`base-${i}\n`,
		);
	}
	git(root, 'add', '.');
	git(root, 'commit', '-m', 'base');
	git(root, 'remote', 'add', 'origin', bare);
	git(root, 'push', '--quiet', '-u', 'origin', 'main');
	git(root, 'remote', 'set-head', 'origin', '-a');

	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
	fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.swarm/\n');
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
	return root;
}

async function initLedgerFor(root: string): Promise<void> {
	const ledger = await import('../../../src/plan/ledger');
	const planUtils = await import('../../../src/plan/utils');
	const plan = JSON.parse(
		fs.readFileSync(path.join(root, '.swarm', 'plan.json'), 'utf8'),
	);
	await ledger.initLedger(root, planUtils.derivePlanId(plan), undefined, plan);
}

/**
 * Deterministic in-window write: dirties `file` with `bytes` immediately
 * before delegating to the CURRENT seam value — the #2953 guard — so the
 * write lands strictly between the align dispatch and the guard's
 * re-measurement (the audit probe's technique).
 */
function injectInWindowWrite(file: string, bytes: string): () => void {
	const real = closeInternals.resetToMainAfterMerge;
	closeInternals.resetToMainAfterMerge = async (cwd, options) => {
		fs.writeFileSync(path.join(cwd, file), bytes);
		return real(cwd, options);
	};
	return () => {
		closeInternals.resetToMainAfterMerge = real;
	};
}

function resetFired(root: string): boolean {
	return /reset: moving to/.test(git(root, 'reflog', '-5'));
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		try {
			closeProjectDb(root);
		} catch {
			/* best-effort: Windows WAL lock release */
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

describe('#2953 close alignment re-check (t1c2-r1-S-03)', () => {
	test('arm A: clean-tree fast path with in-window write aborts alignment', async () => {
		const root = createCloseFixture('armA');
		await initLedgerFor(root);
		const restore = injectInWindowWrite('t02.txt', 'IN-WINDOW-B\n');
		let out: string;
		try {
			out = await handleCloseCommand(root, [], {});
		} finally {
			restore();
		}
		expect(fs.readFileSync(path.join(root, 't02.txt'), 'utf8')).toBe(
			'IN-WINDOW-B\n',
		);
		expect(resetFired(root)).toBe(false);
		expect(out).toMatch(/fail-closed|abort/i);
		expect(out).toMatch(/t02\.txt/);
		expect(out).toMatch(/tracked file/i);
		expect(out).toMatch(/session is finalized/i);
	}, 120_000);

	test('arm B: confirmed close with in-window write to never-previewed file aborts', async () => {
		const root = createCloseFixture('armB');
		await initLedgerFor(root);
		fs.writeFileSync(path.join(root, 't01.txt'), 'user-confirmed-a\n');
		const preview = await handleCloseCommand(root, [], {});
		expect(preview).toMatch(/t01\.txt/);
		expect(preview).not.toMatch(/t02\.txt/);
		const token = extractToken(preview);
		expect(token).not.toBeNull();
		if (!token) return;
		const restore = injectInWindowWrite('t02.txt', 'IN-WINDOW-B\n');
		let executed: string;
		try {
			executed = await handleCloseCommand(root, [`--confirm=${token}`], {});
		} finally {
			restore();
		}
		expect(executed).not.toMatch(/confirmation rejected/i);
		expect(fs.readFileSync(path.join(root, 't01.txt'), 'utf8')).toBe(
			'user-confirmed-a\n',
		);
		expect(fs.readFileSync(path.join(root, 't02.txt'), 'utf8')).toBe(
			'IN-WINDOW-B\n',
		);
		expect(resetFired(root)).toBe(false);
		expect(executed).toMatch(/fail-closed|abort/i);
		expect(executed).toMatch(/t02\.txt/);
	}, 180_000);

	test('no-drift control: confirmed close without in-window write still aligns', async () => {
		const root = createCloseFixture('control');
		await initLedgerFor(root);
		fs.writeFileSync(path.join(root, 't01.txt'), 'user-confirmed-a\n');
		const preview = await handleCloseCommand(root, [], {});
		const token = extractToken(preview);
		expect(token).not.toBeNull();
		if (!token) return;
		const executed = await handleCloseCommand(root, [`--confirm=${token}`], {});
		expect(executed).not.toMatch(/confirmation rejected/i);
		expect(resetFired(root)).toBe(true);
		// Real negative marker (the former /recheck-refused/i was a tautology:
		// the refusal message never contains that substring).
		expect(executed).not.toMatch(/alignment aborted \(fail-closed\)/);
		// The operator-confirmed discard still happens (regression pin).
		expect(fs.readFileSync(path.join(root, 't01.txt'), 'utf8')).not.toBe(
			'user-confirmed-a\n',
		);
	}, 120_000);

	test('deterministic 10/10: every seeded in-window write aborts', async () => {
		let aborted = 0;
		for (let i = 0; i < 10; i++) {
			const root = createCloseFixture(`loop${i}`);
			await initLedgerFor(root);
			const restore = injectInWindowWrite('t02.txt', 'IN-WINDOW-B\n');
			let out: string;
			try {
				out = await handleCloseCommand(root, [], {});
			} finally {
				restore();
			}
			const survived =
				fs.readFileSync(path.join(root, 't02.txt'), 'utf8') === 'IN-WINDOW-B\n';
			if (survived && !resetFired(root) && /fail-closed|abort/i.test(out)) {
				aborted++;
			}
		}
		expect(aborted).toBe(10);
	}, 600_000);

	test('fail-closed default: undefined purgeGateDirtyPaths refuses on dirty tree', async () => {
		// Direct align-stage drive with a hand-built ctx (no carry): the
		// guard must treat the missing measurement as the empty set and
		// refuse the destructive reset — never proceed unlocked.
		const { runAlignStage } = await import(
			'../../../src/commands/close/align-stage'
		);
		const root = createCloseFixture('nodefault');
		fs.writeFileSync(path.join(root, 't01.txt'), 'unconfirmed\n');
		const ctx = {
			directory: root,
			warnings: [] as string[],
			args: [],
		} as Parameters<typeof runAlignStage>[0];
		const { gitAlignResult } = await runAlignStage(ctx);
		expect(gitAlignResult).toMatch(/fail-closed|abort/i);
		expect(gitAlignResult).toMatch(/t01\.txt/);
		expect(resetFired(root)).toBe(false);
		expect(fs.readFileSync(path.join(root, 't01.txt'), 'utf8')).toBe(
			'unconfirmed\n',
		);
		// And no cautious fallback ran either: nothing checked out.
		expect(ctx.warnings.join('\n')).toMatch(/fail-closed|abort/i);
	}, 60_000);

	test('recheck unreadable status mid-pipeline refuses without reset', async () => {
		const root = createCloseFixture('unreadable');
		await initLedgerFor(root);
		const real = purgeInternals.runGitStatus;
		// The gate read uses _closeGateInternals.runGit (its own seam),
		// so every read through the purge internals here is the guard's
		// recheck: fail it while the gate itself stays live and clean.
		purgeInternals.runGitStatus = () => null;
		try {
			const out = await handleCloseCommand(root, [], {});
			expect(out).toMatch(/fail-closed|abort/i);
			expect(out).toMatch(/could not be re-read/i);
			// Zero new-dirty paths: the "(first: ...)" clause must be omitted.
			expect(out).not.toMatch(/\(first:/);
			expect(resetFired(root)).toBe(false);
		} finally {
			purgeInternals.runGitStatus = real;
		}
	}, 120_000);

	test('marker root: bare .git marker directory proceeds without recheck refusal', async () => {
		const root = createCloseFixture('markerroot');
		// #2127 marker root (mirrors the #2508 row): a .git with no
		// repository behind it. Neither the gate nor the align guard may
		// fail-closed here — no dispatch, no refusal.
		fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
		fs.mkdirSync(path.join(root, '.git'));
		await initLedgerFor(root);
		const out = await handleCloseCommand(root, [], {});
		expect(out).not.toMatch(/fail-closed/);
		expect(out).not.toMatch(/alignment aborted/i);
	}, 120_000);

	test('same-path content drift proceeds (set-based contract documented)', async () => {
		const root = createCloseFixture('samedrift');
		await initLedgerFor(root);
		fs.writeFileSync(path.join(root, 't01.txt'), 'confirmed-edit\n');
		const preview = await handleCloseCommand(root, [], {});
		const token = extractToken(preview);
		expect(token).not.toBeNull();
		if (!token) return;
		// In-window write to the SAME already-confirmed path: the confirmed
		// scope is a set of paths, so this proceeds (documented boundary).
		const restore = injectInWindowWrite('t01.txt', 'IN-WINDOW-SAME\n');
		let executed: string;
		try {
			executed = await handleCloseCommand(root, [`--confirm=${token}`], {});
		} finally {
			restore();
		}
		expect(executed).not.toMatch(/confirmation rejected/i);
		expect(resetFired(root)).toBe(true);
	}, 120_000);

	test('refusal bounds: 15 in-window dirty files list 10 plus overflow', async () => {
		const root = createCloseFixture('bounds', 15);
		await initLedgerFor(root);
		const real = closeInternals.resetToMainAfterMerge;
		closeInternals.resetToMainAfterMerge = async (cwd, options) => {
			for (let i = 1; i <= 15; i++) {
				fs.writeFileSync(
					path.join(cwd, `t${String(i).padStart(2, '0')}.txt`),
					'IN-WINDOW\n',
				);
			}
			return real(cwd, options);
		};
		try {
			const out = await handleCloseCommand(root, [], {});
			const listed = new Set(out.match(/- t\d\d\.txt/g) ?? []).size;
			expect(listed).toBeLessThanOrEqual(10);
			expect(out).toMatch(/and 5 more/);
			expect(resetFired(root)).toBe(false);
		} finally {
			closeInternals.resetToMainAfterMerge = real;
		}
	}, 120_000);

	test('tracked .swarm/ drift refusal carries the untrack remediation hint', async () => {
		const { guardResetWithRecheck } = await import(
			'../../../src/commands/close/align-stage'
		);
		const realRunner = purgeInternals.runGitStatus;
		purgeInternals.runGitStatus = () => ' M .swarm/plan.json\n';
		let resetCalled = false;
		const refusingReset = (async () => {
			resetCalled = true;
			throw new Error('unreachable');
		}) as unknown as Parameters<typeof guardResetWithRecheck>[0];
		try {
			const result = await guardResetWithRecheck(refusingReset, '.', {
				expectedDirtyPaths: [],
			});
			expect(result.recheckRefused).toBe(true);
			expect(result.message).toMatch(/git rm -r --cached .swarm\//);
			expect(result.message).toMatch(/fail-closed|abort/i);
			expect(resetCalled).toBe(false);
		} finally {
			purgeInternals.runGitStatus = realRunner;
		}
	}, 60_000);

	describe('parseTrackedDirtyPaths / recheckBeforeDestructive battery', () => {
		test('skips untracked, strips quotes, splits staged rename', () => {
			const out = [
				'?? ignored.txt',
				' M plain.txt',
				'M  staged.txt',
				'R  "old name.txt" -> "new name.txt"',
				'', // trailing newline artifact
			].join('\n');
			expect(parseTrackedDirtyPaths(out).sort()).toEqual([
				'new name.txt',
				'old name.txt',
				'plain.txt',
				'staged.txt',
			]);
		});

		test('copy records (C in either column) split both sides', () => {
			expect(parseTrackedDirtyPaths('C  from.txt -> to.txt').sort()).toEqual([
				'from.txt',
				'to.txt',
			]);
			expect(parseTrackedDirtyPaths(' C from.txt -> to.txt').sort()).toEqual([
				'from.txt',
				'to.txt',
			]);
		});

		test('empty porcelain output parses to no dirty paths', () => {
			expect(parseTrackedDirtyPaths('')).toEqual([]);
		});

		test('worktree rename (R in second column) splits both sides', () => {
			expect(parseTrackedDirtyPaths(' R a.txt -> b.txt').sort()).toEqual([
				'a.txt',
				'b.txt',
			]);
		});

		test('real git add -N rename output splits both sides', () => {
			const root = canonicalMkdtemp('2953-addn-');
			tempRoots.push(root);
			git(root, 'init', '--initial-branch=main');
			git(root, 'config', 'user.email', 'probe@example.invalid');
			git(root, 'config', 'user.name', 'Probe');
			git(root, 'config', 'commit.gpgsign', 'false');
			fs.writeFileSync(path.join(root, 'rorig.txt'), 'x\n');
			git(root, 'add', '.');
			git(root, 'commit', '-m', 'base');
			fs.renameSync(path.join(root, 'rorig.txt'), path.join(root, 'rnew.txt'));
			git(root, 'add', '-N', 'rnew.txt');
			// Raw capture: the porcelain line is ' R rorig.txt -> rnew.txt' —
			// trimming would eat the leading XY space and corrupt the input.
			const status = execFileSync('git', ['status', '--porcelain'], {
				cwd: root,
				encoding: 'utf8',
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			expect(status).toContain('->');
			expect(parseTrackedDirtyPaths(status).sort()).toEqual([
				'rnew.txt',
				'rorig.txt',
			]);
		});

		test('recheck: newly-dirty refuses, subset passes, unreadable refuses', async () => {
			const base = ' M a.txt\n';
			const real = purgeInternals.runGitStatus;
			try {
				purgeInternals.runGitStatus = () => `${base} M b.txt`;
				const refused = await recheckBeforeDestructive('dir', ['a.txt']);
				expect(refused.ok).toBe(false);
				if (!refused.ok) {
					expect(refused.newDirtyPaths).toEqual(['b.txt']);
					expect(refused.reason).toMatch(/1 tracked file/);
				}
				purgeInternals.runGitStatus = () => base;
				const subset = await recheckBeforeDestructive('dir', [
					'a.txt',
					'gone.txt',
				]);
				expect(subset.ok).toBe(true);
				purgeInternals.runGitStatus = () => null;
				const unreadable = await recheckBeforeDestructive('dir', ['a.txt']);
				expect(unreadable.ok).toBe(false);
				if (!unreadable.ok) {
					expect(unreadable.reason).toMatch(/could not be re-read/);
					expect(unreadable.newDirtyPaths).toEqual([]);
				}
			} finally {
				purgeInternals.runGitStatus = real;
			}
		});

		test('gate seam still honored (fail-closed gate read)', async () => {
			const realRunGit = _closeGateInternals.runGit;
			_closeGateInternals.runGit = () => null;
			try {
				const root = createCloseFixture('gatefail');
				await initLedgerFor(root);
				const out = await handleCloseCommand(root, [], {});
				expect(out).toMatch(/fail-closed/);
				expect(out).toMatch(/Nothing was closed/);
			} finally {
				_closeGateInternals.runGit = realRunGit;
			}
		}, 120_000);
	});
});
