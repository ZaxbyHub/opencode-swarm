/**
 * #2472 W4 (AC-5, frozen check C5) — maintenance scans are deferred off the
 * prompt-construction path.
 *
 * The `experimental.chat.system.transform` handler must not run the
 * doc-index directory walk, the dark-matter git spawn, or any of their
 * `.swarm` writes inside the awaited transform call. They are deferred to an
 * unref'd-macrotask background task (registered as the handler's final
 * synchronous act, at the end of its `finally`) with a per-directory
 * in-flight guard; both artifacts feed later turns only.
 *
 * Three contracts, mirroring repro/check-c5.ts:
 *  (a) immediately after the awaited transform: detectDarkMatter NOT called,
 *      dark-matter.md and .swarm/doc-manifest.json do NOT exist;
 *  (b) eventual behavior: polling with real timers shows the deferred scan
 *      DID run and both artifacts materialize;
 *  (c) in-flight guard: a second transform call while the first deferred
 *      scan is pending does not schedule a second one.
 *
 * Instrumentation follows the writing-tests skill: the co-change-analyzer
 * `_internals` DI seam (which system-enhancer reads at call time) is
 * replaced with a counting stub and restored in `finally` — no mock.module.
 * No production flush hook exists; tests poll the filesystem with real
 * timers. Each test drains its deferred scan before removing its temp dir so
 * a pending task can never write into a deleted directory.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { _internals as coChangeInternals } from '../../../src/tools/co-change-analyzer';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const POLL_DEADLINE_MS = 4000;
const POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Real-timer polling (no production test hook needed for the deferral). */
async function pollUntil(
	predicate: () => boolean,
	deadlineMs = POLL_DEADLINE_MS,
	intervalMs = POLL_INTERVAL_MS,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

function makeTransform(directory: string) {
	const hooks = createSystemEnhancerHook({} as PluginConfig, directory);
	return hooks['experimental.chat.system.transform'] as (
		input: { sessionID?: string; model?: unknown },
		output: { system: string[] },
	) => Promise<void>;
}

describe('system-enhancer deferred maintenance scans (#2472 W4 / AC-5)', () => {
	test('(a) scans do not run during the awaited transform call (check-c5 mirror)', async () => {
		const dir = canonicalMkdtemp('se-deferred-scan-a-');
		const realDetectDarkMatter = coChangeInternals.detectDarkMatter;
		let detectCalls = 0;
		coChangeInternals.detectDarkMatter = (async () => {
			detectCalls++;
			return [];
		}) as typeof realDetectDarkMatter;
		try {
			const transform = makeTransform(dir);
			await transform({ sessionID: 'se-deferred-a' }, { system: [] });

			// The frozen C5 observables, asserted in the immediately-post-await
			// state — exactly what repro/check-c5.ts asserts.
			expect(detectCalls).toBe(0);
			expect(existsSync(join(dir, '.swarm', 'dark-matter.md'))).toBe(false);
			expect(existsSync(join(dir, '.swarm', 'doc-manifest.json'))).toBe(false);

			// Drain the deferred scan (best effort) so it completes inside this
			// test's seam window and cannot write into a deleted directory.
			await pollUntil(
				() =>
					existsSync(join(dir, '.swarm', 'dark-matter.md')) &&
					existsSync(join(dir, '.swarm', 'doc-manifest.json')),
			);
		} finally {
			coChangeInternals.detectDarkMatter = realDetectDarkMatter;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('(b) deferred scans eventually run and materialize both artifacts', async () => {
		const dir = canonicalMkdtemp('se-deferred-scan-b-');
		const realDetectDarkMatter = coChangeInternals.detectDarkMatter;
		let detectCalls = 0;
		coChangeInternals.detectDarkMatter = (async () => {
			detectCalls++;
			return [];
		}) as typeof realDetectDarkMatter;
		try {
			const transform = makeTransform(dir);
			await transform({ sessionID: 'se-deferred-b' }, { system: [] });

			const materialized = await pollUntil(
				() =>
					existsSync(join(dir, '.swarm', 'dark-matter.md')) &&
					existsSync(join(dir, '.swarm', 'doc-manifest.json')),
			);
			expect(materialized).toBe(true);
			expect(detectCalls).toBeGreaterThanOrEqual(1);

			// The cache file is the real formatDarkMatterOutput([]) report —
			// written even on empty results to prevent O(n²) recomputation (#1021).
			const report = readFileSync(
				join(dir, '.swarm', 'dark-matter.md'),
				'utf-8',
			);
			expect(report).toContain('No hidden couplings detected');
		} finally {
			coChangeInternals.detectDarkMatter = realDetectDarkMatter;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('(c) in-flight guard: second transform while first scan pending schedules no duplicate', async () => {
		const dir = canonicalMkdtemp('se-deferred-scan-c-');
		const realDetectDarkMatter = coChangeInternals.detectDarkMatter;
		let detectCalls = 0;
		let releaseDetect: (() => void) | undefined;
		// Park the first deferred scan inside detectDarkMatter so it stays
		// in-flight (and dark-matter.md stays absent) until released.
		coChangeInternals.detectDarkMatter = (async () => {
			detectCalls++;
			await new Promise<void>((resolve) => {
				releaseDetect = resolve;
			});
			return [];
		}) as typeof realDetectDarkMatter;
		try {
			const transform = makeTransform(dir);
			await transform({ sessionID: 'se-deferred-c-1' }, { system: [] });

			// Wait until the first deferred scan has STARTED and is parked.
			const started = await pollUntil(() => detectCalls >= 1, undefined, 10);
			expect(started).toBe(true);

			// Second transform while the first deferred scan is still pending.
			await transform({ sessionID: 'se-deferred-c-2' }, { system: [] });

			// A wrongly-scheduled duplicate would run scanDocIndex (cached by
			// now), find dark-matter.md still absent, and call detect again
			// within a few macrotask turns. Give it ample real time to fire.
			await sleep(200);
			expect(detectCalls).toBe(1);

			// Release the parked scan; it must complete and materialize the
			// cache file exactly once.
			releaseDetect?.();
			const materialized = await pollUntil(() =>
				existsSync(join(dir, '.swarm', 'dark-matter.md')),
			);
			expect(materialized).toBe(true);
			expect(detectCalls).toBe(1);
		} finally {
			releaseDetect?.();
			coChangeInternals.detectDarkMatter = realDetectDarkMatter;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
