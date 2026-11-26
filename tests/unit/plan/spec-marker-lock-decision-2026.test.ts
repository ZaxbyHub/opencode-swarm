/**
 * PR 3920 closeout (SolCritic contract): only a lock owner publishes a drift
 * marker. A lock younger than the TTL is in flight and suppresses the marker
 * (the holder reconciles or restores prior bytes). When the lock is aged or
 * cannot be acquired, loadPlan skips — and the mutation gate independently
 * blocks drift through detectUnmarkedSpecDriftSync (markerless pair check), so
 * neither fail-open (F-005) nor an unlocked marker write (F-007) remains.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { enforceSpecDriftGate } from '../../../src/hooks/guardrails';
import {
	acquireOwnerLockOnce,
	getOwnerLockPath,
} from '../../../src/parallel/file-locks';
import { _internals, loadPlan } from '../../../src/plan/manager';
import { readEffectiveSpecSync } from '../../../src/sdd/effective-spec';
import { resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

const ANCIENT_SECONDS = 1600000000; // 2020, well past the lock TTL

function buildPlan(specHash: string) {
	return {
		schema_version: '1.0.0',
		title: 'Lock Decision Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
		migration_status: 'native',
		specHash,
	};
}

describe('loadPlan marker decision under the spec.md owner lock (PR 3920 closeout)', () => {
	let dir: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const originalReread = _internals.readPlanSpecHashUnderLock;
	const markerPath = () => path.join(dir, '.swarm', 'spec-staleness.json');
	const lockPath = () => getOwnerLockPath(dir, 'spec.md');
	const writeAgedLock = (contents: string): void => {
		fs.writeFileSync(lockPath(), contents);
		fs.utimesSync(lockPath(), ANCIENT_SECONDS, ANCIENT_SECONDS);
	};

	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-lock-')));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify(buildPlan('oldhash123'), null, 2),
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'spec.md'),
			'# Spec\n\nCurrent.\n',
		);
		fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
	});

	afterEach(() => {
		_internals.readPlanSpecHashUnderLock = originalReread;
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	test('no lock: a stale plan writes the drift marker', async () => {
		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(true);
	});

	test('a live writer holding spec.md suppresses the marker, and it is written after release', async () => {
		const held = acquireOwnerLockOnce(lockPath(), 'spec-write', 'live-writer');
		expect(held.acquired).toBe(true);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);

		held.release();
		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(true);
	});

	test('an owner that created the lock file but has not published its payload is in flight', async () => {
		fs.writeFileSync(lockPath(), '');

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
	});

	test('an aged owner lock writes no marker and the gate blocks the drift', async () => {
		// The dead-owner lock is unacquirable, so loadPlan skips. The markerless
		// pair check carries the drift: the gate blocks while no marker exists.
		writeAgedLock(
			JSON.stringify({
				v: 1,
				nonce: 'aged-nonce',
				ownerPid: 2147483646,
				startBoundMs: 0,
				agent: 'spec-write',
				taskId: 'crashed-writer',
				acquiredAtMs: 1700000000000,
			}),
		);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(() => enforceSpecDriftGate(dir, 'save_plan')).toThrow(
			/SPEC_DRIFT_BLOCK/,
		);
	});

	test('a writer that completed inside the window leaves a consistent pair: no marker, gate admits', async () => {
		// The writer rebound plan.json before releasing: the on-disk pair is now
		// consistent, so neither loadPlan nor the gate owes a block.
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify(
				buildPlan(readEffectiveSpecSync(dir)?.hash ?? ''),
				null,
				2,
			),
		);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(() => enforceSpecDriftGate(dir, 'save_plan')).not.toThrow();
	});

	test('an aged unacquirable lock with real drift writes no marker and the gate blocks', async () => {
		writeAgedLock('{"v":1}');

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(() => enforceSpecDriftGate(dir, 'save_plan')).toThrow(
			/SPEC_DRIFT_BLOCK/,
		);
	});

	test('an aged unacquirable lock with a consistent pair writes no marker and the gate admits', async () => {
		// The writer rebound plan.json before dying; the on-disk pair is consistent,
		// so the markerless gate check admits despite the unacquirable lock.
		writeAgedLock('{"v":1}');
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify(
				buildPlan(readEffectiveSpecSync(dir)?.hash ?? ''),
				null,
				2,
			),
		);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(() => enforceSpecDriftGate(dir, 'save_plan')).not.toThrow();
	});

	test('an aged lock held by a live process writes no marker and the gate blocks', async () => {
		// A live-aged holder is never swept and never acquirable: loadPlan skips,
		// and the gate's markerless check carries the drift (F-005 closure).
		writeAgedLock(
			JSON.stringify({
				v: 1,
				nonce: 'live-aged-nonce',
				ownerPid: process.pid,
				startBoundMs: 0,
				agent: 'spec-write',
				taskId: 'long-running-writer',
				acquiredAtMs: 1700000000000,
			}),
		);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
		expect(() => enforceSpecDriftGate(dir, 'save_plan')).toThrow(
			/SPEC_DRIFT_BLOCK/,
		);
	});
});
