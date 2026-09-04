import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	_test_exports as gateInternals,
	prWorkflowSessionFileStem,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const BASE_IDS = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];

const reviewed = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
		)
		.join('\n');

function statePath(): string {
	return path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

async function reviewerBatch(): Promise<void> {
	const lane = { laneId: 'rv-1-a', workflowLane: 'rv-1-a' };
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[{ ...lane, reviewItemIds: BASE_IDS }],
		{ batchId: 'rv-1', prHeadSha: HEAD_SHA },
	);
	await persistBatch('rv-1', 'swarm-pr-review:reviewer', [lane], {
		textOverride: reviewed(BASE_IDS),
	});
}

describe('pr-workflow-gate legacy v1 compatibility', () => {
	test('a v1 plugin still parses state a v2 plugin wrote', async () => {
		await establishReviewPrerequisites();
		await reviewerBatch();
		const persisted = JSON.parse(
			await fs.readFile(statePath(), 'utf-8'),
		) as Record<string, unknown>;
		expect(persisted.prReviewBatchCoherence).toBeDefined();
		const v1Lane = z
			.object({
				laneId: z.string().min(1),
				workflowLane: z.string().min(1),
				reviewItemIds: z.array(z.string().min(1)).min(1).optional(),
			})
			.strict();
		const v1Batch = z
			.object({
				batchId: z.string().min(1),
				phase: z.enum(['council', 'reviewer', 'critic']),
				lanes: z.array(v1Lane).min(1),
				validatedAt: z.string().min(1),
			})
			.strict();
		const parsed = z
			.object({
				schemaVersion: z.literal(1),
				revision: z.number().int().nonnegative().default(0),
				sessionID: z.string().min(1),
				mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
				activatedAt: z.string().min(1),
				updatedAt: z.string().min(1),
				prReviewValidationBatches: z.array(v1Batch).optional(),
			})
			.passthrough()
			.safeParse(persisted);
		expect(parsed.success).toBe(true);
		expect(
			(parsed.data as Record<string, unknown>).prReviewBatchCoherence,
		).toBeDefined();
	});
});
