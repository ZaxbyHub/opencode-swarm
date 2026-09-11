import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	_test_exports,
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../../src/hooks/pr-workflow-gate.js';
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

	afterEach(() => {
		_test_exports.resetTrackedStateCache();
		resetSwarmState();
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows may briefly retain a plugin-init handle in the temp project.
		}
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
});
