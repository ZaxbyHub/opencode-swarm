import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { abort_pr_workflow } from '../../../src/tools/index.js';
import {
	createPublicationFixture,
	type PublicationFixture,
} from '../hooks/pr-workflow-publication.test-fixtures.js';

type SchemaLike = {
	safeParse(value: unknown): { success: boolean };
};

type RegisteredAbortTool = {
	args: Record<string, SchemaLike>;
	execute(
		args: unknown,
		context: { directory: string; sessionID: string },
	): Promise<unknown>;
};

type AbortResponse = {
	success: boolean;
	message?: string;
	mode?: string;
	status?: string;
	gate_cleared?: boolean;
	checkout_restore_required?: boolean;
	checkout_restore_receipts?: unknown[];
	[key: string]: unknown;
};

const registeredAbort = abort_pr_workflow as unknown as RegisteredAbortTool;
let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

function responseText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (
		typeof value === 'object' &&
		value !== null &&
		'output' in value &&
		typeof value.output === 'string'
	) {
		return value.output;
	}
	throw new Error('registered abort tool returned an unexpected result');
}

async function executeRegistered(
	args: unknown,
	sessionID: string,
): Promise<AbortResponse> {
	return JSON.parse(
		responseText(
			await registeredAbort.execute(args, {
				directory: fixture.directory,
				sessionID,
			}),
		),
	) as AbortResponse;
}

describe('abort_pr_workflow registered cancellation contract (issue #2584)', () => {
	test('AC1: registered args expose the cancellation kind and required tuple', () => {
		expect(registeredAbort.args.kind.safeParse('recovery').success).toBe(true);
		expect(registeredAbort.args.kind.safeParse('armed_recovery').success).toBe(
			true,
		);
		expect(
			registeredAbort.args.kind.safeParse('cancel-publication').success,
		).toBe(true);
		expect(
			registeredAbort.args.cancel_publication.safeParse(true).success,
		).toBe(true);
	});

	test('AC2: ordinary PR_REVIEW recovery remains accepted and succeeds', async () => {
		const sessionID = 'issue-2584-review-recovery';
		await activatePrWorkflow(fixture.directory, sessionID, 'PR_REVIEW');

		const result = await executeRegistered(
			{
				mode: 'PR_REVIEW',
				kind: 'recovery',
				reason: 'bounded review checkout recovery is exhausted',
			},
			sessionID,
		);

		expect(result).toMatchObject({
			success: true,
			mode: 'PR_REVIEW',
			gate_cleared: true,
			checkout_restore_required: false,
			checkout_restore_receipts: [],
		});
		await expect(
			readPrWorkflowGateState(fixture.directory, sessionID),
		).resolves.toBeNull();
	});

	test('AC3: registered PR_FEEDBACK cancellation clears the gate and records a terminal no-publish outcome', async () => {
		const sessionID = 'issue-2584-feedback-cancel';
		await fixture.prepareArmedGeneration(sessionID);

		const result = await executeRegistered(
			{
				mode: 'PR_FEEDBACK',
				kind: 'cancel-publication',
				cancel_publication: true,
				reason: 'publication cannot proceed in this checkout',
			},
			sessionID,
		);

		expect(result).toMatchObject({
			success: true,
			mode: 'PR_FEEDBACK',
			status: 'cancelled_without_publication',
			gate_cleared: true,
			checkout_restore_required: false,
			checkout_restore_receipts: [],
		});
		await expect(
			readPrWorkflowGateState(fixture.directory, sessionID),
		).resolves.toBeNull();

		const events = (
			await fs.readFile(
				path.join(fixture.directory, '.swarm', 'events.jsonl'),
				'utf8',
			)
		)
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const cancellation = events.find(
			(event) => event.type === 'pr_feedback_publication_cancelled',
		);
		expect(cancellation).toMatchObject({
			type: 'pr_feedback_publication_cancelled',
			reason: 'publication cannot proceed in this checkout',
		});
	});

	test('AC4: registered and execute validation errors are useful, and force remains rejected', async () => {
		expect(registeredAbort.args.kind.safeParse('force').success).toBe(false);
		expect(registeredAbort.args.reason.safeParse('').success).toBe(false);

		const malformed = await executeRegistered({}, 'issue-2584-malformed');
		expect(malformed.success).toBe(false);
		expect(malformed.message).toContain('Invalid PR workflow abort');

		const missingCancellationTuple = await executeRegistered(
			{ kind: 'cancel-publication', reason: 'missing the explicit opt-in' },
			'issue-2584-malformed',
		);
		expect(missingCancellationTuple.success).toBe(false);
		expect(missingCancellationTuple.message).toContain(
			'requires cancel_publication: true',
		);

		const force = await executeRegistered(
			{ mode: 'PR_REVIEW', kind: 'force', reason: 'try to bypass recovery' },
			'issue-2584-malformed',
		);
		expect(force.success).toBe(false);
		expect(force.message).toContain('Invalid PR workflow abort');
	});
});
