import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleAbortPrWorkflowCommand } from '../../src/commands/abort-pr-workflow.js';
import { COMMAND_REGISTRY } from '../../src/commands/registry.js';
import { closeAllProjectDbs, getProjectDb } from '../../src/db/project-db.js';
import {
	activatePrWorkflow,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../src/hooks/pr-workflow-gate.js';
import { workflowGateStateRelativePath } from '../../src/pr-review/persistence.js';
import { resetSwarmState } from '../../src/state.js';
import {
	_internals as checkoutInternals,
	executePreparePrWorkflowCheckout,
	listPendingPrWorkflowCheckoutRestores,
} from '../../src/tools/prepare-pr-workflow-checkout.js';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host.js';

const OWNER_SESSION = 'ac7-deleted-owner';
const RESTORER_SESSION = 'ac7-cross-session-restorer';
const FOREIGN_SESSION = 'ac7-foreign-live-owner';
const CORRUPT_SESSION = 'ac7-corrupt-retained-owner';
const MISSING_STASH_OID = 'a'.repeat(40);

type CheckoutResult = {
	success: boolean;
	code?: string;
	status?: string;
	recoverable?: boolean;
	already_restored?: boolean;
	restored?: boolean;
	message?: string;
};

let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>> | undefined;
const originalRunGit = checkoutInternals.runGit;

async function git(args: string[]): Promise<string> {
	const result = await originalRunGit(directory, args, { captureStdout: true });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function checkoutResult(value: unknown): CheckoutResult {
	return JSON.parse(String(value)) as CheckoutResult;
}

async function prepareRestore(sessionID: string): Promise<CheckoutResult> {
	return checkoutResult(
		await plugin?.tool.prepare_pr_workflow_checkout.execute(
			{ operation: 'restore' },
			{ directory, sessionID },
		),
	);
}

beforeEach(async () => {
	resetSwarmState();
	directory = createKnowledgeProject();
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'ac7@example.com']);
	await git(['config', 'user.name', 'AC7 Acceptance']);
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	plugin = await bootKnowledgeHost(directory);
	await git(['add', '.']);
	await git(['commit', '-m', 'ac7 acceptance fixture']);
});

afterEach(async () => {
	try {
		await plugin?.hooks.dispose?.();
	} catch {
		// The fixture teardown below remains best-effort if a host dispose hook fails.
	}
	plugin = undefined;
	checkoutInternals.runGit = originalRunGit;
	closeAllProjectDbs();
	resetSwarmState();
	try {
		await fs.rm(directory, { recursive: true, force: true });
	} catch {
		// Windows may briefly retain a plugin-init handle in the temp project.
	}
});

describe('PR workflow lifecycle composite acceptance (issue #2602 AC7)', () => {
	test('reaps the owner, preserves the foreign gate, and exposes bounded recovery truth', async () => {
		await activatePrWorkflow(directory, OWNER_SESSION, 'PR_REVIEW');

		// Use both host terminal lifecycle variants at the real plugin event boundary.
		await plugin?.hooks.event({
			event: {
				type: 'session.deleted',
				properties: { sessionID: OWNER_SESSION },
			},
		});
		await plugin?.hooks.event({
			event: {
				type: 'session.removed',
				properties: { sessionID: OWNER_SESSION },
			},
		});

		const reapedOwnerState = await readPrWorkflowGateState(
			directory,
			OWNER_SESSION,
		);
		expect(reapedOwnerState).toBeNull();
		const crossSessionRestore = await prepareRestore(RESTORER_SESSION);
		expect(crossSessionRestore).toMatchObject({
			success: true,
			already_restored: true,
		});

		// Pin one bounded, missing-stash receipt to the owner session. Its typed
		// incomplete result is truthfully recoverable and does not claim restoration.
		const originalHead = await git(['rev-parse', 'HEAD']);
		const receiptDirectory = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(OWNER_SESSION),
		);
		await fs.mkdir(receiptDirectory, { recursive: true });
		await fs.writeFile(
			path.join(receiptDirectory, `${MISSING_STASH_OID}.json`),
			JSON.stringify({
				schemaVersion: 1,
				sessionID: OWNER_SESSION,
				stashOid: MISSING_STASH_OID,
				originalHead,
				originalBranch: 'main',
				paths: ['.opencode/opencode-swarm.json'],
				preparedAt: '2026-08-14T00:00:00.000Z',
				mode: 'PR_REVIEW',
				gateRevision: 0,
				gateActivatedAt: '2026-08-14T00:00:00.000Z',
			}),
		);
		const missingStashRestore = await prepareRestore(OWNER_SESSION);
		expect(missingStashRestore).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_STASH_MISSING',
			status: 'incomplete',
			recoverable: true,
		});
		expect(missingStashRestore.restored).toBeUndefined();
		expect(
			await listPendingPrWorkflowCheckoutRestores(directory, OWNER_SESSION),
		).toEqual([{ stash_oid: MISSING_STASH_OID, stash_present: false }]);

		await activatePrWorkflow(directory, FOREIGN_SESSION, 'PR_FEEDBACK');
		const preservedForeignState = await readPrWorkflowGateState(
			directory,
			FOREIGN_SESSION,
		);
		expect(preservedForeignState).toMatchObject({
			sessionID: FOREIGN_SESSION,
			mode: 'PR_FEEDBACK',
		});
		const blockedByForeignGate = await prepareRestore(RESTORER_SESSION);
		expect(blockedByForeignGate.success).toBeFalse();
		expect(blockedByForeignGate.message).toContain(FOREIGN_SESSION);
		const foreignGateFilename = `${prWorkflowSessionFileStem(FOREIGN_SESSION)}.json`;
		expect(blockedByForeignGate.message).toContain(foreignGateFilename);
		expect(blockedByForeignGate.message).toContain(
			'/swarm abort-pr-workflow PR_FEEDBACK',
		);

		await activatePrWorkflow(directory, CORRUPT_SESSION, 'PR_REVIEW');
		const offendingGatePath = path.join(
			directory,
			'.swarm',
			workflowGateStateRelativePath(CORRUPT_SESSION),
		);
		const offendingGateFilename = path.basename(offendingGatePath);
		expect(offendingGateFilename).toBe(
			`${prWorkflowSessionFileStem(CORRUPT_SESSION)}.json`,
		);
		const namespace = `pr-workflow.state:${prWorkflowSessionFileStem(CORRUPT_SESSION)}`;
		const db = getProjectDb(directory);
		expect(
			db
				.query<{ payload: string }, [string, string]>(
					'SELECT payload FROM coordination_state WHERE namespace = ? AND entity_key = ?',
				)
				.get(namespace, 'state')?.payload,
		).toBeTruthy();
		db.run(
			'UPDATE coordination_state SET payload = ? WHERE namespace = ? AND entity_key = ?',
			['{ retained coordination row is corrupt', namespace, 'state'],
		);

		// Keep the generated offending filename beside the executable recovery
		// instruction so an operator can copy the same command from the audit trail.
		const recoveryInstruction = `/swarm abort-pr-workflow PR_REVIEW recover ${offendingGateFilename}`;
		const humanRecoveryArgs = [
			'PR_REVIEW',
			'recover',
			offendingGateFilename,
			`using ${recoveryInstruction}`,
		];
		const humanRecovery = await handleAbortPrWorkflowCommand(
			directory,
			humanRecoveryArgs,
			CORRUPT_SESSION,
		);
		expect(humanRecovery).toContain('Aborted active PR_REVIEW');
		expect(humanRecovery).toContain('events.jsonl');
		const events = (
			await fs.readFile(path.join(directory, '.swarm', 'events.jsonl'), 'utf8')
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const abortEvent = events.find(
			(event) => event.type === 'pr_workflow_aborted',
		);
		expect(abortEvent).toMatchObject({ type: 'pr_workflow_aborted' });
		expect(String(abortEvent?.reason)).toContain(offendingGateFilename);
		expect(String(abortEvent?.reason)).toContain(recoveryInstruction);
		await expect(
			readPrWorkflowGateState(directory, CORRUPT_SESSION),
		).resolves.toBeNull();
		await expect(fs.stat(offendingGatePath)).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(
			getProjectDb(directory)
				.query(
					'SELECT payload FROM coordination_state WHERE namespace = ? AND entity_key = ?',
				)
				.get(namespace, 'state'),
		).toBeNull();
		const foreignAfterRecovery = await readPrWorkflowGateState(
			directory,
			FOREIGN_SESSION,
		);
		expect(foreignAfterRecovery).toMatchObject({
			sessionID: FOREIGN_SESSION,
			mode: 'PR_FEEDBACK',
		});
	});

	test('advertises the explicit cancellation form on every human help surface', async () => {
		const handlerUsage = await handleAbortPrWorkflowCommand(
			directory,
			['PR_FEEDBACK', '--cancel-publication'],
			'ac7-help-surface',
		);
		expect(handlerUsage).toContain('--cancel-publication');
		expect(handlerUsage).toContain('reason');

		const registryEntry = COMMAND_REGISTRY['abort-pr-workflow'];
		expect(registryEntry.description).toContain('--cancel-publication');
		expect(registryEntry.description).toContain(
			'cancelled_without_publication',
		);
		expect(registryEntry.args).toContain('--cancel-publication');
		expect(registryEntry.args).toContain('reason');
		expect(registryEntry.details).toContain('--cancel-publication');
		expect(registryEntry.details).toContain('cancelled_without_publication');

		const config: Record<string, unknown> = {};
		await plugin?.hooks.config(config);
		const registered = (
			(config.command ?? {}) as Record<string, { description?: string }>
		)['swarm-abort-pr-workflow'];
		expect(registered?.description).toContain('--cancel-publication');
	});
});
