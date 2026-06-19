/**
 * Integration test: curator v3-schema enrichment + retry
 * (Swarm Learning System, Change 4 / Task 4.2).
 *
 * Against a mock LLM delegate:
 *  - first response missing the predicate fields → RETRY follow-up → valid
 *    second response → entry created (active) WITH the v3 fields.
 *  - two failed attempts → entry routed to .swarm/knowledge-unactionable.jsonl
 *    and a curator_skipped event appended to .swarm/events.jsonl.
 *  - no delegate at all → straight to the unactionable queue.
 *  - quota exhausted → no LLM call, straight to the unactionable queue.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../src/config/schema.js';
import { curateAndStoreSwarm } from '../../src/hooks/knowledge-curator.js';
import type { KnowledgeConfig } from '../../src/hooks/knowledge-types.js';
import { resolveUnactionablePath } from '../../src/hooks/knowledge-validator.js';

const CONFIG: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: false,
	rejected_max_entries: 20,
	validation_enabled: true,
	evergreen_confidence: 0.9,
	evergreen_utility: 0.8,
	low_utility_threshold: 0.3,
	min_retrievals_for_utility: 3,
	schema_version: 2,
	same_project_weight: 1,
	cross_project_weight: 0.5,
	min_encounter_score: 0.1,
	initial_encounter_score: 1,
	encounter_increment: 0.1,
	max_encounter_score: 10,
	default_max_phases: 10,
	todo_max_phases: 3,
	sweep_enabled: true,
	enrichment: {
		max_calls_per_day: 30,
		quota_window: 'utc',
	},
};

const LESSON =
	'Always use git status before committing changes to verify state';

const VALID_V3 = JSON.stringify({
	applies_to_agents: ['coder'],
	required_actions: ['run git status before committing'],
	directive_priority: 'medium',
});
const VALID_V3_BATCH = JSON.stringify([
	{
		applies_to_agents: ['coder'],
		required_actions: ['run git status before committing'],
		directive_priority: 'medium',
	},
]);

// Scope present but NO predicate field → fails actionability → triggers retry.
const MISSING_PREDICATE = JSON.stringify({ applies_to_agents: ['coder'] });
const MISSING_PREDICATE_BATCH = JSON.stringify([
	{ applies_to_agents: ['coder'] },
]);

function readActiveEntries(dir: string): Array<Record<string, unknown>> {
	const p = path.join(dir, '.swarm', 'knowledge.jsonl');
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

function readUnactionable(dir: string): Array<Record<string, unknown>> {
	const p = resolveUnactionablePath(dir);
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

function readEventsJsonl(dir: string): Array<Record<string, unknown>> {
	const p = path.join(dir, '.swarm', 'events.jsonl');
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

function readQuotaState(
	dir: string,
	fileName: 'knowledge-enrichment-quota.json' | 'skill-improver-quota.json',
): Record<string, unknown> | null {
	const p = path.join(dir, '.swarm', fileName);
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

describe('curator v3 enrichment + retry (Task 4.2)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-retry-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('retries once on a schema-invalid response, then stores the enriched entry', async () => {
		const calls: string[] = [];
		const mockDelegate = async (
			_system: string,
			userInput: string,
		): Promise<string> => {
			calls.push(userInput);
			// First call: missing predicate fields. Second call: valid.
			return calls.length === 1 ? MISSING_PREDICATE_BATCH : VALID_V3_BATCH;
		};

		const result = await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{ llmDelegate: mockDelegate },
		);

		expect(result.stored).toBe(1);
		expect(result.quarantined).toBe(0);
		// Exactly two LLM calls; the second carries the RETRY follow-up naming
		// the missing requirement.
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain(
			'RETRY: your last output still missed valid directives for items 1',
		);

		// The stored entry carries the v3 fields and is active (candidate status).
		const entries = readActiveEntries(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0].required_actions).toEqual([
			'run git status before committing',
		]);
		expect(entries[0].applies_to_agents).toEqual(['coder']);
		expect(entries[0].status).toBe('candidate');
	});

	it('routes the entry to the unactionable queue after two failed attempts and emits curator_skipped', async () => {
		let callCount = 0;
		const mockDelegate = async (): Promise<string> => {
			callCount++;
			return MISSING_PREDICATE_BATCH; // never produces a predicate
		};

		const result = await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{ llmDelegate: mockDelegate },
		);

		expect(result.stored).toBe(0);
		expect(result.quarantined).toBe(1);
		expect(callCount).toBe(2); // initial + one retry, no more

		// Active store is empty; the unactionable queue holds the entry.
		expect(readActiveEntries(dir)).toHaveLength(0);
		const queued = readUnactionable(dir);
		expect(queued).toHaveLength(1);
		expect(queued[0].status).toBe('quarantined_unactionable');
		expect(queued[0].lesson).toBe(LESSON);

		// curator_skipped event appended. The reason reflects the entry's FINAL
		// state: enrichment failed, so no fields were attached at all.
		const events = readEventsJsonl(dir).filter(
			(e) => e.event === 'curator_skipped',
		);
		expect(events).toHaveLength(1);
		expect(events[0].reason).toBe('missing_predicate_and_scope');
	});

	it('quarantines directly when no LLM delegate is available', async () => {
		const result = await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			// no llmDelegate
		);
		expect(result.stored).toBe(0);
		expect(result.quarantined).toBe(1);
		expect(readActiveEntries(dir)).toHaveLength(0);
		expect(readUnactionable(dir)).toHaveLength(1);
	});

	it('quarantines without calling the LLM when the enrichment quota is exhausted', async () => {
		// Pre-exhaust the quota: maxCalls=1, and a quota state already at 1 use
		// (matches the QuotaState on-disk shape: date/calls_used/max_calls/window).
		fs.writeFileSync(
			path.join(dir, '.swarm', 'knowledge-enrichment-quota.json'),
			JSON.stringify({
				date: new Date().toISOString().slice(0, 10),
				calls_used: 1,
				max_calls: 1,
				window: 'utc',
			}),
		);
		let called = 0;
		const mockDelegate = async (): Promise<string> => {
			called++;
			return VALID_V3;
		};
		const result = await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{
				llmDelegate: mockDelegate,
				enrichmentQuota: { maxCalls: 1, window: 'utc' },
			},
		);
		expect(called).toBe(0);
		expect(result.quarantined).toBe(1);
		expect(readQuotaState(dir, 'skill-improver-quota.json')).toBeNull();
	});

	it('enriches a plain-prose lesson through the batch path even when no v3 fields are pre-populated', async () => {
		// Sanity guard for Phase 5: a delegate that would fail loudly proves the
		// gate short-circuits when actionability is already satisfied. Today the
		// prose path never pre-populates fields, so this asserts the enrichment is
		// only attempted for non-actionable entries (the delegate IS called here).
		let called = 0;
		const mockDelegate = async (): Promise<string> => {
			called++;
			return VALID_V3_BATCH;
		};
		const result = await curateAndStoreSwarm(
			[LESSON],
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{ llmDelegate: mockDelegate },
		);
		expect(result.stored).toBe(1);
		expect(called).toBe(1); // single call sufficed — no retry
	});

	it('batches enrichment calls and only consumes knowledge-enrichment quota', async () => {
		const lessons = Array.from(
			{ length: 12 },
			(_, i) => `Lesson ${i + 1}: always validate assumptions before coding`,
		);
		let calls = 0;
		const mockDelegate = async (
			_system: string,
			userInput: string,
		): Promise<string> => {
			calls++;
			const expectedLenMatch = /The array length MUST be exactly (\d+)\./.exec(
				userInput,
			);
			const expectedLen = expectedLenMatch
				? Number.parseInt(expectedLenMatch[1], 10)
				: 0;
			return JSON.stringify(
				Array.from({ length: expectedLen }, () => ({
					applies_to_agents: ['coder'],
					required_actions: ['validate assumptions before coding'],
					directive_priority: 'medium',
				})),
			);
		};

		const result = await curateAndStoreSwarm(
			lessons,
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{
				llmDelegate: mockDelegate,
				enrichmentQuota: { maxCalls: 30, window: 'utc' },
			},
		);

		expect(result.stored).toBe(12);
		expect(result.quarantined).toBe(0);
		expect(calls).toBe(2); // 12 lessons / batch size 6 => 2 calls

		const enrichmentQuota = readQuotaState(
			dir,
			'knowledge-enrichment-quota.json',
		);
		expect(enrichmentQuota?.calls_used).toBe(2);
		expect(readQuotaState(dir, 'skill-improver-quota.json')).toBeNull();
	});

	it('quarantines only the unresolved items in a partially-successful batch', async () => {
		const lessons = [
			'Lesson 1: always validate input before processing',
			'Lesson 2: avoid global mutable state in module scope',
			'Lesson 3: prefer composition over inheritance',
		];
		const mockDelegate = async (
			_system: string,
			_userInput: string,
		): Promise<string> => {
			// First call: items 0 valid, 1+2 null (failure)
			return JSON.stringify([
				{
					applies_to_agents: ['coder'],
					required_actions: ['validate input first'],
					directive_priority: 'medium',
				},
				null,
				null,
			]);
		};

		const result = await curateAndStoreSwarm(
			lessons,
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{
				llmDelegate: mockDelegate,
				enrichmentQuota: { maxCalls: 30, window: 'utc' },
			},
		);

		// Only item 0 stored; items 1, 2 quarantined
		expect(result.stored).toBe(1);
		expect(result.quarantined).toBe(2);

		const active = readActiveEntries(dir);
		expect(active).toHaveLength(1);
		expect(active[0].required_actions).toEqual(['validate input first']);

		const unactionable = readUnactionable(dir);
		expect(unactionable).toHaveLength(2);
	});

	it('quarantines remaining batches when quota is exhausted mid-batch', async () => {
		// 12 lessons, but only 1 quota call allowed — the second batch is blocked
		const lessons = Array.from(
			{ length: 12 },
			(_, i) => `Lesson ${i + 1}: always do the right thing`,
		);
		let calls = 0;
		const mockDelegate = async (
			_system: string,
			userInput: string,
		): Promise<string> => {
			calls++;
			const expectedLenMatch = /The array length MUST be exactly (\d+)\./.exec(
				userInput,
			);
			const expectedLen = expectedLenMatch
				? Number.parseInt(expectedLenMatch[1], 10)
				: 0;
			return JSON.stringify(
				Array.from({ length: expectedLen }, () => ({
					applies_to_agents: ['coder'],
					required_actions: ['do the right thing'],
					directive_priority: 'medium',
				})),
			);
		};

		const result = await curateAndStoreSwarm(
			lessons,
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{
				llmDelegate: mockDelegate,
				enrichmentQuota: { maxCalls: 1, window: 'utc' },
			},
		);

		// First batch (6 lessons) succeeds; second batch (6 lessons) blocked by quota
		expect(calls).toBe(1);
		expect(result.stored).toBe(6);
		expect(result.quarantined).toBe(6);
	});

	it('emits unactionable queue entry and curator_skipped event for failed batch items', async () => {
		const lessons = [
			'Lesson 1: always use feature flags for risky changes',
			'Lesson 2: never skip code review',
		];
		const mockDelegate = async (
			_system: string,
			_userInput: string,
		): Promise<string> => {
			// Both items null on first call; second call also null
			return JSON.stringify([null, null]);
		};

		const result = await curateAndStoreSwarm(
			lessons,
			'proj',
			{ phase_number: 1 },
			dir,
			CONFIG,
			{
				llmDelegate: mockDelegate,
				enrichmentQuota: { maxCalls: 30, window: 'utc' },
			},
		);

		expect(result.stored).toBe(0);
		expect(result.quarantined).toBe(2);

		// Verify the unactionable queue has both entries
		const unactionable = readUnactionable(dir);
		expect(unactionable).toHaveLength(2);

		// Verify the events.jsonl has curator_skipped events
		const events = readEventsJsonl(dir).filter(
			(e) => e.event === 'curator_skipped',
		);
		expect(events).toHaveLength(2);
		expect(events[0].entry_id).toBeDefined();
		expect(events[0].lesson).toBeDefined();
	});

	it('respects configured batch_size from KnowledgeConfig.enrichment', async () => {
		const lessons = Array.from(
			{ length: 10 },
			(_, i) => `Lesson ${i + 1}: always use immutable data structures`,
		);
		let calls = 0;
		const mockDelegate = async (
			_system: string,
			userInput: string,
		): Promise<string> => {
			calls++;
			const expectedLenMatch = /The array length MUST be exactly (\d+)\./.exec(
				userInput,
			);
			const expectedLen = expectedLenMatch
				? Number.parseInt(expectedLenMatch[1], 10)
				: 0;
			return JSON.stringify(
				Array.from({ length: expectedLen }, () => ({
					applies_to_agents: ['coder'],
					required_actions: ['use immutable data'],
					directive_priority: 'medium',
				})),
			);
		};

		const configWithBatchSize: KnowledgeConfig = {
			...CONFIG,
			enrichment: {
				max_calls_per_day: 30,
				quota_window: 'utc',
				batch_size: 3,
			},
		};

		const result = await curateAndStoreSwarm(
			lessons,
			'proj',
			{ phase_number: 1 },
			dir,
			configWithBatchSize,
			{
				llmDelegate: mockDelegate,
				enrichmentQuota: { maxCalls: 30, window: 'utc' },
			},
		);

		// 10 lessons / batch size 3 => 4 calls (3+3+3+1)
		expect(calls).toBe(4);
		expect(result.stored).toBe(10);
	});

	it('parses enrichment batch_size through KnowledgeConfigSchema and honors it in curateAndStoreSwarm', async () => {
		const lessons = Array.from(
			{ length: 10 },
			(_, i) => `Lesson ${i + 1}: always use immutable data structures`,
		);
		let calls = 0;
		const mockDelegate = async (
			_system: string,
			userInput: string,
		): Promise<string> => {
			calls++;
			const expectedLenMatch = /The array length MUST be exactly (\d+)\./.exec(
				userInput,
			);
			const expectedLen = expectedLenMatch
				? Number.parseInt(expectedLenMatch[1], 10)
				: 0;
			return JSON.stringify(
				Array.from({ length: expectedLen }, () => ({
					applies_to_agents: ['coder'],
					required_actions: ['use immutable data'],
					directive_priority: 'medium',
				})),
			);
		};

		const parsed = KnowledgeConfigSchema.parse({
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			auto_promote_days: 90,
			max_inject_count: 5,
			dedup_threshold: 0.6,
			scope_filter: ['global'],
			hive_enabled: false,
			rejected_max_entries: 20,
			validation_enabled: true,
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			schema_version: 2,
			same_project_weight: 1,
			cross_project_weight: 0.5,
			min_encounter_score: 0.1,
			initial_encounter_score: 1,
			encounter_increment: 0.1,
			max_encounter_score: 10,
			default_max_phases: 10,
			todo_max_phases: 3,
			sweep_enabled: true,
			enrichment: {
				max_calls_per_day: 30,
				quota_window: 'utc',
				batch_size: 3,
			},
		});

		const result = await curateAndStoreSwarm(
			lessons,
			'proj',
			{ phase_number: 1 },
			dir,
			parsed,
			{
				llmDelegate: mockDelegate,
				enrichmentQuota: { maxCalls: 30, window: 'utc' },
			},
		);

		expect(parsed.enrichment?.batch_size).toBe(3);
		// 10 lessons / batch size 3 => 4 calls (3+3+3+1)
		expect(calls).toBe(4);
		expect(result.stored).toBe(10);
	});
});
