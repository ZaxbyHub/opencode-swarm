import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryConfig } from '../../../src/config/schema';
import {
	_internals,
	createToolSummarizerHook,
} from '../../../src/hooks/tool-summarizer';
import { loadFullOutput, storeSummary } from '../../../src/summaries/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2576 hook-side contract: durable allocation continues after
 * persisted IDs (restart-safety), collisions reallocate within a bounded
 * retry, and exhaustion (or a non-collision storage failure) fails open with
 * the original output preserved.
 *
 * Collision paths drive the `_internals` DI seam (repo convention) instead of
 * mock.module; the seam is restored in afterEach.
 */
describe('tool-summarizer durable allocation + collision retry', () => {
	let tempDir: string;
	const realAllocate = _internals.allocateSummaryId;
	const realStore = _internals.storeSummary;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('tool-summarizer-collision-');
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		_internals.allocateSummaryId = realAllocate;
		_internals.storeSummary = realStore;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function defaultConfig(): SummaryConfig {
		return {
			enabled: true,
			threshold_bytes: 1024,
			max_summary_chars: 1000,
			max_stored_bytes: 10485760,
			retention_days: 7,
		};
	}

	function makeOutput(marker: string): {
		title: string;
		output: string;
		metadata: null;
	} {
		return {
			title: 'Result',
			output: `${marker}-line-of-content `.repeat(200),
			metadata: null,
		};
	}

	test('next allocation continues after a persisted ID (restart-safety contract)', async () => {
		const hook = createToolSummarizerHook(defaultConfig(), tempDir);

		const first = makeOutput('FIRST');
		await hook({ tool: 'bash', sessionID: 's', callID: 'c1' }, first);
		expect(first.output).toContain('[SUMMARY S1]');

		// A later invocation against the same project dir sees exactly the
		// directory state a fresh process would: the next ID must continue
		// after S1 — the pre-fix process-local counter restarted at S1 here.
		const second = makeOutput('SECOND');
		await hook({ tool: 'bash', sessionID: 's', callID: 'c2' }, second);
		expect(second.output).toContain('[SUMMARY S2]');
		expect(second.output).not.toContain('[SUMMARY S1]');
	});

	test('stored summaries retrieve their own marker content', async () => {
		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const first = makeOutput('FIRST');
		const second = makeOutput('SECOND');
		await hook({ tool: 'bash', sessionID: 's', callID: 'c1' }, first);
		await hook({ tool: 'bash', sessionID: 's', callID: 'c2' }, second);

		expect(await loadFullOutput(tempDir, 'S1')).toContain('FIRST');
		expect(await loadFullOutput(tempDir, 'S2')).toContain('SECOND');
	});

	test('a collision reallocates to the next free ID on retry', async () => {
		// Pre-seed S1 so the stubbed first allocation collides.
		await storeSummary(tempDir, 'S1', 'PRECIOUS', 'pre-existing', 10485760);

		let calls = 0;
		let storeAttempts = 0;
		const realStore = _internals.storeSummary;
		_internals.allocateSummaryId = (directory: string) => {
			calls += 1;
			if (calls === 1) return 'S1'; // lost the slot to the pre-seed
			return realAllocate(directory); // rescan sees S1 -> S2
		};
		_internals.storeSummary = async (...args: Parameters<typeof realStore>) => {
			storeAttempts += 1;
			return realStore(...args);
		};

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = makeOutput('WINNER');
		await hook({ tool: 'bash', sessionID: 's', callID: 'c1' }, output);

		expect(output.output).toContain('[SUMMARY S2]');
		expect(calls).toBe(2);
		// Both attempts actually reached the store: the colliding one and the
		// winning one (a hook that skipped storeSummary would not produce a
		// retrievable summary, but count it explicitly anyway).
		expect(storeAttempts).toBe(2);
		expect(await loadFullOutput(tempDir, 'S2')).toContain('WINNER');

		// The pre-existing entry survived the collision untouched.
		expect(await loadFullOutput(tempDir, 'S1')).toBe('PRECIOUS');
	});

	test('exhausted collisions fail open with the original output preserved', async () => {
		await storeSummary(tempDir, 'S1', 'PRECIOUS', 'pre-existing', 10485760);

		// Every attempt "wins" the same occupied slot: the bounded retry must
		// terminate and keep the original output inline.
		_internals.allocateSummaryId = () => 'S1';
		let storeAttempts = 0;
		const realStore = _internals.storeSummary;
		_internals.storeSummary = async (...args: Parameters<typeof realStore>) => {
			storeAttempts += 1;
			return realStore(...args);
		};

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = makeOutput('UNSUMMARIZED');
		const original = output.output;
		await hook({ tool: 'bash', sessionID: 's', callID: 'c1' }, output);

		expect(output.output).toBe(original);
		expect(storeAttempts).toBe(8);
		expect(await loadFullOutput(tempDir, 'S1')).toBe('PRECIOUS');
	});

	test('allocation failures fail open with the original output preserved', async () => {
		// PRR-001: a throwing allocation (e.g. an unreadable summaries
		// directory) must hit the same fail-open path as a storage failure —
		// never escape the hook.
		_internals.allocateSummaryId = () => {
			throw new Error('summaries dir unreadable');
		};
		let storeCalls = 0;
		_internals.storeSummary = async () => {
			storeCalls += 1;
		};

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = makeOutput('UNSUMMARIZED');
		const original = output.output;
		await hook({ tool: 'bash', sessionID: 's', callID: 'c1' }, output);

		expect(output.output).toBe(original);
		expect(storeCalls).toBe(0);
	});

	test('non-collision storage failures fail open without retry', async () => {
		let storeCalls = 0;
		_internals.storeSummary = async () => {
			storeCalls += 1;
			throw new Error('disk on fire');
		};

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = makeOutput('UNSUMMARIZED');
		const original = output.output;
		await hook({ tool: 'bash', sessionID: 's', callID: 'c1' }, output);

		expect(output.output).toBe(original);
		expect(storeCalls).toBe(1);
	});
});
