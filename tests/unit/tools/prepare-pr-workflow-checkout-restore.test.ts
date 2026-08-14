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

const SESSION_ID = 'checkout-restore';
let directory = '';
let prHead = '';
const originalRunGit = _internals.runGit;
const originalRemoveReceipt = _internals.removeCheckoutRestoreReceipt;

async function git(args: string[]): Promise<string> {
	const result = await originalRunGit(directory, args, { captureStdout: true });
	if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
	return result.stdout.trim();
}

async function prepareAndAbort(): Promise<{ stash_oid: string }> {
	await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":true}\n');
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	const prepared = JSON.parse(
		await executePreparePrWorkflowCheckout({}, directory, {
			sessionID: SESSION_ID,
		}),
	);
	expect(prepared).toMatchObject({ success: true });
	await git(['switch', '--detach', prHead]);
	const aborted = JSON.parse(
		await executeAbortPrWorkflow(
			{
				mode: 'PR_REVIEW',
				kind: 'recovery',
				reason: 'bounded retry exhausted',
			},
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
		expect(prepared).toMatchObject({ success: true });
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
			retained_stash_oids: [prepared.stash_oid],
			stash_retained: true,
			stash_retention_verified: true,
		});
		expect(await git(['branch', '--show-current'])).toBe('main');
		expect(
			(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).replace(
				/\r\n/g,
				'\n',
			),
		).toBe('{"dirty":true}\n');
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
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

	test('refuses a dirty destination before switching or applying', async () => {
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

	test('keeps the stash and receipt when immutable stash apply fails (TINF-2164-002)', async () => {
		const prepared = await prepareAndAbort();
		const receiptPath = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
			`${prepared.stash_oid}.json`,
		);
		_internals.runGit = async (cwd, args, options) => {
			if (args[0] === 'stash' && args[1] === 'apply') {
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
			code: 'CHECKOUT_RESTORE_APPLY_FAILED',
		});
		_internals.runGit = originalRunGit;
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
		expect(JSON.parse(await fs.readFile(receiptPath, 'utf8'))).toMatchObject({
			stashOid: prepared.stash_oid,
		});
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
		expect(await git(['stash', 'list', '--format=%H'])).toContain(stashOid);
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
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			prepared.stash_oid,
		);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([{ stash_oid: prepared.stash_oid, stash_present: true }]);

		// Simulate normal work after the successful restore. Applied-state receipt
		// cleanup must not require the checkout identity to remain frozen.
		await git(['add', 'config.json']);
		await git(['commit', '-m', 'advance after restore']);
		await git(['stash', 'drop', 'stash@{0}']);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([{ stash_oid: prepared.stash_oid, stash_present: false }]);

		// Previous code left a phantom obligation forever after unlink contention.
		_internals.removeCheckoutRestoreReceipt = originalRemoveReceipt;
		const cleaned = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(cleaned).toMatchObject({
			success: true,
			restored: true,
			receipt_cleanup_pending: false,
			retained_stash_oids: [],
			stash_retained: false,
			stash_retention_verified: true,
		});
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([]);
	});

	test('rejects receipts whose schemaVersion is not exactly supported', async () => {
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		const stashOid = 'a'.repeat(40);
		await fs.writeFile(
			path.join(receiptDirectory, `${stashOid}.json`),
			JSON.stringify({ schemaVersion: 2, sessionID: SESSION_ID, stashOid }),
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
			code: 'CHECKOUT_RESTORE_RECEIPT_INVALID',
		});
	});

	test('bounds receipt bytes and rejects oversized JSON before parsing', async () => {
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		const stashOid = 'b'.repeat(40);
		await fs.writeFile(
			path.join(receiptDirectory, `${stashOid}.json`),
			JSON.stringify({ padding: 'x'.repeat(70_000) }),
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
			code: 'CHECKOUT_RESTORE_RECEIPT_INVALID',
		});
	});

	test('rejects non-string receipt paths at the durable boundary', async () => {
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		const stashOid = 'c'.repeat(40);
		const head = await git(['rev-parse', 'main']);
		await fs.writeFile(
			path.join(receiptDirectory, `${stashOid}.json`),
			JSON.stringify({
				schemaVersion: 1,
				sessionID: SESSION_ID,
				stashOid,
				originalHead: head,
				originalBranch: 'main',
				paths: [42],
				preparedAt: '2026-08-14T00:00:00.000Z',
				mode: 'PR_REVIEW',
				gateRevision: 1,
				gateActivatedAt: '2026-08-14T00:00:00.000Z',
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
			code: 'CHECKOUT_RESTORE_RECEIPT_INVALID',
		});
	});

	test('caps the receipt inventory before echoing or parsing entries', async () => {
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		for (let index = 0; index < 9; index++) {
			const stashOid = index.toString(16).padStart(40, '0');
			await fs.writeFile(path.join(receiptDirectory, `${stashOid}.json`), '{}');
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
			code: 'CHECKOUT_RESTORE_RECEIPT_LIMIT',
		});
		expect(blocked.message).not.toContain(
			'0000000000000000000000000000000000000008',
		);
	});

	test('bounds total receipt-directory entries before materializing invalid names', async () => {
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		for (let index = 0; index < 65; index++) {
			await fs.writeFile(path.join(receiptDirectory, `junk-${index}`), 'x');
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
			code: 'CHECKOUT_RESTORE_RECEIPT_LIMIT',
		});
		expect(blocked.message).toMatch(/64-entry bounded scan/i);
	});
});
