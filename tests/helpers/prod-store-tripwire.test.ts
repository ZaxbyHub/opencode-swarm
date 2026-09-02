/**
 * Production-store tripwire tests (issue #2033).
 *
 * These prove the historical fixture-write class cannot recur: a test that resolves REAL
 * platform store paths (un-redirected env, exactly like PR #1847's intermediate revision)
 * and attempts to write fixtures into them now throws at the filesystem boundary, and the
 * real store is provably unchanged afterwards.
 *
 * Safety: no test here may write to the real store even if a guard were missing. The
 * end-to-end `atomicWriteFile` probe first verifies the `Bun.write` wrap is installed (by
 * function name) so the write cannot bypass to `Bun.write` unguarded; the `renameSync`
 * backstop covers the rest of the atomic-write chain.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	rmdirSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../../src/evidence/task-file.js';
import { resolveLinkBaseDir } from '../../src/hooks/knowledge-link.js';
import { resolveHiveKnowledgePath } from '../../src/knowledge/hive-paths.js';
import {
	clearTripwireViolations,
	createTripwireSafeDir,
	ensureTripwireGuardsArmed,
	getRealStorePaths,
	isRealStoreTarget,
	probeTripwireGuardsArmed,
	verifyRealStoresUnchanged,
	withMaterializedProbe,
} from './prod-store-tripwire.js';

// These probes intentionally trip the guards; clear the shared violations list so later
// test files' afterAll checks stay clean (Bun runs all files in one process).
afterAll(() => {
	clearTripwireViolations();
});

describe('prod-store tripwire (issue #2033)', () => {
	test('preload installed the tripwire and captured real platform paths', () => {
		const { dataDir, linkBaseDir } = getRealStorePaths();
		// The captured data dir is the REAL platform root (not a temp dir), and the link
		// base dir nests under it — proving the capture happened with pristine env.
		expect(isRealStoreTarget(dataDir)).toBe(true);
		expect(linkBaseDir.startsWith(dataDir)).toBe(true);
		expect(resolveHiveKnowledgePath().startsWith(dataDir)).toBe(true);
		expect(dataDir.includes('swarm-test-')).toBe(false);
	});

	test('resolution under un-redirected env returns the real path AND writes throw', async () => {
		// This file never redirects env — exactly the historical #1847 intermediate-revision
		// state. The resolver returns the real store; the guard must refuse the write.
		const realHivePath = resolveHiveKnowledgePath();
		expect(isRealStoreTarget(realHivePath)).toBe(true);

		const fs = await import('node:fs/promises');
		let threw: unknown;
		try {
			await fs.appendFile(
				realHivePath,
				'{"id":"regression-probe","lesson":"Test lesson for tripwire regression"}\n',
			);
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(Error);
		expect((threw as Error).message).toContain('PROD-STORE TRIPWIRE');

		// Sync surface too.
		const fsSync = await import('node:fs');
		let threwSync: unknown;
		try {
			fsSync.appendFileSync(
				realHivePath,
				'{"id":"regression-probe-sync","lesson":"Test lesson sync"}\n',
			);
		} catch (err) {
			threwSync = err;
		}
		expect(threwSync).toBeInstanceOf(Error);
		expect((threwSync as Error).message).toContain('PROD-STORE TRIPWIRE');
	});

	test('link-store writes against the real link base dir throw', () => {
		const realLinkDir = path.join(resolveLinkBaseDir(), 'regression-probe');
		expect(isRealStoreTarget(realLinkDir)).toBe(true);
		// mkdir is intentionally unguarded (see helper docs); the file write inside the
		// real link root must be refused.
		// Regression (issue #2233): the recursive mkdir below also materializes the
		// REAL <dataDir>/links root when it does not exist yet (fresh CI runner);
		// a cleanup that removed only the leaf left links/ behind as top-level
		// store drift that failed this file's own afterAll bookend
		// (verifyRealStoresUnchanged) on the first run against a clean HOME.
		// The pre/post-existence restore now lives in withMaterializedProbe
		// (issue #2243) so every future probe gets it for free.
		let mkdirThrew: unknown;
		withMaterializedProbe(path.join('links', 'regression-probe'), () => {
			try {
				mkdirSync(realLinkDir, { recursive: true });
			} catch (err) {
				mkdirThrew = err;
			}
			let threwWrite: unknown;
			try {
				writeFileSync(`${realLinkDir}/memory.json`, '{"probe":true}');
			} catch (err) {
				threwWrite = err;
			}
			expect(threwWrite).toBeInstanceOf(Error);
			expect((threwWrite as Error).message).toContain('PROD-STORE TRIPWIRE');
		});
		expect(mkdirThrew).toBeUndefined();
	});

	// Falsification probe for withMaterializedProbe (issue #2243): a probe that
	// materializes a tracked root WITHOUT the restore primitive must be caught
	// by the afterAll bookend. verifyRealStoresUnchanged() is invoked directly
	// (its drift channel is a throw, not a recorded violation) and MUST throw;
	// the manual cleanup afterwards keeps this suite's own bookend green. Uses
	// quarantine-backups — the OTHER tracked root — so the coverage
	// complements the links/ regression test above.
	test('bookend catches a probe that forgets the pre/post-existence restore', () => {
		const { dataDir } = getRealStorePaths();
		const rootExisted = existsSync(path.join(dataDir, 'quarantine-backups'));
		const probeDir = path.join(dataDir, 'quarantine-backups', 'falsify-probe');
		let threw: unknown;
		try {
			mkdirSync(probeDir, { recursive: true });
			try {
				verifyRealStoresUnchanged();
			} catch (err) {
				threw = err;
			}
			expect(threw).toBeInstanceOf(Error);
			expect((threw as Error).message).toContain('real store drift detected');
		} finally {
			// Manual cleanup — the shape a probe WITHOUT the helper must
			// remember (leaf first, then the root only if it did not pre-exist).
			try {
				rmdirSync(probeDir);
			} catch {
				/* already gone */
			}
			if (!rootExisted) {
				try {
					rmdirSync(path.join(dataDir, 'quarantine-backups'));
				} catch {
					/* non-empty or already gone */
				}
			}
		}
	});

	test('atomicWriteFile to the real hive store throws end-to-end (Bun path)', async () => {
		// Guard presence first: never attempt the write if the Bun.write wrap is missing.
		const bunWrite = (globalThis.Bun as { write?: { name?: string } }).write;
		expect(bunWrite).toBeDefined();
		expect(bunWrite?.name).toBe('guardedWrite');

		const realHivePath = resolveHiveKnowledgePath();
		let threw: unknown;
		try {
			await atomicWriteFile(
				realHivePath,
				'{"id":"regression-probe-atomic","lesson":"Test lesson atomic"}\n',
			);
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(Error);
		expect((threw as Error).message).toContain('PROD-STORE TRIPWIRE');
	});

	test('reads of the real store files throw (the #2025 item-7 class)', async () => {
		const realHivePath = resolveHiveKnowledgePath();
		const fs = await import('node:fs/promises');
		let threw: unknown;
		try {
			await fs.readFile(realHivePath, 'utf-8');
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(Error);
		expect((threw as Error).message).toContain('PROD-STORE TRIPWIRE');
	});

	test('temp-path traffic passes through the guards untouched', async () => {
		const { dir, cleanup } = createTripwireSafeDir('tripwire-passthrough-');
		try {
			expect(isRealStoreTarget(dir)).toBe(false);
			const fs = await import('node:fs/promises');
			await fs.appendFile(`${dir}/ok.jsonl`, 'line\n');
			await atomicWriteFile(`${dir}/ok.jsonl`, 'replaced\n');
			const content = await fs.readFile(`${dir}/ok.jsonl`, 'utf-8');
			expect(content).toBe('replaced\n');
		} finally {
			cleanup();
		}
	});

	test('real stores unchanged after all probes (byte-identical to process start)', () => {
		// The intentional guard throws above do NOT count as violations for this file
		// (cleared in afterAll); what matters here is that the real store bytes survived.
		verifyRealStoresUnchanged();
	});

	test('guards survive a sanctioned mock.restore() (pinned Bun semantics) and re-arm if ever stripped — final-critic finding 2', async () => {
		// Armed right now (preload installed; this file's earlier probes threw).
		expect(await probeTripwireGuardsArmed()).toBe(true);
		// The repo's sanctioned mock-hygiene convention (AGENTS.md invariant 7): suites
		// call afterEach(mock.restore()). PIN the load-bearing Bun semantics — in
		// Bun 1.3.14 mock.restore() resets mock.fn/spyOn state but does NOT unregister
		// mock.module replacements, so the tripwire survives. If a future Bun changes
		// that, this assertion fails and the preload's global afterEach
		// (ensureTripwireGuardsArmed) becomes the active defense.
		const { mock } = await import('bun:test');
		mock.restore();
		expect(await probeTripwireGuardsArmed()).toBe(true);
		// The re-arm path is idempotent when already armed…
		await ensureTripwireGuardsArmed();
		expect(await probeTripwireGuardsArmed()).toBe(true);
		// …and a real-path write remains blocked through it all.
		let threw: unknown;
		try {
			appendFileSync(
				resolveHiveKnowledgePath(),
				'{"id":"rearm-probe","lesson":"Test lesson after re-arm"}\n',
			);
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(Error);
		expect((threw as Error).message).toContain('PROD-STORE TRIPWIRE');
		clearTripwireViolations();
	});
});
