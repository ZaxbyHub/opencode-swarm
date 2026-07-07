import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenCodeSwarm from '../../src/index';

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
