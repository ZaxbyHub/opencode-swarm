/**
 * End-to-end test for Change 1: architect injects directives into a delegate's
 * prompt (Task 1.4), the delegate returns a transcript with ack markers, and the
 * ack collector reconciles them into knowledge events (Task 1.5).
 *
 * This composes the real `tool.execute.before` and `tool.execute.after`
 * adapters so the two halves of the loop are proven to interoperate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectDelegateAcksAfter } from '../../src/hooks/delegate-ack-collector.js';
import { injectDelegateDirectivesBefore } from '../../src/hooks/delegate-directive-injection.js';
import { readKnowledgeEvents } from '../../src/hooks/knowledge-events.js';
import { DELEGATE_DIRECTIVE_BLOCK_TAG } from '../../src/hooks/knowledge-injector.js';
import type { KnowledgeConfig } from '../../src/hooks/knowledge-types.js';

const CRIT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CRIT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const CONFIG: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	delegate_max_inject_count: 8,
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

function criticalCoderEntry(id: string, lesson: string): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['fixture'],
		scope: 'global',
		confidence: 0.8,
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
		schema_version: 2,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		project_name: 'test',
		applies_to_agents: ['coder'],
		forbidden_actions: ['async iterators in hot paths'],
		directive_priority: 'critical',
	});
}

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'deleg-e2e-'));
}

describe('Change 1 end-to-end: inject → ack → events', () => {
	let dir: string;

	beforeEach(() => {
		dir = createRelativeTempDir();
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			[
				criticalCoderEntry(CRIT_A, 'Never use async iterators in hot paths'),
				criticalCoderEntry(
					CRIT_B,
					'Always validate untrusted input at the edge',
				),
			].join('\n'),
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a coder that acks one critical and ignores the other produces matching events', async () => {
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK_ID: t-7\nTASK: implement the hot loop\nFILES: src/loop.ts',
		};
		const input = {
			tool: 'Task',
			agent: 'architect',
			sessionID: 'sess-e2e',
			args,
		};

		// 1.4 — architect-side injection
		const injectedCount = await injectDelegateDirectivesBefore(
			dir,
			input,
			CONFIG,
		);
		expect(injectedCount).toBe(2);
		expect(args.prompt).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
		expect(args.prompt).toContain(CRIT_A);
		expect(args.prompt).toContain(CRIT_B);

		// Subagent returns: applies CRIT_A, never mentions CRIT_B.
		const transcript = [
			'I implemented the loop with a plain for-loop.',
			`KNOWLEDGE_APPLIED:${CRIT_A}`,
		].join('\n');

		// 1.5 — after-hook ack collection
		await collectDelegateAcksAfter(dir, input, { output: transcript });

		const events = await readKnowledgeEvents(dir);
		const applied = events.filter((e) => e.type === 'applied') as Array<{
			knowledge_id: string;
		}>;
		const violated = events.filter((e) => e.type === 'violated') as Array<{
			knowledge_id: string;
			reason?: string;
		}>;

		expect(applied.map((e) => e.knowledge_id)).toContain(CRIT_A);
		// CRIT_B was a shown critical with no ack → violated/unacknowledged.
		expect(violated.length).toBe(1);
		expect(violated[0].knowledge_id).toBe(CRIT_B);
		expect(violated[0].reason).toBe('unacknowledged');

		// Task id propagated from the envelope.
		const appliedEv = applied.find((e) => e.knowledge_id === CRIT_A) as {
			task_id?: string;
		};
		expect(appliedEv.task_id).toBe('t-7');
	});

	it('zero unacknowledged-critical leaks when the coder acks every critical', async () => {
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK: implement the hot loop',
		};
		const input = {
			tool: 'Task',
			agent: 'architect',
			sessionID: 'sess-e2e-2',
			args,
		};
		await injectDelegateDirectivesBefore(dir, input, CONFIG);

		const transcript = [
			'Implemented carefully.',
			`KNOWLEDGE_APPLIED:${CRIT_A}`,
			`KNOWLEDGE_N_A:${CRIT_B} reason=no untrusted input in this task`,
		].join('\n');
		await collectDelegateAcksAfter(dir, input, { output: transcript });

		const events = await readKnowledgeEvents(dir);
		const violated = events.filter((e) => e.type === 'violated');
		expect(violated.length).toBe(0);
		// No audit file should be written in the happy path.
		const auditPath = path.join(
			dir,
			'.swarm',
			'unacknowledged-criticals.jsonl',
		);
		expect(fs.existsSync(auditPath)).toBe(false);
	});
});
