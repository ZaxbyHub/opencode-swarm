/**
 * PR 3920 closeout (F-001 follow-up): loadPlan decides the spec drift marker under
 * the spec.md owner lock. A lock younger than the TTL is in flight and suppresses
 * the marker (a live writer, or an owner that has created the file but not yet
 * published its payload). Suppression is bounded: an aged lock does not suppress.
 * A writer that completed inside the window leaves a consistent pair under the
 * lock, so no marker is written. With no lock, the marker is written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

	test('an aged owner lock does not suppress the marker (bounded suppression)', async () => {
		fs.writeFileSync(
			lockPath(),
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
		fs.utimesSync(lockPath(), ANCIENT_SECONDS, ANCIENT_SECONDS);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(true);
	});

	test('a writer that completed inside the window leaves a consistent pair: no marker', async () => {
		// The snapshot read saw the stale spec, but the writer has since rebound
		// plan.json under the lock. The locked re-read sees the current hash.
		_internals.readPlanSpecHashUnderLock = async () =>
			readEffectiveSpecSync(dir)?.hash;

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
	});

	test('an aged lock that cannot be acquired decides from a fresh read, not the snapshot', async () => {
		// The aged lock file cannot be acquired and is not in flight, so the decision
		// falls back to a fresh read. The writer has rebound plan.json: no marker.
		fs.writeFileSync(lockPath(), '{"v":1}');
		fs.utimesSync(lockPath(), ANCIENT_SECONDS, ANCIENT_SECONDS);
		_internals.readPlanSpecHashUnderLock = async () =>
			readEffectiveSpecSync(dir)?.hash;

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);
	});
});
