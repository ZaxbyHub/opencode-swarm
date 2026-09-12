import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import {
	getOpenProjectDbCount,
	getProjectDb,
} from '../../src/db/project-db.js';
import { readCoreEvents } from '../../src/events/core-events.js';
import {
	_test_exports,
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../../src/hooks/pr-workflow-gate.js';
import {
	readPrWorkflowGateStateCoordinationForRecovery,
	terminalizePrWorkflowGateForSession,
	workflowGateStatePath,
} from '../../src/pr-review/persistence.js';
import { resetSwarmState } from '../../src/state.js';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host.js';

const OWNER_SESSION_ID = 'deleted-owner-session';
const RESTORING_SESSION_ID = 'checkout-restorer-session';
const FOREIGN_SESSION_ID = 'foreign-active-session';

describe('PR workflow session lifecycle — regression: deleted owner cleanup and foreign-gate preservation (F-2602-AC1/AC2)', () => {
	let directory: string;
	let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;

	beforeEach(async () => {
		resetSwarmState();
		_test_exports.resetTrackedStateCache();
		directory = createKnowledgeProject();
		plugin = await bootKnowledgeHost(directory);
	});

	afterEach(async () => {
		await plugin?.hooks.dispose?.();
		expect(getOpenProjectDbCount()).toBe(0);
		_test_exports.resetTrackedStateCache();
		resetSwarmState();
		rmSync(directory, { recursive: true, force: true });
	});

	test('reaps only the deleted owner gate and leaves foreign restore blocked', async () => {
		await activatePrWorkflow(directory, OWNER_SESSION_ID, 'PR_REVIEW');

		const deletedEvent = {
			event: {
				type: 'session.deleted',
				properties: { sessionID: OWNER_SESSION_ID },
			},
		};
		await plugin.hooks.event(deletedEvent);

		// Before the fix, the event boundary cleared only in-memory scope
		// bindings; the durable owner gate remained and blocked this restore.
		expect(
			await readPrWorkflowGateState(directory, OWNER_SESSION_ID),
		).toBeNull();
		expect(readCoreEvents(directory).text).toContain(
			'"type":"pr_workflow_session_terminalized"',
		);
		expect(readCoreEvents(directory).text).toContain(
			`"sessionID":"${OWNER_SESSION_ID}"`,
		);

		// Replaying the host lifecycle event is harmless and must not recreate
		// or otherwise mutate the already-reaped owner state.
		await plugin.hooks.event(deletedEvent);
		expect(
			await readPrWorkflowGateState(directory, OWNER_SESSION_ID),
		).toBeNull();

		const restoreBeforeForeignGate = JSON.parse(
			String(
				await plugin.tool.prepare_pr_workflow_checkout.execute(
					{ operation: 'restore' },
					{ directory, sessionID: RESTORING_SESSION_ID },
				),
			),
		) as { success: boolean; already_restored?: boolean; message?: string };
		expect(restoreBeforeForeignGate).toMatchObject({
			success: true,
			already_restored: true,
		});

		await activatePrWorkflow(directory, FOREIGN_SESSION_ID, 'PR_FEEDBACK');
		expect(
			await readPrWorkflowGateState(directory, FOREIGN_SESSION_ID),
		).toMatchObject({
			sessionID: FOREIGN_SESSION_ID,
			mode: 'PR_FEEDBACK',
		});

		const restoreWithForeignGate = JSON.parse(
			String(
				await plugin.tool.prepare_pr_workflow_checkout.execute(
					{ operation: 'restore' },
					{ directory, sessionID: RESTORING_SESSION_ID },
				),
			),
		) as { success: boolean; message?: string };
		expect(restoreWithForeignGate.success).toBeFalse();
		expect(restoreWithForeignGate.message).toContain(FOREIGN_SESSION_ID);
	});

	test('does not resurrect authoritative state after a partial shadow unlink', async () => {
		await activatePrWorkflow(directory, OWNER_SESSION_ID, 'PR_REVIEW');
		const seam = _test_exports as typeof _test_exports & {
			removeShadowProjection?: (filePath: string) => Promise<void>;
		};
		let unlinkCount = 0;
		seam.removeShadowProjection = async (filePath) => {
			await fsp.rm(filePath, { force: true });
			unlinkCount += 1;
			if (unlinkCount === 1) throw new Error('injected marker unlink failure');
		};

		try {
			await expect(
				terminalizePrWorkflowGateForSession(directory, OWNER_SESSION_ID),
			).rejects.toThrow('injected marker unlink failure');
		} finally {
			delete seam.removeShadowProjection;
		}

		// The row remains authoritative, so a read repairs the missing live shadow
		// instead of importing a partially deleted legacy projection as new state.
		_test_exports.resetTrackedStateCache();
		expect(
			await readPrWorkflowGateState(directory, OWNER_SESSION_ID),
		).toMatchObject({ sessionID: OWNER_SESSION_ID, mode: 'PR_REVIEW' });
		const repairedShadow = await fsp.stat(
			workflowGateStatePath(directory, OWNER_SESSION_ID),
		);
		expect(repairedShadow.isFile()).toBeTrue();
	});

	test('rejects a concurrent terminalization CAS mutation and preserves the row', async () => {
		await activatePrWorkflow(directory, OWNER_SESSION_ID, 'PR_REVIEW');
		const seam = _test_exports as typeof _test_exports & {
			beforeTerminalizationDelete?: () => Promise<void>;
		};
		seam.beforeTerminalizationDelete = async () => {
			const db = getProjectDb(directory);
			const row = db
				.query<
					{
						namespace: string;
						revision: number;
						generation: number;
						payload: string;
					},
					[]
				>(
					`SELECT namespace, revision, generation, payload
					 FROM coordination_state WHERE entity_key = 'state'`,
				)
				.get();
			if (!row) throw new Error('CAS fixture could not find coordination row');
			const nextRevision = row.revision + 1;
			const payload = {
				...(JSON.parse(row.payload) as Record<string, unknown>),
				revision: nextRevision,
			};
			db.run(
				`UPDATE coordination_state
				 SET revision = ?, generation = ?, payload = ?
				 WHERE namespace = ? AND entity_key = ? AND revision = ?`,
				[
					nextRevision,
					nextRevision,
					JSON.stringify(payload),
					row.namespace,
					'state',
					row.revision,
				],
			);
		};

		try {
			await expect(
				terminalizePrWorkflowGateForSession(directory, OWNER_SESSION_ID),
			).rejects.toThrow('retry session terminalization');
		} finally {
			delete seam.beforeTerminalizationDelete;
		}
		expect(
			await readPrWorkflowGateState(directory, OWNER_SESSION_ID),
		).toMatchObject({ sessionID: OWNER_SESSION_ID, revision: 2 });
		expect(readCoreEvents(directory).text).not.toContain(
			'"type":"pr_workflow_session_terminalized"',
		);
	});

	test('bounds oversized raw coordination payloads before recovery parsing', async () => {
		await activatePrWorkflow(directory, OWNER_SESSION_ID, 'PR_REVIEW');
		const db = getProjectDb(directory);
		const oversizedPayload = JSON.stringify({
			payload: 'x'.repeat(1_048_576),
		});
		db.run(
			`UPDATE coordination_state
			 SET payload = ?
			 WHERE entity_key = 'state'`,
			[oversizedPayload],
		);

		const recovery = readPrWorkflowGateStateCoordinationForRecovery(
			directory,
			OWNER_SESSION_ID,
		);
		expect(recovery.kind).toBe('corrupt');
		if (recovery.kind === 'corrupt') {
			expect(recovery.reason).toContain('maximum size');
		}
	});
});
