import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectPlanTaskIdContextFromPhases } from '../../../src/hooks/plan-task-id-context.js';
import { resolveReviewerScopeTaskId } from '../../../src/hooks/review-receipt-scope.js';
import { skillPropagationTransformScan } from '../../../src/hooks/skill-propagation-gate.js';
import {
	appendSkillUsageEntry,
	readSkillUsageEntries,
} from '../../../src/hooks/skill-usage-log.js';
import { TASK_ID_RESOLUTION_LIMITS } from '../../../src/hooks/task-id-resolver.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const directories: string[] = [];

function makeDirectory(prefix: string): string {
	const directory = canonicalMkdtemp(prefix);
	directories.push(directory);
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return directory;
}

function writePlan(directory: string, taskIds: string[]): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Task identity regression plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: taskIds.map((id) => ({
						id,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: `Task ${id}`,
						depends: [],
						files_touched: [],
					})),
				},
			],
		}),
	);
}

function recordUniqueFallback(
	directory: string,
	sessionID: string,
	taskID: string,
) {
	appendSkillUsageEntry(directory, {
		skillPath: 'file:.claude/skills/writing-tests/SKILL.md',
		agentName: 'coder',
		taskID,
		complianceVerdict: 'not_checked',
		sessionID,
		timestamp: withFrozenClock(() => new Date().toISOString(), {
			isoNow: '2026-01-01T00:00:00.000Z',
		}),
	});
}

async function scanReviewer(
	directory: string,
	sessionID: string,
	reviewerText: string,
) {
	await skillPropagationTransformScan(
		directory,
		{
			messages: [
				{
					info: { role: 'assistant', agent: 'reviewer', sessionID },
					parts: [{ type: 'text', text: reviewerText }],
				},
			],
		},
		sessionID,
	);
	return readSkillUsageEntries(directory, { sessionID }).filter(
		(entry) => entry.agentName === 'reviewer',
	);
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('production task-ID consumers fail closed', () => {
	test('reviewer scope accepts a known explicit task and rejects an unknown one', async () => {
		const directory = makeDirectory('reviewer-scope-task-id-');
		writePlan(directory, ['1.1']);

		expect(
			await resolveReviewerScopeTaskId(directory, { task_id: '1.1' }),
		).toBe('1.1');
		expect(
			await resolveReviewerScopeTaskId(directory, { task_id: '9.9' }),
		).toBeNull();
	});

	test('a malformed reviewer marker cannot activate a unique history fallback', async () => {
		const directory = makeDirectory('reviewer-malformed-task-id-');
		const sessionID = 'malformed-marker';
		recordUniqueFallback(directory, sessionID, 'legacy-task');

		const entries = await scanReviewer(
			directory,
			sessionID,
			'TASK: !!!\nSKILL_COMPLIANCE: COMPLIANT',
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].taskID).toBe('unknown');
		expect(entries[0].skillPath).toBe('__overall__');
	});

	test('an oversized valid plan blocks numeric attribution but preserves legacy named IDs', async () => {
		const directory = makeDirectory('reviewer-oversized-plan-');
		writePlan(
			directory,
			Array.from(
				{ length: TASK_ID_RESOLUTION_LIMITS.maxKnownIds + 1 },
				(_, index) => `1.${index + 1}`,
			),
		);

		recordUniqueFallback(directory, 'numeric-over-limit', '1.1');
		const numericEntries = await scanReviewer(
			directory,
			'numeric-over-limit',
			'TASK: 9.9\nSKILL_COMPLIANCE: COMPLIANT',
		);
		expect(numericEntries).toHaveLength(1);
		expect(numericEntries[0].taskID).toBe('unknown');
		expect(numericEntries[0].skillPath).toBe('__overall__');

		recordUniqueFallback(directory, 'named-over-limit', 'legacy-task');
		const namedEntries = await scanReviewer(
			directory,
			'named-over-limit',
			'TASK: legacy-task\nSKILL_COMPLIANCE: COMPLIANT',
		);
		expect(namedEntries).toHaveLength(1);
		expect(namedEntries[0].taskID).toBe('legacy-task');
	});

	test('an oversized plan still accepts a known explicit numeric reviewer task', async () => {
		const directory = makeDirectory('reviewer-oversized-explicit-');
		writePlan(
			directory,
			Array.from(
				{ length: TASK_ID_RESOLUTION_LIMITS.maxKnownIds + 1 },
				(_, index) => `1.${index + 1}`,
			),
		);

		expect(
			await resolveReviewerScopeTaskId(directory, { task_id: '1.1025' }),
		).toBe('1.1025');
		expect(
			await resolveReviewerScopeTaskId(directory, { task_id: '9.9' }),
		).toBeNull();
	});

	test('sparse phases ignore missing task arrays and malformed task slots', () => {
		expect(
			collectPlanTaskIdContextFromPhases([
				null,
				undefined,
				{ tasks: null },
				{
					tasks: [
						null,
						undefined,
						{} as { id?: string },
						{ id: '1.1' },
						{ id: '1.2' },
					],
				},
			]),
		).toEqual({
			status: 'available',
			taskIds: new Set(['1.1', '1.2']),
		});
	});
});
