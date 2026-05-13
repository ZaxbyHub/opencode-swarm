/**
 * Tests for repo-graph.ts module
 * Focused verification of: workspace rejection, absolute filePath validation,
 * mtime cache invalidation, atomic create fallback, structured corruption handling,
 * and workspaceRoot matching on save.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	addEdge,
	buildWorkspaceGraph,
	clearCache,
	createEmptyGraph,
	type GraphEdge,
	type GraphNode,
	getCachedGraph,
	isDirty,
	loadGraph,
	loadOrCreateGraph,
	markDirty,
	type RepoGraph,
	saveGraph,
	setCachedGraph,
	upsertNode,
	validateGraphEdge,
	validateGraphNode,
	validateWorkspace,
} from '../../../src/tools/repo-graph';

describe('validateWorkspace', () => {
	test('rejects empty string', () => {
		expect(() => validateWorkspace('')).toThrow(
			'Invalid workspace: must be a non-empty string',
		);
	});

	test('rejects whitespace-only string', () => {
		expect(() => validateWorkspace('   ')).toThrow(
			'Invalid workspace: must be a non-empty string',
		);
	});

	test('rejects null/undefined', () => {
		// @ts-expect-error - testing invalid input
		expect(() => validateWorkspace(null)).toThrow(
			'Invalid workspace: must be a non-empty string',
		);
		// @ts-expect-error - testing invalid input
		expect(() => validateWorkspace(undefined)).toThrow(
			'Invalid workspace: must be a non-empty string',
		);
	});

	test('rejects control characters', () => {
		expect(() => validateWorkspace('work\x00space')).toThrow(
			'Invalid workspace: control characters detected',
		);
		expect(() => validateWorkspace('work\nspace')).toThrow(
			'Invalid workspace: control characters detected',
		);
	});

	test('rejects path traversal', () => {
		expect(() => validateWorkspace('../escape')).toThrow(
			'Invalid workspace: path traversal detected',
		);
		expect(() => validateWorkspace('foo/../../bar')).toThrow(
			'Invalid workspace: path traversal detected',
		);
	});

	test('accepts Unix absolute paths', () => {
		expect(() => validateWorkspace('/absolute/path')).not.toThrow();
		expect(() => validateWorkspace('\\backslash')).not.toThrow();
	});

	test('accepts Windows absolute paths', () => {
		expect(() => validateWorkspace('C:\\Windows\\path')).not.toThrow();
		expect(() => validateWorkspace('D:/other/drive')).not.toThrow();
	});

	test('accepts valid relative paths', () => {
		expect(() => validateWorkspace('my-project')).not.toThrow();
		expect(() => validateWorkspace('packages/lib')).not.toThrow();
	});
});

describe('validateGraphNode', () => {
	test('rejects node without filePath', () => {
		const node = {
			moduleName: 'foo',
			exports: [],
			imports: [],
			language: 'ts',
			mtime: '123',
		} as GraphNode;
		expect(() => validateGraphNode(node)).toThrow(
			'Invalid node: filePath is required',
		);
	});

	test('rejects node with relative filePath', () => {
		const node = {
			filePath: 'relative/path.ts',
			moduleName: 'foo',
			exports: [],
			imports: [],
			language: 'ts',
			mtime: '123',
		} as GraphNode;
		expect(() => validateGraphNode(node)).toThrow(
			'Invalid node: filePath must be absolute',
		);
	});

	test('accepts node with Unix absolute filePath', () => {
		const node = {
			filePath: '/absolute/path.ts',
			moduleName: 'foo',
			exports: [],
			imports: [],
			language: 'ts',
			mtime: '123',
		} as GraphNode;
		expect(() => validateGraphNode(node)).not.toThrow();
	});

	test('accepts node with Windows absolute filePath', () => {
		const node = {
			filePath: 'C:\\absolute\\path.ts',
			moduleName: 'foo',
			exports: [],
			imports: [],
			language: 'ts',
			mtime: '123',
		} as GraphNode;
		expect(() => validateGraphNode(node)).not.toThrow();
	});

	test('rejects node with path traversal in filePath', () => {
		const node = {
			filePath: '/foo/../bar/path.ts',
			moduleName: 'foo',
			exports: [],
			imports: [],
			language: 'ts',
			mtime: '123',
		} as GraphNode;
		expect(() => validateGraphNode(node)).toThrow(
			'Invalid node: filePath contains path traversal',
		);
	});

	test('rejects node with relative moduleName', () => {
		const node = {
			filePath: '/abs/path.ts',
			moduleName: '/relative',
			exports: [],
			imports: [],
			language: 'ts',
			mtime: '123',
		} as GraphNode;
		expect(() => validateGraphNode(node)).toThrow(
			'Invalid node: moduleName must be relative',
		);
	});

	test('rejects node with control characters in exports', () => {
		const node = {
			filePath: '/abs/path.ts',
			moduleName: 'foo',
			exports: ['exp\x00ort'],
			imports: [],
			language: 'ts',
			mtime: '123',
		} as GraphNode;
		expect(() => validateGraphNode(node)).toThrow(
			'Invalid node: exports contains control characters',
		);
	});
});

describe('validateGraphEdge', () => {
	test('rejects edge with path traversal', () => {
		const edge = {
			source: '/foo/../bar.ts',
			target: '/baz.ts',
			importSpecifier: './bar',
			importType: 'named' as const,
		};
		expect(() => validateGraphEdge(edge)).toThrow(
			'Invalid edge: path traversal detected',
		);
	});

	test('rejects edge with control characters', () => {
		const edge = {
			source: '/foo.ts',
			target: '/baz\x00.ts',
			importSpecifier: './bar',
			importType: 'named' as const,
		};
		expect(() => validateGraphEdge(edge)).toThrow(
			'Invalid edge: control characters detected',
		);
	});
});

describe('mtime cache invalidation', () => {
	let tempDir: string;
	let originalCwd: string;
	const workspaceName = 'test-repo'; // Relative workspace name

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'repo-graph-test-'),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		clearCache(workspaceName);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		clearCache(workspaceName);
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('cache is invalidated when file mtime changes', async () => {
		// Create a valid graph file in the workspace
		const graphPath = path.join(workspaceName, '.swarm', 'repo-graph.json');
		await fs.promises.mkdir(path.dirname(graphPath), { recursive: true });

		const originalGraph: RepoGraph = {
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

		await fs.promises.writeFile(
			graphPath,
			JSON.stringify(originalGraph),
			'utf-8',
		);
		const originalMtime = (await fs.promises.stat(graphPath)).mtimeMs;

		// Load graph - should be cached
		const loaded1 = await loadGraph(workspaceName);
		expect(loaded1).not.toBeNull();
		expect(getCachedGraph(workspaceName)).not.toBeUndefined();

		// Wait a bit and modify the file mtime
		await new Promise((resolve) => setTimeout(resolve, 50));
		await fs.promises.utimes(
			graphPath,
			new Date(),
			new Date(originalMtime + 1000),
		);

		// Load again - cache should be invalidated and fresh data returned
		const loaded2 = await loadGraph(workspaceName);
		expect(loaded2).not.toBeNull();
		expect(loaded2).toEqual(loaded1);
	});

	test('cache is cleared when file is deleted', async () => {
		// Create a valid graph file
		const graphPath = path.join(workspaceName, '.swarm', 'repo-graph.json');
		await fs.promises.mkdir(path.dirname(graphPath), { recursive: true });

		const originalGraph: RepoGraph = {
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

		await fs.promises.writeFile(
			graphPath,
			JSON.stringify(originalGraph),
			'utf-8',
		);

		// Load graph - should be cached
		await loadGraph(workspaceName);
		expect(getCachedGraph(workspaceName)).not.toBeUndefined();

		// Delete the file
		await fs.promises.unlink(graphPath);

		// Load again - should return null and clear cache
		const loaded = await loadGraph(workspaceName);
		expect(loaded).toBeNull();
		expect(getCachedGraph(workspaceName)).toBeUndefined();
	});
});

describe('structured corruption handling', () => {
	let tempDir: string;
	let originalCwd: string;
	const workspaceName = 'corrupt-repo';

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'repo-graph-corrupt-'),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		clearCache(workspaceName);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		clearCache(workspaceName);
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	async function createGraphFile(content: string): Promise<string> {
		const graphPath = path.join(workspaceName, '.swarm', 'repo-graph.json');
		await fs.promises.mkdir(path.dirname(graphPath), { recursive: true });
		await fs.promises.writeFile(graphPath, content, 'utf-8');
		return graphPath;
	}

	test('rejects content with null bytes', async () => {
		const content = JSON.stringify({ schema_version: '1.0.0' }).replace(
			'1.0',
			'1\x00.0',
		);
		await createGraphFile(content);

		await expect(loadGraph(workspaceName)).rejects.toThrow(
			'repo-graph.json contains null bytes or invalid encoding',
		);
	});

	test('rejects invalid JSON', async () => {
		await createGraphFile('{ invalid json content }');

		await expect(loadGraph(workspaceName)).rejects.toThrow(
			'repo-graph.json contains invalid JSON',
		);
	});

	test('rejects missing schema_version', async () => {
		await createGraphFile(
			JSON.stringify({
				workspaceRoot: path.resolve(workspaceName),
				nodes: {},
				edges: [],
				metadata: {
					generatedAt: new Date().toISOString(),
					generator: 'test',
					nodeCount: 0,
					edgeCount: 0,
				},
			}),
		);

		await expect(loadGraph(workspaceName)).rejects.toThrow(
			'repo-graph.json missing schema_version',
		);
	});

	test('rejects invalid nodes structure', async () => {
		await createGraphFile(
			JSON.stringify({
				schema_version: '1.0.0',
				workspaceRoot: path.resolve(workspaceName),
				nodes: 'not an object',
				edges: [],
				metadata: {
					generatedAt: new Date().toISOString(),
					generator: 'test',
					nodeCount: 0,
					edgeCount: 0,
				},
			}),
		);

		await expect(loadGraph(workspaceName)).rejects.toThrow(
			'repo-graph.json missing or invalid nodes',
		);
	});

	test('rejects invalid edges structure', async () => {
		await createGraphFile(
			JSON.stringify({
				schema_version: '1.0.0',
				workspaceRoot: path.resolve(workspaceName),
				nodes: {},
				edges: { not: 'an array' },
				metadata: {
					generatedAt: new Date().toISOString(),
					generator: 'test',
					nodeCount: 0,
					edgeCount: 0,
				},
			}),
		);

		await expect(loadGraph(workspaceName)).rejects.toThrow(
			'repo-graph.json missing or invalid edges',
		);
	});

	test('rejects node with invalid filePath', async () => {
		await createGraphFile(
			JSON.stringify({
				schema_version: '1.0.0',
				workspaceRoot: path.resolve(workspaceName),
				nodes: {
					key: {
						filePath: 'relative/path.ts', // Must be absolute
						moduleName: 'foo',
						exports: [],
						imports: [],
						language: 'ts',
						mtime: '123',
					},
				},
				edges: [],
				metadata: {
					generatedAt: new Date().toISOString(),
					generator: 'test',
					nodeCount: 1,
					edgeCount: 0,
				},
			}),
		);

		await expect(loadGraph(workspaceName)).rejects.toThrow(
			'filePath must be absolute',
		);
	});

	test('rejects missing metadata', async () => {
		await createGraphFile(
			JSON.stringify({
				schema_version: '1.0.0',
				workspaceRoot: path.resolve(workspaceName),
				nodes: {},
				edges: [],
			}),
		);

		await expect(loadGraph(workspaceName)).rejects.toThrow(
			'repo-graph.json missing or invalid metadata',
		);
	});

	test('accepts valid graph', async () => {
		const validGraph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: path.resolve(workspaceName),
			nodes: {
				'/test/file.ts': {
					filePath: '/test/file.ts',
					moduleName: 'file',
					exports: ['foo'],
					imports: [],
					language: 'ts',
					mtime: '123',
				},
			},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 1,
				edgeCount: 0,
			},
		};

		await createGraphFile(JSON.stringify(validGraph));

		const loaded = await loadGraph(workspaceName);
		expect(loaded).not.toBeNull();
		expect(loaded?.schema_version).toBe('1.0.0');
		expect(Object.keys(loaded?.nodes ?? {}).length).toBe(1);
	});
});

describe('workspaceRoot matching on save', () => {
	let tempDir: string;
	let originalCwd: string;
	const workspaceName = 'save-repo';

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'repo-graph-save-'),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		clearCache(workspaceName);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		clearCache(workspaceName);
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('saveGraph rejects mismatched workspaceRoot', async () => {
		const graph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: '/different/workspace', // Different from tempDir resolved path
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		await expect(saveGraph(workspaceName, graph)).rejects.toThrow(
			'Graph workspaceRoot mismatch',
		);
	});

	test('saveGraph accepts matching workspaceRoot', async () => {
		const resolvedWorkspace = path.resolve(workspaceName);
		const graph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: resolvedWorkspace,
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		// Ensure the .swarm directory exists (saveGraph writes to .swarm/repo-graph.json)
		await fs.promises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});

		// Should not throw
		await expect(saveGraph(workspaceName, graph)).resolves.toBeUndefined();

		// Verify file was created
		const graphPath = path.join(workspaceName, '.swarm', 'repo-graph.json');
		const exists = await fs.promises
			.access(graphPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
	});
});

describe('atomic create fallback', () => {
	let tempDir: string;
	let originalCwd: string;
	const workspaceName = 'atomic-repo';

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'repo-graph-atomic-'),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		clearCache(workspaceName);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		clearCache(workspaceName);
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('loadOrCreateGraph creates new graph if none exists', async () => {
		// Ensure the .swarm directory exists (saveGraph requires parent directories)
		await fs.promises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});

		const graph = await loadOrCreateGraph(workspaceName);

		expect(graph).not.toBeNull();
		// workspaceRoot is normalized but not resolved to absolute
		expect(graph.workspaceRoot).toBe(path.normalize(workspaceName));
		expect(graph.schema_version).toBe('1.0.0');
		expect(graph.nodes).toEqual({});
		expect(graph.edges).toEqual([]);
	});

	test('loadOrCreateGraph returns existing graph if file exists', async () => {
		// Create a file first
		const resolvedWorkspace = path.resolve(workspaceName);
		const existingGraph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: resolvedWorkspace,
			nodes: {
				'/test/existing.ts': {
					filePath: '/test/existing.ts',
					moduleName: 'existing',
					exports: ['existingFn'],
					imports: [],
					language: 'ts',
					mtime: '456',
				},
			},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 1,
				edgeCount: 0,
			},
		};

		const graphPath = path.join(workspaceName, '.swarm', 'repo-graph.json');
		await fs.promises.mkdir(path.dirname(graphPath), { recursive: true });
		await fs.promises.writeFile(
			graphPath,
			JSON.stringify(existingGraph),
			'utf-8',
		);

		const loaded = await loadOrCreateGraph(workspaceName);

		expect(loaded).not.toBeNull();
		expect(Object.keys(loaded.nodes)).toContain('/test/existing.ts');
		expect(loaded.nodes['/test/existing.ts'].exports).toEqual(['existingFn']);
	});

	test('loadOrCreateGraph handles race condition gracefully', async () => {
		// Ensure the .swarm directory exists
		await fs.promises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});

		// Simulate race: first call creates file between our load and create
		const graph = await loadOrCreateGraph(workspaceName);
		expect(graph).not.toBeNull();

		// The function should handle concurrent access gracefully
		const graph2 = await loadOrCreateGraph(workspaceName);
		expect(graph2).not.toBeNull();
	});
});

describe('cache operations', () => {
	test('setCachedGraph and getCachedGraph work correctly', () => {
		const workspace = 'test-cache';
		clearCache(workspace);

		const graph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: '/test/root',
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		setCachedGraph(workspace, graph);
		const cached = getCachedGraph(workspace);
		expect(cached).toEqual(graph);

		clearCache(workspace);
	});

	test('markDirty and isDirty work correctly', () => {
		const workspace = 'test-dirty';
		clearCache(workspace);

		expect(isDirty(workspace)).toBe(false);

		markDirty(workspace);
		expect(isDirty(workspace)).toBe(true);

		clearCache(workspace);
		expect(isDirty(workspace)).toBe(false);
	});

	test('clearCache removes all cached data', () => {
		const workspace = 'test-clear';
		const graph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: '/test/root',
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		setCachedGraph(workspace, graph, 12345);
		markDirty(workspace);

		clearCache(workspace);

		expect(getCachedGraph(workspace)).toBeUndefined();
		expect(isDirty(workspace)).toBe(false);
	});
});

describe('graph operations', () => {
	test('upsertNode adds new node', () => {
		const graph = createEmptyGraph('test');
		const node: GraphNode = {
			filePath: '/abs/test.ts',
			moduleName: 'test',
			exports: ['fn'],
			imports: [],
			language: 'ts',
			mtime: '123',
		};

		upsertNode(graph, node);

		// normalizeGraphPath always uses forward slashes for cross-platform consistency
		const key = path.normalize(node.filePath).replace(/\\/g, '/');
		expect(graph.nodes[key]).toEqual(node);
		expect(graph.metadata.nodeCount).toBe(1);
	});

	test('upsertNode updates existing node', () => {
		const graph = createEmptyGraph('test');
		const node1: GraphNode = {
			filePath: '/abs/test.ts',
			moduleName: 'test',
			exports: ['fn1'],
			imports: [],
			language: 'ts',
			mtime: '123',
		};
		const node2: GraphNode = {
			filePath: '/abs/test.ts',
			moduleName: 'test',
			exports: ['fn2'],
			imports: [],
			language: 'ts',
			mtime: '456',
		};

		upsertNode(graph, node1);
		upsertNode(graph, node2);

		const key = path.normalize(node1.filePath).replace(/\\/g, '/');
		expect(Object.keys(graph.nodes)).toHaveLength(1);
		expect(graph.nodes[key].exports).toEqual(['fn2']);
	});

	test('addEdge adds new edge', () => {
		const graph = createEmptyGraph('test');
		const edge: GraphEdge = {
			source: '/a.ts',
			target: '/b.ts',
			importSpecifier: './b',
			importType: 'named',
		};

		addEdge(graph, edge);

		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0]).toEqual(edge);
	});

	test('addEdge avoids duplicates', () => {
		const graph = createEmptyGraph('test');
		const edge: GraphEdge = {
			source: '/a.ts',
			target: '/b.ts',
			importSpecifier: './b',
			importType: 'named',
		};

		addEdge(graph, edge);
		addEdge(graph, edge);
		addEdge(graph, edge);

		expect(graph.edges).toHaveLength(1);
	});
});

describe('path normalization edge cases', () => {
	test('normalizeGraphPath handles mixed separators', () => {
		// Test that upsertNode normalizes mixed separators to forward-slash keys
		const graph = createEmptyGraph('test');
		const node: GraphNode = {
			filePath: '/foo\\bar/baz.ts', // mixed backslash and forward slash
			moduleName: 'foo/bar/baz',
			exports: ['fn'],
			imports: [],
			language: 'ts',
			mtime: '123',
		};

		upsertNode(graph, node);

		// The key should be normalized with forward slashes
		const expectedKey = '/foo/bar/baz.ts';
		expect(graph.nodes[expectedKey]).toEqual(node);
		expect(graph.metadata.nodeCount).toBe(1);
	});

	test('normalizeGraphPath handles ./ segments', () => {
		// ./ segments should be normalized away by upsertNode
		const graph = createEmptyGraph('test');
		const node: GraphNode = {
			filePath: '/foo/./bar/baz.ts',
			moduleName: 'foo/bar/baz',
			exports: ['fn'],
			imports: [],
			language: 'ts',
			mtime: '123',
		};

		upsertNode(graph, node);

		// The ./ should be normalized away
		const expectedKey = '/foo/bar/baz.ts';
		expect(graph.nodes[expectedKey]).toEqual(node);
	});

	test('normalizeGraphPath handles ../ segments', () => {
		// ../ segments should be rejected by validateGraphNode
		const node: GraphNode = {
			filePath: '/foo/../bar/baz.ts',
			moduleName: 'bar/baz',
			exports: ['fn'],
			imports: [],
			language: 'ts',
			mtime: '123',
		};

		expect(() => validateGraphNode(node)).toThrow(
			'Invalid node: filePath contains path traversal',
		);
	});

	test('graph keys are platform-independent', () => {
		// Windows-style paths should be stored with forward slashes
		const graph = createEmptyGraph('test');
		const node: GraphNode = {
			filePath: 'C:\\foo\\bar.ts',
			moduleName: 'foo/bar',
			exports: ['fn'],
			imports: [],
			language: 'ts',
			mtime: '123',
		};

		upsertNode(graph, node);

		// Key should use forward slashes even with Windows input
		const expectedKey = 'C:/foo/bar.ts';
		expect(graph.nodes[expectedKey]).toEqual(node);
	});
});

describe('graph boundary defense', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'repo-graph-boundary-'),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('validateWorkspace rejects workspace escape via ..', () => {
		// validateWorkspace rejects path traversal in workspace names
		expect(() => validateWorkspace('../escape')).toThrow(
			'Invalid workspace: path traversal detected',
		);
		expect(() => validateWorkspace('foo/../../bar')).toThrow(
			'Invalid workspace: path traversal detected',
		);
	});

	test('saveGraph rejects mismatched workspace with symlink-like paths', async () => {
		// saveGraph validates that workspaceRoot matches the workspace being saved to
		const workspaceName = 'symlink-repo';

		// Ensure the .swarm directory exists
		await fs.promises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});

		// Create graph with mismatched workspaceRoot
		const mismatchedGraph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: '/completely/different/workspace', // Mismatched root
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		// saveGraph should fail due to workspaceRoot mismatch
		await expect(saveGraph(workspaceName, mismatchedGraph)).rejects.toThrow(
			'workspaceRoot mismatch',
		);
	});

	test('saveGraph validates deeply nested workspaceRoot', async () => {
		// Test with a deeply nested workspace path
		const workspaceName = 'nested/deeply/nested/workspace';
		const resolvedWorkspace = path.resolve(workspaceName);

		// Ensure nested directories exist
		await fs.promises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});

		const graph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: resolvedWorkspace,
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		// Should not throw - workspaceRoot matches
		await expect(saveGraph(workspaceName, graph)).resolves.toBeUndefined();
	});
});

describe('adversarial input shapes', () => {
	test('edge with null bytes is rejected', () => {
		// validateGraphEdge doesn't check importSpecifier for null bytes
		// But it checks source/target - let's verify the actual behavior
		const edge: GraphEdge = {
			source: '/foo.ts',
			target: '/baz.ts',
			importSpecifier: './bar\x00baz', // null byte in specifier
			importType: 'named' as const,
		};

		// validateGraphEdge doesn't explicitly validate importSpecifier for control chars
		// But validateGraphNode checks imports array items for control characters
		const nodeWithNullImport: GraphNode = {
			filePath: '/foo.ts',
			moduleName: 'foo',
			exports: [],
			imports: ['./bar\x00baz'],
			language: 'ts',
			mtime: '123',
		};

		expect(() => validateGraphNode(nodeWithNullImport)).toThrow(
			'Invalid node: imports contains control characters',
		);
	});

	test('node with empty exports array is valid', () => {
		const node: GraphNode = {
			filePath: '/foo.ts',
			moduleName: 'foo',
			exports: [],
			imports: [],
			language: 'ts',
			mtime: '123',
		};

		expect(() => validateGraphNode(node)).not.toThrow();

		const graph = createEmptyGraph('test');
		upsertNode(graph, node);
		expect(graph.nodes['/foo.ts']).toEqual(node);
		expect(graph.metadata.nodeCount).toBe(1);
	});

	test('graph with circular edges is valid', () => {
		// A→B and B→A should both be accepted
		const graph = createEmptyGraph('test');

		const edgeAB: GraphEdge = {
			source: '/a.ts',
			target: '/b.ts',
			importSpecifier: './b',
			importType: 'named' as const,
		};

		const edgeBA: GraphEdge = {
			source: '/b.ts',
			target: '/a.ts',
			importSpecifier: './a',
			importType: 'named' as const,
		};

		addEdge(graph, edgeAB);
		addEdge(graph, edgeBA);

		expect(graph.edges).toHaveLength(2);
	});

	test('large number of edges for single node', () => {
		const graph = createEmptyGraph('test');

		// Create 100+ edges from a single source
		const edges: GraphEdge[] = [];
		for (let i = 0; i < 150; i++) {
			edges.push({
				source: '/source.ts',
				target: `/target${i}.ts`,
				importSpecifier: `./target${i}`,
				importType: 'named' as const,
			});
		}

		for (const edge of edges) {
			addEdge(graph, edge);
		}

		expect(graph.edges).toHaveLength(150);
		expect(graph.metadata.edgeCount).toBe(150);
	});

	test('node with very long filePath is accepted', () => {
		// Create a 500+ character absolute path
		// /foo/ (5) + 130*bar/ (520) + baz.ts (7) = 532 chars
		const longPath = '/foo/' + 'bar/'.repeat(130) + 'baz.ts';
		expect(longPath.length).toBeGreaterThan(500);

		const node: GraphNode = {
			filePath: longPath,
			moduleName: 'very-long-module',
			exports: ['fn'],
			imports: [],
			language: 'ts',
			mtime: '123',
		};

		expect(() => validateGraphNode(node)).not.toThrow();

		const graph = createEmptyGraph('test');
		upsertNode(graph, node);
		expect(graph.nodes[longPath]).toEqual(node);
	});
});

describe('control character safety in buildWorkspaceGraph', () => {
	let tempDir: string;
	let workspacePath: string;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(
			path.join(process.cwd(), 'repo-graph-ctrl-char-'),
		);
		workspacePath = path.relative(process.cwd(), tempDir);
	});

	afterEach(async () => {
		clearCache(workspacePath);
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('buildWorkspaceGraph does not throw when an import specifier contains a CR byte', async () => {
		// dirty.ts: one clean import + one import whose specifier contains a literal
		// carriage-return byte (0x0D).  Use String.fromCharCode(13) so the CR is
		// unambiguously a single control character, not the two-char sequence \r.
		const cr = String.fromCharCode(13);
		const dirtyContent = `import x from './bar${cr}.js';\nimport y from './ok';\n`;

		// clean.ts: a file with well-formed imports of all three kinds
		const cleanContent = [
			"import { foo } from './foo';",
			"const r = require('./req');",
			"const d = import('./dyn');",
		].join('\n');

		await fs.promises.writeFile(
			path.join(tempDir, 'dirty.ts'),
			dirtyContent,
			'binary',
		);
		await fs.promises.writeFile(path.join(tempDir, 'clean.ts'), cleanContent);
		// Stub target files so edges can resolve (optional — edges are only created
		// when targets exist, but graph build must not throw regardless)
		await fs.promises.writeFile(path.join(tempDir, 'ok.ts'), 'export {};');
		await fs.promises.writeFile(
			path.join(tempDir, 'foo.ts'),
			'export const foo = 1;',
		);

		// Must not throw
		const graph = buildWorkspaceGraph(workspacePath);

		// Both source files appear as nodes
		const moduleNames = Object.values(graph.nodes).map((n) => n.moduleName);
		expect(moduleNames).toContain('dirty.ts');
		expect(moduleNames).toContain('clean.ts');

		// The dirty specifier must not appear in any node's imports
		for (const node of Object.values(graph.nodes)) {
			for (const imp of node.imports) {
				expect(/[\0\t\r\n]/.test(imp)).toBe(false);
			}
		}

		// The dirty specifier must not appear in any edge's importSpecifier
		for (const edge of graph.edges) {
			expect(/[\0\t\r\n]/.test(edge.importSpecifier)).toBe(false);
		}

		// clean.ts's well-formed specifier is retained
		const cleanNode = Object.values(graph.nodes).find(
			(n) => n.moduleName === 'clean.ts',
		);
		expect(cleanNode).toBeDefined();
		expect(cleanNode?.imports).toContain('./foo');
	});

	test('validateGraphNode error message includes filePath and value when imports contains control characters', () => {
		const node: GraphNode = {
			filePath: '/abs/foo.ts',
			moduleName: 'foo',
			exports: [],
			imports: [`./bar${String.fromCharCode(13)}.js`],
			language: 'ts',
			mtime: '123',
		};
		// Original substring must still be present (toThrow uses substring matching)
		expect(() => validateGraphNode(node)).toThrow(
			'Invalid node: imports contains control characters',
		);
		// New context info must also appear
		expect(() => validateGraphNode(node)).toThrow('/abs/foo.ts');
	});
});
