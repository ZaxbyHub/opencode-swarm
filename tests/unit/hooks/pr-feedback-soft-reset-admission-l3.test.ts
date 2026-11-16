/**
 * Issue #3316 AC10 (L3 acceptance, DISCRIMINATING): after a controller rework
 * invalidation, the one sanctioned way to return the working tree to the
 * intake head is a bare `git reset --soft <intake-head>`. Base behavior fails
 * every non-read shell closed, wedging the recovery loop the invalidation
 * exists to open.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	enforcePrWorkflowToolBefore,
	invalidatePrFeedbackPublication,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	HEAD_SHA,
	type PublicationFixture,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'l3-reset-admission';

let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

describe('PR_FEEDBACK sanctioned soft reset after invalidation (AC10)', () => {
	test('a bare git reset --soft to the bound intake head is admitted after invalidation', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await invalidatePrFeedbackPublication(
			fixture.directory,
			SESSION_ID,
			'rework',
		);

		const resetOutcome = await enforcePrWorkflowToolBefore(
			fixture.directory,
			SESSION_ID,
			'shell',
			{ command: `git reset --soft ${HEAD_SHA}` },
			[],
			'call-reset-1',
		).then(
			() => 'admitted',
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(resetOutcome).toBe('admitted');
	});
});
