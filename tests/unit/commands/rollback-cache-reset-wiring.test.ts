/**
 * Wired-path regression for `/swarm rollback` and the swarm-artifact cache
 * (issue #1619 round 7).
 *
 * `handleRollbackCommand` restores a checkpoint by iterating
 * `readdirSync(checkpointDir)` and `cpSync(src, dest, { recursive: true, force:
 * true })` into `.swarm/`. It replaces an ARBITRARY set of artifacts —
 * plan.json, plan.md, context.md, session/state.json, summaries/, evidence/
 * (recursive), curator-summary.json, spec-staleness.json, whatever else the
 * checkpoint holds — and every one of those is read back through the cached
 * readers, which decide freshness from a stat stamp (mtimeMs + ctimeMs + size)
 * alone. A restored file of the same SIZE landing inside one filesystem
 * timestamp tick therefore produces an identical stamp, and every later hook
 * read in the session keeps serving the PRE-rollback value.
 *
 * The fix is `resetSwarmArtifactCache()` after the copy loop rather than
 * per-file invalidation: the file set is whatever the checkpoint directory
 * happens to contain, `cpSync` recurses into subdirectories, and enumerating
 * that tree would have to stay in sync with every future artifact layout.
 *
 * The static scan CANNOT guard this. `mentionsEvidencePath` never selects
 * src/commands/rollback.ts (it constructs no evidence path), and the copy
 * destination `path.join(swarmDir, file)` folds to a non-specific pattern that
 * matches no cached name — so RULE C does not fire either. This test is the
 * only durable guard, which is why it drives the REAL command end to end and
 * proves the stale read is defeated rather than asserting that a function was
 * called.
 *
 * The stamp collision is forced through the `_internals.statSync` DI seam on
 * swarm-artifact-cache.ts; `utimesSync` cannot portably set ctime (see
 * tests/unit/utils/swarm-artifact-cache.test.ts).
 *
 * SETUP note: fixture writes use synchronous `node:fs`, never
 * `node:fs/promises` — tests/unit/config/default-agent-config.test.ts stubs
 * `node:fs/promises` process-wide at module scope and Bun's module mocks are
 * not undone by `mock.restore()`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleRollbackCommand } from '../../../src/commands/rollback';
import {
	_internals,
	readCachedTextFileSync,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Same LENGTH on purpose. A size difference alone would defeat the cache and
 * the test would pass without any invalidation.
 */
const LIVE_CONTEXT = '# context\n\nphase: LIVE-STATE-AFTER-EDITS\n';
const CHECKPOINT_CONTEXT = '# context\n\nphase: SAVED-STATE-AT-CKPT1\n';

type StatSync = typeof _internals.statSync;

const originalStatSync: StatSync = _internals.statSync;

let projectDir: string;
let swarmDir: string;
let contextPath: string;

/** A stamp that never changes, whatever actually happens on disk. */
function freezeStamps(): void {
	const frozen = { mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000 };
	_internals.statSync = ((target: Parameters<StatSync>[0]) => {
		const real = originalStatSync(target);
		if (String(target) !== contextPath) return real;
		return {
			...real,
			isFile: () => true,
			mtimeMs: frozen.mtimeMs,
			ctimeMs: frozen.ctimeMs,
			size: LIVE_CONTEXT.length,
		};
	}) as StatSync;
}

beforeEach(() => {
	resetSwarmArtifactCache();
	// canonicalMkdtemp rather than the raw OS temp root: `validateSwarmPath`
	// realpath-resolves `.swarm` and compares containment, so an uncanonicalized
	// macOS /var -> /private/var temp root fails that check (FR-011, #1737).
	projectDir = canonicalMkdtemp('swarm-rollback-cache-');
	swarmDir = join(projectDir, '.swarm');
	contextPath = join(swarmDir, 'context.md');

	const checkpointDir = join(swarmDir, 'checkpoints', 'phase-1');
	mkdirSync(checkpointDir, { recursive: true });
	writeFileSync(
		join(swarmDir, 'checkpoints', 'manifest.json'),
		// Fixed timestamp rather than a real-clock read: nothing here is
		// time-sensitive, and reading the wall clock would put this file under the
		// freezeClock gate (scripts/check-test-clock.sh) for no behavioural reason.
		JSON.stringify({
			checkpoints: [
				{ phase: 1, label: 'ckpt-1', timestamp: '2026-01-01T00:00:00.000Z' },
			],
		}),
	);
	writeFileSync(join(checkpointDir, 'context.md'), CHECKPOINT_CONTEXT);
	writeFileSync(contextPath, LIVE_CONTEXT);
});

afterEach(() => {
	_internals.statSync = originalStatSync;
	resetSwarmArtifactCache();
	rmSync(projectDir, { recursive: true, force: true });
});

/** Reads through the cache exactly as the production hooks do. */
function readContextThroughCache(): string | null {
	// Synchronous `node:fs`, never `node:fs/promises` — see the SETUP note above.
	return readCachedTextFileSync(contextPath, () =>
		readFileSync(contextPath, 'utf-8'),
	);
}

describe('/swarm rollback resets the swarm-artifact cache (#1619 round 7)', () => {
	/**
	 * FALSIFIABILITY. Without an invalidation, a same-size overwrite under a
	 * frozen stamp is invisible to the cache. If this test ever goes green
	 * reading the new content, the collision is not being forced and the
	 * regression test below proves nothing.
	 */
	test('a same-size overwrite under a frozen stamp IS served stale', () => {
		freezeStamps();
		expect(readContextThroughCache()).toBe(LIVE_CONTEXT);

		writeFileSync(contextPath, CHECKPOINT_CONTEXT);
		expect(
			readContextThroughCache(),
			'the cache must still be serving the pre-overwrite value here — that is ' +
				'the hazard the rollback reset exists to defeat',
		).toBe(LIVE_CONTEXT);
	});

	test('rollback makes the restored artifact visible to the next cached read', async () => {
		freezeStamps();
		expect(readContextThroughCache()).toBe(LIVE_CONTEXT);

		const result = await handleRollbackCommand(projectDir, ['1']);
		expect(result).toContain('Rolled back to phase 1');

		expect(
			readContextThroughCache(),
			'rollback replaced .swarm/context.md from the checkpoint but the cached ' +
				'reader still served the pre-rollback value. handleRollbackCommand must ' +
				'call resetSwarmArtifactCache() after the cpSync loop — per-file ' +
				'invalidation cannot work here because the restored set is whatever the ' +
				'checkpoint directory contains, recursively.',
		).toBe(CHECKPOINT_CONTEXT);
	});

	/**
	 * The reset sits BEFORE the partial-failure early return, because a rollback
	 * that copied some files and failed on others has still mutated `.swarm/`.
	 * Here the checkpoint holds a readable file plus a directory whose name
	 * collides with an existing FILE in `.swarm/`, which makes `cpSync` throw for
	 * that entry while the first entry lands.
	 */
	test('a PARTIALLY failed rollback still clears the cache', async () => {
		const checkpointDir = join(swarmDir, 'checkpoints', 'phase-1');
		// `.swarm/collide` is a file; the checkpoint has it as a directory, so
		// cpSync(dir -> existing file) fails for that entry only.
		writeFileSync(join(swarmDir, 'collide'), 'a file, not a directory');
		mkdirSync(join(checkpointDir, 'collide'), { recursive: true });
		writeFileSync(join(checkpointDir, 'collide', 'inner.txt'), 'x');

		freezeStamps();
		expect(readContextThroughCache()).toBe(LIVE_CONTEXT);

		const result = await handleRollbackCommand(projectDir, ['1']);
		expect(
			result,
			'this fixture is meant to exercise the partial-failure return; if cpSync ' +
				'stopped failing here the test no longer covers that path',
		).toContain('Rollback partially completed');

		expect(
			readContextThroughCache(),
			'the partial-failure path returns early. context.md was still restored, ' +
				'so the cache must have been cleared before that return.',
		).toBe(CHECKPOINT_CONTEXT);
	});
});
