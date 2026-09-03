/**
 * #1850: cohort-aware provider pool keying (acceptance #5).
 * Verifies cohort roots get distinct pool keys from local roots, and that
 * evictAndCloseForRoot is scoped (does not clear unrelated entries).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/config';
import {
	clearPool,
	evictAndCloseForRoot,
	getOrCreateProvider,
	getOrCreateProviderForRoot,
} from '../../../src/memory/provider-pool';
import { wrapLocalRoot } from '../../../src/memory/storage-root';
import { _internals as filesystemIdentityInternals } from '../../../src/utils/filesystem-identity';

const originalFilesystemIdentityInternals = { ...filesystemIdentityInternals };

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 provider pool cohort keying (acceptance #5)', () => {
	const dirs: string[] = [];

	beforeEach(() => {
		clearPool();
	});

	afterEach(() => {
		clearPool();
		filesystemIdentityInternals.realpathSyncNative =
			originalFilesystemIdentityInternals.realpathSyncNative;
		filesystemIdentityInternals.realpathSync =
			originalFilesystemIdentityInternals.realpathSync;
		filesystemIdentityInternals.lstatSync =
			originalFilesystemIdentityInternals.lstatSync;
		filesystemIdentityInternals.platform =
			originalFilesystemIdentityInternals.platform;
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort Windows EBUSY */
			}
		}
	});

	test('F-8: two distinct local roots get distinct providers', () => {
		const dirA = makeTmp('pool-local-a-');
		const dirB = makeTmp('pool-local-b-');
		dirs.push(dirA, dirB);
		const rootA = wrapLocalRoot(dirA);
		const rootB = wrapLocalRoot(dirB);
		const provA = getOrCreateProviderForRoot(rootA, DEFAULT_MEMORY_CONFIG);
		const provB = getOrCreateProviderForRoot(rootB, DEFAULT_MEMORY_CONFIG);
		expect(provA).not.toBe(provB);
	});

	test('F-9: same local root returns same provider (cache hit)', () => {
		const dir = makeTmp('pool-same-');
		dirs.push(dir);
		const root = wrapLocalRoot(dir);
		const prov1 = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
		const prov2 = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
		expect(prov1).toBe(prov2);
	});

	test('F-10: cohort root and local root for same directory get distinct providers', () => {
		const dir = makeTmp('pool-mixed-');
		dirs.push(dir);
		const localRoot = wrapLocalRoot(dir);
		const cohortRoot = {
			kind: 'cohort' as const,
			cohortRoot: path.join(dir, 'fake-cohort', 'memory'),
			cohortId: 'fake-cohort-id',
			generation: 1,
			linkId: 'fake-cohort',
			directory: dir,
		};
		const localProv = getOrCreateProviderForRoot(
			localRoot,
			DEFAULT_MEMORY_CONFIG,
		);
		const cohortProv = getOrCreateProviderForRoot(
			cohortRoot,
			DEFAULT_MEMORY_CONFIG,
		);
		expect(localProv).not.toBe(cohortProv);
	});

	test('F-11: evictAndCloseForRoot is scoped (does not evict unrelated entries)', () => {
		const dirA = makeTmp('pool-evict-a-');
		const dirB = makeTmp('pool-evict-b-');
		dirs.push(dirA, dirB);
		const rootA = wrapLocalRoot(dirA);
		const rootB = wrapLocalRoot(dirB);
		const provA = getOrCreateProviderForRoot(rootA, DEFAULT_MEMORY_CONFIG);
		const provB = getOrCreateProviderForRoot(rootB, DEFAULT_MEMORY_CONFIG);
		// Release A's refcount so eviction can really close it.
		provA.close();
		// Evict A only.
		evictAndCloseForRoot(rootA);
		// Re-acquire A — should be a new instance.
		const provA2 = getOrCreateProviderForRoot(rootA, DEFAULT_MEMORY_CONFIG);
		expect(provA2).not.toBe(provA);
		// B should still be cached (same instance).
		const provB2 = getOrCreateProviderForRoot(rootB, DEFAULT_MEMORY_CONFIG);
		expect(provB2).toBe(provB);
	});

	test('cohort root missing then created reuses its provider', () => {
		const dir = makeTmp('pool-cohort-create-');
		const physicalParent = makeTmp('pool-cohort-physical-');
		dirs.push(dir, physicalParent);
		const aliasParent = path.join(dir, 'cohort-parent-alias');
		symlinkSync(
			physicalParent,
			aliasParent,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		const cohortRoot = path.join(aliasParent, 'cohort', 'memory');
		const root = {
			kind: 'cohort' as const,
			cohortRoot,
			cohortId: 'cohort-create-id',
			generation: 1,
			linkId: 'cohort-create',
			directory: dir,
		};

		try {
			const first = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
			// Acquisition materializes the initially missing vetted cohort store.
			expect(existsSync(cohortRoot)).toBe(true);
			const second = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
			expect(second).toBe(first);
		} finally {
			rmSync(aliasParent, { recursive: true, force: true });
		}
	});

	test('deleted cohort alias reuses its last physical provider key', () => {
		const dir = makeTmp('pool-cohort-delete-');
		const target = makeTmp('pool-cohort-target-');
		dirs.push(dir, target);
		const alias = path.join(dir, 'cohort-alias');
		symlinkSync(
			target,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		const root = {
			kind: 'cohort' as const,
			cohortRoot: alias,
			cohortId: 'cohort-delete-id',
			generation: 1,
			linkId: 'cohort-delete',
			directory: dir,
		};
		try {
			const first = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
			rmSync(alias, { recursive: true, force: true });
			const second = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
			expect(second).toBe(first);
		} finally {
			rmSync(alias, { recursive: true, force: true });
		}
	});

	test('retargeted cohort alias gets a distinct physical provider', () => {
		const dir = makeTmp('pool-cohort-retarget-');
		const targetA = makeTmp('pool-cohort-a-');
		const targetB = makeTmp('pool-cohort-b-');
		dirs.push(dir, targetA, targetB);
		const alias = path.join(dir, 'cohort-retarget-alias');
		const root = {
			kind: 'cohort' as const,
			cohortRoot: alias,
			cohortId: 'cohort-retarget-id',
			generation: 1,
			linkId: 'cohort-retarget',
			directory: dir,
		};
		try {
			symlinkSync(
				targetA,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const first = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
			rmSync(alias, { recursive: true, force: true });
			symlinkSync(
				targetB,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const second = getOrCreateProviderForRoot(root, DEFAULT_MEMORY_CONFIG);
			expect(second).not.toBe(first);
		} finally {
			rmSync(alias, { recursive: true, force: true });
		}
	});

	test('pins lazy local provider I/O to its acquisition-time physical root', async () => {
		const holder = makeTmp('pool-lazy-retarget-holder-');
		const targetA = makeTmp('pool-lazy-retarget-a-');
		const targetB = makeTmp('pool-lazy-retarget-b-');
		dirs.push(holder, targetA, targetB);
		const alias = path.join(holder, 'project-alias');
		try {
			symlinkSync(
				targetA,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const providerA = getOrCreateProviderForRoot(
				wrapLocalRoot(alias),
				DEFAULT_MEMORY_CONFIG,
			);

			rmSync(alias, { recursive: true, force: true });
			symlinkSync(
				targetB,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			await providerA.initialize();

			expect(
				existsSync(path.join(targetA, '.swarm', 'memory', 'memory.db')),
			).toBe(true);
			expect(
				existsSync(path.join(targetB, '.swarm', 'memory', 'memory.db')),
			).toBe(false);

			const providerB = getOrCreateProviderForRoot(
				wrapLocalRoot(alias),
				DEFAULT_MEMORY_CONFIG,
			);
			expect(providerB).not.toBe(providerA);
			await providerB.initialize();
			expect(
				existsSync(path.join(targetB, '.swarm', 'memory', 'memory.db')),
			).toBe(true);
		} finally {
			rmSync(alias, { recursive: true, force: true });
		}
	});

	test('pins legacy lazy-provider I/O to its acquisition-time physical root', async () => {
		const holder = makeTmp('pool-legacy-retarget-holder-');
		const targetA = makeTmp('pool-legacy-retarget-a-');
		const targetB = makeTmp('pool-legacy-retarget-b-');
		dirs.push(holder, targetA, targetB);
		const alias = path.join(holder, 'project-alias');
		try {
			symlinkSync(
				targetA,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const providerA = getOrCreateProvider(alias, DEFAULT_MEMORY_CONFIG);
			rmSync(alias, { recursive: true, force: true });
			symlinkSync(
				targetB,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			await providerA.initialize();
			expect(
				existsSync(path.join(targetA, '.swarm', 'memory', 'memory.db')),
			).toBe(true);
			expect(
				existsSync(path.join(targetB, '.swarm', 'memory', 'memory.db')),
			).toBe(false);
		} finally {
			rmSync(alias, { recursive: true, force: true });
		}
	});

	for (const acquisition of ['legacy', 'vetted'] as const) {
		test(`pins a missing ${acquisition} project beneath a retargeted parent alias`, async () => {
			const holder = makeTmp(`pool-missing-${acquisition}-holder-`);
			const targetA = makeTmp(`pool-missing-${acquisition}-a-`);
			const targetB = makeTmp(`pool-missing-${acquisition}-b-`);
			dirs.push(holder, targetA, targetB);
			mkdirSync(path.join(targetA, 'existing-child'));
			mkdirSync(path.join(targetB, 'existing-child'));
			const alias = path.join(holder, 'parent-alias');
			const project = path.join(alias, 'existing-child', 'not-created-yet');
			try {
				symlinkSync(
					targetA,
					alias,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
				const acquire = () =>
					acquisition === 'legacy'
						? getOrCreateProvider(project, DEFAULT_MEMORY_CONFIG)
						: getOrCreateProviderForRoot(
								wrapLocalRoot(project),
								DEFAULT_MEMORY_CONFIG,
							);
				const providerA = acquire();

				rmSync(alias, { recursive: true, force: true });
				symlinkSync(
					targetB,
					alias,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
				const providerB = acquire();
				expect(providerB).not.toBe(providerA);

				await providerA.initialize();
				await providerB.initialize();
				expect(
					existsSync(
						path.join(
							targetA,
							'existing-child',
							'not-created-yet',
							'.swarm',
							'memory',
							'memory.db',
						),
					),
				).toBe(true);
				expect(
					existsSync(
						path.join(
							targetB,
							'existing-child',
							'not-created-yet',
							'.swarm',
							'memory',
							'memory.db',
						),
					),
				).toBe(true);
			} finally {
				rmSync(alias, { recursive: true, force: true });
			}
		});
	}

	test('reuses the captured local pool key for lazy provider storage', async () => {
		const holder = makeTmp('pool-captured-key-holder-');
		const targetA = makeTmp('pool-captured-key-a-');
		const targetB = makeTmp('pool-captured-key-b-');
		dirs.push(holder, targetA, targetB);
		const alias = path.join(holder, 'project-alias');
		const normalizedAlias = path.resolve(alias).toLowerCase();
		let aliasResolutions = 0;
		symlinkSync(
			targetA,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		filesystemIdentityInternals.realpathSyncNative = (entry) => {
			if (path.resolve(String(entry)).toLowerCase() === normalizedAlias) {
				aliasResolutions += 1;
				return aliasResolutions <= 2 ? targetA : targetB;
			}
			return originalFilesystemIdentityInternals.realpathSyncNative(entry);
		};

		try {
			const provider = getOrCreateProviderForRoot(
				wrapLocalRoot(alias),
				DEFAULT_MEMORY_CONFIG,
			);
			filesystemIdentityInternals.realpathSyncNative =
				originalFilesystemIdentityInternals.realpathSyncNative;
			await provider.initialize();
			expect(aliasResolutions).toBe(2);
			expect(
				existsSync(path.join(targetA, '.swarm', 'memory', 'memory.db')),
			).toBe(true);
			expect(
				existsSync(path.join(targetB, '.swarm', 'memory', 'memory.db')),
			).toBe(false);
		} finally {
			filesystemIdentityInternals.realpathSyncNative =
				originalFilesystemIdentityInternals.realpathSyncNative;
			rmSync(alias, { recursive: true, force: true });
		}
	});

	test('fails closed when no physical provider-root witness is accessible', () => {
		const directory = makeTmp('pool-inaccessible-root-');
		dirs.push(directory);
		const denied = path.resolve(directory).toLowerCase();
		filesystemIdentityInternals.realpathSyncNative = (entry) => {
			if (path.resolve(String(entry)).toLowerCase() === denied) {
				throw Object.assign(new Error('denied'), { code: 'EACCES' });
			}
			return originalFilesystemIdentityInternals.realpathSyncNative(entry);
		};
		filesystemIdentityInternals.realpathSync = ((entry) => {
			if (path.resolve(String(entry)).toLowerCase() === denied) {
				throw Object.assign(new Error('denied'), { code: 'EACCES' });
			}
			return originalFilesystemIdentityInternals.realpathSync(entry);
		}) as typeof filesystemIdentityInternals.realpathSync;

		expect(() => getOrCreateProvider(directory, DEFAULT_MEMORY_CONFIG)).toThrow(
			'physical identity could not be resolved',
		);
	});
});
