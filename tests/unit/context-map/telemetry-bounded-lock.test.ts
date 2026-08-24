/**
 * Issue #2037 review F-2/F-4/F-5 — store-lock and torn-tail regression tests.
 *
 * F-5: withStoreLock's held / stale-break / release paths had zero coverage.
 * F-2: recordTelemetry must write under the store lock and report an honest
 *      false when the lock is busy (not a false success).
 * F-4: an append must never land on a crash-torn final line.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_resetMaintenanceCounters,
	CONTEXT_TELEMETRY_LIMITS,
	getTelemetrySummary,
	readTelemetry,
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
	return canonicalMkdtemp('ctx-telemetry-lock-');
}

describe('context-map telemetry store lock (issue #2037 F-2/F-4/F-5)', () => {
	let dir: string;
	let swarmDir: string;
	let lockPath: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkTempDir();
		swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		lockPath = path.join(swarmDir, 'context-telemetry.lock');
		filePath = path.join(swarmDir, 'context-telemetry.jsonl');
	});

	afterEach(() => {
		_internals.limits = CONTEXT_TELEMETRY_LIMITS as typeof _internals.limits;
		_resetMaintenanceCounters();
		fs.rmSync(dir, { force: true, recursive: true });
	});

	test('F-5: free lock — fn runs, result returned, lock released', () => {
		const result = _internals.withStoreLock(dir, () => 42);
		expect(result).toBe(42);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	test('F-5: lock held (fresh) — fn does NOT run, returns null, lock intact', () => {
		fs.writeFileSync(lockPath, '', 'utf-8'); // fresh mtime — not stale
		let ran = false;
		const result = _internals.withStoreLock(dir, () => {
			ran = true;
			return 1;
		});
		expect(result).toBeNull();
		expect(ran).toBe(false);
		expect(fs.existsSync(lockPath)).toBe(true); // not stolen, not deleted
	});

	test('F-5: ancient lock is stale-broken — fn runs, lock released', () => {
		fs.writeFileSync(lockPath, '', 'utf-8');
		const ancient = new Date(Date.now() - 10 * 60_000); // > 5 min
		fs.utimesSync(lockPath, ancient, ancient);
		const result = _internals.withStoreLock(dir, () => 'ok');
		expect(result).toBe('ok');
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	test('F-5: lock is released even when fn throws', () => {
		expect(() =>
			_internals.withStoreLock(dir, () => {
				throw new Error('boom');
			}),
		).toThrow('boom');
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	test('F-2: recordTelemetry with the lock held returns false (honest, not written)', () => {
		fs.writeFileSync(lockPath, '', 'utf-8'); // held by a "sibling" process
		expect(recordTelemetry(makeEntry({ task_id: 'a.1' }), dir)).toBe(false);
		// Nothing was written — no false success.
		expect(fs.existsSync(filePath)).toBe(false);
		// Recovery: once the lock is gone, the next write succeeds.
		fs.unlinkSync(lockPath);
		expect(recordTelemetry(makeEntry({ task_id: 'a.1' }), dir)).toBe(true);
		expect(getTelemetrySummary(dir).total_delegations).toBe(1);
	});

	test('F-4: an append never lands on a crash-torn final line', () => {
		// Seed a valid header + one record whose final newline was lost in a
		// crash (torn tail).
		const manifest = {
			v: 2,
			type: 'ctx-telemetry-manifest',
			schemaVersion: 2,
			folded: {
				delegations: 0,
				successCount: 0,
				cacheHits: 0,
				cacheMisses: 0,
				staleEntries: 0,
				tokenSum: 0,
				recommendedReads: 0,
				skippedReads: 0,
				corrupt: 0,
				dropped: 0,
				oldestTimestamp: '2026-01-01T00:00:00.000Z',
				newestTimestamp: '2026-01-01T00:00:00.000Z',
			},
			updatedAt: '2026-01-01T00:00:00.000Z',
		};
		const torn = `${JSON.stringify(manifest)}\n${JSON.stringify(
			makeEntry({ task_id: 'torn.1' }),
		)}`; // NOTE: no trailing newline — torn tail
		fs.writeFileSync(filePath, torn, 'utf-8');

		expect(recordTelemetry(makeEntry({ task_id: 'next.1' }), dir)).toBe(true);
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim() !== '');
		// header + torn record + new record — the new record is its own line,
		// not silently merged into the torn one.
		expect(lines.length).toBe(3);
		const entries = readTelemetry(dir).map((e) => e.task_id);
		expect(entries).toContain('torn.1');
		expect(entries).toContain('next.1');
	});

	test('F-2/F-4 combined: lock-held write neither appends nor repairs a torn tail', () => {
		fs.writeFileSync(filePath, '{"torn": true', 'utf-8'); // torn, no newline
		fs.writeFileSync(lockPath, '', 'utf-8'); // lock held
		expect(recordTelemetry(makeEntry({ task_id: 'x.1' }), dir)).toBe(false);
		// File untouched (still exactly the torn content).
		expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"torn": true');
	});
});
