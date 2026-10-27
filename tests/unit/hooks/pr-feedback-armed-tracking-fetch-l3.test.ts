/**
 * Issue #3316 AC16 (L3 acceptance, DISCRIMINATING): while a publication is
 * armed, the exact bound remote-tracking fetch
 * (`git fetch <remote> <pr-head-branch>`) must stay available so the operator
 * can re-sync the bound ref without leaving the armed window. Base behavior
 * blocks every fetch in the armed state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { enforcePrWorkflowToolBefore } from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	type PublicationFixture,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'l3-armed-fetch';

let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

describe('PR_FEEDBACK armed tracking fetch (AC16)', () => {
	test('the exact bound remote-tracking fetch is admitted while armed', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);

		const fetchOutcome = await enforcePrWorkflowToolBefore(
			fixture.directory,
			SESSION_ID,
			'shell',
			{ command: 'git fetch origin pr-head' },
			[],
			'call-fetch-1',
		).then(
			() => 'admitted',
			(error: unknown) => `rejected: ${(error as Error).message}`,
		);
		expect(fetchOutcome).toBe('admitted');
	});
});
