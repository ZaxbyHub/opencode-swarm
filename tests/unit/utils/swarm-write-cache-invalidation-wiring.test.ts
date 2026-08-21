/**
 * Wired-path regressions for the five `.swarm/` artifact writers fixed in the
 * issue #1619 review round 2 (F1). Each writer overwrites a path that some
 * reader consumes through `readSwarmFileAsync` → `readCachedTextFile`, and the
 * cache validates freshness by stat stamp alone (mtimeMs + ctimeMs + size). A
 * same-size rewrite landing inside one filesystem timestamp tick therefore
 * produces an identical stamp and the next read-your-own-write silently
 * returns the pre-write value (issue #1729,
 * src/utils/swarm-artifact-cache.ts:269-288).
 *
 * Each test drives the REAL production entry point (not the private writer)
 * and forces the stamp collision through the `_internals.stat` DI seam on
 * swarm-artifact-cache.ts — `utimesSync` cannot portably set ctime, see
 * tests/unit/utils/swarm-artifact-cache.test.ts.
 *
 * Assertion shape (deliberate, mirrors
 * tests/unit/plan/plan-manager-cache-invalidation-wiring.test.ts): the second
 * read supplies its OWN `directRead` instead of reading the file, so the test
 * asserts the one thing the wiring is responsible for — the writer dropped the
 * cache entry, forcing a real read. Asserting on the written file's *content*
 * would couple this to `bunWrite`, which sibling test files replace
 * process-wide by module-mocking `../../../src/utils/bun-compat`; that
 * makes the assertion fail in a multi-file run for reasons unrelated to
 * invalidation. End-to-end proof that invalidation defeats a stamp collision
 * lives in
 * tests/unit/hooks/agent-activity-context-md-stale-read-regression.test.ts.
 *
 * SETUP note: this file's own fixture/seed writes go through synchronous
 * `node:fs` (`mkdirSync`/`writeFileSync`), NOT `node:fs/promises`.
 * `tests/unit/config/default-agent-config.test.ts` calls `mock.module`
 * on `node:fs/promises` at module scope to stub `mkdir`/`writeFile` as
 * no-ops; Bun's module mocks are process-wide and `mock.restore()` does not
 * undo them, so in a multi-file run any file that executes after that one
 * silently gets no-op `writeFile`/`mkdir` from `node:fs/promises`. Using
 * `node:fs` sync APIs for setup/teardown here sidesteps that pollution
 * entirely (see issue #1619 review, "8 branch-only failures" investigation).
 *
 * Four of the five writers under test are unaffected by that pollution in
 * practice — `bunWrite` (src/utils/bun-compat.ts) takes the `Bun.write` fast
 * path under `bun test`. (Its Node-only fallback DOES call `fs/promises`
 * `mkdir`/`writeFile` at src/utils/bun-compat.ts:155,161, so this immunity is
 * specific to running under the Bun runtime, not intrinsic to `bunWrite`.)
 * The phase-monitor
 * writer (src/hooks/phase-monitor.ts) is the one exception: it does
 * `const { mkdir, writeFile } = await import('node:fs/promises')` at call
 * time, so it genuinely picks up the poisoned no-op functions in a polluted
 * process — no amount of test-side setup fixes that, because the PRODUCTION
 * write itself becomes a no-op. The `mock.module` call below repairs
 * `mkdir`/`writeFile` back to real, disk-backed implementations before the
 * phase-monitor test runs, so the production write path is genuinely
 * exercised regardless of prior pollution. This is file-scoped and
 * deliberately has NO `mock.restore()`: per the pollution mechanism above,
 * `mock.restore()` would not undo it anyway, and leaving the repair in
 * place only helps files that run later in the same process.
 *
 * The repair delegates to `require('node:fs').promises.mkdir`/`.writeFile`
 * rather than hand-rolling wrappers around the sync `node:fs` API: verified
 * empirically that `mock.module('node:fs/promises', ...)` does NOT also
 * replace the `.promises` namespace hanging off the separate `node:fs`
 * module specifier, so those are the TRUE original functions — same return
 * values (e.g. `mkdir` resolving to the first created path) and the same
 * argument surface (FileHandle targets, streams, etc.) as the real
 * `node:fs/promises` exports, with no semantics to get subtly wrong the way
 * a hand-rolled `mkdirSync`/`writeFileSync` shim would.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	mkdirSync,
	promises as realNodeFsPromises,
	writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// See file-top comment: repairs `node:fs/promises` mkdir/writeFile in case a
// prior test file (default-agent-config.test.ts) already replaced them
// process-wide with no-ops. Spreads the real (possibly already-poisoned for
// every OTHER export, which is fine — none of the other exports are
// touched) module so every export besides mkdir/writeFile passes through
// unchanged, and delegates mkdir/writeFile to the unpolluted `node:fs`
// `.promises` namespace (a different module specifier than
// `node:fs/promises`, so `mock.module('node:fs/promises', ...)` never
// touches it).
const realFsPromises = await import('node:fs/promises');
mock.module('node:fs/promises', () => ({
	...realFsPromises,
	mkdir: realNodeFsPromises.mkdir,
	writeFile: realNodeFsPromises.writeFile,
}));

import { handleHandoffCommand } from '../../../src/commands/handoff';
import { writeCuratorSummary } from '../../../src/hooks/curator';
import type { CuratorSummary } from '../../../src/hooks/curator-types';
import { createPhaseMonitorHook } from '../../../src/hooks/phase-monitor';
import {
	formatBudgetWarning,
	getDefaultConfig,
} from '../../../src/services/context-budget-service';
import { writeSnapshot } from '../../../src/session/snapshot-writer';
import { swarmState } from '../../../src/state';
import {
	_internals as artifactCacheInternals,
	readCachedTextFile,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
let originalStat: typeof artifactCacheInternals.stat;

beforeEach(async () => {
	resetSwarmArtifactCache();
	// canonicalMkdtemp closes the macOS /var -> /private/var symlink gap and
	// the Windows 8.3 short-name mismatch (FR-011, issue #1737).
	tmpDir = canonicalMkdtemp('swarm-write-cache-');
	mkdirSync(path.join(tmpDir, '.swarm', 'session'), { recursive: true });
	originalStat = artifactCacheInternals.stat;
});

afterEach(async () => {
	artifactCacheInternals.stat = originalStat;
	resetSwarmArtifactCache();
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

/** Seed `relPath` under .swarm/, prime the cache, then freeze every stat. */
async function seedAndFreeze(relPath: string, seed: string): Promise<string> {
	const target = path.join(tmpDir, '.swarm', relPath);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, seed, 'utf-8');
	const primed = await readCachedTextFile(target, () =>
		fs.readFile(target, 'utf-8'),
	);
	expect(primed).toBe(seed);
	const frozenStat = await fs.stat(target);
	artifactCacheInternals.stat = (async () =>
		frozenStat) as typeof artifactCacheInternals.stat;
	return target;
}

/**
 * Under the frozen stamp the cache can only miss if the entry was dropped, so
 * a `directRead` the file never contains proves invalidation ran.
 */
async function expectInvalidated(target: string): Promise<void> {
	const second = await readCachedTextFile(target, async () => 'FRESH');
	expect(second).toBe('FRESH');
}

function minimalCuratorSummary(digest: string): CuratorSummary {
	return {
		schema_version: 1,
		session_id: 'wiring-test',
		// Fixed timestamp, not the real clock: nothing here asserts on time, and a
		// deterministic value keeps this file off the check-test-clock ratchet.
		last_updated: '2026-01-01T00:00:00.000Z',
		last_phase_covered: 1,
		digest,
		phase_digests: [],
		compliance_observations: [],
		knowledge_recommendations: [],
	};
}

describe('cached .swarm/ artifact writers invalidate the swarm-artifact-cache (#1729 / #1619 F1)', () => {
	test('handleHandoffCommand invalidates handoff.md after the atomic rename', async () => {
		const target = await seedAndFreeze('handoff.md', 'OLD HANDOFF');
		await handleHandoffCommand(tmpDir, [], 'wiring-session');
		await expectInvalidated(target);
	});

	/**
	 * `session/budget-state.json` previously had NO wired test here, and this
	 * block explained why: `formatBudgetWarning`'s first statement validated its
	 * trusted absolute project root with `validateDirectory`, which rejects every
	 * absolute path, so no directory value could both reach `writeBudgetState`
	 * and be a real temp directory. That defect is fixed — the function now uses
	 * `validateProjectDirectory` — so the wired test is possible and is written
	 * below rather than left as a static-scan-only gap.
	 */
	test('formatBudgetWarning invalidates session/budget-state.json after the write', async () => {
		const target = await seedAndFreeze(
			'session/budget-state.json',
			JSON.stringify({
				warningFiredAtTurn: null,
				criticalFiredAtTurn: null,
				lastInjectedAtTurn: null,
			}),
		);
		const warning = await formatBudgetWarning(
			{
				timestamp: '2026-01-01T00:00:00.000Z',
				systemPromptTokens: 1000,
				planCursorTokens: 0,
				knowledgeTokens: 0,
				runMemoryTokens: 0,
				handoffTokens: 0,
				contextMdTokens: 0,
				swarmTotalTokens: 1000,
				estimatedTurnCount: 7,
				estimatedSessionTokens: 7000,
				budgetPct: 80,
				status: 'warning',
				recommendation: null,
			},
			tmpDir,
			{ ...getDefaultConfig(), warningMode: 'once' },
		);
		// Falsifiability: the invalidation only runs after a SUCCESSFUL write, so
		// confirm the warning path actually executed before trusting the assertion.
		expect(warning).toContain('[SWARM INJECTION FOOTPRINT:');
		await expectInvalidated(target);
	});

	test('writeCuratorSummary invalidates curator-summary.json after the transactFile write callback', async () => {
		const target = await seedAndFreeze('curator-summary.json', 'OLD SUMMARY');
		await writeCuratorSummary(tmpDir, minimalCuratorSummary('fresh digest'));
		await expectInvalidated(target);
	});

	test('writeSnapshot invalidates session/state.json after the atomic rename', async () => {
		const target = await seedAndFreeze('session/state.json', 'OLD SNAPSHOT');
		await writeSnapshot(tmpDir, swarmState);
		// Falsifiability: writeSnapshot swallows its own errors, so confirm it
		// actually replaced the file before trusting the invalidation assertion.
		expect(await fs.readFile(target, 'utf-8')).not.toBe('OLD SNAPSHOT');
		await expectInvalidated(target);
	});

	test('the phase monitor invalidates curator-briefing.md after writing the init briefing', async () => {
		const target = await seedAndFreeze('curator-briefing.md', 'OLD BRIEFING');
		mkdirSync(path.join(tmpDir, '.opencode'), { recursive: true });
		writeFileSync(
			path.join(tmpDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ curator: { enabled: true, init_enabled: true } }),
			'utf-8',
		);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Wiring Plan',
				swarm: 'wiring',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								description: 'Task 1.1',
								status: 'pending',
								size: 'small',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
			'utf-8',
		);

		let ran = false;
		const hook = createPhaseMonitorHook(tmpDir, undefined, async () => {
			ran = true;
			return { briefing: 'NEW BRIEFING', triggered: true };
		});
		await hook({ sessionID: 'wiring-session' }, {});

		// Falsifiability: the briefing write is behind a config + first-call
		// guard; without this the invalidation assertion could pass vacuously.
		expect(ran).toBe(true);
		expect(await fs.readFile(target, 'utf-8')).toBe('NEW BRIEFING');
		await expectInvalidated(target);
	});
});
