/**
 * Integration test: per-delegate knowledge directive retrieval
 * (Swarm Learning System, Change 1 / Task 1.2).
 *
 * `injectForDelegate` must return only the directives in scope for the
 * delegate's role + expected tools (agent-scoped OR tool-scoped OR untargeted),
 * capped at config.delegate_max_inject_count (default 8), and emit a single
 * `retrieved` event tagged mode:'delegate_inject'.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readKnowledgeEvents } from '../../src/hooks/knowledge-events.js';
import { injectForDelegate } from '../../src/hooks/knowledge-injector.js';
import type { KnowledgeConfig } from '../../src/hooks/knowledge-types.js';
import { rebuildSynonymMap } from '../../src/services/synonym-map.js';

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

interface EntryOpts {
	id: string;
	lesson: string;
	applies_to_agents?: string[];
	applies_to_tools?: string[];
	triggers?: string[];
}

function entryLine(o: EntryOpts): string {
	return JSON.stringify({
		id: o.id,
		tier: 'swarm',
		lesson: o.lesson,
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
		applies_to_agents: o.applies_to_agents,
		applies_to_tools: o.applies_to_tools,
		triggers: o.triggers,
		directive_priority: 'medium',
	});
}

// 20 mixed entries: 14 in-scope for a coder using edit/write, 6 out-of-scope.
function buildCorpus(): string {
	const entries: EntryOpts[] = [];
	// 6 agent-scoped to coder (in scope)
	for (let i = 0; i < 6; i++) {
		entries.push({
			id: `coder-agent-${i}`,
			lesson: `Coder agent directive number ${i} about unique topic ${i}`,
			applies_to_agents: ['coder'],
		});
	}
	// 5 tool-scoped to edit (in scope via expected tools)
	for (let i = 0; i < 5; i++) {
		entries.push({
			id: `edit-tool-${i}`,
			lesson: `Edit tool directive number ${i} concerning distinct matter ${i}`,
			applies_to_tools: ['edit'],
		});
	}
	// 3 untargeted (in scope)
	for (let i = 0; i < 3; i++) {
		entries.push({
			id: `untargeted-${i}`,
			lesson: `Untargeted global directive ${i} on separate subject ${i}`,
		});
	}
	// 4 agent-scoped to reviewer (out of scope)
	for (let i = 0; i < 4; i++) {
		entries.push({
			id: `reviewer-agent-${i}`,
			lesson: `Reviewer-only directive ${i} regarding other theme ${i}`,
			applies_to_agents: ['reviewer'],
		});
	}
	// 2 tool-scoped to read (out of scope)
	for (let i = 0; i < 2; i++) {
		entries.push({
			id: `read-tool-${i}`,
			lesson: `Read-only tool directive ${i} for unrelated area ${i}`,
			applies_to_tools: ['read'],
		});
	}
	return entries.map(entryLine).join('\n');
}

function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
	return fs.mkdtempSync(path.join(baseDir, 'delegate-inject-'));
}

function isInScopeForCoder(id: string): boolean {
	return (
		id.startsWith('coder-agent-') ||
		id.startsWith('edit-tool-') ||
		id.startsWith('untargeted-')
	);
}

describe('injectForDelegate — per-agent + per-tool retrieval', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createRelativeTempDir();
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), buildCorpus());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('returns only in-scope directives, capped at delegate_max_inject_count', async () => {
		const { entries } = await injectForDelegate({
			directory: tempDir,
			agent: 'coder',
			expectedTools: ['edit', 'write'],
			taskTitle: 'Implement the feature',
			sessionId: 'sess-1',
			config: CONFIG,
		});

		// Capped at 8.
		expect(entries.length).toBe(8);
		// Every returned entry is in scope for a coder using edit/write.
		for (const e of entries) {
			expect(isInScopeForCoder(e.id)).toBe(true);
		}
		// No reviewer-only or read-only entry leaked through.
		const ids = entries.map((e) => e.id);
		expect(ids.some((id) => id.startsWith('reviewer-agent-'))).toBe(false);
		expect(ids.some((id) => id.startsWith('read-tool-'))).toBe(false);
	});

	it('emits a retrieved event tagged delegate_inject with the shown IDs', async () => {
		const { entries } = await injectForDelegate({
			directory: tempDir,
			agent: 'coder',
			expectedTools: ['edit', 'write'],
			taskTitle: 'Implement the feature',
			sessionId: 'sess-2',
			config: CONFIG,
		});

		const events = await readKnowledgeEvents(tempDir);
		const delegateEvents = events.filter(
			(e) => e.type === 'retrieved' && e.retrieval_mode === 'delegate_inject',
		);
		expect(delegateEvents.length).toBe(1);
		const ev = delegateEvents[0];
		if (ev.type !== 'retrieved') throw new Error('expected retrieved event');
		expect(ev.agent).toBe('coder');
		expect(ev.result_ids.length).toBe(entries.length);
		expect(ev.result_ids.sort()).toEqual(entries.map((e) => e.id).sort());
	});

	it('respects a delegate_max_inject_count of 0 (no retrieval, no event)', async () => {
		const { entries } = await injectForDelegate({
			directory: tempDir,
			agent: 'coder',
			expectedTools: ['edit', 'write'],
			taskTitle: 'Implement the feature',
			sessionId: 'sess-3',
			config: { ...CONFIG, delegate_max_inject_count: 0 },
		});
		expect(entries.length).toBe(0);
		const events = await readKnowledgeEvents(tempDir);
		expect(
			events.filter(
				(e) => e.type === 'retrieved' && e.retrieval_mode === 'delegate_inject',
			).length,
		).toBe(0);
	});

	it('excludes reviewer-only directives when the delegate is a reviewer using read tools', async () => {
		// A reviewer should see reviewer-scoped + untargeted, but NOT coder-only or
		// edit-only directives (read tools do not intersect edit).
		const { entries } = await injectForDelegate({
			directory: tempDir,
			agent: 'reviewer',
			expectedTools: ['read', 'grep', 'glob'],
			taskTitle: 'Review the change',
			sessionId: 'sess-4',
			config: CONFIG,
		});
		const ids = entries.map((e) => e.id);
		expect(ids.some((id) => id.startsWith('coder-agent-'))).toBe(false);
		expect(ids.some((id) => id.startsWith('edit-tool-'))).toBe(false);
		for (const id of ids) {
			expect(
				id.startsWith('reviewer-agent-') ||
					id.startsWith('untargeted-') ||
					id.startsWith('read-tool-'),
			).toBe(true);
		}
	});
});

/**
 * Task 6.3: the delegate path goes through the upgraded `searchKnowledge` core,
 * so the Change-5 retrieval signals (trigger recall, synonym expansion,
 * cold-start) apply to per-delegate injection too — not just the architect
 * path. This proves trigger recall end-to-end via injectForDelegate: a directive
 * whose lesson text does not match the task title still surfaces (and ranks
 * first) because its declared trigger phrase appears in the task title.
 */
describe('injectForDelegate — upgraded retrieval flows through (Task 6.3)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createRelativeTempDir();
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const entries: EntryOpts[] = [];
		// Noise: untargeted (in-scope) directives whose text does not overlap the
		// trigger task title.
		for (let i = 0; i < 8; i++) {
			entries.push({
				id: `noise-${i}`,
				lesson: `Routine maintenance reminder ${i} about unrelated housekeeping ${i}`,
			});
		}
		// Target: untargeted (in-scope), lesson text unrelated to the task title,
		// but its trigger phrase appears verbatim in the task title.
		entries.push({
			id: 'trigger-target',
			lesson: 'A directive whose words share nothing with the delegated task',
			triggers: ['rotate the signing key'],
		});
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			entries.map(entryLine).join('\n'),
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('surfaces and top-ranks a trigger-matching directive on the delegate path', async () => {
		const { entries } = await injectForDelegate({
			directory: tempDir,
			agent: 'coder',
			expectedTools: ['edit', 'write'],
			taskTitle: 'We must rotate the signing key before the release',
			sessionId: 'sess-trig',
			config: { ...CONFIG, delegate_max_inject_count: 3 },
		});
		const ids = entries.map((e) => e.id);
		expect(ids).toContain('trigger-target');
		// The +0.3 trigger-recall boost dominates the near-uniform noise scores, so
		// the trigger-matching entry ranks first.
		expect(entries[0].id).toBe('trigger-target');
	});

	it('does not surface the entry when the trigger phrase is absent from the task', async () => {
		const { entries } = await injectForDelegate({
			directory: tempDir,
			agent: 'coder',
			expectedTools: ['edit', 'write'],
			taskTitle:
				'Routine maintenance reminder about unrelated housekeeping work',
			sessionId: 'sess-notrig',
			config: { ...CONFIG, delegate_max_inject_count: 3 },
		});
		// Without the trigger phrase, the target has no recall boost and the
		// text-overlapping noise entries out-rank it out of the top-3.
		expect(entries[0].id).not.toBe('trigger-target');
	});

	it('applies learned synonym expansion on the delegate path', async () => {
		// A coder-scoped entry that only uses "seams". With a learned mocks<->seams
		// synonym, a task phrased with "mocks" expands to it and lifts its score —
		// proving synonym expansion (not just trigger recall) flows through
		// injectForDelegate's searchKnowledge call. Score-based so it is independent
		// of MMR ordering: the entry is in-scope and under the cap in both runs.
		const swarmDir = path.join(tempDir, '.swarm');
		// Untargeted (in-scope for any delegate) so its baseline score does not
		// saturate at 1.0 — that keeps the +0.15 synonym boost observable.
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge.jsonl'),
			entryLine({
				id: 'seam-entry',
				lesson: 'prefer dependency seams when isolating collaborators in tests',
			}),
		);
		const call = () =>
			injectForDelegate({
				directory: tempDir,
				agent: 'coder',
				expectedTools: ['edit', 'write'],
				taskTitle: 'the task is about mocks today',
				sessionId: 'sess-syn',
				config: { ...CONFIG, delegate_max_inject_count: 5 },
			});

		const before = await call();
		const beforeScore = before.entries.find(
			(e) => e.id === 'seam-entry',
		)?.finalScore;

		// Learn mocks<->seams (co-occurs across three entries → count 3).
		await rebuildSynonymMap(tempDir, [
			{ tags: ['mocks', 'seams'] },
			{ tags: ['mocks', 'seams'] },
			{ tags: ['mocks', 'seams'] },
		]);
		const after = await call();
		const afterScore = after.entries.find(
			(e) => e.id === 'seam-entry',
		)?.finalScore;

		expect(beforeScore).toBeDefined();
		expect(afterScore).toBeDefined();
		expect(afterScore as number).toBeGreaterThan(beforeScore as number);
	});
});
