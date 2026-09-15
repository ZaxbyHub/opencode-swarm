import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_snapshotCoordinationInternals,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init.js';
import { _internals as canonicalRootInternals } from '../../../src/utils/canonical-root.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('snapshot coordination root binding — regression: SRC-002', () => {
	const originalInitialize = _snapshotCoordinationInternals.initialize;
	const originalRealpathSyncNative = canonicalRootInternals.realpathSyncNative;
	const originalRealpathSync = canonicalRootInternals.realpathSync;
	let tempDir: string | undefined;

	afterEach(() => {
		_snapshotCoordinationInternals.initialize = originalInitialize;
		_snapshotCoordinationInternals.entries.clear();
		canonicalRootInternals.realpathSyncNative = originalRealpathSyncNative;
		canonicalRootInternals.realpathSync = originalRealpathSync;
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('retargeted alias cannot split hydration authority from initializer root', async () => {
		tempDir = canonicalMkdtemp('snapshot-coordination-root-binding-');
		const alias = path.join(tempDir, 'moving-alias');
		const rootA = path.join(tempDir, 'project-a');
		const rootB = path.join(tempDir, 'project-b');
		const resolvedAlias = path.resolve(alias);
		const normalized = (root: string) =>
			process.platform === 'win32'
				? path.resolve(root).toLowerCase()
				: path.resolve(root);
		let aliasResolutions = 0;
		canonicalRootInternals.realpathSyncNative = (candidate) => {
			const resolved = path.resolve(String(candidate));
			if (resolved === resolvedAlias) {
				aliasResolutions += 1;
				// Simulate an A→B symlink/junction retarget after the initializer
				// captures its project root but before it starts hydration.
				return aliasResolutions === 1 ? rootA : rootB;
			}
			return resolved;
		};

		let initialized: { directory: string; projectKey?: string } | undefined;
		_snapshotCoordinationInternals.initialize = async (directory, scope) => {
			initialized = { directory, projectKey: scope?.projectKey };
			return 'succeeded';
		};

		await startSnapshotCoordinationInitialization(alias);

		const expectedRootA = normalized(rootA);
		const expectedRootB = normalized(rootB);
		expect(aliasResolutions).toBe(1);
		expect(expectedRootA).not.toBe(expectedRootB);
		expect(initialized).toEqual({
			directory: expectedRootA,
			projectKey: expectedRootA,
		});
	});
});
