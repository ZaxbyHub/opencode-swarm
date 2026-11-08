/**
 * #3372 supplementary lifecycle checks — public-runner and seam observation
 * of the measurement harness's session-identity lifecycle (non-frozen
 * companion to the frozen instruction-pairing-identity suite).
 *
 * Contract under test (05-fix-plan D1 v3):
 * - A session that already carries an activeAgent entry is NEVER re-stamped
 *   by the pairing harness — during the run AND after it (L1/L2a/L2b/L4).
 * - A session with no entry gets an owner-resolved identity for the
 *   measurement window only; the finally restores prior state (L3: absent
 *   before → absent after).
 * - The cache-invalidation flow uses its own session id ('pairing-invalidation')
 *   and therefore needs its own lifecycle leg (L4).
 *
 * Base status (recorded pre-implementation at e8223e308): L1/L2b/L4/L5a/L5b
 * RED and L2a RED via seam-absence (loadPairingInternals throws before the
 * writer is reachable — recorded honestly per plan-critic round 3; the
 * behavioral during-run base evidence is Probe A in 02-reproduction plus the
 * L5b polling leg, which at base observes the production stamp overwriting
 * the prior identity); L3 GREEN.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
	type InstructionPairingTask,
	runInstructionSelectionPairing,
} from '../../../src/memory/instruction-pairing.js';
import { recordPrimaryOwner, swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

interface PairingInternals {
	makeMessages: (sessionId: string) => {
		messages: Array<{ info?: { sessionID?: string } }>;
	};
}

const L1_TASK_ID = 'lifecycle-l1';
const L1_SID = `pairing-${L1_TASK_ID}`;
const L2_TASK_ID = 'lifecycle-l2';
const L2_SID = `pairing-${L2_TASK_ID}`;
const L3_TASK_ID = 'lifecycle-l3';
const L3_SID = `pairing-${L3_TASK_ID}`;
const INVALIDATION_SID = 'pairing-invalidation';
const SEAM_SID = 'pairing-lifecycle-seam';
const L5B_TARGET_TASK_ID = 'l5b-target';
const L5B_TARGET_SID = `pairing-${L5B_TARGET_TASK_ID}`;
const L5B_CONTROL_TASK_ID = 'l5b-control';
const L5B_CONTROL_SID = `pairing-${L5B_CONTROL_TASK_ID}`;

async function loadPairingInternals(): Promise<PairingInternals> {
	const mod = (await import('../../../src/memory/instruction-pairing.js')) as {
		_internals?: PairingInternals;
	};
	const internals = mod._internals;
	if (!internals || typeof internals.makeMessages !== 'function') {
		throw new Error(
			'#3372 seam missing: _internals.makeMessages is required for the ' +
				'during-run (L2a) observation; expected shape: ' +
				'`export const _internals = { makeMessages };`',
		);
	}
	return internals;
}

function minimalTask(id: string): InstructionPairingTask {
	return {
		id,
		lastUserMessage: 'Continue the current work.',
		expectedLabels: [],
		records: [],
	};
}

async function runPairing(taskId: string): Promise<void> {
	const dir = canonicalMkdtemp(`pairing-lifecycle-${taskId}-`);
	try {
		await runInstructionSelectionPairing({
			directory: dir,
			tasks: [minimalTask(taskId)],
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

afterEach(() => {
	// Invariant-8 hygiene: never leave synthetic pairing sessions mapped.
	// Includes the L5b ids: under the FIXED behavior the target entry
	// intentionally survives the public runner, so the test itself must
	// clean it (and the control, for failure-path hygiene).
	for (const sid of [
		L1_SID,
		L2_SID,
		L3_SID,
		INVALIDATION_SID,
		SEAM_SID,
		L5B_TARGET_SID,
		L5B_CONTROL_SID,
	]) {
		swarmState.activeAgent.delete(sid);
		swarmState.primaryOwnerBySession.delete(sid);
	}
});

describe('instruction-pairing identity lifecycle (#3372 supplementary)', () => {
	it('L1: public run preserves a pre-existing entry for a build-owned session', async () => {
		recordPrimaryOwner(L1_SID, 'build');
		swarmState.activeAgent.set(L1_SID, 'build');

		await runPairing(L1_TASK_ID);

		expect(swarmState.activeAgent.get(L1_SID)).toBe('build');
	}, 30_000);

	it('L2a: during-run composer performs NO write when the session already has an identity', async () => {
		const internals = await loadPairingInternals();
		recordPrimaryOwner(SEAM_SID, 'build');
		// Prior value DIFFERS from the owner: the delegation shape. The literal
		// #3372 contract requires NO re-stamp during measurement.
		swarmState.activeAgent.set(SEAM_SID, 'my_swarm_coder');

		const output = internals.makeMessages(SEAM_SID);

		expect(output.messages.length).toBeGreaterThan(0);
		expect(output.messages[0].info?.sessionID).toBe(SEAM_SID);
		expect(swarmState.activeAgent.get(SEAM_SID)).toBe('my_swarm_coder');
	});

	it('L5a: source anchor — the seam binds the PRODUCTION composer and the guard lives in the production body', async () => {
		// Structural guard on the seam's SHAPE (plan-critic round 3, corrected
		// in implementation review): these anchors pin the exact direct-binding
		// export literal and the guard's presence in the production module.
		// They do NOT alone bind the production CALL SITE — the review's M1b
		// probe (guarded wrapper exported, unconditional composer renamed)
		// still passes them; L5b is the sole BEHAVIORAL closer of the
		// wrapper-divergence path.
		const source = readFileSync(
			path.join(
				import.meta.dir,
				'..',
				'..',
				'..',
				'src',
				'memory',
				'instruction-pairing.ts',
			),
			'utf-8',
		);
		// Direct binding: the seam exports the production function itself.
		expect(source).toContain('export const _internals = { makeMessages };');
		// The production composer carries the no-write guard…
		expect(source).toContain('existing === undefined');
		// …with owner-resolved creation (ORCHESTRATOR_NAME fallback included).
		expect(source).toContain('getPrimaryOwner(sessionId) ?? ORCHESTRATOR_NAME');
		// Both cleanup paths release through the refcounted registry (last
		// holder restores the ORIGINAL prior) instead of unconditional delete.
		expect(source).toContain('function holdPairingSessionIdentity');
		expect(source).toContain('function releasePairingSessionIdentity');
		expect(source).toContain('if (hold.count > 0) return;');
		expect(source).toContain(
			'swarmState.activeAgent.set(sessionId, hold.priorAgent);',
		);
	});

	it('L5b: public run never overwrites a prior identity during measurement (with poller control)', async () => {
		// Behavioral close of the same path: this observes the REAL public
		// runner (not the seam). The prior-value≠owner session's entry must
		// read 'my_swarm_coder' for every sample taken during the run, and the
		// CONTROL task's synthetic entry must be observed at least once —
		// proving the poller can see a during-run entry in this very run (a
		// broken/missing-window poller fails the control instead of
		// false-greening the target).
		const targetTaskId = L5B_TARGET_TASK_ID;
		const targetSid = L5B_TARGET_SID;
		const controlTaskId = L5B_CONTROL_TASK_ID;
		const controlSid = L5B_CONTROL_SID;
		recordPrimaryOwner(targetSid, 'build');
		swarmState.activeAgent.set(targetSid, 'my_swarm_coder');

		const observed = new Map<string, Set<string>>();
		const recordSample = (sid: string): void => {
			const v = swarmState.activeAgent.get(sid);
			if (v === undefined) return;
			const set = observed.get(sid) ?? new Set<string>();
			set.add(v);
			observed.set(sid, set);
		};
		const timer = setInterval(() => {
			recordSample(targetSid);
			recordSample(controlSid);
		}, 1);

		const dir = canonicalMkdtemp('pairing-l5b-3372-');
		try {
			await runInstructionSelectionPairing({
				directory: dir,
				tasks: [minimalTask(targetTaskId), minimalTask(controlTaskId)],
			});
		} finally {
			clearInterval(timer);
			rmSync(dir, { recursive: true, force: true });
		}

		// Poller-works control: the harness-created entry for the ownerless
		// control task exists during its measurement window and was sampled.
		expect(observed.get(controlSid)).toContain('architect');
		// Target: the pre-existing identity is never overwritten during the
		// public run — every sample reads the prior value.
		const targetSamples = observed.get(targetSid) ?? new Set<string>();
		expect([...targetSamples]).toEqual(['my_swarm_coder']);
	}, 30_000);

	it('L2b: public run preserves a prior identity that differs from the owner', async () => {
		recordPrimaryOwner(L2_SID, 'build');
		swarmState.activeAgent.set(L2_SID, 'my_swarm_coder');

		await runPairing(L2_TASK_ID);

		expect(swarmState.activeAgent.get(L2_SID)).toBe('my_swarm_coder');
	}, 30_000);

	it('L3: synthetic session with no prior entry leaves no residue (preserving)', async () => {
		expect(swarmState.activeAgent.has(L3_SID)).toBe(false);

		await runPairing(L3_TASK_ID);

		expect(swarmState.activeAgent.has(L3_SID)).toBe(false);
	}, 30_000);

	it('L6: asymmetric concurrent runs (fast minimal vs slow record-heavy, same ids) leave zero activeAgent residue', async () => {
		// #3372 review rounds 1-2 blocking finding, deterministic shape: the
		// FAST run finishes first while the SLOW run still holds the same
		// synthetic ids — per-run prior capture restores the fast run's
		// temporary value and leaves a permanent ghost (the
		// pairing-invalidation id has no agentSessions row, so the stale
		// sweep never evicts it). The refcounted registry must leave NOTHING
		// behind: the last holder restores the ORIGINAL prior state.
		const taskId = 'l6-collide';
		const sid = `pairing-${taskId}`;
		const heavyRecords = Array.from({ length: 60 }, (_, i) => ({
			label: `l6-heavy-${i}`,
			lesson: `L6 heavy record number ${i} to make the second run measurably slower than the minimal first run.`,
		}));
		const heavyTask: InstructionPairingTask = {
			id: taskId,
			lastUserMessage: 'Continue the current work.',
			expectedLabels: [`l6-heavy-0`],
			records: heavyRecords,
		};
		const fastDir = canonicalMkdtemp('pairing-l6-3372-fast-');
		const slowDir = canonicalMkdtemp('pairing-l6-3372-slow-');
		const fast = runInstructionSelectionPairing({
			directory: fastDir,
			tasks: [minimalTask(taskId)],
		});
		await new Promise((r) => setTimeout(r, 1));
		const slow = runInstructionSelectionPairing({
			directory: slowDir,
			tasks: [heavyTask],
		});
		try {
			await Promise.all([fast, slow]);
		} finally {
			rmSync(fastDir, { recursive: true, force: true });
			rmSync(slowDir, { recursive: true, force: true });
		}
		expect(swarmState.activeAgent.get(sid)).toBeUndefined();
		expect(swarmState.activeAgent.get(INVALIDATION_SID)).toBeUndefined();
	}, 30_000);

	it('L4: the cache-invalidation session keeps its pre-existing identity across the public run', async () => {
		// verifyCacheInvalidation uses the DISTINCT constant session id
		// 'pairing-invalidation' (src/memory/instruction-pairing.ts:449-451),
		// so this leg observes THAT cleanup path, not the task-pairing one.
		recordPrimaryOwner(INVALIDATION_SID, 'build');
		swarmState.activeAgent.set(INVALIDATION_SID, 'build');

		await runPairing('lifecycle-l4');

		expect(swarmState.activeAgent.get(INVALIDATION_SID)).toBe('build');
	}, 30_000);
});
