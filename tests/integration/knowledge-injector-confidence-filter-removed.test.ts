/**
 * Integration regression: the ≥0.8 hard confidence pre-filter is removed
 * (Change 5 / Task 6.1).
 *
 * Before: the architect injector dropped every entry with confidence < 0.8, so
 * a fresh, in-scope, low-confidence directive could never surface (the
 * cold-start killer). After: confidence participates only via the hybrid score,
 * so a 0.55-confidence in-scope entry now appears in the injected block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createKnowledgeInjectorHook } from '../../src/hooks/knowledge-injector.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../src/hooks/knowledge-types.js';

const PLAN = JSON.stringify({
	schema_version: '1.0.0',
	swarm: 'cf-test',
	title: 'Confidence Filter Test',
	current_phase: 1,
	phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
});

function entry(id: string, lesson: string, confidence: number): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['test'],
		scope: 'global',
		confidence,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2024-01-01T00:00:00.000Z',
				project_name: 'test',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		project_name: 'test',
	});
}

const CONFIG: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	inject_char_budget: 2000,
	max_lesson_display_chars: 120,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: false,
	rejected_max_entries: 20,
	validation_enabled: true,
	evergreen_confidence: 0.9,
	evergreen_utility: 0.8,
	low_utility_threshold: 0.3,
	min_retrievals_for_utility: 3,
	schema_version: 1,
	same_project_weight: 1.0,
	cross_project_weight: 0.5,
	min_encounter_score: 0.1,
	initial_encounter_score: 1.0,
	encounter_increment: 0.1,
	max_encounter_score: 10.0,
	default_max_phases: 10,
	todo_max_phases: 3,
	sweep_enabled: true,
};

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'cf-filter-'));
}

function architectMessages(): MessageWithParts[] {
	return [
		{
			info: { role: 'system', agent: 'architect' },
			parts: [{ type: 'text', text: 'System prompt for architect' }],
		},
		{ info: { role: 'user' }, parts: [{ type: 'text', text: 'do the work' }] },
	];
}

function injectedText(messages: MessageWithParts[]): string {
	return messages
		.flatMap((m) => m.parts ?? [])
		.map((p) => p.text ?? '')
		.join('\n');
}

describe('confidence filter removed (Task 6.1)', () => {
	let dir: string;

	beforeEach(() => {
		dir = createRelativeTempDir();
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), PLAN);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('surfaces a 0.55-confidence in-scope entry that the old filter would have dropped', async () => {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'knowledge.jsonl'),
			entry(
				'low-1',
				'Prefer dependency injection over module mocks for seams',
				0.55,
			),
		);
		const hook = createKnowledgeInjectorHook(dir, CONFIG);
		const output = { messages: architectMessages() };
		await hook({} as Record<string, never>, output);

		const text = injectedText(output.messages);
		expect(text).toContain('dependency injection over module mocks');
	});

	it('still surfaces high-confidence entries alongside low-confidence ones', async () => {
		fs.writeFileSync(
			path.join(dir, '.swarm', 'knowledge.jsonl'),
			[
				entry(
					'low-1',
					'Low confidence but in-scope lesson about retries',
					0.55,
				),
				entry(
					'high-1',
					'High confidence lesson about idempotent handlers',
					0.95,
				),
			].join('\n'),
		);
		const hook = createKnowledgeInjectorHook(dir, CONFIG);
		const output = { messages: architectMessages() };
		await hook({} as Record<string, never>, output);

		const text = injectedText(output.messages);
		expect(text).toContain('idempotent handlers');
		expect(text).toContain('in-scope lesson about retries');
	});
});
