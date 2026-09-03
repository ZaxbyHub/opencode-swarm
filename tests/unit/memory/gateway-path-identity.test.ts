import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	createConfiguredMemoryProviderForRoot,
	MemoryGateway,
} from '../../../src/memory';
import { DEFAULT_MEMORY_CONFIG } from '../../../src/memory/config';
import { clearPool } from '../../../src/memory/provider-pool';
import { wrapLocalRoot } from '../../../src/memory/storage-root';
import {
	canonicalExistingFilesystemPath,
	canonicalPathForFutureIo,
	_internals as filesystemIdentityInternals,
} from '../../../src/utils/filesystem-identity';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalFilesystemIdentityInternals = { ...filesystemIdentityInternals };

describe('memory gateway path identity (#2474)', () => {
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
	});

	test('retains its physical scope while a new gateway follows a retargeted alias', async () => {
		const firstDir = canonicalMkdtemp('memory-gateway-a-');
		const secondDir = canonicalMkdtemp('memory-gateway-b-');
		const alias = `${firstDir}-alias`;
		let gatewayA: MemoryGateway | undefined;
		let gatewayB: MemoryGateway | undefined;
		try {
			await fs.mkdir(path.join(firstDir, '.git'));
			await fs.writeFile(
				path.join(firstDir, '.git', 'config'),
				'[remote "origin"]\n\turl = https://example.test/repository-a.git\n',
			);
			await fs.mkdir(path.join(secondDir, '.git'));
			await fs.writeFile(
				path.join(secondDir, '.git', 'config'),
				'[remote "origin"]\n\turl = https://example.test/repository-b.git\n',
			);
			await fs.symlink(
				firstDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);

			gatewayA = new MemoryGateway(
				{ directory: alias },
				{ config: { enabled: false } },
			);
			const repositoryA = gatewayA
				.deriveAllowedScopes()
				.find((scope) => scope.type === 'repository');

			await fs.rm(alias, { recursive: true, force: true });
			await fs.symlink(
				secondDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const retainedRepository = gatewayA
				.deriveAllowedScopes()
				.find((scope) => scope.type === 'repository');
			gatewayB = new MemoryGateway(
				{ directory: alias },
				{ config: { enabled: false } },
			);
			const repositoryB = gatewayB
				.deriveAllowedScopes()
				.find((scope) => scope.type === 'repository');

			expect(repositoryA?.repoRoot?.toLowerCase()).toBe(
				(canonicalExistingFilesystemPath(firstDir) ?? firstDir).toLowerCase(),
			);
			expect(retainedRepository).toEqual(repositoryA);
			expect(repositoryB?.repoRoot?.toLowerCase()).toBe(
				(canonicalExistingFilesystemPath(secondDir) ?? secondDir).toLowerCase(),
			);
			expect(repositoryB?.repoId).not.toBe(repositoryA?.repoId);
		} finally {
			await gatewayA?.dispose();
			await gatewayB?.dispose();
			clearPool();
			await fs.rm(alias, { recursive: true, force: true });
			await fs.rm(firstDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 25,
			});
			await fs.rm(secondDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 25,
			});
		}
	});

	test('binds enabled gateway scopes and storage to one physical root', async () => {
		const firstDir = canonicalMkdtemp('memory-gateway-bound-a-');
		const secondDir = canonicalMkdtemp('memory-gateway-bound-b-');
		const alias = `${firstDir}-bound-alias`;
		let gatewayA: MemoryGateway | undefined;
		let gatewayB: MemoryGateway | undefined;
		try {
			await fs.mkdir(path.join(firstDir, '.git'));
			await fs.writeFile(
				path.join(firstDir, '.git', 'config'),
				'[remote "origin"]\n\turl = https://example.test/bound-a.git\n',
			);
			await fs.mkdir(path.join(secondDir, '.git'));
			await fs.writeFile(
				path.join(secondDir, '.git', 'config'),
				'[remote "origin"]\n\turl = https://example.test/bound-b.git\n',
			);
			await fs.symlink(
				firstDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);

			gatewayA = new MemoryGateway(
				{ directory: alias },
				{ config: { enabled: true } },
			);
			await gatewayA.recall({ query: 'physical root binding probe' });
			const scopeA = gatewayA
				.deriveAllowedScopes()
				.find((scope) => scope.type === 'repository');

			await fs.rm(alias, { recursive: true, force: true });
			await fs.symlink(
				secondDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			await gatewayA.recall({ query: 'same gateway after alias retarget' });
			const retainedScope = gatewayA
				.deriveAllowedScopes()
				.find((scope) => scope.type === 'repository');

			expect(retainedScope).toEqual(scopeA);
			expect(retainedScope?.repoRoot?.toLowerCase()).toBe(
				(canonicalExistingFilesystemPath(firstDir) ?? firstDir).toLowerCase(),
			);
			expect(
				existsSync(path.join(firstDir, '.swarm', 'memory', 'memory.db')),
			).toBe(true);
			expect(
				existsSync(path.join(secondDir, '.swarm', 'memory', 'memory.db')),
			).toBe(false);

			gatewayB = new MemoryGateway(
				{ directory: alias },
				{ config: { enabled: true } },
			);
			await gatewayB.recall({ query: 'new gateway follows retarget' });
			const scopeB = gatewayB
				.deriveAllowedScopes()
				.find((scope) => scope.type === 'repository');
			expect(scopeB?.repoRoot?.toLowerCase()).toBe(
				(canonicalExistingFilesystemPath(secondDir) ?? secondDir).toLowerCase(),
			);
			expect(scopeB?.repoId).not.toBe(scopeA?.repoId);
			expect(
				existsSync(path.join(secondDir, '.swarm', 'memory', 'memory.db')),
			).toBe(true);
		} finally {
			await gatewayA?.dispose();
			await gatewayB?.dispose();
			clearPool();
			await fs.rm(alias, { recursive: true, force: true });
			await fs.rm(firstDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 25,
			});
			await fs.rm(secondDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 25,
			});
		}
	});

	test('binds a missing project gateway through its existing physical ancestor', async () => {
		const holder = canonicalMkdtemp('memory-gateway-missing-holder-');
		const firstDir = canonicalMkdtemp('memory-gateway-missing-a-');
		const secondDir = canonicalMkdtemp('memory-gateway-missing-b-');
		const alias = path.join(holder, 'parent-alias');
		await fs.mkdir(path.join(firstDir, 'existing-child'));
		await fs.mkdir(path.join(secondDir, 'existing-child'));
		const project = path.join(alias, 'existing-child', 'missing-project');
		const expectedProjectRoot =
			canonicalPathForFutureIo(
				path.join(firstDir, 'existing-child', 'missing-project'),
			) ?? path.join(firstDir, 'existing-child', 'missing-project');
		let gateway: MemoryGateway | undefined;
		try {
			await fs.symlink(
				firstDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			gateway = new MemoryGateway(
				{ directory: project },
				{ config: { enabled: true } },
			);

			await fs.rm(alias, { recursive: true, force: true });
			await fs.symlink(
				secondDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			await gateway.recall({ query: 'missing project gateway binding' });
			const scope = gateway
				.deriveAllowedScopes()
				.find((candidate) => candidate.type === 'repository');

			expect(scope?.repoRoot?.toLowerCase()).toBe(
				expectedProjectRoot.toLowerCase(),
			);
			expect(
				existsSync(
					path.join(
						firstDir,
						'existing-child',
						'missing-project',
						'.swarm',
						'memory',
						'memory.db',
					),
				),
			).toBe(true);
			expect(
				existsSync(
					path.join(
						secondDir,
						'existing-child',
						'missing-project',
						'.swarm',
						'memory',
						'memory.db',
					),
				),
			).toBe(false);
		} finally {
			await gateway?.dispose();
			clearPool();
			await fs.rm(alias, { recursive: true, force: true });
			await fs.rm(holder, { recursive: true, force: true });
			await fs.rm(firstDir, { recursive: true, force: true });
			await fs.rm(secondDir, { recursive: true, force: true });
		}
	});

	test('pins local JSONL I/O for a missing project before alias retarget', async () => {
		const holder = canonicalMkdtemp('memory-jsonl-missing-holder-');
		const firstDir = canonicalMkdtemp('memory-jsonl-missing-a-');
		const secondDir = canonicalMkdtemp('memory-jsonl-missing-b-');
		const alias = path.join(holder, 'parent-alias');
		await fs.mkdir(path.join(firstDir, 'existing-child'));
		await fs.mkdir(path.join(secondDir, 'existing-child'));
		const project = path.join(alias, 'existing-child', 'missing-project');
		try {
			await fs.symlink(
				firstDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const provider = createConfiguredMemoryProviderForRoot(
				wrapLocalRoot(project),
				{
					...DEFAULT_MEMORY_CONFIG,
					enabled: true,
					provider: 'local-jsonl',
				},
			);

			await fs.rm(alias, { recursive: true, force: true });
			await fs.symlink(
				secondDir,
				alias,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			await provider.recordRecallUsage?.({
				bundleId: 'bundle_missing_jsonl_binding',
				query: 'missing JSONL binding',
				scopes: [],
				memoryIds: [],
				scores: [],
				tokenEstimate: 0,
				timestamp: '2026-09-02T00:00:00.000Z',
			});

			expect(
				existsSync(
					path.join(
						firstDir,
						'existing-child',
						'missing-project',
						'.swarm',
						'memory',
						'audit.jsonl',
					),
				),
			).toBe(true);
			expect(
				existsSync(
					path.join(
						secondDir,
						'existing-child',
						'missing-project',
						'.swarm',
						'memory',
						'audit.jsonl',
					),
				),
			).toBe(false);
			await provider.close?.();
		} finally {
			await fs.rm(alias, { recursive: true, force: true });
			await fs.rm(holder, { recursive: true, force: true });
			await fs.rm(firstDir, { recursive: true, force: true });
			await fs.rm(secondDir, { recursive: true, force: true });
		}
	});

	test('fails closed when gateway physical identity is inaccessible', async () => {
		const directory = canonicalMkdtemp('memory-gateway-inaccessible-');
		try {
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
			expect(
				() => new MemoryGateway({ directory }, { config: { enabled: true } }),
			).toThrow('physical identity could not be resolved');
		} finally {
			filesystemIdentityInternals.realpathSyncNative =
				originalFilesystemIdentityInternals.realpathSyncNative;
			filesystemIdentityInternals.realpathSync =
				originalFilesystemIdentityInternals.realpathSync;
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
