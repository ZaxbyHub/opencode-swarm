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

const VERIFIED_SESSION = 'checkout-gc-verified-2602';
const PENDING_SESSION = 'checkout-gc-pending-2602';
let directory = '';
const originalRunGit = checkoutInternals.runGit;

async function git(args: string[]): Promise<string> {
	const result = await originalRunGit(directory, args, { captureStdout: true });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function createMarkedStash(label: string): Promise<string> {
	const file = `${label}.txt`;
	await fs.writeFile(path.join(directory, file), `${label}\n`);
	await git([
		'stash',
		'push',
		'--include-untracked',
		'--message',
		`pr-workflow-checkout-${label}`,
	]);
	return git(['rev-parse', 'stash@{0}']);
}

async function createOrdinaryUserStash(): Promise<string> {
	await fs.writeFile(path.join(directory, 'user-stash.txt'), 'keep me\n');
	await git([
		'stash',
		'push',
		'--include-untracked',
		'--message',
		'user-created stash unrelated to PR workflow',
	]);
	return git(['rev-parse', 'stash@{0}']);
}

async function writeReceipt(
	sessionID: string,
	stashOid: string,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const originalHead = await git(['rev-parse', 'HEAD']);
	const receiptDirectory = path.join(
		directory,
		'.swarm',
		'pr-workflow-checkouts',
		prWorkflowSessionFileStem(sessionID),
	);
	await fs.mkdir(receiptDirectory, { recursive: true });
	await fs.writeFile(
		path.join(receiptDirectory, `${stashOid}.json`),
		JSON.stringify({
			schemaVersion: 1,
			sessionID,
			stashOid,
			originalHead,
			originalBranch: 'main',
			paths: ['.opencode/opencode-swarm.json'],
			preparedAt: '2026-08-14T00:00:00.000Z',
			mode: 'PR_REVIEW',
			gateRevision: 1,
			gateActivatedAt: '2026-08-14T00:00:00.000Z',
			...overrides,
		}),
	);
}

async function clearGate(sessionID: string): Promise<void> {
	await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
	const response = JSON.parse(
		await executeAbortPrWorkflow(
			{
				mode: 'PR_REVIEW',
				kind: 'recovery',
				reason: 'prepare receipt GC acceptance fixture',
			},
			directory,
			{ sessionID },
		),
	);
	expect(response).toMatchObject({ success: true, gate_cleared: true });
}

async function createVerifiedReceipt(): Promise<string> {
	const stashOid = await createMarkedStash(VERIFIED_SESSION);
	await writeReceipt(VERIFIED_SESSION, stashOid, {
		restoreState: 'applied',
		restoreAppliedAt: '2026-08-14T00:01:00.000Z',
		restoreVerifiedAt: '2026-08-14T00:02:00.000Z',
		restoredHead: await git(['rev-parse', 'HEAD']),
		restoredBranch: 'main',
	});
	await clearGate(VERIFIED_SESSION);
	return stashOid;
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-workflow-checkout-gc-2602-');
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'test@example.com']);
	await git(['config', 'user.name', 'Checkout GC Test']);
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

describe('prepare_pr_workflow_checkout receipt GC (issue #2602)', () => {
	test('collects verified-restored stashes but preserves a pending present stash', async () => {
		const pendingStashOid = await createMarkedStash(PENDING_SESSION);
		const verifiedStashOid = await createMarkedStash(VERIFIED_SESSION);
		const ordinaryUserStashOid = await createOrdinaryUserStash();
		await writeReceipt(PENDING_SESSION, pendingStashOid);
		await writeReceipt(VERIFIED_SESSION, verifiedStashOid, {
			restoreState: 'applied',
			restoreAppliedAt: '2026-08-14T00:01:00.000Z',
			restoreVerifiedAt: '2026-08-14T00:02:00.000Z',
			restoredHead: await git(['rev-parse', 'HEAD']),
			restoredBranch: 'main',
		});
		await clearGate(PENDING_SESSION);
		await clearGate(VERIFIED_SESSION);

		// Before #2602, verified receipt cleanup deleted only the receipt and left
		// its retained pr-workflow-checkout stash indefinitely. Pending receipts must
		// remain recoverable and must never be collected while their stash is present.
		const restored = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: VERIFIED_SESSION },
			),
		);
		expect(restored).toMatchObject({
			success: true,
			restored: true,
			stash_oid: verifiedStashOid,
			retained_stash_oids: [],
			stash_retained: false,
			stash_retention_verified: true,
		});
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, VERIFIED_SESSION),
		).toEqual([]);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, PENDING_SESSION),
		).toEqual([{ stash_oid: pendingStashOid, stash_present: true }]);
		const stashes = await git(['stash', 'list', '--format=%H']);
		expect(stashes).not.toContain(verifiedStashOid);
		expect(stashes).toContain(pendingStashOid);
		expect(stashes).toContain(ordinaryUserStashOid);
	});

	test('keeps the verified receipt when exact stash collection fails', async () => {
		const verifiedStashOid = await createVerifiedReceipt();
		checkoutInternals.runGit = async (cwd, args, options) => {
			if (args[0] === 'stash' && args[1] === 'drop') {
				return { exitCode: 1, stdout: '' };
			}
			return originalRunGit(cwd, args, options);
		};

		const restored = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ operation: 'restore' },
				directory,
				{ sessionID: VERIFIED_SESSION },
			),
		);
		// A failed exact drop must not retire the only receipt that identifies the
		// retained safety stash. Whether cleanup is surfaced as a recoverable error
		// or a successful restore with pending cleanup, the evidence stays durable.
		if (restored.success === true) {
			expect(restored).toMatchObject({
				stash_retained: true,
				retained_stash_oids: expect.arrayContaining([verifiedStashOid]),
			});
		}
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, VERIFIED_SESSION),
		).toEqual([{ stash_oid: verifiedStashOid, stash_present: true }]);
		expect(await git(['stash', 'list', '--format=%H'])).toContain(
			verifiedStashOid,
		);
	});
});
