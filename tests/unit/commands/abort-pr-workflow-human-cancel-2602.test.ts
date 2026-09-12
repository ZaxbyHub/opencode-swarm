import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleAbortPrWorkflowCommand } from '../../../src/commands/abort-pr-workflow.js';
import {
	activatePrWorkflow,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	POST_COMMIT_SHA,
	type PublicationFixture,
} from '../hooks/pr-workflow-publication.test-fixtures.js';

let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

describe('human PR workflow cancellation command (issue #2602)', () => {
	test('requires a reason and cancels armed PR_FEEDBACK without publication', async () => {
		const sessionID = 'issue-2602-human-feedback-cancel';
		await fixture.prepareArmedGeneration(sessionID);

		const missingReason = await handleAbortPrWorkflowCommand(
			fixture.directory,
			['PR_FEEDBACK', '--cancel-publication'],
			sessionID,
		);
		// The pre-fix command treats the flag as force-reason text and reports the
		// generic armed refusal, so it does not enforce this cancellation contract.
		expect(missingReason).toContain(
			'cancel_publication requires a non-empty reason',
		);
		expect((await fixture.readActive(sessionID)).active?.state).toBe('armed');

		const reason = 'operator cancelled publication after the final review';
		const result = await handleAbortPrWorkflowCommand(
			fixture.directory,
			['PR_FEEDBACK', '--cancel-publication', reason],
			sessionID,
		);

		expect(result).toContain('cancelled_without_publication');
		await expect(
			readPrWorkflowGateState(fixture.directory, sessionID),
		).resolves.toBeNull();

		const events = (
			await fs.readFile(
				path.join(fixture.directory, '.swarm', 'events.jsonl'),
				'utf8',
			)
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const cancellation = events.find(
			(event) => event.type === 'pr_feedback_publication_cancelled',
		);
		expect(cancellation).toMatchObject({
			type: 'pr_feedback_publication_cancelled',
			reason,
			observedRemoteHead: POST_COMMIT_SHA,
		});
	});

	test('keeps ordinary PR_REVIEW force cancellation green', async () => {
		const sessionID = 'issue-2602-human-review-force';
		await activatePrWorkflow(fixture.directory, sessionID, 'PR_REVIEW');

		const result = await handleAbortPrWorkflowCommand(
			fixture.directory,
			['PR_REVIEW', 'operator recovery completed'],
			sessionID,
		);

		expect(result).toContain('Aborted active PR_REVIEW');
		expect(result).toContain('(force)');
		await expect(
			readPrWorkflowGateState(fixture.directory, sessionID),
		).resolves.toBeNull();
	});
});
