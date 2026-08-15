/**
 * G3 (#1715) tests: contradiction signal unification.
 *
 * Previously `contradicted_count` (incremented only via knowledge_receipt) and
 * curator `flag_contradiction` (tag-only) were disconnected. Now the curator
 * emits diagnostic `contradicted` events post-transaction, while destructive
 * quarantine counts authoritative contradicted receipt terminals only.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCuratorKnowledgeUpdates } from '../../../src/hooks/curator.js';
import {
	_internals,
	maybeQuarantineOnContradiction,
} from '../../../src/hooks/knowledge-escalator.js';
import { readKnowledgeEvents } from '../../../src/hooks/knowledge-events.js';
import type { ReceiptMembership } from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import {
	type IsolatedState,
	setupIsolatedState,
} from '../../helpers/test-isolation.js';

/**
 * Time in this file, and why `freezeClock` is deliberately NOT used.
 *
 * `maybeQuarantineOnContradiction` takes its reference instant as a parameter
 * (`now: Date = new Date()`) and compares terminal commit timestamps against
 * `now.getTime() - windowDays`. It never calls `Date.now()`, so `freezeClock`'s
 * `fixedNow` spy cannot reach it, and its `isoNow` spy would corrupt the
 * `new Date(x).toISOString()` fixtures below. The correct seam is therefore the
 * injected `now` (AGENTS.md invariant 7, DI over mocking): the four direct
 * `maybeQuarantineOnContradiction` tests pass `new Date(FROZEN_NOW)` and stamp
 * their events off `FROZEN_NOW`, which makes them hermetic — no ambient clock
 * at all, where before "now" and "60 days ago" were both live values.
 *
 * The two curator-driven tests have no such seam: `applyCuratorKnowledgeUpdates`
 * stamps the event it emits with its own `new Date()` and forwards the default
 * `now`, both read from the real clock. Their seeded events must therefore be
 * stamped against that same live clock — see `liveNowIso` below.
 */
const FROZEN_NOW = Date.parse('2026-07-01T00:00:00.000Z');
const FROZEN_ISO = new Date(FROZEN_NOW).toISOString();
let historicalMemberships: ReceiptMembership[] = [];

/**
 * A wall-clock stamp, used ONLY by the two curator-driven tests. Their events
 * have to land inside the real 30-day window that the curator's internal
 * `new Date()` computes, so a fixed literal would silently age out of the
 * window and stop exercising the threshold. Every other test uses `FROZEN_ISO`.
 */
function liveNowIso(): string {
	return new Date().toISOString();
}

function ensureSwarmDir(dir: string): string {
	const p = join(dir, '.swarm', 'knowledge-events.jsonl');
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	return p;
}

function makeEvent(o: {
	type: string;
	knowledge_id: string;
	timestamp?: string;
}): string {
	return JSON.stringify({
		type: o.type,
		event_id: randomUUID(),
		trace_id: randomUUID(),
		knowledge_id: o.knowledge_id,
		timestamp: o.timestamp ?? FROZEN_ISO,
		session_id: 'test-session',
		agent: 'test-agent',
	});
}

function writeEvents(
	dir: string,
	events: Array<{ type: string; knowledge_id: string; timestamp?: string }>,
): void {
	const fp = ensureSwarmDir(dir);
	const content = events.map((e) => makeEvent(e)).join('\n') + '\n';
	writeFileSync(fp, content, 'utf-8');
	historicalMemberships = events.map((event, index) => {
		const timestamp = event.timestamp ?? FROZEN_ISO;
		return {
			trace_id: `trace-${index}`,
			entry_id: event.knowledge_id,
			session_id: 'test-session',
			critical: false,
			committed_at: timestamp,
			membership_event_id: `membership-${index}`,
			grace_days: 7,
			exposure_kind: 'legacy_unknown',
			origin: 'v2',
			terminal: {
				outcome: event.type as 'contradicted',
				source: 'test',
				event_id: `terminal-${index}`,
				committed_at: timestamp,
			},
		} satisfies ReceiptMembership;
	});
}

function writeEntry(
	dir: string,
	opts: { id: string; status?: string; tags?: string[] },
): void {
	const fp = resolveSwarmKnowledgePath(dir);
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		fp,
		JSON.stringify({
			id: opts.id,
			tier: 'swarm',
			lesson: 'a test lesson long enough to pass validation checks here',
			category: 'process',
			tags: opts.tags ?? [],
			scope: 'global',
			confidence: 0.7,
			status: opts.status ?? 'established',
			confirmed_by: [],
			retrieval_outcomes: {},
			schema_version: 2,
			created_at: FROZEN_ISO,
			updated_at: FROZEN_ISO,
		}) + '\n',
		'utf-8',
	);
}

async function readEntryStatus(
	dir: string,
	id: string,
): Promise<string | undefined> {
	const fp = resolveSwarmKnowledgePath(dir);
	const entries = await readKnowledge<{ id: string; status: string }>(fp);
	return entries.find((e) => e.id === id)?.status;
}

const defaultConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: false,
	rejected_max_entries: 20,
	validation_enabled: false,
	evergreen_confidence: 0.9,
	evergreen_utility: 0.8,
	low_utility_threshold: 0.3,
	min_retrievals_for_utility: 3,
	schema_version: 2,
	same_project_weight: 1.0,
	cross_project_weight: 0.5,
	min_encounter_score: 0.1,
	initial_encounter_score: 1.0,
	encounter_increment: 0.1,
	max_encounter_score: 10.0,
	default_max_phases: 10,
	todo_max_phases: 3,
	sweep_enabled: true,
	confidence_floor_action: 'none' as const,
	confidence_floor_min_outcomes: 3,
	confidence_floor_signal_threshold: 0,
	contradiction_threshold_action: 'quarantine' as const,
	contradiction_quarantine_threshold: 3,
	contradiction_quarantine_window_days: 30,
	enrichment: { max_calls_per_day: 30, quota_window: 'utc' as const },
};

describe('G3 contradiction unification (#1715)', () => {
	// `setupIsolatedState` gives a realpath-canonicalized temp dir — the raw
	// `mkdtempSync` under the system temp root that this replaced left the macOS
	// /var -> /private/var symlink gap open — plus an isolated HOME/XDG so a
	// developer's real config cannot reach the curator. No `clock` option here:
	// see the note at the top of the file for why freezing would not help.
	let state: IsolatedState;
	let dir: string;
	const originalQueryHistoricalOutcomes = _internals.queryHistoricalOutcomes;
	beforeEach(() => {
		state = setupIsolatedState({ prefix: 'contradiction-test-' });
		dir = state.dir;
		historicalMemberships = [];
		_internals.queryHistoricalOutcomes = async (_directory, entryIds) => ({
			ok: true,
			memberships: entryIds
				? historicalMemberships.filter((m) => entryIds.includes(m.entry_id))
				: historicalMemberships,
		});
	});
	afterEach(() => {
		_internals.queryHistoricalOutcomes = originalQueryHistoricalOutcomes;
		state.cleanup();
	});

	test('curator flag_contradiction emits a contradicted event post-transaction', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'conflicts with new evidence',
				},
			],
			defaultConfig,
		);
		const events = await readKnowledgeEvents(dir);
		const contradicted = events.filter((e) => e.type === 'contradicted');
		expect(contradicted.length).toBe(1);
		expect(contradicted[0].knowledge_id).toBe(id);
		expect((contradicted[0] as { agent?: string }).agent).toBe('curator');
	});

	test('curator flag_contradiction still adds the tag (backward compat)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'spaces vs tabs',
				},
			],
			defaultConfig,
		);
		const entries = await readKnowledge<{ id: string; tags?: string[] }>(
			resolveSwarmKnowledgePath(dir),
		);
		expect(entries[0].tags).toContain('contradiction:spaces vs tabs');
	});

	async function flagContradiction(
		id: string,
		reason: string,
	): Promise<string[]> {
		await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'flag_contradiction', entry_id: id, lesson: 'Test', reason }],
			defaultConfig,
		);
		const entries = await readKnowledge<{ id: string; tags?: string[] }>(
			resolveSwarmKnowledgePath(dir),
		);
		return entries[0].tags ?? [];
	}

	test('flag_contradiction appends the marker and preserves tag order under the cap (#1821)', async () => {
		// Under the cap nothing has to be evicted, so historical tag order is
		// preserved — src/services/skill-generator.ts derives `slugSeed` from
		// `tags[0]` when an entry has no triggers/required_actions.
		const id = randomUUID();
		writeEntry(dir, { id, tags: ['alpha', 'beta'] });
		const tags = await flagContradiction(id, 'spaces vs tabs');
		expect(tags).toEqual(['alpha', 'beta', 'contradiction:spaces vs tabs']);
	});

	test('flag_contradiction marker survives the write-boundary cap on a full tag list (#1821)', async () => {
		// The #1821 Lane 0b store guardrail caps `tags` at 20 keeping the FIRST N.
		// While flag_contradiction APPENDED unconditionally, an entry already
		// carrying 20 tags lost the marker on write: the curator still counted the
		// update as applied and emitted a `contradicted` event, but
		// buildCuratorBriefing's `e.tags.some((t) => t.includes('contradiction'))`
		// never saw it.
		//
		// At 21 values something MUST be dropped. This pins the deliberate
		// tradeoff: the marker moves to the front and survives, and the OLDEST
		// listed tag (`tag-19`) is what gets evicted — asserted explicitly so the
		// loss is visible rather than silent.
		const id = randomUUID();
		writeEntry(dir, {
			id,
			tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`),
		});
		const tags = await flagContradiction(
			id,
			'conflicting advice about retries',
		);

		expect(tags).toHaveLength(20);
		expect(tags[0]).toBe('contradiction:conflicting advice about retries');
		// Everything except the final tag is retained, in its original order.
		expect(tags.slice(1)).toEqual(
			Array.from({ length: 19 }, (_, i) => `tag-${i}`),
		);
		expect(tags).not.toContain('tag-19');
	});

	test('maybeQuarantineOnContradiction quarantines when threshold crossed', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		// 3 contradicted events in window → threshold 3
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		const result = await maybeQuarantineOnContradiction(
			dir,
			id,
			3,
			30,
			new Date(FROZEN_NOW),
		);
		expect(result.quarantined).toBe(true);
		expect(result.contradictionsInWindow).toBe(3);
		// quarantineEntry MOVES the entry to knowledge-quarantined.jsonl, so it
		// is no longer in the active swarm file (the active read returns undefined).
		expect(await readEntryStatus(dir, id)).toBeUndefined();
		// And the quarantine file exists + contains the entry.
		const quarantinePath = join(dir, '.swarm', 'knowledge-quarantined.jsonl');
		expect(existsSync(quarantinePath)).toBe(true);
		const qContent = readFileSync(quarantinePath, 'utf-8');
		expect(qContent).toContain(id);
	});

	test('maybeQuarantineOnContradiction does NOT quarantine below threshold', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		const result = await maybeQuarantineOnContradiction(
			dir,
			id,
			3,
			30,
			new Date(FROZEN_NOW),
		);
		expect(result.quarantined).toBe(false);
		expect(await readEntryStatus(dir, id)).toBe('established');
	});

	test('ledger uncertainty cannot authorize quarantine', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		_internals.queryHistoricalOutcomes = async () => ({
			ok: false,
			code: 'store_corrupt',
			detail: 'corrupt',
			uncertainty: 'corrupt',
		});
		const result = await maybeQuarantineOnContradiction(dir, id, 1, 30);
		expect(result).toEqual({ quarantined: false, entryId: id });
		expect(await readEntryStatus(dir, id)).toBe('established');
	});

	test('maybeQuarantineOnContradiction is idempotent on already-quarantined entry', async () => {
		const id = randomUUID();
		writeEntry(dir, { id, status: 'quarantined' });
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
			{ type: 'contradicted', knowledge_id: id },
		]);
		const result = await maybeQuarantineOnContradiction(
			dir,
			id,
			3,
			30,
			new Date(FROZEN_NOW),
		);
		expect(result.quarantined).toBe(false);
		expect(result.alreadyInactive).toBe(true);
	});

	test('maybeQuarantineOnContradiction respects the window (old events excluded)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		// 60 days before the injected reference instant.
		const old = new Date(FROZEN_NOW - 60 * 24 * 60 * 60 * 1000).toISOString();
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id, timestamp: old },
			{ type: 'contradicted', knowledge_id: id, timestamp: old },
			{ type: 'contradicted', knowledge_id: id, timestamp: old },
		]);
		// 3 events but all >30d old → within 30d window = 0 → no quarantine
		const result = await maybeQuarantineOnContradiction(
			dir,
			id,
			3,
			30,
			new Date(FROZEN_NOW),
		);
		expect(result.quarantined).toBe(false);
	});

	test('curator diagnostic contradiction cannot satisfy an authoritative quarantine threshold', async () => {
		// Seed two authoritative contradicted terminals, then run a curator
		// flag_contradiction, which emits a third diagnostic observation only.
		const id = randomUUID();
		writeEntry(dir, { id });
		// Live stamps: the curator emits its own event with `new Date()` and
		// evaluates the window against the real clock (see the note at the top).
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id, timestamp: liveNowIso() },
			{ type: 'contradicted', knowledge_id: id, timestamp: liveNowIso() },
		]);
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'third strike',
				},
			],
			defaultConfig,
		);
		// Two authoritative terminals stay below the threshold. The diagnostic
		// FIFO row cannot authorize a destructive quarantine.
		expect(await readEntryStatus(dir, id)).toBe('established');
		const quarantinePath = join(dir, '.swarm', 'knowledge-quarantined.jsonl');
		expect(existsSync(quarantinePath)).toBe(false);
	});

	test('curator tag_only config preserves legacy behavior (no quarantine)', async () => {
		const id = randomUUID();
		writeEntry(dir, { id });
		// Live stamps: the curator emits its own event with `new Date()` and
		// evaluates the window against the real clock (see the note at the top).
		writeEvents(dir, [
			{ type: 'contradicted', knowledge_id: id, timestamp: liveNowIso() },
			{ type: 'contradicted', knowledge_id: id, timestamp: liveNowIso() },
		]);
		await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: id,
					lesson: 'Test',
					reason: 'third strike',
				},
			],
			{ ...defaultConfig, contradiction_threshold_action: 'tag_only' },
		);
		// 3 contradicted events but tag_only → no quarantine, entry stays established
		expect(await readEntryStatus(dir, id)).toBe('established');
	});
});
