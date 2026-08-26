/**
 * Issue #2039 — close/finalize cut for the core event store.
 *
 * `finalizeCoreEventsForClose` must leave an archived-cut-ready store:
 * a header'd over-budget store folds into a VALIDATED cut (manifest parses,
 * file ends with a newline, lifetime count preserved), a legacy header-less
 * file drains to convergence (bounded passes) producing a manifest'd store,
 * and missing/empty `.swarm` is a no-op. The archived cut contract: after
 * finalize, readCoreEvents coverage reflects the compacted store and
 * getCoreEventLifetimeCount equals the pre-finalize count.
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
	finalizeCoreEventsForClose,
	getCoreEventCoverage,
	getCoreEventLifetimeCount,
	readCoreEvents,
} from '../../../src/events/core-events';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function mkTempDir(): string {
	return canonicalMkdtemp('core-events-close-');
}

function eventsFile(dir: string): string {
	return path.join(dir, '.swarm', 'events.jsonl');
}

function rawLines(dir: string): string[] {
	return fs
		.readFileSync(eventsFile(dir), 'utf-8')
		.split('\n')
		.filter((l) => l.trim() !== '');
}

function manifestOf(dir: string): {
	type: string;
	schemaVersion: number;
	folded: { totalEvents: number };
} {
	return JSON.parse(rawLines(dir)[0] ?? '{}');
}

/** Assert the archived-cut framing: manifest at line 1, trailing newline. */
function expectValidCut(dir: string): void {
	const content = fs.readFileSync(eventsFile(dir), 'utf-8');
	expect(content.endsWith('\n')).toBe(true);
	const manifest = manifestOf(dir);
	expect(manifest.type).toBe('swarm-events-manifest');
	expect(manifest.schemaVersion).toBe(1);
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

function opEvent(seq: number, pad = 80): Record<string, unknown> {
	return {
		type: 'op',
		seq,
		pad: 'x'.repeat(pad),
		timestamp: '2026-01-01T00:00:00.000Z',
	};
}

describe('core event store — close/finalize cut (issue #2039)', () => {
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

	test("header'd over-budget store: finalize folds everything non-retained into the manifest and leaves a valid cut", () => {
		// checkInterval huge -> maintenance never runs during the appends, so
		// the store is header'd but over its entry budget (20 lines > 3).
		_internals.limits = tinyLimits({
			activeMaxEntries: 3,
			activeMaxBytes: 1_000_000,
			compactMaxBytes: 4096,
		});
		for (let i = 0; i < 20; i += 1) appendCoreEventSync(dir, opEvent(i));
		const before = getCoreEventLifetimeCount(dir);
		expect(before).toBe(20);
		expect(manifestOf(dir).folded.totalEvents).toBe(0); // nothing folded yet

		finalizeCoreEventsForClose(dir);

		expectValidCut(dir);
		const manifest = manifestOf(dir);
		expect(manifest.folded.totalEvents).toBe(17); // 20 - 3 retained
		const windowSeqs = rawLines(dir)
			.slice(1)
			.map((l) => (JSON.parse(l) as { seq: number }).seq);
		expect(windowSeqs).toEqual([17, 18, 19]); // newest retained

		// Archived cut contract: lifetime preserved, coverage reflects the
		// compacted (still in-bounds) store.
		expect(getCoreEventLifetimeCount(dir)).toBe(before);
		expect(getCoreEventCoverage(dir)).toBe('complete');
		expect(readCoreEvents(dir).coverage).toBe('complete');
	});

	test('legacy header-less file: finalize drains to convergence and produces a manifest store (bounded passes)', () => {
		_internals.limits = tinyLimits({
			compactMaxBytes: 256, // force bounded fold passes
			activeMaxEntries: 4,
			activeMaxBytes: 1_000_000,
		});
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const legacy: string[] = [];
		for (let i = 0; i < 60; i += 1) legacy.push(JSON.stringify(opEvent(i)));
		fs.writeFileSync(eventsFile(dir), `${legacy.join('\n')}\n`, 'utf-8');
		const before = getCoreEventLifetimeCount(dir);
		expect(before).toBe(60); // legacy within the read bound: complete count

		finalizeCoreEventsForClose(dir);

		expectValidCut(dir);
		const manifest = manifestOf(dir);
		expect(manifest.folded.totalEvents).toBe(56); // 60 - 4 retained
		const windowSeqs = rawLines(dir)
			.slice(1)
			.map((l) => (JSON.parse(l) as { seq: number }).seq);
		expect(windowSeqs).toEqual([56, 57, 58, 59]);
		expect(getCoreEventLifetimeCount(dir)).toBe(before); // nothing lost
		expect(getCoreEventCoverage(dir)).toBe('complete');
	});

	test('finalize on a fresh/empty project is a safe no-op (no throw, no file)', () => {
		_internals.limits = tinyLimits();
		// Missing .swarm entirely.
		expect(() => finalizeCoreEventsForClose(dir)).not.toThrow();
		expect(fs.existsSync(eventsFile(dir))).toBe(false);
		// Empty .swarm directory, no events file.
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		expect(() => finalizeCoreEventsForClose(dir)).not.toThrow();
		expect(fs.existsSync(eventsFile(dir))).toBe(false);
		expect(getCoreEventLifetimeCount(dir)).toBe(0);
	});

	test('archived cut contract on an already-compacted store: finalize preserves lifetime and re-cuts cleanly', () => {
		// checkInterval=1 -> the append path already compacted some events, so
		// the manifest carries a folded aggregate BEFORE finalize runs.
		_internals.limits = tinyLimits({
			checkInterval: 1,
			activeMaxEntries: 3,
			activeMaxBytes: 2048,
			compactMaxBytes: 1024,
		});
		for (let i = 0; i < 30; i += 1) appendCoreEventSync(dir, opEvent(i));
		const preManifest = manifestOf(dir);
		expect(preManifest.folded.totalEvents).toBeGreaterThan(0); // already folded
		const before = getCoreEventLifetimeCount(dir);
		expect(before).toBe(30);

		finalizeCoreEventsForClose(dir);

		expectValidCut(dir);
		const manifest = manifestOf(dir);
		expect(manifest.folded.totalEvents).toBe(27); // 30 - 3 retained
		expect(rawLines(dir).length).toBe(4); // manifest + newest 3
		expect(getCoreEventLifetimeCount(dir)).toBe(before); // == pre-finalize
		const coverage = getCoreEventCoverage(dir);
		expect(coverage === 'complete' || coverage === 'empty').toBe(true);
		expect(
			readCoreEvents(dir)
				.text.split('\n')
				.filter((l) => l.trim() !== '').length,
		).toBe(3);

		// Idempotency (review blind spot): a second finalize on the already-cut
		// store must be a semantic no-op — identical event lines and folded
		// aggregate (only the manifest's updatedAt may refresh), same lifetime.
		const cutLines = rawLines(dir).slice(1); // event lines only
		const cutFolded = JSON.stringify(manifestOf(dir).folded);
		finalizeCoreEventsForClose(dir);
		expect(rawLines(dir).slice(1)).toEqual(cutLines);
		expect(JSON.stringify(manifestOf(dir).folded)).toBe(cutFolded);
		expect(getCoreEventLifetimeCount(dir)).toBe(before);
	});
});
