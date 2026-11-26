/**
 * PR 3920 closeout (F-001 follow-up): loadPlan decides the spec drift marker under
 * the spec.md owner lock. A live writer holding it suppresses the marker, because
 * that writer reconciles or restores prior bytes. A dead-owner lock file does not
 * suppress it (fail-closed on the drift guard). With no lock, the marker is written.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	acquireOwnerLockOnce,
	getOwnerLockPath,
} from '../../../src/parallel/file-locks';
import { loadPlan } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

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
	const markerPath = () => path.join(dir, '.swarm', 'spec-staleness.json');

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
	});

	afterEach(() => {
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
		const lockPath = getOwnerLockPath(dir, 'spec.md');
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		const held = acquireOwnerLockOnce(lockPath, 'spec-write', 'live-writer');
		expect(held.acquired).toBe(true);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(false);

		held.release();
		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(true);
	});

	test('a dead-owner lock file does not suppress the marker (fail-closed on drift)', async () => {
		const lockPath = getOwnerLockPath(dir, 'spec.md');
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				v: 1,
				nonce: 'dead-nonce',
				ownerPid: 2147483646,
				startBoundMs: 0,
				agent: 'spec-write',
				taskId: 'crashed-writer',
				acquiredAtMs: 1700000000000,
			}),
		);

		await loadPlan(dir);
		expect(fs.existsSync(markerPath())).toBe(true);
	});
});
