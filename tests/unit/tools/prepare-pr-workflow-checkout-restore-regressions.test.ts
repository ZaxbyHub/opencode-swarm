import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	prWorkflowSessionFileStem,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import {
	_internals,
	executePreparePrWorkflowCheckout,
	listPendingPrWorkflowCheckoutRestores,
} from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'checkout-restore-regressions';
let directory = '';
let baseHead = '';
let prHead = '';
const originalRunGit = _internals.runGit;
const originalRemoveCheckoutRestoreReceipt =
	_internals.removeCheckoutRestoreReceipt;

async function git(args: string[]): Promise<string> {
	const result = await originalRunGit(directory, args, { captureStdout: true });
	if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
	return result.stdout.trim();
}

async function abort(mode: 'PR_REVIEW' | 'PR_FEEDBACK'): Promise<void> {
	const result = JSON.parse(
		await executeAbortPrWorkflow(
			{ mode, kind: 'recovery', reason: 'regression fixture terminal state' },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result).toMatchObject({ success: true });
}

async function prepare(
	mode: 'PR_REVIEW' | 'PR_FEEDBACK',
): Promise<{ stash_oid: string }> {
	await activatePrWorkflow(directory, SESSION_ID, mode);
	const result = JSON.parse(
		await executePreparePrWorkflowCheckout({}, directory, {
			sessionID: SESSION_ID,
		}),
	);
	expect(result.success).toBe(true);
	return result;
}

async function restore(): Promise<Record<string, unknown>> {
	return JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ operation: 'restore' },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
}

async function readText(fileName: string): Promise<string> {
	return (await fs.readFile(path.join(directory, fileName), 'utf8')).replace(
		/\r\n/g,
		'\n',
	);
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-workflow-restore-regressions-');
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'test@example.com']);
	await git(['config', 'user.name', 'Checkout Restore Regression Test']);
	await fs.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.writeFile(path.join(directory, 'a.txt'), 'a0\n');
	await fs.writeFile(path.join(directory, 'b.txt'), 'b0\n');
	await git(['add', '.']);
	await git(['commit', '-m', 'base']);
	baseHead = await git(['rev-parse', 'HEAD']);
	await git(['switch', '-c', 'review-head']);
	await fs.writeFile(path.join(directory, 'review.txt'), 'review\n');
	await git(['add', 'review.txt']);
	await git(['commit', '-m', 'review']);
	prHead = await git(['rev-parse', 'HEAD']);
	await git(['switch', 'main']);
});

afterEach(async () => {
	_internals.runGit = originalRunGit;
	_internals.removeCheckoutRestoreReceipt =
		originalRemoveCheckoutRestoreReceipt;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('prepare_pr_workflow_checkout restore review regressions', () => {
	test('restores a PR_FEEDBACK branch that advanced only as a descendant (intent-architecture-001)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'preserved\n');
		const prepared = await prepare('PR_FEEDBACK');
		await git(['switch', '--detach', prHead]);
		await abort('PR_FEEDBACK');

		// Previous code required main to remain exactly at baseHead, although the
		// feedback workflow normally advances that same PR branch with a commit.
		const advanced = await git([
			'commit-tree',
			`${baseHead}^{tree}`,
			'-p',
			baseHead,
			'-m',
			'feedback commit',
		]);
		await git(['update-ref', 'refs/heads/main', advanced, baseHead]);

		const result = await restore();
		expect(result).toMatchObject({
			success: true,
			restored: true,
			stash_oid: prepared.stash_oid,
			restored_head: advanced,
		});
		expect(await git(['branch', '--show-current'])).toBe('main');
		expect(await git(['rev-parse', 'HEAD'])).toBe(advanced);
		expect(await readText('a.txt')).toBe('preserved\n');
	});

	test('rejects divergent PR_FEEDBACK branch drift without checkout mutation', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'preserved\n');
		const prepared = await prepare('PR_FEEDBACK');
		await git(['switch', '--detach', prHead]);
		await abort('PR_FEEDBACK');
		const divergent = await git([
			'commit-tree',
			`${prHead}^{tree}`,
			'-m',
			'divergent commit',
		]);
		await git(['update-ref', 'refs/heads/main', divergent, baseHead]);

		const result = await restore();
		expect(result).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_BRANCH_DRIFT',
		});
		expect(await git(['rev-parse', 'HEAD'])).toBe(prHead);
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
	});

	test('restores two same-destination receipts in one convergent call (CS-2164-002)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'a1\n');
		const first = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await fs.writeFile(path.join(directory, 'b.txt'), 'b1\n');
		const second = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await git(['switch', '--detach', prHead]);

		const result = await restore();
		expect(result).toMatchObject({ success: true, restored: true });
		expect(result.stash_oids).toEqual(
			expect.arrayContaining([first.stash_oid, second.stash_oid]),
		);
		expect(await readText('a.txt')).toBe('a1\n');
		expect(await readText('b.txt')).toBe('b1\n');
		const retained = await git(['stash', 'list', '--format=%H']);
		expect(retained).toContain(first.stash_oid);
		expect(retained).toContain(second.stash_oid);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([]);
	});

	test('resumes a partially applied multi-receipt restore without requiring a clean tree (CS-2164-002)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'a1\n');
		const first = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await fs.writeFile(path.join(directory, 'b.txt'), 'b1\n');
		const second = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		let applyCount = 0;
		_internals.runGit = async (cwd, args, options) => {
			if (args[0] === 'stash' && args[1] === 'apply') {
				applyCount += 1;
				if (applyCount === 2) return { exitCode: 1, stdout: '' };
			}
			return originalRunGit(cwd, args, options);
		};

		const interrupted = await restore();
		expect(interrupted).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_APPLY_FAILED',
		});
		expect(await readText('a.txt')).toBe('a1\n');
		expect(await readText('b.txt')).not.toBe('b1\n');

		_internals.runGit = originalRunGit;
		const resumed = await restore();
		expect(resumed).toMatchObject({ success: true, restored: true });
		expect(resumed.stash_oids).toEqual(
			expect.arrayContaining([first.stash_oid, second.stash_oid]),
		);
		expect(await readText('a.txt')).toBe('a1\n');
		expect(await readText('b.txt')).toBe('b1\n');
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([]);
	});

	test('cleans a verified stale receipt before restoring a later receipt to an advanced branch (CS-2164-002)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'a1\n');
		const first = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		_internals.removeCheckoutRestoreReceipt = async () => {
			throw new Error('simulated unlink failure');
		};

		const firstRestore = await restore();
		expect(firstRestore).toMatchObject({
			success: true,
			restored: true,
			receipt_cleanup_pending: true,
		});
		_internals.removeCheckoutRestoreReceipt =
			originalRemoveCheckoutRestoreReceipt;
		await git(['add', 'a.txt']);
		await git(['commit', '-m', 'advance after verified restore']);
		const advancedHead = await git(['rev-parse', 'HEAD']);
		await fs.writeFile(path.join(directory, 'b.txt'), 'b1\n');
		const second = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await git(['switch', '--detach', prHead]);

		const secondRestore = await restore();
		expect(secondRestore).toMatchObject({
			success: true,
			restored: true,
			restored_head: advancedHead,
		});
		expect(secondRestore.stash_oids).toEqual(
			expect.arrayContaining([first.stash_oid, second.stash_oid]),
		);
		expect(await readText('a.txt')).toBe('a1\n');
		expect(await readText('b.txt')).toBe('b1\n');
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([]);
	});

	test('rejects a missing stash before changing the current checkout (CS-2164-002)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'target\n');
		await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		await git(['stash', 'drop', 'stash@{0}']);
		const beforeHead = await git(['rev-parse', 'HEAD']);
		const beforeBranch = await git(['branch', '--show-current']);

		const blocked = await restore();
		expect(blocked).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_STASH_MISSING',
		});
		expect(await git(['rev-parse', 'HEAD'])).toBe(beforeHead);
		expect(await git(['branch', '--show-current'])).toBe(beforeBranch);
	});

	test('applies by immutable OID and retains every stash across reflog renumbering (CS-2164-003)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'target\n');
		const prepared = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await fs.writeFile(path.join(directory, 'b.txt'), 'race\n');
		await git(['stash', 'push', '--message=race']);
		const raceOid = await git(['rev-parse', 'stash@{0}']);
		await git(['switch', '--detach', prHead]);
		const appliedArgs: string[][] = [];
		_internals.runGit = async (cwd, args, options) => {
			if (args[0] === 'stash' && args[1] === 'apply')
				appliedArgs.push([...args]);
			return originalRunGit(cwd, args, options);
		};

		const result = await restore();
		expect(result).toMatchObject({ success: true, restored: true });
		expect(appliedArgs).toEqual([
			['stash', 'apply', '--index', prepared.stash_oid],
		]);
		const remaining = await git(['stash', 'list', '--format=%H']);
		expect(remaining).toContain(prepared.stash_oid);
		expect(remaining).toContain(raceOid);
		expect(await readText('a.txt')).toBe('target\n');
	});

	test('retains applied receipts when final checkout verification fails (CS-2164-002)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'target\n');
		const prepared = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		let applied = false;
		_internals.runGit = async (cwd, args, options) => {
			const result = await originalRunGit(cwd, args, options);
			if (args[0] === 'stash' && args[1] === 'apply' && result.exitCode === 0) {
				applied = true;
				return result;
			}
			if (applied && args.join(' ') === 'rev-parse --verify HEAD^0') {
				return { exitCode: 1, stdout: '' };
			}
			return result;
		};

		const result = await restore();
		expect(result.success).toBe(false);
		const receiptPath = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
			`${prepared.stash_oid}.json`,
		);
		expect(JSON.parse(await fs.readFile(receiptPath, 'utf8'))).toMatchObject({
			restoreState: 'applied',
		});

		_internals.runGit = originalRunGit;
		const retried = await restore();
		expect(retried).toMatchObject({ success: true, restored: true });
		await expect(fs.readFile(receiptPath, 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(await restore()).toMatchObject({
			success: true,
			already_restored: true,
		});
	});

	test('reports only stashes observed after final verification (CS-2164-003)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'target\n');
		const prepared = await prepare('PR_REVIEW');
		await abort('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		_internals.runGit = async (cwd, args, options) => {
			const result = await originalRunGit(cwd, args, options);
			if (args[0] === 'stash' && args[1] === 'apply' && result.exitCode === 0) {
				const inventory = await git(['stash', 'list', '--format=%gd%x00%H']);
				const selector = inventory
					.split(/\r?\n/)
					.map((line) => line.split('\0'))
					.find((parts) => parts[1] === prepared.stash_oid)?.[0];
				expect(selector).toBeDefined();
				await git(['stash', 'drop', selector!]);
			}
			return result;
		};

		const result = await restore();
		expect(result).toMatchObject({
			success: true,
			retained_stash_oids: [],
			stash_retained: false,
			stash_retention_verified: true,
		});
	});

	test('restores discovery-mode untracked files end to end (TINF-2164-001)', async () => {
		await fs.writeFile(path.join(directory, 'untracked.txt'), 'preserved\n');
		await prepare('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		await abort('PR_REVIEW');

		const result = await restore();
		expect(result).toMatchObject({ success: true, restored: true });
		expect(await readText('untracked.txt')).toBe('preserved\n');
	});

	test('returns to an originally detached checkout exactly (TINF-2164-001)', async () => {
		await git(['switch', '--detach', baseHead]);
		await fs.writeFile(path.join(directory, 'a.txt'), 'detached\n');
		await prepare('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		await abort('PR_REVIEW');

		const result = await restore();
		expect(result).toMatchObject({
			success: true,
			restored: true,
			original_branch: null,
			restored_head: baseHead,
		});
		expect(await git(['branch', '--show-current'])).toBe('');
		expect(await git(['rev-parse', 'HEAD'])).toBe(baseHead);
	});

	test('refuses checkout mutation while another session gate is active (CONC-001)', async () => {
		await fs.writeFile(path.join(directory, 'a.txt'), 'preserved\n');
		const prepared = await prepare('PR_REVIEW');
		await git(['switch', '--detach', prHead]);
		await abort('PR_REVIEW');
		await activatePrWorkflow(directory, 'other-live-session', 'PR_REVIEW');

		const result = await restore();
		expect(result).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_OTHER_SESSION_ACTIVE',
		});
		expect(await git(['rev-parse', 'HEAD'])).toBe(prHead);
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
	});
});
