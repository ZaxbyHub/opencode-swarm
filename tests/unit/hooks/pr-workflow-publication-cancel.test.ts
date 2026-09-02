/**
 * Issue #2108 §6 — cancellation without publication: the terminal no-publish
 * state, the abort-tool arg surface, and the guarantee that cancellation
 * never manufactures push authority.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	abortPrWorkflow,
	enforcePrWorkflowToolBefore,
	invalidatePrFeedbackPublication,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	POST_COMMIT_SHA,
	type PublicationFixture,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'pub-cancel';
let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

describe('cancellation without publication (issue #2108 §6)', () => {
	test('cancel_publication clears an armed workflow as a terminal no-publish state', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		const summary = await abortPrWorkflow(fixture.directory, SESSION_ID, {
			kind: 'cancel-publication',
			reason: 'user abandoned the fix',
			cancelPublication: true,
		});
		expect(summary.mode).toBe('PR_FEEDBACK');
		await expect(
			readPrWorkflowGateState(fixture.directory, SESSION_ID),
		).resolves.toBeNull();
	});

	test('cancellation requires a non-empty reason', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			abortPrWorkflow(fixture.directory, SESSION_ID, {
				kind: 'cancel-publication',
				reason: '   ',
				cancelPublication: true,
			}),
		).rejects.toThrow('non-empty reason');
	});

	test('cancellation is refused without cancel_publication: true', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// The tool layer enforces the kind/cancel_publication pairing…
		const { executeAbortPrWorkflow } = await import(
			'../../../src/tools/abort-pr-workflow.js'
		);
		const toolResponse = JSON.parse(
			await executeAbortPrWorkflow(
				{ kind: 'cancel-publication', reason: 'x' },
				fixture.directory,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(toolResponse.success).toBe(false);
		expect(toolResponse.message).toContain('requires cancel_publication');
		// …and the hook itself stays fail-closed: without the flag the armed
		// refusal stands.
		await expect(
			abortPrWorkflow(fixture.directory, SESSION_ID, {
				kind: 'cancel-publication',
				reason: 'x',
			}),
		).rejects.toThrow(/armed for publication; abort is blocked/i);
		const state = await readPrWorkflowGateState(fixture.directory, SESSION_ID);
		expect(state?.prFeedbackReadyToPublish).toBeDefined();
	});

	test('plain recovery/force aborts remain refused while armed', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		for (const kind of ['recovery', 'force'] as const) {
			await expect(
				abortPrWorkflow(fixture.directory, SESSION_ID, { kind, reason: 'x' }),
			).rejects.toThrow(/armed for publication; abort is blocked/i);
		}
	});

	test('cancellation is mutually exclusive with force', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			abortPrWorkflow(fixture.directory, SESSION_ID, {
				kind: 'force',
				reason: 'x',
				cancelPublication: true,
			}),
		).rejects.toThrow('cannot be combined with kind "force"');
	});

	test('cancellation from an invalidated generation is allowed', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await invalidatePrFeedbackPublication(
			fixture.directory,
			SESSION_ID,
			'rework',
		);
		await expect(
			abortPrWorkflow(fixture.directory, SESSION_ID, {
				kind: 'cancel-publication',
				reason: 'abandon after invalidation',
				cancelPublication: true,
			}),
		).resolves.toBeTruthy();
		await expect(
			readPrWorkflowGateState(fixture.directory, SESSION_ID),
		).resolves.toBeNull();
	});

	test('cancellation finalizes an in-flight attempt as cancelled', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// Start a real attempt (remote not yet at the approved head).
		_test_exports.resolveExactRemoteBranchHead = () => '0'.repeat(40);
		_test_exports.resolveExactRemoteBranchHeadAsync = async () =>
			'0'.repeat(40);
		await enforcePrWorkflowToolBefore(
			fixture.directory,
			SESSION_ID,
			'shell',
			{ command: `git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head` },
			[],
			'call-cancel',
		);
		const inFlight = await readPrWorkflowGateState(
			fixture.directory,
			SESSION_ID,
		);
		expect(inFlight?.prFeedbackPublication?.active?.state).toBe(
			'push_in_flight',
		);
		await abortPrWorkflow(fixture.directory, SESSION_ID, {
			kind: 'cancel-publication',
			reason: 'abandon mid-push',
			cancelPublication: true,
		});
		// Terminal: the gate is cleared; the durable events trail carries the
		// cancellation with the observable finalized-attempt count (review M6
		// — the `cancelled` outcome must be asserted somewhere real).
		const fs = await import('node:fs/promises');
		const path = await import('node:path');
		const eventsPath = path.join(fixture.directory, '.swarm', 'events.jsonl');
		const events = await fs.readFile(eventsPath, 'utf-8');
		const cancelledEvent = events
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.find((event) => event.type === 'pr_feedback_publication_cancelled');
		expect(cancelledEvent).toBeDefined();
		expect(cancelledEvent?.attemptsFinalized).toBe(1);
		await expect(
			readPrWorkflowGateState(fixture.directory, SESSION_ID),
		).resolves.toBeNull();
	});

	test('cancellation applies only to a PR_FEEDBACK publication workflow', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		const otherSession = 'pub-cancel-no-generation';
		const { activatePrWorkflow } = await import(
			'../../../src/hooks/pr-workflow-gate.js'
		);
		await activatePrWorkflow(fixture.directory, otherSession, 'PR_REVIEW');
		await expect(
			abortPrWorkflow(fixture.directory, otherSession, {
				kind: 'cancel-publication',
				reason: 'not a feedback workflow',
				cancelPublication: true,
			}),
		).rejects.toThrow('applies only to a PR_FEEDBACK workflow');
	});

	test('after cancellation no push authority exists: the gate is gone and events carry the audit', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await abortPrWorkflow(fixture.directory, SESSION_ID, {
			kind: 'cancel-publication',
			reason: 'terminal',
			cancelPublication: true,
		});
		const fs = await import('node:fs/promises');
		const path = await import('node:path');
		const eventsPath = path.join(fixture.directory, '.swarm', 'events.jsonl');
		const events = await fs.readFile(eventsPath, 'utf-8');
		expect(events).toContain('pr_feedback_publication_cancelled');
		expect(events).toContain('terminal');
		// No gate state remains to authorize anything.
		await expect(
			readPrWorkflowGateState(fixture.directory, SESSION_ID),
		).resolves.toBeNull();
	});
});
