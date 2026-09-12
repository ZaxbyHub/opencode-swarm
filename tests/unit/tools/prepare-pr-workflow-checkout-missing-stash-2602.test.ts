import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	prWorkflowSessionFileStem,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import {
	_internals as checkoutInternals,
	executePreparePrWorkflowCheckout,
	listPendingPrWorkflowCheckoutRestores,
} from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'checkout-missing-stash-2602';
const MISSING_RECEIPT_COUNT = 8;
let directory = '';
const originalRunGit = checkoutInternals.runGit;

async function git(args: string[]): Promise<string> {
	const result = await originalRunGit(directory, args, { captureStdout: true });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function writeMissingReceipts(): Promise<void> {
	const originalHead = await git(['rev-parse', 'HEAD']);
	const receiptDirectory = path.join(
		directory,
		'.swarm',
		'pr-workflow-checkouts',
		prWorkflowSessionFileStem(SESSION_ID),
	);
	await fs.mkdir(receiptDirectory, { recursive: true });
	for (let index = 0; index < MISSING_RECEIPT_COUNT; index += 1) {
		const stashOid = index.toString(16).repeat(40);
		await fs.writeFile(
			path.join(receiptDirectory, `${stashOid}.json`),
			JSON.stringify({
				schemaVersion: 1,
				sessionID: SESSION_ID,
				stashOid,
				originalHead,
				originalBranch: 'main',
				paths: ['.opencode/opencode-swarm.json'],
				preparedAt: `2026-08-14T00:0${index}:00.000Z`,
				mode: 'PR_REVIEW',
				gateRevision: index + 1,
				gateActivatedAt: '2026-08-14T00:00:00.000Z',
			}),
		);
	}
}

async function clearGate(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	const response = JSON.parse(
		await executeAbortPrWorkflow(
			{
				mode: 'PR_REVIEW',
				kind: 'recovery',
				reason: 'prepare missing-stash receipt acceptance fixture',
			},
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(response).toMatchObject({ success: true, gate_cleared: true });
}

async function writeMissingVerifiedReceipt(): Promise<string> {
	const originalHead = await git(['rev-parse', 'HEAD']);
	const stashOid = 'f'.repeat(40);
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
			originalHead,
			originalBranch: 'main',
			paths: ['.opencode/opencode-swarm.json'],
			preparedAt: '2026-08-14T00:00:00.000Z',
			mode: 'PR_REVIEW',
			gateRevision: 1,
			gateActivatedAt: '2026-08-14T00:00:00.000Z',
			restoreState: 'applied',
			restoreAppliedAt: '2026-08-14T00:01:00.000Z',
			restoreVerifiedAt: '2026-08-14T00:02:00.000Z',
			restoredHead: originalHead,
			restoredBranch: 'main',
		}),
	);
	return stashOid;
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-workflow-checkout-missing-2602-');
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'test@example.com']);
	await git(['config', 'user.name', 'Missing Stash Test']);
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":true}\n',
	);
	await git(['add', '.']);
	await git(['commit', '-m', 'initial']);
});

afterEach(async () => {
	checkoutInternals.runGit = originalRunGit;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('prepare_pr_workflow_checkout missing stash recovery (issue #2602)', () => {
	test('returns typed incomplete recovery and leaves the receipt cap usable', async () => {
		await writeMissingReceipts();
		await clearGate();

		const restored = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		// Before #2602, this was an untyped false result and every missing receipt
		// permanently blocked future preparation at the active receipt limit.
		expect(restored).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_STASH_MISSING',
			status: 'incomplete',
			recoverable: true,
		});
		expect(restored.restored).toBeUndefined();
		expect(restored.already_restored).toBeUndefined();

		const inventory = await listPendingPrWorkflowCheckoutRestores(
			directory,
			SESSION_ID,
		);
		expect(inventory).toHaveLength(MISSING_RECEIPT_COUNT);
		expect(inventory.every((entry) => entry.stash_present === false)).toBe(
			true,
		);

		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		const prepared = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(prepared).toMatchObject({ success: true });
	});

	test('reports a missing verified safety stash as incomplete and keeps its receipt pending', async () => {
		const stashOid = await writeMissingVerifiedReceipt();
		await clearGate();

		const restored = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(restored).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_STASH_MISSING',
			status: 'incomplete',
			recoverable: true,
			missing_stash_oids: [stashOid],
		});
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
		).toEqual([{ stash_oid: stashOid, stash_present: false }]);
	});
});
