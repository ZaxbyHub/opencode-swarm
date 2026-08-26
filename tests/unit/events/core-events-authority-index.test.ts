/**
 * Issue #2039 — authority partition of the core event store.
 *
 * The closed set of correctness-relevant event types
 * (`coder_retry_circuit_breaker`, `task_workflow_repaired`,
 * `spec_drift_acknowledged`, `spec_drift_repaired`) is indexed into
 * `.swarm/events-authority-index.json` at append time, fold time (BEFORE a
 * line leaves the window), and read time (self-healing). These tests pin:
 * index-first answers, legacy window fallback + self-heal, dedupe
 * at-most-once semantics, crash-window recovery, fail-closed corrupt-index
 * behavior, FIFO eviction disclosure, and the C1 property — compaction can
 * never make an authority verdict wrong.
 *
 * Tests override `_internals.limits` (small budgets) and `_internals.emitHealth`
 * and restore them in `afterEach` (the `_internals` DI seam is file-scoped and
 * leak-free across Bun's shared test-runner process).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_resetMaintenanceCounters,
	appendCoreEventSync,
	CORE_EVENT_LIMITS,
	type CoreEventLimits,
	compactCoreEvents,
	getCoderRetryEscalationActions,
	hasSpecDriftAuditEvent,
	hasTaskRepairAuditEvent,
} from '../../../src/events/core-events';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function mkTempDir(): string {
	return canonicalMkdtemp('core-events-auth-');
}

function eventsFile(dir: string): string {
	return path.join(dir, '.swarm', 'events.jsonl');
}

function indexPath(dir: string): string {
	return path.join(dir, '.swarm', 'events-authority-index.json');
}

function rawLines(dir: string): string[] {
	return fs
		.readFileSync(eventsFile(dir), 'utf-8')
		.split('\n')
		.filter((l) => l.trim() !== '');
}

/** Rewrite events.jsonl keeping ONLY the manifest line (drops event lines). */
function stripWindowToManifest(dir: string): void {
	const manifestLine = rawLines(dir)[0] ?? '';
	fs.writeFileSync(eventsFile(dir), `${manifestLine}\n`, 'utf-8');
}

function readIndex(dir: string): {
	entries: Record<string, string>;
	evicted: number;
} {
	return JSON.parse(fs.readFileSync(indexPath(dir), 'utf-8')) as {
		entries: Record<string, string>;
		evicted: number;
	};
}

/** Small budgets, clock-decoupled (age disabled), maintenance manual. */
function tinyLimits(over: Partial<CoreEventLimits> = {}): CoreEventLimits {
	return {
		...CORE_EVENT_LIMITS,
		ageMaxMs: Number.MAX_SAFE_INTEGER,
		checkInterval: 1_000_000,
		...over,
	};
}

const TS = '2026-01-01T00:00:00.000Z';

function repairEvent(
	taskId: string,
	transitionId: string,
): Record<string, unknown> {
	return {
		type: 'task_workflow_repaired',
		taskId,
		transitionId,
		timestamp: TS,
	};
}

function retryEvent(
	taskId: string,
	retryEpoch: number,
	action: 'sounding_board_consultation' | 'simplification' | 'user_escalation',
): Record<string, unknown> {
	return {
		type: 'coder_retry_circuit_breaker',
		taskId,
		retryEpoch,
		action,
		timestamp: TS,
	};
}

function driftEvent(
	kind: 'spec_drift_acknowledged' | 'spec_drift_repaired',
	transitionId: string,
): Record<string, unknown> {
	return { type: kind, transitionId, timestamp: TS };
}

describe('core event store — authority index (issue #2039)', () => {
	let dir: string;
	const originalEmitHealth = _internals.emitHealth;

	beforeEach(() => {
		dir = mkTempDir();
		_resetMaintenanceCounters();
		_internals.emitHealth = (() => {}) as typeof _internals.emitHealth;
	});

	afterEach(() => {
		_internals.limits = CORE_EVENT_LIMITS as typeof _internals.limits;
		_internals.emitHealth = originalEmitHealth;
		_resetMaintenanceCounters();
		fs.rmSync(dir, { force: true, recursive: true });
	});

	describe('index-first answers', () => {
		test('queries stay true when the event LINE is gone but the index entry remains', () => {
			_internals.limits = tinyLimits();
			appendCoreEventSync(dir, repairEvent('T1', 'tr-1'));
			appendCoreEventSync(
				dir,
				retryEvent('T9', 2, 'sounding_board_consultation'),
			);
			appendCoreEventSync(dir, retryEvent('T9', 2, 'simplification'));
			appendCoreEventSync(dir, driftEvent('spec_drift_repaired', 'dr-1'));
			// The index exists and carries all four authority keys.
			expect(Object.keys(readIndex(dir).entries).length).toBe(4);

			// Delete every event line from the file, keeping only the manifest.
			stripWindowToManifest(dir);
			expect(rawLines(dir).length).toBe(1); // window is empty

			// Only the index can answer now.
			expect(hasTaskRepairAuditEvent(dir, 'T1', 'tr-1')).toBe(true);
			expect([...getCoderRetryEscalationActions(dir, 'T9', 2)].sort()).toEqual([
				'simplification',
				'sounding_board_consultation',
			]);
			expect(hasSpecDriftAuditEvent(dir, 'spec_drift_repaired', 'dr-1')).toBe(
				true,
			);
		});

		test('index AND window both miss -> false / empty set', () => {
			_internals.limits = tinyLimits();
			appendCoreEventSync(dir, { type: 'op', seq: 1, timestamp: TS });
			expect(hasTaskRepairAuditEvent(dir, 'nope', 'nope')).toBe(false);
			expect(
				hasSpecDriftAuditEvent(dir, 'spec_drift_acknowledged', 'nope'),
			).toBe(false);
			expect(getCoderRetryEscalationActions(dir, 'nope', 7).size).toBe(0);
		});
	});

	describe('legacy fallback + self-healing', () => {
		test('legacy file with an authority line but NO index: query true AND the index self-heals', () => {
			_internals.limits = tinyLimits();
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				eventsFile(dir),
				`${JSON.stringify(repairEvent('T1', 'tr-1'))}\n`,
				'utf-8',
			);
			expect(fs.existsSync(indexPath(dir))).toBe(false);

			expect(hasTaskRepairAuditEvent(dir, 'T1', 'tr-1')).toBe(true);
			expect(fs.existsSync(indexPath(dir))).toBe(true);
			expect(readIndex(dir).entries['repair|T1|tr-1']).toBeDefined();
		});

		test('legacy retry line: actions answered from the window AND the index self-heals', () => {
			_internals.limits = tinyLimits();
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				eventsFile(dir),
				`${JSON.stringify(retryEvent('T2', 1, 'user_escalation'))}\n`,
				'utf-8',
			);
			const actions = getCoderRetryEscalationActions(dir, 'T2', 1);
			expect([...actions]).toEqual(['user_escalation']);
			expect(
				readIndex(dir).entries['retry|T2|1|user_escalation'],
			).toBeDefined();
		});
	});

	describe('dedupeOnAuthorityKey (at-most-once audit)', () => {
		test('second append of the same authority key is skipped; distinct keys still append', () => {
			_internals.limits = tinyLimits();
			const event = repairEvent('T1', 'tr-1');
			appendCoreEventSync(dir, event, { dedupeOnAuthorityKey: true });
			appendCoreEventSync(dir, event, { dedupeOnAuthorityKey: true });
			expect(rawLines(dir).length - 1).toBe(1); // no duplicate line

			appendCoreEventSync(dir, repairEvent('T1', 'tr-2'), {
				dedupeOnAuthorityKey: true,
			});
			expect(rawLines(dir).length - 1).toBe(2); // distinct key appends
		});

		test('crash window: index deleted -> dedupe append still skips (window scan) and the query re-indexes', () => {
			_internals.limits = tinyLimits();
			appendCoreEventSync(dir, repairEvent('T1', 'tr-1'));
			fs.unlinkSync(indexPath(dir)); // simulate crash before index write

			// The dedupe append must NOT duplicate the line: the window scan
			// finds the authority line even though the index is gone.
			appendCoreEventSync(dir, repairEvent('T1', 'tr-1'), {
				dedupeOnAuthorityKey: true,
			});
			expect(rawLines(dir).length - 1).toBe(1);
			expect(fs.existsSync(indexPath(dir))).toBe(false); // skip does not write

			// The read-time self-heal point re-creates the index entry.
			expect(hasTaskRepairAuditEvent(dir, 'T1', 'tr-1')).toBe(true);
			expect(fs.existsSync(indexPath(dir))).toBe(true);
			expect(readIndex(dir).entries['repair|T1|tr-1']).toBeDefined();
		});
	});

	describe('fail-closed corrupt index', () => {
		test('corrupt index JSON makes every authority query throw CORE_EVENT_AUTHORITY_INDEX_UNREADABLE', () => {
			_internals.limits = tinyLimits();
			appendCoreEventSync(dir, repairEvent('T1', 'tr-1'));
			fs.writeFileSync(indexPath(dir), 'NOT JSON AT ALL', 'utf-8');
			expect(() => hasTaskRepairAuditEvent(dir, 'T1', 'tr-1')).toThrow(
				'CORE_EVENT_AUTHORITY_INDEX_UNREADABLE',
			);
			expect(() =>
				hasSpecDriftAuditEvent(dir, 'spec_drift_acknowledged', 'dr-1'),
			).toThrow('CORE_EVENT_AUTHORITY_INDEX_UNREADABLE');
			expect(() => getCoderRetryEscalationActions(dir, 'T1', 1)).toThrow(
				'CORE_EVENT_AUTHORITY_INDEX_UNREADABLE',
			);
		});

		test('well-formed JSON with the wrong shape is also treated as corrupt', () => {
			_internals.limits = tinyLimits();
			appendCoreEventSync(dir, repairEvent('T1', 'tr-1'));
			fs.writeFileSync(indexPath(dir), '{"version":2,"entries":{}}', 'utf-8');
			expect(() => hasTaskRepairAuditEvent(dir, 'T1', 'tr-1')).toThrow(
				'CORE_EVENT_AUTHORITY_INDEX_UNREADABLE',
			);
		});
	});

	describe('FIFO eviction (authorityIndexMaxEntries)', () => {
		test('cap evicts the oldest key and discloses it via the persisted counter; evicted key falls back to the window', () => {
			_internals.limits = tinyLimits({ authorityIndexMaxEntries: 2 });
			for (let i = 0; i < 3; i += 1) {
				appendCoreEventSync(dir, repairEvent(`T${i}`, `tr-${i}`));
			}
			compactCoreEvents(dir); // generous budgets: all 3 lines stay in window
			const index = readIndex(dir);
			expect(Object.keys(index.entries).length).toBe(2);
			expect(index.evicted).toBeGreaterThanOrEqual(1);

			const allKeys = [0, 1, 2].map((i) => `repair|T${i}|tr-${i}`);
			const evictedKey = allKeys.find((k) => index.entries[k] === undefined);
			expect(evictedKey).toBeDefined();
			// The evicted key is still answerable while its line remains in the
			// retained window (window fallback).
			const parts = evictedKey!.split('|');
			expect(hasTaskRepairAuditEvent(dir, parts[1]!, parts[2]!)).toBe(true);
			// The two indexed keys answer from the index.
			for (const key of Object.keys(index.entries)) {
				const p = key.split('|');
				expect(hasTaskRepairAuditEvent(dir, p[1]!, p[2]!)).toBe(true);
			}
		});

		test('evicted key whose line has ALSO left the window answers absent (false)', () => {
			_internals.limits = tinyLimits({
				authorityIndexMaxEntries: 2,
				activeMaxEntries: 0, // every line folds out of the window
				compactMaxBytes: 65_536,
			});
			for (let i = 0; i < 3; i += 1) {
				appendCoreEventSync(dir, repairEvent(`T${i}`, `tr-${i}`));
			}
			compactCoreEvents(dir);
			expect(rawLines(dir).length).toBe(1); // manifest only — window empty
			const index = readIndex(dir);
			expect(Object.keys(index.entries).length).toBe(2);
			expect(index.evicted).toBeGreaterThanOrEqual(1);

			const allKeys = [0, 1, 2].map((i) => `repair|T${i}|tr-${i}`);
			const evictedKey = allKeys.find((k) => index.entries[k] === undefined);
			expect(evictedKey).toBeDefined();
			const parts = evictedKey!.split('|');
			expect(hasTaskRepairAuditEvent(dir, parts[1]!, parts[2]!)).toBe(false);
			for (const key of Object.keys(index.entries)) {
				const p = key.split('|');
				expect(hasTaskRepairAuditEvent(dir, p[1]!, p[2]!)).toBe(true);
			}
		});
	});

	describe('C1 property — compact-then-verify verdict stability', () => {
		test('coder retry escalation actions survive compaction that folds their lines out of the window', () => {
			_internals.limits = tinyLimits({
				activeMaxEntries: 0, // compaction folds EVERYTHING out
				compactMaxBytes: 65_536,
			});
			appendCoreEventSync(
				dir,
				retryEvent('T9', 2, 'sounding_board_consultation'),
			);
			appendCoreEventSync(dir, retryEvent('T9', 2, 'simplification'));
			appendCoreEventSync(dir, retryEvent('T9', 1, 'user_escalation')); // other epoch
			// Sanity: the window answers before compaction.
			expect(getCoderRetryEscalationActions(dir, 'T9', 2).size).toBe(2);

			compactCoreEvents(dir);
			expect(rawLines(dir).length).toBe(1); // lines are gone from the window

			// THE C1 invariant: fold-time indexing keeps the verdict identical.
			expect([...getCoderRetryEscalationActions(dir, 'T9', 2)].sort()).toEqual([
				'simplification',
				'sounding_board_consultation',
			]);
			expect([...getCoderRetryEscalationActions(dir, 'T9', 1)].sort()).toEqual([
				'user_escalation',
			]);
			expect(getCoderRetryEscalationActions(dir, 'T9', 3).size).toBe(0);
		});

		test('task repair audit presence survives compaction (fold-time indexing)', () => {
			_internals.limits = tinyLimits({
				activeMaxEntries: 0,
				compactMaxBytes: 65_536,
			});
			appendCoreEventSync(dir, repairEvent('T8', 'tr-8'));
			compactCoreEvents(dir);
			expect(rawLines(dir).length).toBe(1); // folded out of the window
			expect(hasTaskRepairAuditEvent(dir, 'T8', 'tr-8')).toBe(true);
			expect(hasTaskRepairAuditEvent(dir, 'T8', 'tr-other')).toBe(false);
		});

		test('spec drift audit presence survives compaction for BOTH kinds, keyed per kind', () => {
			_internals.limits = tinyLimits({
				activeMaxEntries: 0,
				compactMaxBytes: 65_536,
			});
			appendCoreEventSync(dir, driftEvent('spec_drift_acknowledged', 'dr-1'));
			appendCoreEventSync(dir, driftEvent('spec_drift_repaired', 'dr-2'));
			compactCoreEvents(dir);
			expect(rawLines(dir).length).toBe(1); // folded out of the window
			expect(
				hasSpecDriftAuditEvent(dir, 'spec_drift_acknowledged', 'dr-1'),
			).toBe(true);
			expect(hasSpecDriftAuditEvent(dir, 'spec_drift_repaired', 'dr-2')).toBe(
				true,
			);
			// Keys are kind-scoped: the acknowledged key must not answer the
			// repaired query for the same transition.
			expect(hasSpecDriftAuditEvent(dir, 'spec_drift_repaired', 'dr-1')).toBe(
				false,
			);
			expect(
				hasSpecDriftAuditEvent(dir, 'spec_drift_acknowledged', 'nope'),
			).toBe(false);
		});
	});
});
