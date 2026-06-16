/**
 * Integration test: architect-side delegate directive injection
 * (Swarm Learning System, Change 1 / Task 1.4).
 *
 * The plan named src/agents/architect.ts as the "delegation prompt builder", but
 * the architect is prompt-driven: real delegations are emitted at runtime via the
 * Task tool. The code-accurate interception is the `tool.execute.before` hook
 * `injectDelegateDirectivesBefore`, which mutates the Task delegation's prompt.
 * This test exercises that seam: an architect delegating to a coder must have the
 * <delegate_knowledge_directives> block prepended to the coder's prompt; when no
 * directives match, the prompt must be left unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { injectDelegateDirectivesBefore } from '../../src/hooks/delegate-directive-injection.js';
import { DELEGATE_DIRECTIVE_BLOCK_TAG } from '../../src/hooks/knowledge-injector.js';
import type { KnowledgeConfig } from '../../src/hooks/knowledge-types.js';

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

function coderEntryLine(id: string, lesson: string): string {
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
		forbidden_actions: ['introduce async iterators in hot paths'],
		directive_priority: 'critical',
	});
}

function reviewerOnlyLine(id: string, lesson: string): string {
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
		applies_to_agents: ['reviewer'],
		applies_to_tools: ['read'],
		directive_priority: 'high',
	});
}

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'arch-deleg-'));
}

function seed(dir: string, lines: string[]): void {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), lines.join('\n'));
}

describe('injectDelegateDirectivesBefore (architect → coder)', () => {
	let dir: string;

	beforeEach(() => {
		dir = createRelativeTempDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('prepends the delegate directive block to the coder prompt', async () => {
		seed(dir, [
			coderEntryLine('coder-1', 'Never use async iterators in hot paths'),
		]);
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK: implement the parser\nFILES: src/parser.ts',
		};
		const injected = await injectDelegateDirectivesBefore(
			dir,
			{
				tool: 'Task',
				agent: 'architect',
				sessionID: 'sess-1',
				args,
			},
			CONFIG,
		);

		expect(injected).toBeGreaterThan(0);
		expect(args.prompt).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
		expect(args.prompt).toContain('coder-1');
		// Original prompt content preserved after the block.
		expect(args.prompt).toContain('TASK: implement the parser');
		// Block is at the top.
		expect(args.prompt.startsWith(DELEGATE_DIRECTIVE_BLOCK_TAG)).toBe(true);
	});

	it('leaves the prompt unchanged when no directives match the delegate', async () => {
		// Only reviewer-scoped directives — none match a coder using edit/write.
		seed(dir, [reviewerOnlyLine('rev-1', 'Reviewer-only directive')]);
		const original = 'TASK: implement the parser\nFILES: src/parser.ts';
		const args = { subagent_type: 'coder', prompt: original };
		const injected = await injectDelegateDirectivesBefore(
			dir,
			{ tool: 'Task', agent: 'architect', sessionID: 'sess-2', args },
			CONFIG,
		);
		expect(injected).toBe(0);
		expect(args.prompt).toBe(original);
		expect(args.prompt).not.toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
	});

	it('is idempotent — a second pass does not inject a second block', async () => {
		seed(dir, [
			coderEntryLine('coder-1', 'Never use async iterators in hot paths'),
		]);
		const args = {
			subagent_type: 'coder',
			prompt: 'TASK: implement the parser',
		};
		await injectDelegateDirectivesBefore(
			dir,
			{ tool: 'Task', agent: 'architect', sessionID: 'sess-3', args },
			CONFIG,
		);
		const afterFirst = args.prompt;
		const secondInjected = await injectDelegateDirectivesBefore(
			dir,
			{ tool: 'Task', agent: 'architect', sessionID: 'sess-3', args },
			CONFIG,
		);
		expect(secondInjected).toBe(0);
		expect(args.prompt).toBe(afterFirst);
		// Exactly one block present.
		const occurrences =
			args.prompt.split(DELEGATE_DIRECTIVE_BLOCK_TAG).length - 1;
		expect(occurrences).toBe(1);
	});

	it('does not inject when the caller is not the architect', async () => {
		seed(dir, [
			coderEntryLine('coder-1', 'Never use async iterators in hot paths'),
		]);
		const original = 'TASK: nested delegation attempt';
		const args = { subagent_type: 'coder', prompt: original };
		const injected = await injectDelegateDirectivesBefore(
			dir,
			{ tool: 'Task', agent: 'coder', sessionID: 'sess-4', args },
			CONFIG,
		);
		expect(injected).toBe(0);
		expect(args.prompt).toBe(original);
	});

	it('does not inject for non-Task tools', async () => {
		seed(dir, [
			coderEntryLine('coder-1', 'Never use async iterators in hot paths'),
		]);
		const original = 'some prompt';
		const args = { subagent_type: 'coder', prompt: original };
		const injected = await injectDelegateDirectivesBefore(
			dir,
			{ tool: 'edit', agent: 'architect', sessionID: 'sess-5', args },
			CONFIG,
		);
		expect(injected).toBe(0);
		expect(args.prompt).toBe(original);
	});
});
