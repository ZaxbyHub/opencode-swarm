import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../src/db/project-db.js';
import {
	appendCoreEventSync,
	readCoreEvents,
} from '../../src/events/core-events.js';
import {
	activatePrWorkflow,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../src/hooks/pr-workflow-gate.js';
import { resetSwarmState } from '../../src/state.js';
import {
	_internals as checkoutInternals,
	listPendingPrWorkflowCheckoutRestores,
	reconcilePrWorkflowCheckoutReceipts,
} from '../../src/tools/prepare-pr-workflow-checkout.js';
import { bootKnowledgeHost } from '../helpers/knowledge-real-host.js';
import { canonicalMkdtemp } from '../helpers/tmpdir.js';

const OWNER_SESSION = 'checkout-deletion-owner-2602';
const FOREIGN_SESSION = 'checkout-deletion-foreign-2602';
const MISSING_STASH_OID = 'a'.repeat(40);

let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>> | undefined;
const originalRunGit = checkoutInternals.runGit;
const originalAppendCoreEventSync = checkoutInternals.appendCoreEventSync;
const originalRemoveReceipt = checkoutInternals.removeCheckoutRestoreReceipt;

async function git(args: string[]): Promise<string> {
	const result = await originalRunGit(directory, args, { captureStdout: true });
	if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
	return result.stdout.trim();
}

async function initializeGitProject(): Promise<void> {
	directory = canonicalMkdtemp('pr-workflow-checkout-deletion-2602-');
	await fs.mkdir(path.join(directory, '.swarm'), { recursive: true });
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'checkout-2602@example.com']);
	await git(['config', 'user.name', 'Checkout 2602']);
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.writeFile(path.join(directory, 'README.md'), 'checkout lifecycle\n');
	await git(['add', 'README.md']);
	await git(['commit', '-m', 'initial checkout lifecycle fixture']);
}

async function createStash(label: string, message: string): Promise<string> {
	await fs.writeFile(path.join(directory, `${label}.txt`), `${label}\n`);
	await git(['stash', 'push', '--include-untracked', '--message', message]);
	return git(['rev-parse', 'stash@{0}']);
}

async function writeReceipt(
	sessionID: string,
	stashOid: string,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const receiptDirectory = path.join(
		directory,
		'.swarm',
		'pr-workflow-checkouts',
		prWorkflowSessionFileStem(sessionID),
	);
	await fs.mkdir(receiptDirectory, { recursive: true });
	const originalHead = await git(['rev-parse', 'HEAD']);
	await fs.writeFile(
		path.join(receiptDirectory, `${stashOid}.json`),
		JSON.stringify({
			schemaVersion: 1,
			sessionID,
			stashOid,
			originalHead,
			originalBranch: 'main',
			paths: ['README.md'],
			preparedAt: '2026-08-14T00:00:00.000Z',
			mode: 'PR_REVIEW',
			gateRevision: 1,
			gateActivatedAt: '2026-08-14T00:00:00.000Z',
			...overrides,
		}),
	);
}

async function writeMissingReceipt(sessionID = FOREIGN_SESSION): Promise<void> {
	await writeReceipt(sessionID, MISSING_STASH_OID);
}

async function waitForPendingCheckoutRestoresToClear(
	sessionID: string,
): Promise<Awaited<ReturnType<typeof listPendingPrWorkflowCheckoutRestores>>> {
	let pending = await listPendingPrWorkflowCheckoutRestores(
		directory,
		sessionID,
	);
	for (let attempt = 0; pending.length > 0 && attempt < 40; attempt += 1) {
		await Bun.sleep(50);
		pending = await listPendingPrWorkflowCheckoutRestores(directory, sessionID);
	}
	return pending;
}

beforeEach(async () => {
	plugin = undefined;
	resetSwarmState();
	await initializeGitProject();
});

afterEach(async () => {
	checkoutInternals.runGit = originalRunGit;
	checkoutInternals.appendCoreEventSync = originalAppendCoreEventSync;
	checkoutInternals.removeCheckoutRestoreReceipt = originalRemoveReceipt;
	try {
		await plugin?.hooks.dispose?.();
	} catch {
		// Best-effort plugin teardown; receipt assertions already completed.
	}
	plugin = undefined;
	closeAllProjectDbs();
	resetSwarmState();
	try {
		await fs.rm(directory, { recursive: true, force: true });
	} catch {
		// Windows can briefly retain a plugin-init handle.
	}
});

describe('PR workflow checkout deletion lifecycle (issue #2602)', () => {
	test('session.deleted preserves the owner safety stash and other stashes', async () => {
		plugin = await bootKnowledgeHost(directory);
		await git(['add', '.']);
		await git(['commit', '-m', 'plugin fixture']);
		const ownerStashOid = await createStash(
			'owner-marked',
			'pr-workflow-checkout-owner-2602',
		);
		const foreignStashOid = await createStash(
			'foreign-marked',
			'pr-workflow-checkout-foreign-2602',
		);
		const ordinaryStashOid = await createStash(
			'ordinary-user',
			'user-created stash unrelated to PR workflow',
		);
		const head = await git(['rev-parse', 'HEAD']);
		await writeReceipt(OWNER_SESSION, ownerStashOid, {
			restoreState: 'applied',
			restoreAppliedAt: '2026-08-14T00:01:00.000Z',
			restoreVerifiedAt: '2026-08-14T00:02:00.000Z',
			restoredHead: head,
			restoredBranch: 'main',
		});
		await writeReceipt(FOREIGN_SESSION, foreignStashOid);
		await activatePrWorkflow(directory, OWNER_SESSION, 'PR_REVIEW');

		await plugin.hooks.event({
			event: {
				type: 'session.deleted',
				properties: { sessionID: OWNER_SESSION },
			},
		});

		expect(await readPrWorkflowGateState(directory, OWNER_SESSION)).toBeNull();
		expect(await waitForPendingCheckoutRestoresToClear(OWNER_SESSION)).toEqual(
			[],
		);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, FOREIGN_SESSION),
		).toEqual([{ stash_oid: foreignStashOid, stash_present: true }]);
		const stashes = await git(['stash', 'list', '--format=%H']);
		// Verified safety stashes are intentionally retained because Git has no
		// atomic identity-bound deletion for a non-top stash entry.
		expect(stashes).toContain(ownerStashOid);
		expect(stashes).toContain(foreignStashOid);
		expect(stashes).toContain(ordinaryStashOid);

		// Replaying the deletion event must not disturb the foreign receipt or stash.
		await plugin.hooks.event({
			event: {
				type: 'session.removed',
				properties: { sessionID: OWNER_SESSION },
			},
		});
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, FOREIGN_SESSION),
		).toEqual([{ stash_oid: foreignStashOid, stash_present: true }]);
	});

	test('missing receipt evidence is appended before exact receipt deletion', async () => {
		await writeMissingReceipt();
		const calls: string[] = [];
		checkoutInternals.appendCoreEventSync = (cwd, event, options) => {
			calls.push('append');
			originalAppendCoreEventSync(cwd, event, options);
		};
		checkoutInternals.removeCheckoutRestoreReceipt = async (receiptPath) => {
			calls.push('delete');
			return originalRemoveReceipt(receiptPath);
		};

		const summary = await reconcilePrWorkflowCheckoutReceipts(
			directory,
			FOREIGN_SESSION,
		);

		expect(summary).toMatchObject({
			retiredMissingStashOids: [MISSING_STASH_OID],
			preservedStashOids: [],
			failures: [],
		});
		expect(calls).toEqual(['append', 'delete']);
		expect(readCoreEvents(directory).text).toContain(
			'"type":"pr_workflow_checkout_stash_missing"',
		);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, FOREIGN_SESSION),
		).toEqual([]);
	});

	test('failed evidence append preserves the receipt and reports preservation', async () => {
		await writeMissingReceipt();
		const calls: string[] = [];
		checkoutInternals.appendCoreEventSync = () => {
			calls.push('append');
			throw new Error('injected evidence failure');
		};
		checkoutInternals.removeCheckoutRestoreReceipt = async () => {
			calls.push('delete');
			throw new Error('delete must not run');
		};

		const summary = await reconcilePrWorkflowCheckoutReceipts(
			directory,
			FOREIGN_SESSION,
		);

		expect(summary.preservedStashOids).toEqual([MISSING_STASH_OID]);
		expect(summary.failures).toHaveLength(1);
		expect(calls).toEqual(['append']);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, FOREIGN_SESSION),
		).toEqual([{ stash_oid: MISSING_STASH_OID, stash_present: false }]);
	});

	test('failed receipt deletion preserves the receipt and reports preservation', async () => {
		await writeMissingReceipt();
		const calls: string[] = [];
		checkoutInternals.appendCoreEventSync = (...args) => {
			calls.push('append');
			return originalAppendCoreEventSync(...args);
		};
		checkoutInternals.removeCheckoutRestoreReceipt = async () => {
			calls.push('delete');
			throw new Error('injected receipt deletion failure');
		};

		const summary = await reconcilePrWorkflowCheckoutReceipts(
			directory,
			FOREIGN_SESSION,
		);

		expect(summary.preservedStashOids).toEqual([MISSING_STASH_OID]);
		expect(summary.failures).toHaveLength(1);
		expect(calls).toEqual(['append', 'delete']);
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, FOREIGN_SESSION),
		).toEqual([{ stash_oid: MISSING_STASH_OID, stash_present: false }]);
	});
});
