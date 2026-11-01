// #2967 lane listing contract (Group 6, relocated from
// file-locks-lane.test.ts for FR-006: the parent is a grandfathered
// over-cap file that may not grow). Lane locks ride the wx owner-payload
// substrate — listActiveLocks projects the PAYLOAD (artifact path +
// agent/taskId + live heartbeat); the laneId and original path are carried
// by the .meta sidecar.
import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	acquireLaneLocks,
	getOwnerLockPath,
	listActiveLocks,
	releaseLaneLocks,
} from '../../../src/parallel/file-locks';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-listing-2967-'));
});

describe('Group 6: listActiveLocks with metadata (#2967 payload projection)', () => {
	it('lists lane locks via the .lck payload projection; rich lane identity lives in the .meta sidecar', async () => {
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

		const expectedPaths = files.map((f) => getOwnerLockPath(tmpDir, f));
		const listedPaths = richLocks.map((l) => l.filePath).sort();
		expect(listedPaths).toEqual(expectedPaths.sort());
		for (const lock of richLocks) {
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
