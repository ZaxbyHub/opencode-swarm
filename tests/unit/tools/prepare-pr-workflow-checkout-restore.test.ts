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
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'checkout-restore';
let directory = '';
let prHead = '';
const originalRunGit = _internals.runGit;
const originalRemoveReceipt = _internals.removeCheckoutRestoreReceipt;

async function git(args: string[]): Promise<string> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		if (exitCode !== 0) throw new Error(stderr || `git ${args[0]} failed`);
		return stdout.trim();
	} finally {
		try {
			proc.kill();
		} catch {
			// Git may already have exited.
		}
	}
}

async function prepareAndAbort(): Promise<{ stash_oid: string }> {
	await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":true}\n');
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	const prepared = JSON.parse(
		await executePreparePrWorkflowCheckout({}, directory, {
			sessionID: SESSION_ID,
		}),
	);
	expect(prepared.success).toBe(true);
	await git(['switch', '--detach', prHead]);
	const aborted = JSON.parse(
		await executeAbortPrWorkflow(
			{ mode: 'PR_REVIEW', reason: 'bounded retry exhausted' },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(aborted).toMatchObject({
		success: true,
		gate_cleared: true,
		checkout_restore_required: true,
		checkout_restore_receipts: [
			{ stash_oid: prepared.stash_oid, stash_present: true },
		],
	});
	return prepared;
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-workflow-restore-');
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'test@example.com']);
	await git(['config', 'user.name', 'Checkout Restore Test']);
	await fs.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":false}\n');
	await git(['add', '.']);
	await git(['commit', '-m', 'base']);
	await git(['switch', '-c', 'review-head']);
	await fs.writeFile(path.join(directory, 'review.txt'), 'review\n');
	await git(['add', 'review.txt']);
	await git(['commit', '-m', 'review']);
	prHead = await git(['rev-parse', 'HEAD']);
	await git(['switch', 'main']);
});

afterEach(async () => {
	_internals.runGit = originalRunGit;
	_internals.removeCheckoutRestoreReceipt = originalRemoveReceipt;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('prepare_pr_workflow_checkout restore operation', () => {
	test('refuses restoration while the workflow gate is still active', async () => {
		await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":true}\n');
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		const prepared = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		const blocked = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(blocked).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_GATE_ACTIVE',
		});
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
	});

	test('captures original checkout identity before creating any stash', async () => {
		await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":true}\n');
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		_internals.runGit = async (cwd, args, options) => {
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { exitCode: 1, stdout: '' };
			}
			return originalRunGit(cwd, args, options);
		};
		const blocked = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		expect(blocked.success).toBe(false);
		expect(blocked.message).toContain('no stash was created');
		_internals.runGit = originalRunGit;
		expect(await git(['stash', 'list'])).toBe('');
	});

	test('returns to the original branch and reapplies the exact preserved stash', async () => {
		const prepared = await prepareAndAbort();
		const receiptPath = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
			`${prepared.stash_oid}.json`,
		);
		const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
		expect(receipt).toMatchObject({
			originalBranch: 'main',
			originalHead: expect.stringMatching(/^[0-9a-f]{40,64}$/),
		});

		const restored = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(restored).toMatchObject({
			success: true,
			restored: true,
			stash_oid: prepared.stash_oid,
		});
		expect(await git(['branch', '--show-current'])).toBe('main');
		expect(
			(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).replace(
				/\r\n/g,
				'\n',
			),
		).toBe('{"dirty":true}\n');
		expect(await git(['stash', 'list'])).toBe('');
		await expect(fs.stat(receiptPath)).rejects.toMatchObject({
			code: 'ENOENT',
		});

		const repeated = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(repeated).toMatchObject({ success: true, already_restored: true });
	});

	test('refuses a dirty destination before switching or popping', async () => {
		const prepared = await prepareAndAbort();
		await fs.writeFile(path.join(directory, 'unrelated.txt'), 'do not move\n');
		const blocked = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore', stash_oid: prepared.stash_oid },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(blocked).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_NOT_CLEAN',
		});
		expect(await git(['rev-parse', 'HEAD'])).toBe(prHead);
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
	});

	test('keeps the stash and receipt when stash pop fails', async () => {
		const prepared = await prepareAndAbort();
		_internals.runGit = async (cwd, args, options) => {
			if (args[0] === 'stash' && args[1] === 'pop') {
				return { exitCode: 1, stdout: '' };
			}
			return originalRunGit(cwd, args, options);
		};
		const blocked = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(blocked).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_POP_FAILED',
		});
		_internals.runGit = originalRunGit;
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
	});

	test('restores a legacy receipt by deriving identity from the stash parent', async () => {
		await fs.writeFile(
			path.join(directory, 'config.json'),
			'{"legacy":true}\n',
		);
		await git(['stash', 'push', '--message=legacy']);
		const stashOid = await git(['rev-parse', 'stash@{0}']);
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		await fs.writeFile(
			path.join(receiptDirectory, `${stashOid}.json`),
			JSON.stringify({
				schemaVersion: 1,
				sessionID: SESSION_ID,
				stashOid,
				paths: ['config.json'],
				preparedAt: '2026-08-14T00:00:00.000Z',
				mode: 'PR_REVIEW',
				gateRevision: 1,
				gateActivatedAt: '2026-08-14T00:00:00.000Z',
			}),
		);
		await git(['switch', '--detach', prHead]);
		const restored = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(restored).toMatchObject({
			success: true,
			restored: true,
			original_branch: 'main',
		});
		expect(await git(['branch', '--show-current'])).toBe('main');
		expect(await git(['stash', 'list'])).toBe('');
		expect(
			(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).replace(
				/\r\n/g,
				'\n',
			),
		).toBe('{"legacy":true}\n');
	});

	test('reports success when verified restore receipt cleanup is delayed', async () => {
		const prepared = await prepareAndAbort();
		_internals.removeCheckoutRestoreReceipt = async () => {
			throw new Error('simulated unlink contention');
		};
		const restored = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(restored).toMatchObject({
			success: true,
			restored: true,
			stash_oid: prepared.stash_oid,
			receipt_cleanup_pending: true,
		});
		expect(await git(['branch', '--show-current'])).toBe('main');
		expect(await git(['stash', 'list'])).toBe('');
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([{ stash_oid: prepared.stash_oid, stash_present: false }]);
	});

	test('lists every exact stash oid when multiple receipts require selection', async () => {
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		const stashOids = ['a'.repeat(40), 'b'.repeat(40)];
		for (const stashOid of stashOids) {
			await fs.writeFile(
				path.join(receiptDirectory, `${stashOid}.json`),
				JSON.stringify({ schemaVersion: 1, sessionID: SESSION_ID, stashOid }),
			);
		}
		const blocked = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(blocked).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_RECEIPT_AMBIGUOUS',
		});
		for (const stashOid of stashOids) {
			expect(blocked.message).toContain(stashOid);
		}
	});
});
