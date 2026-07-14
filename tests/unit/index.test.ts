import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenCodeSwarm, { capSessionMap } from '../../src/index';

describe('OpenCodeSwarm Plugin Registration', () => {
	let tempDir: string;

	const mockPluginInput = {
		client: {} as any,
		project: {} as any,
		directory: '' as string,
		worktree: '' as string,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as any,
	};

	beforeEach(async () => {
		// Create a temp directory for the mock context
		tempDir = await mkdtemp(path.join(tmpdir(), 'swarm-test-'));
		mockPluginInput.directory = tempDir;
		mockPluginInput.worktree = tempDir;
	});

	afterEach(async () => {
		// Clean up temp directory
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('1. default export uses OpenCode v1 plugin object shape', () => {
		expect(OpenCodeSwarm.id).toBe('opencode-swarm');
		expect(typeof OpenCodeSwarm.server).toBe('function');
	});

	test('2. plugin server returns object with tool property when invoked with mock context', async () => {
		const result = await OpenCodeSwarm.server(mockPluginInput);
		expect(result).toHaveProperty('tool');
	});

	test('3. tool property contains doc_scan and doc_extract entries', async () => {
		const result = await OpenCodeSwarm.server(mockPluginInput);
		expect(result.tool).toHaveProperty('doc_scan');
		expect(result.tool).toHaveProperty('doc_extract');
	});

	test('4. doc_scan and doc_extract are defined tool objects (not undefined)', async () => {
		const result = await OpenCodeSwarm.server(mockPluginInput);
		// Tools created with createSwarmTool are objects with execute properties
		expect(result.tool.doc_scan).toBeDefined();
		expect(result.tool.doc_extract).toBeDefined();
		expect(typeof result.tool.doc_scan.execute).toBe('function');
		expect(typeof result.tool.doc_extract.execute).toBe('function');
	});
});

describe('capSessionMap heartbeat memory cap (invariant-8)', () => {
	test('FIFO-caps a session-keyed map at max, evicting oldest first', () => {
		// Mirrors the heartbeat throttle path: set a key, then cap the map.
		const map = new Map<string, number>();
		const max = 500;
		for (let i = 0; i < 600; i++) {
			// Deterministic monotonic stamp (value is irrelevant — the cap
			// evicts by insertion order, not by timestamp).
			map.set(`session-${i}`, 1_700_000_000_000 + i);
			capSessionMap(map, max);
			expect(map.size).toBeLessThanOrEqual(max);
		}

		// Size is pinned at the cap after inserting more than `max` distinct keys.
		expect(map.size).toBe(max);
		// Oldest key was evicted; the most recent key survives (FIFO semantics).
		expect(map.has('session-0')).toBe(false);
		expect(map.has('session-599')).toBe(true);
	});

	test('no-op when the map is already within the cap', () => {
		const map = new Map<string, number>([
			['a', 1],
			['b', 2],
		]);
		capSessionMap(map, 500);
		expect(map.size).toBe(2);
		expect(map.has('a')).toBe(true);
		expect(map.has('b')).toBe(true);
	});
});
