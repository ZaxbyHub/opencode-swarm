// #2967 lane listing contract (Group 6, relocated from
// file-locks-lane.test.ts for FR-006: the parent is a grandfathered
// over-cap file that may not grow). Lane locks ride the wx owner-payload
// substrate — listActiveLocks projects the PAYLOAD (agent/taskId + live
// heartbeat) AND the sibling .meta sidecar (laneId + originalPath), so the
// lean lane gates (phase-ready / task-completion) can gate on lane identity
// again (feedback PRR-001). AFTER-EACH CLEANUP (feedback PRR-030b): this
// suite leaked its temp trees — dispose every scratch tree in afterEach.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	acquireLaneLocks,
	getOwnerLockPath,
	listActiveLocks,
	releaseLaneLocks,
} from '../../../src/parallel/file-locks';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('lane-listing-2967-');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Group 6: listActiveLocks with metadata (#2967 payload projection)', () => {
	it('lists lane locks with laneId + originalPath projected from the .meta sidecar (feedback PRR-001)', async () => {
		const files = ['real-path-a.ts', 'real-path-b.ts'];
		await acquireLaneLocks(
			tmpDir,
			'rich-lane',
			files,
			'rich-agent',
			'3.14',
			'session-rich',
		);

		const locks = listActiveLocks(tmpDir);
		expect(locks.length).toBeGreaterThanOrEqual(2);
		const richLocks = locks.filter(
			(l) => l.agent === 'rich-agent' && l.taskId === '3.14',
		);
		expect(richLocks).toHaveLength(2);

		// The lean lane gates filter on lock.laneId — the sidecar's laneId
		// and the ORIGINAL relative path are both projected now (the meta
		// stores the caller-relative name acquireLaneLocks received).
		const expectedPaths = [...files].sort();
		const listedPaths = richLocks.map((l) => l.filePath).sort();
		expect(listedPaths).toEqual(expectedPaths);
		for (const lock of richLocks) {
			expect(lock.laneId).toBe('rich-lane');
			// Live owner heartbeat: active with no expiry horizon.
			expect(lock.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
		}

		// The lane's rich metadata (laneId + original path) is intact in
		// the sidecar.
		const locksDir = path.join(tmpDir, '.swarm', 'locks');
		const laneMetas = fs
			.readdirSync(locksDir)
			.filter((f) => f.endsWith('.meta'))
			.map(
				(f) =>
					JSON.parse(fs.readFileSync(path.join(locksDir, f), 'utf-8')) as {
						laneId: string;
						originalPath: string;
						agent: string;
					},
			)
			.filter((m) => m.laneId === 'rich-lane');
		expect(laneMetas).toHaveLength(2);
		for (const meta of laneMetas) {
			expect(files).toContain(meta.originalPath);
			expect(meta.agent).toBe('rich-agent');
		}

		await releaseLaneLocks(tmpDir, 'rich-lane');
	});

	it('returns empty array when no locks exist', () => {
		const locks = listActiveLocks(tmpDir);
		expect(locks).toEqual([]);
	});
});
