import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	transitionPrReviewToFeedback,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const PR_URL = 'https://github.com/owner/repo/pull/155';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(async () => {
	_test_exports.beforePrFeedbackTransitionLock = undefined;
	await teardownPrWorkflowGateFixtures();
});

function handoffRelativePath(runId: string): string {
	return `.swarm/pr-review/${runId}/feedback-handoff.json`;
}

async function overwriteHandoffArtifact(
	runId: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const absolute = path.join(tempDir, handoffRelativePath(runId));
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, JSON.stringify(payload, null, 2), 'utf8');
}

describe('PR feedback continuation handoff artifact limits', () => {
	test('rejects malformed and oversized external handoff artifacts', async () => {
		await overwriteHandoffArtifact('malformed', {
			not: 'a valid handoff',
		});
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: 'malformed',
				handoffPath: handoffRelativePath('malformed'),
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/artifact is invalid/i);

		const oversizedSummary = 'x'.repeat(140 * 1024);
		await overwriteHandoffArtifact('oversized', {
			schema_version: 1,
			run_id: 'oversized',
			pr_head_sha: HEAD_SHA,
			created_at: '2026-08-01T00:00:00.000Z',
			pr_url: PR_URL,
			finding_ids: ['C-1'],
			summary: oversizedSummary,
			provenance: ['manual-test'],
		});
		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: 'oversized',
				handoffPath: handoffRelativePath('oversized'),
				prUrl: PR_URL,
			}),
		).rejects.toThrow(/exceeds 131072 bytes|artifact is invalid/i);
	});
});
