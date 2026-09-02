import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveReviewerScopeTaskId } from '../../../src/hooks/review-receipt-scope.js';
import { skillPropagationTransformScan } from '../../../src/hooks/skill-propagation-gate.js';
import {
	appendSkillUsageEntry,
	readSkillUsageEntries,
} from '../../../src/hooks/skill-usage-log.js';
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
): void {
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

describe('reviewer task-id fail-closed regressions', () => {
	test('rejects an unknown explicit strict task_id before prompt fallback', async () => {
		const directory = makeDirectory('reviewer-scope-no-fallback-');
		writePlan(directory, ['1.1']);

		expect(
			await resolveReviewerScopeTaskId(directory, {
				task_id: '9.9',
				prompt: 'TASK: 1.1\nReview changes',
			}),
		).toBeNull();
	});

	test('mixed prompt marker families fail closed instead of choosing one', async () => {
		const directory = makeDirectory('reviewer-mixed-markers-');
		writePlan(directory, ['1.1', '1.2']);
		recordUniqueFallback(directory, 'mixed-markers', '1.1');

		const entries = await scanReviewer(
			directory,
			'mixed-markers',
			'task_id: 1.1\nTASK: 1.2\nSKILL_COMPLIANCE: COMPLIANT',
		);
		expect(entries).toHaveLength(1);
		expect(entries[0].taskID).toBe('unknown');
		expect(entries[0].skillPath).toBe('__overall__');
	});
});
