/**
 * r16 audit (P1): a corrupt context map must never be overwritten by the
 * release reconciliation (or the release promotion it drives).
 *
 * `reconcileContextMapTaskReleases` and `promoteContextMapTaskRelease`
 * previously did `loadContextMap(directory) ?? createEmptyContextMap()`.
 * `loadContextMap` returns `null` BOTH for a missing file AND for an
 * existing-but-corrupt/unreadable one, so in the corrupt case the
 * reconciliation manufactured a fresh empty map and — via
 * `promoteContextMapTaskRelease` → `saveContextMap` — REPLACED the damaged
 * file. Whatever was still recoverable from the corrupt map (decisions, task
 * history, file summaries) was destroyed instead of preserved for an
 * operator-driven recovery.
 *
 * The repair introduces a discriminated read (`readContextMapState`):
 * `missing` may legitimately be rebuilt from authoritative state;
 * `unreadable` (file exists, but corrupt/structurally invalid) is preserved
 * byte-for-byte, logged, and never released from.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	loadContextMap,
	readContextMapState,
} from '../../../src/context-map/persistence';
import {
	promoteContextMapTaskRelease,
	reconcileContextMapTaskReleases,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { freezeClock } from '../../helpers/test-clock';

const TASK_ID = '1.1';

function writePlan(directory: string): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'r16 Corrupt Map Plan',
		swarm: 'r16-corrupt-map',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: TASK_ID,
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(
		join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
}

function gateEntry(agent: string) {
	const now = new Date().toISOString();
	return { sessionId: `ses-${agent}`, timestamp: now, agent };
}

/** Schema-valid evidence for a task that genuinely completed its full QA chain. */
function writeValidCompletedEvidence(directory: string): void {
	const now = new Date().toISOString();
	fs.mkdirSync(join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'evidence', `${TASK_ID}.json`),
		JSON.stringify({
			taskId: TASK_ID,
			required_gates: ['pre_check', 'reviewer', 'test_engineer'],
			gates: {
				pre_check: gateEntry('pre_check'),
				reviewer: gateEntry('reviewer'),
				test_engineer: gateEntry('test_engineer'),
			},
			workflow: {
				schema: 'exact-task-v1',
				generation: 0,
				state: 'complete',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome: 'task_completed',
				lastTransitionId: 'test-seed:complete',
				updatedAt: now,
			},
		}),
	);
}

function contextMapPath(directory: string): string {
	return join(directory, '.swarm', 'context-map.json');
}

function sha256(bytes: Buffer): string {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('context-map — corrupt map preservation during release reconciliation (r16 P1)', () => {
	let directory: string;
	let cleanup: () => void;
	let warnSpy: ReturnType<typeof spyOn>;
	let originalDebug: string | undefined;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({
			// The numeric clock and the ISO stamp are the SAME instant
			// (2025-07-15T12:00:00Z): under a freeze they must not disagree.
			fixedNow: 1_752_580_800_000,
			isoNow: '2025-07-15T12:00:00.000Z',
		});
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('ctxmap-corrupt-'));
		writePlan(directory);
		writeValidCompletedEvidence(directory);
		// Deliberately corrupt the context map AFTER seeding full QA proof:
		// everything the reconciliation needs to justify a release exists,
		// so the only thing standing between the corrupt file and a
		// destructive overwrite is the discriminated read.
		fs.writeFileSync(
			contextMapPath(directory),
			'{"schema_version": 1, "task_history": {"1.1": {"final_status": "pending"', // truncated JSON
			'utf-8',
		);
		originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		restoreClock();
		warnSpy.mockRestore();
		if (originalDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		}
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('readContextMapState classifies the corrupt file as unreadable, not missing', () => {
		const state = readContextMapState(directory);
		expect(state.kind).toBe('unreadable');
		// The legacy contract is unchanged: loadContextMap still returns null.
		expect(loadContextMap(directory)).toBeNull();
	});

	test('reconciliation preserves a corrupt context map byte-for-byte and logs the condition', async () => {
		const before = fs.readFileSync(contextMapPath(directory));
		const hashBefore = sha256(before);

		// Must not throw (the maintenance path stays alive)...
		await expect(
			reconcileContextMapTaskReleases(directory),
		).resolves.toBeUndefined();

		// ...must not release anything derived from the damaged file...
		expect(loadContextMap(directory)).toBeNull();
		// ...and the corrupt original file must remain byte-identical so an
		// operator can still attempt recovery.
		const after = fs.readFileSync(contextMapPath(directory));
		expect(sha256(after)).toBe(hashBefore);
		expect(after.equals(before)).toBe(true);

		// The condition is diagnosably logged.
		const warned = warnSpy.mock.calls
			.map((call) => String(call[0]))
			.some((text) => text.includes('corrupt or unreadable'));
		expect(warned).toBe(true);
	});

	test('promoteContextMapTaskRelease also refuses to overwrite a corrupt map', () => {
		const before = fs.readFileSync(contextMapPath(directory));
		const hashBefore = sha256(before);

		expect(() =>
			promoteContextMapTaskRelease(directory, TASK_ID),
		).not.toThrow();

		const after = fs.readFileSync(contextMapPath(directory));
		expect(sha256(after)).toBe(hashBefore);
	});

	test('a genuinely missing map is still rebuilt per the product rules', async () => {
		// Control: the preservation guard must not over-block. With full QA
		// proof, a completed plan task, and NO context-map file at all, the
		// reconciliation legitimately rebuilds the map with the promoted
		// release.
		fs.rmSync(contextMapPath(directory));
		expect(readContextMapState(directory).kind).toBe('missing');

		await reconcileContextMapTaskReleases(directory);

		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'approved',
		);
	});
});
