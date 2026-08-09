/**
 * Non-critical silence is a first-class, audit-only signal.
 *
 * Before this behavior, a delegated subagent that was shown directives and
 * finished without acknowledging any of them produced a signal ONLY for
 * CRITICAL entries (a `violated` event with reason `unacknowledged`). In a real
 * deployment with 1 critical entry out of 103, that meant ~4% of deliveries
 * were observable and the other 96% were invisible.
 *
 * These tests pin the new `unacknowledged` event AND the three things it must
 * never do (escalate, write promotion evidence, or touch the criticals-only
 * audit file), plus the fact that the critical path is completely unchanged.
 *
 * Uses real implementations (no mock.module), same isolation tier as the
 * companion delegate-ack-collector.test.ts. Each test gets its own temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type CollectDelegateAcksResult,
	collectDelegateAcks,
} from '../../../src/hooks/delegate-ack-collector.js';
import {
	appendKnowledgeEvent,
	type KnowledgeEvent,
	readKnowledgeEvents,
	recomputeCounters,
} from '../../../src/hooks/knowledge-events.js';
import { buildDelegateDirectiveBlock } from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';
import { loadPromotionEvidenceByEntry } from '../../../src/hooks/promotion-evidence-store.js';

// ---------------------------------------------------------------------------
// Fixtures (mirrors delegate-ack-collector.test.ts)
// ---------------------------------------------------------------------------

const ID_HIGH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_MEDIUM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_LOW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_CRITICAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const FIXED_TRACE_ID = 'trace-unack-0001';

function knowledgeConfig(): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		same_project_weight: 1,
		cross_project_weight: 0.5,
		min_encounter_score: 0.1,
		initial_encounter_score: 1,
		encounter_increment: 0.1,
		max_encounter_score: 10,
		default_max_phases: 10,
		todo_max_phases: 3,
		sweep_enabled: true,
	} as KnowledgeConfig;
}

function rankedEntry(
	id: string,
	priority: RankedEntry['directive_priority'],
): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson for ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		directive_priority: priority,
		relevanceScore: { category: 0, confidence: 0, keywords: 0 },
		finalScore: 0.5,
	} as RankedEntry;
}

/** Prompt carrying the trace_id header (the modern, validated path). */
function buildPrompt(entries: RankedEntry[]): string {
	const block = buildDelegateDirectiveBlock(
		entries,
		knowledgeConfig(),
		FIXED_TRACE_ID,
	);
	return `${block}\n\nTASK_ID: task-42\nDelegated work here.`;
}

/**
 * Prompt WITHOUT a trace_id header — the legacy shape that makes
 * `isLegacyPrompt === true` inside the collector.
 */
function buildLegacyPrompt(entries: RankedEntry[]): string {
	const block = buildDelegateDirectiveBlock(entries, knowledgeConfig());
	return `${block}\n\nTASK_ID: task-42\nDelegated work here.`;
}

async function seedRetrieved(
	directory: string,
	resultIds: string[],
	sessionId: string,
): Promise<void> {
	await appendKnowledgeEvent(directory, {
		type: 'retrieved',
		trace_id: FIXED_TRACE_ID,
		session_id: sessionId,
		agent: 'coder',
		query: 'delegate task',
		retrieval_mode: 'delegate_inject',
		result_ids: resultIds,
		ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
		scores: Object.fromEntries(resultIds.map((id) => [id, 1])),
		timestamp: new Date().toISOString(),
	});
}

type UnackEvent = KnowledgeEvent & {
	knowledge_id?: string;
	trace_id?: string;
	session_id?: string;
	task_id?: string;
	agent?: string;
	source?: string;
	reason?: string;
};

function eventsOfType(events: KnowledgeEvent[], type: string): UnackEvent[] {
	return events.filter((e) => e.type === type) as UnackEvent[];
}

function criticalsAuditPath(directory: string): string {
	return path.join(directory, '.swarm', 'unacknowledged-criticals.jsonl');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('delegate-ack-collector — non-critical silence', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-ack-unack-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** Shown two non-criticals, delegate answered nothing. */
	async function runSilentNonCritical(
		sessionId: string,
	): Promise<CollectDelegateAcksResult> {
		await seedRetrieved(dir, [ID_HIGH, ID_MEDIUM], sessionId);
		return collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([
				rankedEntry(ID_HIGH, 'high'),
				rankedEntry(ID_MEDIUM, 'medium'),
			]),
			transcript: 'Done. Implemented the change.',
			agent: 'coder',
			sessionId,
		});
	}

	it('emits one unacknowledged event per shown, unacked non-critical directive', async () => {
		const result = await runSilentNonCritical('sess-unack-1');

		expect([...result.unacknowledgedNonCritical].sort()).toEqual(
			[ID_HIGH, ID_MEDIUM].sort(),
		);
		expect(result.unacknowledgedCriticals).toEqual([]);
		expect(
			result.emitted
				.filter((e) => e.type === 'unacknowledged')
				.map((e) => e.id),
		).toHaveLength(2);

		const events = await readKnowledgeEvents(dir);
		const unack = eventsOfType(events, 'unacknowledged');
		expect(unack).toHaveLength(2);
		// Exactly one event per shown id — no duplicates.
		expect([...new Set(unack.map((e) => e.knowledge_id))].sort()).toEqual(
			[ID_HIGH, ID_MEDIUM].sort(),
		);
	});

	it('stamps the recovered trace id, session, task, agent, source and reason', async () => {
		await runSilentNonCritical('sess-unack-2');

		const events = await readKnowledgeEvents(dir);
		const ev = eventsOfType(events, 'unacknowledged').find(
			(e) => e.knowledge_id === ID_HIGH,
		);
		expect(ev).toBeDefined();
		// The ORIGINAL retrieval trace, not a freshly minted one.
		expect(ev?.trace_id).toBe(FIXED_TRACE_ID);
		expect(ev?.session_id).toBe('sess-unack-2');
		expect(ev?.task_id).toBe('task-42');
		expect(ev?.agent).toBe('coder');
		expect(ev?.source).toBe('delegate');
		// Distinct from the critical loop's reason ('unacknowledged'), so the two
		// paths can never be collapsed without this failing.
		expect(ev?.reason).toBe('no_ack_marker');
	});

	it('never escalates, never writes promotion evidence, never touches the criticals audit file', async () => {
		await runSilentNonCritical('sess-unack-3');

		const events = await readKnowledgeEvents(dir);
		// (a) silence is not a violation, so nothing crossed the escalator.
		expect(eventsOfType(events, 'violated')).toHaveLength(0);
		expect(eventsOfType(events, 'escalation')).toHaveLength(0);
		// (b) no promotion evidence — that is reserved for validated terminals.
		const evidence = await loadPromotionEvidenceByEntry(dir);
		expect(Object.keys(evidence)).toHaveLength(0);
		// (c) the criticals audit file stays criticals-only (never created here).
		expect(fs.existsSync(criticalsAuditPath(dir))).toBe(false);
	});

	it('emits no unacknowledged event for a non-critical directive that WAS acked', async () => {
		const sessionId = 'sess-unack-4';
		await seedRetrieved(dir, [ID_HIGH, ID_MEDIUM], sessionId);

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([
				rankedEntry(ID_HIGH, 'high'),
				rankedEntry(ID_MEDIUM, 'medium'),
			]),
			transcript: [
				`KNOWLEDGE_APPLIED:${ID_HIGH}`,
				`KNOWLEDGE_N_A:${ID_MEDIUM} reason=different subsystem`,
			].join('\n'),
			agent: 'coder',
			sessionId,
		});

		expect(result.unacknowledgedNonCritical).toEqual([]);
		const events = await readKnowledgeEvents(dir);
		expect(eventsOfType(events, 'unacknowledged')).toHaveLength(0);
		// The real terminals still landed.
		const byId = new Map(result.emitted.map((e) => [e.id, e.type]));
		expect(byId.get(ID_HIGH)).toBe('applied');
		expect(byId.get(ID_MEDIUM)).toBe('n_a');
	});

	it('leaves the CRITICAL unacked path unchanged and does not double-emit', async () => {
		const sessionId = 'sess-unack-5';
		await seedRetrieved(dir, [ID_CRITICAL], sessionId);

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([rankedEntry(ID_CRITICAL, 'critical')]),
			transcript: 'Done, but I never acknowledged anything.',
			agent: 'coder',
			sessionId,
		});

		// Still a contract violation, still audited.
		expect(result.unacknowledgedCriticals).toEqual([ID_CRITICAL]);
		expect(result.emitted).toContainEqual({
			id: ID_CRITICAL,
			type: 'violated',
		});
		const events = await readKnowledgeEvents(dir);
		const violated = eventsOfType(events, 'violated');
		expect(violated).toHaveLength(1);
		expect(violated[0].knowledge_id).toBe(ID_CRITICAL);
		expect(violated[0].reason).toBe('unacknowledged');
		expect(fs.existsSync(criticalsAuditPath(dir))).toBe(true);
		const auditLines = fs
			.readFileSync(criticalsAuditPath(dir), 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		expect(auditLines).toHaveLength(1);
		expect(JSON.parse(auditLines[0]).knowledge_id).toBe(ID_CRITICAL);

		// A critical must NOT also get the neutral audit event — that would
		// double-count one silence as both a violation and an observation.
		expect(result.unacknowledgedNonCritical).toEqual([]);
		expect(eventsOfType(events, 'unacknowledged')).toHaveLength(0);
	});

	it('routes each directive of a mixed block down exactly one path', async () => {
		const sessionId = 'sess-unack-6';
		await seedRetrieved(dir, [ID_CRITICAL, ID_HIGH, ID_LOW], sessionId);

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([
				rankedEntry(ID_CRITICAL, 'critical'),
				rankedEntry(ID_HIGH, 'high'),
				rankedEntry(ID_LOW, 'low'),
			]),
			// Critical unacked; ID_HIGH acked; ID_LOW silently dropped.
			transcript: `Work complete.\nKNOWLEDGE_APPLIED:${ID_HIGH}`,
			agent: 'reviewer',
			sessionId,
		});

		expect(result.unacknowledgedCriticals).toEqual([ID_CRITICAL]);
		expect(result.unacknowledgedNonCritical).toEqual([ID_LOW]);

		const events = await readKnowledgeEvents(dir);
		const unack = eventsOfType(events, 'unacknowledged');
		expect(unack).toHaveLength(1);
		expect(unack[0].knowledge_id).toBe(ID_LOW);
		expect(unack[0].agent).toBe('reviewer');

		const violated = eventsOfType(events, 'violated');
		expect(violated.map((e) => e.knowledge_id)).toEqual([ID_CRITICAL]);
		expect(eventsOfType(events, 'applied').map((e) => e.knowledge_id)).toEqual([
			ID_HIGH,
		]);
		// The acked entry never falls through to the silence path.
		expect(unack.map((e) => e.knowledge_id)).not.toContain(ID_HIGH);
	});

	it('still emits for a legacy prompt with no trace_id header, using the minted trace', async () => {
		// No seeded `retrieved` event and no trace header: the collector mints a
		// trace id and skips validation. Silence must remain visible on this path
		// too — legacy delegations are exactly where the signal was missing.
		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildLegacyPrompt([rankedEntry(ID_MEDIUM, 'medium')]),
			transcript: 'Finished without markers.',
			agent: 'coder',
			sessionId: 'sess-unack-legacy',
		});

		expect(result.unacknowledgedNonCritical).toEqual([ID_MEDIUM]);
		const events = await readKnowledgeEvents(dir);
		const unack = eventsOfType(events, 'unacknowledged');
		expect(unack).toHaveLength(1);
		expect(unack[0].knowledge_id).toBe(ID_MEDIUM);
		expect(unack[0].reason).toBe('no_ack_marker');
		// A real, minted trace id — never empty, never the fixed one.
		expect(typeof unack[0].trace_id).toBe('string');
		expect(unack[0].trace_id?.length).toBeGreaterThan(0);
		expect(unack[0].trace_id).not.toBe(FIXED_TRACE_ID);
	});

	it('does not mark a rejected-but-acked directive as unacknowledged (partial validation rejection)', async () => {
		const sessionId = 'sess-unack-partial';
		await seedRetrieved(dir, [ID_HIGH, ID_MEDIUM], sessionId);
		// A prior conflicting terminal for ID_HIGH under the same trace — e.g. the
		// delegate already filed a knowledge_receipt marking it ignored. The chat
		// marker below then says APPLIED, so validateReceipt returns ok:true with
		// ID_HIGH in rejected_items (duplicate_conflicting_terminal) and ID_MEDIUM
		// accepted.
		await appendKnowledgeEvent(dir, {
			type: 'ignored',
			trace_id: FIXED_TRACE_ID,
			knowledge_id: ID_HIGH,
			session_id: sessionId,
			agent: 'coder',
			reason: 'filed via knowledge_receipt',
		});

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([
				rankedEntry(ID_HIGH, 'high'),
				rankedEntry(ID_MEDIUM, 'medium'),
			]),
			transcript: [
				`KNOWLEDGE_APPLIED:${ID_HIGH}`,
				`KNOWLEDGE_APPLIED:${ID_MEDIUM}`,
			].join('\n'),
			agent: 'coder',
			sessionId,
		});

		// The delegate DID respond for ID_HIGH — a rejected ack is not silence.
		expect(result.unacknowledgedNonCritical).toEqual([]);
		const events = await readKnowledgeEvents(dir);
		expect(eventsOfType(events, 'unacknowledged')).toHaveLength(0);
		// The accepted terminal still landed for ID_MEDIUM.
		expect(
			eventsOfType(events, 'applied').map((e) => e.knowledge_id),
		).toContain(ID_MEDIUM);
	});

	it('does not falsely escalate a CRITICAL whose ack was rejected by validation', async () => {
		const sessionId = 'sess-unack-partial-crit';
		await seedRetrieved(dir, [ID_CRITICAL, ID_MEDIUM], sessionId);
		// Prior conflicting terminal for the critical under the same trace.
		await appendKnowledgeEvent(dir, {
			type: 'ignored',
			trace_id: FIXED_TRACE_ID,
			knowledge_id: ID_CRITICAL,
			session_id: sessionId,
			agent: 'coder',
			reason: 'filed via knowledge_receipt',
		});

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([
				rankedEntry(ID_CRITICAL, 'critical'),
				rankedEntry(ID_MEDIUM, 'medium'),
			]),
			transcript: [
				`KNOWLEDGE_APPLIED:${ID_CRITICAL}`,
				`KNOWLEDGE_APPLIED:${ID_MEDIUM}`,
			].join('\n'),
			agent: 'coder',
			sessionId,
		});

		// The critical was explicitly acknowledged; the rejection is audited by the
		// validator, not converted into a violation.
		expect(result.unacknowledgedCriticals).toEqual([]);
		const events = await readKnowledgeEvents(dir);
		expect(
			eventsOfType(events, 'violated').filter(
				(e) => e.reason === 'unacknowledged',
			),
		).toHaveLength(0);
		expect(fs.existsSync(criticalsAuditPath(dir))).toBe(false);
	});

	it('a non-critical KNOWLEDGE_IGNORED ack lands as a real negative terminal (pinned blast radius)', async () => {
		// The widened all-priority ack contract solicits terminals for every shown
		// directive, and IGNORED is NOT neutral: it increments ignored_count, a
		// negative term in computeOutcomeSignal (ranking + quarantine evidence).
		// This test pins that consequence so the contract's blast radius is a
		// conscious, tested decision — the block text steers merely-irrelevant
		// directives to the neutral N_A marker instead.
		const sessionId = 'sess-unack-ignored';
		await seedRetrieved(dir, [ID_MEDIUM], sessionId);

		const result = await collectDelegateAcks({
			directory: dir,
			prompt: buildPrompt([rankedEntry(ID_MEDIUM, 'medium')]),
			transcript: `KNOWLEDGE_IGNORED:${ID_MEDIUM} reason=conflicts with the task spec`,
			agent: 'coder',
			sessionId,
		});

		// A real ignored terminal, not silence.
		expect(result.unacknowledgedNonCritical).toEqual([]);
		const events = await readKnowledgeEvents(dir);
		expect(eventsOfType(events, 'unacknowledged')).toHaveLength(0);
		expect(eventsOfType(events, 'ignored').map((e) => e.knowledge_id)).toEqual([
			ID_MEDIUM,
		]);
		// And it moves the negative counter — unlike 'unacknowledged'.
		const rollup = recomputeCounters(events);
		expect(rollup.get(ID_MEDIUM)?.ignored_count).toBe(1);
	});
});
