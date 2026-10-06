/**
 * Epic phase-review freshness vs post-completion gate writes (F1 pin).
 * File: tests/unit/epic/phase-readiness-terminal-evidence.test.ts
 *
 * `epic_phase_review` evidence is bound to the content of every phase task's
 * `.swarm/evidence/{taskId}.json`. A review finding suspected that phase-wrap
 * gate writes (docs / explorer) after review would rewrite that file and make
 * the review stale. They cannot: once a task's workflow is terminal
 * (`task_completed`), further gate evidence writes are refused
 * (TASK_WORKFLOW_TERMINAL) and leave the file byte-identical. This test pins
 * that, so a future change that lets terminal evidence mutate fails here.
 *
 * Real gate-evidence + real phase-readiness modules; fake review dispatcher.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	runEpicPhaseReview,
	verifyEpicPhaseReadiness,
} from '../../../src/epic/phase-readiness';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const APPROVED = 'VERDICT: APPROVED\nREASON: integrated change is sound';
let dir: string;
/**
 * Frozen instant: the review stamps `reviewed_at` from `Date.now()` and both
 * readiness checks run at the same instant, so freshness cannot drift with the
 * wall clock between the review and the post-refusal verification.
 */
const FROZEN_NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');
let restoreClock: Restore | null = null;

const dispatcher: ReviewModelDispatcher = {
	dispatch: async (request) => ({
		status: 'completed',
		agentName: request.agentName,
		text: APPROVED,
		durationMs: 1,
		promptBytes: 0,
		responseBytes: APPROVED.length,
	}),
};

async function generation(): Promise<number> {
	return getTaskWorkflowSnapshot(await readTaskEvidence(dir, '1.1')).generation;
}

function evidenceBytes(): string {
	return fs.readFileSync(
		path.join(dir, '.swarm', 'evidence', '1.1.json'),
		'utf-8',
	);
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW_MS });
	dir = canonicalMkdtemp('epic-terminal-evidence-');
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Terminal Evidence Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							description: 'Task 1.1',
							files_touched: ['src/a.ts'],
						},
					],
				},
			],
		}),
	);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	closeAllProjectDbs();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe('epic_phase_review evidence stays fresh after phase-wrap gate writes', () => {
	test('docs / explorer gate writes after task_completed are refused and leave the review fresh', async () => {
		await transitionTaskWorkflowEvidence(dir, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: {},
			expectedGeneration: 0,
		} as never);
		await transitionTaskWorkflowEvidence(dir, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: await generation(),
		} as never);
		for (const gate of ['reviewer', 'test_engineer']) {
			await recordGateEvidence(dir, '1.1', gate, 's1', false, {
				expectedGeneration: await generation(),
				transitionId: `t-${gate}`,
			});
		}
		await transitionTaskWorkflowEvidence(dir, '1.1', {
			type: 'task_completed',
			expectedGeneration: await generation(),
			transitionId: 'terminal',
		} as never);

		const review = await runEpicPhaseReview(dir, 1, 's1', { dispatcher });
		expect(review.success).toBe(true);
		const before = evidenceBytes();
		expect((await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).ok).toBe(
			true,
		);

		for (const gate of ['docs', 'explorer']) {
			let refusal = '';
			try {
				await recordGateEvidence(dir, '1.1', gate, 's1', false, {
					expectedGeneration: await generation(),
					transitionId: `phase-wrap:${gate}`,
				});
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			expect(refusal).toContain('TASK_WORKFLOW_TERMINAL');
			expect(evidenceBytes()).toBe(before);
		}

		const after = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(after.ok).toBe(true);
	});
});
