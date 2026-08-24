/**
 * Issue #2037 — health event + limits-constant surface for the bounded
 * context-map telemetry store (split from telemetry-bounded.test.ts to keep
 * each file under the 500-line cap, AGENTS.md invariant 7 / FR-006).
 *
 * Exercises: the canonical `context_telemetry_health` payload shape (counts
 * only — no capsule/query content), oversized-record handling, and the
 * documented constant inequality (read bound covers the active window +
 * header + slack).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	CONTEXT_TELEMETRY_LIMITS,
	type ContextTelemetryLimits,
	getTelemetrySummary,
	recordTelemetry,
	type TelemetryEntry,
} from '../../../src/context-map/telemetry';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeEntry(overrides: Partial<TelemetryEntry> = {}): TelemetryEntry {
	return {
		timestamp: '2026-01-01T00:00:00.000Z',
		task_id: '1.1',
		agent_role: 'coder',
		delegation_reason: 'context_requested',
		token_estimate: 1000,
		cache_hits: 5,
		cache_misses: 2,
		stale_entries: 0,
		recommended_reads: 3,
		skipped_reads: 7,
		success: true,
		...overrides,
	};
}

function mkTempDir(): string {
	return canonicalMkdtemp('ctx-telemetry-health-');
}

function tinyLimits(): ContextTelemetryLimits {
	return {
		...CONTEXT_TELEMETRY_LIMITS,
		activeMaxBytes: 4 * 1024,
		activeMaxEntries: 8,
		compactMaxBytes: 2 * 1024,
		checkInterval: 1, // run maintenance on every write
		ageMaxMs: Number.MAX_SAFE_INTEGER, // never age-prune in these tests
	};
}

interface HealthCapture {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	payloads: any[];
}

describe('context-map telemetry bounded store — health + limits (issue #2037)', () => {
	let dir: string;
	const originalEmitHealth = _internals.emitHealth;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let health: HealthCapture;

	beforeEach(() => {
		dir = mkTempDir();
		health = { payloads: [] };
		_internals.emitHealth = ((
			_directory: string,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			payload: any,
		) => {
			health.payloads.push(payload);
		}) as typeof _internals.emitHealth;
	});

	afterEach(() => {
		_internals.limits = CONTEXT_TELEMETRY_LIMITS as typeof _internals.limits;
		_internals.emitHealth = originalEmitHealth;
		fs.rmSync(dir, { force: true, recursive: true });
	});

	describe('oversized single record', () => {
		test('a record larger than the active budget cannot be lost; it is folded into the aggregate', () => {
			_internals.limits = tinyLimits() as typeof _internals.limits;
			const big = makeEntry({
				task_id: 'big',
				delegation_reason: 'x'.repeat(16 * 1024), // > activeMaxBytes (4 KiB)
			});
			expect(recordTelemetry(big, dir)).toBe(true);
			const summary = getTelemetrySummary(dir);
			// The oversized record is accounted exactly once (folded), never lost.
			expect(summary.total_delegations).toBe(1);
			expect(summary.coverage).toBe('complete');
		});
	});

	describe('health event payload (canonical contract, counts only)', () => {
		test('compaction emits accepted/compacted/retained/dropped/corrupt/oldest/newest/bytes', () => {
			_internals.limits = tinyLimits() as typeof _internals.limits;
			recordTelemetry(makeEntry({ task_id: '0.1' }), dir);
			// checkInterval=1 ⇒ the second write triggers maintenance/compaction.
			recordTelemetry(makeEntry({ task_id: '1.1' }), dir);
			expect(health.payloads.length).toBeGreaterThan(0);
			const last = health.payloads[health.payloads.length - 1];
			expect(typeof last.accepted).toBe('number');
			expect(typeof last.compacted).toBe('number');
			expect(typeof last.retained).toBe('number');
			expect(typeof last.dropped).toBe('number');
			expect(typeof last.corrupt).toBe('number');
			expect(last.oldest === null || typeof last.oldest === 'string').toBe(
				true,
			);
			expect(last.newest === null || typeof last.newest === 'string').toBe(
				true,
			);
			expect(typeof last.bytes).toBe('number');
			expect(typeof last.limitBytes).toBe('number');
			// No capsule/query content ever enters the payload.
			const serialized = JSON.stringify(last);
			expect(serialized).not.toContain('context_requested');
		});
	});
});

// Guard the documented constant inequality (issue #2037): the hard read bound
// must always cover the active window + header + slack.
describe('context-map telemetry constant sanity', () => {
	test('readMaxBytes >= activeMaxBytes + headerMaxBytes + 1 KiB slack', () => {
		expect(CONTEXT_TELEMETRY_LIMITS.readMaxBytes).toBeGreaterThanOrEqual(
			CONTEXT_TELEMETRY_LIMITS.activeMaxBytes +
				CONTEXT_TELEMETRY_LIMITS.headerMaxBytes +
				1024,
		);
	});
});
