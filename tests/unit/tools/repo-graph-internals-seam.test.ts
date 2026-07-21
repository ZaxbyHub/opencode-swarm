/**
 * Verification tests for _internals DI seams in builder.ts and storage.ts.
 * Verifies:
 * 1. _internals is exported from both modules
 * 2. Mocking _internals.safeRealpathSync affects internal behavior
 * 3. Default behavior is unchanged when seam is not mocked
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Import _internals from the specific source files (not barrel — _internals is not re-exported there)
import {
	_internals as builder_internals,
	resolveModuleSpecifier,
} from '../../../src/tools/repo-graph/builder';
import {
	saveGraph,
	_internals as storage_internals,
} from '../../../src/tools/repo-graph/storage';

describe('_internals DI seam — builder.ts', () => {
	test('_internals is exported with safeRealpathSync function', () => {
		expect(builder_internals).toBeDefined();
		expect(typeof builder_internals.now).toBe('function');
		expect(typeof builder_internals.safeRealpathSync).toBe('function');
	});

	test('mocking _internals.safeRealpathSync intercepts resolveModuleSpecifier', () => {
		const original = builder_internals.safeRealpathSync;
		let callCount = 0;

		// Replace with tracking mock — this proves the seam is used internally
		builder_internals.safeRealpathSync = mock(
			(targetPath: string, fallback: string) => {
				callCount++;
				return original(targetPath, fallback);
			},
		);

		// resolveModuleSpecifier calls _internals.safeRealpathSync when resolving
		// relative imports. Use a path that exercises symlink resolution.
		const result = resolveModuleSpecifier(
			os.tmpdir(),
			path.join(os.tmpdir(), 'source.ts'),
			'./nonexistent',
		);

		// If the seam is live, our mock was called at least once
		expect(callCount).toBeGreaterThan(0);
		// Non-existent path returns null — default behavior preserved
		expect(result).toBeNull();

		builder_internals.safeRealpathSync = original;
	});

	test('seam preserves default behavior when not mocked', () => {
		// Without mocking, the seam still calls the real safeRealpathSync
		const result = resolveModuleSpecifier(
			os.tmpdir(),
			path.join(os.tmpdir(), 'source.ts'),
			'./foo',
		);
		// Returns null for non-existent path — correct default behavior
		expect(result).toBeNull();
	});

	afterEach(() => {
		mock.restore();
	});
});

describe('_internals DI seam — storage.ts', () => {
	let tempDir: string;
	let originalCwd: string;
	const workspaceName = 'seam-test-repo';

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repo-seam-'));
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		mock.restore();
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('_internals is exported with safeRealpathSync function', () => {
		expect(storage_internals).toBeDefined();
		expect(typeof storage_internals.safeRealpathSync).toBe('function');
	});

	test('mocking _internals.safeRealpathSync intercepts saveGraph security check', async () => {
		const original = storage_internals.safeRealpathSync;
		let callCount = 0;

		// Replace with tracking mock — proves seam is called in saveGraph
		storage_internals.safeRealpathSync = mock(
			(targetPath: string, fallback: string): string | null => {
				callCount++;
				return original(targetPath, fallback);
			},
		);

		// Create .swarm directory for saveGraph
		await fs.promises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});

		const graph = {
			schema_version: '1.0.0',
			workspaceRoot: path.resolve(workspaceName),
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		await saveGraph(workspaceName, graph);

		// saveGraph calls _internals.safeRealpathSync twice:
		// once for workspace realpath, once for graph.workspaceRoot
		expect(callCount).toBeGreaterThanOrEqual(2);

		storage_internals.safeRealpathSync = original;
	});

	test('seam preserves default behavior when not mocked', async () => {
		// Verify that without mocking, saveGraph still works correctly
		await fs.promises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});

		const graph = {
			schema_version: '1.0.0',
			workspaceRoot: path.resolve(workspaceName),
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		// Should not throw — seam uses real function when not mocked
		await expect(saveGraph(workspaceName, graph)).resolves.toBeUndefined();
	});
});
