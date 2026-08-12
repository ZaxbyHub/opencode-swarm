/**
 * Wired-path regression for the evidence-manager writers fixed in the issue
 * #1619 review round 3 (FIX-3). `saveEvidence` and the flat-retrospective
 * write-back inside `loadEvidence` both read+write
 * `evidence/<taskId>/evidence.json` through the same cached-read /
 * atomic-rename path as the other `.swarm/` artifact writers covered by
 * tests/unit/utils/swarm-write-cache-invalidation-wiring.test.ts, but were
 * missed by that sweep: the cache validates freshness by stat stamp alone
 * (mtimeMs + ctimeMs + size, src/utils/swarm-artifact-cache.ts:269-288), so a
 * same-size rewrite landing inside one filesystem timestamp tick produces an
 * identical stamp and the next read-your-own-write silently returns the
 * pre-write value (issue #1729) unless the writer explicitly invalidates the
 * cache entry after a successful rename.
 *
 * Assertion shape mirrors
 * tests/unit/utils/swarm-write-cache-invalidation-wiring.test.ts: freeze the
 * stat clock after priming the cache, drive the real production entry point,
 * then supply a `directRead` the file never contains — the read can only
 * return it if the cache entry was actually dropped.
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
 * The production code under test is unaffected in practice — `bunWrite`
 * (src/utils/bun-compat.ts) takes the `Bun.write` fast path under `bun test`
 * (verified: this file's tests pass with zero branch-only failures in the
 * required multi-directory runs). Its Node-only fallback path DOES call
 * `fs/promises` `mkdir`/`writeFile` (src/utils/bun-compat.ts:155,161), so
 * this immunity is specific to running under the Bun runtime, not an
 * intrinsic property of `bunWrite` itself.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Evidence } from '../../../src/config/evidence-schema';
import { loadEvidence, saveEvidence } from '../../../src/evidence/manager';
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
	tmpDir = canonicalMkdtemp('evidence-manager-write-cache-');
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
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

function evidencePathFor(taskId: string): string {
	return path.join(tmpDir, '.swarm', 'evidence', taskId, 'evidence.json');
}

/**
 * Fixed fixture timestamp. Nothing in this file asserts on time — these values
 * only fill required schema fields — so a literal is used instead of a real
 * clock read. That keeps the fixtures deterministic under coverage
 * instrumentation (issue #1782) without pulling in `freezeClock`, which exists
 * for time-SENSITIVE assertions this file does not make.
 */
const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function noteEvidence(taskId: string, summary: string): Evidence {
	return {
		type: 'note',
		task_id: taskId,
		timestamp: FIXTURE_TIMESTAMP,
		agent: 'test-agent',
		verdict: 'info',
		summary,
	};
}

/** Seed evidence.json, prime the artifact cache, then freeze every stat. */
async function seedAndFreeze(target: string, seed: string): Promise<void> {
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, seed, 'utf-8');
	const primed = await readCachedTextFile(target, () =>
		fs.readFile(target, 'utf-8'),
	);
	expect(primed).toBe(seed);
	const frozenStat = await fs.stat(target);
	artifactCacheInternals.stat = (async () =>
		frozenStat) as typeof artifactCacheInternals.stat;
}

/**
 * Under the frozen stamp the cache can only miss if the entry was dropped, so
 * a `directRead` the file never contains proves invalidation ran.
 */
async function expectInvalidated(target: string): Promise<void> {
	const second = await readCachedTextFile(target, async () => 'FRESH');
	expect(second).toBe('FRESH');
}

describe('evidence manager invalidates the swarm-artifact-cache (#1729 / #1619 FIX-3)', () => {
	test('saveEvidence invalidates evidence.json after the read-modify-write atomic rename', async () => {
		const taskId = 'wiring-task-save';
		const target = evidencePathFor(taskId);
		const existingBundle = {
			schema_version: '1.0.0',
			task_id: taskId,
			entries: [],
			created_at: FIXTURE_TIMESTAMP,
			updated_at: FIXTURE_TIMESTAMP,
		};
		await seedAndFreeze(target, JSON.stringify(existingBundle));

		const bundle = await saveEvidence(
			tmpDir,
			taskId,
			noteEvidence(taskId, 'New note'),
		);
		// Falsifiability: confirm the write actually appended before trusting
		// the invalidation assertion.
		expect(bundle.entries).toHaveLength(1);

		await expectInvalidated(target);
	});

	test('loadEvidence invalidates evidence.json after the flat-retrospective write-back rename', async () => {
		const taskId = 'wiring-task-flat';
		const target = evidencePathFor(taskId);
		const flatRetrospective = {
			type: 'retrospective',
			task_id: taskId,
			timestamp: FIXTURE_TIMESTAMP,
			agent: 'test-agent',
			verdict: 'info',
			summary: 'legacy flat retro',
			phase_number: 1,
			total_tool_calls: 100,
			coder_revisions: 5,
			reviewer_rejections: 2,
			test_failures: 1,
			security_findings: 0,
			integration_issues: 0,
			task_count: 10,
			task_complexity: 'moderate',
			top_rejection_reasons: [],
			lessons_learned: [],
		};
		await seedAndFreeze(target, JSON.stringify(flatRetrospective));

		const result = await loadEvidence(tmpDir, taskId);
		// Falsifiability: confirm the migration actually ran (upgraded to a
		// wrapped EvidenceBundle) before trusting the invalidation assertion —
		// `migrate: false` or a lock failure would skip the write-back entirely.
		expect(result.status).toBe('found');
		if (result.status === 'found') {
			expect(result.bundle.schema_version).toBe('1.0.0');
		}
		// The write-back happens synchronously inside the awaited loadEvidence
		// call (it's inside the withEvidenceLock'd async function that
		// loadEvidence itself awaits), so no extra wait is needed here.

		await expectInvalidated(target);
	});
});
