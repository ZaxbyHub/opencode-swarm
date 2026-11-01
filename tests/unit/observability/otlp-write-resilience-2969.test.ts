// #2969 (SIB3-2): the OTLP exporter's spool/state writes ride the shared
// bounded-retry rename; the non-atomic canonical-clobber fallback is gone;
// terminal failures clean the temp, are counted ONCE at the record-owning
// boundary under the precise class, and never break the fail-open emit path.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	OTLP_EXPORT_SPOOL_DIR,
	_internals as otlpInternals,
	readOtlpExporterHealth,
	registerOtlpExporter,
	resetOtlpExporterForTesting,
} from '../../../src/observability/otlp-exporter.js';
import {
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { testExportConfig } from './otlp-fixtures.js';

const SPOOL_DIR = OTLP_EXPORT_SPOOL_DIR;
const NEVER_COLLECTOR = 'http://127.0.0.1:9/';

const JUNK = {
	tokens_input: 120,
	tokens_output: 80,
	tokens_cache: 10,
	tokens_reasoning: 5,
	cost_usd: 0.012,
	model: 'test-model-7b',
	agentName: 'coder',
	prompt: 'JUNKPROMPT7f3a',
	code: 'JUNKCODE9b1',
	path: 'JUNKPATH5c2',
};

function spoolPathOf(dir: string): string {
	return join(dir, SPOOL_DIR, 'spool.jsonl');
}

function spoolDirEntries(dir: string): string[] {
	const sd = join(dir, SPOOL_DIR);
	if (!existsSync(sd)) return [];
	return readdirSync(sd);
}

function ebusy(): Error {
	const err = new Error('EBUSY (test): permanent hold') as Error & {
		code?: string;
	};
	err.code = 'EBUSY';
	return err;
}

afterEach(() => {
	resetOtlpExporterForTesting();
	resetTelemetryForTesting();
	otlpInternals.renameWithRetry = realOtlpRename;
	atomicWriteInternals.renameSync = realAtomicRename;
});

const realOtlpRename = otlpInternals.renameWithRetry;
const realAtomicRename = atomicWriteInternals.renameSync;

describe('otlp exporter write resilience (#2969, SIB3-2)', () => {
	test('transient EPERM on the spool rename is retried by the REAL shared loop; the spool lands atomically with no tmp residue', async () => {
		const dir = canonicalMkdtemp('otlp-wr-2969-');
		initTelemetry(dir);
		let calls = 0;
		atomicWriteInternals.renameSync = ((from: string, to: string) => {
			calls += 1;
			if (calls === 1) {
				const err = new Error('EPERM (test): AV hold') as Error & {
					code?: string;
				};
				err.code = 'EPERM';
				throw err;
			}
			return realAtomicRename(from, to);
		}) as typeof realAtomicRename;
		registerOtlpExporter(
			dir,
			testExportConfig(NEVER_COLLECTOR, { batchSize: 8 }),
		);

		const { emit } = await import('../../../src/telemetry.js');
		emit('delegation_begin' as never, { ...JUNK } as never);

		expect(calls).toBeGreaterThanOrEqual(2);
		expect(existsSync(spoolPathOf(dir))).toBe(true);
		const lines = readFileSync(spoolPathOf(dir), 'utf-8')
			.split('\n')
			.filter((l) => l.length > 0);
		expect(lines.length).toBe(1);
		expect(spoolDirEntries(dir)).toEqual(['spool.jsonl']);
		const health = readOtlpExporterHealth(dir);
		expect(health?.dropped['write_retry_exhausted'] ?? 0).toBe(0);
	}, 20_000);

	test('terminal spool rename failure: temp cleaned, ONE drop under write_retry_exhausted, listener_error never double-counts, emit stays fail-open', async () => {
		const dir = canonicalMkdtemp('otlp-wr-2969-');
		initTelemetry(dir);
		registerOtlpExporter(
			dir,
			testExportConfig(NEVER_COLLECTOR, { batchSize: 8 }),
		);
		// Feedback PRR-019: drive the REAL shared retry helper to exhaustion
		// through the atomic-write fs seam (a stub on the site seam skipped
		// the helper's throw-after-budget contract entirely — a mutant that
		// swallows the terminal error passed everything). PRR-023's capped
		// OTLP schedule keeps this arm fast (~85 ms of sync sleeps).
		atomicWriteInternals.renameSync = (() => {
			throw ebusy();
		}) as typeof realAtomicRename;

		const { emit } = await import('../../../src/telemetry.js');
		// The public boundary must never throw for a spool write failure.
		expect(() =>
			emit('delegation_begin' as never, { ...JUNK } as never),
		).not.toThrow();

		const health = readOtlpExporterHealth(dir);
		expect(health?.dropped['write_retry_exhausted']).toBe(1);
		expect(health?.dropped['listener_error'] ?? 0).toBe(0);
		expect(health?.lastErrorCategory).toBe('write_retry_exhausted');
		// Feedback PRR-020: the stated no-clobber invariant is ASSERTED —
		// no canonical spool file was (non-atomically) placed, and no tmp
		// residue survives the terminal failure.
		expect(existsSync(spoolPathOf(dir))).toBe(false);
		expect(spoolDirEntries(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
	}, 20_000);

	test('state-write failure counts under its OWN category and never touches the record-drop counters', async () => {
		const dir = canonicalMkdtemp('otlp-wr-2969-');
		initTelemetry(dir);
		otlpInternals.renameWithRetry = (() => {
			throw ebusy();
		}) as typeof realOtlpRename;
		registerOtlpExporter(
			dir,
			testExportConfig(NEVER_COLLECTOR, { batchSize: 8 }),
		);
		// persistState fires at the end of a flush cycle — run one against the
		// dead collector so the state write (not the spool) is what fails.
		const { flushOtlpExporterForTesting } = await import(
			'../../../src/observability/otlp-exporter.js'
		);
		await flushOtlpExporterForTesting(dir);

		const health = readOtlpExporterHealth(dir);
		expect(health?.dropped['state_write_failed']).toBeGreaterThanOrEqual(1);
		expect(health?.dropped['write_retry_exhausted'] ?? 0).toBe(0);
		expect(health?.dropped['listener_error'] ?? 0).toBe(0);
	}, 20_000);
});
